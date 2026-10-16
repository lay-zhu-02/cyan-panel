"""cyan-panel —— 轻量服务器运维面板。

模块划分：
    config    配置读写（data/config.json）
    auth      用户、会话、登录限流、审计
    metrics   后台采样线程 + 环形缓冲（给 dashboard 画曲线）
    sysinfo   系统信息、磁盘、网络、进程
    terminal  Web 终端（PTY ↔ WebSocket 桥接）
    main      FastAPI 应用与路由
"""

__version__ = "0.2.0"
__all__ = ["config", "auth", "metrics", "sysinfo", "terminal", "main"]
