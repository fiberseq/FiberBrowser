"""Live nucleosome outputs for a region's records, from the complete source records.

``record_outputs`` adapts the public ``fiberhmm.nuc.record_outputs`` tuple to the browser store.
The decoded molecule and result are retained for window metrics and phasing without recomputing them.

Records come from ``fiberhmm.scan.reads.iter_records`` (the scan's own iterator: read filters, SHA-256 and
occurrence), over

- a native dataset's view;
- a live-lift dataset's source windows for the view (the lift plan the lifted rows are composed from);
- an explicit source region (a graph path's span in a live-lift dataset's own coordinates).
"""
from __future__ import annotations

import threading
import json
from collections import OrderedDict
from typing import Callable, Dict, Iterable, List, NamedTuple, Optional, Sequence, Tuple

from .calibration import CalibrationRef
from .inputs import NucSource
from .store import STORE, RecordOutputs

_ctx_lock = threading.Lock()
_contexts: Dict[tuple, object] = {}
_view_lock = threading.RLock()
_views = OrderedDict()
MAX_VIEW_RECORDS = 60_000


def _decode_context(path: str, header, params, params_key: str):
    """FiberHMM's DecodeContext for a file (its header decides frames and observation mode)."""
    from fiberhmm.nuc.records import DecodeContext
    key = (path, params_key)
    with _ctx_lock:
        ctx = _contexts.get(key)
        if ctx is None:
            if len(_contexts) > 64:
                _contexts.clear()
            ctx = DecodeContext(header, params)
            _contexts[key] = ctx
        return ctx


def _accepts_calibration_digest() -> bool:
    """Whether the installed FiberHMM's ``record_outputs`` takes a precomputed ``calibration_digest``."""
    global _DIGEST_KW
    if _DIGEST_KW is None:
        import inspect
        from fiberhmm.nuc import record_outputs as nuc_record_outputs
        _DIGEST_KW = 'calibration_digest' in inspect.signature(nuc_record_outputs).parameters
    return _DIGEST_KW


_DIGEST_KW = None


def record_outputs(read, input_index: int, ctx, params, cal, regularity=None, *,
                   calibration_digest: Optional[str] = None) -> Tuple[Optional[RecordOutputs], object, object, str]:
    """(outputs, molecule, result, reason) of one stored record; outputs is None when FiberHMM can't decode it.

    ``regularity`` (``fiberhmm.nuc.regularity.RegularityParams``; None, the browser's use: off) adds ``nucreg``
    tiles. The browser computes tiles on demand instead (``services.nuc.regularity``), so a Compute never pays for
    them; the regularity parameters never enter the settings hash, the calibration or the store's configuration.
    ``calibration_digest``: ``cal.digest()``, computed once by the caller (serializing the calibration for every
    record is costly); used when the installed FiberHMM accepts it."""
    from .scalars import record_without_calls, has_non_array_tag_pair, without_non_array_tag_pairs
    if has_non_array_tag_pair(read):
        if record_without_calls(read):
            # FiberHMM's legacy decode would iterate a string or scalar ns/nl (as/al) pair: the browser's array-pair
            # rule already says the record has no calls. FiberHMM's own order otherwise (a marked chimera first).
            from fiberhmm.inference.chimeras import is_marked_chimera
            return None, None, None, 'chimera' if is_marked_chimera(read) else 'no_calls'
        # A valid array pair beside a string or scalar one: decode a copy without the invalid pair (not calls by the
        # array-pair rule), so FiberHMM never iterates it.
        read = without_non_array_tag_pairs(read)
    from fiberhmm.nuc import record_outputs as nuc_record_outputs
    from fiberhmm.nuc.tags import encode_nucmol
    from fiberhmm.scan.types import RecordRef
    record = RecordRef('', int(input_index), str(read.query_name), '', 0, str(read.reference_name),
                       int(read.reference_start), int(read.reference_end or read.reference_start))
    # Regularity is off here: a Compute never pays for it (services/nuc/regularity.py computes tiles on demand).
    extra = {'calibration_digest': calibration_digest} if calibration_digest and _accepts_calibration_digest() else {}
    mol, res, scan = nuc_record_outputs(read, record, cal, params=params, context=ctx, regularity=regularity, **extra)
    if mol is None:
        from fiberhmm.nuc.records import decode_record
        _mol, reason = decode_record(read, ctx)
        return None, None, None, reason
    groups: Dict[str, list] = {'nucsz': [], 'nucseg': [], 'nucreg': []}
    for mark in scan.marks:
        groups.setdefault(mark.group, []).append((*mark.mol, mark.start, mark.end, mark.q, mark.name))
    # The nucmol group's bytes (tags.group_rows builds the same row; the other groups are already in scan.marks).
    nucmol = [int(x) for x in encode_nucmol(res.scalars, res.flags, res.digest)]
    scalars = scan.scalars
    out = RecordOutputs(
        qname=str(read.query_name), input_index=int(input_index), chrom=str(read.reference_name),
        ref_start=int(read.reference_start), ref_end=int(read.reference_end or read.reference_start),
        reverse=bool(read.is_reverse), supplementary=bool(read.is_supplementary),
        hp=int(read.get_tag('HP')) if read.has_tag('HP') else None, groups=groups, nucmol=nucmol, scalars=scalars,
        source='live', low_information=bool(res.flags.get('low_information')),
        regularity_digest=regularity.digest()[:8] if regularity is not None else '')
    return out, mol, res, 'ok'


