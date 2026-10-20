"""The interactive graph helper pool (DESIGN_GRAPH_PANEL.md §3, "Worker scheduling").

- At most ``max_workers`` (2) helper processes in total, started lazily; each
  serves one registration and runs one job at a time. A worker of another
  registration that is idle gives up its slot.
- Physical jobs are distinct from subscribers. A subscriber is one browser
  request (request ID, panel ID, panel generation); equivalent requests share
  one job and each gets the result with its own token.
- Per panel only the newest *queued* request is kept; panels are served round
  robin; queued work expires after ``queue_expiry_s`` (1 s).
- Cancelling a subscriber removes it. Only when no subscriber remains is the job
  dropped (queued) or its worker killed and reaped (running): native work cannot
  be interrupted any other way. A deadline or worker failure ends the job for
  every remaining subscriber with a retryable status.
- Memory: an idle worker above ``recycle_rss`` is recycled, a busy one above
  ``job_rss`` is killed (its job fails ``memory``), and the pool's total above
  ``aggregate_rss`` kills the largest. Sampling only: macOS has no usable OS
  limit on resident memory, so a large allocation can overshoot between samples.
- Complete topology results are cached in a byte-bounded LRU keyed by the
  immutable revisions and the full request; partial results (summaries) live
  for ``summary_ttl_s`` only. Errors and cancelled work are never cached.
"""
from __future__ import annotations

import asyncio
import collections
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

import orjson

from services.graph_panel.registration import Registration
from services.graph_panel.worker import DISPATCH_DEADLINE_S, STARTUP_TIMEOUT_S, HelperWorker, WorkerFailure

MiB = 1 << 20
GiB = 1 << 30
# Helper error codes that a fresh attempt will not change.
FINAL_HELPER_ERRORS = {"invalid_request", "selection_limit", "stale_revision", "schema_mismatch", "complexity_limit",
                       "package_data"}


