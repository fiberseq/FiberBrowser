"""The panel's observations (NUC §5.2 "observation planner"), resolved to records, and their summaries.

An observation is one column of the panel: a dataset panel's reads in its view (a haplotype pop-out, a strand
split, a split panel's subset, a filtered or cluster-focused read set), a linked locus (a panel at its own view),
or a graph path's reads. The frontend builds the descriptors from the same windows a Cluster run sends
(``utils/clusterTargets.clusterWindows``, graph hosts' members); this module resolves each one to the source
records it shows:

- native: every record over the view passing the read filters (``live.view_records``);
- live lift: the lifted rows of the view (``lifted_reads_for_region``), restricted to the observation's haplotype,
  each named by its source file, record and provenance-qualified molecule key (``live_lift.library`` /
  ``record`` / ``molecule``); the view's windows in source coordinates are its haplotype's lift pieces;
- graph: the records over the path's span in the dataset's own coordinates (a haplotype's lift-piece hull);
- then, when the observation names reads (``readIds``), only those: a plain QNAME names every record of that read;
  a ``lift-record:v1`` key or ``lift-cohort:v1`` identity names its molecule (with its provenance group) and record,
  and a folded key its molecule's records only.

One record per physical molecule (``mol:v1``, a primary record first) enters every aggregate, so a split lifted
record, a supplementary or a CCS strand pair never counts twice.

Summaries are measured in molecular bases: each record's window is the view's span projected onto the molecule
(aligned bases), so deletions never inflate a segment and insertions never hide one. They are molecule-wide
distributions over each observation's outputs (size classes and density-matched z of footprints centred in the
window, per-molecule repeat length, regularity and gap CV, segment shares and events in the window), plus FiberHMM's
``window_metrics`` for the window. Live outputs count only under the dataset's active configuration; records without
them come from what is loaded (a bound scan's rows, an annotated BAM's groups). No nucleosome maths runs here.
"""
from __future__ import annotations

import json
import math
from typing import Dict, List, Optional, Sequence, Tuple

from .inputs import NucSource, nuc_source, real
from .live import Rec
from .store import STORE, RecordOutputs

COARSE = ('cant_tell', 'short', 'mono', 'long', 'multi2', 'multi3', 'edge_truncated')
SEG_STATES = {1: 'regular', 2: 'disordered', 3: 'low_information', 4: 'undetermined'}
Z_EDGES = [round(-6 + 0.5 * i, 2) for i in range(25)]
NRL_EDGES = list(range(150, 262, 4))


class ObservationError(ValueError):
    pass


class _ReadIds:
    """What a read-id list names (QNAMEs, record keys, row identities)."""

    def __init__(self, ids):
        self.qnames, self.records, self.molecules = set(), set(), set()
        for raw in ids or ():
            s = str(raw)
            for prefix in ('lift-record:v1 ', 'lift-cohort:v1 '):
                if s.startswith(prefix):
                    try:
                        parts = json.loads(s[len(prefix):])
                    except ValueError:
                        parts = None
                    if isinstance(parts, list) and len(parts) >= 3 and isinstance(parts[1], str):
                        if isinstance(parts[2], str):
                            self.records.add((parts[0], parts[1], parts[2]))
                        else:
                            self.molecules.add((parts[0], parts[1]))     # a folded molecule: its records
                    break
            else:
                self.qnames.add(s)

    def match(self, rec: Rec) -> bool:
        if rec.qname in self.qnames:
            return True
        if rec.molecule is not None:
            return (rec.molecule, rec.qname, f'{rec.sha}:{rec.occ}') in self.records or \
                (rec.molecule, rec.qname) in self.molecules
        return False


def resolve(state, obs: dict, policy: dict) -> Tuple[NucSource, List[Rec], List[Tuple[str, int, int]]]:
    """(source, records, windows) of one observation descriptor; the windows are in the records' own coordinates."""
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
        if source.kind == 'lifted':
            recs = _with_molecule_keys(state, source, recs)
    else:
        chrom, start, end = str(obs.get('chrom') or ''), int(obs.get('start') or 0), int(obs.get('end') or 0)
        if not chrom or end <= start:
            raise ObservationError(f'{obs.get("label") or ds_id}: no view')
        if source.kind == 'native':
            windows = [(chrom, start, end)]
            recs = view_records(source, windows, policy)
        else:
            windows = source_windows(state, source, chrom, start, end, obs.get('liftHap'))
            recs = _lifted_records(state, source, chrom, start, end, obs.get('liftHap'), windows, policy)
    strand = obs.get('strand')
    ids = obs.get('readIds')
    if ids is not None:
        named = _ReadIds(ids)
        recs = [r for r in recs if named.match(r)]
    if strand in ('CT', 'GA'):
        # A DAF strand panel shows the reads whose st:Z call is that strand (the server's strand filter).
        recs = [r for r in recs if r.strand == strand]
    return source, recs, windows


