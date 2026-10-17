"""Find reads by name in the open datasets (fb-r4-clicks).

A read name pasted into a locus box (``m84046_240619_124816_s1/240062573/ccs``,
an ONT UUID, an Illumina name) is looked up in the loaded BAM/BigBed files and
answered with where each read aligns, so the browser can show it whole and
highlight it.

BAM files have no standard name index (pysam reads none), so the search goes
from where the read most likely is to everywhere, one ``scope`` per request:

- ``region``: the view the box belongs to (``chrom``/``start``/``end``);
- ``chrom``: the rest of that chromosome;
- ``genome``: every other contig with reads, most reads first.

The client asks for the next scope only when the previous one did not find
every name, shows which one is running and can cancel between them. Each
request has a wall-clock budget and a record cap, checked between records, so
it always ends; ``complete: false`` says the scope was not searched to the end.
A request takes at most ``MAX_NAMES`` names: the rest are answered as
``not_searched`` (and ``complete: false``), never silently dropped; the client
sends long lists in chunks. A file that cannot be read (no index, gone, no
access) is reported in ``errors`` and makes the answer incomplete: its reads
are not "not found".
Reads found once are remembered (per file version: a file replaced at the same
path is searched again), so finding them again is instant.
"""
from __future__ import annotations

import os
import re
import threading
import time
from services.byte_cache import shared_cache
from typing import Iterable, Optional

from services.bam_handles import get_bam_handle
from services.bigbed_handles import get_bigbed_handle
from utils.chrom import get_chrom_variants

MAX_NAMES = 2000
# Wall-clock budget of one request (seconds) and records examined at most.
DEFAULT_BUDGET_S = 20.0
MAX_BUDGET_S = 120.0
MAX_RECORDS = 50_000_000
# Records between deadline checks.
CHECK_EVERY = 2048
SCOPES = ("region", "chrom", "genome")

_SEGMENT_SUFFIX = re.compile(r"_\d+$")

# (path, file version, query name) -> where the read is in that file (its own
# contig name; the chromosome it is shown on depends on the workspace, so it is
# mapped on use). The version (modification time, size, inode) makes a file
# replaced or re-aligned at the same path a new file: its old answers are never
# returned.
_CACHE = shared_cache('indexes')
_CACHE_LOCK = threading.Lock()


def file_version(path: str) -> object:
    """What identifies this file's content now (None: not a local file, e.g. a URL:
    nothing is remembered for it, since a replaced remote file could not be told apart)."""
    try:
        st = os.stat(path)
    except (OSError, TypeError, ValueError):
        return None
    return (st.st_mtime_ns, st.st_size, st.st_ino)


def _cache_get(path: str, version: object, name: str) -> Optional[dict]:
    if version is None:
        return None
    key = (path, version, name)
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
        if hit is not None:
            _CACHE.move_to_end(key)
        return hit


def _cache_put(path: str, version: object, name: str, hit: dict) -> None:
    if version is None:
        return
    key = (path, version, name)
    with _CACHE_LOCK:
        _CACHE[key] = hit
        _CACHE.move_to_end(key)


def clear_cache() -> None:
    with _CACHE_LOCK:
        _CACHE.clear()


def normalize_names(names: Iterable[str]) -> list[str]:
    """Distinct, trimmed names in the order given (a leading FASTQ ``@`` dropped).

    All of them: a request searches the first MAX_NAMES and answers the rest
    as ``not_searched`` (see ``locate_reads``)."""
    out: list[str] = []
    seen: set[str] = set()
    for raw in names or ():
        name = str(raw or "").strip()
        if name.startswith("@"):
            name = name[1:].strip()
        if not name or name in seen:
            continue
        seen.add(name)
        out.append(name)
    return out


def _wanted(names: list[str]) -> dict[str, str]:
    """``{query name in the file: requested name}``: a split segment's id (``name_2``) finds its read."""
    wanted: dict[str, str] = {}
    for name in names:
        wanted.setdefault(name, name)
    for name in names:
        base = _SEGMENT_SUFFIX.sub("", name)
        if base != name:
            wanted.setdefault(base, name)
    return wanted


