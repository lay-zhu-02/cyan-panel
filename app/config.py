"""配置：JSON 文件 + 默认值，所有路径都由 CYAN_PANEL_BASE_DIR 决定。

改配置的两种方式：
    1) 直接编辑 /opt/cyan-panel/data/config.json 后 systemctl restart cyan-panel
    2) 面板界面里的设置页（后续版本）
"""
import json
import os
from pathlib import Path

BASE_DIR = Path(os.environ.get("CYAN_PANEL_BASE_DIR", Path(__file__).resolve().parent.parent))
DATA_DIR = BASE_DIR / "data"
STATIC_DIR = BASE_DIR / "app" / "static"
CONFIG_PATH = DATA_DIR / "config.json"

DEFAULTS = {
    # 监听地址：0.0.0.0 = 公网可访问；改成 127.0.0.1 就只允许本机/SSH 隧道访问
    "host": "0.0.0.0",
    "port": 8899,
    # 会话有效期（小时）
    "session_ttl_hours": 12,
    # 同一 IP 连续失败多少次后临时锁定，以及锁定时长（秒）
    "max_login_fails": 5,
    "lockout_seconds": 300,
    # 指标采样
    "sample_interval": 2,
    "history_points": 900,
    # Web 终端
    "terminal_shell": "/bin/bash",
    "terminal_cwd": "/root",
    # 同时最多几个终端会话（防止 fork 炸弹）
    "terminal_max": 4,
    # 是否信任 X-Forwarded-For（面板挂在 Cloudflare/Nginx 后面时打开，否则按 IP 限流会失效）
    "trust_proxy": False,
    # 可选：启用 HTTPS（填了证书路径才生效）
    "ssl_certfile": "",
    "ssl_keyfile": "",
    # 文件管理器：能操作的根目录（越界会被拒绝）、上传上限、是否显示隐藏文件
    "file_root": "/",
    "file_upload_max_mb": 512,
    "file_show_hidden": True,
    # SSH 管理：读改哪份 authorized_keys。留空 = 面板进程的用户（root）
    "ssh_key_user": "",
}


def load() -> dict:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    cfg = dict(DEFAULTS)
    if CONFIG_PATH.exists():
        try:
            cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            # 配置损坏时退回默认值，不让面板起不来
            pass
    return cfg


def save(cfg: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(CONFIG_PATH)
