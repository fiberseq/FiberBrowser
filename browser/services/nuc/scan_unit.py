"""Native nuc 2.2–2.4 unit tracks with identical phase and exact recurrence calculations.

This follows FiberHMM NucModule.run_unit 2.2. Batching groups molecules by their dyad count, so each
row's NumPy exp and sum see exactly the same values, length and reduction order as the scalar loop.
Groups share each molecule's period resultants, and integer coverage uses interval differences.
Recurrence reuses membership and prefix sums (recurrence.py) while preserving the exact null,
convolution order and tail reduction. Molecule order and every setting remain those of the scan module.
Only the live-output adapter uses this implementation, with versions 2.2–2.4 (the same unit protocol, with version-specific dyad eligibility). Equivalence
tests compare every unit track, regions, molecular tables and patch p/q against the stock module.
"""
from __future__ import annotations

from pathlib import Path
from typing import Dict, List
import numpy as np
from fiberhmm.scan.modules.nuc import ENRICH_KINDS, SEG_METRICS, _union_iv, _intersect_iv
from fiberhmm.scan.types import UnitResult


def phase_batches(xs):
    groups = {}
    for i, x in enumerate(xs):
        groups.setdefault(len(x), []).append(i)
    return [(ids, np.array([xs[i] for i in ids])) for ids in groups.values()]


def phase_resultants(batches, count, period, expectation):
    out = np.empty(count, dtype=np.complex128)
    for ids, values in batches:
        out[ids] = np.exp(2j * np.pi * values / period).sum(axis=1) - expectation * values.shape[1]
    return out


