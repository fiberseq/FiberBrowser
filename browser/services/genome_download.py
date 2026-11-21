"""A catalog genome's FASTA downloaded into the cache for the run wizard, in the background, with progress.

The wizard needs the FASTA on disk (``pipeline_inputs.catalog_genome_fasta``), nothing else: this never opens
the genome in the browser (``/api/load_genome`` does that, swaps the view's reference and fetches the
annotation too). One download per genome, process-wide; its status is polled. Errors say which mirror failed
and why; a cancel stops it at the next chunk without trying another mirror.

Size (services/http_download.py: no cap, a warning threshold): ``size`` tells the wizard what a download will
be before it starts (the first mirror's Content-Length, when it says). A start over the threshold that was not
confirmed ends in state ``confirm`` with ``total`` and ``threshold`` (nothing downloaded; ``start(...,
confirm_large=True)`` goes ahead); one of unknown size that passes it goes on with a ``warning``.
"""
from __future__ import annotations

import os
import threading
import time
from typing import Optional

_LOCK = threading.Lock()
_DOWNLOADS: dict[str, dict] = {}


def _public(entry: dict) -> dict:
    return {k: v for k, v in entry.items() if not k.startswith("_")}


def status(genome_id: str) -> dict:
    """The download's state: ``idle`` (none started), ``running``, ``done``, ``error`` or ``cancelled``."""
    with _LOCK:
        entry = _DOWNLOADS.get(genome_id)
        return _public(entry) if entry else {"genome_id": genome_id, "state": "idle"}


def _catalog_urls(genome_id: str) -> tuple[Optional[dict], list[str]]:
    from services.genome_registry import GENOME_REGISTRY
    info = GENOME_REGISTRY.get(genome_id)
    if info is None:
        return None, []
    urls = list(info.get("fasta_urls") or [])
    if info.get("fasta_url") and info["fasta_url"] not in urls:
        urls.insert(0, info["fasta_url"])
    return info, urls


def size(genome_id: str) -> dict:
    """What the download will be: the first mirror's announced size (``bytes``, None when it does not say), the
    warning threshold, and whether the size is over it. Nothing is downloaded."""
    from services import http_download
    info, urls = _catalog_urls(genome_id)
    threshold = http_download.warn_bytes()
    out = {"genome_id": genome_id, "url": urls[0] if urls else None, "bytes": None, "threshold": threshold,
           "over": False}
    if info is None or not urls:
        return out
    total = http_download.probe_size(urls[0])
    out["bytes"] = total
    out["over"] = bool(threshold and total is not None and total > threshold)
    return out


def start(genome_id: str, confirm_large: bool = False) -> dict:
    """Start the download (a running one is returned as is; a finished, failed or cancelled one is started
    again unless the FASTA is already there). ``confirm_large``: the user agreed to a download over the size
    warning threshold (else such a download stops before it begins, in state ``confirm``)."""
    from services.pipeline_inputs import catalog_genome_fasta
    info, urls = _catalog_urls(genome_id)
    if info is None:
        return {"genome_id": genome_id, "state": "error", "error": f"Unknown genome: {genome_id}", "errors": []}
    if not urls:
        return {"genome_id": genome_id, "state": "error", "error": f"{genome_id} has no FASTA in the catalog",
                "errors": []}
    with _LOCK:
        entry = _DOWNLOADS.get(genome_id)
        if entry and entry["state"] == "running":
            return _public(entry)
    # The same check the wizard's validation makes (verify=True: a plain FASTA with an index that describes it). A
    # cached file that fails it (no index yet, a truncated gzip) is fetched or indexed again by the download, never
    # answered "done" while the validation still says "not downloaded".
    local, _ = catalog_genome_fasta(genome_id, verify=True)
    if local:
        entry = {"genome_id": genome_id, "name": info["name"], "state": "done", "fasta": local,
                 "url": None, "bytes": 0, "total": 0, "error": None, "errors": []}
        with _LOCK:
            _DOWNLOADS[genome_id] = entry
            return _public(entry)
    cancel = threading.Event()
    entry = {"genome_id": genome_id, "name": info["name"], "state": "running", "url": urls[0], "bytes": 0,
             "total": 0, "stage": "downloading", "error": None, "errors": [], "fasta": None, "started": time.time(),
             "warning": None, "_cancel": cancel, "_confirmed": bool(confirm_large)}
    with _LOCK:
        current = _DOWNLOADS.get(genome_id)
        if current and current["state"] == "running":
            return _public(current)
        _DOWNLOADS[genome_id] = entry
    threading.Thread(target=_run, args=(genome_id, urls, entry), name=f"genome-download-{genome_id}",
                     daemon=True).start()
    return _public(entry)


