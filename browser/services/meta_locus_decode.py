"""Meta-locus: decode chosen pool entries by their stored file position, onto the virtual locus.

The pool index (services/meta_locus_pool) stores each entry's BGZF virtual offset, so a working set never re-scans
the BAM: each record is read by a seek (its name verified, a few records scanned forward if the iterator had skipped
one, else a fetch at the read's start), then FiberBrowser's own BAM loader parses the records, exactly as for any
view (``build_compact_reads_from_bam`` with a handle whose fetch yields just these records), with the display's read
filters. One loader call covers many nearby sites (a batch); each read is then clipped to its own site window.

Each read is parsed whole (the loader's region covers the read), then clipped: a read decodes the same whatever
batch or worker it lands in, and layers the loader infers from neighbouring calls (MSPs between nucleosomes) use the
whole read, as a view containing the read would show them.

A read in the answer is a compact read (the /api/reads/compact format) in its window's coordinates ``[0, 2*flank)``,
mirrored for minus-strand sites, so window coordinate x is virtual coordinate ``x - flank`` on every site, plus
``meta``: its provenance (dataset, site, site name and real window, anchor, strand, real read extent, key, rank).
Fields that cannot be placed on the virtual locus (CIGAR events, sequence, SV segments, terminal-gap internals) are
dropped; ``reference_start`` / ``reference_end`` / ``aligned_blocks`` stay real (provenance).
"""
from __future__ import annotations

from typing import Callable, Optional

import numpy as np

from services.meta_locus_pool import DatasetIndex, Sites

DECODE_DEFAULTS = {
    "batch_span_bp": 2_000_000,  # one loader call covers sites within this span
    "batch_reads": 2_000,
    "max_forward": 64,           # records scanned after a stored offset before falling back to a fetch
    "workers": 0,                # decode worker processes (0: automatic, 1: decode in this process)
    "parallel_min_reads": 400,   # fewer reads than this decode in this process (worker hand-off costs more)
    "chunks_per_worker": 2,
}
WORKERS_ENV = "FIBERBROWSER_META_LOCUS_WORKERS"
MAX_WORKERS = 8
# Region-relative fields the clipper cannot place on the virtual locus: dropped from the answer.
_DROP = ("cigar", "sv", "sv_segments", "_fiberbrowser_terminal_gaps", "_fiberbrowser_sequence", "_fiberbrowser_sequence_lead",
         "_fiberbrowser_md", "_fiberbrowser_call_bounds", "_fiberbrowser_source_order", "sequence_span", "lift")
_POSITION_LISTS = ("methyl", "methyl_m6a", "methyl_m5c", "possible_deam_ga", "possible_deam_ct")
_EDGE_PAIRS = (("lq", "rq"), ("el", "er"))


class _Header(dict):
    """A BAM header as a dict, coerced once per batch (the loader reads it several times per call)."""

    def to_dict(self):
        return dict(self)


class _RecordsHandle:
    """A BAM handle whose fetch yields given records (the loader's ``bam_handle_getter``)."""

    def __init__(self, bam, records, header):
        self._bam = bam
        self._records = records
        self.header = header

    def fetch(self, *args, **kwargs):
        return iter(self._records)

    def __getattr__(self, name):
        return getattr(self._bam, name)


def seek_records(handles: list, resolved: list, index: DatasetIndex, sites: Sites, entries: list, *,
                 max_forward: int = 64, stats: Optional[dict] = None) -> dict:
    """{entry: pysam record}, read by stored virtual offset (in file order), verified by name."""
    st = stats if stats is not None else {}
    for k in ("exact", "forward", "fallback", "undecodable"):
        st.setdefault(k, 0)
    out = {}
    by_file: dict = {}
    for e in entries:
        by_file.setdefault(int(index.file[index.mol[e]]), []).append(e)
    for fi, ents in by_file.items():
        h = handles[fi]
        done: dict = {}
        for e in sorted(ents, key=lambda x: int(index.voff[index.mol[x]])):
            m = int(index.mol[e])
            if m in done:  # the molecule's record, already read for another of its sites
                if done[m] is not None:
                    out[e] = done[m]
                else:
                    st["undecodable"] += 1
                continue
            name, rec = index.names[m], None
            off = int(index.voff[m])
            if off >= 0:
                h.seek(off)
                for step in range(max_forward + 1):
                    try:
                        r = next(h)
                    except StopIteration:
                        break
                    if r.query_name == name and not r.is_secondary and not r.is_unmapped:
                        rec = r
                        st["exact" if step == 0 else "forward"] += 1
                        break
            if rec is None:
                actual = resolved[fi].get(sites.chrom[int(index.site[e])])
                if actual is not None:
                    s0 = int(index.start[m])
                    for r in h.fetch(actual, s0, s0 + 1):
                        if r.query_name == name and not r.is_secondary and not r.is_unmapped:
                            rec = r
                            st["fallback"] += 1
                            break
            done[m] = rec
            if rec is None:
                st["undecodable"] += 1
                continue
            out[e] = rec
    return out


