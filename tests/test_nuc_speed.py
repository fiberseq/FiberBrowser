"""Behavior-preserving caches for value clicks and the ordinary region-discovery scan."""
from __future__ import annotations

import copy
from dataclasses import replace

import pytest

pytest.importorskip('pysam')
pytest.importorskip('fiberhmm.scan.modules.nuc')

from test_nuc_patches import bam, computed, _state, CONTIG, LENGTH, OBS, SETTINGS


def test_summary_cohort_is_reused_and_invalidated(computed, monkeypatch):
    import services.nuc.observations as observations
    from services.nuc.inputs import browser_read_policy
    from services.nuc.store import STORE
    policy = browser_read_policy(computed)
    computed.__dict__.pop('_nuc_cohorts', None)
    first = observations.observation_cohort(computed, OBS, policy)
    original = observations.resolve
    calls = []
    def resolve(*args):
        calls.append(True)
        return original(*args)
    monkeypatch.setattr(observations, 'resolve', resolve)
    assert observations.observation_cohort(computed, dict(OBS), policy) is first
    assert not calls
    observations.observation_cohort(computed, {**OBS, 'readIds': []}, policy)
    observations.observation_cohort(computed, {**OBS, 'strand': 'CT'}, policy)
    observations.observation_cohort(computed, OBS, browser_read_policy(computed, include_duplicates=True))
    assert len(calls) == 3
    rec, row = first[4][0]
    cfg = first[3].config_for(rec.path)
    STORE.put(rec.path, cfg, [((rec.sha, rec.occ), replace(row))])
    refreshed = observations.observation_cohort(computed, OBS, policy)
    assert refreshed is not first and len(calls) == 4
    STORE.put(rec.path, cfg, [((rec.sha, rec.occ), row)])
    STORE.put_failed(rec.path, cfg, [(('new-failure', 0), 'no_calls')])
    observations.observation_cohort(computed, OBS, policy)
    assert len(calls) == 5
    STORE.clear()
    absent = observations.observation_cohort(computed, OBS, policy)
    assert absent[5]['missing'] > 0 and len(calls) == 6
    # Restore this module fixture for the other tests.
    from services.nuc import jobs
    job = jobs.submit(computed, dict(datasets=['ds0'], chrom=CONTIG, start=0, end=LENGTH,
                                     parameters=SETTINGS, workers=2))
    assert jobs.wait(computed, job['job_id'], timeout=900)['status'] == 'complete'


def test_subwindow_records_equal_bam_resolution(computed):
    import services.nuc.live as live
    from services.nuc.inputs import browser_read_policy, nuc_source
    policy, source = browser_read_policy(computed), nuc_source(computed, 'ds0')
    live._views.clear()
    live.view_records(source, [(CONTIG, 0, LENGTH)], policy)
    for a, b in [(20000, 27000), (22000, 22500), (0, 1), (LENGTH-1, LENGTH)]:
        warm = live.view_records(source, [(CONTIG, a, b)], policy)
        saved = live._views.copy()
        live._views.clear()
        cold = live.view_records(source, [(CONTIG, a, b)], policy)
        live._views.clear()
        live._views.update(saved)
        assert warm == cold


def test_a_remembered_view_extended_to_the_right_equals_bam_resolution(computed, monkeypatch):
    import services.nuc.live as live
    from services.nuc.inputs import browser_read_policy, nuc_source
    policy, source = browser_read_policy(computed), nuc_source(computed, 'ds0')
    for first, (a, b) in [((10000, 30000), (10000, 30001)), ((10000, 30000), (15000, 52000)),
                          ((0, 20000), (19999, LENGTH))]:
        live._views.clear()
        live.view_records(source, [(CONTIG, *first)], policy)
        fetched = []
        original = live._extend_view
        monkeypatch.setattr(live, '_extend_view', lambda *args: fetched.append(args[5:7]) or original(*args))
        wins = [(CONTIG, a, b), (CONTIG, a + 100, a + 900)]
        warm = live.view_records(source, [(CONTIG, a, b)], policy, windows=wins)
        assert fetched == [(first[1], b)]          # only the new span was read
        monkeypatch.setattr(live, '_extend_view', original)
        live._views.clear()
        cold = live.view_records(source, [(CONTIG, a, b)], policy, windows=wins)
        assert warm == cold and len(warm) > 10


