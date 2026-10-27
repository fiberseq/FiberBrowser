"""The panel's observations (NUC §5.2 "observation planner"), resolved to records, and their summaries.

An observation is one column of the panel: a dataset panel's reads in its view (a haplotype pop-out, a strand
split, a split panel's subset, a filtered or cluster-focused read set), a linked locus (a panel at its own view),
or a graph path's reads. The frontend builds the descriptors from the same windows a Cluster run sends
(``utils/clusterTargets.clusterWindows``, graph runs' observations); this module resolves each one to the source
records it shows:

- native: every record over the view passing the read filters (``live.view_records``);
- live lift: the lifted rows of the view (``lifted_reads_for_region``), restricted to the observation's haplotype,
  each named by its source file and record (``live_lift.library`` / ``live_lift.record``);
- graph: the records over the path's span in the dataset's own coordinates;
- then, when the observation names reads (``readIds``: QNAMEs, ``lift-record:v1`` record keys or ``lift-cohort:v1``
  row identities), only those.

Physical molecules are counted once per observation (``mol:v1``-style: one molecule per QNAME and file), so a
split lifted record or a supplementary never counts twice.

Summaries are molecule-wide distributions over each observation's stored outputs (size classes and density-matched
z of footprints in the window, per-molecule repeat length, regularity and gap CV, segment fractions and events in
the window), plus FiberHMM's ``window_metrics`` for the window (class mix with ``insufficient``, NRL quantiles,
regular / disordered / undetermined fractions) from the decoded molecules. No nucleosome maths runs in the
browser.
"""
from __future__ import annotations

import json
import math
from typing import Dict, List, Optional, Sequence, Tuple

from .inputs import NucSource, nuc_source, real
from .store import STORE, RecordOutputs

COARSE = ('cant_tell', 'short', 'mono', 'long', 'multi2', 'multi3', 'edge_truncated')
SEG_STATES = {1: 'regular', 2: 'disordered', 3: 'low_information', 4: 'undetermined'}
Z_EDGES = [round(-6 + 0.5 * i, 2) for i in range(25)]
NRL_EDGES = list(range(150, 262, 4))


class ObservationError(ValueError):
    pass


def _read_id_keys(ids) -> Tuple[set, set]:
    """(QNAMEs, records 'sha:occ') named by a read-id list (QNAMEs, record keys, row identities)."""
    qnames, records = set(), set()
    for raw in ids or ():
        s = str(raw)
        for prefix in ('lift-record:v1 ', 'lift-cohort:v1 '):
            if s.startswith(prefix):
                try:
                    parts = json.loads(s[len(prefix):])
                except ValueError:
                    parts = None
                if isinstance(parts, list) and len(parts) >= 3:
                    if isinstance(parts[2], str):
                        records.add(parts[2])
                    elif isinstance(parts[1], str):
                        qnames.add(parts[1])     # a folded molecule key: every record of the QNAME
                break
        else:
            qnames.add(s)
    return qnames, records


