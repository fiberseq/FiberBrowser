"""The regularity reference, cohort and share fixes (audit): one view-independent reference per dataset from its
calibration population (as fiberhmm-scan computes nucreg_reference), single flight and off the read path, used by
the panel and the nucpatch lane for every file of a multi-file dataset; per-width references for ends 'truncated';
the cohort parameter; share denominators; the panel adopting a scan's reference; no per-run BLAS limit in hub
association. Synthetic Hia5 molecules (tests/nuc_fixtures.py)."""
from __future__ import annotations

import threading
from types import SimpleNamespace as NS

import pytest

pysam = pytest.importorskip('pysam')
pytest.importorskip('fiberhmm.nuc.geometries')
pytest.importorskip('fiberhmm.scan.modules.nuc')

from nuc_fixtures import chromatin_bam

CONTIG, LENGTH = 'chrR', 160_000
SETTINGS = {'calibration': 'self', 'calibration_population': 400}
VIEW_A, VIEW_B = (20_000, 60_000), (90_000, 130_000)


def _obs(view, oid='o1'):
    return dict(obsId=oid, label='Synthetic', datasetId='ds0', kind='linear', chrom=CONTIG, start=view[0], end=view[1])


@pytest.fixture(scope='module')
def bams(tmp_path_factory):
    d = tmp_path_factory.mktemp('nuc_refmath')
    return [chromatin_bam(d / 'a.bam', contig=CONTIG, length=LENGTH, seed=21),
            chromatin_bam(d / 'b.bam', contig=CONTIG, length=LENGTH, seed=22)]


@pytest.fixture(scope='module')
def computed(bams, tmp_path_factory):
    import os
    from models.domain import Dataset
    from state.browser_state import BrowserState
    from services.nuc import jobs, nucgeo
    from services.nuc.regularity import clear_references
    from services.nuc.store import STORE
    old = os.environ.get('FIBERBROWSER_SCAN_CACHE_DIR')
    os.environ['FIBERBROWSER_SCAN_CACHE_DIR'] = str(tmp_path_factory.mktemp('nuc_refmath_cache'))
    STORE.clear(); clear_references(); nucgeo.clear()
    st = BrowserState(None)
    ds = Dataset('ds0', list(bams), label='Synthetic')
    ds.available_layers = {'footprint': True}
    st.datasets = {'ds0': ds}
    st.chroms = [NS(name=CONTIG, size=LENGTH)]
    for view in (VIEW_A, VIEW_B):
        job = jobs.submit(st, dict(datasets=['ds0'], chrom=CONTIG, start=view[0], end=view[1], parameters=SETTINGS,
                                   workers=2))
        assert jobs.wait(st, job['job_id'], timeout=900)['status'] == 'complete'
    yield st
    STORE.clear(); clear_references(); nucgeo.clear()
    if old is None:
        os.environ.pop('FIBERBROWSER_SCAN_CACHE_DIR', None)
    else:
        os.environ['FIBERBROWSER_SCAN_CACHE_DIR'] = old


def _ref(st, params=None):
    from fiberhmm.nuc.regularity import DEFAULT_REGULARITY
    from services.nuc import regularity as R
    from services.nuc.inputs import nuc_source
    from services.nuc.jobs import active_config
    return R.dataset_reference(nuc_source(st, 'ds0'), params or DEFAULT_REGULARITY, active_config(st, 'ds0'))


def test_reference_is_the_scans_calibration_population_reference_and_view_independent(computed):
    from fiberhmm.nuc.regularity import DEFAULT_REGULARITY
    from fiberhmm.scan.modules.nuc import nucreg_reference
    from fiberhmm.scan.reads import passes
    from services.nuc import nucgeo, reference as REF
    from services.nuc.engine import nuc_params
    from services.nuc.jobs import active_config
    b = nucgeo.geometry_analysis(computed, [_obs(VIEW_B)], patch_params={'min_share': 0.02})
    REF.clear()
    a = nucgeo.geometry_analysis(computed, [_obs(VIEW_A)], patch_params={'min_share': 0.02})
    assert a['references']['ds0'] == b['references']['ds0'] is not None
    # what fiberhmm-scan's calibration records as nucreg_reference: the calibration record's regions, its
    # population size, read filters, 3000 windows, seed 1
    cfg = active_config(computed, 'ds0')
    paths = computed.datasets['ds0'].paths
    regions = REF._regions(cfg, paths)
    assert regions
    filters = cfg.policy['filters']
    want = nucreg_reference(paths, nuc_params(cfg.settings), DEFAULT_REGULARITY, regions,
                            n_population=SETTINGS['calibration_population'], n_windows=3000, seed=1,
                            read_filter=lambda r: passes(r, filters))
    assert a['references']['ds0'] == pytest.approx(want.median, abs=1e-4)
    src = a['referenceSources']['ds0']
    assert src['kind'] == 'calibration' and src['files'] == 2 and src['usable']