def test_region_discovery_and_patch_scores_equal_without_reuse(computed, tmp_path, monkeypatch):
    """The same regions, scores, exact recurrence p/q values and molecular tables as the stock scan."""
    from fiberhmm.scan import run_units
    from fiberhmm.scan.types import ScanUnit
    from services.scan.planning import build_plan
    from services.nuc.scan import live_registry
    from services.nuc.patches import patch_scores
    from services.nuc.inputs import browser_read_policy
    from services.nuc.observations import observation_cohort
    from services.nuc.store import STORE
    from services.scan.registry import open_scan, close_scan
    from services.scan.serve import hits_for_view
    from services.scan.tables import iter_rows
    request = dict(datasets=['ds0'], scope='view', chrom=CONTIG, start=20000, end=32000,
                   modules=['nuc'], parameters={'nuc': SETTINGS})
    plan = build_plan(computed, request)
    module = plan['modules'][0]
    registry = live_registry(computed, plan, module)
    assert registry is not None
    units = [ScanUnit.from_json(u) for u in plan['units']]
    datasets = [dict(dataset_id=d['dataset_id'], paths=d['paths'], chemistry=d['chemistry']) for d in plan['datasets']]
    baseline, fast = tmp_path/'baseline', tmp_path/'fast'
    common = dict(modules=['nuc'], params={'nuc': SETTINGS}, read_policy=plan['raw_read_policy'],
                  annotate=False, cores=2, window_jobs=1)
    run_units(datasets, (units, plan['units_info']), out=baseline, **common)
    # Every fixture record is already stored. Prove the fast scan cannot decode/recompute one or recalibrate.
    from fiberhmm.scan.modules.nuc import NucModule
    def forbidden(*a, **kw):
        pytest.fail('a live record or calibration was recomputed')
    with monkeypatch.context() as m:
        m.setattr(NucModule, '_record_outputs', forbidden)
        m.setattr(NucModule, 'calibrate', forbidden)
        run_units(datasets, (units, plan['units_info']), out=fast, registry=registry, **common)
    import numpy as np
    for path in (baseline/'work/nuc').glob('*/tracks.npz'):
        with np.load(path) as expected, np.load(fast/path.relative_to(baseline)) as actual:
            assert set(expected.files) == set(actual.files)
            for key in expected.files:
                np.testing.assert_array_equal(actual[key], expected[key], err_msg=key)
    def hits(path):
        scan = open_scan(computed, path)
        try:
            return [h for h in hits_for_view(scan, 'nuc', CONTIG, 0, LENGTH)['hits']
                    if h['typeId'].startswith('nuc.patch.')]
        finally:
            close_scan(computed, scan.scan_id)
    assert hits(baseline) == hits(fast)
    for table in ('molecules', 'marks'):
        assert list(iter_rows(baseline/f'nuc/{table}.tsv.bgz')) == list(iter_rows(fast/f'nuc/{table}.tsv.bgz'))
    hs = hits(baseline)
    assert hs
    patches = [dict(key=str(i), type=h['typeId'].rsplit('.',1)[1], chrom=h['chrom'], start=h['start'], end=h['end'])
               for i, h in enumerate(hs)]
    # Include overlapping windows and multiple tests of each kind, so PMF reuse and BH are exercised.
    patches += [dict(key=f'extra-{kind}-{i}', type=kind, chrom=CONTIG, start=a, end=b)
                for kind in ('regular','disordered','undersized','missing')
                for i,(a,b) in enumerate(((21000,22500),(22000,23500),(24000,25000)))]
    obs = {**OBS, 'start':0, 'end':LENGTH}
    cohort = observation_cohort(computed, obs, browser_read_policy(computed))
    import services.nuc.patches as patch_module
    original = patch_module.molecule_track
    live = {id(row): STORE.get_result(rec.path,rec.sha,rec.occ,cohort[3].config_for(rec.path))
            for rec,row in cohort[4]}
    def reference_track(row, mol=None, blocks=(), result=None):
        hit = live[id(row)]
        return original(row, hit[0], blocks, hit[1])
    with monkeypatch.context() as m:
        m.setattr(patch_module, 'molecule_track', reference_track)
        expected = patch_scores(computed, [obs], patches)
    assert patch_scores(computed, [obs], patches) == expected
    # Changing settings or the read policy must decline live reuse.
    incompatible = copy.deepcopy(module)
    incompatible['settings']['params']['min_nucs'] = 999
    assert live_registry(computed, plan, incompatible) is None
    incompatible_plan = {**plan, 'raw_read_policy': {'filters': {'duplicates':'include'}}}
    assert live_registry(computed, incompatible_plan, module) is None


