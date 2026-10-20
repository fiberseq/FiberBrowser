"""One native graph helper process (``fiberbrowser-graph serve --package DIR``).

The helper runs one sequential job at a time over one read-only DB connection
and has no cancel command: synchronous native work cannot be interrupted. This
class therefore owns the process completely:

- one reader task continuously reads complete frames from stdout and routes each
  to the job that is waiting for it (a cancelled caller never becomes the reader);
- a lock serializes command writes, so frames cannot interleave;
- stderr is drained independently into a 64 KiB ring plus counters, so a chatty
  helper can never block on a full pipe or grow memory;
- startup has its own deadline (2 s by default) and every job a deadline from
  dispatch through complete frame receipt (1 s), covering the command write;
- any protocol violation (malformed/oversized/truncated frame, unknown or
  duplicate job ID, wrong generation, premature EOF), a deadline, a blocked pipe
  or cancellation of a running job kills and reaps the process. Nothing is reused
  after a failure; the pool starts a fresh epoch lazily.

If FiberBrowser itself dies, the helper sees EOF on stdin and exits, so no child
outlives the server.
"""
from __future__ import annotations

import asyncio
import collections
import os
import subprocess
import time
from typing import Optional

from services.graph_panel.frames import (
    MAX_CONTROL_BYTES, MAX_TOPOLOGY_BYTES, FrameError, command, encode_command, read_frame,
)
from services.graph_panel.helper import check_capabilities

STDERR_RING_BYTES = 64 << 10
STARTUP_TIMEOUT_S = 2.0
DISPATCH_DEADLINE_S = 1.0
REAP_TIMEOUT_S = 5.0

# PIDs of helper processes this server started and has not reaped yet (tests and shutdown check it).
LIVE_PIDS: set[int] = set()


class WorkerFailure(Exception):
    """A job or worker that ended without a valid terminal frame. ``retryable`` failures may succeed on a fresh worker."""

    def __init__(self, code: str, message: str = "", retryable: bool = True):
        super().__init__(f"{code}: {message}" if message else code)
        self.code = code
        self.message = message or code
        self.retryable = retryable


class StderrRing:
    """The last 64 KiB of the helper's stderr, with totals."""

    def __init__(self, capacity: int = STDERR_RING_BYTES):
        self.capacity = capacity
        self.chunks: collections.deque[bytes] = collections.deque()
        self.size = 0
        self.total_bytes = 0
        self.total_lines = 0
        self.dropped_bytes = 0

    def add(self, chunk: bytes) -> None:
        self.total_bytes += len(chunk)
        self.total_lines += chunk.count(b"\n")
        if len(chunk) > self.capacity:
            self.dropped_bytes += len(chunk) - self.capacity
            chunk = chunk[-self.capacity:]
        self.chunks.append(chunk)
        self.size += len(chunk)
        while self.size > self.capacity:
            head = self.chunks[0]
            excess = self.size - self.capacity
            if len(head) <= excess:
                self.chunks.popleft()
                self.size -= len(head)
                self.dropped_bytes += len(head)
            else:
                self.chunks[0] = head[excess:]
                self.size -= excess
                self.dropped_bytes += excess

    def text(self, limit: int = 2048) -> str:
        return b"".join(self.chunks)[-limit:].decode("utf-8", "replace")

    def stats(self) -> dict:
        return {"retained_bytes": self.size, "total_bytes": self.total_bytes, "total_lines": self.total_lines,
                "dropped_bytes": self.dropped_bytes}


def read_rss_bytes(pid: int) -> Optional[int]:
    """Resident set size of a process, or None when it cannot be read."""
    try:
        import psutil  # optional; not a FiberBrowser dependency
        return int(psutil.Process(pid).memory_info().rss)
    except ImportError:
        pass
    except Exception:
        return None
    statm = f"/proc/{pid}/statm"
    if os.path.exists(statm):
        try:
            with open(statm) as handle:
                return int(handle.read().split()[1]) * os.sysconf("SC_PAGE_SIZE")
        except (OSError, ValueError, IndexError):
            return None
    try:
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True, timeout=1).stdout
        return int(out.strip()) * 1024 if out.strip() else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def _consume(future: asyncio.Future) -> None:
    if not future.cancelled():
        future.exception()


