"""Validated, atomic wallpaper imports and a framework-neutral catalog."""
from pathlib import Path, PurePosixPath
import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
import zipfile

MAX_BYTES = 2 * 1024 ** 3
MAX_FILES = 4096
ALLOWED = {'.html', '.htm', '.js', '.mjs', '.css', '.json', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.svg', '.ico', '.mp4', '.webm', '.ogg', '.ogv', '.mp3', '.wav', '.ttf', '.woff', '.woff2', '.otf', '.glsl', '.frag', '.vert'}
IMAGES = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp'}
VIDEOS = {'.mp4', '.webm', '.ogg', '.ogv'}
SKIP = {'.git', '.idea', 'node_modules', '__pycache__', '__MACOSX'}

class ImportFailure(ValueError):
    pass


def relative_name(value):
    if not isinstance(value, str) or not value or len(value) > 500:
        raise ImportFailure('项目文件名无效')
    value = value.replace('\\', '/')
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ('', '.', '..') for part in value.split('/')) or ':' in value or '\x00' in value:
        raise ImportFailure('项目包含不安全的路径')
    return path.as_posix()


def inside(root, value):
    rel = relative_name(value)
    target = root.joinpath(*PurePosixPath(rel).parts)
    # Reject symlinks at every level, including links that happen to point inside the root.
    walk = root
    for part in PurePosixPath(rel).parts:
        walk = walk / part
        if walk.is_symlink():
            raise ImportFailure('项目不能包含符号链接')
    if not target.resolve().is_relative_to(root.resolve()):
        raise ImportFailure('项目路径越界')
    return target


