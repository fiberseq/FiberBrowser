"""Playwright-driven render engine for /api/render?engine=playwright.

Drives a long-lived Node worker (browser/frontend/scripts/render-headless.mjs)
that owns a single headless Chromium with N browser contexts (default 4 via
FIBERBROWSER_RENDER_CONCURRENCY). Produces color-faithful PNG output by
loading the real React app with `?render=1`, calling setState({...}) with
all RenderRequest fields translated to store fields, then screenshotting the
tracks region. PDF/SVG output reuses the wrap helpers from render_endpoint.

Process lifecycle mirrors copilot_lifecycle: lazy spawn on first request,
atexit shutdown, SIGTERM→SIGKILL escalation. The worker stays up across
requests so subsequent renders pay only the per-context cost (~500ms vs
the cold-start ~3s).

Concurrency:
- BoundedSemaphore(N) on the Python side caps in-flight requests; backpressure
  surfaces as HTTP 503 with Retry-After rather than a queue that grows
  unboundedly.
- Node worker tracks the same N as defense in depth; if Python's count is
  bypassed (rare) the worker rejects with `{ok:false, error:"concurrency
  exceeded"}` which Python translates to 503.

Failure modes are explicit (see plan):
- chromium binary missing → 503 with install-fix message
- node not on PATH → 503 with install-fix message
- worker crash mid-request → reap + lazy-respawn, current request fails 502
- settlement timeout → returns a partial render with diagnostics in header
"""
from __future__ import annotations

import atexit
import base64
import io
import json
import os
import signal
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import Future, TimeoutError as FuturesTimeoutError
from pathlib import Path
from typing import Any, Optional

from fastapi.responses import Response

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKER_SCRIPT = REPO_ROOT / "browser" / "frontend" / "scripts" / "render-headless.mjs"
# Beside the Copilot logs in ~/.fiberhmm, never in the install tree (a
# read-only or shared install has no writable ./logs).
WORKER_LOG_DIR = Path(os.environ.get(
    "FIBERBROWSER_LOG_DIR", str(Path.home() / ".fiberhmm" / "logs")
)).expanduser()

DEFAULT_CONCURRENCY = int(os.environ.get("FIBERBROWSER_RENDER_CONCURRENCY", "4"))
DEFAULT_TIMEOUT_MS = int(os.environ.get("FIBERBROWSER_RENDER_TIMEOUT_MS", "30000"))
MIN_TIMEOUT_MS = 5_000
MAX_TIMEOUT_MS = 300_000

# The Node worker navigates to this URL with `?render=1`. server.py sets the
# env var to the live host/port after argparse resolves them. Default value
# matches the FastAPI default for ad-hoc / dev use.
DEFAULT_SELF_URL = os.environ.get("FIBERBROWSER_RENDER_SELF_URL", "http://127.0.0.1:8000")


class _WorkerError(Exception):
    """Raised when the worker subprocess can't be reached or has died."""


class _ConcurrencyExceeded(Exception):
    """Raised when the semaphore is saturated; surfaces as HTTP 503."""


# ---------------------------------------------------------------------------
# Platform-aware install hints
# ---------------------------------------------------------------------------

def _is_wsl() -> bool:
    """WSL exposes itself in /proc/version (Microsoft) or env var."""
    if "WSL_DISTRO_NAME" in os.environ or "WSL_INTEROP" in os.environ:
        return True
    try:
        with open("/proc/version", "r") as f:
            return "microsoft" in f.read().lower()
    except OSError:
        return False


def _node_missing_hint() -> str:
    """Platform-aware suggestion for installing Node 18+."""
    if sys.platform == "darwin":
        return ("node not found on PATH. Install Node 18+ "
                "(e.g. `brew install node`) and restart FiberBrowser.")
    if sys.platform.startswith("linux"):
        wsl_note = " (WSL: same command, you may need sudo)" if _is_wsl() else ""
        return ("node not found on PATH. Install Node 18+ "
                f"(e.g. `sudo apt install nodejs npm`{wsl_note}) and restart FiberBrowser.")
    if sys.platform.startswith("win"):
        return ("node not found on PATH. Install Node 18+ from "
                "https://nodejs.org/ and restart FiberBrowser.")
    return ("node not found on PATH. Install Node 18+ and restart FiberBrowser.")