def _datasets(state, dataset_ids: Optional[list[str]]):
    ids = dataset_ids or list(getattr(state, "dataset_order", None) or [])
    out = []
    for dataset_id in ids:
        ds = state.get_dataset(dataset_id)
        if ds is not None and getattr(ds, "data_type", None) in ("bam", "bigbed") and (ds.paths or []):
            out.append(ds)
    return out


def _state_chrom(state, contig: str, dataset) -> str:
    """The chromosome the browser shows a file contig on."""
    from services.random_window import _linked_chrom, _resolve_state_chrom
    try:
        return _linked_chrom(state, contig, [dataset]) or _resolve_state_chrom(state, contig)
    except Exception:
        return contig


def _file_contig(chrom: Optional[str], references) -> Optional[str]:
    if not chrom:
        return None
    refs = set(references or ())
    for variant in get_chrom_variants(chrom):
        if variant in refs:
            return variant
    return None


class _Search:
    """One request's bookkeeping: what is still wanted, the budget, what was found."""

    def __init__(self, names: list[str], budget_s: float, max_records: int, cancelled=None):
        self.names = names
        self.wanted = _wanted(names)
        self.remaining = set(names)
        self.deadline = time.monotonic() + budget_s
        self.max_records = max_records
        self.scanned = 0
        self.complete = True
        self.found: dict[str, dict] = {}
        self.fallback: dict[str, dict] = {}  # supplementary alignments, if no primary turns up
        self.cancelled = cancelled or (lambda: False)
        # Files that could not be read: {(dataset id, path): why}.
        self.errors: dict[tuple, str] = {}
        # Names over MAX_NAMES: not looked for in this request.
        self.not_searched: list[str] = []
        self._versions: dict[str, object] = {}

    def version(self, path: str) -> object:
        """The file's version, read once per request."""
        if path not in self._versions:
            self._versions[path] = file_version(path)
        return self._versions[path]

    def failed(self, dataset, path: str, why: str) -> None:
        """A file that could not be read: the search is not complete (its reads were not looked at)."""
        self.complete = False
        self.errors.setdefault((getattr(dataset, "id", None), path), why)

    def out_of_budget(self) -> bool:
        if self.scanned >= self.max_records or time.monotonic() > self.deadline or self.cancelled():
            self.complete = False
            return True
        return False

    def done(self) -> bool:
        return not self.remaining

    def record(self, requested: str, hit: dict, primary: bool = True) -> None:
        if requested not in self.remaining:
            return
        if primary:
            self.found[requested] = hit
            self.remaining.discard(requested)
            self.fallback.pop(requested, None)
        else:
            self.fallback.setdefault(requested, hit)


def _bam_hit(search: _Search, state, dataset, read, path: str, primary: Optional[bool] = None) -> dict:
    """``primary``: the caller's decision that this is the drawn record (default: the
    BAM flags). Only primaries are cached, never an unrepaired lift's hidden record."""
    contig = read.reference_name
    start = int(read.reference_start)
    end = int(read.reference_end or start + 1)
    hit = {
        "read_id": read.query_name,
        "dataset_id": getattr(dataset, "id", None),
        "chrom": _state_chrom(state, contig, dataset),
        "contig": contig,
        "start": start,
        "end": end,
        "strand": "-" if read.is_reverse else "+",
    }
    if primary is None:
        primary = not (read.is_secondary or read.is_supplementary)
    if primary:
        _cache_put(path, search.version(path), read.query_name, {k: hit[k] for k in ("read_id", "contig", "start", "end", "strand")})
    return hit


def _error_text(err: BaseException) -> str:
    text = str(err).strip() or type(err).__name__
    return text[:300]


def _open_scan_handle(path: str, state=None):
    """Scan through the shared reader with the current mode's decompression limit."""
    return get_bam_handle(path, threads=4), False


def _scan_bam(search: _Search, state, dataset, path: str, intervals) -> None:
    if not intervals:
        return
    try:
        bam, owned = _open_scan_handle(path, state)
    except Exception as err:  # noqa: BLE001 - reported to the client, not swallowed
        search.failed(dataset, path, _error_text(err))
        return
    if bam is None:
        search.failed(dataset, path, "the file could not be opened")
        return
    try:
        _scan_bam_records(search, state, dataset, path, bam, intervals)
    finally:
        if owned:
            try:
                bam.close()
            except Exception:
                pass


