"""One-pass, allocated-block storage breakdown; never reads file contents."""
from __future__ import annotations

from collections import Counter
import os
from pathlib import Path
import re
import shutil
import stat
import threading
import time


CATEGORIES = (
    ('system', '系统与运行库', '系统程序、运行库、内核、交换文件与软件包管理数据'),
    ('apps', '应用程序', '应用代码、依赖与运行环境'),
    ('data', '应用数据', '应用数据目录、数据库与上传文件'),
    ('config', '配置与证书', '配置目录、常见配置文件与证书'),
    ('cache', '缓存', '应用缓存、包下载缓存与编译缓存'),
    ('logs', '日志', '系统与应用的日志目录及日志文件'),
    ('backups', '备份', '备份目录与明确标记的备份文件'),
    ('temp', '临时文件', '临时目录中的文件'),
    ('users', '用户文件', '用户目录中尚未归入其他分类的内容'),
    ('other', '其他文件', '未匹配上述规则的文件与目录'),
)


def category(parts: tuple[str, ...]) -> str:
    lower = tuple(p.lower() for p in parts)
    name = lower[-1] if lower else ''
    system = bool(lower and lower[0] in ('usr', 'bin', 'sbin', 'lib', 'lib64', 'boot')) and lower[:2] != ('usr', 'local')
    dependency = any(p in ('venv', '.venv', 'node_modules') for p in lower)
    if lower[:2] == ('var', 'backups') or (not system and not dependency and any(p in ('backup', 'backups') for p in lower)) or re.search(r'\.bak(?:\.|$)', name):
        return 'backups'
    if lower[:2] == ('var', 'log') or (not system and not dependency and (any(p in ('log', 'logs', '_logs') for p in lower) or re.search(r'\.log(?:\.\d+)?(?:\.gz)?$', name))):
        return 'logs'
    if lower[:2] == ('var', 'cache') or any(p in ('.cache', '__pycache__', '.npm', '_cacache', 'node-compile-cache') for p in lower) or (not system and not dependency and any(p in ('cache', 'caches') for p in lower)):
        return 'cache'
    if lower[:1] == ('tmp',) or lower[:2] == ('var', 'tmp'):
        return 'temp'
    if lower[:1] == ('etc',) or '.config' in lower:
        return 'config'
    if system or lower[:3] in (('var', 'lib', 'dpkg'), ('var', 'lib', 'apt')) or lower[:1] in (('swapfile',), ('swap.img',)):
        return 'system'
    if dependency:
        return 'apps'
    if any(p in ('config', 'configs', 'configuration') for p in lower) or name.endswith(('.conf', '.ini', '.cfg', '.toml', '.yaml', '.yml', '.env')) or name in ('.env', 'config.json', 'settings.json', 'package.json', 'tsconfig.json', 'jsconfig.json'):
        return 'config'
    if lower[:2] in (('var', 'lib'), ('var', 'spool')) or any(p in ('data', 'storage', 'uploads', 'database', 'databases') for p in lower) or name.endswith(('.sqlite', '.sqlite3', '.db')):
        return 'data'
    if lower[:1] in (('opt',), ('srv',)) or lower[:2] == ('usr', 'local') or lower[:3] == ('root', '.local', 'lib'):
        return 'apps'
    if lower[:1] in (('root',), ('home',)):
        return 'users'
    return 'other'


def group_path(parts: tuple[str, ...], is_dir: bool, kind: str) -> tuple[str, ...]:
    dirs = parts if is_dir else parts[:-1]
    if not dirs:
        return ()
    lower = tuple(p.lower() for p in dirs)
    markers = {
        'backups': ('backup', 'backups'), 'cache': ('cache', 'caches', '.cache', '__pycache__', '.npm', '_cacache', 'node-compile-cache'),
        'config': ('.config', 'config', 'configs', 'configuration'), 'data': ('data', 'storage', 'uploads', 'database', 'databases'),
    }
    for index, part in enumerate(lower):
        if part in markers.get(kind, ()):
            return dirs[:index + 1]
    depth = 3 if lower[:2] in (('var', 'lib'), ('var', 'log'), ('usr', 'local')) else 2
    return dirs[:depth]


def nested_mounts(root: Path) -> set[str]:
    """Exclude bind mounts as well as other devices; du -x alone misses bind mounts."""
    out = set()
    try:
        for line in Path('/proc/self/mountinfo').read_text(errors='surrogateescape').splitlines():
            mount = Path(re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), line.split()[4]))
            if mount != root and root in mount.parents:
                out.add(str(mount))
    except (OSError, IndexError):
        pass
    return out


class ScanStopped(Exception):
    pass