def bam_chrom(references, chrom: str) -> Optional[str]:
    """A contig name as a BAM's header spells it (chr1 / 1 aliases), or None when the BAM has no such contig."""
    if chrom in references:
        return chrom
    from utils.chrom import normalize_chrom_name
    want = normalize_chrom_name(chrom)
    for name in references:
        if normalize_chrom_name(name) == want:
            return name
    return None


_HEADER_REFS: "OrderedDict[tuple, Tuple[str, ...]]" = OrderedDict()
_header_lock = threading.Lock()


def header_references(path: str) -> Tuple[str, ...]:
    """A BAM's contig names (its header), kept per file identity (path, size, mtime): a lookup that only needs the
    header's spelling of a contig opens the file once, not on every request."""
    import os
    import pysam
    st = os.stat(path)
    key = (path, st.st_size, st.st_mtime_ns)
    with _header_lock:
        hit = _HEADER_REFS.get(key)
        if hit is not None:
            _HEADER_REFS.move_to_end(key)
            return hit
    with pysam.AlignmentFile(path, 'rb', check_sq=False) as bam:
        refs = tuple(bam.references)
    with _header_lock:
        _HEADER_REFS[key] = refs
        while len(_HEADER_REFS) > 256:
            _HEADER_REFS.popitem(last=False)
    return refs


def _params_key(settings: dict) -> str:
    import json
    return json.dumps(settings.get('params') or {}, sort_keys=True)


class _Counter:
    def __init__(self):
        self.records = 0
        self.computed = 0
        self.cached = 0
        self.undecodable: Dict[str, int] = {}
        self.without_calls = 0

    def failed(self, why):
        if why == 'no_calls':
            self.records -= 1
            self.without_calls += 1
        else:
            self.undecodable[why] = self.undecodable.get(why, 0) + 1


