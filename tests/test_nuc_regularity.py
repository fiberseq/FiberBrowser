"""Nucleosome regularity (FiberHMM nucreg) in the browser: the live layer, its parameters kept apart from the nuc
settings and calibration, the random-packing reference, the Regularity view (/api/nuc/regularity), the nuc.reg
cluster modes and the nuc.reg.* molecule metrics. Synthetic Hia5 molecules (tests/nuc_fixtures.py)."""
from __future__ import annotations

from types import SimpleNamespace as NS

import numpy as np
import pytest

pysam = pytest.importorskip('pysam')
pytest.importorskip('fiberhmm.nuc.regularity')
pytest.importorskip('fiberhmm.scan.modules.nuc')

from nuc_fixtures import chromatin_bam

CONTIG, LENGTH = 'chrR', 160_000
SETTINGS = {'calibration': 'self', 'calibration_population': 400}
VIEW = (20_000, 60_000)
OBS = dict(obsId='o1', label='Synthetic', datasetId='ds0', kind='linear', chrom=CONTIG, start=VIEW[0], end=VIEW[1])


@pytest.fixture(scope='module')
def bam(tmp_path_factory):
    return chromatin_bam(tmp_path_factory.mktemp('nuc_reg') / 'chromatin.bam', contig=CONTIG, length=LENGTH)


def _state(bam):
    from models.domain import Dataset
    from state.browser_state import BrowserState
    st = BrowserState(None)
    ds = Dataset('ds0', bam, label='Synthetic')
    ds.available_layers = {'footprint': True}
    st.datasets = {'ds0': ds}
    st.chroms = [NS(name=CONTIG, size=LENGTH)]
    return st


@pytest.fixture(scope='module')
def computed(bam, tmp_path_factory):
    import os
    from services.nuc import jobs
    from services.nuc.regularity import clear_references
    from services.nuc.store import STORE
    old = os.environ.get('FIBERBROWSER_SCAN_CACHE_DIR')
    os.environ['FIBERBROWSER_SCAN_CACHE_DIR'] = str(tmp_path_factory.mktemp('nuc_reg_cache'))
    # these tests follow the reference from the panel's first request (the read path never computes it): no
    # reference started by the Analyse (services.nuc.reference.PREFETCH_ON_ANALYSE)
    from services.nuc import reference as _ref
    _prefetch, _ref.PREFETCH_ON_ANALYSE = _ref.PREFETCH_ON_ANALYSE, False
    STORE.clear()
    clear_references()
    st = _state(bam)
    job = jobs.submit(st, dict(datasets=['ds0'], chrom=CONTIG, start=VIEW[0], end=VIEW[1], parameters=SETTINGS,
                               workers=2))
    assert jobs.wait(st, job['job_id'], timeout=900)['status'] == 'complete'
    _ref.PREFETCH_ON_ANALYSE = _prefetch
    yield st
    STORE.clear()
    clear_references()
    if old is None:
        os.environ.pop('FIBERBROWSER_SCAN_CACHE_DIR', None)
    else:
        os.environ['FIBERBROWSER_SCAN_CACHE_DIR'] = old


def _rows(st):
    from services.nuc.store import STORE
    return STORE.rows_of(st.datasets['ds0'].paths[0])


def test_regularity_parameters_never_change_the_nuc_settings_hash():
    from services.nuc.engine import resolve_settings
    _s0, h0 = resolve_settings(SETTINGS)
    _s1, h1 = resolve_settings({**SETTINGS, 'nucreg': {'window_bp': 1500, 'signal': 'occupancy'}})
    assert h0 == h1


def test_a_compute_never_computes_regularity(computed):
    from services.nuc.regularity import _TILES, dataset_params
    from fiberhmm.nuc.regularity import DEFAULT_REGULARITY
    rows = _rows(computed)
    assert len(rows) > 50
    assert dataset_params(computed, 'ds0') == DEFAULT_REGULARITY
    assert not any(r.groups.get('nucreg') for r in rows.values())
    assert all(r.regularity_digest == '' for r in rows.values())
    path = computed.datasets['ds0'].paths[0]
    from services.nuc.inputs import real
    assert not any(k[0] == real(path) for k in list(_TILES))