def _settlement_timeout_hint(log_path) -> str:
    """Inspect the worker log to give the right install hint when the worker
    didn't reach 'ready'. Distinguishes:
      - missing playwright module     (npm install never ran)
      - missing Chromium executable   (npx playwright install chromium)
      - missing shared libs on Linux  (npx playwright install-deps chromium)
    Falls back to the generic "probably Chromium missing" message.
    """
    log_tail = ""
    try:
        with open(str(log_path), "r", encoding="utf-8", errors="replace") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 4000))  # last ~4KB
            log_tail = f.read()
    except OSError:
        pass

    base = (f"Playwright worker did not start within 15s. Worker log: {log_path}")

    if not log_tail:
        return base + (
            "\nMost likely Chromium isn't installed. Run: "
            "`cd browser/frontend && npx playwright install chromium`"
        )

    lower = log_tail.lower()
    # 1. Node module resolution failure → npm install never ran
    if "cannot find module 'playwright'" in lower or "err_module_not_found" in lower:
        return base + (
            "\nThe Playwright Node module isn't installed. Run: "
            "`cd browser/frontend && npm install` (this also pulls @playwright/test)."
        )
    # 2. Chromium binary missing — error string from Playwright
    if "executable doesn't exist" in lower or "browsertype.launch: executable" in lower:
        return base + (
            "\nChromium binary is missing. Run: "
            "`cd browser/frontend && npx playwright install chromium`"
        )
    # 3. Shared library missing (Linux/WSL) — common pattern
    shared_lib_markers = (
        "error while loading shared libraries",
        "cannot open shared object file",
        "libnss3", "libgbm", "libatk", "libasound", "libcups", "libxkbcommon",
        "host system is missing dependencies",
    )
    if any(m in lower for m in shared_lib_markers):
        wsl_note = " (WSL uses the same command via sudo)" if _is_wsl() else ""
        return base + (
            "\nChromium is installed but can't launch — system libraries are missing. "
            f"Run: `cd browser/frontend && sudo npx playwright install-deps chromium`{wsl_note} "
            "(installs libgbm1, libnss3, libasound2, libatk1.0-0, etc.)"
        )
    # 4. WSL-specific: D-Bus / display / sandbox warnings — rare but actionable
    if _is_wsl() and ("dbus" in lower or "x server" in lower):
        return base + (
            "\nWSL: Chromium may need additional config. Try setting "
            "`CHROME_PATH` env var or run `npx playwright install-deps chromium`."
        )
    # 5. Fallback — surface the last log line for diagnostic value
    last_line = next((ln.strip() for ln in reversed(log_tail.splitlines()) if ln.strip()), "")
    return base + (
        f"\nLikely Chromium isn't installed. Run: "
        f"`cd browser/frontend && npx playwright install chromium`"
        f"\nLast worker log line: {last_line[:200]}"
    )