def resolve(state, obs: dict, policy: dict) -> Tuple[NucSource, list, List[Tuple[str, int, int]]]:
    """(source, [(file, sha, occ, qname, DAF strand)], windows) of one observation descriptor; the windows are in the
    records' own coordinates (a live-lift observation's view through its haplotype's primary lift pieces)."""
    from .live import view_records
    ds_id = str(obs.get('datasetId') or '')
    source = nuc_source(state, ds_id)
    kind = obs.get('kind') or 'linear'
    if kind == 'graph':
        g = obs.get('graph') or {}
        contig, start, end = str(g.get('contig') or ''), int(g.get('start') or 0), int(g.get('end') or 0)
        if contig and end > start:
            windows = [(contig, start, end)]
        else:
            # The path's span over the view: a live-lift dataset's haplotype contig from the first to the last lift
            # piece in view (an insertion between pieces is on the path), or the view on a native dataset's target.
            chrom, v0, v1 = str(obs.get('chrom') or ''), int(obs.get('start') or 0), int(obs.get('end') or 0)
            if not chrom or v1 <= v0:
                raise ObservationError(f'{obs.get("label") or ds_id}: a graph observation needs its path span or view')
            if source.kind == 'native':
                windows = [(chrom, v0, v1)]
            else:
                hulls: Dict[str, List[int]] = {}
                for c, a, b in source_windows(state, source, chrom, v0, v1, obs.get('liftHap') or g.get('hap')):
                    h = hulls.setdefault(c, [a, b])
                    h[0], h[1] = min(h[0], a), max(h[1], b)
                windows = [(c, a, b) for c, (a, b) in hulls.items()]
        recs = view_records(source, windows, policy)
    else:
        chrom, start, end = str(obs.get('chrom') or ''), int(obs.get('start') or 0), int(obs.get('end') or 0)
        if not chrom or end <= start:
            raise ObservationError(f'{obs.get("label") or ds_id}: no view')
        if source.kind == 'native':
            windows = [(chrom, start, end)]
            recs = view_records(source, windows, policy)
        else:
            recs = _lifted_records(state, source, chrom, start, end, obs.get('liftHap'))
            windows = source_windows(state, source, chrom, start, end, obs.get('liftHap'))
    strand = obs.get('strand')
    ids = obs.get('readIds')
    if ids is not None:
        qnames, records = _read_id_keys(ids)
        recs = [r for r in recs if r[3] in qnames or f'{r[1]}:{r[2]}' in records]
    if strand in ('CT', 'GA'):
        # A DAF strand panel shows the reads whose st:Z call is that strand (the server's strand filter).
        recs = [r for r in recs if r[4] == strand]
    return source, recs, windows


def source_windows(state, source: NucSource, chrom: str, start: int, end: int, hap: Optional[str] = None):
    """A target view in a live-lift dataset's source coordinates: its primary lift pieces (of ``hap`` when given)
    clipped to the view, merged per source contig."""
    from services.lift.live_lift import clip_piece, lift_key, select_pieces
    from .live import _merge
    config = state.datasets[source.browser_id].live_lift
    handle = config.handle
    if chrom not in handle.map.targets:
        return []
    haps = handle.resolve_haplotypes(config.haplotypes)
    key = lift_key(handle, haps, config.settings)
    sel = select_pieces(handle, chrom, int(start), int(end), haplotypes=haps, settings=config.settings, key=key)
    labels = getattr(handle, 'haplotype_labels', None) or {}
    out = []
    for p in sel.pieces:
        if not p.primary:
            continue
        if hap and hap not in (p.hap, labels.get(p.hap)):
            continue
        c = clip_piece(p, int(start), int(end))
        if c is not None:
            out.append((p.source, int(c.q_start), int(c.q_end)))
    return _merge(out)


def _lifted_records(state, source: NucSource, chrom: str, start: int, end: int, hap: Optional[str]):
    from services.lift.reads import lifted_reads_for_region
    ds = state.datasets[source.browser_id]
    rows = lifted_reads_for_region(ds, chrom, int(start), int(end), {})
    out, seen = [], set()
    for row in rows:
        ll = row.get('live_lift') or {}
        if hap and hap not in (ll.get('hap'), ll.get('hap_label')):
            continue
        rec = str(ll.get('record') or '')
        if ':' not in rec:
            continue
        sha, occ = rec.rsplit(':', 1)
        lib = int(ll.get('library') or 0)
        if not 0 <= lib < len(source.paths):
            continue
        key = (source.paths[lib], sha, int(occ))
        if key not in seen:
            seen.add(key)
            st = row.get('strand')
            out.append((*key, str(row.get('id') or ''), st if st in ('CT', 'GA') else None))
    return out