def cancel(genome_id: str) -> dict:
    """Ask a running download to stop: at its next chunk, or before decompressing or indexing (``cancelling``
    true until it has stopped; an index being built finishes first)."""
    with _LOCK:
        entry = _DOWNLOADS.get(genome_id)
        if entry and entry["state"] == "running":
            entry["_cancel"].set()
            entry["cancelling"] = True
    return status(genome_id)


def _run(genome_id: str, urls: list[str], entry: dict) -> None:
    from services.http_download import DownloadCancelled, LargeDownload, download_policy, format_bytes
    from state.browser_state import BrowserState
    cancel_event: threading.Event = entry["_cancel"]
    errors: list[dict] = []

    def large(url: str, done: int, threshold: int) -> None:
        """A download over the warning size that goes ahead (confirmed, or of unknown size past it): said once."""
        with _LOCK:
            entry["warning"] = (f"Large download: {format_bytes(done)} (over the {format_bytes(threshold)} "
                                f"download warning size) from {url}")

    def progress(url: str, done: int, total: int) -> None:
        if cancel_event.is_set():
            raise DownloadCancelled("cancelled")
        with _LOCK:
            if entry["url"] != url:
                entry["url"], entry["bytes"], entry["total"] = url, 0, 0
            entry["bytes"], entry["total"] = int(done), int(total)
            entry["errors"] = list(errors)

    def stage(name: str) -> None:
        """Decompressing and indexing report no bytes: the wizard shows the stage. A cancel before either stops."""
        if cancel_event.is_set():
            raise DownloadCancelled("cancelled")
        with _LOCK:
            entry["stage"] = name

    result: dict
    from services.download_locks import holding
    from state.browser_state import _plain_fasta_basename
    from services.pipeline_inputs import catalog_genome_fasta, genome_cache_dir
    # The same per-file lock as BrowserState._download_fasta_to_cache (and so /api/load_genome): what is in the
    # cache, and whether this download made it, is decided while no one else can write that file.
    key = f"fasta-cache:{os.path.abspath(os.path.join(genome_cache_dir(), _plain_fasta_basename(urls[0])))}"
    try:
        with holding(key), download_policy(confirmed=entry.get("_confirmed", False), on_large=large):
            cached = _cached_path(urls)
            if cached and os.path.exists(cached) and catalog_genome_fasta(genome_id)[0] is None:
                _discard(cached)   # a cached file whose index cannot be built is replaced, not trusted
            made = not (cached and os.path.exists(cached))
            try:
                local = BrowserState._download_fasta_to_cache_unlocked(urls[0], fasta_urls=urls, progress=progress,
                                                                      errors=errors, stage=stage)
            except BaseException:
                if made and cached:
                    _discard(cached)   # only a file this download published, still under the lock
                raise
        if local:
            result = {"state": "done", "fasta": local}
        else:
            reasons = "; ".join(f"{e['url']}: {e['error']}" for e in errors) or "no mirror answered"
            result = {"state": "error", "error": f"Could not download {entry['name']}. {reasons}"}
    except DownloadCancelled:
        result = {"state": "cancelled", "error": None}
    except LargeDownload as exc:
        # Over the size warning and not confirmed: nothing downloaded; the wizard asks, then starts it again.
        result = {"state": "confirm", "error": None, "url": exc.url, "total": exc.total, "threshold": exc.threshold}
    except Exception as exc:   # noqa: BLE001 - e.g. the index could not be built: shown to the user
        if cancel_event.is_set():
            result = {"state": "cancelled", "error": None}
        else:
            result = {"state": "error", "error": f"Could not download {entry['name']}: {exc}"}
    with _LOCK:
        entry.update(result)
        entry["errors"] = list(errors)
        entry["finished"] = time.time()


def _cached_path(urls: list[str]) -> Optional[str]:
    """The cache file this genome downloads into (pipeline_inputs.catalog_genome_fasta's)."""
    try:
        from services.pipeline_inputs import genome_cache_dir
        from state.browser_state import cached_fasta_path
        return cached_fasta_path(genome_cache_dir(), urls)
    except Exception:   # noqa: BLE001
        return None


def _discard(path: str) -> None:
    """Remove a cached FASTA this download made, with its index and sidecars (only files in the cache)."""
    for name in (path, path + ".fai", path + ".fai.verified", path + ".gzi", path + ".source"):
        try:
            os.remove(name)
        except OSError:
            pass


def _reset_for_tests() -> None:
    with _LOCK:
        _DOWNLOADS.clear()