def _with_molecule_keys(state, source: NucSource, recs: List[Rec]) -> List[Rec]:
    """A live-lift dataset's records with the provenance-qualified molecule key its lifted rows carry (the source
    file's provenance group and the QNAME), so record keys and row identities select them on a graph path too."""
    from services.lift.joint import molecule_key
    ds = state.datasets[source.browser_id]
    groups = ds.live_lift.settings.molecule_group_map(list(ds.paths), ds.id)
    by_real = {real(p): label for p, label in groups.items()}
    return [r._replace(molecule=molecule_key(by_real.get(r.path) or ds.id, r.qname)) for r in recs]


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


def _lifted_records(state, source: NucSource, chrom: str, start: int, end: int, hap: Optional[str], windows,
                    policy) -> List[Rec]:
    """The records of a live-lift dataset's lifted rows in view (of ``hap``), with their molecular windows."""
    from services.lift.reads import lifted_reads_for_region
    from .live import view_records
    ds = state.datasets[source.browser_id]
    rows = lifted_reads_for_region(ds, chrom, int(start), int(end), {})
    lifted: Dict[Tuple[str, str, int], Tuple[str, Optional[str], Optional[str]]] = {}
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
        st = row.get('strand')
        lifted.setdefault((source.paths[lib], sha, int(occ)),
                          (str(row.get('id') or ''), st if st in ('CT', 'GA') else None, ll.get('molecule')))
    by_key = {(r.path, r.sha, r.occ): r for r in view_records(source, windows, policy)} if windows else {}
    out = []
    for key, (qname, strand, molecule) in lifted.items():
        r = by_key.get(key)
        wins = r.molwins if r is not None else tuple((-1, -1) for _w in windows)
        out.append(Rec(*key, qname, strand, bool(r.supplementary) if r is not None else False, wins, molecule,
                       r.blocks if r is not None else ()))
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


def _overlap(molwins, a: int, b: int) -> int:
    """Molecular bases of ``[a, b)`` inside a record's windows (a zero-length span counts 1 when inside)."""
    n = 0
    for w0, w1 in molwins:
        if w1 <= w0:
            continue
        if a == b:
            if w0 <= a < w1:
                return 1
            continue
        n += max(0, min(b, w1) - max(a, w0))
    return n


def summarize_rows(items: Sequence[Tuple[RecordOutputs, Tuple[Tuple[int, int], ...]]]) -> dict:
    """Molecule-wide summary of outputs with each record's molecular windows (one item per molecule)."""
    coarse = {k: 0 for k in COARSE}
    tf = 0
    z = []
    seg_bp = {v: 0 for v in SEG_STATES.values()}
    undersized = missing = 0
    nrl, reg, cv = [], [], []
    too_short = low = 0
    for r, molwins in items:
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
        for ms, ml, _a, _b, q, _n in r.groups.get('nucsz') or ():
            if not q or not _overlap(molwins, ms + ml // 2, ms + ml // 2):
                continue
            code = q[0] & 15
            if code < len(COARSE):
                coarse[COARSE[code]] += 1
            if q[0] & 16:
                tf += 1
            if len(q) > 3 and q[3] != 255 and code in (1, 2, 3):
                z.append((q[3] - 128) / 20.0)
        for ms, ml, _a, _b, q, _n in r.groups.get('nucseg') or ():
            if not q:
                continue
            inside = _overlap(molwins, ms, ms + ml)
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
        molecules=len(items), lowInformation=low,
        sizes=dict(coarse=coarse, tf=tf, footprints=n_fp,
                   cantTellFraction=round((coarse['cant_tell'] + coarse['edge_truncated']) / n_fp, 4) if n_fp else None,
                   z=dict(edges=Z_EDGES, counts=_hist(z, Z_EDGES), n=len(z))),
        spacing=dict(nrl=dict(quantiles=_quantiles(nrl), edges=NRL_EDGES, counts=_hist(nrl, NRL_EDGES), n=len(nrl)),
                     regularity=_quantiles(reg), gapCv=_quantiles(cv),
                     tooShortFraction=round(too_short / len(items), 4) if items else None),
        segments=dict(bp=seg_total, **{k: (round(v / seg_total, 4) if seg_total else None) for k, v in seg_bp.items()},
                      undersizedRuns=undersized, missingNucleosomes=missing),
    )


def _window_metrics(cohort: Sequence[Rec], window, cfg) -> Optional[dict]:
    """FiberHMM's window metrics for one record per molecule of the observation (decoded molecules from the store,
    under the active configuration) over one window in their own coordinates."""
    from fiberhmm.nuc.window import window_metrics
    from .engine import nuc_params
    mols, results = [], {}
    for r in cohort:
        config = cfg.config_for(r.path)
        hit = STORE.get_result(r.path, r.sha, r.occ, config) if config is not None else None
        if hit is None:
            continue
        mol, res = hit
        mols.append(mol)
        results[id(mol)] = res
    if not mols:
        return None
    window = (frame_chrom(mols, window[0]), window[1], window[2])
    wr = window_metrics(mols, window, params=nuc_params(cfg.settings), cal=cfg.calibration.calibration,
                        results=results)
    agg = dict(wr.groups.get('all') or {})
    return json.loads(json.dumps(agg, default=lambda o: None if isinstance(o, float) and not math.isfinite(o) else str(o)))


