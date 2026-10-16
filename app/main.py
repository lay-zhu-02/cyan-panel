"""FastAPI 应用：认证、系统 API、Web 终端 WebSocket。"""
import asyncio
import time
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import __version__, auth, config, files, file_usage, metrics, storage, sysinfo, terminal
from . import ssh as sshmgr

CFG = config.load()
SAMPLER = metrics.Metrics(interval=CFG["sample_interval"], points=CFG["history_points"])
THROTTLE = auth.Throttle()
COOKIE_NAME = "cyan_panel_session"
FILE_ROOT = CFG.get("file_root") or "/"
MAX_UPLOAD = int(CFG.get("file_upload_max_mb", 512)) * 1024 * 1024
SHOW_HIDDEN = bool(CFG.get("file_show_hidden", True))
FILE_USAGE = file_usage.DirectoryUsage()
STORAGE = storage.StorageAnalysis(FILE_ROOT)


# ---------------------------------------------------------------- 生命周期

@asynccontextmanager
async def lifespan(_app: FastAPI):
    auth.init_db()
    SAMPLER.start()
    auth.audit("system", "-", "startup", f"version={__version__} listen={CFG['host']}:{CFG['port']}")
    try:
        yield
    finally:
        STORAGE.close()
        FILE_USAGE.close()
        SAMPLER.stop()


app = FastAPI(
    title="cyan-panel",
    version=__version__,
    docs_url=None, redoc_url=None, openapi_url=None,   # 不暴露接口文档
    lifespan=lifespan,
)

config.STATIC_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(config.STATIC_DIR)), name="static")


# ---------------------------------------------------------------- 安全响应头

@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
        "script-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'",
    )
    return response


# ---------------------------------------------------------------- 工具

def _client_ip(request: Request) -> str:
    if CFG.get("trust_proxy"):
        fwd = request.headers.get("x-forwarded-for", "")
        if fwd:
            return fwd.split(",")[0].strip()
    return request.client.host if request.client else "-"


def _ua(request: Request) -> str:
    return (request.headers.get("user-agent") or "")[:200]


def current_user(request: Request) -> dict:
    """依赖：Cookie 或 Authorization: Bearer 都必须有效。"""
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        header = request.headers.get("authorization", "")
        if header.lower().startswith("bearer "):
            token = header[7:].strip()
    user = auth.session_user(token)
    if not user:
        raise HTTPException(status_code=401, detail="未登录或会话已过期")
    return user


# The adapter supplies authentication; the portable theme library has no account dependency.
from .themes import router as themes_router, asset_router as theme_assets
app.include_router(themes_router, dependencies=[Depends(current_user)])
app.include_router(theme_assets)


class LoginBody(BaseModel):
    username: str
    password: str


class PasswordBody(BaseModel):
    old_password: str
    new_password: str


class FilePathBody(BaseModel):
    path: str


class FileWriteBody(BaseModel):
    path: str
    content: str
    create_only: bool = False


class FileRenameBody(BaseModel):
    src: str
    dst: str


class FileDeleteBody(BaseModel):
    paths: list[str]
    recursive: bool = False


class FileChmodBody(BaseModel):
    path: str
    mode: str


class SshDisconnectBody(BaseModel):
    tty: str
    sshd_pid: Optional[int] = None


class TerminalKillBody(BaseModel):
    id: str


def _guard(exc: Exception, status: int = 400):
    return HTTPException(status_code=status, detail=str(exc) or exc.__class__.__name__)


# ---------------------------------------------------------------- 页面

@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(config.STATIC_DIR / "index.html")


@app.get("/api/health", include_in_schema=False)
async def health():
    return {"status": "ok", "version": __version__, "time": int(time.time()),
            "metrics": SAMPLER.snapshot()}


# ---------------------------------------------------------------- 认证

