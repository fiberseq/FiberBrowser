"""Genome loading routines shared by API routers and legacy server wrappers."""
from __future__ import annotations

import gzip
import os
import shutil
import threading
import urllib.request
import weakref


# Lock hierarchy (services/lock_order; every path takes them in this order, never the reverse; tests check it):
#   0. operation locks         one workspace's operation on one key (catalog group load/unload, demo load).
#   1. state_lock(state)       per state owner (base workspace, the template of public visitors, a tour/workspace
#                              copy-on-write state): dataset mutations (add, remove, merge, unmerge, registration,
#                              catalog, insertion registration) and publication on the main reference (genome/
#                              FASTA/GTF load, session import, chromosomes from a header, plasmid maps, links and
#                              frames, circular flags, declarations, primer paths, demo clearing). Re-entrant.
#   2. reference_lock(ctx)     a panel genome's context: reference-only writers on a view take it alone; writers
#                              touching datasets and a view's reference take 1 then 2 (reference_write_lock).
#   3. panel_genomes._LOCK     the process-wide panel registry: bookkeeping only, never any I/O.
#   4. download_lock(...)      one per cache file: downloads and cache allocation.
# Slow work (downloads, FASTA open, header reads, file inspection) happens before 1 where it can (dataset
# registration, panel attach, plasmid maps, GTF route); loads that publish a reference hold 1 or 2 for their whole
# length, as do a session import and an insertion registration (each opens small files under 1). Writers outside
# the hierarchy by design: BrowserState.__init__ and server startup (before serving), the DAF-C state's own
# chromosomes (a separate state), insertion_identify's private snapshot. Nothing here is ever waited for on the
# event loop: routes that reach these locks run in worker threads.
_owner_locks_guard = threading.Lock()
_owner_locks: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()
_owner_locks_by_id: dict = {}


def reference_owner(state):
    """The object whose reference attributes a write through ``state`` replaces: a panel genome's view
    (panel_genomes.GenomeView, one per request) writes to its shared context; a session forked from a shared
    template (public visitors) to the template; anything else to itself (a tour tab's or workspace's
    copy-on-write state writes its own copy, never the template's)."""
    ctx = getattr(state, "__dict__", {}).get("_genome_context")
    if ctx is not None:
        return reference_owner(ctx)
    d = getattr(state, "__dict__", {})
    template = d.get("_template")
    if template is not None and not d.get("_cow_shared"):
        # A session forked from a shared template (public visitors): its reference writes go to the template.
        return reference_owner(template)
    return state


def reference_lock(state) -> threading.RLock:
    """The lock every replacement of a reference holds, for its whole length (clearing, FASTA, annotation,
    genome id, collection metadata): two at once would interleave them (hg38's annotation and id over mm10's
    sequence). One per reference owner (``reference_owner``), so two views of one panel genome share it and tour
    tabs don't wait on each other. Re-entrant: a session import holds it around its own FASTA load. Taken only in
    worker threads (never on the event loop)."""
    from services.lock_order import CONTEXT, STATE, OrderedLock
    owner = reference_owner(state)
    is_context = bool(getattr(owner, "__dict__", {}).get("_panel_context")) or \
        getattr(state, "__dict__", {}).get("_genome_context") is not None
    with _owner_locks_guard:
        try:
            lock = _owner_locks.get(owner)
            if lock is None:
                lock = _owner_locks[owner] = OrderedLock(STATE, f"state:{type(owner).__name__}@{id(owner):x}")
        except TypeError:  # not weak-referenceable
            lock = _owner_locks_by_id.setdefault(id(owner), OrderedLock(STATE, f"state@{id(owner):x}"))
        if is_context and lock.level == STATE:
            lock.level, lock.name = CONTEXT, lock.name.replace("state:", "context:", 1)
        return lock


def state_lock(state) -> threading.RLock:
    """The lock of a state's datasets and main reference (lock 1 above). A panel view's datasets are its base
    state's, so a view resolves to that state's lock; otherwise the same lock as ``reference_lock``."""
    base = getattr(state, "__dict__", {}).get("_genome_base")
    return reference_lock(base if base is not None else state)


class reference_write_lock:
    """The locks of a writer that touches a state's datasets and its reference: ``state_lock`` then
    ``reference_lock`` (one lock for a plain state; the base workspace then the context for a panel view)."""

    def __init__(self, state):
        self._locks = [state_lock(state)]
        ref = reference_lock(state)
        if ref is not self._locks[0]:
            self._locks.append(ref)

    def __enter__(self):
        for lock in self._locks:
            lock.acquire()
        return self

    def __exit__(self, *exc):
        for lock in reversed(self._locks):
            lock.release()
        return False


