"""Open-internet protection for a ``--public`` server.

One pure-ASGI middleware, installed just inside the security-header layer, so
it runs before any route, guard or session code (a refused request never mints
a visitor session) and its refusals still carry the security headers:

- **Client address.** The connecting address is the client, unless it is a
  trusted reverse proxy (``--trusted-proxy`` / ``FIBERBROWSER_TRUSTED_PROXIES``):
  then X-Forwarded-For is read from the right, skipping trusted hops, and
  X-Forwarded-Proto is believed. Anyone else's forwarding headers are ignored.
  IPv6 clients are counted per /64 (one host usually holds the whole prefix).
- **Rate limits** (token buckets, 429 with Retry-After): every request per
  client, analysis requests (``HEAVY_ROUTES``) per client on a stricter bucket,
  and all requests together as a backstop against floods from many addresses.
- **Analysis concurrency.** At most ``heavy_concurrent_per_ip`` analysis
  requests per client and ``heavy_concurrent`` server-wide run at once; past
  the server-wide limit a request waits briefly, then gets 503. One still
  running after ``heavy_timeout_seconds`` gets 503, and its slot stays taken
  until the work really ends (a thread can't be stopped; freeing the slot
  early would let retries stack work up).
- **Bodies.** Bodies over ``max_body_kb`` get 413; multipart and form bodies
  (uploads) get 415 on every route. JSON bodies go through
  ``public_limits.limit_body`` (region spans, list lengths, counts).
- **Off the event loop.** Many analysis handlers are ``async def`` but compute
  synchronously, which would freeze the server for every visitor. Each API
  request runs on a worker thread's own event loop (analysis requests on a
  dedicated pool with one loop per slot); the main loop only moves bytes.
- **Per-visitor caps.** Tracks and stored footprint-class runs per session
  (``session_max_tracks``, ``session_max_consensus_runs``); the catalog
  genome is loaded by one request at a time.
- **Errors.** A 500 becomes a generic message with a request id (the original
  is logged with that id); other error bodies have host paths shortened and
  tracebacks removed.
- ``/api/health`` answers ``{"status": "ok"}`` without a session.

Local servers (and tour tabs of a local server) are untouched: everything here
is keyed on the host's ``--public`` flag. The limits are PublicLimits fields
(services/public_limits.py), so a config file can set them by name.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import ipaddress
import json
import logging
import math
import os
import secrets
import threading
import time
from http.cookies import SimpleCookie
from urllib.parse import parse_qsl
from collections import OrderedDict
from collections.abc import Callable
from typing import Any, Iterable, Optional

from services.public_limits import PublicLimits, get_public_limits

log = logging.getLogger("fiberbrowser.public")

# ---------------------------------------------------------------------------
# Routes whose work is CPU-bound or reads many regions (clustering, scans,
# figures, footprint classes, whole-chromosome summaries, exports).
HEAVY_ROUTES: frozenset[tuple[str, str]] = frozenset({
    ("POST", "/api/scan_peaks"), ("POST", "/api/detect_peaks"),
    ("POST", "/api/cluster"), ("POST", "/api/cluster_all"), ("POST", "/api/cluster_expand"),
    ("POST", "/api/cluster_matched_views"), ("POST", "/api/cluster_projection"),
    ("POST", "/api/cluster/vplot"), ("POST", "/api/assign_to_clusters"),
    ("POST", "/api/dissolve_cluster"), ("POST", "/api/auto_cull_clusters"),
    ("POST", "/api/filter"), ("POST", "/api/filter_by_analysis_rule"),
    ("POST", "/api/filter_by_transcription_state"), ("POST", "/api/sort_reads"),
    ("POST", "/api/pol2_com"), ("POST", "/api/autozoom"),
    ("POST", "/api/footprint/analyze"), ("POST", "/api/footprint/consensus/lattice"),
    ("POST", "/api/footprint/consensus/jobs"),
    ("POST", "/api/reads/stats"), ("POST", "/api/reads/compile"), ("POST", "/api/render/compile"),
    ("POST", "/api/quality/impact"), ("POST", "/api/render"),
    ("POST", "/api/reads/locate"),
    ("POST", "/api/tracks/export"), ("POST", "/api/annotations/cluster"),
    ("POST", "/api/tracks/add_motif_sequence"), ("POST", "/api/tracks/add_motif_pwm"),
    ("POST", "/api/tracks/add_motif_jaspar"),
    # opening a session link reads remote files (only with FIBERBROWSER_LINK_HOSTS)
    ("GET", "/api/session-links/{link_id}"), ("POST", "/api/session-links/{link_id}/open"),
    ("GET", "/api/coacc/arcs"), ("GET", "/api/coacc/matrix/data"), ("GET", "/api/coacc/matrix/image"),
    ("GET", "/api/coacc/metadata"), ("GET", "/api/coacc/slice"), ("GET", "/api/coacc/strip"),
    ("GET", "/api/reads/top_windows"), ("GET", "/api/reads/random_window"),
    ("GET", "/api/reads/compact_all"), ("GET", "/api/meta_all"),
    ("GET", "/api/insertions/lens"), ("GET", "/api/insertions/clusters"),
    ("GET", "/api/tracks/{track_idx}/export"), ("GET", "/api/annotations/profile"),
    ("GET", "/api/footprint/consensus/jobs/{job_id}/export"),
    ("GET", "/api/microc/virtual4c"), ("GET", "/api/microc/matrix/data"),
    ("GET", "/api/dafc/matrix/data"), ("GET", "/api/dafc/matrix/image"),
})

# Plugin packs' heavy routes (plugins/packs.py).
from plugins.packs import pack_routes as _pack_routes  # noqa: E402

HEAVY_ROUTES = HEAVY_ROUTES | _pack_routes("protected")

# Routes that load reads or signal for a view (not analyses): a few run at once.
READ_ROUTES: frozenset[str] = frozenset({
    "/api/reads/compact", "/api/reads/compact_all", "/api/reads/info", "/api/working_set_info",
    "/api/coverage", "/api/meta", "/api/meta_all", "/api/fire", "/api/tracks/{track_idx}",
    "/api/tracks/{track_idx}/annotations", "/api/tracks/batch", "/api/annotations/region",
    "/api/overlays/{overlay_id}/marks", "/api/annotations/profile",
})

HEALTH_PATH = "/api/health"
GENERIC_ERROR = "Something went wrong on the server. Please try again later."
REQUEST_ID_HEADER = "X-Request-ID"

# ---------------------------------------------------------------------------
# Client address and trusted proxies

_trusted_networks: Optional[tuple] = None


def _parse_networks(values: Iterable[str]) -> tuple:
    networks = []
    for value in values:
        value = (value or "").strip()
        if not value:
            continue
        try:
            networks.append(ipaddress.ip_network(value, strict=False))
        except ValueError:
            log.warning("Ignoring trusted proxy %r: not an IP address or network", value)
    return tuple(networks)


def configure_trusted_proxies(values: Optional[Iterable[str]]) -> None:
    """Reverse proxies whose X-Forwarded-For/-Proto are believed (None: from the environment)."""
    global _trusted_networks
    if values is None:
        _trusted_networks = None
        return
    items: list[str] = []
    for value in values:
        items.extend(str(value).split(","))
    _trusted_networks = _parse_networks(items)


def trusted_networks() -> tuple:
    """Every reverse proxy this server believes, from one place.

    ``--trusted-proxy`` and a server config file's ``auth.trusted_proxies``
    (both applied with configure_trusted_proxies), else
    FIBERBROWSER_TRUSTED_PROXIES; on a lab server also its config's
    ``auth.trusted_proxies``, which the lab sign-in (proxy user header,
    audit addresses) uses through is_trusted_proxy/client_address too.
    """
    global _trusted_networks
    if _trusted_networks is None:
        _trusted_networks = _parse_networks(os.environ.get("FIBERBROWSER_TRUSTED_PROXIES", "").split(","))
    try:
        from services.lab import get_config
        lab = get_config()
    except ImportError:
        lab = None
    if lab is not None and lab.auth.trusted_proxies:
        return _trusted_networks + _lab_networks(tuple(lab.auth.trusted_proxies))
    return _trusted_networks


def explicitly_trusted_proxies() -> bool:
    """Trusted proxies were configured (--trusted-proxy, FIBERBROWSER_TRUSTED_PROXIES,
    a config file's auth.trusted_proxies), not only a lab server's loopback default."""
    trusted_networks()  # parses the environment on first use
    if _trusted_networks:
        return True
    try:
        from services.lab import get_config
        lab = get_config()
    except ImportError:
        lab = None
    return bool(lab is not None and lab.auth.trusted_proxies_set and lab.auth.trusted_proxies)


_lab_network_cache: dict[tuple, tuple] = {}


def _lab_networks(values: tuple) -> tuple:
    if values not in _lab_network_cache:
        _lab_network_cache.clear()
        _lab_network_cache[values] = _parse_networks(values)
    return _lab_network_cache[values]


def _ip(value: str):
    value = (value or "").strip().strip('"')
    if value.startswith("[") and "]" in value:  # [v6]:port
        value = value[1:value.index("]")]
    elif value.count(":") == 1 and "." in value:  # v4:port
        value = value.split(":", 1)[0]
    try:
        return ipaddress.ip_address(value)
    except ValueError:
        return None


def is_trusted_proxy(address) -> bool:
    ip = address if not isinstance(address, str) else _ip(address)
    return ip is not None and any(ip in net for net in trusted_networks())


def _header_values(scope, name: bytes) -> list[str]:
    return [v.decode("latin-1") for k, v in scope.get("headers") or [] if k == name]


def client_address(scope) -> str:
    """The client's IP address (see the module docstring for proxies)."""
    peer = (scope.get("client") or ("", 0))[0] or ""
    if not is_trusted_proxy(peer):
        return peer
    hops = [h.strip() for value in _header_values(scope, b"x-forwarded-for") for h in value.split(",") if h.strip()]
    for hop in reversed(hops):
        ip = _ip(hop)
        if ip is None:
            return peer  # a malformed hop from a trusted proxy: don't guess
        if not is_trusted_proxy(ip):
            return str(ip)
    return str(_ip(hops[0])) if hops and _ip(hops[0]) else peer


def client_key(scope) -> str:
    """What limits count by: the client IP, or its /64 for IPv6."""
    address = client_address(scope)
    ip = _ip(address)
    if ip is None:
        return address or "unknown"
    if ip.version == 6:
        if ip.ipv4_mapped is not None:
            return str(ip.ipv4_mapped)
        return str(ipaddress.ip_network(f"{ip}/64", strict=False))
    return str(ip)


def request_is_https(scope) -> bool:
    """https to this server, or https to a trusted proxy in front of it."""
    if scope.get("scheme") == "https":
        return True
    peer = (scope.get("client") or ("", 0))[0] or ""
    if not is_trusted_proxy(peer):
        return False
    values = _header_values(scope, b"x-forwarded-proto")
    return bool(values) and values[0].split(",")[0].strip().lower() == "https"


# ---------------------------------------------------------------------------
# Token buckets

class TokenBuckets:
    """Token buckets per key: ``rate`` tokens/second, at most ``burst`` held.

    Bounded: past ``max_keys`` the least recently used key is forgotten (a
    forgotten key starts full again, which only matters for a client that
    stayed away while max_keys others came by).
    """

    def __init__(self, rate: float, burst: float, max_keys: int = 100_000, clock: Callable[[], float] = time.monotonic):
        self.rate = max(float(rate), 1e-9)
        self.burst = max(float(burst), 1.0)
        self.max_keys = max_keys
        self.clock = clock
        self._buckets: OrderedDict[str, list[float]] = OrderedDict()

    def take(self, key: str, cost: float = 1.0) -> float:
        """0 when allowed (and charged), else the seconds until it would be."""
        now = self.clock()
        bucket = self._buckets.get(key)
        if bucket is None:
            bucket = [self.burst, now]
            self._buckets[key] = bucket
            while len(self._buckets) > self.max_keys:
                self._buckets.popitem(last=False)
        else:
            self._buckets.move_to_end(key)
            bucket[0] = min(self.burst, bucket[0] + (now - bucket[1]) * self.rate)
            bucket[1] = now
        if bucket[0] >= cost:
            bucket[0] -= cost
            return 0.0
        return (cost - bucket[0]) / self.rate

    def __len__(self) -> int:
        return len(self._buckets)


# ---------------------------------------------------------------------------
# Concurrency slots

class Slots:
    """At most ``size`` holders at once, ``per_client`` of them per client.

    Past ``size`` a request waits (FIFO) up to ``wait`` seconds for a slot to
    be handed over, then is refused. Used on the event loop only.
    """

    def __init__(self, size: int):
        self.size = max(1, size)
        self.running = 0
        self.waiters: list[asyncio.Future] = []
        self.per_client: dict[str, int] = {}

    async def acquire(self, key: str, per_client: int, wait: float, busy: str, mine: str) -> None:
        if self.per_client.get(key, 0) >= max(1, per_client):
            raise _Refusal(429, mine, 2)
        self.per_client[key] = self.per_client.get(key, 0) + 1
        try:
            if self.running >= self.size:
                waiter = asyncio.get_running_loop().create_future()
                self.waiters.append(waiter)
                try:
                    await asyncio.wait_for(asyncio.shield(waiter), timeout=max(0.0, wait))
                except asyncio.TimeoutError:
                    if waiter in self.waiters:
                        self.waiters.remove(waiter)
                    if waiter.done() and not waiter.cancelled():
                        return  # handed a slot at the last moment: keep it
                    raise _Refusal(503, busy, 5)
                except BaseException:
                    # Cancelled while queued: leave the queue, and pass on a
                    # slot that was handed over meanwhile (nobody else would).
                    if waiter in self.waiters:
                        self.waiters.remove(waiter)
                    if waiter.done() and not waiter.cancelled():
                        self._pass_on()
                    else:
                        waiter.cancel()
                    raise
                # a released slot was handed over (running unchanged)
            else:
                self.running += 1
        except BaseException:
            self._drop_client(key)
            raise

    def _drop_client(self, key: str) -> None:
        count = self.per_client.get(key, 0) - 1
        if count > 0:
            self.per_client[key] = count
        else:
            self.per_client.pop(key, None)

    def release(self, key: str) -> None:
        self._drop_client(key)
        self._pass_on()

    def _pass_on(self) -> None:
        """A slot is free: hand it to the first waiter, or give it back."""
        while self.waiters:
            waiter = self.waiters.pop(0)
            if not waiter.done():
                waiter.set_result(True)  # hand the slot over
                return
        self.running = max(0, self.running - 1)


def _before_last_byte(send, callback: Callable[[], None]):
    """``send`` that runs ``callback`` just before the response's last body
    message leaves (the change is done by then; the client may ask again at once)."""
    async def wrapped(message):
        if message["type"] == "http.response.body" and not message.get("more_body", False):
            callback()
        await send(message)
    finish = getattr(send, "finish", None)
    if finish is not None:
        wrapped.finish = finish  # type: ignore[attr-defined]
    return wrapped


def _once(fn: Callable[[], None]) -> Callable[[], None]:
    done: list[bool] = []

    def wrapper() -> None:
        if not done:
            done.append(True)
            fn()
    return wrapper


# ---------------------------------------------------------------------------
# Worker event loops

class LoopPool:
    """Event loops on daemon threads; a request runs on the least busy one."""

    def __init__(self, size: int, name: str):
        self.size = max(1, size)
        self.name = name
        self._loops: list[asyncio.AbstractEventLoop] = []
        self._busy: list[int] = []
        self._lock = threading.Lock()

    def _start(self) -> None:
        for index in range(self.size):
            loop = asyncio.new_event_loop()
            ready = threading.Event()

            def run(loop=loop, ready=ready):
                asyncio.set_event_loop(loop)
                loop.call_soon(ready.set)
                loop.run_forever()
            threading.Thread(target=run, name=f"{self.name}-{index}", daemon=True).start()
            ready.wait()
            self._loops.append(loop)
            self._busy.append(0)

    def _pick(self) -> int:
        with self._lock:
            if not self._loops:
                self._start()
            index = min(range(len(self._loops)), key=self._busy.__getitem__)
            self._busy[index] += 1
            return index

    def _done(self, index: int) -> None:
        with self._lock:
            self._busy[index] -= 1

    async def run(self, app, scope, receive, send, on_done: Optional[Callable[[], None]] = None) -> None:
        """Run the ASGI ``app`` on a worker loop; receive/send hop back to this loop.

        ``on_done`` runs (on this loop) once the work has really finished on
        the worker, even if this coroutine was cancelled or gave up earlier:
        blocking code on the worker can't be interrupted.
        """
        main = asyncio.get_running_loop()
        abandoned = [False]  # the caller gave up: the work goes on, unanswered

        async def receive_proxy():
            if abandoned[0]:
                return {"type": "http.disconnect"}
            return await asyncio.wrap_future(asyncio.run_coroutine_threadsafe(receive(), main))

        async def send_proxy(message):
            if abandoned[0]:
                return
            await asyncio.wrap_future(asyncio.run_coroutine_threadsafe(send(message), main))

        index = self._pick()
        lock = threading.Lock()
        phase = ["pending"]  # -> "started" -> "done"

        def finished() -> None:
            self._done(index)
            if on_done is not None:
                try:
                    main.call_soon_threadsafe(on_done)
                except RuntimeError:  # the main loop is gone (shutdown)
                    on_done()

        async def work():
            with lock:
                if phase[0] == "done":
                    return  # cancelled before it started
                phase[0] = "started"
            try:
                await app(scope, receive_proxy, send_proxy)
            finally:
                with lock:
                    phase[0] = "done"
                finished()

        def cancelled_early(_future) -> None:
            # A cancelled future is "done" at once, while the worker may still
            # be busy; only work that never started is finished here.
            with lock:
                if phase[0] != "pending":
                    return
                phase[0] = "done"
            finished()
        try:
            future: concurrent.futures.Future = asyncio.run_coroutine_threadsafe(work(), self._loops[index])
        except BaseException:
            cancelled_early(None)
            raise
        future.add_done_callback(cancelled_early)
        try:
            # Shielded: a caller that goes away (a closed tab) doesn't cancel
            # the work, which may be blocking in a thread anyway; its slot
            # stays taken until on_done, when the work has really ended.
            await asyncio.shield(asyncio.wrap_future(future))
        except asyncio.CancelledError:
            abandoned[0] = True
            raise


# ---------------------------------------------------------------------------
# The middleware

def _retry_after(seconds: float) -> str:
    return str(max(1, int(math.ceil(seconds))))


async def _send_json(send, status: int, payload: dict, headers: Optional[dict] = None) -> None:
    body = json.dumps(payload).encode("utf-8")
    raw = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]
    for name, value in (headers or {}).items():
        raw.append((name.lower().encode("latin-1"), str(value).encode("latin-1")))
    await send({"type": "http.response.start", "status": status, "headers": raw})
    await send({"type": "http.response.body", "body": body, "more_body": False})