def test_cached_geometry_keeps_cigar_strand_occurrences_filters_and_contig_aliases(tmp_path):
    import pysam
    from services.nuc.inputs import nuc_source
    from services.nuc.live import view_records, _views
    from fiberhmm.scan.reads import resolve_read_policy
    path = tmp_path/'geometry.bam'
    with pysam.AlignmentFile(path, 'wb', header={'HD':{'SO':'coordinate'},
            'SQ':[{'SN':'chr1','LN':10000},{'SN':'1','LN':10000}]}) as out:
        for tid in (0,1):
            for i,flag in enumerate((0,0,16,2048,1024,256)):
                r = pysam.AlignedSegment(out.header)
                r.query_name = f'r{tid}-{i if i > 1 else 0}'  # two byte-identical occurrences
                r.flag, r.reference_id, r.reference_start, r.mapping_quality = flag, tid, 100, 60
                r.cigarstring = '5S20M7I15M30D10M20N15M5S'
                r.query_sequence = 'A'*77
                r.set_tag('st', 'CT' if flag & 16 else 'GA')
                out.write(r)
    pysam.index(str(path))
    source = nuc_source(_state(str(path)), 'ds0')
    for policy in (resolve_read_policy({}), resolve_read_policy({'filters':{'duplicates':'include'}})):
        for chrom in ('chr1','1'):
            _views.clear()
            view_records(source, [(chrom,0,1000)], policy)
            for a,b in ((95,108),(125,130),(140,170),(180,210),(300,310)):
                wins = [(chrom,a,b),('1',120,180)]
                expected_cache = _views.copy()
                actual = view_records(source, [(chrom,a,b)], policy, windows=wins)
                _views.clear()
                expected = view_records(source, [(chrom,a,b)], policy, windows=wins)
                _views.clear()
                _views.update(expected_cache)
                assert actual == expected


def test_batched_phase_resultants_preserve_each_reduction_bit_for_bit():
    import numpy as np
    from fiberhmm.nuc.phasing import uniform_expectation
    from services.nuc.scan_unit import phase_batches, phase_resultants
    rng = np.random.default_rng(42)
    xs = [rng.uniform(-1500,1500,size=n) for n in rng.integers(1,40,size=1000)]
    batches = phase_batches(xs)
    for p in np.arange(165.,216.):
        eu = uniform_expectation(0.,1200.,p)
        expected = np.array([np.exp(2j*np.pi*x/p).sum()-eu*len(x) for x in xs])
        np.testing.assert_array_equal(phase_resultants(batches,len(xs),p,eu), expected)


def test_recurrence_grid_matches_stock_with_gaps_and_custom_levels():
    import numpy as np
    from fiberhmm.nuc.enrichment import MeasuredTrack, window_test
    from services.nuc.recurrence import WindowTrack, window_tests
    rng = np.random.default_rng(731)
    kinds = ('reg', 'dis', 'uds', 'mis')
    for K in (1, 3, 10, 17):
        baseline, fast = [], []
        for i in range(36):
            start = int(rng.integers(0, 800))
            measured = [(start, start + 130), (start + 150, start + 400), (start + 500, start + 1100)]
            a, b = MeasuredTrack(measured), WindowTrack(measured)
            for kind in kinds:
                # Include deterministic nulls, interval gaps, partial coverage and many PMF lengths.
                marks = [] if i % 5 == 0 else measured if i % 5 == 1 else [
                    (int(s), int(s + rng.integers(1, 130))) for s in rng.integers(start, start + 1000, size=5)]
                a.set_kind(kind, marks)
                b.set_kind(kind, marks)
            baseline.append(a)
            fast.append(b)
        starts = list(range(0, 2000, 41))
        got = window_tests(fast, kinds, starts, 250, K, 3)
        for kind in kinds:
            for w, actual in zip(starts, got[kind]):
                assert actual == window_test(baseline, kind, w, w + 250, K, 3)
        # An insufficient cohort remains untested, including an empty window grid.
        assert window_tests([], kinds, starts, 250, K, 3)['reg'] == [None] * len(starts)
        assert window_tests(fast, kinds, [], 250, K, 3)['reg'] == []


def test_compact_convolution_preserves_tail_reduction_and_underflow():
    import numpy as np
    from services.nuc.recurrence import tail_probability
    rng = np.random.default_rng(881)
    pmfs, expected = [], np.ones(1)
    for i in range(1400):
        p = rng.random(11)
        p[rng.random(11) < 0.7] = 0
        if i % 3 or not p.any():
            p[:] = 0
            p[i % 11] = 1
        p /= p.sum()
        nz = np.flatnonzero(p)
        pmfs.append((p, 0., int(nz[0]), int(nz[-1])))
        expected = np.convolve(expected, p)
    for obs in (0, 2000, 7000, 8000, len(expected) - 1):
        assert tail_probability(pmfs, obs) == float(min(1., expected[obs:].sum()))