def window_hull(windows) -> Optional[Tuple[str, int, int]]:
    """One measurement window from an observation's windows in its records' coordinates: the hull of the pieces on
    the contig they cover most. A lifted window crossing an insertion projects to source pieces with the inserted
    sequence between them; the hull keeps every piece and measures the insertion with them (as graph-path columns
    count the haplotype's lift-piece hull)."""
    by: Dict[str, List[int]] = {}
    for c, a, b in windows or ():
        if b <= a:
            continue
        h = by.setdefault(c, [a, b, 0])
        h[0], h[1], h[2] = min(h[0], a), max(h[1], b), h[2] + (b - a)
    if not by:
        return None
    c, (a, b, _n) = max(by.items(), key=lambda kv: kv[1][2])
    return c, int(a), int(b)


def same_contig(a: str, b: str) -> bool:
    """Contig names equal up to the chr prefix (chr1 / 1)."""
    norm = lambda x: str(x or '').lower().removeprefix('chr')  # noqa: E731
    return norm(a) == norm(b)


def frame_chrom(mols, chrom: str) -> str:
    """A window's contig as the molecules' BAM names it (chr1 / 1 aliases): FiberHMM matches names exactly."""
    from utils.chrom import normalize_chrom_name
    want = normalize_chrom_name(chrom)
    for m in mols:
        if m.chrom == chrom:
            return chrom
        if m.chrom and normalize_chrom_name(m.chrom) == want:
            return m.chrom
    return chrom


def _molecule_key(qname: str) -> str:
    from fiberhmm.scan.identity import molecule_id
    return molecule_id([qname])


def observation_cohort(state, obs: dict, policy: dict):
    """(source, records, windows, active configuration, [(record, outputs)] one per molecule, counts)."""
    from .jobs import active_config
    source, recs, windows = resolve(state, obs, policy)
    cfg = active_config(state, source.browser_id)

    def live_row(r: Rec) -> Optional[RecordOutputs]:
        # Live outputs count under the dataset's active configuration only (another dataset may have computed
        # this file with other settings).
        if cfg is None or STORE.config_of(r.path) != cfg.config_for(r.path):
            return None
        return STORE.get(r.path, r.sha, r.occ)

    def failed(r: Rec) -> bool:
        return cfg is not None and STORE.config_of(r.path) == cfg.config_for(r.path) and \
            STORE.failed(r.path, r.sha, r.occ) is not None

    absent = [(r.path, r.sha, r.occ) for r in recs if live_row(r) is None and not failed(r)]
    loaded = {}
    if absent:
        try:
            from .loaded import loaded_rows
            loaded = loaded_rows(state, source, windows, absent)
        except Exception:   # noqa: BLE001 - loaded rows are an addition; live rows still summarise
            loaded = {}
    # One record per physical molecule (mol:v1), a primary record first.
    by_molecule: Dict[str, Tuple[Rec, RecordOutputs]] = {}
    missing = undecodable = 0
    for r in sorted(recs, key=lambda x: x.supplementary):
        row = live_row(r) or loaded.get((r.path, r.sha, r.occ))
        if row is None:
            if failed(r):
                undecodable += 1
            else:
                missing += 1
            continue
        by_molecule.setdefault(_molecule_key(r.qname), (r, row))
    return source, recs, windows, cfg, list(by_molecule.values()), dict(missing=missing, undecodable=undecodable)


def summarize(state, observations: Sequence[dict], *, include_duplicates: bool = False) -> dict:
    from .inputs import browser_read_policy
    policy = browser_read_policy(state, include_duplicates=include_duplicates)
    out = []
    for obs in observations:
        entry = dict(obsId=obs.get('obsId'), label=obs.get('label'), datasetId=obs.get('datasetId'),
                     kind=obs.get('kind') or 'linear')
        try:
            source, recs, windows, cfg, cohort, counts = observation_cohort(state, obs, policy)
        except (ObservationError, ValueError) as error:
            entry['error'] = str(error)
            out.append(entry)
            continue
        entry.update(records=len(recs), computed=len(cohort), notComputed=counts['missing'],
                     undecodable=counts['undecodable'],
                     windows=[dict(chrom=c, start=a, end=b) for c, a, b in windows],
                     calibration=cfg.calibration.summary() if cfg is not None else None,
                     sources=sorted({row.source for _r, row in cohort}))
        entry.update(summarize_rows([(row, r.molwins) for r, row in cohort]))
        if cfg is not None and cohort and windows:
            # window metrics over the observation's largest window (a lifted view through an insertion is still
            # one source span per haplotype)
            window = max(windows, key=lambda w: w[2] - w[1])
            try:
                entry['windowMetrics'] = _window_metrics([r for r, _row in cohort], window, cfg)
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
    rows = []
    for r in view_records(source, regions, policy):
        out = STORE.get(r.path, r.sha, r.occ)
        rows.append(dict(record=f'{r.sha}:{r.occ}', file=source.paths.index(real(r.path)) if real(r.path) in source.paths else 0,
                         qname=r.qname, outputs=out.to_json() if out is not None else None))
    return dict(datasetId=dataset_id, regions=[list(x) for x in regions], records=rows)