def _inject(path, sha, occ, requested):
    from services.nuc.layers import injector
    inject = injector(path, VIEW[0], VIEW[1], include_layers=True, requested_layers=requested, include_qualities=True,
                      include_lift_meta=False)
    row = dict(record_sha256=sha, alignment_occurrence=occ)
    inject(row)
    return row


def test_layer_rows_get_tiles_only_when_the_layer_is_asked_for(computed):
    from fiberhmm.nuc.regularity import DEFAULT_REGULARITY, decode_score
    from services.nuc.layers import NUCREG_REF_KEY
    from services.nuc.regularity import cached_tiles, reference_for_path
    from services.nuc.store import STORE
    path = computed.datasets['ds0'].paths[0]
    d8 = DEFAULT_REGULARITY.digest()[:8]
    keys = sorted(STORE.rows_of(path))
    (sha, occ) = keys[len(keys) // 2]
    # A load of every layer (clustering, peak scans) uses cached tiles only: none yet, nothing computed.
    row = _inject(path, sha, occ, None)
    assert 'nucreg' not in row['layers'] and cached_tiles(path, sha, occ, d8) is None
    # A load naming the layer computes this row's tiles, never the reference (off the read path: the lane uses
    # its fallback scale until the dataset's reference exists).
    row = _inject(path, sha, occ, ['nucreg'])
    layer = row['layers']['nucreg']
    assert layer['quality_names'] == ['score', 'period']
    assert not layer['scale']['reference'] and reference_for_path(path, d8) is None
    # The panel computes the dataset's reference (its calibration population); later loads carry its scale.
    from services.nuc import regularity as R
    from services.nuc.inputs import nuc_source
    from services.nuc.jobs import active_config
    R.dataset_reference(nuc_source(computed, 'ds0'), DEFAULT_REGULARITY, active_config(computed, 'ds0'))
    row = _inject(path, sha, occ, ['nucreg'])
    layer = row['layers']['nucreg']
    assert layer['scale']['reference'] and layer['scale']['top'] > layer['scale']['zero']
    assert row[NUCREG_REF_KEY] == pytest.approx(layer['scale']['zero'], abs=1e-3)
    marks = cached_tiles(path, sha, occ, d8)
    assert marks and all(m[1] == DEFAULT_REGULARITY.step_bp and m[5].split('@')[1].split('_')[0].endswith('.' + d8) for m in marks)
    ref = reference_for_path(path, d8)
    assert ref['n_windows'] > 0 and ref['observed_p95'] > ref['median']
    # The synthetic arrays are regular: most tiles score above random packing.
    assert np.median([decode_score(m[4][0]) for m in marks]) > ref['median']
    # Now cached: a load of every layer carries it too.
    assert 'nucreg' in _inject(path, sha, occ, None)['layers']
    from services.nuc.scalars import metric_value
    med, mx, frac = (metric_value(row, m) for m in ('nuc.reg.median', 'nuc.reg.max', 'nuc.reg.frac_above_ref'))
    assert med is not None and mx >= med and 0 <= frac <= 1


def test_a_cluster_column_computes_missing_tiles(computed):
    from services.clustering_features import _weighted_intervals_for_mode
    from services.nuc.inputs import real
    from services.nuc.store import STORE
    path = computed.datasets['ds0'].paths[0]
    keys = sorted(STORE.rows_of(path))
    sha, occ = keys[len(keys) // 3]
    read = {'id': 'x', 'library_id': real(path), 'record_sha256': sha, 'alignment_occurrence': occ,
            'intervals': [[0, VIEW[1] - VIEW[0], -1]], 'layers': {}}
    ivs = _weighted_intervals_for_mode(read, 'nuc.reg', [], 90, region_start=VIEW[0])
    assert ivs and any(abs(v - 0.5) > 1e-6 for _a, _b, v in ivs)


def test_the_regularity_view_and_a_parameter_change_without_recalibration(computed, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers.nuc import router
    from state.dependencies import get_state
    from services.nuc import calibration, live
    from services.nuc.store import STORE

    def unexpected(*_a, **_k):
        raise AssertionError('a regularity change must not recalibrate or recompute nucleosome outputs')
    monkeypatch.setattr(calibration, 'compute_calibration', unexpected)
    monkeypatch.setattr(live, 'record_outputs', unexpected)
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_state] = lambda: computed
    path = computed.datasets['ds0'].paths[0]
    with TestClient(app) as client:
        r = client.post('/api/nuc/regularity', json=dict(observations=[OBS]))
        assert r.status_code == 200, r.text
        res = r.json()
        o = res['observations'][0]
        assert 'error' not in o, o
        assert o['molecules'] > 20 and o['scores']['n'] > 100
        assert sum(o['periods']['counts']) > 0
        assert o['acf']['mean'] and o['acf']['mean'][0] == pytest.approx(1.0)
        assert o['scatter']['n'] > 10 and o['scatter']['spearman'] is not None
        s = o['summary']
        assert 150 < s['repeatLength'] < 230 and s['scoreAboveRef'] > 0 and s['footprintMedian'] > 0
        assert any(v is not None for v in o['track']['mean'])
        # the tiles computed for this view move the rows' regularity identity (nothing else)
        assert res['updatedDatasets'] in ([], ['ds0'])
        src = res['datasets']['ds0']['source']
        assert src['kind'] == 'calibration' and src['population'] == SETTINGS['calibration_population']
        assert res['cohort'] == 'overlapping'
        again = client.post('/api/nuc/regularity', json=dict(observations=[OBS])).json()
        assert again['updatedDatasets'] == [] and again['observations'] == res['observations']
        from services.nuc.regularity import revision
        before, store_before = revision(path), STORE.revision(path)
        # A parameter change selects other tiles (record_outputs/compute_calibration would raise).
        r2 = client.post('/api/nuc/regularity', json=dict(observations=[OBS], parameters={'signal': 'occupancy',
                                                                                          'mask_open_bp': 0}))
        assert r2.status_code == 200, r2.text
        res2 = r2.json()
        assert res2['updatedDatasets'] == ['ds0']
        assert res2['datasets']['ds0']['params']['signal'] == 'occupancy'
        assert revision(path) != before and STORE.revision(path) == store_before
        assert res2['observations'][0]['summary']['score'] != o['summary']['score']
        # The same request again is a cached response.
        import time
        t = time.time()
        assert client.post('/api/nuc/regularity', json=dict(observations=[OBS])).json()['observations'] == res2['observations']
        assert time.time() - t < 1.0
        # Spanning only: fewer (or as many) molecules.
        r3 = client.post('/api/nuc/regularity', json=dict(observations=[OBS], spanning=True)).json()
        assert r3['observations'][0]['molecules'] <= res2['observations'][0]['molecules']
        assert client.post('/api/nuc/regularity', json=dict(observations=[OBS], parameters={'band_bp': [140, 400]})).status_code == 422
        assert client.post('/api/nuc/regularity', json={}).status_code == 422
        # Back to the defaults for the other tests.
        assert client.post('/api/nuc/regularity', json=dict(observations=[OBS], parameters={})).status_code == 200


def test_regularity_moves_only_the_regularity_identity_and_keeps_ordinary_rows_cached(computed):
    """Tiles computed for a view change rows carrying nucreg only: the dataset's source identity (which reloads every
    panel, the nucleosome panel's summaries and the graph) stays, and cached rows without nucreg stay warm."""
    from services.nuc.regularity import regularity_analysis
    from services.working_sets import make_working_cache_key
    ds = computed.datasets['ds0']
    before = ds.to_dict()
    assert before['regularity_identity']
    computed._working_set_cache = getattr(computed, '_working_set_cache', {}) or {}
    ordinary = make_working_cache_key('ds0', CONTIG, *VIEW, False, 0, 0, False, ('nuc', 'nucseg', 'nucsz', 'tf'), [])
    regular = make_working_cache_key('ds0', CONTIG, *VIEW, False, 0, 0, False, ('nuc', 'nucreg', 'tf'), [])
    computed._working_set_cache[ordinary] = ([], 0)
    computed._working_set_cache[regular] = ([], 0)
    try:
        res = regularity_analysis(computed, [OBS], params={'signal': 'occupancy', 'mask_open_bp': 0})
        assert res['updatedDatasets'] == ['ds0']
        after = ds.to_dict()
        assert after['source_identity'] == before['source_identity']
        assert after['regularity_identity'] != before['regularity_identity']
        assert ordinary in computed._working_set_cache and regular not in computed._working_set_cache
    finally:
        computed._working_set_cache.pop(ordinary, None)
        regularity_analysis(computed, [OBS], params={})


def test_cluster_observations_split_by_read_ids(computed):
    from services.nuc.regularity import regularity_analysis
    rows = _rows(computed)
    names = sorted({r.qname for r in rows.values()})
    half = len(names) // 2
    obs = [dict(OBS, obsId='c0', readIds=names[:half], cluster=0), dict(OBS, obsId='c1', readIds=names[half:], cluster=1)]
    res = regularity_analysis(computed, obs)
    a, b = res['observations']
    assert a['cluster'] == 0 and b['cluster'] == 1
    assert 0 < a['molecules'] and 0 < b['molecules']
    assert a['molecules'] + b['molecules'] <= len(names)
    # Along the region, each cluster also carries the mean local repeat length per bin (cluster metaprofiles).
    for o in (a, b):
        track = o['track']
        assert len(track['period']) == len(track['mean']) == len(track['edges']) - 1
        known = [v for v in track['period'] if v is not None]
        assert known and all(100 < v < 400 for v in known)
        assert all((p is None) == (m is None) or m is not None for p, m in zip(track['period'], track['mean']))
    assert 'perMolecule' not in a
    # Per molecule (the cluster map's regularity colours): median <= max per scored molecule, keyed by QNAME.
    res2 = regularity_analysis(computed, obs, per_molecule=True)
    for o, ids in zip(res2['observations'], (names[:half], names[half:])):
        per = o['perMolecule']
        assert len(per) == o['scored'] > 0 and set(per) <= set(ids)
        assert all(med <= mx for med, mx in per.values())


def _fake_read(scores, ref=3.0, body=(0, 2000)):
    from fiberhmm.nuc.regularity import encode_score
    ivs = [[i * 250, (i + 1) * 250, 250] for i in range(len(scores))]
    return {'id': 'r', 'intervals': [[body[0], body[1], -1]],
            'layers': {'nucreg': {'intervals': ivs, 'qualities': [[encode_score(s) for s in scores], [90] * len(scores)],
                                  'quality_names': ['score', 'period']}},
            '_fiberbrowser_nucreg_ref': ref}


def test_nuc_reg_cluster_intervals_fill_and_centre():
    from services.clustering_features import nuc_reg_intervals, uses_nucleosome_inputs
    read = _fake_read([3.0, 5.0, 8.0], ref=3.0)
    ivs = nuc_reg_intervals(read)
    assert ivs[0][:2] == (0, 250) and ivs[0][2] == pytest.approx(0.5, abs=0.01)    # the reference sits at 0.5
    assert ivs[1][2] == pytest.approx(0.7, abs=0.01)
    assert ivs[-1] == (750, 2000, 0.5)                                            # no tile: the reference
    assert all(a < b for a, b, _v in ivs) and all(ivs[i][1] <= ivs[i + 1][0] for i in range(len(ivs) - 1))
    pat = nuc_reg_intervals(read, pattern=True)
    vals = [v for a, b, v in pat if b - a == 250]
    assert np.mean(vals) == pytest.approx(0.5, abs=0.01)
    assert uses_nucleosome_inputs(['nuc.reg']) and uses_nucleosome_inputs(['nuc.reg.pattern'])


def test_nuc_reg_features_kmeans_and_combinatorial():
    from services.clustering_features import extract_features_from_compact
    from services.cluster_assignment import cluster_compact_reads
    low = [dict(_fake_read([2.5] * 8), id=f'l{i}') for i in range(12)]
    high = [dict(_fake_read([6.5] * 8), id=f'h{i}') for i in range(12)]
    reads = low + high
    X, ids, widths, modes = extract_features_from_compact(reads, [[0, 2000]], 0, peak_modes=['nuc.reg'])
    assert X.shape == (24, 200) and modes == ['nuc.reg']
    assert X[:12].mean() < 0.5 < X[12:].mean()
    for method in ('kmeans', 'graph', 'combinatorial'):
        assignments = cluster_compact_reads(reads, [[0, 2000]], 0, 2, method=method, peak_modes=['nuc.reg'])[0]
        assert len({assignments[f'l{i}'] for i in range(12)}) == 1
        assert len({assignments[f'h{i}'] for i in range(12)}) == 1
        assert assignments['l0'] != assignments['h0']


def test_reg_metrics_are_listed_with_their_layer():
    from services.nuc.scalars import group_of, metrics
    ids = {m['id']: m for m in metrics()}
    for mid in ('nuc.reg.median', 'nuc.reg.max', 'nuc.reg.frac_above_ref'):
        assert ids[mid]['group'] == 'nucreg' and group_of(mid) == 'nucreg'
    from services.filtering_endpoint import _term_layers
    assert _term_layers(None, 'nuc.reg.median') == (True, ['nucreg'])


def test_reg_metric_values_from_a_row():
    from services.nuc.scalars import metric_value
    row = _fake_read([2.0, 4.0, 6.0], ref=3.0)
    assert metric_value(row, 'nuc.reg.median') == pytest.approx(4.0, abs=0.05)
    assert metric_value(row, 'nuc.reg.max') == pytest.approx(6.0, abs=0.05)
    assert metric_value(row, 'nuc.reg.frac_above_ref') == pytest.approx(2 / 3)
    row.pop('_fiberbrowser_nucreg_ref')
    assert metric_value(row, 'nuc.reg.frac_above_ref') is None
    # A row that lost the internal field (a re-windowed or projected copy) still reads its layer's reference scale.
    row['layers']['nucreg']['scale'] = {'zero': 5.0, 'top': 7.0, 'reference': True}
    assert metric_value(row, 'nuc.reg.frac_above_ref') == pytest.approx(1 / 3)
    row['layers']['nucreg']['scale'] = {'zero': 3.0, 'top': 6.0, 'reference': False}
    assert metric_value(row, 'nuc.reg.frac_above_ref') is None
    assert metric_value({'layers': {}}, 'nuc.reg.median') is None


def test_binary_reads_keep_the_lane_scale():
    import json
    import struct
    from services.read_binary import _wire_payload, encode_reads
    row = _fake_read([3.0, 5.0])
    row['layers']['nucreg']['scale'] = {'zero': 3.01, 'top': 5.72, 'reference': True}
    body = encode_reads(_wire_payload({'reads': [row]}))
    header = json.loads(body[8:8 + struct.unpack('<I', body[4:8])[0]])
    fields = header['reads']['fields']
    assert set(fields['layers']['fields']['nucreg']['fields']['scale']['fields']) == {'zero', 'top', 'reference'}
    assert '_fiberbrowser_nucreg_ref' not in fields


def test_parse_params():
    from services.nuc.regularity import parse_params
    p = parse_params({'window_bp': 1500, 'mask_open_bp': 0, 'thin_per_kb': 25, 'band_bp': [150, 250]})
    assert p.window_bp == 1500 and p.mask_open_bp is None and p.thin_per_kb == 25.0 and p.band_bp == (150, 250)
    with pytest.raises(ValueError):
        parse_params({'bogus': 1})
    with pytest.raises(ValueError):
        parse_params({'signal': 'x'})