class _PlaywrightWorker:
    """Long-lived Node subprocess + request/response framing."""

    def __init__(self) -> None:
        self._proc: Optional[subprocess.Popen] = None
        self._lock = threading.Lock()  # guards proc lifecycle (spawn/reap)
        self._pending: dict[str, Future] = {}
        self._pending_lock = threading.Lock()
        self._reader_thread: Optional[threading.Thread] = None
        self._sem = threading.BoundedSemaphore(DEFAULT_CONCURRENCY)
        self._writer_lock = threading.Lock()  # stdin writes
        atexit.register(self.shutdown)

    # ──────────────────────────────────────────────────────────────────
    # Process lifecycle
    # ──────────────────────────────────────────────────────────────────

    def _ensure_running(self) -> subprocess.Popen:
        with self._lock:
            if self._proc and self._proc.poll() is None:
                return self._proc
            if self._proc is not None:
                # It died: its requests can't be answered by the replacement.
                self._proc = None
                self._reject_pending()
            # Either never spawned or died — (re)spawn.
            if not WORKER_SCRIPT.exists():
                raise _WorkerError(
                    f"render worker script missing at {WORKER_SCRIPT}. "
                    "Did the frontend tree get moved?"
                )
            try:
                WORKER_LOG_DIR.mkdir(parents=True, exist_ok=True)
                log_path = WORKER_LOG_DIR / "render_worker.log"
                log_fh = log_path.open("a", encoding="utf-8")
                # Prefer 'node' from PATH; cwd at frontend so `import 'playwright'`
                # resolves to the installed node_modules.
                proc = subprocess.Popen(
                    ["node", str(WORKER_SCRIPT)],
                    cwd=str(REPO_ROOT / "browser" / "frontend"),
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=log_fh,
                    env={**os.environ},
                    start_new_session=True,
                )
            except FileNotFoundError as exc:
                raise _WorkerError(_node_missing_hint()) from exc
            self._proc = proc
            self._reader_thread = threading.Thread(
                target=self._reader_loop, args=(proc,), daemon=True, name="render-worker-reader",
            )
            self._reader_thread.start()
            print(f"[render] spawned headless render worker (pid={proc.pid})", file=sys.stderr)
            # Wait briefly for the worker's `ready` lifecycle frame.
            ready_event = threading.Event()
            self._ready_event = ready_event
            if not ready_event.wait(timeout=15.0):
                # Worker didn't say ready. Common causes:
                #   - Chromium binary not installed
                #   - On Linux/WSL: Chromium installed but missing shared libs
                #     (libgbm1, libnss3, libasound2, libatk1.0-0, etc.)
                #   - playwright-core missing from node_modules
                # Sniff the worker log to give the right hint.
                self._kill_locked()
                raise _WorkerError(_settlement_timeout_hint(log_path))
            return proc

    def _kill_locked(self) -> None:
        proc = self._proc
        self._proc = None
        if not proc:
            return
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except Exception:
            try:
                proc.terminate()
            except Exception:
                pass
        try:
            proc.wait(timeout=2.0)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        self._reject_pending()

    def _reject_pending(self) -> None:
        """Fail requests waiting on a worker that is gone (they can't be answered)."""
        with self._pending_lock:
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(_WorkerError("worker died mid-request"))
            self._pending.clear()

    def shutdown(self) -> None:
        with self._lock:
            self._kill_locked()

    # ──────────────────────────────────────────────────────────────────
    # Reader loop: parse framed JSON from stdout, dispatch by id
    # ──────────────────────────────────────────────────────────────────

    def _reader_loop(self, proc: subprocess.Popen) -> None:
        out = proc.stdout
        if out is None:
            return
        while True:
            try:
                header = out.read(9)  # 8 bytes + '\n'
                if not header or len(header) < 9:
                    break  # EOF
                length_str = header[:8].decode("ascii", errors="replace")
                if header[8:9] != b"\n":
                    # Framing error — skip a byte and try to resync. In
                    # practice this shouldn't happen.
                    continue
                try:
                    payload_len = int(length_str)
                except ValueError:
                    continue
                payload = out.read(payload_len + 1)  # +1 for trailing '\n'
                if len(payload) < payload_len:
                    break
                body = payload[:payload_len].decode("utf-8", errors="replace")
                try:
                    frame = json.loads(body)
                except Exception:
                    print(f"[render] reader: bad JSON frame: {body[:200]!r}", file=sys.stderr)
                    continue
                self._dispatch(frame)
            except Exception as exc:
                print(f"[render] reader loop error: {exc}", file=sys.stderr)
                break
        # Stdout closed: worker died. Reap it, unless a replacement has already
        # been started (then this worker's requests were failed at respawn).
        with self._lock:
            if self._proc is proc:
                self._kill_locked()

    def _dispatch(self, frame: dict[str, Any]) -> None:
        rid = frame.get("id")
        if rid is None:
            kind = frame.get("kind")
            if kind == "ready":
                ev = getattr(self, "_ready_event", None)
                if ev is not None:
                    ev.set()
            # Lifecycle frames (log/shutdown) are also handled here. Logs are
            # already in the worker log file; we don't need to mirror them.
            return
        with self._pending_lock:
            fut = self._pending.pop(rid, None)
        if fut and not fut.done():
            fut.set_result(frame)

    # ──────────────────────────────────────────────────────────────────
    # Public submit
    # ──────────────────────────────────────────────────────────────────

    def submit(self, request_envelope: dict[str, Any], timeout_s: float) -> dict[str, Any]:
        """Send a frame to the worker and block (with timeout) for the response."""
        if not self._sem.acquire(blocking=False):
            raise _ConcurrencyExceeded()
        try:
            proc = self._ensure_running()
            rid = request_envelope["id"]
            fut: Future = Future()
            with self._pending_lock:
                self._pending[rid] = fut
            payload = json.dumps(request_envelope, separators=(",", ":")).encode("utf-8")
            header = f"{len(payload):08d}\n".encode("ascii")
            with self._writer_lock:
                try:
                    proc.stdin.write(header + payload + b"\n")
                    proc.stdin.flush()
                except (BrokenPipeError, OSError) as exc:
                    # Worker died between _ensure_running and our write.
                    with self._pending_lock:
                        self._pending.pop(rid, None)
                    raise _WorkerError(f"worker write failed: {exc}") from exc
            try:
                return fut.result(timeout=timeout_s)
            except FuturesTimeoutError:
                with self._pending_lock:
                    self._pending.pop(rid, None)
                raise _WorkerError(f"request {rid} timed out after {timeout_s}s")
        finally:
            self._sem.release()


# Module-level singleton; lazy-spawned on first request.
_WORKER = _PlaywrightWorker()


# ──────────────────────────────────────────────────────────────────────
# RenderRequest → Zustand store state translation
# ──────────────────────────────────────────────────────────────────────


def _datasets_for_render(state, dataset_ids: Optional[list[str]]) -> list[dict[str, Any]]:
    """Build setState-ready dataset entries from the live BrowserState.

    React's renderMode dataset shape needs the same fields the dataset panel
    consumes: id, label, color, available_layers, data_type, path. We pull
    these straight off the live state so the rendered tracks match what's
    actually loaded server-side.
    """
    raw_datasets = getattr(state, "datasets", []) or []
    all_datasets = list(raw_datasets.values()) if hasattr(raw_datasets, "values") else list(raw_datasets)
    target_ids = set(dataset_ids) if dataset_ids else None
    out = []
    for ds in all_datasets:
        # Tolerate both attr-style (BrowserState dataclass) and dict-style.
        def _get(name, default=None):
            # Dicts first: a dict has attributes like .values/.items that
            # would shadow the keys of the same name.
            if isinstance(ds, dict):
                return ds.get(name, default)
            return getattr(ds, name, default)
        ds_id = _get("id")
        if not ds_id:
            continue
        if target_ids is not None and ds_id not in target_ids:
            continue
        out.append({
            "id": ds_id,
            "label": _get("label", ds_id) or ds_id,
            "color": _get("color", "#2563eb") or "#2563eb",
            "path": _get("source_path", _get("path", "")) or "",
            "data_type": _get("data_type", "bam") or "bam",
            "layer_type": _get("layer_type", None),
            "available_layers": _get("available_layers", {}) or {},
        })
    return out


