"""SSH 远程终端管理：看谁连着、从哪来、多久没动，并能把它断开。

只做这一件事，刻意不碰 authorized_keys、不改 sshd 配置 —— 面板里不放能把自己关在门外的开关。

数据来源（踩过坑，这里记一下）：
- 登录会话以 `who -u` 为准：它给的是真实的 pts/N、来源 IP、登录时间、空闲时长。
  不要用 `loginctl list-sessions` 当主来源：本机上它的 tty 字段是空的（只给 session/uid/user），
  照它建表会得到「0 个会话」这种假象。
- 每条会话对应的进程用 `ps` 里的 `sshd: <user>@<tty>` 找。
- 断开时不信任客户端传来的 pid，而是用 tty 现场重新解析 sshd 进程再发 SIGTERM，
  避免 pid 复用误杀无关进程；找不到对应的 sshd 进程就拒绝执行。
"""
from __future__ import annotations

import os
import re
import signal
import subprocess

SSH_PORTS = (22,)
SSHD_SESSION_RE = re.compile(r"^sshd: (\S+)@(\S+)$")


class SSHError(Exception):
    """操作被拒绝或执行失败。"""


def _run(args: list[str], timeout: int = 10) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)


def service_state() -> dict:
    """sshd 有两种启动形态：Debian 12 起默认 ssh.socket 按需拉起，两个都要认。"""
    state = {"unit": None, "active": False, "enabled": False, "socket": None}
    for unit in ("ssh.service", "sshd.service"):
        if _run(["systemctl", "is-active", unit]).stdout.strip() == "active":
            state["unit"] = unit
            break
    for unit in ("ssh.socket", "sshd.socket"):
        if _run(["systemctl", "is-active", unit]).stdout.strip() == "active":
            state["socket"] = unit
            break
    unit = state["unit"] or state["socket"] or "ssh.service"
    state["active"] = bool(_run(["systemctl", "is-active", unit]).stdout.strip() == "active")
    state["enabled"] = bool(_run(["systemctl", "is-enabled", unit]).stdout.strip() == "enabled")
    return state


def listening_ports() -> list[int]:
    """从 sshd 自身读生效端口（配置里可能有多条 Port 或 Include，读文本不可靠）。"""
    done = _run(["sshd", "-T"])
    ports = [int(v) for v in re.findall(r"^port (\d+)$", done.stdout, re.M)]
    if ports:
        return ports
    done = _run(["ss", "-ltnp"])
    return sorted({int(p) for p in re.findall(r":(\d+)\s+.*sshd", done.stdout)})


def _sshd_sessions() -> dict[str, dict]:
    """tty -> {user, pid}，来源是 `sshd: root@pts/0` 这类进程名。"""
    found: dict[str, dict] = {}
    done = _run(["ps", "-eo", "pid=,args="])
    for line in done.stdout.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) != 2:
            continue
        match = SSHD_SESSION_RE.match(parts[1].strip())
        if not match:
            continue
        user, tty = match.group(1), match.group(2)
        found[tty] = {"user": user, "pid": int(parts[0])}
    return found


def _logins() -> list[dict]:
    """`who -u` 的登录列表（user, tty, login time, idle, remote）。"""
    rows = []
    for line in _run(["who", "-u"]).stdout.splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        user, tty = parts[0], parts[1]
        idle = 0
        match = re.match(r"^(\d+):(\d+)$", parts[4])
        if match:
            idle = int(match.group(1)) * 60 + int(match.group(2))
        remote = parts[-1].strip("()")
        rows.append({
            "user": user,
            "tty": tty,
            "since": " ".join(parts[2:4]),
            "idle_seconds": idle,
            "from": remote if remote and remote != tty else "-",
            "login_pid": int(parts[5]) if len(parts) > 5 and parts[5].isdigit() else None,
        })
    return rows


def connections() -> list[dict]:
    """本机当前的 SSH 登录会话（who 的信息 + sshd 进程号）。"""
    sshd = _sshd_sessions()
    rows = []
    for login in _logins():
        tty = login["tty"]
        session = sshd.get(tty, {})
        rows.append({
            "user": login["user"],
            "tty": tty,
            "from": login["from"],
            "since": login["since"],
            "idle_seconds": login["idle_seconds"],
            "login_pid": login["login_pid"],
            "sshd_pid": session.get("pid"),
            "ssh_session": bool(session),        # 只有带 sshd 进程的才是 SSH 登录（否则是本机 tty）
        })
    rows.sort(key=lambda r: r["tty"])
    return rows


def status() -> dict:
    conns = connections()
    return {
        "service": service_state(),
        "ports": listening_ports(),
        "connections": conns,
        "count": len(conns),
        "ssh_count": sum(1 for c in conns if c["ssh_session"]),
    }


def disconnect(tty: str, sshd_pid: int | None = None) -> dict:
    """断开某个终端上的 SSH 登录。用 tty 现场解析进程，不信任传入的 pid。"""
    if not tty or not re.fullmatch(r"[A-Za-z0-9/._-]+", tty):
        raise SSHError("缺少或不合法的终端号")
    session = _sshd_sessions().get(tty)
    if not session:
        raise SSHError(f"{tty} 不是 SSH 登录会话，或它已经结束")
    pid = session["pid"]
    if sshd_pid and int(sshd_pid) != pid:
        raise SSHError("会话已变化（进程号不匹配），请刷新后重试")
    try:
        os.kill(pid, signal.SIGTERM)      # 结束这条连接的 sshd，客户端会看到 Connection closed
    except (ProcessLookupError, PermissionError) as exc:
        raise SSHError(f"结束进程失败：{exc}") from exc
    return {"tty": tty, "pid": pid, "user": session["user"], "method": "SIGTERM"}
