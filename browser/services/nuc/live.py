"""Live nucleosome outputs for a region's records, from the complete source records.

``record_outputs`` is ``fiberhmm.scan.modules.nuc.NucModule.molecule_outputs`` written out so the browser keeps
the decoded molecule and FiberHMM's ``MoleculeResult`` (window metrics and phasing need them) without computing
twice: ``decode_record`` on the stored record, ``molecule_outputs`` with the calibration, the MA rows of
``group_rows`` with each mark's reference envelope (``_ref_envelope``), and the scalars with the flag bits and the
calls digest. ``tests/test_nuc_equivalence.py`` checks every row against ``fiberhmm-scan``'s for the same record.

Records come from ``fiberhmm.scan.reads.iter_records`` (the scan's own iterator: read filters, SHA-256 and
occurrence), over

- a native dataset's view;
- a live-lift dataset's source windows for the view (the lift plan the lifted rows are composed from);
- an explicit source region (a graph path's span in a live-lift dataset's own coordinates).
"""
from __future__ import annotations

import threading
from typing import Callable, Dict, Iterable, List, NamedTuple, Optional, Sequence, Tuple

import numpy as np

from .calibration import CalibrationRef
from .inputs import NucSource
from .store import STORE, RecordOutputs

_ctx_lock = threading.Lock()
_contexts: Dict[tuple, object] = {}


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


def record_outputs(read, input_index: int, ctx, params, cal) -> Tuple[Optional[RecordOutputs], object, object, str]:
    """(outputs, molecule, result, reason) of one stored record; outputs is None when FiberHMM can't decode it."""
    from fiberhmm.nuc.molecule import molecule_outputs as nuc_outputs
    from fiberhmm.nuc.records import decode_record
    from fiberhmm.nuc.tags import FLAG_BITS, NUCMOL, digest_pieces, group_rows
    from fiberhmm.scan.modules.nuc import _ref_envelope
    mol, why = decode_record(read, ctx)
    if mol is None:
        return None, None, None, why
    res = nuc_outputs(mol, params, cal)
    groups: Dict[str, list] = {}
    nucmol: List[int] = []
    for group, (_spec, rows) in group_rows(res).items():
        if group == NUCMOL:
            nucmol = [int(x) for x in rows[0][2]] if rows else []
            continue
        marks = []
        for s, n, q, name in rows:
            a, b = _ref_envelope(mol, s, s + n)
            marks.append((int(s), int(n), int(a), int(b), tuple(int(x) for x in q), str(name)))
        groups[group] = marks
    scalars = {k: (None if v is None or not np.isfinite(v) else float(v)) for k, v in res.scalars.items()}
    scalars['flags'] = float(sum(1 << i for i, k in enumerate(FLAG_BITS) if res.flags.get(k)))
    scalars['calls_digest_hi'], scalars['calls_digest_lo'] = digest_pieces(res.digest)
    out = RecordOutputs(
        qname=str(read.query_name), input_index=int(input_index), chrom=str(read.reference_name),
        ref_start=int(read.reference_start), ref_end=int(read.reference_end or read.reference_start),
        reverse=bool(read.is_reverse), supplementary=bool(read.is_supplementary),
        hp=int(read.get_tag('HP')) if read.has_tag('HP') else None, groups=groups, nucmol=nucmol, scalars=scalars,
        source='live', low_information=bool(res.flags.get('low_information')))
    return out, mol, res, 'ok'


def _params_key(settings: dict) -> str:
    import json
    return json.dumps(settings.get('params') or {}, sort_keys=True)


class _Counter:
    def __init__(self):
        self.records = 0
        self.computed = 0
        self.cached = 0
        self.undecodable: Dict[str, int] = {}