class Library:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)

    def import_directory(self, source):
        source = Path(source)
        if source.is_symlink() or not source.is_dir():
            raise ImportFailure('请选择实际项目目录')
        metadata = inside(source, 'project.json')
        if not metadata.is_file() or metadata.stat().st_size > 1024 ** 2:
            raise ImportFailure('找不到有效的 project.json')
        try:
            raw = metadata.read_bytes()
            project = json.loads(raw.decode('utf-8-sig'))
        except (ValueError, UnicodeError) as exc:
            raise ImportFailure('project.json 不是有效 JSON') from exc
        if not isinstance(project, dict):
            raise ImportFailure('project.json 必须是对象')
        kind = str(project.get('type', '')).lower()
        title = str(project.get('title') or source.name)[:200]
        identity = 'we-' + hashlib.sha256(raw).hexdigest()[:20]
        destination = self.root / identity
        if destination.exists():
            return {'id': identity, 'title': title, 'existing': True}
        preview = project.get('preview')
        if preview:
            preview = relative_name(preview)
            if Path(preview).suffix.lower() not in IMAGES:
                raise ImportFailure('封面须为浏览器图片格式')
            if not inside(source, preview).is_file():
                preview = None
        entry = project.get('file')
        render, note = 'none', '此项目类型需要 Wallpaper Engine 运行时'
        required = set()
        if preview:
            required.add(preview)
        if kind == 'video':
            entry = relative_name(entry)
            if Path(entry).suffix.lower() not in VIDEOS or not inside(source, entry).is_file():
                raise ImportFailure('视频入口缺失或格式不受支持')
            required.add(entry); render, note = 'video', '静音循环播放'
        elif kind == 'web':
            entry = relative_name(entry)
            if Path(entry).suffix.lower() not in {'.html', '.htm'} or not inside(source, entry).is_file():
                raise ImportFailure('Web 项目的 HTML 入口缺失')
            if inside(source, entry).stat().st_size > 2 * 1024 ** 2:
                raise ImportFailure('HTML 入口过大')
            render, note = 'web', '隔离运行；音频响应、桌面交互等原生接口不提供'
            for parent, dirs, names in os.walk(source, followlinks=False):
                parent = Path(parent)
                for name in dirs + names:
                    if (parent / name).is_symlink():
                        raise ImportFailure('项目不能包含符号链接')
                dirs[:] = [name for name in dirs if name not in SKIP and not name.startswith('.')]
                for name in names:
                    if Path(name).suffix.lower() in ALLOWED:
                        required.add((parent / name).relative_to(source).as_posix())
        else:
            entry = preview
            render = 'image' if preview else 'none'
            note = 'Scene 场景仅显示封面，动态效果需要 Wallpaper Engine 运行时' if kind == 'scene' else note
        total = 0
        if len(required) > MAX_FILES:
            raise ImportFailure('项目文件数量超过 4096')
        folded = set()
        for name in required:
            if name.casefold() in folded:
                raise ImportFailure('项目存在仅大小写不同的重复文件名')
            folded.add(name.casefold())
            file = inside(source, name)
            if not file.is_file():
                raise ImportFailure('项目资源缺失')
            total += file.stat().st_size
        if total > MAX_BYTES:
            raise ImportFailure('项目超过 2 GB 上限')
        properties = {}
        general = project.get('general')
        if isinstance(general, dict) and isinstance(general.get('properties'), dict):
            for key, value in general['properties'].items():
                if isinstance(value, dict) and isinstance(key, str):
                    prop = value.get('value')
                    if isinstance(prop, (str, int, float, bool)) and len(str(prop)) < 4096:
                        properties[key] = {'value': prop}
        manifest = {'schema': 1, 'id': identity, 'title': title, 'kind': kind, 'render': render, 'file': entry, 'preview': preview, 'note': note, 'properties': properties, 'bytes': total}
        staging = Path(tempfile.mkdtemp(prefix='.import-', dir=self.root))
        try:
            for name in sorted(required):
                target = staging / 'assets' / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(inside(source, name), target)
            (staging / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False), encoding='utf-8')
            staging.rename(destination)
        finally:
            if staging.exists():
                assert staging.resolve().is_relative_to(self.root.resolve())
                shutil.rmtree(staging)
        return {'id': identity, 'title': title, 'kind': kind, 'render': render, 'bytes': total, 'existing': False}

    def import_tree(self, source):
        source = Path(source)
        if source.is_symlink() or not source.is_dir():
            raise ImportFailure('请选择实际项目目录')
        roots = []
        def scan(directory, depth=0):
            if directory.is_symlink():
                raise ImportFailure('项目不能包含符号链接')
            if (directory / 'project.json').is_file():
                roots.append(directory)
            elif depth < 3:
                for child in sorted(directory.iterdir()):
                    if child.is_dir() and child.name not in SKIP and not child.name.startswith('.'):
                        scan(child, depth + 1)
        scan(source)
        if not roots:
            raise ImportFailure('未找到 project.json；ZIP 应包含项目目录或项目文件')
        if len(roots) > 128:
            raise ImportFailure('一次最多导入 128 个项目')
        results = []
        try:
            for root in roots:
                results.append(self.import_directory(root))
            return results
        except Exception:
            # Roll back only directories created by this batch, never existing projects.
            for result in results:
                if not result['existing']:
                    target = self.root / result['id']
                    assert target.resolve().is_relative_to(self.root.resolve())
                    shutil.rmtree(target)
            raise

    def import_zip(self, archive):
        with tempfile.TemporaryDirectory(prefix='cyan-wallpaper-') as directory:
            root = Path(directory)
            try:
                with zipfile.ZipFile(archive) as z:
                    infos = z.infolist()
                    if len(infos) > MAX_FILES or sum(i.file_size for i in infos) > MAX_BYTES:
                        raise ImportFailure('解压后超过 2 GB 或 4096 文件上限')
                    seen = set()
                    for info in infos:
                        if info.is_dir():
                            continue
                        name = relative_name(info.filename)
                        if name.casefold() in seen:
                            raise ImportFailure('ZIP 存在重复路径')
                        seen.add(name.casefold())
                        mode = (info.external_attr >> 16) & 0o170000
                        if mode not in (0, stat.S_IFREG) or info.flag_bits & 1:
                            raise ImportFailure('ZIP 不允许链接、特殊文件或加密内容')
                        if any(part in SKIP or part.startswith('.') for part in PurePosixPath(name).parts):
                            continue
                        # Scene packages and executables are never needed in a browser.
                        if Path(name).suffix.lower() not in ALLOWED:
                            continue
                        target = inside(root, name)
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with z.open(info) as src, target.open('wb') as dst:
                            shutil.copyfileobj(src, dst, 1024 * 1024)
                return self.import_tree(root)
            except (zipfile.BadZipFile, RuntimeError, OSError, NotImplementedError, EOFError) as exc:
                raise ImportFailure('无法读取 ZIP 项目') from exc

    def manifest(self, identity):
        if not re.fullmatch(r'we-[a-f0-9]{20}', identity):
            raise ImportFailure('无效的壁纸标识')
        path = self.root / identity / 'manifest.json'
        if not path.is_file() or path.is_symlink():
            raise FileNotFoundError('壁纸不存在')
        return json.loads(path.read_text(encoding='utf-8'))

    def catalog(self):
        items = []
        for directory in sorted(self.root.glob('we-*')):
            try:
                item = self.manifest(directory.name)
                # Properties are consumed only by the sandboxed bridge, not by the panel.
                items.append({k: v for k, v in item.items() if k != 'properties'})
            except (OSError, ValueError):
                continue
        return {'schema': 1, 'items': items}

    def asset(self, identity, name):
        self.manifest(identity)
        if Path(name).suffix.lower() not in ALLOWED:
            raise ImportFailure('不支持的资源格式')
        target = inside(self.root / identity / 'assets', name)
        if not target.is_file():
            raise FileNotFoundError('资源不存在')
        return target
