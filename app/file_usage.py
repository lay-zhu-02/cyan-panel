"""Bounded, lazy disk-usage scans for the file browser (Linux du semantics)."""
from __future__ import annotations

from collections import OrderedDict
from pathlib import Path
import queue
import subprocess
import threading
import time

from . import files


class DirectoryUsage:
    def __init__(self, *, timeout: float = 20, ttl: float = 60, capacity: int = 256):
        self.timeout, self.ttl, self.capacity = timeout, ttl, capacity
        self._entries = OrderedDict()
        self._queue = queue.Queue(maxsize=64)
        self._lock = threading.Lock()
        self._closed = threading.Event()
        self._thread = None
        self._process = None

    def snapshot(self, path: str, names: list[str], root: str, refresh: bool = False) -> dict:
        if not 1 <= len(names) <= 64 or any(
            not name or name in ('.', '..') or '/' in name or '\x00' in name for name in names
        ):
            raise files.FileError('一次只能统计 1–64 个当前目录下的文件夹')
        parent = files.resolve(path, root)
        if not parent.is_dir():
            raise files.FileError('只能统计文件夹')
        items = []
        for name in dict.fromkeys(names):
            public_path = str(parent / name)
            try:
                target = files.resolve(public_path, root)
                if target.is_symlink() or not target.is_dir():
                    raise files.FileError('不统计符号链接目标')
                real = target.resolve()
                if any(real == Path(p) or Path(p) in real.parents for p in ('/proc', '/sys', '/dev', '/run')):
                    items.append({'path': public_path, 'size': None, 'status': 'excluded'})
                    continue
            except (files.FileError, OSError):
                items.append({'path': public_path, 'size': None, 'status': 'unavailable'})
                continue
            key = (str(Path(root).resolve()), str(real))
            with self._lock:
                entry = self._entries.get(key)
                if entry and entry['status'] not in ('pending', 'calculating') and (
                    refresh or time.monotonic() - entry['at'] > self.ttl
                ):
                    del self._entries[key]
                    entry = None
                if entry is None:
                    # Evict completed results only; active work has a fixed queue bound.
                    while len(self._entries) >= self.capacity:
                        old = next((k for k, v in self._entries.items() if v['status'] not in ('pending', 'calculating')), None)
                        if old is None:
                            break
                        del self._entries[old]
                    entry = {'status': 'pending', 'size': None, 'at': time.monotonic()}
                    if len(self._entries) < self.capacity and not self._closed.is_set():
                        try:
                            self._queue.put_nowait((key, entry))
                        except queue.Full:
                            pass
                        else:
                            self._entries[key] = entry
                            if self._thread is None:
                                self._thread = threading.Thread(target=self._work, daemon=True, name='directory-usage')
                                self._thread.start()
                elif key in self._entries:
                    self._entries.move_to_end(key)
                items.append({'path': public_path, 'size': entry['size'], 'status': entry['status']})
        return {'path': str(parent), 'items': items}

    def _measure(self, root: str, raw: str) -> tuple[str, int | None]:
        try:
            target = files.resolve(raw, root)
            if target.is_symlink() or not target.is_dir() or str(target.resolve()) != raw:
                return 'unavailable', None
            # du counts allocated blocks, handles sparse/hard-linked files, and never follows links.
            process = subprocess.Popen(
                ['/usr/bin/nice', '-n', '10', '/usr/bin/du', '--summarize', '--one-file-system',
                 '--block-size=1', '--null', '--no-dereference', '--', str(target)],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            )
            with self._lock:
                self._process = process
                if self._closed.is_set():
                    process.kill()
            try:
                output, _ = process.communicate(timeout=self.timeout)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
                return 'timeout', None
            finally:
                with self._lock:
                    self._process = None
            number, separator, _ = output.partition(b'\t')
            if not separator or not number.isdigit():
                return 'unavailable', None
            return ('ready' if process.returncode == 0 else 'partial'), int(number)
        except (files.FileError, OSError):
            return 'unavailable', None

    def _work(self):
        while not self._closed.is_set():
            try:
                key, entry = self._queue.get(timeout=.2)
            except queue.Empty:
                continue
            try:
                with self._lock:
                    if self._entries.get(key) is not entry:
                        continue
                    entry['status'] = 'calculating'
                status, size = self._measure(*key)
                with self._lock:
                    if self._entries.get(key) is entry:
                        entry.update(status=status, size=size, at=time.monotonic())
            finally:
                self._queue.task_done()

    def invalidate(self):
        # Results of work already in flight cannot repopulate this new cache generation.
        with self._lock:
            self._entries.clear()

    def close(self):
        self._closed.set()
        with self._lock:
            process = self._process
        if process:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        if self._thread:
            self._thread.join(timeout=2)