def compute_regions(source: NucSource, regions: Sequence[Tuple[str, int, int]], settings: dict, cals,
                    policy: dict, *, progress: Optional[Callable[[int, int], None]] = None, cancel=None,
                    keep_results: bool = True) -> dict:
    """Compute and store outputs for every record (passing ``policy``'s filters) overlapping ``regions`` of the
    dataset's files (in the files' own coordinates). ``cals``: a CalibrationRef, or one per real path. Records
    already stored for this configuration are kept."""
    import pysam
    from fiberhmm.scan.reads import iter_records
    from .engine import nuc_params
    params = nuc_params(settings)
    pkey = _params_key(settings)
    if isinstance(cals, CalibrationRef):
        cals = {p: cals for p in source.paths}
    filters = policy['filters']
    n = _Counter()
    for path in source.paths:
        STORE.configure(path, (cals[path].settings_hash, cals[path].digest))
    regions = _merge(regions)
    total_bp = sum(b - a for _c, a, b in regions) or 1
    done_bp = 0
    for i, path in enumerate(source.paths):
        config = (cals[path].settings_hash, cals[path].digest)
        calibration = cals[path].calibration
        with pysam.AlignmentFile(path, 'rb') as bam:
            refs = set(bam.references)
            ctx = _decode_context(path, bam.header, params, pkey)
            for chrom, start, end in regions:
                if chrom not in refs:
                    continue
                batch = []
                for read, sha, occ in iter_records(bam, chrom, int(start), int(end), filters):
                    if cancel is not None and cancel.is_set():
                        raise InterruptedError('cancelled')
                    n.records += 1
                    if STORE.has(path, sha, occ) and (not keep_results or STORE.get_result(path, sha, occ, config)):
                        n.cached += 1
                        continue
                    if STORE.failed(path, sha, occ) is not None:
                        why = STORE.failed(path, sha, occ)
                        n.undecodable[why] = n.undecodable.get(why, 0) + 1
                        continue
                    out, mol, res, why = record_outputs(read, i, ctx, params, calibration)
                    if out is None:
                        n.undecodable[why] = n.undecodable.get(why, 0) + 1
                        STORE.put_failed(path, config, [((sha, occ), why)])
                        continue
                    n.computed += 1
                    batch.append(((sha, occ), out))
                    if keep_results:
                        mol.meta['dataset_id'] = source.browser_id
                        STORE.put_result(path, sha, occ, config, mol, res)
                    if len(batch) >= 64:
                        STORE.put(path, config, batch)
                        batch = []
                        if progress is not None:
                            progress(n.records, n.computed)
                STORE.put(path, config, batch)
                done_bp += end - start
                if progress is not None:
                    progress(n.records, n.computed)
    return dict(records=n.records, computed=n.computed, cached=n.cached, undecodable=n.undecodable,
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
    return [(c.contig, int(a), int(b)) for c in plan.contigs for a, b in c.windows]


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


def view_records(source: NucSource, regions: Sequence[Tuple[str, int, int]], policy: dict,
                 windows: Optional[Sequence[Tuple[str, int, int]]] = None) -> List[Rec]:
    """Every record over ``regions`` passing the read filters (no decoding), with its molecular spans of ``windows``
    (default: the regions)."""
    import pysam
    from fiberhmm.scan.reads import iter_records
    from services.read_strand import record_strand_fields
    windows = list(windows if windows is not None else regions)
    out: List[Rec] = []
    seen = set()
    for path in source.paths:
        with pysam.AlignmentFile(path, 'rb') as bam:
            refs = set(bam.references)
            for chrom, start, end in _merge(regions):
                if chrom not in refs:
                    continue
                for read, sha, occ in iter_records(bam, chrom, int(start), int(end), policy['filters']):
                    key = (path, sha, occ)
                    if key in seen:
                        continue
                    seen.add(key)
                    strand = record_strand_fields(read).get('strand')
                    wins = tuple(mol_window(read, int(a), int(b)) if c == read.reference_name else (-1, -1)
                                 for c, a, b in windows)
                    out.append(Rec(path, sha, occ, str(read.query_name), strand if strand in ('CT', 'GA') else None,
                                   bool(read.is_supplementary), wins))
    return out