def _orthogonal_tracks_for_render(state) -> list[dict[str, Any]]:
    """Return setState-ready orthogonal track metadata/data when available."""
    raw_tracks = getattr(state, "orthogonal_tracks", []) or []
    tracks = list(raw_tracks.values()) if hasattr(raw_tracks, "values") else list(raw_tracks)
    out: list[dict[str, Any]] = []

    for idx, track in enumerate(tracks):
        def _get(name, default=None):
            # Dicts first: a dict has attributes like .values/.items that
            # would shadow the keys of the same name.
            if isinstance(track, dict):
                return track.get(name, default)
            return getattr(track, name, default)

        track_index = _get("index", idx)
        values = _get("values", []) or []
        if hasattr(values, "tolist"):
            values = values.tolist()
        intervals = _get("intervals", None)
        if hasattr(intervals, "tolist"):
            intervals = intervals.tolist()
        render_mode = _get("renderMode", _get("render_mode", "signal")) or "signal"
        out.append({
            "index": int(track_index),
            "label": _get("label", f"Track {track_index}") or f"Track {track_index}",
            "values": values,
            "renderMode": "annotation" if render_mode == "annotation" else "signal",
            **({"intervals": intervals} if intervals is not None else {}),
            **({"path": _get("path")} if _get("path") else {}),
            **({"format": _get("format")} if _get("format") else {}),
            **({"category": _get("category")} if _get("category") else {}),
        })
    return out


def _sub_tracks_for_request(req, state) -> list[dict[str, Any]]:
    """Normalize RenderRequest track tokens to frontend subtrack ids.

    The public render API exposes readable plural/source names (`genes`,
    `peaks`, `signal`) while the React layout uses concrete subtrack ids
    (`gene`, `fire`, `ortho-N`). Keep the API stable and centralize that
    translation here.
    """
    tokens = req.tracks or ["axis", "reads"]
    orthogonal_tracks = _orthogonal_tracks_for_render(state)
    out: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(track_type: str) -> None:
        if track_type in seen:
            return
        seen.add(track_type)
        out.append({"type": track_type, "visible": True})

    for token in tokens:
        if token == "genes":
            add("gene")
        elif token == "peaks":
            add("fire")
        elif token == "signal":
            for track in orthogonal_tracks:
                add(f"ortho-{track['index']}")
        else:
            add(token)
    # The reads bring their SV summary and coverage rows (their own tracks in the browser since
    # fb-n11-tracks; they draw only with SVs in view / Coverage histogram on), right above them,
    # as the read canvas drew them before.
    if "reads" in seen:
        at = next(i for i, t in enumerate(out) if t["type"] == "reads")
        extra = [{"type": t, "visible": True} for t in ("sv", "coverage") if t not in seen]
        out[at:at] = extra
    return out


def _genes_for_render(req, state) -> list[dict[str, Any]]:
    """Preload viewport genes for render-mode screenshots.

    Browser.tsx intentionally avoids some startup fetches in render mode, so
    tracks that read from store.genes need the payload to carry the current
    viewport's genes directly.
    """
    if getattr(state, "gtf_data", None) is None:
        return []
    try:
        from services.read_auxiliary_endpoint import get_genes_payload

        payload = get_genes_payload(
            state,
            chrom=req.chrom,
            start=int(req.start),
            end=int(req.end),
        )
        return list((payload.get("content") or {}).get("genes") or [])
    except Exception:
        return []


def _chroms_for_render(state) -> list[dict[str, Any]]:
    raw_chroms = getattr(state, "chroms", []) or []
    chroms = list(raw_chroms.values()) if hasattr(raw_chroms, "values") else list(raw_chroms)
    out: list[dict[str, Any]] = []
    circular = getattr(state, "circular_chroms", {}) or {}
    for chrom in chroms:
        if isinstance(chrom, dict):
            name = chrom.get("name")
            size = chrom.get("size") or chrom.get("length")
        else:
            name = getattr(chrom, "name", None)
            size = getattr(chrom, "size", getattr(chrom, "length", None))
        if name and size:
            out.append({"name": str(name), "size": int(size), "circular": bool(circular.get(str(name)))})
    return out


