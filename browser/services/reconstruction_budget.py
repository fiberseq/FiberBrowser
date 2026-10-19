"""Shared allocation/work reservations and killable reconstruction jobs.

The parent reserves before starting a worker. The worker charges each actual
alignment before allocation, including changed backbones in later rounds.
Cancellation kills/reaps compiled kernels too, including initial compilation.
No listener, multiprocessing manager, shared server or user-state files.
"""
from __future__ import annotations

from contextvars import ContextVar
from dataclasses import asdict, dataclass
from dataclasses import replace
from functools import wraps
import atexit
import importlib
import multiprocessing
import pickle
import threading
import time

MIB = 1024 ** 2


@dataclass(frozen=True)
class Limits:
    version: str = "reconstruction:v1"
    pair_cells: int = 25_000_000
    request_cells: int = 100_000_000
    job_bytes: int = 256 * MIB
    request_bytes: int = 512 * MIB
    process_bytes: int = 1024 * MIB
    large_job_bytes: int = 16 * MIB
    max_queued: int = 8
    max_inputs: int = 512
    max_input_bases: int = 2_000_000
    max_reconstructed_bases: int = 100_000
    max_response_bytes: int = 16 * MIB
    wavefront_max_bases: int = 10_000
    wavefront_pair_states: int = 4_000_000
    deadline_s: float = 30.0

    def __post_init__(self):
        if any(not isinstance(v, (int, float)) or v <= 0 for k, v in asdict(self).items() if k != "version"):
            raise ValueError("positive reconstruction limits required")
        if self.job_bytes > self.request_bytes or self.request_bytes > self.process_bytes:
            raise ValueError("job <= request <= process reservation required")


DEFAULT_LIMITS = Limits()


class ResourceResult(Exception):
    def __init__(self, status, reason, **parameters):
        self.status, self.reason, self.parameters = status, reason, parameters
        super().__init__(reason)

    def payload(self):
        return {"status": self.status, "reason": self.reason, "parameters": self.parameters,
                "budget_version": DEFAULT_LIMITS.version, "complete": False}


def estimate_alignment(n, m, w):
    if min(n, m, w) < 0:
        raise ValueError("negative alignment shape")
    cells = (n + 1) * (2 * w + 1) if n and m else 0
    matrix_bytes = cells * 5  # int32 score + uint8 trace
    # 2x matrix headroom; centers, encoded inputs, ops, knot/vote temporaries.
    reserved_bytes = 2 * matrix_bytes + 128 * (n + m + 2)
    return {"cells": cells, "matrix_bytes": matrix_bytes, "reserved_bytes": reserved_bytes,
            "n": n, "m": m, "band_width": w}


_current = ContextVar("reconstruction_request", default=None)
_parent_request = ContextVar("reconstruction_parent_request", default=None)


def budgeted_request(function):
    """Share work/deadline across successive isolated jobs in one request."""
    @wraps(function)
    def call(*args, **kwargs):
        if _parent_request.get() is not None:
            return function(*args, **kwargs)
        token = _parent_request.set({"cells": 0, "deadline": time.monotonic() + DEFAULT_LIMITS.deadline_s})
        try:
            return function(*args, **kwargs)
        finally:
            _parent_request.reset(token)
    return call


