"""认证 / 会话 / 登录限流 / 审计。

设计取舍（都是有意的）：
- 口令哈希用标准库 hashlib.scrypt，不引第三方依赖；存 "scrypt$n$r$p$salt$hash"
- 会话 token 只把 sha256 落库，明文只在 Cookie 里，库被读走也不能直接登录
- 登录限流是内存态：进程重启即清零，避免持久化状态出错把管理员永久锁在门外
"""
import hashlib
import hmac
import os
import secrets
import sqlite3
import time
from collections import defaultdict, deque
from typing import Optional

from . import config

# scrypt 参数：16MB 内存 / 次，约几十毫秒，够挡住离线爆破
_SCRYPT_N, _SCRYPT_R, _SCRYPT_P = 2 ** 14, 8, 1
_SCRYPT_MAXMEM = 64 * 1024 * 1024

DB_PATH = config.DATA_DIR / "panel.db"


# ---------------------------------------------------------------- 数据库

def _conn() -> sqlite3.Connection:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=15)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    return con


def init_db() -> None:
    with _conn() as con:
        con.executescript(
            """
            CREATE TABLE IF NOT EXISTS users(
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                username   TEXT UNIQUE NOT NULL,
                pwd_hash   TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                last_login INTEGER
            );
            CREATE TABLE IF NOT EXISTS sessions(
                token_hash TEXT PRIMARY KEY,
                user_id    INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                ip         TEXT,
                ua         TEXT
            );
            CREATE TABLE IF NOT EXISTS audit(
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                ts       INTEGER NOT NULL,
                username TEXT,
                ip       TEXT,
                action   TEXT,
                detail   TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts DESC);
            """
        )
    try:
        os.chmod(DB_PATH, 0o600)
    except OSError:
        pass


# ---------------------------------------------------------------- 口令

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R,
                        p=_SCRYPT_P, dklen=32, maxmem=_SCRYPT_MAXMEM)
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt_hex, dk_hex = stored.split("$")
        if scheme != "scrypt":
            return False
        expected = bytes.fromhex(dk_hex)
        calc = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex),
                              n=int(n), r=int(r), p=int(p), dklen=len(expected),
                              maxmem=_SCRYPT_MAXMEM)
        return hmac.compare_digest(calc, expected)
    except (ValueError, TypeError, AttributeError):
        return False


# ---------------------------------------------------------------- 用户

def user_count() -> int:
    with _conn() as con:
        return int(con.execute("SELECT COUNT(*) FROM users").fetchone()[0])


def create_user(username: str, password: str) -> bool:
    try:
        with _conn() as con:
            con.execute("INSERT INTO users(username, pwd_hash, created_at) VALUES (?,?,?)",
                        (username, hash_password(password), int(time.time())))
        return True
    except sqlite3.IntegrityError:
        return False


def set_password(username: str, password: str) -> bool:
    with _conn() as con:
        cur = con.execute("UPDATE users SET pwd_hash = ? WHERE username = ?",
                          (hash_password(password), username))
        return cur.rowcount > 0


def list_users() -> list[dict]:
    with _conn() as con:
        rows = con.execute("SELECT username, created_at, last_login FROM users ORDER BY id").fetchall()
    return [dict(r) for r in rows]


def verify_login(username: str, password: str) -> Optional[dict]:
    """成功返回用户 dict，失败返回 None。用户名不存在时也做一次哈希，避免时序侧信道。"""
    with _conn() as con:
        row = con.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    if row is None:
        hash_password(password)
        return None
    if not verify_password(password, row["pwd_hash"]):
        return None
    with _conn() as con:
        con.execute("UPDATE users SET last_login = ? WHERE id = ?", (int(time.time()), row["id"]))
    return {"id": row["id"], "username": row["username"]}


# ---------------------------------------------------------------- 会话

def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def create_session(user_id: int, ip: str, ua: str, ttl_hours: int) -> str:
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    with _conn() as con:
        con.execute(
            "INSERT INTO sessions(token_hash, user_id, created_at, expires_at, ip, ua) VALUES (?,?,?,?,?,?)",
            (_sha256(token), user_id, now, now + int(ttl_hours * 3600), ip, (ua or "")[:200]))
        con.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
    return token


def session_user(token: Optional[str]) -> Optional[dict]:
    if not token:
        return None
    now = int(time.time())
    with _conn() as con:
        row = con.execute(
            "SELECT u.id, u.username, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id"
            " WHERE s.token_hash = ? AND s.expires_at > ?", (_sha256(token), now)).fetchone()
    return dict(row) if row else None


def delete_session(token: Optional[str]) -> None:
    if not token:
        return
    with _conn() as con:
        con.execute("DELETE FROM sessions WHERE token_hash = ?", (_sha256(token),))


def delete_all_sessions(username: str) -> int:
    with _conn() as con:
        cur = con.execute(
            "DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username = ?)", (username,))
        return cur.rowcount


def session_count() -> int:
    with _conn() as con:
        return int(con.execute("SELECT COUNT(*) FROM sessions WHERE expires_at > ?",
                               (int(time.time()),)).fetchone()[0])


# ---------------------------------------------------------------- 审计

def audit(username: Optional[str], ip: str, action: str, detail: str = "") -> None:
    try:
        with _conn() as con:
            con.execute("INSERT INTO audit(ts, username, ip, action, detail) VALUES (?,?,?,?,?)",
                        (int(time.time()), username, ip, action, detail[:500]))
    except sqlite3.Error:
        pass


def recent_audit(limit: int = 50) -> list[dict]:
    with _conn() as con:
        rows = con.execute("SELECT ts, username, ip, action, detail FROM audit ORDER BY id DESC LIMIT ?",
                           (int(limit),)).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------- 登录限流

class Throttle:
    """按来源 IP 统计失败次数，超阈值临时锁定。状态只在内存里。"""

    def __init__(self) -> None:
        self._fails: dict[str, deque] = defaultdict(deque)
        self._blocked: dict[str, float] = {}

    def blocked_seconds(self, ip: str) -> int:
        until = self._blocked.get(ip, 0.0)
        left = int(until - time.time())
        if left <= 0:
            self._blocked.pop(ip, None)
            return 0
        return left

    def register_failure(self, ip: str, max_fails: int, lock_seconds: int) -> int:
        now = time.time()
        q = self._fails[ip]
        q.append(now)
        # 只保留锁定窗口内的失败记录
        while q and now - q[0] > lock_seconds:
            q.popleft()
        if len(q) >= max_fails:
            self._blocked[ip] = now + lock_seconds
            q.clear()
            return lock_seconds
        return 0

    def reset(self, ip: str) -> None:
        self._fails.pop(ip, None)
        self._blocked.pop(ip, None)