class UnknownRenderDatasets(ValueError):
    """The request named datasets that aren't loaded."""


class UnsupportedRenderOption(ValueError):
    """The request uses an option this engine can't honour."""


# The browser store's initial layer toggles (uiSlice.ts). setState replaces
# these maps whole, so the payload always sends them complete.
DEFAULT_ENABLED_MOD_TYPES = {
    "mod": False, "m6a": False, "m5c": False, "deam": False, "deam_opportunity": False,
    "msp": False, "fire": False, "footprint": True, "nuc": True, "tf": True,
}
DEFAULT_ENABLED_META_PROFILES = {"nuc": True, "tf": True, "fire": False, "m6a": False, "m5c": False, "deam": False}


def _explicit_fields(req) -> set:
    return set(getattr(req, "model_fields_set", None) or getattr(req, "__fields_set__", set()))


def _cluster_assignments_for_render(state, dataset_ids: list[str]) -> dict[str, dict[str, int]]:
    """The server's stored clustering per rendered dataset (what use_clusters draws)."""
    out: dict[str, dict[str, int]] = {}
    for ds_id in dataset_ids:
        dataset = state.get_dataset(ds_id) if hasattr(state, "get_dataset") else None
        assignments = getattr(dataset, "cluster_assignments", None) or {}
        if isinstance(assignments, dict) and assignments:
            out[ds_id] = {str(r): int(c) for r, c in assignments.items() if c is not None}
    return out


# sort_by values the legacy compositor computes; the browser orders reads by
# readSortOrder, so these are computed here the same way and sent as that.
RENDER_SORT_MODES = {"accessibility", "kmeans"}


def _render_reads_by_dataset(req, state, dataset_ids: list[str]) -> dict[str, list[dict]]:
    """The reads the render's region shows per dataset (the analysis working set)."""
    from services.analysis_query import AnalysisReadQuery
    query = AnalysisReadQuery.from_request(
        state, chrom=req.chrom, start=int(req.start), end=int(req.end),
        spanning=bool(req.spanning_only), dataset_ids=dataset_ids, sample_seed=req.sample_seed,
        read_ids=req.read_ids, include_methylation=False, include_layers=False,
    )
    return {ds_id: list(query.build_working_set(state, ds_id).reads) for ds_id in query.dataset_ids}


def _read_sort_order_for_render(req, state, dataset_ids: list[str]) -> dict[str, list[str]]:
    """sort_by as the legacy compositor sorts, as a per-dataset readSortOrder."""
    from services.read_metrics import random_state_from_seed
    from services.read_sorting import sort_reads_by_accessibility, sort_reads_by_kmeans
    width = max(1, int(req.end) - int(req.start))
    out: dict[str, list[str]] = {}
    for ds_id, reads in _render_reads_by_dataset(req, state, dataset_ids).items():
        if req.sort_by == "accessibility":
            ordered = sort_reads_by_accessibility(reads)
        elif len(reads) > int(req.n_clusters or 0):
            ordered = sort_reads_by_kmeans(
                reads, width, n_clusters=int(req.n_clusters or 3),
                random_state=random_state_from_seed(req.sample_seed or "fiberbrowser-analysis", "render", "kmeans"),
            )
        else:
            ordered = reads
        out[ds_id] = [str(read["id"]) for read in ordered]
    return out