def _scan_bam_records(search: _Search, state, dataset, path: str, bam, intervals) -> None:
    wanted = search.wanted
    from services.graph_lift import lift_hidden_predicate
    hidden = lift_hidden_predicate(getattr(bam, "header", None))
    for contig, lo, hi in intervals:
        if search.done() or search.out_of_budget():
            return
        try:
            iterator = bam.fetch(contig, lo, hi) if lo is not None else bam.fetch(contig)
        except Exception as err:  # noqa: BLE001 - no index, gone, no access: not "not found"
            search.failed(dataset, path, _error_text(err))
            continue
        n = 0
        try:
            for read in iterator:
                n += 1
                if n % CHECK_EVERY == 0:
                    search.scanned += CHECK_EVERY
                    if search.out_of_budget():
                        return
                requested = wanted.get(read.query_name)
                if requested is None or requested not in search.remaining:
                    continue
                if read.is_unmapped or read.is_secondary:
                    continue
                # An unrepaired lift's ex-supplementary is not the drawn record: a supplementary hit.
                primary = not read.is_supplementary and not (hidden is not None and hidden(read))
                search.record(requested, _bam_hit(search, state, dataset, read, path, primary), primary=primary)
                if search.done():
                    search.scanned += n % CHECK_EVERY
                    return
        except Exception as err:  # noqa: BLE001 - truncated file, broken stream: this file is reported
            search.failed(dataset, path, _error_text(err))
            return
        finally:
            close = getattr(iterator, 'close', None)
            if close is not None:
                close()
        search.scanned += n % CHECK_EVERY


def _bigbed_entry_name(rest: str) -> tuple[Optional[str], Optional[tuple[int, int]]]:
    """A BigBed row's read name (FiberHMM BED: column 4; a FIRE decorator row: its decorated fiber)."""
    fields = (rest or "").split("\t")
    if len(fields) >= 10 and ":" in fields[9]:
        from services.bigbed_read_loader import parse_decorated_item
        item = parse_decorated_item(fields[9])
        if item is not None:
            return item[3], (item[1], item[2])
    return (fields[0] if fields and fields[0] else None), None


def _scan_bigbed(search: _Search, state, dataset, path: str, intervals) -> None:
    if not intervals:
        return
    try:
        bb = get_bigbed_handle(path)
    except Exception as err:  # noqa: BLE001
        search.failed(dataset, path, _error_text(err))
        return
    if bb is None:
        search.failed(dataset, path, "the file could not be opened")
        return
    wanted = search.wanted
    try:
        sizes = bb.chroms() or {}
    except Exception as err:  # noqa: BLE001
        search.failed(dataset, path, _error_text(err))
        return
    for contig, lo, hi in intervals:
        if search.done() or search.out_of_budget():
            return
        size = int(sizes.get(contig) or 0)
        lo = 0 if lo is None else lo
        hi = size if hi is None else hi
        # Fixed windows, so the budget is checked between them on a big contig.
        step = 250_000
        pos = lo
        while pos < hi:
            if search.done() or search.out_of_budget():
                return
            try:
                entries = bb.entries(contig, pos, min(hi, pos + step)) or []
            except Exception as err:  # noqa: BLE001 - unreadable, not empty
                search.failed(dataset, path, _error_text(err))
                return
            for i, (e_start, e_end, rest) in enumerate(entries):
                search.scanned += 1
                if i % CHECK_EVERY == CHECK_EVERY - 1 and search.out_of_budget():
                    return
                name, span = _bigbed_entry_name(rest)
                requested = wanted.get(name) if name else None
                if requested is None or requested not in search.remaining:
                    continue
                start, end = span if span else (int(e_start), int(e_end))
                hit = {
                    "read_id": name,
                    "dataset_id": getattr(dataset, "id", None),
                    "chrom": _state_chrom(state, contig, dataset),
                    "contig": contig,
                    "start": int(start),
                    "end": int(end),
                    "strand": None,
                }
                _cache_put(path, search.version(path), name, {k: hit[k] for k in ("read_id", "contig", "start", "end", "strand")})
                search.record(requested, hit)
            pos += step


def _contigs_by_reads(dataset, path: str) -> list[tuple[str, float]]:
    from services.random_window import _bam_contigs, _bigbed_contigs
    reader = _bam_contigs if dataset.data_type == "bam" else _bigbed_contigs
    try:
        contigs = reader(path)
    except Exception:
        contigs = []
    return sorted(((c, w) for c, w, _size in contigs), key=lambda item: -item[1])