def scan(root: Path, *, timeout: float = 90, max_entries: int = 1_000_000, stop=None, progress=None) -> dict:
    root = root.resolve()
    began, deadline = time.time(), time.monotonic() + timeout
    sizes = Counter()
    groups = {key: Counter() for key, _, _ in CATEGORIES}
    seen_dirs, seen_links = set(), set()
    mounts = nested_mounts(root)
    counters = {'entries': 0, 'errors': 0, 'skipped_mounts': 0}
    reason = None
    last_progress = 0
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC

    def check():
        nonlocal last_progress
        now = time.monotonic()
        if stop and stop.is_set():
            raise ScanStopped('cancelled')
        if now >= deadline:
            raise ScanStopped('timeout')
        if counters['entries'] >= max_entries:
            raise ScanStopped('entry_limit')
        if progress and now - last_progress >= .5:
            last_progress = now
            progress(counters['entries'], sum(sizes.values()))

    def add(parts, st, is_dir):
        counters['entries'] += 1
        identity = (st.st_dev, st.st_ino)
        if not is_dir and st.st_nlink > 1:
            if identity in seen_links:
                return
            seen_links.add(identity)
        kind = category(parts)
        amount = max(0, st.st_blocks) * 512
        sizes[kind] += amount
        groups[kind][str(root.joinpath(*group_path(parts, is_dir, kind)))] += amount

    def walk(fd, parts, st):
        check()
        identity = (st.st_dev, st.st_ino)
        if identity in seen_dirs:
            counters['skipped_mounts'] += 1
            return
        seen_dirs.add(identity)
        add(parts, st, True)
        if len(parts) >= 256:
            counters['errors'] += 1
            return
        try:
            with os.scandir(fd) as entries:
                for entry in entries:
                    check()
                    child = parts + (entry.name,)
                    path = str(root.joinpath(*child))
                    if path in mounts or any(path == p or path.startswith(p + '/') for p in ('/proc', '/sys', '/dev', '/run')):
                        counters['skipped_mounts'] += 1
                        continue
                    try:
                        info = entry.stat(follow_symlinks=False)
                        if info.st_dev != device:
                            counters['skipped_mounts'] += 1
                        elif stat.S_ISDIR(info.st_mode):
                            child_fd = os.open(entry.name, flags, dir_fd=fd)
                            try:
                                actual = os.fstat(child_fd)
                                if actual.st_dev == device:
                                    walk(child_fd, child, actual)
                                else:
                                    counters['skipped_mounts'] += 1
                            finally:
                                os.close(child_fd)
                        else:
                            add(child, info, False)
                    except OSError:
                        counters['errors'] += 1
        except OSError:
            counters['errors'] += 1

    fd = os.open(root, flags)
    try:
        first = os.fstat(fd)
        device = first.st_dev
        try:
            walk(fd, (), first)
        except ScanStopped as exc:
            reason = str(exc)
    finally:
        os.close(fd)
    disk = shutil.disk_usage(root)
    categories = []
    for key, label, description in CATEGORIES:
        largest = sorted(groups[key].items(), key=lambda item: (-item[1], item[0]))[:6]
        categories.append({'id': key, 'label': label, 'description': description, 'size': sizes[key],
                           'groups': [{'path': path, 'size': size} for path, size in largest],
                           'remaining': sizes[key] - sum(size for _, size in largest)})
    return {'scope': str(root), 'started_at': began, 'finished_at': time.time(), 'categories': categories,
            'scanned_bytes': sum(sizes.values()), 'difference': disk.used - sum(sizes.values()),
            'disk': {'total': disk.total, 'used': disk.used, 'available': disk.free, 'reserved': max(0, disk.total - disk.used - disk.free)},
            **counters, 'partial_reason': reason or ('read_errors' if counters['errors'] else None)}


class StorageAnalysis:
    def __init__(self, root: str, *, ttl: float = 300, timeout: float = 90):
        self.root, self.ttl, self.timeout = Path(root), ttl, timeout
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._result = None
        self._status = 'idle'
        self._progress = {'entries': 0, 'bytes': 0}
        self._error = None

    def snapshot(self, refresh: bool = False) -> dict:
        with self._lock:
            expired = not self._result or time.time() - self._result['finished_at'] > self.ttl
            if self._status != 'running' and not self._stop.is_set() and (refresh or expired):
                self._status, self._error = 'running', None
                self._progress = {'entries': 0, 'bytes': 0}
                self._thread = threading.Thread(target=self._run, name='storage-analysis', daemon=True)
                self._thread.start()
            return {'status': self._status, 'progress': dict(self._progress), 'result': self._result, 'error': self._error}

    def _update(self, entries, size):
        with self._lock:
            self._progress = {'entries': entries, 'bytes': size}

    def _run(self):
        try:
            # Linux nice values are per-thread; do not lower the API event loop's priority.
            try:
                os.setpriority(os.PRIO_PROCESS, threading.get_native_id(), 10)
            except OSError:
                pass
            result = scan(self.root, timeout=self.timeout, stop=self._stop, progress=self._update)
            with self._lock:
                self._result = result
                self._status = 'partial' if result['partial_reason'] else 'ready'
        except OSError:
            with self._lock:
                self._status, self._error = 'error', '无法读取存储信息，请检查目录权限后重试。'

    def close(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
