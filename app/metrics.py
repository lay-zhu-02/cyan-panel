"""后台指标采样：独立线程 + 环形缓冲，给 dashboard 画曲线。

为什么用环形缓冲而不是写库：dashboard 只需要最近窗口的曲线，
2 秒一个点 × 900 个点 ≈ 30 分钟，内存里放着够用且不磨盘。
"""
import collections
import os
import threading
import time

import psutil


class Metrics:
    def __init__(self, interval: int = 2, points: int = 900) -> None:
        self.interval = max(1, int(interval))
        self.buf: collections.deque = collections.deque(maxlen=max(10, int(points)))
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.latest: dict = {}

        # 计数器类指标要先取一次基准，否则第一次采样会是开机以来的总量
        psutil.cpu_percent(None)
        self._last_net = psutil.net_io_counters()
        self._last_disk = psutil.disk_io_counters()
        self._last_ts = time.time()

    # ------------------------------------------------------------ 采样

    def sample_once(self) -> dict:
        now = time.time()
        dt = max(now - self._last_ts, 0.001)
        net = psutil.net_io_counters()
        disk = psutil.disk_io_counters()
        vm = psutil.virtual_memory()
        sm = psutil.swap_memory()
        try:
            load1, _, _ = os.getloadavg()
        except OSError:
            load1 = 0.0

        point = {
            "ts": round(now, 3),
            "cpu": round(psutil.cpu_percent(None), 1),
            "mem": round(vm.percent, 1),
            "swap": round(sm.percent, 1),
            "load1": round(load1, 2),
            "net_rx": max(0, int((net.bytes_recv - self._last_net.bytes_recv) / dt)),
            "net_tx": max(0, int((net.bytes_sent - self._last_net.bytes_sent) / dt)),
            "disk_r": max(0, int((disk.read_bytes - self._last_disk.read_bytes) / dt)) if disk else 0,
            "disk_w": max(0, int((disk.write_bytes - self._last_disk.write_bytes) / dt)) if disk else 0,
        }
        self._last_net, self._last_disk, self._last_ts = net, disk, now
        self.buf.append(point)
        self.latest = point
        return point

    # ------------------------------------------------------------ 生命周期

    def _loop(self) -> None:
        while not self._stop.wait(self.interval):
            try:
                self.sample_once()
            except Exception:
                # 采样失败不能让线程死掉
                pass

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self.sample_once()
        self._thread = threading.Thread(target=self._loop, name="panel-metrics", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)

    # ------------------------------------------------------------ 查询

    def history(self, points: int | None = None) -> list[dict]:
        data = list(self.buf)
        if points and points > 0:
            data = data[-int(points):]
        return data

    def snapshot(self) -> dict:
        return {"latest": self.latest, "interval": self.interval,
                "points": len(self.buf), "started": bool(self._thread and self._thread.is_alive())}