def publishes_reference(fn):
    """Decorator: ``fn(state, ...)`` writes reference fields in memory only; it runs under
    ``reference_write_lock(state)``."""
    import functools

    @functools.wraps(fn)
    def wrapper(state, *args, **kwargs):
        with reference_write_lock(state):
            return fn(state, *args, **kwargs)
    return wrapper


def _fasta_stem(path) -> str:
    stem = os.path.basename(str(path or ""))
    for ext in (".fa.gz", ".fasta.gz", ".fna.gz", ".fa", ".fasta", ".fna"):
        if stem.lower().endswith(ext):
            return stem[: -len(ext)]
    return stem


def genome_already_loaded(state, genome_id: str) -> bool:
    """The state already has this genome, coherently: its id, a FASTA that is that genome's (the one a registry
    load of it installed, or a user's FASTA named for it, ``--fasta hg38.fa``) and no other registry genome's
    annotation. A mixed state (another genome's sequence or annotation under this id) is loaded again."""
    if getattr(state, "current_genome", None) != genome_id or getattr(state, "fasta", None) is None:
        return False
    fasta_path = getattr(state, "fasta_path", None)
    installed = getattr(state, "registry_fasta", None)
    if not (installed == (genome_id, fasta_path) or _fasta_stem(fasta_path) == genome_id):
        return False
    gtf_path = getattr(state, "gtf_path", None)
    if gtf_path and os.path.dirname(os.path.abspath(gtf_path)) == _genome_cache_dir() \
            and os.path.basename(gtf_path) != f"{genome_id}.gtf":
        return False
    return True


def _genome_cache_dir() -> str:
    return os.path.abspath(os.path.join(os.path.expanduser("~"), ".fiberhmm", "genomes"))


def already_loaded_result(state, genome_id: str, info: dict) -> dict:
    return {
        "success": True, "genome_id": genome_id, "name": info.get("name", genome_id),
        "already_loaded": True, "message": "Genome already loaded",
        "fasta_loaded": True, "fasta_path": getattr(state, "fasta_path", None),
        "gtf_loaded": getattr(state, "gtf_data", None) is not None,
    }


def load_genome_blocking(state, genome_id: str, info: dict) -> dict:
    """Load a registered genome into the provided browser state.

    Nothing to do when the state already has it, coherently, with a FASTA (session restores ask for the saved
    genome): the loaded FASTA, maybe the user's own, is never replaced by a download. One reference change per
    state at a time (``reference_lock``): a second request waits for the first and then finds it loaded.
    """
    # One reference change per state at a time, the no-op check under the same lock: a load never sees, or
    # leaves, another load's half-installed reference.
    with reference_lock(state):
        if genome_already_loaded(state, genome_id):
            return already_loaded_result(state, genome_id, info)
        result = _load_genome_unlocked(state, genome_id, info)
        if result.get("fasta_loaded") and getattr(state, "fasta", None) is not None:
            state.registry_fasta = (genome_id, getattr(state, "fasta_path", None))
        return result


