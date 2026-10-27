"""Window mode and selection for the nucleosome panel (NUC §3.7, §6.2, §6.1 "Selection").

**Window mode.** For a window (the view, a read-track selection, a hub hit, a BED row, typed coordinates) with an
optional anchor and orientation, each observation's molecules are measured inside the window by FiberHMM's
``window_metrics``: class mix (``insufficient`` when can't-tell dominates), NRL quantiles, regular / disordered /
undetermined / low-information shares, missing nucleosomes per molecule, the nucleosome state at the anchor, and with
an anchor the phasing in both frames (whole-period bins, molecule-level phase null, period sensitivity, positional
dispersion). With background anchors (comparable loci without the property under test), the dephasing readout places
the anchor's coherence and excess among them (``fiberhmm.nuc.dephasing``: fuzzy / dephased, NUC §13.1 kind 4).
A live-lift observation measures in its source coordinates: the window and the anchors are projected through its
haplotype's lift pieces (an anchor on a ``-`` piece turns its orientation).

**Selection.** A click on a size class, an NRL bin, a segment state or an event names the observation's molecules
that have it; the panel highlights those reads in every track (native rows by QNAME, lifted rows by record key).
"""
from __future__ import annotations

import json
import math
from typing import List, Optional, Sequence, Tuple

from .observations import COARSE, ObservationError, observation_cohort, source_windows
from .store import STORE


def _clean(obj):
    """JSON-able, with non-finite numbers as None (FiberHMM reports undefined metrics as NaN)."""
    import numpy as np
    if isinstance(obj, dict):
        return {str(k): _clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_clean(v) for v in obj]
    if isinstance(obj, (bool, np.bool_)):
        return bool(obj)
    if isinstance(obj, (int, np.integer)):
        return int(obj)
    if isinstance(obj, (float, np.floating)):
        return float(obj) if math.isfinite(float(obj)) else None
    if obj is None or isinstance(obj, str):
        return obj
    return str(obj)


def _source_point(state, source, chrom: str, pos: int, hap: Optional[str], orientation: int):
    """A target position (and orientation) on a live-lift dataset's source contig through its haplotype's primary
    lift piece, or None when no piece of that haplotype holds it."""
    from services.lift.live_lift import lift_key, select_pieces
    config = state.datasets[source.browser_id].live_lift
    handle = config.handle
    if chrom not in handle.map.targets:
        return None
    haps = handle.resolve_haplotypes(config.haplotypes)
    key = lift_key(handle, haps, config.settings)
    sel = select_pieces(handle, chrom, int(pos), int(pos) + 1, haplotypes=haps, settings=config.settings, key=key)
    labels = getattr(handle, 'haplotype_labels', None) or {}
    for p in sel.pieces:
        if not p.primary or not (p.t_start <= pos < p.t_end):
            continue
        if hap and hap not in (p.hap, labels.get(p.hap)):
            continue
        if p.strand == '+':
            return p.source, int(p.q_start + (pos - p.t_start)), int(orientation)
        return p.source, int(p.q_end - 1 - (pos - p.t_start)), -int(orientation)
    return None


def _in_frame(state, source, obs: dict, chrom: str, pos: int, orientation: int):
    if source.kind == 'native':
        return chrom, int(pos), int(orientation)
    return _source_point(state, source, chrom, pos, obs.get('liftHap') or (obs.get('graph') or {}).get('hap'), orientation)


