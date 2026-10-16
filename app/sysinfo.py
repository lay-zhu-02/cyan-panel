"""系统信息采集：概览 / 磁盘 / 网络 / 进程。全部来自 psutil 与 /proc，不 exec 外部命令。"""
import os
import socket
import time
from pathlib import Path

import psutil


# ---------------------------------------------------------------- 基础

def _os_release() -> dict:
    data: dict[str, str] = {}
    try:
        for line in Path("/etc/os-release").read_text(encoding="utf-8").splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                data[key.strip()] = value.strip().strip('"')
    except OSError:
        pass
    return data


def primary_ip() -> str | None:
    """取本机出口 IP。UDP connect 不会真的发包，只是让内核选路由。"""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 53))
        ip = sock.getsockname()[0]
        sock.close()
        return ip
    except OSError:
        return None


def _cpu_model() -> str:
    try:
        for line in Path("/proc/cpuinfo").read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.lower().startswith("model name"):
                return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return "unknown"


def _fmt_uptime(seconds: float) -> str:
    seconds = int(seconds)
    days, rest = divmod(seconds, 86400)
    hours, rest = divmod(rest, 3600)
    minutes, _ = divmod(rest, 60)
    parts = []
    if days:
        parts.append(f"{days} 天")
    if hours or days:
        parts.append(f"{hours} 小时")
    parts.append(f"{minutes} 分钟")
    return " ".join(parts)


# ---------------------------------------------------------------- 概览

def overview() -> dict:
    vm = psutil.virtual_memory()
    sm = psutil.swap_memory()
    osrel = _os_release()
    try:
        load = os.getloadavg()
    except OSError:
        load = (0.0, 0.0, 0.0)
    boot = psutil.boot_time()

    return {
        "hostname": socket.gethostname(),
        "os": osrel.get("PRETTY_NAME", "unknown"),
        "kernel": f"{os.uname().sysname} {os.uname().release}",
        "arch": os.uname().machine,
        "virtualization": _virtualization(),
        "uptime_seconds": int(time.time() - boot),
        "uptime_human": _fmt_uptime(time.time() - boot),
        "boot_time": int(boot),
        "time": int(time.time()),
        "primary_ip": primary_ip(),
        "cpu": {
            "model": _cpu_model(),
            "cores": psutil.cpu_count(logical=True),
            "physical": psutil.cpu_count(logical=False),
            "percent": psutil.cpu_percent(None),
            "per_core": psutil.cpu_percent(None, percpu=True),
            "load": [round(x, 2) for x in load],
        },
        "memory": {
            "total": vm.total, "used": vm.used, "available": vm.available,
            "percent": vm.percent, "cached": getattr(vm, "cached", 0),
            "buffers": getattr(vm, "buffers", 0),
        },
        "swap": {"total": sm.total, "used": sm.used, "percent": sm.percent},
        "disk_root": _root_disk(),
        "process_count": len(psutil.pids()),
        "user_count": len(psutil.users()),
    }


def _virtualization() -> str:
    detectors = ("systemd-detect-virt",)
    for _ in detectors:
        if Path("/.dockerenv").exists():
            return "docker"
    try:
        return Path("/sys/class/dmi/id/product_name").read_text(encoding="utf-8").strip()
    except OSError:
        return "unknown"


def _root_disk() -> dict:
    try:
        usage = psutil.disk_usage("/")
        return {"total": usage.total, "used": usage.used, "free": usage.free, "percent": usage.percent}
    except OSError:
        return {"total": 0, "used": 0, "free": 0, "percent": 0}


# ---------------------------------------------------------------- 磁盘

_SKIP_FSTYPES = {"squashfs", "iso9660", "autofs", "overlay", "devtmpfs", "ramfs"}


def disks() -> list[dict]:
    out = []
    for part in psutil.disk_partitions(all=False):
        if part.fstype in _SKIP_FSTYPES:
            continue
        try:
            usage = psutil.disk_usage(part.mountpoint)
        except (PermissionError, OSError):
            continue
        out.append({
            "device": part.device, "mountpoint": part.mountpoint, "fstype": part.fstype,
            "total": usage.total, "used": usage.used, "free": usage.free, "percent": usage.percent,
        })
    return out


# ---------------------------------------------------------------- 网络

def network() -> dict:
    addrs = []
    for name, list_ in psutil.net_if_addrs().items():
        for addr in list_:
            if addr.family == socket.AF_INET:
                addrs.append({"interface": name, "ip": addr.address, "netmask": addr.netmask})
            elif addr.family == socket.AF_INET6 and "%" not in addr.address:
                addrs.append({"interface": name, "ip": addr.address, "netmask": addr.netmask, "ipv6": True})
    io = {}
    for name, counters in psutil.net_io_counters(pernic=True).items():
        io[name] = {"rx": counters.bytes_recv, "tx": counters.bytes_sent,
                    "rx_packets": counters.packets_recv, "tx_packets": counters.packets_sent}
    return {"addresses": addrs, "io": io}


# ---------------------------------------------------------------- 进程

def processes(limit: int = 20, sort: str = "cpu") -> list[dict]:
    """psutil 的进程 CPU 百分比需要两次采样（第一次是基准）。"""
    fields = ["pid", "name", "username", "status", "memory_info", "memory_percent", "create_time"]
    for proc in psutil.process_iter(fields):
        try:
            proc.cpu_percent(None)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    time.sleep(0.15)

    cores = psutil.cpu_count(logical=True) or 1
    rows = []
    for proc in psutil.process_iter(fields):
        try:
            info = proc.info
            mem_info = info.get("memory_info")
            cmdline = " ".join(proc.cmdline() or [])[:300]
            rows.append({
                "pid": info["pid"],
                "name": info.get("name") or "?",
                "user": info.get("username") or "?",
                "status": info.get("status") or "?",
                "cpu": round((proc.cpu_percent(None) or 0.0) / cores, 2),
                "mem_percent": round(info.get("memory_percent") or 0.0, 2),
                "rss": getattr(mem_info, "rss", 0) if mem_info else 0,
                "started": int(info.get("create_time") or 0),
                "cmdline": cmdline,
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied, ProcessLookupError):
            continue

    key = "cpu" if sort == "cpu" else "rss"
    rows.sort(key=lambda r: r[key], reverse=True)
    return rows[: max(1, min(int(limit), 200))]
