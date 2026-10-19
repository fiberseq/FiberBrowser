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


class Reservations:
    def __init__(self, limits=DEFAULT_LIMITS):
        self.limits = limits
        self.condition = threading.Condition()
        self.bytes = self.large = self.queued = 0

    def acquire(self, size, large, deadline, checkpoint):
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


def _worker(connection, module, name, args, kwargs, limits):
    _current.set(WorkBudget(limits))
    try:
        result = getattr(importlib.import_module(module), name)(*args, **kwargs)
        encoded = pickle.dumps(("ok", result, _current.get().cells), protocol=5)
        if len(encoded) > limits.max_response_bytes:
            raise ResourceResult("budget_exceeded", "response_bytes", bytes=len(encoded))
        connection.send_bytes(encoded)
    except ResourceResult as exc:
        connection.send(("resource", exc.payload()))
    except BaseException as exc:
        connection.send(("error", type(exc).__name__ + ": " + str(exc)))
    finally:
        connection.close()


def isolated(module, name, args, kwargs, *, lengths, pairs=(), limits=DEFAULT_LIMITS, large=False):
    """Call an internal, importable function with a shared request reservation.

    Inputs are trusted internal values, never executable client payloads.
    Nested calls stay in the same worker/work budget. ``pairs`` are known
    planned alignments; dynamic rounds are rechecked immediately before use.
    """
    if _current.get() is not None:
        return getattr(importlib.import_module(module), name)(*args, **kwargs)
    if len(lengths) > limits.max_inputs or sum(lengths) > limits.max_input_bases:
        raise ResourceResult("budget_exceeded", "input_scope", inputs=len(lengths), bases=sum(lengths))
    if lengths and max(lengths) > limits.max_reconstructed_bases:
        raise ResourceResult("budget_exceeded", "reconstructed_bases", bases=max(lengths))
    request = _parent_request.get()
    if request is not None:
        remaining = limits.request_cells - request['cells']
        if remaining <= 0:
            raise ResourceResult('budget_exceeded', 'request_cells', cells=request['cells'])
        limits = replace(limits, request_cells=remaining)
    preflight = WorkBudget(limits)
    estimates = [preflight.pair(*pair) for pair in pairs]
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
    RESERVATIONS.acquire(size, large, deadline, check)
    parent = child = process = None
    try:
        parent, child = multiprocessing.get_context("spawn").Pipe(duplex=False)
        process = multiprocessing.get_context("spawn").Process(
            target=_worker, args=(child, module, name, args, kwargs, limits), daemon=True)
        check()
        process.start()
        child.close()
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
                return result
            if not process.is_alive():
                raise ResourceResult("unavailable", "worker_exited", exitcode=process.exitcode)
    except (OSError, RuntimeError) as exc:
        raise ResourceResult('unavailable', 'worker_setup_failed', detail=str(exc)) from None
    finally:
        if process is not None and process.pid is not None:
            if process.is_alive():
                process.kill()
            process.join()
            process.close()
        if parent is not None:
            parent.close()
        if child is not None:
            child.close()
        RESERVATIONS.release(size, large)


def current_budget():
    return _current.get()