def _clip_ivs(ivs, shift: int, width: int):
    kept, idx = [], []
    for i, iv in enumerate(ivs or []):
        a, b = int(iv[0]) + shift, int(iv[1]) + shift
        if b <= 0 or a >= width:
            continue
        kept.append([max(a, 0), min(b, width), *iv[2:]])
        idx.append(i)
    return kept, idx


def clip_compact_read(read: dict, shift: int, width: int) -> Optional[dict]:
    """A compact read moved by ``shift`` and clipped to ``[0, width)`` (sizes stay the full feature sizes, as the
    loader writes them at a view edge); None when nothing is left."""
    out = {k: v for k, v in read.items() if k not in _DROP}
    ivs, idx = _clip_ivs(read.get("intervals"), shift, width)
    if not ivs:
        return None
    out["intervals"] = ivs
    if read.get("qualities") is not None:
        # One quality per footprint (positive size), in interval order.
        fp_order = [i for i, iv in enumerate(read.get("intervals") or []) if len(iv) > 2 and iv[2] is not None and iv[2] > 0]
        keep = set(idx)
        q = read["qualities"]
        kept_q = [q[n] for n, i in enumerate(fp_order) if i in keep and n < len(q)]
        if kept_q:
            out["qualities"] = kept_q
        else:
            out.pop("qualities", None)  # the loader writes none without a footprint in the view
    if read.get("layers"):
        layers = {}
        for name, layer in read["layers"].items():
            if not isinstance(layer, dict):
                layers[name] = layer
                continue
            lv, li = _clip_ivs(layer.get("intervals"), shift, width)
            if layer.get("intervals") and not lv:
                continue  # the loader leaves out a layer with nothing in the view
            nl = dict(layer, intervals=lv)
            if layer.get("qualities") is not None:
                nl["qualities"] = [[col[i] for i in li if i < len(col)] if isinstance(col, list) else col for col in layer["qualities"]]
            layers[name] = nl
        out["layers"] = layers
    if read.get("fire") is not None:
        fire = _clip_ivs(read["fire"], shift, width)[0]
        if fire or not read["fire"]:
            out["fire"] = fire
        else:
            out.pop("fire", None)  # the loader writes none without a FIRE element in the view
    if read.get("deam") is not None:
        out["deam"] = [[int(p[0]) + shift, *p[1:]] for p in read["deam"] if 0 <= int(p[0]) + shift < width]
    for key in _POSITION_LISTS:
        if read.get(key) is not None:
            out[key] = [int(p) + shift for p in read[key] if 0 <= int(p) + shift < width]
    return out


def _mirror_ivs(ivs, width: int):
    return [[width - int(iv[1]), width - int(iv[0]), *iv[2:]] for iv in reversed(ivs or [])]


def mirror_compact_read(read: dict, width: int) -> dict:
    """A window-relative compact read flipped end to end (minus-strand site): [a, b) -> [width - b, width - a),
    position p -> width - 1 - p; per-interval arrays reversed with their intervals."""
    out = dict(read)
    out["intervals"] = _mirror_ivs(read.get("intervals"), width)
    if read.get("qualities") is not None:
        out["qualities"] = list(reversed(read["qualities"]))
    if read.get("layers"):
        layers = {}
        for name, layer in read["layers"].items():
            if not isinstance(layer, dict):
                layers[name] = layer
                continue
            nl = dict(layer, intervals=_mirror_ivs(layer.get("intervals"), width))
            if layer.get("qualities") is not None:
                cols = [list(reversed(col)) if isinstance(col, list) else col for col in layer["qualities"]]
                names = list(layer.get("quality_names") or [])
                # Edge qualities change sides with the flip (the left edge becomes the right edge).
                for left, right in _EDGE_PAIRS:
                    if left in names and right in names and max(names.index(left), names.index(right)) < len(cols):
                        i, j = names.index(left), names.index(right)
                        cols[i], cols[j] = cols[j], cols[i]
                nl["qualities"] = cols
            layers[name] = nl
        out["layers"] = layers
    if read.get("fire") is not None:
        out["fire"] = _mirror_ivs(read["fire"], width)
    if read.get("deam") is not None:
        out["deam"] = [[width - 1 - int(p[0]), *p[1:]] for p in reversed(read["deam"])]
    for key in _POSITION_LISTS:
        if read.get(key) is not None:
            out[key] = [width - 1 - int(p) for p in reversed(read[key])]
    out["strand_flipped"] = True
    return out


