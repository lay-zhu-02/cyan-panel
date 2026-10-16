#!/usr/bin/env python3
"""命令行工具：初始化管理员、改密码、看状态。

用法（在 /opt/cyan-panel 下）：
    venv/bin/python -m app.cli user-add <用户名> <密码>
    venv/bin/python -m app.cli passwd   <用户名> <密码>
    venv/bin/python -m app.cli users
    venv/bin/python -m app.cli info
    venv/bin/python -m app.cli kill-sessions
"""
import secrets
import sys
import time

from . import auth, config


def _need(n: int) -> None:
    if len(sys.argv) < n:
        print(__doc__)
        sys.exit(1)


def cmd_user_add() -> None:
    _need(4)
    username, password = sys.argv[2], sys.argv[3]
    auth.init_db()
    if len(password) < 8:
        sys.exit("密码至少 8 位")
    if auth.create_user(username, password):
        print(f"已创建用户 {username}")
    else:
        sys.exit(f"用户 {username} 已存在")


def cmd_passwd() -> None:
    _need(4)
    auth.init_db()
    if auth.set_password(sys.argv[2], sys.argv[3]):
        n = auth.delete_all_sessions(sys.argv[2])
        print(f"已更新 {sys.argv[2]} 的密码，注销了 {n} 个会话")
    else:
        sys.exit("用户不存在")


def cmd_users() -> None:
    auth.init_db()
    for u in auth.list_users():
        last = time.strftime("%Y-%m-%d %H:%M", time.localtime(u["last_login"])) if u["last_login"] else "从未登录"
        print(f"  {u['username']:<20} 最近登录: {last}")


def cmd_info() -> None:
    cfg = config.load()
    auth.init_db()
    scheme = "https" if cfg.get("ssl_certfile") else "http"
    print(f"  配置:  {config.CONFIG_PATH}")
    print(f"  监听:  {scheme}://{cfg['host']}:{cfg['port']}")
    print(f"  用户:  {len(auth.list_users())} 个")
    print(f"  会话:  {auth.session_count()} 个有效")
    print(f"  采样:  每 {cfg['sample_interval']}s 一次，保留 {cfg['history_points']} 个点")
    print(f"  终端:  {cfg['terminal_shell']} @ {cfg['terminal_cwd']}，最多 {cfg['terminal_max']} 个并发")


def cmd_kill_sessions() -> None:
    auth.init_db()
    with auth._conn() as con:
        n = con.execute("DELETE FROM sessions").rowcount
    print(f"已注销 {n} 个会话")


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    commands = {
        "user-add": cmd_user_add,
        "passwd": cmd_passwd,
        "users": cmd_users,
        "info": cmd_info,
        "kill-sessions": cmd_kill_sessions,
        "random-password": lambda: print(secrets.token_urlsafe(15)),
    }
    handler = commands.get(sys.argv[1])
    if not handler:
        print(__doc__)
        sys.exit(1)
    handler()


if __name__ == "__main__":
    main()