def _state_for_request(req, state) -> dict[str, Any]:
    """Translate RenderRequest fields into a setState payload."""
    dataset_ids = req.dataset_ids or ([req.dataset_id] if req.dataset_id else None)
    if dataset_ids:
        # Explicitly named datasets must exist: rendering whatever else is
        # loaded instead would return a plausible image of the wrong data.
        resolve = getattr(state, "resolve_dataset_id", None)
        if callable(resolve):
            dataset_ids = [resolve(ds_id) or ds_id for ds_id in dataset_ids]
        found = {ds["id"] for ds in _datasets_for_render(state, dataset_ids)}
        missing = [ds_id for ds_id in dataset_ids if ds_id not in found]
        if missing:
            raise UnknownRenderDatasets(f"Dataset(s) not loaded: {', '.join(map(str, missing))}")
    datasets = _datasets_for_render(state, dataset_ids)

    sub_tracks = _sub_tracks_for_request(req, state)
    orthogonal_tracks = _orthogonal_tracks_for_render(state)

    panels = []
    slot_order = []
    for ds in datasets:
        panel_id = f"render-{ds['id']}"
        panels.append({
            "id": panel_id,
            "contentType": "dataset",
            "datasetId": ds["id"],
            "subTracks": sub_tracks,
            "collapsed": False,
            "linkGroup": None,
            "layoutRow": 0,
        })
        slot_order.append(panel_id)

    # Layer toggles: the ones the request names turn those layers on or off
    # (as the headless engine does); the rest keep the browser's defaults.
    # setState replaces these maps whole, so they're sent complete.
    explicit = _explicit_fields(req)
    enabled_mod_types: dict[str, bool] = {}
    enabled_meta_profiles: dict[str, bool] = {}
    if explicit & {"show_mods", "show_layers", "show_fire", "show_deam_opportunities"}:
        enabled_mod_types = dict(DEFAULT_ENABLED_MOD_TYPES)
        if "show_mods" in explicit:
            enabled_mod_types.update(dict.fromkeys(("m6a", "m5c", "deam", "mod"), bool(req.show_mods)))
        if "show_deam_opportunities" in explicit:
            enabled_mod_types["deam_opportunity"] = bool(req.show_deam_opportunities)
        if "show_layers" in explicit:
            enabled_mod_types.update(dict.fromkeys(("tf", "nuc"), bool(req.show_layers)))
        if "show_fire" in explicit:
            enabled_mod_types["fire"] = bool(req.show_fire)
            enabled_meta_profiles = {**DEFAULT_ENABLED_META_PROFILES, "fire": bool(req.show_fire)}

    # Always ship the full enabledCigarTypes shape. Earlier we shipped {}
    # when show_cigar was false, which made `state.enabledCigarTypes.mismatches`
    # in the React store be `undefined` — and `anyCigarEnabled()` propagated
    # that to `needsCigar`, which then crashed URLSearchParams construction
    # in `useReadTrackData` and silently killed the entire reads fetch. The
    # store's `anyCigarEnabled` is now defensive too, but keep the payload
    # honest so the type contract matches the slice's initial state.
    enabled_cigar_types: dict[str, bool] = {
        "mismatches": bool(req.show_cigar),
        "insertions": bool(req.show_cigar),
        "deletions": bool(req.show_cigar),
    }

    # A palette (colors={'nuc': ...}) is the legacy compositor's: the browser
    # colours footprints through labeling rules and fixed mark colours, so
    # there's no faithful translation. Say so rather than silently ignore it.
    if req.sort_by and not req.read_sort_order and req.sort_by not in RENDER_SORT_MODES:
        raise UnsupportedRenderOption(
            f"sort_by={req.sort_by!r} isn't supported by engine='playwright'; use "
            f"{' or '.join(sorted(RENDER_SORT_MODES))}, or pass read_sort_order")
    if req.colors:
        raise UnsupportedRenderOption(
            "colors isn't supported by engine='playwright' (the browser colours reads with labeling "
            "rules); use engine='numpy' for a palette, or set labeling rules in the browser")
    # Ship the live colormap so the render matches what's on-screen.
    live = getattr(state, "active_colormap", None)
    if live is not None:
        try:
            # Backend state may store as dataclass-like; fall back to dict.
            from dataclasses import is_dataclass, asdict
            active_colormap = asdict(live) if is_dataclass(live) else dict(live)
        except Exception:
            active_colormap = {}
    else:
        active_colormap = {}
    if req.quality_shading and isinstance(active_colormap, dict):
        shading = active_colormap.get("qualityShading") or {}
        shading["enabled"] = True
        active_colormap["qualityShading"] = shading

    payload: dict[str, Any] = {
        "chrom": req.chrom,
        "start": int(req.start),
        "end": int(req.end),
        "datasets": datasets,
        "panels": panels,
        "slotOrder": slot_order,
        "selectedDatasets": [],  # Set on the JS side via Set([])
        "spanningOnly": bool(req.spanning_only),
        "readRowHeight": int(req.row_height) if req.row_height else 3,
        "allReadsDisplayCap": int(req.max_reads) if req.max_reads else 2000,
        "downsampleCount": int(req.max_reads) if req.max_reads else None,
        "clusterK": int(req.n_clusters) if req.n_clusters else 5,
        "subnucleosomalThreshold": int(req.subnuc_threshold) if req.subnuc_threshold else 90,
        "analysisSampleSeed": req.sample_seed or "fiberbrowser-analysis",
        "enabledCigarTypes": enabled_cigar_types,
    }
    chroms = _chroms_for_render(state)
    if chroms:
        payload["chroms"] = chroms
    if getattr(state, "fasta", None) is not None:
        payload["hasFasta"] = True
        fasta_path = getattr(state, "fasta_path", None)
        if fasta_path:
            payload["fastaPath"] = str(fasta_path)
    current_genome = getattr(state, "current_genome", None)
    if current_genome:
        payload["currentGenome"] = current_genome
    if getattr(state, "gtf_data", None) is not None:
        payload["genes"] = _genes_for_render(req, state)
    if orthogonal_tracks:
        payload["orthogonalTracks"] = orthogonal_tracks
    if enabled_mod_types:
        payload["enabledModTypes"] = enabled_mod_types
    if enabled_meta_profiles:
        payload["enabledMetaProfiles"] = enabled_meta_profiles
    if active_colormap:
        payload["activeColormap"] = active_colormap
    if req.sort_by:
        payload["sortMode"] = req.sort_by
        # The read track orders by readSortOrder (sortMode is only the UI's
        # label), so compute the order as the legacy compositor does.
        if not req.read_sort_order and req.sort_by in RENDER_SORT_MODES:
            order = _read_sort_order_for_render(req, state, [ds["id"] for ds in datasets])
            if order:
                payload["readSortOrder"] = order
    if req.read_ids is not None:
        # An empty list is an applied filter matching no reads.
        # ReadTrack filters by `filteredReadIds[stateKey]` (where stateKey
        # defaults to datasetId). The OLD code wrote to `activeReadIds`, which
        # exists in the store but is only used by ExportPanel for ordering —
        # so the request shape was right but the display was unaffected.
        # That was Bug 1 in the FiberCNN bug report.
        #
        # We key the filter by every dataset id rendered in this payload. For
        # single-dataset renders (the common case — dataset_id=merged_id) that
        # produces one entry. For multi-dataset renders the same id list
        # applies across all panels, which matches the prior intent.
        read_ids_list = [str(rid) for rid in req.read_ids]
        payload["filteredReadIds"] = {ds["id"]: read_ids_list for ds in datasets}
    if getattr(req, "use_clusters", False):
        # The server's stored clustering, as the legacy compositor draws it;
        # the fresh page has none of its own to colour or order by.
        assignments = _cluster_assignments_for_render(state, [ds["id"] for ds in datasets])
        if assignments:
            payload["clusterAssignments"] = assignments
    if req.cluster_order:
        payload["clusterOrder"] = req.cluster_order
    if req.read_sort_order:
        payload["readSortOrder"] = req.read_sort_order
    return payload