class HelperWorker:
    """A helper process serving one package. Only the pool calls ``call`` (one job at a time)."""

    def __init__(self, helper_path: str, package_dir: str, registration_id: str, epoch: int, *,
                 startup_timeout_s: float = STARTUP_TIMEOUT_S, extra_args: tuple = (), env: Optional[dict] = None):
        self.helper_path = helper_path
        self.package_dir = package_dir
        self.registration_id = registration_id
        self.epoch = epoch
        self.startup_timeout_s = startup_timeout_s
        self.extra_args = tuple(extra_args)
        self.env = env
        self.proc: Optional[asyncio.subprocess.Process] = None
        self.handshake: dict = {}
        self.revisions: dict = {}
        self.topology_bytes = MAX_TOPOLOGY_BYTES
        self.jobs_per_process = 4096
        self.state = "new"            # new | starting | idle | busy | retired | dead
        self.death_reason: Optional[str] = None
        self.stderr = StderrRing()
        self.pending: dict[str, tuple[asyncio.Future, int]] = {}
        self.terminal_frames = 0
        self.sent_jobs = 0
        self.started_at: Optional[float] = None
        self.startup_ms: Optional[float] = None
        self.last_used = time.monotonic()
        self.peak_rss: Optional[int] = None
        self._write_lock = asyncio.Lock()
        self._reader: Optional[asyncio.Task] = None
        self._stderr_task: Optional[asyncio.Task] = None
        self._exited = asyncio.Event()

    # ------------------------------------------------------------------ lifecycle
    @property
    def pid(self) -> Optional[int]:
        return self.proc.pid if self.proc else None

    @property
    def alive(self) -> bool:
        return self.state in ("starting", "idle", "busy")

    async def start(self) -> None:
        self.state = "starting"
        t0 = time.perf_counter()
        try:
            self.proc = await asyncio.create_subprocess_exec(
                self.helper_path, "serve", "--package", self.package_dir, *self.extra_args,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                env=self.env, close_fds=True)
        except OSError as exc:
            self.state = "dead"
            self.death_reason = "startup_failed"
            raise WorkerFailure("startup_failed", f"cannot start the graph helper: {exc}") from None
        LIVE_PIDS.add(self.proc.pid)
        self.started_at = time.monotonic()
        self._stderr_task = asyncio.ensure_future(self._drain_stderr())
        try:
            frame = await asyncio.wait_for(read_frame(self.proc.stdout, MAX_CONTROL_BYTES), self.startup_timeout_s)
            if frame.type != "ready" or frame.job_id != "startup" or frame.generation != 0:
                raise WorkerFailure("startup_failed", f"first frame was {frame.type!r}/{frame.job_id!r}, not ready/startup")
            hs = frame.body.get("handshake")
            if not isinstance(hs, dict):
                raise WorkerFailure("startup_failed", "ready frame has no handshake")
            try:
                check_capabilities(hs)
            except RuntimeError as exc:
                raise WorkerFailure("schema_mismatch", str(exc), retryable=False) from None
        except asyncio.TimeoutError:
            await self.kill("startup_timeout")
            raise WorkerFailure("startup_timeout", f"helper not ready within {self.startup_timeout_s:g} s; "
                                f"stderr: {self.stderr.text(300)!r}") from None
        except FrameError as exc:
            await self.kill("startup_failed")
            raise WorkerFailure("startup_failed", f"{exc}; stderr: {self.stderr.text(300)!r}") from None
        except WorkerFailure as exc:
            await self.kill(exc.code)
            raise
        except asyncio.CancelledError:
            await self.kill("cancelled")
            raise
        self.handshake = hs
        self.revisions = frame.revisions
        self.topology_bytes = min(int(hs.get("topology_bytes") or MAX_TOPOLOGY_BYTES), MAX_TOPOLOGY_BYTES)
        self.jobs_per_process = int(hs.get("jobs_per_process") or 4096)
        self.startup_ms = (time.perf_counter() - t0) * 1000.0
        self.state = "idle"
        self._reader = asyncio.ensure_future(self._read_loop())

    async def _drain_stderr(self) -> None:
        stream = self.proc.stderr
        try:
            while True:
                chunk = await stream.read(8192)
                if not chunk:
                    return
                self.stderr.add(chunk)
        except (asyncio.CancelledError, Exception):
            return

    async def _read_loop(self) -> None:
        try:
            while True:
                try:
                    frame = await read_frame(self.proc.stdout, self.topology_bytes, self.topology_bytes)
                except FrameError as exc:
                    if exc.code == "eof" and not self.pending and self.terminal_frames >= self.jobs_per_process:
                        # The helper retires itself after its job budget: a normal end.
                        await self._finish("retired")
                    elif exc.code == "eof" and not self.pending and self.state == "retiring":
                        await self._finish("retired")
                    else:
                        await self.kill(f"protocol_{exc.code}", detail=str(exc))
                    return
                entry = self.pending.pop(frame.job_id, None)
                if entry is None:
                    await self.kill("protocol_unknown_job", detail=f"frame for unknown or finished job {frame.job_id!r}")
                    return
                future, generation = entry
                if frame.generation != generation:
                    self.pending[frame.job_id] = entry   # kill() fails it after reaping
                    await self.kill("protocol_generation", detail=f"job {frame.job_id} answered generation {frame.generation}")
                    return
                self.terminal_frames += 1
                if not future.done():
                    future.set_result(frame)
        except asyncio.CancelledError:
            return

    async def _finish(self, reason: str) -> None:
        """The process ended on its own (retirement); reap it."""
        self.state = "retired"
        self.death_reason = reason
        await self._reap()

    async def _reap(self) -> None:
        if self.proc is None:
            return
        try:
            await asyncio.wait_for(self.proc.wait(), REAP_TIMEOUT_S)
        except asyncio.TimeoutError:
            try:
                self.proc.kill()
            except ProcessLookupError:
                pass
            await self.proc.wait()
        LIVE_PIDS.discard(self.proc.pid)
        self._exited.set()
        # Close every pipe now (asyncio would otherwise wait for EOF on each and warn at loop close).
        transport = getattr(self.proc, "_transport", None)
        try:
            if transport is not None:
                transport.close()
            elif self.proc.stdin and not self.proc.stdin.is_closing():
                self.proc.stdin.close()
        except Exception:
            pass

    async def kill(self, reason: str, detail: str = "") -> None:
        """Kill and reap the process; every waiting job fails with ``reason``. Idempotent."""
        if self.state == "dead":
            if self.proc is not None and not self._exited.is_set():
                await self._exited.wait()
            return
        self.state = "dead"
        self.death_reason = reason
        failure = WorkerFailure(reason, detail or reason)
        pending = list(self.pending.values())
        self.pending.clear()
        if self.proc is not None:
            try:
                self.proc.kill()
            except ProcessLookupError:
                pass
            await self._reap()
        # Waiters learn of the failure only once the process is gone (reaped).
        for future, _ in pending:
            if not future.done():
                future.set_exception(failure)
                # Waiters that already gave up (a deadline) never read it: mark it read.
                future.add_done_callback(_consume)
        current = asyncio.current_task()
        for task in (self._reader, self._stderr_task):
            if task is not None and task is not current and not task.done():
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass

    async def shutdown(self, timeout_s: float = 1.0) -> None:
        """Ask an idle helper to exit (``shutdown`` → ``bye``); kill it otherwise or on any delay."""
        if not self.alive:
            if self.state in ("retiring", "retired"):
                try:
                    await asyncio.wait_for(self.proc.wait(), timeout_s)
                except asyncio.TimeoutError:
                    await self.kill("shutdown")
                    return
                await self._reap()
            return
        if self.state != "idle":
            await self.kill("shutdown")
            return
        self.state = "retiring"
        try:
            loop = asyncio.get_running_loop()
            future = loop.create_future()
            job_id = f"w{self.epoch}-shutdown"
            self.pending[job_id] = (future, self.epoch)
            data = encode_command(command("shutdown", job_id, self.epoch, self.revisions))
            async with self._write_lock:
                self.proc.stdin.write(data)
                await asyncio.wait_for(self.proc.stdin.drain(), timeout_s)
            frame = await asyncio.wait_for(future, timeout_s)
            if frame.type != "bye":
                raise WorkerFailure("protocol", f"shutdown answered {frame.type!r}")
            await asyncio.wait_for(self.proc.wait(), timeout_s)
            self.state = "dead"
            self.death_reason = "shutdown"
            await self._reap()
            if self._reader is not None and not self._reader.done():
                self._reader.cancel()
        except (asyncio.TimeoutError, WorkerFailure, OSError, ConnectionError):
            self.state = "busy"  # let kill() run its full path
            await self.kill("shutdown")

    # ------------------------------------------------------------------ jobs
    async def call(self, kind: str, fields: dict, deadline_s: float = DISPATCH_DEADLINE_S):
        """Send one command and return its terminal Frame within ``deadline_s`` (dispatch → complete frame).

        On deadline, broken pipe, protocol failure or cancellation the process is killed and reaped."""
        if self.state != "idle":
            raise WorkerFailure("worker_unavailable", f"worker is {self.state}")
        self.state = "busy"
        self.sent_jobs += 1
        job_id = f"w{self.epoch}-j{self.sent_jobs}"
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self.pending[job_id] = (future, self.epoch)
        deadline = loop.time() + deadline_s
        try:
            data = encode_command(command(kind, job_id, self.epoch, self.revisions, **fields))
            async with self._write_lock:
                self.proc.stdin.write(data)
                await asyncio.wait_for(self.proc.stdin.drain(), max(0.0, deadline - loop.time()))
            frame = await asyncio.wait_for(asyncio.shield(future), max(0.0, deadline - loop.time()))
        except asyncio.TimeoutError:
            await self.kill("deadline", f"no complete {kind} frame within {deadline_s * 1000:.0f} ms of dispatch")
            raise WorkerFailure("deadline", f"no complete {kind} frame within {deadline_s * 1000:.0f} ms of dispatch") from None
        except (BrokenPipeError, ConnectionResetError, ConnectionError) as exc:
            await self.kill("io", f"pipe to helper failed: {exc}")
            raise WorkerFailure("io", f"pipe to helper failed: {exc}") from None
        except FrameError as exc:   # our own command was oversized
            self.pending.pop(job_id, None)
            self.state = "idle"
            raise WorkerFailure("invalid_request", str(exc), retryable=False) from None
        except asyncio.CancelledError:
            # The native job cannot be interrupted: kill/reap rather than leave a busy worker behind.
            await self.kill("cancelled")
            raise
        finally:
            self.pending.pop(job_id, None)
        self.last_used = time.monotonic()
        if self.state == "busy":
            self.state = "idle"
            if self.terminal_frames >= self.jobs_per_process:
                self.state = "retiring"
        return frame

    def rss(self) -> Optional[int]:
        if not self.alive or self.pid is None:
            return None
        value = read_rss_bytes(self.pid)
        if value is not None:
            self.peak_rss = max(self.peak_rss or 0, value)
        return value

    def stats(self) -> dict:
        return {"epoch": self.epoch, "pid": self.pid, "state": self.state, "registration_id": self.registration_id,
                "jobs": self.terminal_frames, "startup_ms": self.startup_ms, "death_reason": self.death_reason,
                "peak_rss": self.peak_rss, "stderr": self.stderr.stats()}
