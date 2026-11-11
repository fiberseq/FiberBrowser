"""A catalog genome's FASTA downloaded into the cache for the run wizard, in the background, with progress.

The wizard needs the FASTA on disk (``pipeline_inputs.catalog_genome_fasta``), nothing else: this never opens
the genome in the browser (``/api/load_genome`` does that, swaps the view's reference and fetches the
annotation too). One download per genome, process-wide; its status is polled. Errors say which mirror failed
and why; a cancel stops it at the next chunk without trying another mirror.
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


def start(genome_id: str) -> dict:
    """Start the download (a running one is returned as is; a finished, failed or cancelled one is started
    again unless the FASTA is already there)."""
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
    # Verified: a cached FASTA whose index cannot be built (a mirror sent something that is not a FASTA)
    # is not "done"; the download runs again and replaces it.
    local, _ = catalog_genome_fasta(genome_id)
    if local:
        entry = {"genome_id": genome_id, "name": info["name"], "state": "done", "fasta": local,
                 "url": None, "bytes": 0, "total": 0, "error": None, "errors": []}
        with _LOCK:
            _DOWNLOADS[genome_id] = entry
            return _public(entry)
    cancel = threading.Event()
    entry = {"genome_id": genome_id, "name": info["name"], "state": "running", "url": urls[0], "bytes": 0,
             "total": 0, "error": None, "errors": [], "fasta": None, "started": time.time(), "_cancel": cancel}
    with _LOCK:
        current = _DOWNLOADS.get(genome_id)
        if current and current["state"] == "running":
            return _public(current)
        _DOWNLOADS[genome_id] = entry
    threading.Thread(target=_run, args=(genome_id, urls, entry), name=f"genome-download-{genome_id}",
                     daemon=True).start()
    return _public(entry)


def cancel(genome_id: str) -> dict:
    with _LOCK:
        entry = _DOWNLOADS.get(genome_id)
        if entry and entry["state"] == "running":
            entry["_cancel"].set()
    return status(genome_id)


def _run(genome_id: str, urls: list[str], entry: dict) -> None:
    from services.http_download import DownloadCancelled
    from state.browser_state import BrowserState
    cancel_event: threading.Event = entry["_cancel"]
    errors: list[dict] = []

    def progress(url: str, done: int, total: int) -> None:
        if cancel_event.is_set():
            raise DownloadCancelled("cancelled")
        with _LOCK:
            if entry["url"] != url:
                entry["url"], entry["bytes"], entry["total"] = url, 0, 0
            entry["bytes"], entry["total"] = int(done), int(total)
            entry["errors"] = list(errors)

    result: dict
    from services.download_locks import holding
    from state.browser_state import _plain_fasta_basename
    from services.pipeline_inputs import catalog_genome_fasta, genome_cache_dir
    # The same per-file lock as BrowserState._download_fasta_to_cache (and so /api/load_genome): what is in the
    # cache, and whether this download made it, is decided while no one else can write that file.
    key = f"fasta-cache:{os.path.abspath(os.path.join(genome_cache_dir(), _plain_fasta_basename(urls[0])))}"
    made = False
    try:
        with holding(key):
            cached = _cached_path(urls)
            if cached and os.path.exists(cached) and catalog_genome_fasta(genome_id)[0] is None:
                _discard(cached)   # a cached file whose index cannot be built is replaced, not trusted
            made = not (cached and os.path.exists(cached))
            try:
                local = BrowserState._download_fasta_to_cache_unlocked(urls[0], fasta_urls=urls, progress=progress,
                                                                      errors=errors)
                if cancel_event.is_set():
                    # Cancelled while the file was decompressed or indexed: the user asked to stop.
                    raise DownloadCancelled("cancelled")
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