@app.post("/api/auth/login")
async def login(body: LoginBody, request: Request, response: Response):
    ip = _client_ip(request)
    left = THROTTLE.blocked_seconds(ip)
    if left:
        auth.audit(body.username, ip, "login_blocked", f"还需等待 {left}s")
        raise HTTPException(status_code=429, detail=f"失败次数过多，请 {left} 秒后再试")

    user = auth.verify_login(body.username, body.password)
    if not user:
        locked = THROTTLE.register_failure(ip, CFG["max_login_fails"], CFG["lockout_seconds"])
        auth.audit(body.username, ip, "login_failed", f"锁定 {locked}s" if locked else "")
        detail = "用户名或密码错误"
        if locked:
            detail = f"失败次数过多，已锁定 {locked} 秒"
        raise HTTPException(status_code=401, detail=detail)

    THROTTLE.reset(ip)
    token = auth.create_session(user["id"], ip, _ua(request), CFG["session_ttl_hours"])
    response.set_cookie(
        COOKIE_NAME, token,
        max_age=int(CFG["session_ttl_hours"] * 3600),
        httponly=True, samesite="lax",
        secure=bool(CFG.get("ssl_certfile")) or request.url.scheme == "https", path="/",
    )
    auth.audit(user["username"], ip, "login_ok")
    return {"ok": True, "user": user["username"], "expires_hours": CFG["session_ttl_hours"]}


@app.post("/api/auth/logout")
async def logout(request: Request, response: Response, user: dict = Depends(current_user)):
    token = request.cookies.get(COOKIE_NAME)
    auth.delete_session(token)
    auth.audit(user["username"], _client_ip(request), "logout")
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


@app.get("/api/auth/me")
async def me(request: Request, user: dict = Depends(current_user)):
    return {
        "user": user["username"],
        "expires_at": user["expires_at"],
        "version": __version__,
        "host": CFG["host"],
        "port": CFG["port"],
        "session_ttl_hours": CFG["session_ttl_hours"],
        "ssl": bool(CFG.get("ssl_certfile")),
    }


@app.post("/api/auth/password")
async def change_password(body: PasswordBody, request: Request, response: Response,
                          user: dict = Depends(current_user)):
    if len(body.new_password) < 8:
        raise HTTPException(status_code=400, detail="新密码至少 8 位")
    login_user = auth.verify_login(user["username"], body.old_password)
    if not login_user:
        auth.audit(user["username"], _client_ip(request), "password_change_failed", "原密码错误")
        raise HTTPException(status_code=400, detail="原密码错误")
    auth.set_password(user["username"], body.new_password)
    auth.delete_all_sessions(user["username"])          # 改密后踢掉所有旧会话
    auth.audit(user["username"], _client_ip(request), "password_changed")
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True, "message": "密码已修改，请重新登录"}


# ---------------------------------------------------------------- 系统信息

@app.get("/api/system/overview")
async def api_overview(user: dict = Depends(current_user)):
    data = sysinfo.overview()
    data["metrics"] = SAMPLER.snapshot()
    data["panel"] = {"version": __version__, "sessions": auth.session_count(),
                     "users": len(auth.list_users())}
    return data


@app.get("/api/system/metrics")
async def api_metrics(points: int = 300, user: dict = Depends(current_user)):
    return {"interval": SAMPLER.interval, "points": SAMPLER.history(points), "latest": SAMPLER.latest}


@app.get("/api/system/processes")
async def api_processes(limit: int = 20, sort: str = "cpu", user: dict = Depends(current_user)):
    return {"items": await asyncio.to_thread(sysinfo.processes, limit, sort)}


@app.get("/api/system/disks")
async def api_disks(user: dict = Depends(current_user)):
    return {"items": sysinfo.disks()}


@app.get("/api/system/storage")
async def api_storage(refresh: bool = False, user: dict = Depends(current_user)):
    return STORAGE.snapshot(refresh)


@app.get("/api/system/network")
async def api_network(user: dict = Depends(current_user)):
    return sysinfo.network()