def _batches(entries: list, index: DatasetIndex, sites: Sites, span: int, max_reads: int) -> list:
    """Entries grouped by contig into batches of nearby sites."""
    order = sorted(entries, key=lambda e: (sites.chrom[int(index.site[e])], int(sites.win_start[int(index.site[e])])))
    out, cur = [], []
    for e in order:
        s = int(index.site[e])
        if cur:
            s0 = int(index.site[cur[0]])
            if (sites.chrom[s] != sites.chrom[s0] or int(sites.win_end[s]) - int(sites.win_start[s0]) > span
                    or len(cur) >= max_reads):
                out.append(cur)
                cur = []
        cur.append(e)
    if cur:
        out.append(cur)
    return out


def decode_entries(paths: list, index: DatasetIndex, sites: Sites, entries: list, *, loader_options: dict,
                   chrom_map: Optional[dict] = None, options: Optional[dict] = None, stats: Optional[dict] = None,
                   cancelled: Optional[Callable[[], bool]] = None) -> dict:
    """{entry: virtual compact read} for the chosen entries of one dataset. Entries the read filters remove are
    absent (``stats["filtered"]``), as are records that could not be found (``stats["undecodable"]``)."""
    import pysam
    from services.compact_read_loader import build_compact_reads_from_bam
    from services.signal_windows import signal_window_sink
    from utils.chrom import resolve_reference_name

    opts = {**DECODE_DEFAULTS, **(options or {})}
    st = stats if stats is not None else {}
    st.setdefault("filtered", 0)
    width = 2 * sites.flank
    out: dict = {}
    if not entries:
        return out
    handles = [pysam.AlignmentFile(str(p), "rb") for p in paths]
    # Batches are partial fetches: they must never publish per-window signal counts as if complete.
    sink = signal_window_sink.set(lambda _window: None)
    try:
        contigs = sorted({sites.chrom[int(index.site[e])] for e in entries})
        resolved = [{c: resolve_reference_name(c, h.references, chrom_map or {}) for c in contigs} for h in handles]
        headers = [_Header(h.header.to_dict()) for h in handles]
        records = seek_records(handles, resolved, index, sites, entries, max_forward=int(opts["max_forward"]), stats=st)
        for batch in _batches([e for e in entries if e in records], index, sites, int(opts["batch_span_bp"]), int(opts["batch_reads"])):
            if cancelled and cancelled():
                break
            s_first = int(index.site[batch[0]])
            chrom = sites.chrom[s_first]
            # The loader sees every read whole (the region covers all of the batch's records), so a read decodes the
            # same in any batch: layers inferred at a window edge (an MSP between two nucleosomes, one outside the
            # window) use the read's full context, as a view containing the whole read would, never the batch's.
            recs_here = [records[e] for e in batch]
            r0 = min(min(r.reference_start for r in recs_here), min(int(sites.win_start[int(index.site[e])]) for e in batch))
            r1 = max(max(r.reference_end or r.reference_start + 1 for r in recs_here),
                     max(int(sites.win_end[int(index.site[e])]) for e in batch))
            by_file: dict = {}
            seen = set()
            for e in batch:
                key = (int(index.file[index.mol[e]]), index.names[index.mol[e]])
                if key not in seen:
                    seen.add(key)
                    by_file.setdefault(int(index.file[index.mol[e]]), []).append(records[e])
            decoded: dict = {}
            for fi, recs in by_file.items():
                actual = resolved[fi].get(chrom)
                if actual is None:
                    continue
                recs.sort(key=lambda r: (r.reference_start, r.query_name))
                handle = _RecordsHandle(handles[fi], recs, headers[fi])
                rows = build_compact_reads_from_bam(str(paths[fi]), actual, r0, r1, spanning_only=False,
                                                    bam_handle_getter=lambda _p, h=handle: h, chrom_map=chrom_map,
                                                    **loader_options)
                rows = rows[0] if isinstance(rows, tuple) else rows
                for row in rows:
                    decoded.setdefault((fi, str(row.get("id"))), row)
            for e in batch:
                row = decoded.get((int(index.file[index.mol[e]]), index.names[index.mol[e]]))
                if row is None:
                    st["filtered"] += 1
                    continue
                s = int(index.site[e])
                # Projected from the window's logical origin (the fetch start may be clamped at the contig start).
                clipped = clip_compact_read(row, r0 - int(sites.origin[s]), width)
                if clipped is None:
                    st["filtered"] += 1
                    continue
                if sites.minus[s]:
                    clipped = mirror_compact_read(clipped, width)
                out[e] = clipped
    finally:
        signal_window_sink.reset(sink)
        for h in handles:
            h.close()
    return out