def compute_regions(source: NucSource, regions: Sequence[Tuple[str, int, int]], settings: dict, cals,
                    policy: dict, *, progress: Optional[Callable[[int, int], None]] = None, cancel=None,
                    keep_results: bool = True, regularity=None, pool=None) -> dict:
    """Compute and store outputs for every record (passing ``policy``'s filters) overlapping ``regions`` of the
    dataset's files (in the files' own coordinates). ``cals``: a CalibrationRef, or one per real path. Records
    already stored for this configuration are kept.

    ``pool`` (``compute_pool.ComputePool``) computes the records on worker processes; the server process still
    reads every record (counts, cache checks, the view's geometry) and stores the outputs in record order, so
    the store and the returned counts are those of the serial compute."""
    import pysam
    from .compute_pool import slim_molecule
    from .engine import nuc_params
    params = nuc_params(settings)
    pkey = _params_key(settings)
    if isinstance(cals, CalibrationRef):
        cals = {p: cals for p in source.paths}
    n = _Counter()
    for path in source.paths:
        STORE.configure(path, (cals[path].settings_hash, cals[path].digest))
    regions = _merge(regions)
    total_bp = sum(b - a for _c, a, b in regions) or 1
    done_bp = 0
    if pool is not None and getattr(pool, 'workers', 1) <= 1:
        pool = None
    for i, path in enumerate(source.paths):
        config = (cals[path].settings_hash, cals[path].digest)
        calibration = cals[path].calibration
        # One serialization of the calibration per compute, not one per record.
        cal_digest = calibration.digest()
        with pysam.AlignmentFile(path, 'rb') as bam:
            refs = list(bam.references)
            ctx = _decode_context(path, bam.header, params, pkey) if pool is None else None
            for chrom, start, end in regions:
                chrom = bam_chrom(refs, chrom)
                if chrom is None:
                    continue
                batch = []

                def store(key, out, mol, res, why):
                    nonlocal batch
                    if out is None:
                        n.failed(why)
                        STORE.put_failed(path, config, [(key, why)])
                        return
                    n.computed += 1
                    batch.append((key, out))
                    if keep_results:
                        mol.meta['dataset_id'] = source.browser_id
                        STORE.put_result(path, key[0], key[1], config, slim_molecule(mol), res)
                    if len(batch) >= 64:
                        STORE.put(path, config, batch)
                        batch = []
                        if progress is not None:
                            progress(n.records, n.computed)

                todo = []
                for k, (read, sha, occ) in enumerate(iter_view_records(source, bam, chrom, int(start), int(end), policy)):
                    if cancel is not None and cancel.is_set():
                        raise InterruptedError('cancelled')
                    n.records += 1
                    if STORE.has(path, sha, occ) and (not keep_results or STORE.get_result(path, sha, occ, config)):
                        n.cached += 1
                        continue
                    if STORE.failed(path, sha, occ) is not None:
                        why = STORE.failed(path, sha, occ)
                        n.failed(why)
                        continue
                    if pool is not None:
                        todo.append((k, (sha, occ)))
                        continue
                    out, mol, res, why = record_outputs(read, i, ctx, params, calibration, regularity,
                                                        calibration_digest=cal_digest)
                    store((sha, occ), out, mol, res, why)
                if todo:
                    keys = dict(todo)
                    base = dict(path=path, chrom=chrom, start=int(start), end=int(end), filters=policy['filters'],
                                input_index=i, params=params, params_key=pkey, calibration=calibration,
                                calibration_digest=cal_digest, regularity=regularity, keep_results=keep_results)
                    pool.run(base, todo, cancel=cancel,
                             on_result=lambda k, out, mol, res, why: store(keys[k], out, mol, res, why))
                STORE.put(path, config, batch)
                STORE.mark_region(path, config, chrom, int(start), int(end))
                done_bp += end - start
                if progress is not None:
                    progress(n.records, n.computed)
    return dict(records=n.records, computed=n.computed, cached=n.cached, undecodable=n.undecodable,
                withoutCalls=n.without_calls,
                regions=[list(r) for r in regions], fraction=min(1.0, done_bp / total_bp / max(1, len(source.paths))))


