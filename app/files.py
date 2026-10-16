"""文件管理器：浏览 / 上传下载 / 编辑 / 改名 / 删除 / 权限。

设计取舍：
- 面板以 root 运行，所以这里等于「以 root 身份管理整台机器的文件」，和 1Panel 一致。
  边界靠三件事兜住：1) 路径必须落在 config 的 file_root 之内（默认 /）；
  2) 伪文件系统（/proc /sys /dev /run）只允许看、不允许写/删；3) 所有写操作写审计。
- 大文件不进内存：下载走 FileResponse，上传边读边写盘，文本预览有大小上限。
- 写文件用「临时文件 + 原子替换」，避免编辑中途失败留下半个文件。
"""
from __future__ import annotations

import grp
import os
import pwd
import shutil
import stat
from pathlib import Path

# 这些目录只读：往里写东西没有意义，且很容易把系统搞坏
READ_ONLY_PREFIXES = ("/proc", "/sys", "/dev", "/run", "/boot/efi", "/lost+found")
TEXT_PREVIEW_LIMIT = 1024 * 1024          # 文本预览最多 1MB
_OWNER_CACHE: dict[int, str] = {}
_GROUP_CACHE: dict[int, str] = {}


class FileError(Exception):
    """路径不合法或操作被拒绝。"""


def _owner(uid: int) -> str:
    if uid not in _OWNER_CACHE:
        try:
            _OWNER_CACHE[uid] = pwd.getpwuid(uid).pw_name
        except KeyError:
            _OWNER_CACHE[uid] = str(uid)
    return _OWNER_CACHE[uid]


def _group(gid: int) -> str:
    if gid not in _GROUP_CACHE:
        try:
            _GROUP_CACHE[gid] = grp.getgrgid(gid).gr_name
        except KeyError:
            _GROUP_CACHE[gid] = str(gid)
    return _GROUP_CACHE[gid]


def resolve(path: str, root: str = "/", must_exist: bool = True) -> Path:
    """把用户给的路径规范化，并确保它落在 root 之内。

    用 realpath 解析软链接后再比较前缀，防止 `../` 或软链跳出根目录。
    允许不存在的路径（新建文件/目录），此时校验其父目录。
    """
    raw = (path or "/").strip()
    if "\x00" in raw:
        raise FileError("路径包含非法字符")
    if not raw.startswith("/"):
        raw = "/" + raw
    root_path = Path(root).resolve()
    target = Path(os.path.normpath(raw))
    if must_exist and not target.exists() and not target.is_symlink():
        raise FileError(f"不存在：{target}")
    # 包括尚未创建的多层目录在内，统一解析真实路径后比较边界
    real = Path(os.path.realpath(target))
    if real != root_path and root_path not in real.parents:
        raise FileError("路径越界：只允许操作面板配置的根目录之内")
    return target


def _writable(path: Path) -> None:
    for prefix in READ_ONLY_PREFIXES:
        if path == Path(prefix) or prefix + "/" in str(path) + "/":
            raise FileError(f"{prefix} 是系统伪文件系统，禁止修改")


def _mode_string(st: os.stat_result) -> str:
    return stat.filemode(st.st_mode)


def entry_info(path: Path) -> dict:
    """单个条目的元信息（不跟随判断用 lstat，便于显示软链接）。"""
    st = path.lstat()
    kind = "dir" if stat.S_ISDIR(st.st_mode) else "link" if stat.S_ISLNK(st.st_mode) else "file"
    info = {
        "name": path.name or str(path),
        "path": str(path),
        "type": kind,
        "size": st.st_size,
        "mtime": int(st.st_mtime),
        "mode": oct(stat.S_IMODE(st.st_mode))[2:].zfill(3),
        "mode_str": _mode_string(st),
        "owner": _owner(st.st_uid),
        "group": _group(st.st_gid),
        "readable": os.access(path, os.R_OK),
        "writable": os.access(path, os.W_OK),
    }
    if kind == "link":
        try:
            info["target"] = os.readlink(path)
        except OSError:
            info["target"] = ""
    return info


def list_dir(path: str, root: str = "/", show_hidden: bool = True) -> dict:
    target = resolve(path, root)
    if not target.is_dir():
        raise FileError(f"不是目录：{target}")
    items = []
    try:
        with os.scandir(target) as it:
            for item in it:
                if not show_hidden and item.name.startswith("."):
                    continue
                try:
                    info = entry_info(Path(item.path))
                    if info["type"] == "link":
                        try:
                            linked = resolve(item.path, root)
                            info["target_type"] = "dir" if linked.is_dir() else "file" if linked.is_file() else "missing"
                        except FileError:
                            info["target_type"] = "unavailable"
                    items.append(info)
                except OSError:
                    continue                      # 权限不足或竞态删除，跳过这一条
    except PermissionError as exc:
        raise FileError(f"没有权限读取：{target}") from exc
    items.sort(key=lambda e: (e["type"] != "dir", e["name"].lower()))
    parent = str(target.parent) if str(target) != str(Path(root).resolve()) else None
    return {"path": str(target), "root": root, "parent": parent, "items": items}