# ------------------------------------------------------------------ summaries
def _quantiles(values: Sequence[float]) -> Optional[List[float]]:
    vs = sorted(v for v in values if v is not None and math.isfinite(v))
    if not vs:
        return None
    def q(p):
        k = (len(vs) - 1) * p
        lo, hi = math.floor(k), math.ceil(k)
        return vs[lo] + (vs[hi] - vs[lo]) * (k - lo)
    return [round(q(p), 3) for p in (0.1, 0.25, 0.5, 0.75, 0.9)]


def _hist(values: Sequence[float], edges: Sequence[float]) -> List[int]:
    counts = [0] * (len(edges) - 1)
    for v in values:
        if v is None or not math.isfinite(v) or v < edges[0] or v >= edges[-1]:
            continue
        lo, hi = 0, len(edges) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if v >= edges[mid]:
                lo = mid
            else:
                hi = mid
        counts[lo] += 1
    return counts


def _inside(windows, chrom: str, a: int, b: int) -> int:
    """Bases of ``[a, b)`` on ``chrom`` inside the windows (a zero-width span counts 1 when its base is inside)."""
    n = 0
    for c, w0, w1 in windows:
        if c != chrom:
            continue
        if a == b:
            if w0 <= a < w1:
                return 1
            continue
        n += max(0, min(b, w1) - max(a, w0))
    return n


def summarize_rows(rows: Sequence[RecordOutputs], windows: Sequence[Tuple[str, int, int]]) -> dict:
    """Molecule-wide summary of stored outputs over windows in the rows' own coordinates."""
    coarse = {k: 0 for k in COARSE}
    tf = 0
    z = []
    seg_bp = {v: 0 for v in SEG_STATES.values()}
    undersized = missing = 0
    nrl, reg, cv = [], [], []
    too_short = low = 0
    for r in rows:
        if r.low_information:
            low += 1
        flags = int(r.scalars.get('flags') or 0)
        if flags & 1:
            too_short += 1
        elif r.scalars.get('nrl') is not None:
            nrl.append(r.scalars['nrl'])
        if not flags & 2 and r.scalars.get('regularity') is not None:
            reg.append(r.scalars['regularity'])
            if r.scalars.get('gap_cv') is not None:
                cv.append(r.scalars['gap_cv'])
        for ms, ml, a, b, q, _n in r.groups.get('nucsz') or ():
            mid = (a + max(b, a + 1)) // 2
            if not q or not _inside(windows, r.chrom, mid, mid):
                continue
            code = q[0] & 15
            if code < len(COARSE):
                coarse[COARSE[code]] += 1
            if q[0] & 16:
                tf += 1
            if len(q) > 3 and q[3] != 255 and code in (1, 2, 3):
                z.append((q[3] - 128) / 20.0)
        for ms, ml, a, b, q, _n in r.groups.get('nucseg') or ():
            if not q:
                continue
            inside = _inside(windows, r.chrom, a, b)
            if q[0] >= 16:
                if inside:
                    if q[0] == 16:
                        undersized += 1
                    elif q[0] == 17:
                        missing += 1
                continue
            if inside and q[0] in SEG_STATES:
                seg_bp[SEG_STATES[q[0]]] += inside
    n_fp = sum(coarse.values())
    seg_total = sum(seg_bp.values())
    return dict(
        molecules=len(rows), lowInformation=low,
        sizes=dict(coarse=coarse, tf=tf, footprints=n_fp,
                   cantTellFraction=round((coarse['cant_tell'] + coarse['edge_truncated']) / n_fp, 4) if n_fp else None,
                   z=dict(edges=Z_EDGES, counts=_hist(z, Z_EDGES), n=len(z))),
        spacing=dict(nrl=dict(quantiles=_quantiles(nrl), edges=NRL_EDGES, counts=_hist(nrl, NRL_EDGES), n=len(nrl)),
                     regularity=_quantiles(reg), gapCv=_quantiles(cv),
                     tooShortFraction=round(too_short / len(rows), 4) if rows else None),
        segments=dict(bp=seg_total, **{k: (round(v / seg_total, 4) if seg_total else None) for k, v in seg_bp.items()},
                      undersizedRuns=undersized, missingNucleosomes=missing),
    )