def _merge(regions: Iterable[Tuple[str, int, int]]) -> List[Tuple[str, int, int]]:
    by: Dict[str, List[List[int]]] = {}
    for c, a, b in regions:
        if int(b) > int(a):
            by.setdefault(str(c), []).append([int(a), int(b)])
    out = []
    for c, ivs in by.items():
        ivs.sort()
        merged: List[List[int]] = []
        for a, b in ivs:
            if merged and a <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([a, b])
        out += [(c, a, b) for a, b in merged]
    return out


def source_regions(state, source: NucSource, chrom: str, start: int, end: int) -> List[Tuple[str, int, int]]:
    """The regions of the dataset's files a view needs: the view itself (native), or the source windows of the
    lift plan its lifted rows come from (live lift)."""
    if source.kind == 'native':
        return [(chrom, int(start), int(end))]
    ds = state.datasets[source.browser_id]
    config = ds.live_lift
    from services.lift.live_lift import lift_key, plan_fetch, select_pieces
    handle = config.handle
    if chrom not in handle.map.targets:
        return []
    haps = handle.resolve_haplotypes(config.haplotypes)
    key = lift_key(handle, haps, config.settings)
    selection = select_pieces(handle, chrom, int(start), int(end), haplotypes=haps, settings=config.settings, key=key)
    plan = plan_fetch(selection, config.settings, fetch_range=(int(start), int(end)))
    regions = [(c.contig, int(a), int(b)) for c in plan.contigs for a, b in c.windows]
    # A graph path's span is each source contig's lift-piece hull over the view (an insertion between pieces is on
    # the path, services/nuc/observations.py): computed too, so a graph column's molecules all have outputs.
    from .observations import source_windows
    hulls: Dict[str, List[int]] = {}
    for c, a, b in source_windows(state, source, chrom, int(start), int(end)):
        h = hulls.setdefault(c, [a, b])
        h[0], h[1] = min(h[0], a), max(h[1], b)
    return regions + [(c, a, b) for c, (a, b) in hulls.items()]


class Rec(NamedTuple):
    """One source record of an observation."""
    path: str
    sha: str
    occ: int
    qname: str
    strand: Optional[str]            # the record's DAF strand call (st:Z), None without one
    supplementary: bool
    molwins: Tuple[Tuple[int, int], ...]   # per window of the request: its molecular span on this record, or (-1, -1)
    molecule: Optional[str] = None   # a lifted row's provenance-qualified molecule key (live_lift.molecule)
    blocks: Tuple[Tuple[int, int], ...] = ()   # the record's aligned reference blocks (deletions and skips excluded)
    without_calls: bool = False     # independent of whether analysis has run


class _Geometry(NamedTuple):
    """The alignment fields mol_window needs, without retaining BAM records or their large tags."""
    rec: Rec
    reference_start: int
    reference_end: int
    query_length: int
    is_reverse: bool
    mblocks: object                  # (k, 3) int64: query start, reference start, length of each M/=/X op
    reference_name: str
    references: tuple


def _aligned_ops(reference_start: int, cigartuples) -> "np.ndarray":
    """(query start, reference start, length) of every aligned (M = X) CIGAR op, as mol_window walks them."""
    import numpy as np
    out = []
    q, r = 0, int(reference_start)
    for op, n in cigartuples or ():
        if op in (0, 7, 8):
            out.append((q, r, n))
            q += n
            r += n
        elif op in (1, 4):
            q += n
        elif op in (2, 3):
            r += n
    return np.array(out, dtype=np.int64).reshape(-1, 3)


def _geometry_window(g: _Geometry, start: int, end: int) -> Tuple[int, int]:
    """``mol_window`` of a remembered record (its aligned ops as arrays): the same spans, without a CIGAR walk."""
    import numpy as np
    m = g.mblocks
    if not len(m):
        return (-1, -1)
    q, r, n = m[:, 0], m[:, 1], m[:, 2]
    a = np.maximum(r, start)
    b = np.minimum(r + n, end)
    ok = b > a
    if not ok.any():
        return (-1, -1)
    qlo = int((q + (a - r))[ok].min())
    qhi = int((q + (b - r))[ok].max())
    if g.is_reverse:
        L = int(g.query_length or 0)
        return (L - qhi, L - qlo)
    return (qlo, qhi)