def window_analysis(state, observations: Sequence[dict], window: dict, anchor: Optional[dict] = None,
                    background: Optional[Sequence[dict]] = None, *, include_duplicates: bool = False) -> dict:
    from fiberhmm.nuc.window import window_metrics
    from .engine import nuc_params
    from .inputs import browser_read_policy
    policy = browser_read_policy(state, include_duplicates=include_duplicates)
    chrom, ws, we = str(window.get('chrom') or ''), int(window.get('start') or 0), int(window.get('end') or 0)
    if not chrom or we <= ws:
        raise ObservationError('Give the window (chrom, start, end)')
    out = []
    for obs in observations:
        entry = dict(obsId=obs.get('obsId'), label=obs.get('label'), datasetId=obs.get('datasetId'))
        try:
            scoped = {**obs, 'chrom': chrom, 'start': ws, 'end': we}
            if scoped.get('kind') == 'graph':
                scoped['graph'] = {k: v for k, v in (obs.get('graph') or {}).items() if k == 'hap'}
            source, _recs, windows, cfg, cohort, counts = observation_cohort(state, scoped, policy)
        except (ObservationError, ValueError) as error:
            entry['error'] = str(error)
            out.append(entry)
            continue
        if cfg is None:
            entry['error'] = 'Compute in view first: window metrics read the computed molecules'
            out.append(entry)
            continue
        if not windows:
            entry['error'] = 'The window is not on this observation (no lift piece of its haplotype covers it)'
            out.append(entry)
            continue
        win = max(windows, key=lambda w: w[2] - w[1])
        mols, results = [], {}
        for r, _row in cohort:
            hit = STORE.get_result(r.path, r.sha, r.occ, cfg.config_for(r.path))
            if hit is not None:
                mols.append(hit[0])
                results[id(hit[0])] = hit[1]
        a = None
        if anchor is not None and anchor.get('pos') is not None:
            a = _in_frame(state, source, obs, chrom, int(anchor['pos']), int(anchor.get('orientation') or 0))
            if a is None:
                entry['anchorNote'] = 'The anchor is not on this observation (an insertion or another haplotype)'
        bg = []
        for b in background or ():
            p = _in_frame(state, source, obs, str(b.get('chrom') or chrom), int(b['pos']), int(b.get('orientation') or 0))
            if p is not None:
                bg.append(p)
        entry.update(window=dict(chrom=win[0], start=win[1], end=win[2]), molecules=len(mols),
                     notComputed=len(cohort) - len(mols) + counts['missing'])
        if not mols:
            entry['metrics'] = None
            out.append(entry)
            continue
        from .observations import frame_chrom
        win = (frame_chrom(mols, win[0]), win[1], win[2])
        bg = [(frame_chrom(mols, c), p, o) for c, p, o in bg]
        wr = window_metrics(mols, win, anchor=a[1] if a else None, orientation=a[2] if a else 0,
                            params=nuc_params(cfg.settings), cal=cfg.calibration.calibration, results=results,
                            background_anchors=bg or None)
        entry['metrics'] = _clean(wr.groups.get('all') or {})
        if a:
            entry['anchor'] = dict(chrom=a[0], pos=a[1], orientation=a[2])
        entry['background'] = len(bg)
        out.append(entry)
    return dict(window=dict(chrom=chrom, start=ws, end=we), anchor=anchor, observations=out)


# ------------------------------------------------------------------ selection
def _read_key(rec) -> str:
    if rec.molecule is not None:
        return 'lift-record:v1 ' + json.dumps([rec.molecule, rec.qname, f'{rec.sha}:{rec.occ}'], separators=(',', ':'),
                                              ensure_ascii=True)
    return rec.qname


def select_reads(state, obs: dict, category: dict, *, include_duplicates: bool = False) -> dict:
    """The read identities of an observation's molecules in a category: ``{kind: 'coarse', name}`` (a footprint of
    that class centred in the window), ``{kind: 'nrl', lo, hi}`` (repeat length in [lo, hi)), ``{kind: 'segment',
    state}`` (a segment of that state in the window) or ``{kind: 'event', name}`` (undersized / missing)."""
    from .inputs import browser_read_policy
    from .observations import SEG_STATES, _overlap
    policy = browser_read_policy(state, include_duplicates=include_duplicates)
    _source, _recs, _windows, _cfg, cohort, _counts = observation_cohort(state, obs, policy)
    kind = category.get('kind')
    keys: List[str] = []
    for rec, row in cohort:
        hit = False
        if kind == 'coarse':
            name = category.get('name')
            for ms, ml, _a, _b, q, _n in row.groups.get('nucsz') or ():
                if q and _overlap(rec.molwins, ms + ml // 2, ms + ml // 2):
                    code = q[0] & 15
                    if (name == 'tf' and q[0] & 16) or (code < len(COARSE) and COARSE[code] == name):
                        hit = True
                        break
        elif kind == 'nrl':
            v = row.scalars.get('nrl')
            hit = v is not None and float(category.get('lo', -1e9)) <= v < float(category.get('hi', 1e9))
        elif kind == 'segment':
            want = {v: k for k, v in SEG_STATES.items()}.get(category.get('state'))
            hit = any(q and q[0] == want and _overlap(rec.molwins, ms, ms + ml)
                      for ms, ml, _a, _b, q, _n in row.groups.get('nucseg') or ())
        elif kind == 'event':
            want = {'undersized': 16, 'missing': 17}.get(category.get('name'))
            hit = any(q and q[0] == want and _overlap(rec.molwins, ms, ms + ml)
                      for ms, ml, _a, _b, q, _n in row.groups.get('nucseg') or ())
        else:
            raise ObservationError(f'Unknown category {kind!r}')
        if hit:
            keys.append(_read_key(rec))
    return dict(obsId=obs.get('obsId'), readIds=keys, molecules=len(cohort))