# ----------------------------------------------------------------------------------------------------- worker processes
#
# Decoding is CPU-bound in FiberBrowser's own record parser (MA / AQ layers, CIGAR mapping), so a working set is split
# into chunks of nearby sites decoded on a persistent pool of spawned worker processes, each seeking the records by
# their stored offsets itself. The answer is keyed by pool entry, so the order the client sees is the rank order
# whatever chunk finished first.

import os
import threading

_pool = None
_pool_size = 0
_pool_lock = threading.Lock()


def default_workers() -> int:
    try:
        env = int(os.environ.get(WORKERS_ENV, "0"))
    except ValueError:
        env = 0
    if env > 0:
        return min(MAX_WORKERS, env)
    return max(1, min(6, (os.cpu_count() or 2) - 2))


def _init_worker() -> None:
    from services.worker_watchdog import watch_parent
    watch_parent()  # exit with the server, never linger as an orphan
    import services.compact_read_loader  # noqa: F401 - imported once per worker, not per chunk


def _noop() -> int:
    return os.getpid()


def worker_pool(workers: int):
    """The shared decode pool with ``workers`` processes (created, or recreated at another size, on demand)."""
    global _pool, _pool_size
    import multiprocessing
    from concurrent.futures import ProcessPoolExecutor
    with _pool_lock:
        if _pool is None or _pool_size != workers:
            if _pool is not None:
                _pool.shutdown(wait=False, cancel_futures=True)
            _pool = ProcessPoolExecutor(max_workers=workers, mp_context=multiprocessing.get_context("spawn"),
                                        initializer=_init_worker)
            _pool_size = workers
        return _pool


def warm_workers(workers: Optional[int] = None) -> None:
    """Start the worker processes ahead of the first working set (spawning and importing take about a second)."""
    n = workers or default_workers()
    if n <= 1:
        return
    pool = worker_pool(n)
    for _ in range(n):
        pool.submit(_noop)


def shutdown_workers(wait: bool = False) -> None:
    """Close the decode pool; ``wait`` joins its worker processes before returning (tests that check for
    leftover children rely on this)."""
    global _pool, _pool_size
    with _pool_lock:
        pool = _pool
        _pool, _pool_size = None, 0
    if pool is not None:
        pool.shutdown(wait=wait, cancel_futures=True)


def _decode_chunk(paths, dataset_id, names, site, start, file, voff, sites_payload, loader_options, chrom_map, options,
                  signal_filters=None):
    """Worker side: decode a chunk given as a small self-contained index (local entries 0..n-1, local sites).
    ``signal_filters``: the request's signal predicate (a worker process has none of the request's context)."""
    from services.signal_evidence import signal_filters_for_request
    with signal_filters_for_request(signal_filters):
        return _decode_chunk_here(paths, dataset_id, names, site, start, file, voff, sites_payload, loader_options,
                                  chrom_map, options)


def _decode_chunk_here(paths, dataset_id, names, site, start, file, voff, sites_payload, loader_options, chrom_map, options):
    n = len(names)
    # One molecule per local entry (a molecule shared by two sites of the chunk is simply read twice).
    index = DatasetIndex(dataset_id, np.asarray(site, np.uint32), np.arange(n, dtype=np.uint32), list(names),
                         np.asarray(start, np.int64), np.asarray(start, np.int64), np.asarray(file, np.uint8),
                         np.asarray(voff, np.int64))
    sites = Sites(**sites_payload)
    stats: dict = {}
    rows = decode_entries(paths, index, sites, list(range(n)), loader_options=loader_options, chrom_map=chrom_map,
                          options={**(options or {}), "workers": 1}, stats=stats)
    return rows, stats