def _view_key(source, policy):
    from services.background_work import file_identity
    return (source.paths, file_identity(source.paths), json.dumps(policy['filters'], sort_keys=True))


def _remember_view(key, chrom, start, end, geometries):
    if len(geometries) <= MAX_VIEW_RECORDS:
        with _view_lock:
            _views[(key, chrom, start, end)] = geometries
            while len(_views) > 16 or sum(len(v) for v in _views.values()) > MAX_VIEW_RECORDS:
                _views.popitem(last=False)


def _geometry(path, read, sha, occ, references, molwins=()):
    from services.read_strand import record_strand_fields
    from .scalars import record_without_calls
    strand = record_strand_fields(read).get('strand')
    rec = Rec(path, sha, occ, str(read.query_name), strand if strand in ('CT', 'GA') else None,
              bool(read.is_supplementary), molwins, None,
              tuple((int(a), int(b)) for a, b in read.get_blocks()), record_without_calls(read))
    return _Geometry(rec, int(read.reference_start), int(read.reference_end or read.reference_start + 1),
                     int(read.query_length or 0), bool(read.is_reverse),
                     _aligned_ops(read.reference_start, read.cigartuples), str(read.reference_name), references)


def iter_view_records(source, bam, chrom, start, end, policy):
    """The normal scan iterator, retaining only lightweight alignment geometry for later observations.

    A completed single-file native fetch can serve every contained patch. In particular, discovery already
    reads the full grid units, including patches extending outside the analysed viewport: scoring those
    patches must not reopen the BAM and regenerate every SAM digest again.
    """
    from fiberhmm.scan.reads import iter_records
    if source.kind != 'native' or len(source.paths) != 1:
        yield from iter_records(bam, chrom, start, end, policy['filters'])
        return
    key = _view_key(source, policy)
    references, geometries = tuple(bam.references), []
    for read, sha, occ in iter_records(bam, chrom, start, end, policy['filters']):
        geometries.append(_geometry(source.paths[0], read, sha, occ, references))
        yield read, sha, occ
    _remember_view(key, chrom, start, end, geometries)


def mol_window(read, start: int, end: int) -> Tuple[int, int]:
    """The molecular span of reference ``[start, end)`` on a record (``NucMolecule.ref_interval_to_mol``: aligned
    query bases, reverse records counted from the molecule's other end), or (-1, -1) when none of it is aligned."""
    qlo = qhi = None
    q = r = 0
    r = int(read.reference_start)
    for op, n in read.cigartuples or ():
        if op in (0, 7, 8):                       # M = X: aligned
            a, b = max(r, start), min(r + n, end)
            if b > a:
                lo, hi = q + (a - r), q + (b - r)
                qlo = lo if qlo is None else min(qlo, lo)
                qhi = hi if qhi is None else max(qhi, hi)
            q += n
            r += n
        elif op in (1, 4):                        # I S: query only
            q += n
        elif op in (2, 3):                        # D N: reference only
            r += n
    if qlo is None:
        return (-1, -1)
    if read.is_reverse:
        L = int(read.query_length or 0)
        return (L - qhi, L - qlo)
    return (qlo, qhi)


def _extend_view(source, policy, cache_key, chrom, start, b, end, geometries):
    """A remembered fetch of [start', b) extended to [start', end): its records, then the records of [b, end)
    starting at or after b, in the file's order (any record starting before b and reaching b overlaps the
    remembered span, and identical records share a start, so occurrences are file-wide as in one fetch)."""
    import pysam
    from fiberhmm.scan.reads import iter_records
    path = source.paths[0]
    extra = []
    with pysam.AlignmentFile(path, 'rb') as bam:
        refs = tuple(bam.references)
        bchrom = bam_chrom(list(refs), chrom)
        if bchrom is None:
            return None
        for read, sha, occ in iter_records(bam, bchrom, int(b), int(end), policy['filters']):
            if read.reference_start < b:
                continue
            extra.append(_geometry(path, read, sha, occ, refs))
    out = list(geometries) + extra
    _remember_view(cache_key, chrom, start, end, out)
    return out