# ──────────────────────────────────────────────────────────────────────
# Output wrapping (PNG → PDF / SVG) — reuses logic from render_endpoint.py
# ──────────────────────────────────────────────────────────────────────


def _wrap_png(png_bytes: bytes, fmt: str, dpi: int, *, partial: bool, diagnostics: dict) -> Response:
    """Wrap raw PNG bytes in the requested format and Response envelope."""
    common_headers = {
        "X-Render-Engine": "playwright",
        "X-Render-Diagnostics": json.dumps(diagnostics, separators=(",", ":")),
    }
    if partial:
        common_headers["X-Render-Partial"] = "true"

    fmt = (fmt or "png").lower()

    if fmt == "png":
        return Response(
            content=png_bytes,
            media_type="image/png",
            headers=common_headers,
        )

    if fmt == "pdf":
        from PIL import Image
        img = Image.open(io.BytesIO(png_bytes))
        out = io.BytesIO()
        try:
            from reportlab.lib.utils import ImageReader
            from reportlab.pdfgen import canvas
            pdf_w = img.width * 72 / max(dpi, 1)
            pdf_h = img.height * 72 / max(dpi, 1)
            pdf_canvas = canvas.Canvas(out, pagesize=(pdf_w, pdf_h))
            pdf_canvas.drawImage(ImageReader(img), 0, 0, width=pdf_w, height=pdf_h)
            pdf_canvas.save()
        except ImportError:
            img.save(out, format="PDF", resolution=dpi or 150)
        return Response(
            content=out.getvalue(),
            media_type="application/pdf",
            headers={**common_headers, "Content-Disposition": "attachment; filename=fiberbrowser_render.pdf"},
        )

    if fmt == "svg":
        b64 = base64.b64encode(png_bytes).decode("ascii")
        # We don't know intrinsic px dims without loading the PNG; cheap
        # parse via PIL gives us them.
        from PIL import Image
        img = Image.open(io.BytesIO(png_bytes))
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" '
            f'width="{img.width}" height="{img.height}">\n'
            f'  <image width="{img.width}" height="{img.height}" '
            f'href="data:image/png;base64,{b64}"/>\n'
            f"</svg>"
        )
        return Response(
            content=svg.encode("utf-8"),
            media_type="image/svg+xml",
            headers={**common_headers, "Content-Disposition": "attachment; filename=fiberbrowser_render.svg"},
        )

    # Unknown format: fall back to PNG so callers always get bytes.
    return Response(content=png_bytes, media_type="image/png", headers=common_headers)


# ──────────────────────────────────────────────────────────────────────
# Public entry point
# ──────────────────────────────────────────────────────────────────────