class JobError(Exception):
    """What a subscriber gets instead of a result. ``status`` is the HTTP status the router answers."""

    def __init__(self, code: str, message: str, *, retryable: bool, status: int = 503, detail: Optional[dict] = None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.retryable = retryable
        self.status = status
        self.detail = detail or {}

    def payload(self) -> dict:
        return {"code": self.code, "message": self.message, "retryable": self.retryable, **self.detail}


def _error_status(code: str) -> int:
    return {"stale_revision": 409, "invalid_request": 422, "selection_limit": 413, "schema_mismatch": 409,
            "complexity_limit": 422, "package_data": 422, "cancelled": 409, "superseded": 409,
            "duplicate_request": 409}.get(code, 503)


@dataclass
class Subscriber:
    request_id: str
    panel_id: str
    generation: int
    future: asyncio.Future
    submitted: float


@dataclass
class Job:
    key: bytes
    reg: Registration
    kind: str
    fields: dict
    enqueued: float
    subscribers: dict = field(default_factory=dict)
    state: str = "queued"                 # queued | running | done
    task: Optional[asyncio.Task] = None
    worker: Optional[HelperWorker] = None
    panel_id: str = ""
    shared: bool = False


class ResultCache:
    def __init__(self, max_bytes: int = 64 * MiB, summary_ttl_s: float = 30.0):
        self.max_bytes = max_bytes
        self.summary_ttl_s = summary_ttl_s
        self.items: "collections.OrderedDict[bytes, tuple[int, dict, Optional[float]]]" = collections.OrderedDict()
        self.bytes = 0
        self.hits = 0
        self.misses = 0

    def get(self, key: bytes) -> Optional[dict]:
        entry = self.items.get(key)
        if entry is None:
            self.misses += 1
            return None
        size, result, expires = entry
        if expires is not None and time.monotonic() > expires:
            self._drop(key)
            self.misses += 1
            return None
        self.items.move_to_end(key)
        self.hits += 1
        return result

    def put(self, key: bytes, result: dict, size: int) -> bool:
        if size > self.max_bytes:
            return False
        complete = bool(result.get("complete")) and not result.get("summaries")
        expires = None if complete else time.monotonic() + self.summary_ttl_s
        if key in self.items:
            self._drop(key)
        self.items[key] = (size, result, expires)
        self.bytes += size
        while self.bytes > self.max_bytes and self.items:
            self._drop(next(iter(self.items)))
        return True

    def _drop(self, key: bytes) -> None:
        size, _, _ = self.items.pop(key)
        self.bytes -= size

    def clear(self) -> None:
        self.items.clear()
        self.bytes = 0

    def stats(self) -> dict:
        return {"entries": len(self.items), "bytes": self.bytes, "max_bytes": self.max_bytes, "hits": self.hits,
                "misses": self.misses}


class GraphPool:
    def __init__(self, helper_path: Callable[[], Optional[str]], *, max_workers: int = 2,
                 queue_expiry_s: float = 1.0, deadline_s: float = DISPATCH_DEADLINE_S,
                 startup_timeout_s: float = STARTUP_TIMEOUT_S, cache_bytes: int = 64 * MiB,
                 summary_ttl_s: float = 30.0, recycle_rss: int = 1 * GiB, job_rss: int = int(1.5 * GiB),
                 aggregate_rss: int = 2 * GiB, monitor_interval_s: float = 0.05,
                 check_registration: Optional[Callable[[Registration], None]] = None,
                 worker_args: tuple = (), worker_env: Optional[dict] = None):
        self.helper_path = helper_path
        self.max_workers = max_workers
        self.queue_expiry_s = queue_expiry_s
        self.deadline_s = deadline_s
        self.startup_timeout_s = startup_timeout_s
        self.recycle_rss = recycle_rss
        self.job_rss = job_rss
        self.aggregate_rss = aggregate_rss
        self.monitor_interval_s = monitor_interval_s
        self.check_registration = check_registration
        self.worker_args = worker_args
        self.worker_env = worker_env
        self.cache = ResultCache(cache_bytes, summary_ttl_s)
        self.loop = asyncio.get_running_loop()
        self.workers: list[HelperWorker] = []
        self.reserved: dict[int, Job] = {}         # id(worker) -> the job that owns it until that job ends
        self.jobs: dict[bytes, Job] = {}
        self.requests: dict[str, Job] = {}
        self.queues: "collections.OrderedDict[str, collections.deque[Job]]" = collections.OrderedDict()
        self.epoch = 0
        self.closing = False
        self.background: set[asyncio.Task] = set()
        self.tasks: set[asyncio.Task] = set()
        self.retiring: set[HelperWorker] = set()
        self.counters: collections.Counter = collections.Counter()
        self._monitor: Optional[asyncio.Task] = None
        self._expiry_handle: Optional[asyncio.TimerHandle] = None
        self._startup_failures: dict[str, list[float]] = {}

    # ------------------------------------------------------------------ public API
    async def submit(self, reg: Registration, kind: str, fields: dict, *, request_id: str, panel_id: str,
                     generation: int, use_cache: bool = True) -> dict:
        """Run (or join) a job and return this subscriber's response. Raises JobError."""
        if self.closing:
            raise JobError("shutdown", "the graph service is shutting down", retryable=True)
        if request_id in self.requests:
            raise JobError("duplicate_request", f"request {request_id!r} is already pending", retryable=False, status=409)
        if self.check_registration is not None:
            # Every request, before the cache or a shared job: a package edited since verification is refused, and
            # whatever was derived from it (cache entries, workers) is dropped.
            try:
                self.check_registration(reg)
            except Exception as exc:
                await self.forget_registration(reg.id)
                raise JobError(getattr(exc, "code", "package_changed"), str(getattr(exc, "message", exc)),
                               retryable=False, status=getattr(exc, "status", 409)) from None
        key = orjson.dumps([reg.id, reg.revisions, kind, fields], option=orjson.OPT_SORT_KEYS)
        now = self.loop.time()
        # A newer request of the panel replaces its queued ones even when the cache answers it.
        self._supersede(panel_id)
        if kind == "query" and use_cache:
            cached = self.cache.get(key)
            if cached is not None:
                self.counters["cache_hits"] += 1
                return {"request_id": request_id, "panel_id": panel_id, "generation": generation, "status": "ok",
                        "cached": True, "result": cached, "timings": {"queue_ms": 0.0, "total_ms": 0.0}}
        sub = Subscriber(request_id, panel_id, generation, self.loop.create_future(), now)
        job = self.jobs.get(key)
        if job is not None and job.state in ("queued", "running"):
            self.counters["shared"] += 1
            job.shared = True
        else:
            job = Job(key, reg, kind, fields, now, panel_id=panel_id)
            self.jobs[key] = job
            self.queues.setdefault(panel_id, collections.deque()).append(job)
        job.subscribers[request_id] = sub
        self.requests[request_id] = job
        self._pump()
        try:
            return await sub.future
        except asyncio.CancelledError:
            # The HTTP handler went away (client disconnect): same as an explicit cancel.
            self.cancel(request_id)
            raise
        finally:
            self.requests.pop(request_id, None)

    def cancel(self, request_id: str, code: str = "cancelled") -> bool:
        job = self.requests.pop(request_id, None)
        if job is None:
            return False
        sub = job.subscribers.pop(request_id, None)
        if sub is not None and not sub.future.done():
            sub.future.set_exception(JobError(code, f"request {code}", retryable=False, status=409))
            sub.future.add_done_callback(_consume)
        self.counters[code] += 1
        if job.subscribers and job.state == "queued" and not any(sb.panel_id == job.panel_id for sb in job.subscribers.values()):
            # Its panel left a job other panels still wait for: it queues under one of theirs (not ahead of the
            # panel's own newer request).
            self._unqueue(job)
            job.panel_id = next(iter(job.subscribers.values())).panel_id
            self.queues.setdefault(job.panel_id, collections.deque()).append(job)
        if not job.subscribers:
            if job.state == "queued":
                self._unqueue(job)
                self._forget(job)
                job.state = "done"
            elif job.state == "running" and job.task is not None and not job.task.done():
                # The last subscriber left a running job: kill/reap its worker (DESIGN §3). The job leaves the
                # table now, so an equal request arriving while the process is reaped starts a fresh job.
                self.counters["killed_on_last_cancel"] += 1
                job.state = "cancelling"
                self._forget(job)
                job.task.cancel()
        return True

    async def forget_registration(self, reg_id: str) -> None:
        """Drop a registration's cached results, queued and running jobs and its helpers (its package changed)."""
        prefix = orjson.dumps([reg_id])[:-1]
        for key in [k for k in self.cache.items if k.startswith(prefix)]:
            self.cache._drop(key)
        for job in [j for j in list(self.jobs.values()) if j.reg.id == reg_id]:
            if job.state == "queued":
                self._unqueue(job)
            if job.task is not None and not job.task.done():
                job.task.cancel()
            self._fail_job(job, JobError("package_changed", "the graph package changed since it was verified",
                                         retryable=False, status=409))
        for w in [w for w in self.workers if w.registration_id == reg_id]:
            self.workers.remove(w)
            self._retire(w, kill=True)

    def stats(self) -> dict:
        return {
            "max_workers": self.max_workers,
            "workers": [w.stats() for w in self.workers],
            "queued": sum(len(q) for q in self.queues.values()),
            "running": sum(1 for j in self.jobs.values() if j.state == "running"),
            "subscribers": len(self.requests),
            "cache": self.cache.stats(),
            "counters": dict(self.counters),
            "epoch": self.epoch,
        }

    async def close(self) -> None:
        """Fail queued work, kill running jobs, shut idle helpers down, and reap every child."""
        self.closing = True
        if self._expiry_handle is not None:
            self._expiry_handle.cancel()
        for job in list(self.jobs.values()):
            for rid in list(job.subscribers):
                sub = job.subscribers.pop(rid)
                self.requests.pop(rid, None)
                if not sub.future.done():
                    sub.future.set_exception(JobError("shutdown", "the graph service is shutting down", retryable=True))
                    sub.future.add_done_callback(_consume)
        for task in list(self.tasks):
            if not task.done():
                task.cancel()
        for task in list(self.tasks):
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        self.queues.clear()
        self.jobs.clear()
        await asyncio.gather(*(w.shutdown() for w in list(self.workers)), return_exceptions=True)
        for task in list(self.background):
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        for w in [*self.workers, *self.retiring]:
            await w.kill("shutdown")
        self.workers.clear()
        self.retiring.clear()
        if self._monitor is not None:
            self._monitor.cancel()
            try:
                await self._monitor
            except (asyncio.CancelledError, Exception):
                pass

    # ------------------------------------------------------------------ scheduling
    def _supersede(self, panel_id: str) -> None:
        """Keep only the newest queued request of a panel: older queued subscribers of it are dropped."""
        queue = self.queues.get(panel_id)
        jobs = list(queue) if queue else []
        for job in self.jobs.values():
            if job.state == "queued" and job not in jobs and any(s.panel_id == panel_id for s in job.subscribers.values()):
                jobs.append(job)
        for job in jobs:
            for rid, sub in list(job.subscribers.items()):
                if sub.panel_id == panel_id:
                    self.cancel(rid, "superseded")

    def _forget(self, job: Job) -> None:
        if self.jobs.get(job.key) is job:
            del self.jobs[job.key]

    def _unqueue(self, job: Job) -> None:
        queue = self.queues.get(job.panel_id)
        if queue is not None:
            try:
                queue.remove(job)
            except ValueError:
                pass
            if not queue:
                self.queues.pop(job.panel_id, None)

    def _expire(self) -> None:
        now = self.loop.time()
        for job in [j for q in self.queues.values() for j in q]:
            if now - job.enqueued >= self.queue_expiry_s:
                self._unqueue(job)
                self._forget(job)
                job.state = "done"
                self.counters["queue_expired"] += 1
                for rid in list(job.subscribers):
                    sub = job.subscribers.pop(rid)
                    self.requests.pop(rid, None)
                    if not sub.future.done():
                        sub.future.set_exception(JobError(
                            "queue_timeout", f"queued longer than {self.queue_expiry_s * 1000:.0f} ms; both graph workers were busy",
                            retryable=True))
                        sub.future.add_done_callback(_consume)

    def _retire(self, worker: HelperWorker, kill: bool = False) -> None:
        """Shut a worker down (or kill it) in the background. Until it is reaped it still holds a process slot and
        counts toward the aggregate memory limit."""
        self.retiring.add(worker)

        async def go():
            try:
                if kill:
                    await worker.kill("retired")
                else:
                    await worker.shutdown()
            finally:
                if worker.proc is not None and not worker._exited.is_set():
                    await worker.kill("retired")   # whatever happened above: reaped before the slot frees
                self.retiring.discard(worker)
                if not self.closing:
                    self._pump()
        self._spawn_bg(go())

    def _await_reaped(self, worker: HelperWorker) -> None:
        if worker in self.retiring:
            return
        self.retiring.add(worker)

        async def go():
            try:
                await worker._exited.wait()
            finally:
                self.retiring.discard(worker)
                if not self.closing:
                    self._pump()
        self._spawn_bg(go())

    def _slots_used(self) -> int:
        return len(self.workers) + len(self.retiring)

    def _prune(self) -> None:
        keep = []
        for w in self.workers:
            if w.state in ("dead",) and id(w) not in self.reserved:
                if w.proc is not None and not w._exited.is_set():
                    self._await_reaped(w)   # still being reaped: it keeps its slot until then
                continue
            if w.state in ("retiring", "retired") and id(w) not in self.reserved:
                self._retire(w)
                continue
            keep.append(w)
        self.workers = keep

    def _take_worker(self, reg: Registration) -> Optional[HelperWorker]:
        """An idle worker of this registration, a new one in a free slot, or one taken from an idle other package."""
        for w in self.workers:
            if w.registration_id == reg.id and w.state == "idle" and id(w) not in self.reserved:
                return w
        if self._slots_used() >= self.max_workers:
            victim = next((w for w in sorted(self.workers, key=lambda w: w.last_used)
                           if w.state == "idle" and id(w) not in self.reserved and w.registration_id != reg.id), None)
            if victim is None:
                return None
            self.workers.remove(victim)
            self.counters["evicted_other_package"] += 1
            self._retire(victim)
            # Its slot frees once it is reaped (the pump runs again then).
            return None
        helper = self.helper_path()
        if not helper:
            return None
        self.epoch += 1
        worker = HelperWorker(helper, reg.package_dir, reg.id, self.epoch, startup_timeout_s=self.startup_timeout_s,
                              extra_args=self.worker_args, env=self.worker_env)
        self.workers.append(worker)
        return worker

    def _pump(self) -> None:
        if self.closing:
            return
        self._expire()
        self._prune()
        progressed = True
        while progressed and self.queues:
            progressed = False
            for panel_id in list(self.queues.keys()):
                queue = self.queues.get(panel_id)
                if not queue:
                    continue
                job = queue[0]
                if self._failing(job.reg):
                    queue.popleft()
                    if not queue:
                        self.queues.pop(panel_id, None)
                    self._fail_job(job, JobError("helper_failing", "the graph helper failed to start repeatedly; retry shortly",
                                                 retryable=True))
                    progressed = True
                    continue
                if not self.helper_path():
                    queue.popleft()
                    if not queue:
                        self.queues.pop(panel_id, None)
                    self._fail_job(job, JobError("helper_unavailable", "the graph helper is not installed", retryable=False))
                    progressed = True
                    continue
                worker = self._take_worker(job.reg)
                if worker is None:
                    continue
                queue.popleft()
                if not queue:
                    self.queues.pop(panel_id, None)
                else:
                    self.queues.move_to_end(panel_id)   # round robin between panels
                self.reserved[id(worker)] = job
                job.state = "running"
                job.worker = worker
                job.task = self.loop.create_task(self._run(job, worker))
                self.tasks.add(job.task)
                job.task.add_done_callback(lambda task, job=job, worker=worker: self._job_done(task, job, worker))
                progressed = True
                break
        if self.queues:
            self._schedule_expiry()
        self._ensure_monitor()

    def _ensure_monitor(self) -> None:
        unreaped = any(w.proc is not None and not w._exited.is_set() for w in [*self.workers, *self.retiring])
        if not self.closing and unreaped and (self._monitor is None or self._monitor.done()):
            self._monitor = self.loop.create_task(self._watch_memory())

    def _schedule_expiry(self) -> None:
        if self._expiry_handle is not None:
            self._expiry_handle.cancel()
        oldest = min(j.enqueued for q in self.queues.values() for j in q)
        delay = max(0.0, oldest + self.queue_expiry_s - self.loop.time()) + 0.001
        self._expiry_handle = self.loop.call_later(delay, self._pump)

    def _failing(self, reg: Registration) -> bool:
        now = time.monotonic()
        recent = [t for t in self._startup_failures.get(reg.id, []) if now - t < 10.0]
        self._startup_failures[reg.id] = recent
        return len(recent) >= 3 and now - recent[-1] < 5.0

    def _fail_job(self, job: Job, error: JobError) -> None:
        job.state = "done"
        self._forget(job)
        for rid in list(job.subscribers):
            sub = job.subscribers.pop(rid)
            self.requests.pop(rid, None)
            if not sub.future.done():
                sub.future.set_exception(error)
                sub.future.add_done_callback(_consume)

    def _spawn_bg(self, coro) -> None:
        task = self.loop.create_task(coro)
        self.background.add(task)
        task.add_done_callback(self.background.discard)
        task.add_done_callback(_consume)

    def _job_done(self, task: asyncio.Task, job: Job, worker: HelperWorker) -> None:
        """Runs however the job task ended, even cancelled before its first step (then _run's finally never ran)."""
        self.tasks.discard(task)
        if self.reserved.get(id(worker)) is job:   # only this job's own reservation (a successor may hold it now)
            del self.reserved[id(worker)]
            if worker.state == "new" and worker in self.workers:
                self.workers.remove(worker)   # never started: nothing to reap
            if job.state != "done":
                job.state = "done"
                self._forget(job)
            if not self.closing:
                self._pump()

    async def _run(self, job: Job, worker: HelperWorker) -> None:
        dispatched = self.loop.time()
        startup_ms = None
        try:
            if worker.state == "new":
                if self.check_registration is not None:
                    self.check_registration(job.reg)
                self.counters["workers_started"] += 1
                try:
                    await worker.start()
                except WorkerFailure:
                    self._startup_failures.setdefault(job.reg.id, []).append(time.monotonic())
                    raise
                self._startup_failures.pop(job.reg.id, None)
                startup_ms = worker.startup_ms
                self._ensure_monitor()
                if worker.revisions != job.reg.revisions:
                    await worker.kill("stale_package")
                    raise JobError("stale_revision", "the helper opened a package with other revisions than were registered",
                                   retryable=False, status=409)
            sent = self.loop.time()
            frame = await worker.call(job.kind, job.fields, self.deadline_s)
            received = self.loop.time()
            if frame.type == "error":
                err = frame.body.get("error") or {}
                code = str(err.get("code") or "helper_error")
                raise JobError(code, str(err.get("message") or code), retryable=code not in FINAL_HELPER_ERRORS,
                               status=_error_status(code))
            payload = frame.body.get("result") if job.kind == "query" else frame.body
            if job.kind == "query":
                if frame.type != "topology" or not isinstance(payload, dict):
                    await worker.kill("protocol_type")
                    raise JobError("protocol", f"query answered {frame.type!r}", retryable=True)
                self.cache.put(job.key, payload, frame.size)
            self.counters[f"ok_{job.kind}"] += 1
            job.state = "done"
            self._forget(job)
            for rid in list(job.subscribers):
                sub = job.subscribers.pop(rid)
                if not sub.future.done():
                    sub.future.set_result({
                        "request_id": rid, "panel_id": sub.panel_id, "generation": sub.generation, "status": "ok",
                        "cached": False, "result": payload,
                        "timings": {
                            "queue_ms": round((dispatched - sub.submitted) * 1000, 3),
                            "startup_ms": None if startup_ms is None else round(startup_ms, 3),
                            "dispatch_ms": round((received - sent) * 1000, 3),
                            "total_ms": round((received - sub.submitted) * 1000, 3),
                            "frame_bytes": frame.size, "worker_epoch": worker.epoch, "shared": job.shared,
                        },
                    })
        except asyncio.CancelledError:
            # No subscriber is left (cancel or shutdown); worker.call/start already killed and reaped the process.
            await worker.kill("cancelled")
            job.state = "done"
            self._forget(job)
        except WorkerFailure as exc:
            self.counters[f"worker_{exc.code}"] += 1
            self._fail_job(job, JobError(exc.code, exc.message, retryable=exc.retryable,
                                         status=409 if exc.code == "schema_mismatch" else 503))
        except JobError as exc:
            self.counters[f"error_{exc.code}"] += 1
            self._fail_job(job, exc)
        except Exception as exc:  # a registration check, say: fail the job, never the pool
            self.counters["error_internal"] += 1
            await worker.kill("internal")
            code = getattr(exc, "code", "internal")
            self._fail_job(job, JobError(code, str(getattr(exc, "message", exc)), retryable=False,
                                         status=getattr(exc, "status", 500)))
        finally:
            if self.reserved.get(id(worker)) is job:
                del self.reserved[id(worker)]
            if not self.closing:
                self._pump()

    # ------------------------------------------------------------------ memory
    async def _watch_memory(self) -> None:
        try:
            while not self.closing and any(w.proc is not None and not w._exited.is_set() for w in [*self.workers, *self.retiring]):
                # Every process not yet reaped counts, retiring ones included.
                alive = [w for w in [*self.workers, *self.retiring]
                         if w.proc is not None and not w._exited.is_set() and w.state not in ("new", "starting")]
                samples = await asyncio.gather(*(asyncio.to_thread(w.rss) for w in alive))
                total = 0
                for w, rss in zip(alive, samples):
                    if rss is None:
                        continue
                    total += rss
                    if w.state == "busy" and rss > self.job_rss:
                        self.counters["memory_killed"] += 1
                        await w.kill("memory", f"helper used {rss / MiB:.0f} MiB, above the {self.job_rss / MiB:.0f} MiB job limit")
                    elif w.state == "idle" and rss > self.recycle_rss and id(w) not in self.reserved:
                        self.counters["memory_recycled"] += 1
                        if w in self.workers:
                            self.workers.remove(w)
                        self._retire(w)
                # The total of what is still running after the per-worker kills above.
                living = [(rss, w) for w, rss in zip(alive, samples) if rss is not None and not w._exited.is_set()]
                total = sum(r for r, _ in living)
                if total > self.aggregate_rss:
                    if living:
                        rss, w = max(living, key=lambda x: x[0])
                        self.counters["memory_aggregate_killed"] += 1
                        await w.kill("memory", f"graph workers used {total / MiB:.0f} MiB together, above {self.aggregate_rss / MiB:.0f} MiB")
                await asyncio.sleep(self.monitor_interval_s)
        except asyncio.CancelledError:
            return


def _consume(future: asyncio.Future) -> None:
    if not future.cancelled():
        future.exception()