def view_records(source: NucSource, regions: Sequence[Tuple[str, int, int]], policy: dict,
                 windows: Optional[Sequence[Tuple[str, int, int]]] = None) -> List[Rec]:
    """Every record over ``regions`` passing the read filters (no decoding), with its molecular spans of ``windows``
    (default: the regions)."""
    import pysam
    from fiberhmm.scan.reads import iter_records
    from services.read_strand import record_strand_fields
    from .scalars import record_without_calls
    windows = list(windows if windows is not None else regions)
    regions = _merge(regions)
    # One file only (as iter_view_records): an extended view (_extend_view) reads its one file.
    cache_key = _view_key(source, policy) if source.kind == 'native' and len(source.paths) == 1 \
        and len(regions) == 1 else None
    if cache_key is not None:
        chrom, start, end = regions[0]
        chrom_key = chrom
        hit = partial = None
        with _view_lock:
            for key, geometries in reversed(_views.items()):
                base, contig, a, b = key
                if base == cache_key and contig == chrom_key and a <= start:
                    if b >= end:
                        _views.move_to_end(key)
                        hit = geometries
                        break
                    if b > start and partial is None:
                        partial = (a, b, geometries)
        if hit is None and partial is not None:
            hit = _extend_view(source, policy, cache_key, chrom_key, *partial[:2], end, partial[2])
        if hit is not None:
            # A subwindow may select a different primary/supplementary record. Keep every record
            # and its original order here; observation_cohort still performs molecule deduplication.
            return [g.rec._replace(molwins=tuple(_geometry_window(g, int(w0), int(w1))
                        if bam_chrom(g.references, c) == g.reference_name else (-1, -1)
                        for c, w0, w1 in windows))
                    for g in hit if g.reference_start < end and g.reference_end > start]
    out: List[Rec] = []
    geometries = []
    seen = set()
    for path in source.paths:
        with pysam.AlignmentFile(path, 'rb') as bam:
            refs = list(bam.references)
            geometry_refs = tuple(refs)
            # windows in the BAM's own contig names (chr1 / 1 aliases)
            wins_here = [(bam_chrom(refs, c), a, b) for c, a, b in windows]
            for chrom, start, end in regions:
                chrom = bam_chrom(refs, chrom)
                if chrom is None:
                    continue
                for read, sha, occ in iter_records(bam, chrom, int(start), int(end), policy['filters']):
                    key = (path, sha, occ)
                    if key in seen:
                        continue
                    seen.add(key)
                    strand = record_strand_fields(read).get('strand')
                    wins = tuple(mol_window(read, int(a), int(b)) if c is not None and c == read.reference_name else (-1, -1)
                                 for c, a, b in wins_here)
                    out.append(Rec(path, sha, occ, str(read.query_name), strand if strand in ('CT', 'GA') else None,
                                   bool(read.is_supplementary), wins, None,
                                   tuple((int(a), int(b)) for a, b in read.get_blocks()), record_without_calls(read)))
                    if cache_key is not None:
                        geometries.append(_Geometry(out[-1], int(read.reference_start),
                            int(read.reference_end or read.reference_start + 1), int(read.query_length or 0),
                            bool(read.is_reverse), _aligned_ops(read.reference_start, read.cigartuples),
                            str(read.reference_name), geometry_refs))
    if cache_key is not None:
        _remember_view(cache_key, chrom_key, regions[0][1], regions[0][2], geometries)
    return out