def read_text(path: str, root: str = "/") -> dict:
    target = resolve(path, root)
    if not target.is_file():
        raise FileError("只能编辑普通文件")
    size = target.stat().st_size
    if size > TEXT_PREVIEW_LIMIT:
        raise FileError(f"文件 {size} 字节，超过 {TEXT_PREVIEW_LIMIT} 字节的在线编辑上限，请下载后编辑")
    data = target.read_bytes()
    if b"\x00" in data[:8192]:
        raise FileError("这是二进制文件，无法在线编辑")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        text = data.decode("utf-8", "replace")
    return {"path": str(target), "size": size, "content": text,
            "mtime": int(target.stat().st_mtime)}


def write_text(path: str, content: str, root: str = "/", backup: bool = True,
               create_only: bool = False) -> dict:
    target = resolve(path, root, must_exist=False)
    _writable(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    if create_only:
        try:
            with target.open("x", encoding="utf-8", newline="\n") as stream:
                stream.write(content)
        except FileExistsError as exc:
            raise FileError("同名文件或目录已存在") from exc
        return {"path": str(target), "size": target.stat().st_size, "created": True}
    existed = target.exists()
    if existed and backup:
        shutil.copy2(target, target.with_name(target.name + ".bak"))
    tmp = target.with_name(f".{target.name}.sp.tmp")
    tmp.write_text(content, encoding="utf-8", newline="\n")
    if existed:
        os.chmod(tmp, stat.S_IMODE(target.stat().st_mode))
    os.replace(tmp, target)
    return {"path": str(target), "size": target.stat().st_size, "created": not existed}


def mkdir(path: str, root: str = "/") -> dict:
    target = resolve(path, root, must_exist=False)
    _writable(target)
    if target.exists():
        raise FileError("同名文件或目录已存在")
    target.mkdir(parents=True)
    return {"path": str(target)}


def rename(src: str, dst: str, root: str = "/") -> dict:
    source = resolve(src, root)
    target = resolve(dst, root, must_exist=False)
    _writable(source)
    _writable(target)
    if target.exists():
        raise FileError("目标已存在")
    target.parent.mkdir(parents=True, exist_ok=True)
    source.rename(target)
    return {"from": str(source), "to": str(target)}


def delete(paths: list[str], root: str = "/", recursive: bool = False) -> dict:
    removed, skipped = [], []
    for raw in paths:
        try:
            target = resolve(raw, root)
            _writable(target)
            if target.is_dir() and not target.is_symlink():
                if recursive:
                    shutil.rmtree(target)
                else:
                    target.rmdir()          # 非空目录会抛错，交由外层记录
            else:
                target.unlink()
            removed.append(str(target))
        except (FileError, OSError) as exc:
            skipped.append({"path": raw, "reason": str(exc) or exc.__class__.__name__})
    return {"removed": removed, "skipped": skipped}


def chmod(path: str, mode: str, root: str = "/") -> dict:
    target = resolve(path, root)
    _writable(target)
    try:
        value = int(str(mode), 8)
    except ValueError as exc:
        raise FileError("权限要写成八进制，例如 644 / 755") from exc
    if not 0 <= value <= 0o7777:
        raise FileError("权限超出范围")
    os.chmod(target, value)
    return {"path": str(target), "mode": oct(value)[2:].zfill(3)}


def copy_or_move(src: str, dst: str, root: str = "/", move: bool = False) -> dict:
    source = resolve(src, root)
    target = resolve(dst, root, must_exist=False)
    _writable(target)
    if target.exists():
        raise FileError("目标已存在")
    if move:
        source.rename(target)
    elif source.is_dir():
        shutil.copytree(source, target)
    else:
        shutil.copy2(source, target)
    return {"from": str(source), "to": str(target), "move": move}


async def save_upload(filename: str, directory: str, chunks, root: str = "/",
                      max_bytes: int = 512 * 1024 * 1024, overwrite: bool = False) -> dict:
    """把上传流边读边写盘。chunks 是异步字节迭代器（FastAPI 的 request.stream()）。"""
    safe_name = os.path.basename((filename or "").replace("\\", "/")).strip() or "upload.bin"
    folder = resolve(directory or "/", root)
    if not folder.is_dir():
        raise FileError("目标不是目录")
    target = folder / safe_name
    _writable(target)
    if target.exists() and not overwrite:
        raise FileError(f"已存在同名文件：{safe_name}")
    written = 0
    tmp = folder / f".{safe_name}.sp-up"
    with open(tmp, "wb") as stream:
        async for chunk in chunks:
            if not chunk:
                continue
            written += len(chunk)
            if written > max_bytes:
                stream.close()
                tmp.unlink(missing_ok=True)
                raise FileError(f"文件超过 {max_bytes // (1024 * 1024)}MB 上限")
            stream.write(chunk)
    if target.exists():
        target.unlink()
    os.replace(tmp, target)
    return {"path": str(target), "size": written}


def disk_usage(path: str, root: str = "/") -> dict:
    target = resolve(path, root)
    usage = shutil.disk_usage(target if target.is_dir() else target.parent)
    return {"total": usage.total, "used": usage.used, "free": usage.free,
            "percent": round(usage.used / usage.total * 100, 1) if usage.total else 0.0}
