"""Web 终端：PTY ↔ WebSocket 桥接。

协议（客户端 → 服务端，全部是文本帧）：
    {"type":"input","data":"ls\\n"}
    {"type":"resize","cols":120,"rows":32}
服务端 → 客户端：直接发二进制帧（xterm.js 用 write(Uint8Array) 接收）。

安全说明：本模块只负责管道，鉴权在 main.py 的 websocket 端点里做。
终端以面板进程的身份运行（systemd 里是 root），所以「谁能登录面板」= 「谁能拿 root shell」。

另外维护一份会话注册表（SESSIONS），供「终端管理」列出现有会话并远程踢掉。
"""
import asyncio
import contextlib
import fcntl
import json
import os
import pty
import secrets
import signal
import struct
import subprocess
import termios
import time

# session_id -> {id, user, ip, pid, cols, rows, created, last_active, ws}
SESSIONS: dict[str, dict] = {}


def new_session_id() -> str:
    return secrets.token_hex(6)


def register(session_id: str, user: str, ip: str, ws, cols: int, rows: int) -> None:
    SESSIONS[session_id] = {
        "id": session_id, "user": user, "ip": ip, "ws": ws, "pid": None,
        "cols": cols, "rows": rows, "created": int(time.time()),
        "last_active": int(time.time()), "bytes_out": 0, "bytes_in": 0,
    }


def unregister(session_id: str) -> None:
    SESSIONS.pop(session_id, None)


def touch(session_id: str, *, cols: int | None = None, rows: int | None = None,
          sent: int = 0, received: int = 0) -> None:
    entry = SESSIONS.get(session_id)
    if not entry:
        return
    entry["last_active"] = int(time.time())
    if cols:
        entry["cols"] = cols
    if rows:
        entry["rows"] = rows
    entry["bytes_out"] += sent
    entry["bytes_in"] += received


def set_pid(session_id: str, pid: int) -> None:
    entry = SESSIONS.get(session_id)
    if entry:
        entry["pid"] = pid


def list_sessions() -> list[dict]:
    now = int(time.time())
    items = []
    for entry in SESSIONS.values():
        items.append({key: value for key, value in entry.items() if key != "ws"}
                     | {"age_seconds": now - entry["created"],
                        "idle_seconds": now - entry["last_active"]})
    items.sort(key=lambda item: item["created"])
    return items


def count() -> int:
    return len(SESSIONS)


async def kill_session(session_id: str, reason: str = "被管理员从面板断开") -> dict:
    """关掉 WebSocket，让 run_terminal 的收尾逻辑去回收进程组。"""
    entry = SESSIONS.get(session_id)
    if not entry:
        raise KeyError("会话不存在或已结束")
    ws = entry.get("ws")
    pid = entry.get("pid")
    if pid:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(pid, signal.SIGHUP)          # 先礼后兵，进程组不在了就忽略
    if ws is not None:
        with contextlib.suppress(Exception):
            await ws.close(code=1000)
    SESSIONS.pop(session_id, None)
    return {"id": session_id, "pid": pid, "reason": reason}


def set_winsize(fd: int, rows: int, cols: int) -> None:
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", int(rows), int(cols), 0, 0))
    except OSError:
        pass


async def run_terminal(ws, shell: str = "/bin/bash", cwd: str = "/root",
                       env: dict | None = None, cols: int = 100, rows: int = 30,
                       session_id: str | None = None) -> None:
    master, slave = pty.openpty()
    set_winsize(slave, rows, cols)

    child_env = dict(os.environ)
    child_env.update({
        "TERM": "xterm-256color",
        "COLORTERM": "truecolor",
        "LANG": child_env.get("LANG", "C.UTF-8"),
        "PS1": child_env.get("PS1", r"\[\e[32m\]\u@\h\[\e[0m\]:\[\e[34m\]\w\[\e[0m\]# "),
    })
    if env:
        child_env.update(env)

    proc = subprocess.Popen(
        [shell, "-l"],
        stdin=slave, stdout=slave, stderr=slave,
        start_new_session=True,   # 新会话 + 新进程组，方便整组回收
        close_fds=True, cwd=cwd if os.path.isdir(cwd) else "/",
        env=child_env,
    )
    os.close(slave)   # 父进程只保留 master
    if session_id:
        set_pid(session_id, proc.pid)          # 供「终端管理」按进程组回收

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=512)

    def _on_readable() -> None:
        try:
            data = os.read(master, 65536)
        except OSError:
            data = b""
        try:
            queue.put_nowait(data)
        except asyncio.QueueFull:
            pass   # 前端跟不上时丢帧，比阻塞 PTY 好

    loop.add_reader(master, _on_readable)

    async def pump_out() -> None:
        while True:
            data = await queue.get()
            if not data:      # PTY 关闭
                break
            await ws.send_bytes(data)
            if session_id:
                touch(session_id, sent=len(data))

    async def pump_in() -> None:
        while True:
            msg = await ws.receive_text()
            try:
                obj = json.loads(msg)
            except ValueError:
                obj = {"type": "input", "data": msg}
            kind = obj.get("type")
            if kind == "input":
                payload = obj.get("data") or ""
                if payload:
                    os.write(master, payload.encode("utf-8", "replace"))
                    if session_id:
                        touch(session_id, received=len(payload))
            elif kind == "resize":
                new_cols = int(obj.get("cols", cols))
                new_rows = int(obj.get("rows", rows))
                set_winsize(master, new_rows, new_cols)
                if session_id:
                    touch(session_id, cols=new_cols, rows=new_rows)
            elif kind == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))

    tasks = [asyncio.create_task(pump_out(), name="pty-out"),
             asyncio.create_task(pump_in(), name="pty-in")]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            task.cancel()
        with contextlib.suppress(OSError):
            loop.remove_reader(master)
        with contextlib.suppress(OSError):
            os.close(master)
        # 先 SIGHUP 让登录 shell 正常退出，给 2 秒，再整组 SIGKILL
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(proc.pid, signal.SIGHUP)
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(proc.pid, signal.SIGKILL)
            with contextlib.suppress(Exception):
                proc.wait(timeout=2)