def run_unit(self, unit, inputs, settings, calibration, upstream, work: Path, progress) -> UnitResult:
    import pysam
    from fiberhmm.nuc.enrichment import grid_windows
    from .recurrence import WindowTrack as MeasuredTrack, window_tests
    from fiberhmm.nuc.segment import REGULAR
    from fiberhmm.scan.reads import record_ref
    params = self._params(settings)
    z0, z1 = unit.zone_start, unit.zone_end
    n = z1 - z0
    W, step = int(settings['phase_window_bp']), int(settings['phase_step_bp'])
    EW, Estep = int(settings['enrich_window_bp']), int(settings['enrich_step_bp'])
    reach = max(W, EW)
    haps = settings['groups'] == 'dataset+haplotype'
    filters = inputs.read_policy['filters']
    tracks: Dict[str, np.ndarray] = {}
    counts = {}

    def count(name, intervals):
        delta = counts.get(name)
        if delta is None:
            delta = counts[name] = np.zeros(n + 1, dtype=np.int64)
        for a, b in _union_iv(intervals):
            a, b = max(int(a), z0), min(int(b), z1)
            if b > a:
                delta[a - z0] += 1
                delta[b - z0] -= 1

    def arr(name):
        a = tracks.get(name)
        if a is None:
            a = np.zeros(n, dtype=np.float64)
            tracks[name] = a
        return a

    def mask(ivs):
        mk = np.zeros(n, dtype=bool)
        for a, b in ivs:
            a, b = max(int(a), z0), min(int(b), z1)
            if b > a:
                mk[a - z0:b - z0] = True
        return mk
    win_starts = [w for w in range((z0 + step - 1) // step * step, z1, step)]
    enr_starts = grid_windows(z0, z1, Estep)
    phase_windows = {}
    enr_tracks: List[MeasuredTrack] = []
    # a fixed group (and so track) set for every unit: territory runs
    # concatenate tracks by name, zone by zone
    groups_seen = ['all']
    for ds in inputs.datasets:
        groups_seen.append(ds.dataset_id)
        if haps:
            groups_seen += [f'{ds.dataset_id}:HP1', f'{ds.dataset_id}:HP2']
    for ds in inputs.datasets:
        cal = self._cal(calibration, ds.dataset_id)
        for i, path in enumerate(ds.paths):
            with pysam.AlignmentFile(path, 'rb') as bam:
                if unit.chrom not in bam.references:
                    continue
                for read, _sha, _occ in self._iter_records(bam, unit.chrom, z0, z1 + reach, filters):
                    if read.is_supplementary:
                        continue
                    record = record_ref(read, ds, i, _sha, _occ, unit.chrom)
                    mol, res, _mr = self._record_outputs(read, record, settings, calibration)
                    if mol is None:
                        continue
                    if res.flags.get('low_information') or not res.segments:
                        # below the floor (D8), too short or nothing to segment:
                        # not measured anywhere
                        continue
                    grp = ['all', ds.dataset_id]
                    if haps and mol.hp in (1, 2):
                        grp.append(f'{ds.dataset_id}:HP{mol.hp}')
                    # reference intervals: aligned blocks; segment and event envelopes
                    blocks = [(int(r0), int(r0 + ln)) for _q0, r0, ln in mol.blocks] \
                        if mol.blocks is not None else []
                    from fiberhmm.nuc.scan import measured_track
                    measured, kind_ref = measured_track(mol, res)
                    q_ref = []
                    for sgm in res.segments:
                        env = mol.mol_interval_to_ref(sgm.start, sgm.end)
                        if env is not None and sgm.state == REGULAR and sgm.q_hat:
                            q_ref.append((int(env[0]), int(env[1]), float(sgm.q_hat)))
                    meas = mask(measured)
                    regular = mask(kind_ref['reg']) & meas
                    covered = {k: _intersect_iv(_union_iv(kind_ref[k]), _union_iv(blocks) if k == 'low' else measured)
                               for k in SEG_METRICS}
                    qsum = np.zeros(n)
                    for a, b, q in q_ref:
                        a, b = max(a, z0), min(b, z1)
                        if b > a:
                            qsum[a - z0:b - z0] = q
                    for g in grp:
                        count(f'measured:{g}', measured)
                        for k in SEG_METRICS:
                            count(f'{k}:{g}', covered[k])
                        arr(f'qsum:{g}')[regular] += qsum[regular]
                    # recurrence test: the molecule's measured bases and kinds
                    t = MeasuredTrack(measured)
                    for k in ENRICH_KINDS:
                        t.set_kind(k, kind_ref[k])
                    enr_tracks.append(t)
                    # dyads for phased windows: molecular positions of observed mono
                    # dyads (distances are measured along the molecule; the
                    # reference position only decides window membership)
                    fp = res.footprints
                    if fp is not None:
                        if str(self.version) == '2.4':
                            from fiberhmm.nuc.spacing import footprint_dyad_mask
                            sel = footprint_dyad_mask(fp, cal.nrl_pooled, params)
                        else:
                            from fiberhmm.nuc.sizes import MONO
                            sel = (fp['coarse'] == MONO) & ~fp['is_tf'] & ~fp['truncated']
                        c = ((fp['start'][sel] + fp['end'][sel]) / 2.0)
                        ref = mol.mol_to_ref(np.round(c).astype(np.int64)) if len(c) else np.zeros(0, np.int64)
                        ok = ref >= 0
                        c, ref = c[ok], ref[ok]
                        eligible = np.asarray([w for w in win_starts
                                               if mol.ref_start <= w and mol.ref_end >= w + W], dtype=np.int64)
                        anchors = mol.ref_to_mol(eligible) if len(eligible) else []
                        sgn = -1.0 if mol.is_reverse else 1.0
                        for w, a in zip(eligible, anchors):
                            if a < 0:
                                continue
                            inw = (ref >= w) & (ref < w + W)
                            if not inw.any():
                                continue
                            x = sgn * (c[inw] - int(a))
                            for g in grp:
                                phase_windows.setdefault((g, int(w)), []).append(x)
    for name, delta in counts.items():
        tracks[name] = np.cumsum(delta[:-1]).astype(np.float64)
    # fixed-grid phased windows written by the zone holding the window start
    qgrid = np.arange(165.0, 216.0, 1.0)
    from fiberhmm.nuc.phasing import uniform_expectation
    phase_tracks = {g: tuple(np.full(n, np.nan) for _ in range(6)) for g in groups_seen}
    for w in win_starts:
        xs = phase_windows.get(('all', w), [])
        if len(xs) < int(settings['patch_min_measured']):
            continue
        batches = phase_batches(xs)
        lengths = np.fromiter(map(len, xs), dtype=np.int64, count=len(xs))
        positions = {id(x): i for i, x in enumerate(xs)}
        # Each molecule occurs in pooled, dataset and possibly haplotype groups. Its per-period
        # resultant is identical in all of them; retain only this window's 51-period matrix.
        values = np.array([phase_resultants(batches, len(xs), P, uniform_expectation(0.0, float(W), P))
                           for P in qgrid])
        # Scalar complex abs and vector np.abs round differently on some NumPy builds. Preserve
        # the scalar operation used by the stock period search, then share those exact values.
        strength = np.array([np.fromiter(map(abs, row), dtype=np.float64, count=len(xs)) / lengths
                             for row in values])
        for g in groups_seen:
            members = phase_windows.get((g, w), [])
            if len(members) < int(settings['patch_min_measured']):
                continue
            ids = np.fromiter((positions[id(x)] for x in members), dtype=np.int64, count=len(members))
            best = int(np.argmax([np.mean(row[ids]) for row in strength]))
            V = values[best, ids]
            N = float(sum(len(x) for x in members))
            S = abs(V.sum())
            var = float(np.sum(np.abs(V) ** 2))
            k = w - z0
            Rt, Nt, nullt, logpt, Pt, Ct = phase_tracks[g]
            Rt[k] = S / N
            nullt[k] = np.sqrt(np.pi / 4.0 * var) / N
            logpt[k] = -(S * S) / var if var > 0 else 0.0
            Nt[k] = len(members)
            Pt[k] = qgrid[best]
            tot = float(np.abs(V).sum())
            Ct[k] = S / tot if tot > 0 else np.nan
    for g, arrays in phase_tracks.items():
        for name, array in zip(('R', 'n', 'null', 'logp', 'P', 'C'), arrays):
            tracks[f'phase_{name}:{g}'] = array
    # recurrence windows (pooled over every measured molecule): exact
    # shift-null p per window start, written by the zone holding the start
    K = int(settings['enrich_levels'])
    min_mol = int(settings['enrich_min_molecules'])
    tested = window_tests(enr_tracks, ENRICH_KINDS, enr_starts, EW, K, min_mol)
    for kind in ENRICH_KINDS:
        Pv, Ov, Ev, Nv = (np.full(n, np.nan) for _ in range(4))
        for w, r in zip(enr_starts, tested[kind]):
            if r is None:
                continue
            k = w - z0
            Pv[k], Ov[k], Ev[k], Nv[k] = r['p'], r['obs'], r['exp'], r['n']
        tracks[f'enr_p:{kind}'] = Pv
        tracks[f'enr_obs:{kind}'] = Ov
        tracks[f'enr_exp:{kind}'] = Ev
        tracks[f'enr_n:{kind}'] = Nv
    for g in groups_seen:
        arr(f'measured:{g}')
        for k in SEG_METRICS + ('qsum',):
            arr(f'{k}:{g}')
    return UnitResult(status='ok', tracks=tracks, extra={'groups': groups_seen})