@app.get("/api/audit")
async def api_audit(limit: int = 50, user: dict = Depends(current_user)):
    return {"items": auth.recent_audit(limit)}


# ---------------------------------------------------------------- 文件管理器

@app.get("/api/files/list")
async def api_files_list(path: Optional[str] = None, user: dict = Depends(current_user)):
    try:
        data = files.list_dir(path or FILE_ROOT, FILE_ROOT, SHOW_HIDDEN)
        data["disk"] = files.disk_usage(data["path"], FILE_ROOT)
        return data
    except files.FileError as exc:
        raise _guard(exc)


class DirectoryUsageBody(BaseModel):
    path: str
    names: list[str]
    refresh: bool = False


@app.post("/api/files/usage")
async def api_files_usage(body: DirectoryUsageBody, user: dict = Depends(current_user)):
    try:
        return await asyncio.to_thread(FILE_USAGE.snapshot, body.path, body.names, FILE_ROOT, body.refresh)
    except files.FileError as exc:
        raise _guard(exc)


@app.get("/api/files/read")
async def api_files_read(path: str, user: dict = Depends(current_user)):
    try:
        return files.read_text(path, FILE_ROOT)
    except files.FileError as exc:
        raise _guard(exc)


@app.get("/api/files/download")
async def api_files_download(path: str, request: Request, user: dict = Depends(current_user)):
    try:
        target = files.resolve(path, FILE_ROOT)
        if not target.is_file():
            raise files.FileError("只能下载普通文件")
    except files.FileError as exc:
        raise _guard(exc)
    auth.audit(user["username"], _client_ip(request), "file_download", str(target))
    return FileResponse(str(target), filename=target.name,
                        media_type="application/octet-stream")


@app.put("/api/files/upload")
async def api_files_upload(request: Request, path: str = "/", name: str = "",
                           overwrite: bool = False, user: dict = Depends(current_user)):
    async def chunks():
        async for chunk in request.stream():
            yield chunk

    try:
        result = await files.save_upload(name or "upload.bin", path, chunks(),
                                         FILE_ROOT, MAX_UPLOAD, overwrite)
    except files.FileError as exc:
        auth.audit(user["username"], _client_ip(request), "file_upload_failed", f"{path}/{name}: {exc}")
        raise _guard(exc)
    FILE_USAGE.invalidate()
    auth.audit(user["username"], _client_ip(request), "file_upload",
               f"{result['path']} {result['size']}B")
    return result


@app.post("/api/files/write")
async def api_files_write(body: FileWriteBody, request: Request, user: dict = Depends(current_user)):
    try:
        result = files.write_text(body.path, body.content, FILE_ROOT, create_only=body.create_only)
    except (files.FileError, OSError) as exc:
        raise _guard(exc)
    auth.audit(user["username"], _client_ip(request), "file_write",
               f"{result['path']} {result['size']}B" + ("（新建）" if result["created"] else ""))
    FILE_USAGE.invalidate()
    return result


@app.post("/api/files/mkdir")
async def api_files_mkdir(body: FilePathBody, request: Request, user: dict = Depends(current_user)):
    try:
        result = files.mkdir(body.path, FILE_ROOT)
    except (files.FileError, OSError) as exc:
        raise _guard(exc)
    auth.audit(user["username"], _client_ip(request), "file_mkdir", result["path"])
    FILE_USAGE.invalidate()
    return result


@app.post("/api/files/rename")
async def api_files_rename(body: FileRenameBody, request: Request, user: dict = Depends(current_user)):
    try:
        result = files.rename(body.src, body.dst, FILE_ROOT)
    except (files.FileError, OSError) as exc:
        raise _guard(exc)
    auth.audit(user["username"], _client_ip(request), "file_rename",
               f"{result['from']} -> {result['to']}")
    FILE_USAGE.invalidate()
    return result