def decode_entries_parallel(paths: list, index: DatasetIndex, sites: Sites, entries: list, *, loader_options: dict,
                            chrom_map: Optional[dict] = None, options: Optional[dict] = None, stats: Optional[dict] = None,
                            cancelled: Optional[Callable[[], bool]] = None) -> dict:
    """``decode_entries`` over worker processes (see above); small requests and ``workers`` 1 stay in this process."""
    opts = {**DECODE_DEFAULTS, **(options or {})}
    workers = int(opts["workers"]) or default_workers()
    workers = max(1, min(MAX_WORKERS, workers))
    st = stats if stats is not None else {}
    if workers <= 1 or len(entries) < int(opts["parallel_min_reads"]):
        return decode_entries(paths, index, sites, entries, loader_options=loader_options, chrom_map=chrom_map,
                              options=opts, stats=st, cancelled=cancelled)
    from services.signal_evidence import active_signal_filters
    signal_filters = active_signal_filters()
    ordered = sorted(entries, key=lambda e: (sites.chrom[int(index.site[e])], int(sites.win_start[int(index.site[e])]), e))
    n_chunks = min(len(ordered), workers * max(1, int(opts["chunks_per_worker"])))
    size = -(-len(ordered) // n_chunks)
    pool = worker_pool(workers)
    futures = []
    for c in range(0, len(ordered), size):
        chunk = ordered[c:c + size]
        local_sites = sorted({int(index.site[e]) for e in chunk})
        local = {s: i for i, s in enumerate(local_sites)}
        payload = {"chrom": [sites.chrom[s] for s in local_sites], "win_start": sites.win_start[local_sites],
                   "win_end": sites.win_end[local_sites], "anchor": sites.anchor[local_sites],
                   "minus": sites.minus[local_sites], "name": [sites.name[s] for s in local_sites], "flank": sites.flank,
                   "origin": sites.origin[local_sites]}
        futures.append((chunk, pool.submit(
            _decode_chunk, list(paths), index.dataset_id, [index.names[index.mol[e]] for e in chunk],
            [local[int(index.site[e])] for e in chunk], [int(index.start[index.mol[e]]) for e in chunk],
            [int(index.file[index.mol[e]]) for e in chunk], [int(index.voff[index.mol[e]]) for e in chunk], payload, loader_options,
            chrom_map, {k: v for k, v in opts.items() if k in ("batch_span_bp", "batch_reads", "max_forward")}, signal_filters)))
    out: dict = {}
    for chunk, future in futures:
        if cancelled and cancelled():
            for _c, f in futures:
                f.cancel()
            break
        rows, chunk_stats = future.result()
        for local_i, row in rows.items():
            out[chunk[local_i]] = row
        for k, v in chunk_stats.items():
            st[k] = st.get(k, 0) + v
    return out


def virtualize_read(read: dict, sites: Sites, site: int) -> dict:
    """A window-relative read (decode_entries) with its absolute fields on the virtual contig, so it has exactly the
    shape of an ordinary compact read in a view of ``meta:<pool>`` at ``[0, 2*flank)``: ``reference_start`` /
    ``reference_end`` / ``aligned_blocks`` become window coordinates (minus-strand sites mirrored, half-open kept) and
    ``alignment_orientation`` flips on minus-strand sites. The axis shows ``x - flank`` (anchor = 0); internal
    coordinates stay non-negative like any contig's. The real values go to ``meta["real"]`` (provenance)."""
    ws = int(sites.origin[site])  # the logical window start (unclamped): the anchor is virtual flank on every site
    width = 2 * sites.flank
    minus = bool(sites.minus[site])

    def span(a, b):
        a, b = int(a) - ws, int(b) - ws
        return (width - b, width - a) if minus else (a, b)

    real = {k: read.get(k) for k in ("reference_start", "reference_end", "aligned_blocks", "alignment_orientation") if k in read}
    real["chrom"] = sites.chrom[site]
    out = dict(read)
    if read.get("reference_start") is not None and read.get("reference_end") is not None:
        out["reference_start"], out["reference_end"] = span(read["reference_start"], read["reference_end"])
    if read.get("aligned_blocks"):
        blocks = [list(span(a, b)) for a, b in read["aligned_blocks"]]
        out["aligned_blocks"] = list(reversed(blocks)) if minus else blocks
    if minus and read.get("alignment_orientation") in ("forward", "reverse"):
        out["alignment_orientation"] = "reverse" if read["alignment_orientation"] == "forward" else "forward"
    out.setdefault("meta", {})["real"] = real
    return out