def _intervals(scope: str, dataset, path: str, chrom: Optional[str], start: Optional[int], end: Optional[int]):
    """[(file contig, start or None, end or None)] a scope searches in one file.

    Raises when the file cannot be opened (the caller reports it)."""
    if dataset.data_type == "bam":
        handle = get_bam_handle(path)
        if handle is None:
            raise OSError("the file could not be opened")
        references = getattr(handle, "references", None) or ()
    else:
        handle = get_bigbed_handle(path)
        if handle is None:
            raise OSError("the file could not be opened")
        references = list((handle.chroms() or {}).keys())
    contig = _file_contig(chrom, references)
    if scope == "region":
        if contig is None or start is None or end is None:
            return []
        return [(contig, max(0, int(start)), max(int(start) + 1, int(end)))]
    if scope == "chrom":
        return [(contig, None, None)] if contig is not None else []
    # genome: every contig with reads, most first; the view's chromosome was the previous scope's.
    return [(c, None, None) for c, _w in _contigs_by_reads(dataset, path) if c != contig]


def locate_reads(
    state,
    names: Iterable[str],
    *,
    scope: str = "region",
    chrom: Optional[str] = None,
    start: Optional[int] = None,
    end: Optional[int] = None,
    dataset_ids: Optional[list[str]] = None,
    budget_s: float = DEFAULT_BUDGET_S,
    max_records: int = MAX_RECORDS,
    cancelled=None,
) -> dict:
    """Where the named reads align, searching one scope (see the module docstring)."""
    if scope not in SCOPES:
        raise ValueError(f"scope must be one of {', '.join(SCOPES)}")
    asked = normalize_names(names)
    # Beyond the limit: answered as not searched (the client sends chunks), never dropped silently.
    requested, not_searched = asked[:MAX_NAMES], asked[MAX_NAMES:]
    budget_s = max(0.0, min(float(budget_s), MAX_BUDGET_S))
    search = _Search(requested, budget_s, int(max_records), cancelled)
    search.not_searched = list(not_searched)
    if not_searched:
        search.complete = False
    datasets = _datasets(state, dataset_ids)
    if not requested:
        return _result(search, scope, datasets)

    # Remembered reads first: instant, whatever the scope.
    for dataset in datasets:
        for path in dataset.paths or []:
            for query_name, name in search.wanted.items():
                if name not in search.remaining:
                    continue
                cached = _cache_get(path, search.version(path), query_name)
                if cached is not None:
                    search.record(name, {
                        **cached,
                        "dataset_id": getattr(dataset, "id", None),
                        "chrom": _state_chrom(state, cached["contig"], dataset),
                    })

    for dataset in datasets:
        for path in dataset.paths or []:
            if search.done() or search.out_of_budget():
                break
            try:
                intervals = _intervals(scope, dataset, path, chrom, start, end)
            except Exception as err:  # noqa: BLE001 - unreadable: reported, the search incomplete
                search.failed(dataset, path, _error_text(err))
                continue
            if dataset.data_type == "bam":
                _scan_bam(search, state, dataset, path, intervals)
            else:
                _scan_bigbed(search, state, dataset, path, intervals)
    return _result(search, scope, datasets)


def _result(search: _Search, scope: str, datasets) -> dict:
    found = []
    for name in search.names:
        hit = search.found.get(name) or search.fallback.get(name)
        if hit is not None:
            entry = {k: v for k, v in hit.items() if k != "contig"}
            found.append({"name": name, **entry, "supplementary": name not in search.found})
    found_names = {f["name"] for f in found}
    return {
        "scope": scope,
        "found": found,
        "not_found": [n for n in search.names if n not in found_names],
        # Over MAX_NAMES: not looked for at all (send them in another request).
        "not_searched": list(search.not_searched),
        "max_names": MAX_NAMES,
        "complete": search.complete,
        "scanned": search.scanned,
        "datasets": [getattr(d, "id", None) for d in datasets],
        # Files that could not be read: their reads were not looked at.
        "errors": [
            {"dataset_id": dataset_id, "path": path, "error": why}
            for (dataset_id, path), why in search.errors.items()
        ],
    }