@app.post("/api/files/delete")
async def api_files_delete(body: FileDeleteBody, request: Request, user: dict = Depends(current_user)):
    try:
        result = files.delete(body.paths, FILE_ROOT, body.recursive)
    except files.FileError as exc:
        raise _guard(exc)
    auth.audit(user["username"], _client_ip(request), "file_delete",
               f"删除 {len(result['removed'])} 项，跳过 {len(result['skipped'])} 项：{', '.join(result['removed'])[:160]}")
    FILE_USAGE.invalidate()
    return result


@app.post("/api/files/chmod")
async def api_files_chmod(body: FileChmodBody, request: Request, user: dict = Depends(current_user)):
    try:
        result = files.chmod(body.path, body.mode, FILE_ROOT)
    except (files.FileError, OSError) as exc:
        raise _guard(exc)
    auth.audit(user["username"], _client_ip(request), "file_chmod", f"{result['path']} -> {result['mode']}")
    FILE_USAGE.invalidate()
    return result


# ---------------------------------------------------------------- SSH 远程终端管理

@app.get("/api/ssh/status")
async def api_ssh_status(user: dict = Depends(current_user)):
    try:
        return sshmgr.status()
    except sshmgr.SSHError as exc:
        raise _guard(exc)


@app.post("/api/ssh/disconnect")
async def api_ssh_disconnect(body: SshDisconnectBody, request: Request,
                             user: dict = Depends(current_user)):
    try:
        result = sshmgr.disconnect(body.tty, body.sshd_pid)
    except sshmgr.SSHError as exc:
        auth.audit(user["username"], _client_ip(request), "ssh_disconnect_failed", str(exc)[:200])
        raise _guard(exc)
    auth.audit(user["username"], _client_ip(request), "ssh_disconnect",
               f"tty={result['tty']} pid={result['pid']} user={result['user']}")
    return result


# ---------------------------------------------------------------- 终端会话管理

@app.get("/api/terminal/sessions")
async def api_terminal_sessions(user: dict = Depends(current_user)):
    return {"items": terminal.list_sessions(), "max": int(CFG["terminal_max"])}


@app.post("/api/terminal/kill")
async def api_terminal_kill(body: TerminalKillBody, request: Request,
                            user: dict = Depends(current_user)):
    try:
        result = await terminal.kill_session(body.id)
    except KeyError as exc:
        raise _guard(exc, status=404)
    auth.audit(user["username"], _client_ip(request), "terminal_kill",
               f"id={result['id']} pid={result['pid']}")
    return result


# ---------------------------------------------------------------- Web 终端

@app.websocket("/ws/terminal")
async def ws_terminal(websocket: WebSocket):
    user = auth.session_user(websocket.cookies.get(COOKIE_NAME))
    if not user:
        # 未认证：直接拒绝握手，不进入 PTY
        await websocket.close(code=1008)
        return
    if terminal.count() >= int(CFG["terminal_max"]):
        await websocket.close(code=1013)
        return

    await websocket.accept()
    query = websocket.query_params
    cols = max(20, min(int(query.get("cols", 100) or 100), 500))
    rows = max(5, min(int(query.get("rows", 30) or 30), 200))
    session_id = query.get("session") or terminal.new_session_id()
    ip = _client_ip(websocket)
    terminal.register(session_id, user["username"], ip, websocket, cols, rows)
    auth.audit(user["username"], ip, "terminal_open", f"id={session_id} active={terminal.count()}")
    try:
        await terminal.run_terminal(
            websocket,
            shell=CFG["terminal_shell"],
            cwd=CFG["terminal_cwd"],
            cols=cols,
            rows=rows,
            session_id=session_id,
        )
    except Exception as exc:                      # 终端异常不应该影响面板进程
        auth.audit(user["username"], ip, "terminal_error", repr(exc)[:200])
    finally:
        terminal.unregister(session_id)
        auth.audit(user["username"], ip, "terminal_close",
                   f"id={session_id} active={terminal.count()}")