class WorkBudget:
    def __init__(self, limits=DEFAULT_LIMITS):
        self.limits, self.cells = limits, 0
        self.algorithm = 'banded:v1'

    def pair(self, n, m, w):
        estimate = estimate_alignment(n, m, w)
        if estimate["cells"] > self.limits.pair_cells or estimate["reserved_bytes"] > self.limits.job_bytes:
            raise ResourceResult("budget_exceeded", "alignment_pair", **estimate)
        if self.cells + estimate["cells"] > self.limits.request_cells:
            raise ResourceResult("budget_exceeded", "request_cells", cells=self.cells + estimate["cells"])
        if max(n, m) > self.limits.max_reconstructed_bases:
            raise ResourceResult("budget_exceeded", "reconstructed_bases", bases=max(n, m))
        self.cells += estimate["cells"]
        return estimate

    def wavefront(self, n, m):
        """Bound the next allocation; the kernel charges actual visited states.

        Reserving every pair's worst case as spent work would reject ordinary
        identical cohorts. Sequential calls share the remaining actual budget.
        """
        if max(n, m) > self.limits.wavefront_max_bases:
            raise ResourceResult('budget_exceeded', 'wavefront_bases', bases=max(n, m))
        states = min(self.limits.wavefront_pair_states, self.limits.pair_cells, self.limits.request_cells - self.cells)
        delta = abs(n - m)
        # Exact upper bound across score rows: the mandatory length-changing
        # diagonals plus two extra diagonals per six units of excess cost.
        def count(score):
            q, r = divmod(score, 6)
            return (score + 1) * (delta + 1) + 6 * q * (q - 1) + 2 * q * (r + 1)
        def allocation(score):
            cells = (score + 1) * (delta + 2 * (score // 6) + 1)
            return cells, 10 * cells + 128 * (n + m + 2)
        if states < delta + 1:
            raise ResourceResult('budget_exceeded', 'wavefront_states', states=states, n=n, m=m)
        cells, reserved = allocation(0)
        if cells > self.limits.pair_cells or reserved > self.limits.job_bytes:
            raise ResourceResult('budget_exceeded', 'wavefront_allocation', cells=cells, reserved_bytes=reserved)
        low, high = 0, int((6 * max(0, states)) ** .5) + 1
        while low < high:
            mid = (low + high + 1) // 2
            cells, reserved = allocation(mid)
            if count(mid) <= states and cells <= self.limits.pair_cells and reserved <= self.limits.job_bytes:
                low = mid
            else:
                high = mid - 1
        score = low
        return score, states

    def plan_wavefront(self, n, m):
        self.wavefront(n, m)
        # Only this lower bound is unavoidable before sequences are aligned.
        self.cells += abs(n - m) + 1

    def native_stage(self, pairs):
        """Preflight a native mapping stage after its actual backbone exists.

        A preceding DAF stage retains its different scoring/kernel. Remaining
        native knots may use the bounded native alternative without discarding
        any prior work or resetting the request's cell counter.
        """
        if self.algorithm == 'weighted_wavefront:v1':
            return
        remaining = self.limits.request_cells - self.cells
        if remaining <= 0:
            raise ResourceResult('budget_exceeded', 'request_cells', cells=self.cells)
        check = WorkBudget(replace(self.limits, request_cells=remaining))
        try:
            for pair in pairs:
                check.pair(*pair)
        except ResourceResult:
            alternative = WorkBudget(replace(self.limits, request_cells=remaining))
            for n, m, _width in pairs:
                alternative.plan_wavefront(n, m)
            self.algorithm = 'weighted_wavefront:v1'


class Reservations:
    def __init__(self, limits=DEFAULT_LIMITS):
        self.limits = limits
        self.condition = threading.Condition()
        self.bytes = self.large = self.queued = 0

    def acquire(self, size, large, deadline, checkpoint):
        # Idle numerical workers must yield to real allocations. Their memory
        # stays charged until they are reaped, even when no request owns them.
        if self is globals().get('RESERVATIONS') and size and self.bytes + size > self.limits.process_bytes:
            close_warm_worker()
        with self.condition:
            if size > self.limits.process_bytes:
                raise ResourceResult("budget_exceeded", "process_bytes", bytes=size)
            if self.queued >= self.limits.max_queued:
                raise ResourceResult("budget_exceeded", "queue_full", queued=self.queued)
            self.queued += 1
            try:
                while True:
                    checkpoint()
                    if time.monotonic() >= deadline:
                        raise ResourceResult("budget_exceeded", "deadline", seconds=self.limits.deadline_s)
                    if self.bytes + size <= self.limits.process_bytes and not (large and self.large):
                        self.bytes += size
                        self.large += int(large)
                        return
                    self.condition.wait(0.02)
            finally:
                self.queued -= 1

    def release(self, size, large):
        with self.condition:
            self.bytes -= size
            self.large -= int(large)
            self.condition.notify_all()


RESERVATIONS = Reservations()


def _worker(connection, module, name, args, kwargs, limits, algorithm, *, close=True):
    budget = WorkBudget(limits)
    budget.algorithm = algorithm
    token = _current.set(budget)
    try:
        result = getattr(importlib.import_module(module), name)(*args, **kwargs)
        encoded = pickle.dumps(("ok", result, budget.cells, budget.algorithm), protocol=5)
        if len(encoded) > limits.max_response_bytes:
            raise ResourceResult("budget_exceeded", "response_bytes", bytes=len(encoded))
        connection.send_bytes(encoded)
    except ResourceResult as exc:
        connection.send(("resource", exc.payload()))
    except BaseException as exc:
        connection.send(("error", type(exc).__name__ + ": " + str(exc)))
    finally:
        _current.reset(token)
        if close:
            connection.close()


def _warm_worker(connection):
    """One numerical worker, no listener; discard job values between requests."""
    import gc
    try:
        while True:
            job = connection.recv()
            _worker(connection, *job, close=False)
            del job
            gc.collect()
    except (EOFError, OSError):
        pass
    finally:
        connection.close()


_warm_lock = threading.Lock()
_warm_idle = None
_warm_timer = None
WARM_IDLE_SECONDS = 60.0


def _reap(process, connection):
    if process is not None and process.pid is not None:
        if process.is_alive():
            process.kill()
        process.join()
        process.close()
    if connection is not None:
        connection.close()


def close_warm_worker():
    """Reclaim the idle worker and its retained memory reservation."""
    global _warm_idle, _warm_timer
    with _warm_lock:
        idle, _warm_idle = _warm_idle, None
        if _warm_timer is not None:
            _warm_timer.cancel()
            _warm_timer = None
    if idle is not None:
        process, connection, size = idle
        _reap(process, connection)
        RESERVATIONS.release(size, False)


def _take_warm(size):
    global _warm_idle, _warm_timer
    with _warm_lock:
        idle, _warm_idle = _warm_idle, None
        if _warm_timer is not None:
            _warm_timer.cancel()
            _warm_timer = None
    if idle is not None:
        process, connection, reserved = idle
        if reserved == size and process.is_alive():
            return process, connection
        _reap(process, connection)
        RESERVATIONS.release(reserved, False)
    return None


def _expire_warm(expected):
    global _warm_idle, _warm_timer
    with _warm_lock:
        if _warm_idle is not expected:
            return
        _warm_idle, _warm_timer = None, None
    process, connection, size = expected
    _reap(process, connection)
    RESERVATIONS.release(size, False)


def _keep_warm(process, connection, size):
    global _warm_idle, _warm_timer
    with _warm_lock:
        old = _warm_idle
        if _warm_timer is not None:
            _warm_timer.cancel()
        _warm_idle = process, connection, size
        _warm_timer = threading.Timer(WARM_IDLE_SECONDS, _expire_warm, args=(_warm_idle,))
        _warm_timer.daemon = True
        _warm_timer.start()
    if old is not None:
        old_process, old_connection, reserved = old
        _reap(old_process, old_connection)
        RESERVATIONS.release(reserved, False)


atexit.register(close_warm_worker)


def isolated(module, name, args, kwargs, *, lengths, pairs=(), limits=DEFAULT_LIMITS, large=False, allow_wavefront=False, input_count=None, reuse_worker=False):
    """Call an internal, importable function with a shared request reservation.

    Inputs are trusted internal values, never executable client payloads.
    Nested calls stay in the same worker/work budget. ``pairs`` are known
    planned alignments; dynamic rounds are rechecked immediately before use.
    """
    if _current.get() is not None:
        return getattr(importlib.import_module(module), name)(*args, **kwargs)
    inputs = len(lengths) if input_count is None else input_count
    if inputs > limits.max_inputs or sum(lengths) > limits.max_input_bases:
        raise ResourceResult("budget_exceeded", "input_scope", inputs=inputs, bases=sum(lengths))
    if lengths and max(lengths) > limits.max_reconstructed_bases:
        raise ResourceResult("budget_exceeded", "reconstructed_bases", bases=max(lengths))
    request = _parent_request.get()
    if request is not None:
        remaining = limits.request_cells - request['cells']
        if remaining <= 0:
            raise ResourceResult('budget_exceeded', 'request_cells', cells=request['cells'])
        limits = replace(limits, request_cells=remaining)
    preflight = WorkBudget(limits)
    algorithm = 'banded:v1'
    try:
        estimates = [preflight.pair(*pair) for pair in pairs]
    except ResourceResult:
        if not allow_wavefront or not pairs:
            raise
        alternative = WorkBudget(limits)
        for n, m, _w in pairs:
            alternative.plan_wavefront(n, m)
        algorithm, estimates = 'weighted_wavefront:v1', []
        large = True
    large = large or any(e["reserved_bytes"] >= limits.large_job_bytes for e in estimates)
    # Reserve the full configurable request allowance, covering inputs, worker
    # overhead and retained outputs even when the polished backbone changes.
    size = limits.request_bytes
    deadline = min(time.monotonic() + limits.deadline_s, request['deadline']) if request else time.monotonic() + limits.deadline_s
    from services.background_work import Cancelled, checkpoint
    def check():
        try:
            checkpoint(allow_pause=False)
        except Cancelled:
            raise ResourceResult("cancelled", "server_cancelled") from None
    parent = child = process = None
    acquired, retained, success = False, False, False
    try:
        warm = _take_warm(size) if reuse_worker else None
        if not reuse_worker:
            close_warm_worker()
        if warm is not None:
            process, parent = warm
            retained = True
        # An idle worker keeps its entire byte reservation, but releases its
        # active large-job slot. Reuse transfers that reservation to this job.
        RESERVATIONS.acquire(0 if retained else size, large, deadline, check)
        acquired = True
        if process is None:
            context = multiprocessing.get_context('spawn')
            parent, child = context.Pipe(duplex=reuse_worker)
            process = context.Process(target=_warm_worker if reuse_worker else _worker,
                args=(child,) if reuse_worker else (child, module, name, args, kwargs, limits, algorithm), daemon=True)
            check()
            process.start()
            child.close()
        if reuse_worker:
            parent.send((module, name, args, kwargs, limits, algorithm))
        while True:
            check()
            if time.monotonic() >= deadline:
                raise ResourceResult("budget_exceeded", "deadline", seconds=limits.deadline_s)
            if parent.poll(0.02):
                # Resource diagnostics have a small independent envelope even
                # when a caller configures a tiny output allowance.
                try:
                    encoded = parent.recv_bytes(max(64 * 1024, limits.max_response_bytes))
                except (EOFError, OSError):
                    raise ResourceResult('unavailable', 'worker_channel_closed') from None
                message = pickle.loads(encoded)
                status, result = message[:2]
                check()
                if status == "resource":
                    raise ResourceResult(result["status"], result["reason"], **result["parameters"])
                if status == "error":
                    raise ResourceResult("unavailable", "worker_failed", detail=result)
                if request is not None:
                    request['cells'] += message[2]
                    request.setdefault('algorithms', set()).add(message[3])
                success = True
                return result
            if not process.is_alive():
                raise ResourceResult("unavailable", "worker_exited", exitcode=process.exitcode)
    except (OSError, RuntimeError) as exc:
        raise ResourceResult('unavailable', 'worker_setup_failed', detail=str(exc)) from None
    finally:
        if success and reuse_worker:
            _keep_warm(process, parent, size)
            RESERVATIONS.release(0, large)
        else:
            _reap(process, parent)
            if acquired:
                RESERVATIONS.release(size, large)
            elif retained:
                RESERVATIONS.release(size, False)
        if child is not None:
            child.close()


def current_budget():
    return _current.get()


def request_provenance():
    request = _parent_request.get()
    return sorted(request.get('algorithms', set())) if request else []