def _window_metrics(source: NucSource, keys, window, cfg) -> Optional[dict]:
    """FiberHMM's window metrics for the observation's molecules (decoded molecules from the store) over one window
    in their own coordinates."""
    from fiberhmm.nuc.window import window_metrics
    from .engine import nuc_params
    config = (cfg.calibration.settings_hash, cfg.calibration.digest)
    mols, results = [], {}
    for path, sha, occ, *_rest in keys:
        hit = STORE.get_result(path, sha, occ, config)
        if hit is None:
            continue
        mol, res = hit
        mols.append(mol)
        results[id(mol)] = res
    if not mols:
        return None
    wr = window_metrics(mols, window, params=nuc_params(cfg.settings), cal=cfg.calibration.calibration,
                        results=results)
    agg = dict(wr.groups.get('all') or {})
    return json.loads(json.dumps(agg, default=lambda o: None if isinstance(o, float) and not math.isfinite(o) else str(o)))


def summarize(state, observations: Sequence[dict], *, include_duplicates: bool = False) -> dict:
    from .inputs import browser_read_policy
    from .jobs import active_config
    policy = browser_read_policy(state, include_duplicates=include_duplicates)
    out = []
    for obs in observations:
        entry = dict(obsId=obs.get('obsId'), label=obs.get('label'), datasetId=obs.get('datasetId'),
                     kind=obs.get('kind') or 'linear')
        try:
            source, recs, windows = resolve(state, obs, policy)
        except (ObservationError, ValueError) as error:
            entry['error'] = str(error)
            out.append(entry)
            continue
        cfg = active_config(state, source.browser_id)
        rows, seen = [], set()
        missing = undecodable = 0
        for path, sha, occ, qname, _strand in recs:
            r = STORE.get(path, sha, occ)
            if r is None:
                if STORE.failed(path, sha, occ) is not None:
                    undecodable += 1
                else:
                    missing += 1
                continue
            mol_key = (path, qname)
            if mol_key in seen:
                continue
            seen.add(mol_key)
            rows.append(r)
        entry.update(records=len(recs), computed=len(rows), notComputed=missing, undecodable=undecodable,
                     windows=[dict(chrom=c, start=a, end=b) for c, a, b in windows],
                     calibration=cfg.calibration.summary() if cfg is not None else None,
                     sources=sorted({r.source for r in rows}))
        entry.update(summarize_rows(rows, windows))
        if cfg is not None and rows and windows:
            # window metrics over the observation's largest window (a lifted view through an insertion is still
            # one source span per haplotype)
            window = max(windows, key=lambda w: w[2] - w[1])
            try:
                entry['windowMetrics'] = _window_metrics(source, recs, window, cfg)
            except Exception as error:   # noqa: BLE001 - a metrics failure must not hide the summary
                entry['windowMetrics'] = None
                entry['windowMetricsError'] = str(error)
        out.append(entry)
    return dict(observations=out)


def record_rows(state, dataset_id: str, chrom: str, start: int, end: int, *, include_duplicates: bool = False) -> dict:
    """The stored outputs of a dataset's records over a view (tests, exports, debugging)."""
    from .inputs import browser_read_policy
    from .live import source_regions, view_records
    policy = browser_read_policy(state, include_duplicates=include_duplicates)
    source = nuc_source(state, dataset_id)
    regions = source_regions(state, source, chrom, int(start), int(end))
    recs = view_records(source, regions, policy)
    rows = []
    for path, sha, occ, qname, _strand in recs:
        r = STORE.get(path, sha, occ)
        rows.append(dict(record=f'{sha}:{occ}', file=source.paths.index(real(path)) if real(path) in source.paths else 0,
                         qname=qname, outputs=r.to_json() if r is not None else None))
    return dict(datasetId=dataset_id, regions=[list(r) for r in regions], records=rows)