def _load_genome_unlocked(state, genome_id: str, info: dict) -> dict:
    result = {"success": False, "genome_id": genome_id, "name": info["name"]}
    fasta_error = "No FASTA for this genome"
    previous_genome = getattr(state, "current_genome", None)

    try:
        print(f"\n=== Loading genome: {info['name']} ===")
        local_genome_dir = os.path.join(os.path.expanduser("~"), ".fiberhmm", "genomes")

        fasta_urls = list(info.get("fasta_urls") or [])
        fasta_url = info.get("fasta_url")
        if fasta_url and fasta_url not in fasta_urls:
            fasta_urls.insert(0, fasta_url)
        fai_urls = list(info.get("fai_urls") or [])
        fai_url = info.get("fai_url")

        primary_url = fasta_urls[0] if fasta_urls else fasta_url
        if primary_url:
            # The same cache file the download uses (one per source).
            from state.browser_state import cached_fasta_path, verified_cached_fasta

            local_fasta = cached_fasta_path(local_genome_dir, fasta_urls or [primary_url])

            verified = None
            if os.path.exists(local_fasta):
                # A cached reference opens only with an index verified to describe it (rebuilt when it does
                # not; refused when it cannot be): the same check the download path makes. A compressed
                # cache is decompressed first; one that is not a FASTA at all is removed and downloaded again.
                print(f"  FASTA (cached): {local_fasta}")
                verified = verified_cached_fasta(fasta_urls or [primary_url])
            if verified:
                fasta_error = state._load_fasta(verified)
            else:
                print(f"  FASTA: {primary_url} (+{len(fasta_urls) - 1} fallbacks)")
                fasta_error = state._load_fasta(
                    primary_url,
                    fai_url=fai_url,
                    fasta_urls=fasta_urls,
                    fai_urls=fai_urls,
                )

        # _load_fasta returns None on success; on failure the previous
        # genome's handle may still be open, so don't judge by state.fasta.
        if fasta_error is None and state.fasta is not None:
            result["fasta_loaded"] = True
        else:
            result["fasta_loaded"] = False
            result["fasta_error"] = "Failed to download or load FASTA (non-fatal)"
            print("  FASTA not available; genome will load without sequence view")
    except Exception as exc:
        print(f"  ERROR loading remote FASTA: {exc}")
        result["fasta_error"] = str(exc)
        result["fasta_loaded"] = False

    gtf_url = info.get("gtf_url")
    if gtf_url:
        try:
            cache_dir = os.path.join(os.path.expanduser("~"), ".fiberhmm", "genomes")
            os.makedirs(cache_dir, exist_ok=True)
            gtf_cache_path = os.path.join(cache_dir, f"{genome_id}.gtf")

            from services.download_locks import holding

            with holding(os.path.abspath(gtf_cache_path)):
                _download_gtf(gtf_url, gtf_cache_path)

            from services.gene_annotations import load_gtf

            state.gtf_data = load_gtf(gtf_cache_path)
            state.gtf_path = gtf_cache_path
            gene_count = len(state.gtf_data.get("transcripts", [])) if state.gtf_data else 0
            print(f"  GTF loaded: {gene_count} transcripts")
            result["gtf_loaded"] = True
            result["gene_count"] = gene_count
        except Exception as exc:
            print(f"  ERROR loading GTF: {exc}")
            result["gtf_error"] = str(exc)
            result["gtf_loaded"] = False

    result["success"] = result.get("gtf_loaded", False) or result.get("fasta_loaded", False)
    if result["success"]:
        # Switching genomes: whatever wasn't replaced belongs to the previous
        # genome (e.g. human sequence under mouse annotations); drop it.
        switching = previous_genome != genome_id
        if switching and not result.get("fasta_loaded"):
            _close_fasta(state)
        if switching and not result.get("gtf_loaded"):
            state.gtf_data = None
            state.gtf_path = None
        state.current_genome = genome_id
    return result


def _close_fasta(state) -> None:
    handle = getattr(state, "fasta", None)
    # A sandbox that couldn't reopen its template's reference borrows the
    # template's handle: dropping it here must not close it for the main tab.
    template = getattr(state, "__dict__", {}).get("_template")
    if handle is not None and handle is not getattr(template, "fasta", None):
        try:
            handle.close()
        except Exception:
            pass
    state.fasta = None
    state.fasta_path = None


def _download_gtf(gtf_url: str, gtf_cache_path: str) -> None:
    """The registry annotation into the cache, unless it is there (callers hold its download lock)."""
    if os.path.exists(gtf_cache_path):
        print(f"  GTF cached: {gtf_cache_path}")
    else:
        print(f"  Downloading GTF: {gtf_url}")
        tmp_path = gtf_cache_path + ".tmp"
        gz_path = tmp_path + ".gz"
        try:
            if gtf_url.endswith(".gz"):
                _http_fetch(gtf_url, gz_path)   # complete or it raises (http_download), nothing published
                print("  Decompressing GTF...")
                with gzip.open(gz_path, "rb") as f_in:
                    with open(tmp_path, "wb") as f_out:
                        shutil.copyfileobj(f_in, f_out)
                os.remove(gz_path)
            else:
                _http_fetch(gtf_url, tmp_path)
            os.rename(tmp_path, gtf_cache_path)
        except BaseException:
            # A failed or truncated download leaves no temporary behind: the next load tries again.
            for leftover in (gz_path, tmp_path):
                try:
                    os.remove(leftover)
                except OSError:
                    pass
            raise
        print(f"  GTF saved: {gtf_cache_path}")


def _http_fetch(*args, **kwargs):
    """A download with finite deadlines (services/http_download.fetch; tests replace it there)."""
    from services import http_download
    return http_download.fetch(*args, **kwargs)
