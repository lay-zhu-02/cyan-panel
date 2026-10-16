#!/usr/bin/env python3
"""启动入口：读配置 → 拉起 uvicorn。systemd 直接跑这个文件。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import uvicorn  # noqa: E402

from app import config  # noqa: E402


def main() -> None:
    cfg = config.load()
    options = {
        "host": cfg["host"],
        "port": int(cfg["port"]),
        "log_level": "info",
        "access_log": False,
        "proxy_headers": bool(cfg.get("trust_proxy")),
        "forwarded_allow_ips": "*" if cfg.get("trust_proxy") else "127.0.0.1",
        "server_header": False,
        "date_header": False,
    }
    if cfg.get("ssl_certfile") and cfg.get("ssl_keyfile"):
        options["ssl_certfile"] = cfg["ssl_certfile"]
        options["ssl_keyfile"] = cfg["ssl_keyfile"]
        scheme = "https"
    else:
        scheme = "http"
    print(f"[cyan-panel] 监听 {scheme}://{cfg['host']}:{cfg['port']}", flush=True)
    uvicorn.run("app.main:app", **options)


if __name__ == "__main__":
    main()