def render_with_playwright(req, state) -> Response:
    """Synchronous Playwright render. Called via asyncio.to_thread by the router."""
    # tf_overlay isn't supported in v1 — surface as a warning header.
    tf_overlay_warning = bool(getattr(req, "tf_overlay", None))

    width = max(200, int(getattr(req, "width", 2000) or 2000))
    # Approximate the page height from the dataset count + tracks. The
    # tracks-region wrapper has overflow:hidden in render mode so any extra
    # height just gets cropped — pick a generous default to avoid clipping.
    n_datasets = max(1, len(req.dataset_ids or ([req.dataset_id] if req.dataset_id else [])))
    height = max(800, 320 * n_datasets + 200)

    dpi = int(getattr(req, "dpi", 150) or 150)
    device_scale_factor = max(1.0, dpi / 96.0)
    request_timeout_ms = getattr(req, "timeout_ms", None)
    timeout_ms = DEFAULT_TIMEOUT_MS
    if request_timeout_ms is not None:
        timeout_ms = max(MIN_TIMEOUT_MS, min(MAX_TIMEOUT_MS, int(request_timeout_ms)))

    # Append `&nudges=1` to the worker URL when the request asks for it. The
    # worker forwards this into the navigated URL; renderMode.ts reads the
    # param and toggles `html.render-mode-show-nudges` so the in-track
    # warning overlays remain visible. Default off: render captures are
    # figure-clean (no rose "Filter is hiding every read" box, no hints).
    show_nudges = bool(getattr(req, "show_nudges", False))
    # The worker's browser opens the page with this server's access token
    # (services/local_auth.py); its API calls then carry the cookie.
    from services.local_auth import tokened_url
    self_url = tokened_url(DEFAULT_SELF_URL)
    from services.lab.auth import with_render_identity
    self_url = with_render_identity(self_url)  # a lab server: act as the member who asked
    if show_nudges:
        sep = "&" if "?" in self_url else "?"
        self_url = f"{self_url}{sep}nudges=1"

    try:
        render_state = _state_for_request(req, state)
    except (UnknownRenderDatasets, UnsupportedRenderOption) as exc:
        return Response(
            content=json.dumps({"error": str(exc)}).encode("utf-8"),
            media_type="application/json",
            status_code=404 if isinstance(exc, UnknownRenderDatasets) else 400,
            headers={"X-Render-Engine": "playwright"},
        )
    envelope = {
        "id": str(uuid.uuid4()),
        "url": self_url,
        "viewport": {"width": width, "height": height},
        "deviceScaleFactor": device_scale_factor,
        "timeoutMs": timeout_ms,
        "state": render_state,
    }

    timeout_s = (timeout_ms + 5_000) / 1000.0
    try:
        result = _WORKER.submit(envelope, timeout_s=timeout_s)
    except _ConcurrencyExceeded:
        return Response(
            content=json.dumps({"error": "render concurrency exceeded; retry shortly"}).encode("utf-8"),
            media_type="application/json",
            status_code=503,
            headers={"Retry-After": "1", "X-Render-Engine": "playwright"},
        )
    except _WorkerError as exc:
        msg = str(exc)
        # The hint helpers above already embed a Run: ... line for most cases.
        # Extract it here for the structured response body so clients can
        # surface a one-liner without parsing the full multi-line message.
        fix = None
        for marker in ("Run: `", "Run: "):
            idx = msg.find(marker)
            if idx >= 0:
                fix = msg[idx + len(marker):].splitlines()[0].rstrip("` ")
                break
        body = {"error": msg}
        if fix:
            body["fix"] = fix
        return Response(
            content=json.dumps(body).encode("utf-8"),
            media_type="application/json",
            status_code=503,
            headers={"X-Render-Engine": "playwright"},
        )

    if not result.get("ok"):
        body = {"error": result.get("error", "unknown render error"),
                "diagnostics": result.get("diagnostics", {})}
        return Response(
            content=json.dumps(body).encode("utf-8"),
            media_type="application/json",
            status_code=502,
            headers={"X-Render-Engine": "playwright"},
        )

    png_b64 = result.get("png_b64") or ""
    if not png_b64:
        return Response(
            content=json.dumps({"error": "worker returned no PNG"}).encode("utf-8"),
            media_type="application/json",
            status_code=502,
            headers={"X-Render-Engine": "playwright"},
        )

    png_bytes = base64.b64decode(png_b64)
    diagnostics = result.get("diagnostics") or {}
    if tf_overlay_warning:
        diagnostics["tf_overlay_ignored"] = True

    response = _wrap_png(
        png_bytes,
        fmt=req.format,
        dpi=dpi,
        partial=bool(result.get("partial")),
        diagnostics=diagnostics,
    )
    if tf_overlay_warning:
        response.headers["X-Render-Warning"] = "tf_overlay not supported in playwright engine v1"
    if result.get("reason"):
        response.headers["X-Render-Reason"] = str(result["reason"])[:200]
    return response


# ──────────────────────────────────────────────────────────────────────
# Smoke/probe helpers (used by tests + diagnostic CLI)
# ──────────────────────────────────────────────────────────────────────


def is_worker_running() -> bool:
    """Lightweight introspection for tests/diagnostics."""
    proc = _WORKER._proc  # noqa: SLF001 - intentional
    return bool(proc and proc.poll() is None)


def worker_pid() -> Optional[int]:
    proc = _WORKER._proc  # noqa: SLF001 - intentional
    return proc.pid if proc and proc.poll() is None else None


def shutdown_worker() -> None:
    """Test-friendly shutdown; safe to call multiple times."""
    _WORKER.shutdown()
