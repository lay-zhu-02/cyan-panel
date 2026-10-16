#!/bin/bash
# cyan-panel 管理脚本  —— 用法: ./panel.sh {start|stop|restart|status|logs|url|passwd|user-add|users|info|kill-sessions|update}
set -u
BASE="$(cd "$(dirname "$0")" && pwd)"
PY="$BASE/venv/bin/python"
UNIT="cyan-panel"

cd "$BASE" || exit 1

usage() {
  cat <<EOF
cyan-panel 管理脚本

  start / stop / restart / status   控制 systemd 服务
  logs                              跟踪日志 (Ctrl-C 退出)
  url                               打印访问地址
  info                              当前配置与统计
  users                             列出用户
  user-add <用户名> <密码>           新增用户
  passwd   <用户名> <密码>           改密码（会注销该用户所有会话）
  kill-sessions                     注销所有会话
  update                            升级 python 依赖并重启
  bump                              改了前端后刷新 index.html 里的 ?v= 版本号（挂 CDN 时必须）
EOF
}

case "${1:-}" in
  start|stop|restart|status)
    systemctl "$1" "$UNIT"
    ;;
  logs)
    journalctl -u "$UNIT" -f --no-pager
    ;;
  url)
    "$PY" - <<'PYEOF'
from app import config
cfg = config.load()
scheme = "https" if cfg.get("ssl_certfile") else "http"
print(f"{scheme}://{cfg['host']}:{cfg['port']}")
PYEOF
    ;;
  info)        "$PY" -m app.cli info ;;
  users)       "$PY" -m app.cli users ;;
  user-add)    shift; "$PY" -m app.cli user-add "$@" ;;
  passwd)      shift; "$PY" -m app.cli passwd "$@" ;;
  kill-sessions) "$PY" -m app.cli kill-sessions ;;
  bump)
    "$PY" "$BASE/tools/bump_static.py"
    ;;
  update)
    "$BASE/venv/bin/pip" install -q -U -r "$BASE/requirements.txt" && systemctl restart "$UNIT"
    ;;
  *)
    usage
    ;;
esac