class _Refusal(Exception):
    def __init__(self, status: int, message: str, retry_after: Optional[float] = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.retry_after = retry_after


class PublicProtection:
    """Rate limits, analysis slots, body limits and error hygiene (--public only)."""

    def __init__(self, app, is_host_public: Callable[[], bool], route_app=None,
                 limits: Optional[Callable[[], PublicLimits]] = None):
        self.app = app
        self.is_host_public = is_host_public
        self.route_app = route_app  # the FastAPI app, for route templates
        self.limits_fn = limits or get_public_limits
        self._state_for: Optional[PublicLimits] = None

    # -- per-limits state (rebuilt when the limits object changes) ---------------
    def _state(self) -> PublicLimits:
        limits = self.limits_fn()
        if limits is not self._state_for:
            self._state_for = limits
            self.general = TokenBuckets(limits.rate_per_minute / 60.0, limits.rate_burst)
            self.heavy = TokenBuckets(limits.heavy_per_minute / 60.0, limits.heavy_burst)
            self.global_bucket = TokenBuckets(limits.global_rate_per_second, max(limits.global_rate_per_second, 1))
            slots = limits.heavy_concurrent or max(2, (os.cpu_count() or 2) // 2)
            self.heavy_slots = slots
            self.heavy_work = Slots(slots)
            self.read_work = Slots(limits.read_concurrent or 4)
            self.inflight: dict[str, asyncio.Future] = {}
            if getattr(self, "heavy_pool", None) is None or self.heavy_pool.size != slots:
                self.heavy_pool = LoopPool(slots, "fiberbrowser-analysis")
            if getattr(self, "light_pool", None) is None:
                self.light_pool = LoopPool(max(4, min(16, os.cpu_count() or 4)), "fiberbrowser-api")
            self.genome_lock = asyncio.Lock()
            self.memory_high = False
            self._memory_checked = 0.0
            self._idle_swept = time.monotonic()
            self._configured_manager = None
        self._configure_sessions(limits)
        self._check_memory(limits)
        return limits

    def _configure_sessions(self, limits: PublicLimits) -> None:
        from state.runtime_state import get_session_manager
        manager = get_session_manager()
        if manager is None or manager is self._configured_manager:
            return
        self._configured_manager = manager
        manager.max_per_client = limits.sessions_per_ip
        manager.session_cache_entries = limits.session_cache_entries
        manager.admission_check = self._admission_check

    def _admission_check(self) -> Optional[str]:
        if self.memory_high:
            return "The server is short of memory; try again in a minute"
        return None

    def _check_memory(self, limits: PublicLimits) -> None:
        now = time.monotonic()
        if limits.idle_cache_seconds > 0 and now - self._idle_swept > 30.0:
            # A visitor's read caches are the bulk of its memory. Empty them
            # once it has been idle a while (reading a figure, or gone): the
            # next view reloads its reads, in about a second.
            self._idle_swept = now
            from state.runtime_state import get_session_manager
            manager = get_session_manager()
            if manager is not None and hasattr(manager, "clear_idle_caches"):
                if manager.clear_idle_caches(limits.idle_cache_seconds):
                    release_free_memory()
        if limits.memory_mb <= 0:
            self.memory_high = False
            return
        if now - self._memory_checked < 5.0:
            return
        self._memory_checked = now
        rss = resident_memory_mb()
        if rss is None:
            return
        high = rss > limits.memory_mb
        if high:
            from state.runtime_state import get_session_manager
            manager = get_session_manager()
            cleared = manager.clear_idle_caches(min(120, limits.idle_cache_seconds or 120)) if manager is not None else 0
            from services.public_cache import get_response_cache
            get_response_cache().clear()
            release_free_memory()
            rss = resident_memory_mb() or rss
            high = rss > limits.memory_mb
            if not self.memory_high:
                log.warning("resident memory %.0f MB > %d MB: cleared %d idle sessions' caches; "
                            "new sessions wait", rss, limits.memory_mb, cleared)
        self.memory_high = high

    def stats(self) -> dict[str, Any]:
        self._state()
        return {"heavy_running": self.heavy_work.running, "heavy_slots": self.heavy_slots,
                "heavy_waiting": len(self.heavy_work.waiters), "reads_running": self.read_work.running,
                "reads_waiting": len(self.read_work.waiters), "clients_tracked": len(self.general)}

    async def _acquire_heavy(self, key: str, limits: PublicLimits) -> None:
        await self.heavy_work.acquire(key, limits.heavy_concurrent_per_ip, limits.heavy_wait_seconds,
                                      "The server is busy with other analyses; try again shortly.",
                                      "You already have analyses running; wait for them to finish.")

    def _release_heavy(self, key: str) -> None:
        self.heavy_work.release(key)

    # -- ASGI --------------------------------------------------------------------
    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            return await self.app(scope, receive, send)
        path = scope.get("path") or ""
        if path == HEALTH_PATH and scope.get("method") in ("GET", "HEAD"):
            # Liveness for load balancers and container health checks, on every
            # kind of server, before sign-in or the access token: it says "ok"
            # and nothing else, and never mints a session.
            return await _send_json(send, 200, {"status": "ok"}, {"Cache-Control": "no-store"})
        if not self.is_host_public():
            return await self.app(scope, receive, send)
        limits = self._state()
        request_id = secrets.token_hex(8)
        key = client_key(scope)
        scope.setdefault("state", {})["fiberbrowser_client"] = key
        try:
            method = scope.get("method") or "GET"
            # Per client first: a client over its own limit is refused without
            # using up the server-wide budget everyone else shares.
            if not path.startswith("/assets/"):
                wait = self.general.take(key)
                if wait:
                    raise _Refusal(429, "Too many requests; slow down.", wait)
            wait = self.global_bucket.take("*")
            if wait:
                raise _Refusal(503, "The server is very busy; try again shortly.", wait)
            heavy = False
            template = None
            if path.startswith("/api/") and self.route_app is not None:
                from services.public_mode_guard import route_template
                template = route_template(self.route_app, scope)
                heavy = ("GET" if method == "HEAD" else method, template) in HEAVY_ROUTES
            if heavy:
                wait = self.heavy.take(key)
                if wait:
                    raise _Refusal(429, "Too many analysis requests; wait a moment.", wait)
            _check_session_caps(scope, method, template, limits)
            receive, body = await self._bounded_body(scope, receive, limits, template)
        except _Refusal as refusal:
            headers = {REQUEST_ID_HEADER: request_id, "Cache-Control": "no-store"}
            if refusal.retry_after is not None:
                headers["Retry-After"] = _retry_after(refusal.retry_after)
            return await _send_json(send, refusal.status, {"success": False, "message": refusal.message,
                                                           "detail": refusal.message}, headers)
        except Exception:
            # A bug in the checks themselves: the same generic answer as any 500.
            log.exception("request %s %s %s failed before it ran", request_id, scope.get("method"), path)
            return await _send_json(send, 500, {"success": False, "message": GENERIC_ERROR, "detail": GENERIC_ERROR,
                                                "request_id": request_id}, {REQUEST_ID_HEADER: request_id})
        send = self._error_hygiene(send, request_id, scope)
        visitor = visitor_state(scope) if template is not None else None
        from services.public_cache import CACHEABLE_POST
        # A POST/DELETE changes the session (reads-only POSTs aside): answers
        # computed meanwhile aren't shared (services/public_cache.py).
        changing = visitor is not None and method not in ("GET", "HEAD") and template not in CACHEABLE_POST
        end_changing = None
        change = {"deferred": False}
        if changing:
            from services.public_cache import begin_change, end_change
            begin_change(visitor, method, template)
            end_changing = _once(lambda: end_change(visitor, method, template))
            send = _before_last_byte(send, lambda: None if change["deferred"] else end_changing())
        dispatched = [False]  # the work was handed to a worker (it ends on its own)

        def after_work(extra: Optional[Callable[[], None]] = None) -> Callable[[], None]:
            """Runs when the work has really ended: frees ``extra`` and ends the change."""
            def done() -> None:
                if extra is not None:
                    extra()
                if end_changing is not None:
                    end_changing()
            dispatched[0] = True
            return _once(done)
        try:
            cached = await self._serve_cached(scope, send, method, template, visitor, body)
            if cached is True:
                return
            if cached is not None:
                send = cached  # a capturing send: the answer may be stored
            if not heavy:
                if template == "/api/load_genome":
                    # One genome download at a time: concurrent first visitors
                    # would otherwise race on the same temporary files.
                    async with self.genome_lock:
                        return await self._run(scope, receive, send, request_id, self.light_pool, after_work())
                if template in READ_ROUTES:
                    # Reading reads is CPU work under one GIL: a few at a time
                    # finish sooner on average, and keep cheap requests quick.
                    try:
                        await self.read_work.acquire(key, limits.read_concurrent_per_ip, limits.read_wait_seconds,
                                                     "The server is busy; try again shortly.",
                                                     "Too many reads at once from your address.")
                    except _Refusal as refusal:
                        return await _send_json(send, refusal.status, {"success": False, "message": refusal.message,
                                                                       "detail": refusal.message},
                                                {"Retry-After": _retry_after(refusal.retry_after or 1),
                                                 "Cache-Control": "no-store"})
                    return await self._run(scope, receive, send, request_id, self.light_pool,
                                           after_work(lambda: self.read_work.release(key)))
                pool = self.light_pool if path.startswith("/api/") else None
                return await self._run(scope, receive, send, request_id, pool, after_work())
            try:
                await self._acquire_heavy(key, limits)
            except _Refusal as refusal:
                return await _send_json(send, refusal.status, {"success": False, "message": refusal.message,
                                                               "detail": refusal.message},
                                        {"Retry-After": _retry_after(refusal.retry_after or 1),
                                         "Cache-Control": "no-store"})
            dispatched[0] = True
            await self._run_heavy(scope, receive, send, request_id, key, limits,
                                  on_abandon=lambda: change.__setitem__("deferred", True),
                                  after_work=end_changing)
        except asyncio.CancelledError:
            # The client went away. Work handed to a worker goes on (and may
            # still change the session): its change ends when the work does.
            if dispatched[0]:
                change["deferred"] = True
            raise
        finally:
            if end_changing is not None and not change["deferred"]:
                end_changing()
            finish = getattr(send, "finish", None)
            if finish is not None:
                finish()

    async def _serve_cached(self, scope, send, method: str, template: Optional[str], visitor, body: bytes):
        """True when answered from the shared cache; a capturing send on a
        cacheable miss; None when the request can't use the cache."""
        from services import public_cache as pc
        if visitor is None or template is None:
            return None
        if not ((method == "GET" and template in pc.CACHEABLE_GET)
                or (method == "POST" and template in pc.CACHEABLE_POST)):
            return None
        cache = pc.get_response_cache()
        if not cache.enabled:
            return None
        accept = ",".join(_header_values(scope, b"accept-encoding")).lower()
        sid = _session_cookie(scope)
        waited = False
        while True:
            # (Re)read the session each time: it may have changed while this
            # request waited for someone else's identical answer.
            if pc.busy(visitor):
                return None
            state_fp = pc.fingerprint(visitor)
            if state_fp is None:
                return None
            cache_key = pc.request_key(method, scope.get("path") or "", scope.get("query_string", b""), body,
                                       "gzip" in accept, state_fp)
            hit = cache.get(cache_key)
            if hit is None and cache_key in self.inflight and not waited:
                # The same answer is being computed for someone else: wait for
                # it (many visitors opening the same link at once), then look again.
                waited = True
                try:
                    await asyncio.wait_for(asyncio.shield(self.inflight[cache_key]), timeout=60)
                except (asyncio.TimeoutError, Exception):
                    pass
                continue
            break
        if hit is not None:
            # No await between the checks above and here: the answer matches
            # the session as it is now.
            status, headers, payload = hit
            from state.runtime_state import get_session_manager
            manager = get_session_manager()
            if manager is not None and sid:
                try:
                    manager.get_or_create(sid)  # keep the visitor's session alive
                except Exception:
                    pass
            replay = _HIT_SIDE_EFFECTS.get(template)
            if replay is not None:
                replay(visitor, scope)
            headers = list(headers) + [(b"x-fiberbrowser-cache", b"hit"),
                                       (b"content-length", str(len(payload)).encode())]
            if sid and manager is not None:
                headers.append(_session_cookie_header(scope, sid, manager.idle_ttl))
            await send({"type": "http.response.start", "status": status, "headers": headers})
            await send({"type": "http.response.body", "body": payload, "more_body": False})
            return True
        generation = pc.generation(visitor)
        captured = {"status": None, "headers": [], "chunks": [], "size": 0, "complete": False, "ok": True}
        leader = cache_key not in self.inflight
        if leader:
            self.inflight[cache_key] = asyncio.get_running_loop().create_future()

        async def capturing_send(message):
            if message["type"] == "http.response.start":
                captured["status"] = message.get("status")
                headers = [(k, v) for k, v in message.get("headers", [])
                           if k.lower() not in (b"set-cookie", b"content-length", b"x-request-id",
                                                b"x-fiberbrowser-cache")]
                captured["headers"] = headers
                message = dict(message)
                message["headers"] = list(message.get("headers", [])) + [(b"x-fiberbrowser-cache", b"miss")]
            elif message["type"] == "http.response.body" and captured["ok"]:
                chunk = message.get("body", b"")
                captured["size"] += len(chunk)
                if captured["size"] > cache.max_entry:
                    captured["ok"] = False
                    captured["chunks"] = []
                else:
                    captured["chunks"].append(chunk)
                if not message.get("more_body", False):
                    captured["complete"] = True
            await send(message)

        def finish():
            if (captured["ok"] and captured["complete"] and captured["status"] == 200
                    and pc.generation(visitor) == generation and not pc.busy(visitor)
                    and pc.fingerprint(visitor) == state_fp):
                cache.put(cache_key, 200, captured["headers"], b"".join(captured["chunks"]))
            if leader:
                waiting = self.inflight.pop(cache_key, None)
                if waiting is not None and not waiting.done():
                    waiting.set_result(True)

        capturing_send.finish = finish  # type: ignore[attr-defined]
        return capturing_send

    async def _bounded_body(self, scope, receive, limits: PublicLimits, template: Optional[str] = None):
        headers = dict((k.lower(), v) for k, v in scope.get("headers") or [])
        ctype = headers.get(b"content-type", b"").decode("latin-1").lower()
        if ctype.startswith(("multipart/", "application/x-www-form-urlencoded")):
            raise _Refusal(415, "Uploads aren't accepted by a public server.")
        limit = max(0, limits.max_body_kb) * 1024
        length = headers.get(b"content-length")
        if length is not None:
            try:
                if int(length) > limit:
                    raise _Refusal(413, "Request body too large.")
            except ValueError:
                raise _Refusal(400, "Bad Content-Length.")
        if (scope.get("method") or "GET") in ("GET", "HEAD") and length is None \
                and b"chunked" not in headers.get(b"transfer-encoding", b""):
            return receive, b""
        # Read the body now (at most `limit` bytes) and replay it to the app.
        chunks: list[bytes] = []
        size = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                raise _Refusal(400, "Client went away.")
            body = message.get("body", b"")
            size += len(body)
            if size > limit:
                raise _Refusal(413, "Request body too large.")
            chunks.append(body)
            if not message.get("more_body", False):
                break
        from services.public_limits import VPLOT_ROUTES
        if template is not None and (size or template in VPLOT_ROUTES) and (b"json" in ctype.encode() or not ctype):
            raw = b"".join(chunks)
            try:
                # (no body: a V-plot route still makes one, with its defaults)
                payload = json.loads(raw) if size else {}
            except ValueError:
                payload = None
            if payload is not None:
                from services.public_limits import limit_body, query_positions
                query = parse_qsl(scope.get("query_string", b"").decode("latin-1"), keep_blank_values=True)
                new_payload, refusal = limit_body(template, payload, limits, positions=query_positions(query))
                if refusal:
                    raise _Refusal(getattr(refusal, "status", 413), refusal)
                if new_payload is not None and size:
                    chunks = [json.dumps(new_payload).encode("utf-8")]
                    _set_content_length(scope, len(chunks[0]))
        replayed = False

        async def replay():
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": b"".join(chunks), "more_body": False}
            return await receive()
        return replay, b"".join(chunks)

    def _error_hygiene(self, send, request_id: str, scope):
        """Generic 500s; other error bodies without host paths or tracebacks."""
        state = {"status": 200, "rewrite": None, "buffer": [], "headers": [], "encoding": b""}

        async def wrapped(message):
            if message["type"] == "http.response.start":
                status = message.get("status", 200)
                headers = [(k, v) for k, v in message.get("headers", []) if k.lower() != b"content-length"]
                ctype = b""
                for k, v in message.get("headers", []):
                    if k.lower() == b"content-type":
                        ctype = v.lower()
                    elif k.lower() == b"content-encoding":
                        state["encoding"] = v.lower().strip()
                headers.append((REQUEST_ID_HEADER.lower().encode(), request_id.encode()))
                if status >= 500 and status not in (503,):
                    state["rewrite"] = "generic"
                elif status >= 400 and b"json" in ctype:
                    state["rewrite"] = "redact"
                if state["rewrite"] is None:
                    message = dict(message)
                    message["headers"] = list(message.get("headers", [])) + [
                        (REQUEST_ID_HEADER.lower().encode(), request_id.encode())]
                    return await send(message)
                state["status"] = status
                state["headers"] = [(k, v) for k, v in headers if k.lower() not in (b"content-encoding",)]
                return None
            if message["type"] == "http.response.body" and state["rewrite"] is not None:
                state["buffer"].append(message.get("body", b""))
                if message.get("more_body", False):
                    return None
                raw = b"".join(state["buffer"])
                if state["encoding"] == b"gzip":
                    import gzip
                    try:
                        raw = gzip.decompress(raw)
                    except OSError:
                        pass
                if state["rewrite"] == "generic":
                    if GENERIC_ERROR.encode() not in raw:  # (an exception was logged already)
                        log.error("request %s %s %s -> %s: %s", request_id, scope.get("method"), scope.get("path"),
                                  state["status"], raw[:2000].decode("utf-8", "replace"))
                    body = json.dumps({"success": False, "message": GENERIC_ERROR, "detail": GENERIC_ERROR,
                                       "request_id": request_id}).encode()
                    headers = [(k, v) for k, v in state["headers"] if k.lower() != b"content-type"]
                    headers.append((b"content-type", b"application/json"))
                else:
                    body = _redact_error_body(raw)
                    headers = state["headers"]
                headers = headers + [(b"content-length", str(len(body)).encode())]
                await send({"type": "http.response.start", "status": state["status"], "headers": headers})
                return await send({"type": "http.response.body", "body": body, "more_body": False})
            return await send(message)
        wrapped.state = state  # type: ignore[attr-defined]
        return wrapped

    async def _run(self, scope, receive, send, request_id: str, pool: Optional[LoopPool] = None,
                   on_done: Optional[Callable[[], None]] = None) -> None:
        started = {"value": False}

        async def tracking_send(message):
            if message["type"] == "http.response.start":
                started["value"] = True
            await send(message)
        try:
            if pool is None:
                try:
                    await self.app(scope, receive, tracking_send)
                finally:
                    if on_done is not None:
                        on_done()
            else:
                await pool.run(self.app, scope, receive, tracking_send, on_done)
        except Exception:
            log.exception("request %s %s %s failed", request_id, scope.get("method"), scope.get("path"))
            if not started["value"]:
                # (the error-hygiene send adds the X-Request-ID header)
                await _send_json(send, 500, {"success": False, "message": GENERIC_ERROR, "detail": GENERIC_ERROR,
                                             "request_id": request_id})

    async def _run_heavy(self, scope, receive, send, request_id: str, key: str, limits: PublicLimits,
                         on_abandon: Optional[Callable[[], None]] = None,
                         after_work: Optional[Callable[[], None]] = None) -> None:
        """Run an analysis; past heavy_timeout_seconds answer 503 while it goes on.

        ``on_abandon`` runs just before that 503; ``after_work`` once the work
        has really ended (a change to the session ends only then)."""
        started = {"value": False, "abandoned": False}

        async def guarded_send(message):
            if started["abandoned"]:
                return  # the client already got a 503
            if message["type"] == "http.response.start":
                started["value"] = True
            await send(message)

        released = []

        def release():
            if not released:  # once, when the work has really ended
                released.append(True)
                self._release_heavy(key)
                if after_work is not None:
                    after_work()
        task = asyncio.ensure_future(self._run(scope, receive, guarded_send, request_id, self.heavy_pool, release))
        timeout = limits.heavy_timeout_seconds if limits.heavy_timeout_seconds > 0 else None
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=timeout)
        except asyncio.CancelledError:
            # The client went away: the analysis goes on unanswered, holding
            # its slot and its session change until it ends.
            started["abandoned"] = True
            if on_abandon is not None:
                on_abandon()
            raise
        except asyncio.TimeoutError:
            if started["value"]:
                await task  # already answering: let it finish
                return
            started["abandoned"] = True
            if on_abandon is not None:
                on_abandon()
            log.warning("request %s %s %s ran past %ss; answered 503, work continues", request_id,
                        scope.get("method"), scope.get("path"), limits.heavy_timeout_seconds)
            await _send_json(send, 503, {"success": False, "request_id": request_id,
                                         "message": "This analysis is taking too long on the public server; "
                                                    "try a smaller region."},
                             {"Retry-After": "30", REQUEST_ID_HEADER: request_id})


def release_free_memory() -> None:
    """Collect garbage and hand freed heap pages back to the system (glibc), so
    resident memory falls after caches are emptied instead of staying at its peak."""
    import gc
    gc.collect()
    try:
        import ctypes
        import ctypes.util
        libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6")
        trim = getattr(libc, "malloc_trim", None)
        if trim is not None:
            trim(0)
    except Exception:
        pass


def resident_memory_mb() -> Optional[float]:
    """This process's resident memory (psutil, else /proc; None where neither works)."""
    try:
        import psutil
        return psutil.Process().memory_info().rss / 2**20
    except Exception:
        pass
    try:
        with open("/proc/self/statm") as handle:
            pages = int(handle.read().split()[1])
        return pages * os.sysconf("SC_PAGE_SIZE") / 2**20
    except Exception:
        return None


def _set_content_length(scope, length: int) -> None:
    scope["headers"] = [(k, v) for k, v in scope.get("headers") or [] if k.lower() != b"content-length"]
    scope["headers"].append((b"content-length", str(length).encode()))


def _session_cookie_header(scope, sid: str, ttl: int) -> tuple[bytes, bytes]:
    """The visitor's session cookie exactly as the session middleware sets it
    (state/dependencies.py: under the server's URL prefix, Secure over https)."""
    from starlette.requests import Request
    from starlette.responses import Response

    from services.root_path import cookie_path
    from state.dependencies import _SESSION_COOKIE, _is_https
    response = Response()
    response.set_cookie(_SESSION_COOKIE, sid, httponly=True, samesite="lax",
                        secure=_is_https(Request(scope)), max_age=ttl, path=cookie_path())
    return next((k, v) for k, v in response.raw_headers if k == b"set-cookie")


def _replay_viewport(state, scope) -> None:
    """A read request records the viewport (a figure without a region draws it);
    a cached answer records it too."""
    params = dict(parse_qsl(scope.get("query_string", b"").decode("latin-1"), keep_blank_values=True))
    try:
        chrom, start, end = params["chrom"], int(params["start"]), int(params["end"])
    except (KeyError, ValueError):
        return
    from services.read_endpoint import update_current_viewport
    update_current_viewport(state, chrom, start, end)


# What a cached answer's route does to the session besides answering (a hit
# skips the route, so it is done here).
_HIT_SIDE_EFFECTS: dict[str, Callable] = {
    "/api/reads/compact": _replay_viewport,
    "/api/reads/compact_all": _replay_viewport,
}


def _session_cookie(scope) -> Optional[str]:
    for value in _header_values(scope, b"cookie"):
        try:
            cookie = SimpleCookie()
            cookie.load(value)
        except Exception:
            continue
        morsel = cookie.get("fiberhmm_sid")
        if morsel is not None and morsel.value:
            return morsel.value
    return None


def visitor_state(scope):
    """The visitor session a request's cookie names (None: none yet, or not public)."""
    from state.runtime_state import get_session_manager
    manager = get_session_manager()
    if manager is None or not getattr(manager, "enabled", False):
        return None
    sid = _session_cookie(scope)
    return manager.get(sid) if sid else None


_TRACK_ADDING = frozenset({"/api/tracks/add_motif_sequence", "/api/tracks/add_motif_pwm",
                           "/api/tracks/add_motif_jaspar", "/api/catalog/tracks/load"})


def _check_session_caps(scope, method: str, template: Optional[str], limits: PublicLimits) -> None:
    if method != "POST" or template is None:
        return
    if template in _TRACK_ADDING:
        state = visitor_state(scope)
        tracks = getattr(state, "orthogonal_tracks", None) if state is not None else None
        if tracks is not None and len(tracks) >= limits.session_max_tracks:
            raise _Refusal(409, f"At most {limits.session_max_tracks} tracks on this public server; "
                                "remove one first.")
    elif template == "/api/footprint/consensus/jobs":
        state = visitor_state(scope)
        jobs = state.__dict__.get("consensus_workflow_jobs") if state is not None else None
        if jobs is not None and len(jobs) >= limits.session_max_consensus_runs:
            raise _Refusal(409, f"At most {limits.session_max_consensus_runs} footprint-class runs are kept "
                                "per visitor on this public server; delete one first.")


_TRACE_KEYS = frozenset({"traceback", "trace", "stack", "stacktrace", "exc_info"})


def _strip_traces(payload: Any) -> Any:
    if isinstance(payload, dict):
        return {k: _strip_traces(v) for k, v in payload.items() if str(k).lower() not in _TRACE_KEYS}
    if isinstance(payload, list):
        return [_strip_traces(v) for v in payload]
    return payload


def _redact_error_body(raw: bytes) -> bytes:
    from services.public_redaction import redact_paths
    try:
        payload = json.loads(raw)
    except ValueError:
        return raw
    return json.dumps(redact_paths(_strip_traces(payload))).encode("utf-8")


def install_public_protection(app, is_host_public: Callable[[], bool]) -> None:
    """Install the protection middleware (outermost but the security headers).

    Call just BEFORE install_security_headers: Starlette runs the last-added
    middleware first.
    """
    app.add_middleware(PublicProtection, is_host_public=is_host_public, route_app=app)

    @app.get(HEALTH_PATH, include_in_schema=False)
    async def health():
        # Answered by the middleware (every profile); here for the route table.
        return {"status": "ok"}


def remove_api_docs(app) -> None:
    """A public server has no /docs, /redoc or /openapi.json (404, not a 403)."""
    doomed = {app.openapi_url, app.docs_url, app.redoc_url, app.swagger_ui_oauth2_redirect_url,
              "/openapi.json", "/docs", "/redoc", "/docs/oauth2-redirect"}
    app.router.routes[:] = [r for r in app.router.routes if getattr(r, "path", None) not in doomed]
    app.openapi_url = app.docs_url = app.redoc_url = None
    try:  # the public-mode guard's route cache
        from services.public_mode_guard import _entries_cache
        _entries_cache.pop(id(app), None)
    except ImportError:
        pass