def test_single_flight_and_never_on_the_read_path(computed, monkeypatch):
    from fiberhmm.nuc.regularity import RegularityParams
    from services.nuc import reference as REF
    from services.nuc.layers import injector
    from services.nuc.store import STORE
    calls = []
    real_compute = REF.compute

    def slow(*a, **k):
        calls.append(1)
        import time
        time.sleep(0.3)
        return real_compute(*a, **k)
    monkeypatch.setattr(REF, 'compute', slow)
    params = RegularityParams(step_bp=200)
    out = []
    threads = [threading.Thread(target=lambda: out.append(_ref(computed, params))) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(calls) == 1 and len({id(x) for x in out}) == 1
    # a read load naming the lane never computes: it only starts the registered dataset's reference in the
    # background (nothing to start for parameters nobody registered)
    REF.clear()
    calls.clear()
    path = computed.datasets['ds0'].paths[0]
    started = []
    monkeypatch.setattr(REF, 'request_background', lambda p, d8: started.append(d8) or False)
    sha, occ = sorted(STORE.rows_of(path))[0]
    inject = injector(path, VIEW_A[0], VIEW_A[1], include_layers=True, requested_layers=['nucreg'],
                      include_qualities=True, include_lift_meta=False)
    inject(dict(record_sha256=sha, alignment_occurrence=occ))
    assert not calls and started


def test_multi_file_dataset_one_reference_and_lane_labels_match_the_panel(computed):
    from services.nuc import nucgeo, reference as REF
    from services.nuc.store import STORE
    from services.nuc.inputs import real
    res = nucgeo.geometry_analysis(computed, [_obs(VIEW_A)], patch_params={'min_share': 0.02})
    assert res['geometries']
    pa, pb = computed.datasets['ds0'].paths
    from fiberhmm.nuc.regularity import DEFAULT_REGULARITY
    d8 = DEFAULT_REGULARITY.digest()[:8]
    assert REF._PATH_KEY[(real(pa), d8)] == REF._PATH_KEY[(real(pb), d8)]       # one reference for both files
    # file 2's lane: the panel's patches, with their geometry numbers
    labelled = 0
    keys = [k for k in STORE.rows_of(pb)]
    from services.nuc.layers import injector
    inject = injector(pb, VIEW_A[0], VIEW_A[1], include_layers=True, requested_layers=['nucpatch'],
                      include_qualities=True, include_lift_meta=False)
    for sha, occ in keys:
        row = dict(record_sha256=sha, alignment_occurrence=occ)
        inject(row)
        layer = (row.get('layers') or {}).get('nucpatch')
        if layer:
            labelled += sum(1 for g in layer['qualities'][3] if g > 0)
    assert labelled > 0
    # both files' labels come from patches called against the same reference and parameters
    assert nucgeo._GEO_OF[real(pa)][0] == nucgeo._GEO_OF[real(pb)][0]


def test_truncated_ends_read_cut_windows_against_their_own_width(computed):
    from services.nuc import nucgeo
    res = nucgeo.geometry_analysis(computed, [_obs(VIEW_A)], patch_params={'min_share': 0.02},
                                   reg_params={'ends': 'truncated'})
    src = res['referenceSources']['ds0']
    assert src['perWidth']
    ref = _ref(computed, __import__('fiberhmm.nuc.regularity', fromlist=['x']).RegularityParams(ends='truncated'))
    assert ref['width_deltas'] and min(float(v) for v in ref['width_deltas'].values()) < 0
    nucgeo.geometry_analysis(computed, [_obs(VIEW_A)], patch_params={'min_share': 0.02}, reg_params={})


def test_an_unusable_reference_is_never_accepted(computed, monkeypatch):
    from fiberhmm.nuc.regularity import RegularityParams
    from services.nuc import reference as REF
    # a population too sparse to score: not usable, no median, not stored
    ref = _ref(computed, RegularityParams(min_calls=100000))
    assert ref['usable'] is False and ref['median'] is None and ref['reason']
    assert not REF._file(ref['key']).is_file()


def test_cohort_parameter_and_share_denominators(computed):
    from services.nuc import nucgeo, regularity as R
    over = nucgeo.geometry_analysis(computed, [_obs(VIEW_A)], patch_params={'min_share': 0.02})
    span = nucgeo.geometry_analysis(computed, [_obs(VIEW_A)], patch_params={'min_share': 0.02}, cohort='spanning')
    legacy = nucgeo.geometry_analysis(computed, [_obs(VIEW_A)], patch_params={'min_share': 0.02}, spanning=True)
    assert over['params']['cohort'] == 'overlapping' and span['params']['cohort'] == 'spanning'
    assert span['nMolecules'] == legacy['nMolecules'] <= over['nMolecules']
    with pytest.raises(ValueError):
        R.resolve_cohort('some')
    assert set(over['shareDefinitions']) == {'fullShare', 'callableShare', 'densityMatched'}
    for g in over['geometries']:
        o = g['perObservation']['o1']
        # one dataset: the density-matched share is the plain callable share (the scan's share_dm)
        assert g['densityMatched']['ds0'] == pytest.approx(o['callableShare'], abs=1e-4)
        assert o['callableShare'] >= o['fullShare']


def test_the_panel_can_adopt_a_scans_reference(computed, monkeypatch):
    from services.nuc import nucgeo, reference as REF
    fake = [dict(scanId='s1', label='synthetic scan', dataset='dataset_1', median=2.5,
                 reference={'median': 2.5, 'params_digest': 'x'})]
    monkeypatch.setattr(REF, 'scan_references', lambda state, source, d8: fake)
    res = nucgeo.geometry_analysis(computed, [_obs(VIEW_A)], patch_params={'min_share': 0.02},
                                   ref_override={'ds0': 'scan:s1'})
    assert res['references']['ds0'] == 2.5 and res['referenceSources']['ds0']['kind'] == 'scan'
    assert res['scanReferences']['ds0'][0]['scanId'] == 's1'
    with pytest.raises(ValueError, match='No open scan'):
        nucgeo.geometry_analysis(computed, [_obs(VIEW_A)], patch_params={'min_share': 0.02},
                                 ref_override={'ds0': 'scan:nope'})
    nucgeo.geometry_analysis(computed, [_obs(VIEW_A)], patch_params={'min_share': 0.02})


def test_hub_association_changes_no_process_wide_blas_limit():
    from services.hub import assoc
    assert not hasattr(assoc, '_thread_limits')


# ---------------------------------------------------------------- second audit (verified here)
def test_patch_flags_follow_the_strand():
    from services.nuc.layers import flip_patch_flags
    assert flip_patch_flags(1) == 2 and flip_patch_flags(2) == 1
    assert flip_patch_flags(4) == 8 and flip_patch_flags(8 | 16) == 4 | 16
    assert flip_patch_flags(flip_patch_flags(1 | 8 | 16)) == 1 | 8 | 16


def test_live_patch_lane_flags_are_in_reference_orientation(computed):
    from services.nuc import nucgeo
    from services.nuc.layers import flip_patch_flags
    from services.nuc.store import STORE
    nucgeo.geometry_analysis(computed, [_obs(VIEW_A)], patch_params={'min_share': 0.02})
    path = computed.datasets['ds0'].paths[0]
    checked = 0
    for sha, occ in sorted(STORE.rows_of(path)):
        marks = nucgeo.marks_for_row(path, sha, occ, STORE.get(path, sha, occ), compute=True) or []
        if not marks:
            continue
        # the record's cached grid entry and patches (keys hold the record's sha and occurrence)
        e = next(v for k, v in nucgeo._GRIDS.items() if sha in k and occ in k)
        if not e['mol'].is_reverse:
            continue
        mp = next(v for k, v in reversed(list(nucgeo._PATCHES.items())) if sha in k and occ in k)
        kept = [p for p in mp.patches if p.end > p.start]
        for m, p in zip(marks, kept):
            assert m[4][2] == flip_patch_flags(p.flags)
            checked += 1
        if checked > 5:
            break
    assert checked


def test_score_histogram_covers_the_score_byte_range():
    from fiberhmm.nuc.regularity import SCORE_LO
    from services.nuc.regularity import SCORE_EDGES
    assert SCORE_EDGES[0] == SCORE_LO


def test_patch_parameters_clamp_extend_from_either_side():
    from services.nuc.nucgeo import parse_params
    p, _g, _v = parse_params({'enter': 1.0})
    assert p.extend == 1.0
    with pytest.raises(ValueError):
        parse_params(['x'])


def test_geometry_hit_ids_are_unique():
    from fiberhmm.nuc.geometries import Geometry
    from services.nuc.nucgeo import hit_ids
    a = Geometry('G1_a', 100, 900, False, False, 3, 3, [], 0, 0, 1.0, 190)
    b = Geometry('G2_b', 100, 900, False, False, 3, 3, [], 0, 0, 1.0, 190)
    c = Geometry('L1_c', 100, 900, False, False, 3, 3, [], 0, 0, 1.0, 190, kind='low')
    assert hit_ids([a, b, c]) == ['geometry:100-900', 'geometry:100-900:G2', 'geometry-low:100-900']


def test_low_patches_are_grouped_by_their_own_edges(computed):
    from services.nuc import nucgeo
    res = nucgeo.geometry_analysis(computed, [_obs(VIEW_A)],
                                   patch_params={'min_share': 0.02, 'edges': 'grid', 'low': {'edges': 'snap'}})
    assert res['params']['geometry']['snapped'] is False
    nucgeo.geometry_analysis(computed, [_obs(VIEW_A)], patch_params={'min_share': 0.02})


def test_a_dataset_without_a_computed_reference_reads_a_bound_scans(computed, monkeypatch):
    from services.nuc import nucgeo, reference as REF, regularity as R
    fake = [dict(scanId='s1', label='scan', dataset='dataset_1', median=2.7, reference={'median': 2.7})]
    monkeypatch.setattr(REF, 'scan_references', lambda state, source, d8: fake)
    monkeypatch.setattr(R, 'dataset_reference', lambda source, params, cfg, compute=True: None)
    res = nucgeo.geometry_analysis(computed, [_obs(VIEW_A)], patch_params={'min_share': 0.02, 'enter': 2.1})
    assert res['references']['ds0'] == 2.7 and res['referenceSources']['ds0']['kind'] == 'scan'
