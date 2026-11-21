"""Regularity patches (layer nucpatch) and shared geometries (/api/nuc/geometries) in the browser.

- nothing is computed unless asked for: an all-layer load never computes patches; a load naming nucpatch does;
- the browser's layouts equal FiberHMM's molecule_layout, and its geometries equal FiberHMM's find_geometries on
  the same records, view and reference (float scores, as the scan);
- fold modes change parents and partial shares, never the grouping; parameters change results without reloading
  reads and are cached; edges grid / snap; the reference override; the regularity read-end modes' reach rides on
  the nucreg layer. Synthetic Hia5 molecules (tests/nuc_fixtures.py)."""
from __future__ import annotations

from types import SimpleNamespace as NS

import pytest

pysam = pytest.importorskip('pysam')
pytest.importorskip('fiberhmm.nuc.geometries')
pytest.importorskip('fiberhmm.scan.modules.nuc')

from nuc_fixtures import chromatin_bam

CONTIG, LENGTH = 'chrR', 160_000
SETTINGS = {'calibration': 'self', 'calibration_population': 400}
VIEW = (20_000, 60_000)
OBS = dict(obsId='o1', label='Synthetic', datasetId='ds0', kind='linear', chrom=CONTIG, start=VIEW[0], end=VIEW[1])


@pytest.fixture(scope='module')
def bam(tmp_path_factory):
    return chromatin_bam(tmp_path_factory.mktemp('nuc_geo') / 'chromatin.bam', contig=CONTIG, length=LENGTH)


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
    from services.nuc import jobs, nucgeo
    from services.nuc.regularity import clear_references
    from services.nuc.store import STORE
    old = os.environ.get('FIBERBROWSER_SCAN_CACHE_DIR')
    os.environ['FIBERBROWSER_SCAN_CACHE_DIR'] = str(tmp_path_factory.mktemp('nuc_geo_cache'))
    # these tests follow the reference from the panel's first request (the read path never computes it): no
    # reference started by the Analyse (services.nuc.reference.PREFETCH_ON_ANALYSE)
    from services.nuc import reference as _ref
    _prefetch, _ref.PREFETCH_ON_ANALYSE = _ref.PREFETCH_ON_ANALYSE, False
    STORE.clear()
    clear_references()
    nucgeo.clear()
    st = _state(bam)
    job = jobs.submit(st, dict(datasets=['ds0'], chrom=CONTIG, start=VIEW[0], end=VIEW[1], parameters=SETTINGS,
                               workers=2))
    assert jobs.wait(st, job['job_id'], timeout=900)['status'] == 'complete'
    _ref.PREFETCH_ON_ANALYSE = _prefetch
    yield st
    STORE.clear()
    clear_references()
    nucgeo.clear()
    if old is None:
        os.environ.pop('FIBERBROWSER_SCAN_CACHE_DIR', None)
    else:
        os.environ['FIBERBROWSER_SCAN_CACHE_DIR'] = old


def _inject(path, sha, occ, requested):
    from services.nuc.layers import injector
    inject = injector(path, VIEW[0], VIEW[1], include_layers=True, requested_layers=requested, include_qualities=True,
                      include_lift_meta=False)
    row = dict(record_sha256=sha, alignment_occurrence=occ)
    inject(row)
    return row


def _path(st):
    return st.datasets['ds0'].paths[0]


def test_parse_params():
    from services.nuc.nucgeo import parse_params
    p, g, v = parse_params(None)
    assert (p.enter, p.extend, p.min_tiles, p.snap, g.tol_bp, g.min_share, g.fold, g.near_max_bp) == \
        (2.0, 1.25, 2, True, 500, 0.03, 'near', 1250)
    p, g, v = parse_params({'edges': 'grid', 'enter': 1.5, 'extend': 1.75, 'fold': 'all', 'tol_bp': 750.0,
                            'search_bp': 600, 'snap_rule': 'period', 'tol_frac': 0.3, 'carriers': 'any'})
    assert not p.snap and not g.snapped and p.extend == 1.5 and g.fold == 'all' and g.tol_bp == 750
    assert p.search_bp == 600 and p.snap_rule == 'period' and p.tol_frac == 0.3 and v['carriers'] == 'any'
    for bad in ({'fold': 'some'}, {'edges': 'x'}, {'carriers': 'x'}, {'min_tiles': 0}):
        with pytest.raises(ValueError):
            parse_params(bad)


def test_an_all_layer_load_never_computes_patches(computed):
    from services.nuc import nucgeo
    from services.nuc.store import STORE
    path = _path(computed)
    keys = sorted(STORE.rows_of(path))
    sha, occ = keys[len(keys) // 3]
    row = _inject(path, sha, occ, None)
    assert 'nucpatch' not in row['layers']
    assert not nucgeo._PATCHES and not nucgeo._GRIDS
    row = _inject(path, sha, occ, ['nucpatch'])
    # no reference yet (no panel request named the dataset): the read path never computes one, so no patches
    assert 'nucpatch' not in row['layers'] and not nucgeo._GRIDS
    from services.nuc import regularity as R
    from services.nuc.jobs import active_config
    from services.nuc.inputs import nuc_source
    assert R.dataset_reference(nuc_source(computed, 'ds0'), R.dataset_params(computed, 'ds0'),
                               active_config(computed, 'ds0'))['median'] is not None
    row = _inject(path, sha, occ, ['nucpatch'])
    layer = row['layers'].get('nucpatch')
    assert nucgeo._GRIDS                       # computed on demand for this row only
    if layer is not None:                      # a row may hold no patch
        assert layer['quality_names'] == ['score', 'period', 'flags', 'geometry', 'root', 'patch']
        assert all(len(q) == len(layer['intervals']) for q in layer['qualities'])


def test_layouts_and_geometries_equal_fiberhmm(computed):
    from fiberhmm.nuc.geometries import GeometryParams, find_geometries, molecule_layout
    from fiberhmm.nuc.patches import PatchParams, call_patches
    from fiberhmm.nuc.regularity import DEFAULT_REGULARITY, sliding_regularity
    from services.nuc import nucgeo, regularity as R
    from services.nuc.inputs import browser_read_policy
    from services.nuc.observations import observation_cohort
    res = nucgeo.geometry_analysis(computed, [OBS], patch_params={'fold': 'none', 'min_share': 0.02})
    assert res['nMolecules'] > 50 and res['nPatches'] > 0 and res['geometries']
    ref = res['references']['ds0']
    _src, _recs, _w, cfg, cohort, _c = observation_cohort(computed, OBS, browser_read_policy(computed))
    lays_fh = []
    checked = 0
    for r, row in cohort:
        hit = R.molecules(r.path, cfg, {(r.sha, r.occ): row}, [(r.sha, r.occ)])
        marks = R.tiles_of(r.path, (r.sha, r.occ), row, DEFAULT_REGULARITY)
        if (r.sha, r.occ) not in hit or marks is None:
            continue
        mol = hit[(r.sha, r.occ)][0]
        tr = sliding_regularity(mol, DEFAULT_REGULARITY)       # FiberHMM's own float track, as the scan
        mp = call_patches(tr, mol.nucs, ref_median=ref, params=PatchParams())
        lay = molecule_layout(mol, tr, mp, 'ds0', snapped=True, view=VIEW, uid='x')
        e = nucgeo._get(nucgeo._GRIDS, (nucgeo.real(r.path), R.config_key(r.path, cfg), r.sha, r.occ, R.digest8(DEFAULT_REGULARITY)))
        mine, _sc, _rt = nucgeo._layout(e, mp, 'ds0', True, VIEW, 'x')
        assert [(p.start, p.end, p.open_left, p.open_right) for p in mine.patches] == \
            [(p.start, p.end, p.open_left, p.open_right) for p in lay.patches]
        assert (mine.tile_lo == lay.tile_lo).all() and (mine.tile_state == lay.tile_state).all()
        checked += 1
        if len(lay.tile_lo):
            lays_fh.append(lay)
    assert checked > 50
    G = find_geometries(lays_fh, GeometryParams(fold='none', min_share=0.02))
    assert [(g.start, g.end, g.n_molecules) for g in G] == \
        [(g['start'], g['end'], g['molecules']) for g in res['geometries']]


def test_fold_modes_change_parents_not_groups_and_results_are_cached(computed):
    from services.nuc import nucgeo
    out = {}
    for fold in ('none', 'near', 'all'):
        out[fold] = nucgeo.geometry_analysis(computed, [OBS], patch_params={'fold': fold, 'min_share': 0.01})
    spans = {f: [(g['start'], g['end']) for g in r['geometries']] for f, r in out.items()}
    assert spans['none'] == spans['near'] == spans['all']
    assert all(g['parent'] is None for g in out['none']['geometries'])
    n_near = sum(g['parent'] is not None for g in out['near']['geometries'])
    n_all = sum(g['parent'] is not None for g in out['all']['geometries'])
    assert n_all >= n_near
    for g in out['all']['geometries']:
        po = g['perObservation']['o1']
        assert po['full'] + po['partial'] <= po['molecules']
        if g['parent'] is not None:
            assert po['partial'] == 0
    again = nucgeo.geometry_analysis(computed, [OBS], patch_params={'fold': 'all', 'min_share': 0.01})
    assert again['cached'] and again['geometries'] == out['all']['geometries']
    # every response part is present for the panel
    r = out['near']
    assert set(r['profiles']) == {'edges', 'carriers', 'none', 'share'}
    assert r['patchStats']['o1']['molecules'] == r['nMolecules']
    assert r['stack'] and all(len(s['patches']) <= 40 for s in r['stack'])
    assert 'ds0' in r['assignments'] and r['assignments']['ds0']['group']


def test_parameters_change_results_live_and_label_the_layer(computed):
    from services.nuc import nucgeo
    from services.nuc.store import STORE
    path = _path(computed)
    rev0 = nucgeo.revision(path)
    base = nucgeo.geometry_analysis(computed, [OBS], patch_params={'min_share': 0.01})
    strict = nucgeo.geometry_analysis(computed, [OBS], patch_params={'min_share': 0.01, 'enter': 3.5, 'extend': 3.0})
    assert strict['nPatches'] < base['nPatches']
    assert nucgeo.revision(path) != rev0             # read rows carrying patches are rebuilt
    grid = nucgeo.geometry_analysis(computed, [OBS], patch_params={'min_share': 0.01, 'edges': 'grid'})
    assert grid['params']['patch']['snap'] is False and grid['params']['geometry']['snapped'] is False
    # a geometry label rides on the layer's quality bytes after an analysis with the file's parameters
    nucgeo.geometry_analysis(computed, [OBS], patch_params={'min_share': 0.01})
    labelled = 0
    for sha, occ in sorted(STORE.rows_of(path))[:150]:
        layer = _inject(path, sha, occ, ['nucpatch'])['layers'].get('nucpatch')
        if layer:
            labelled += sum(1 for g in layer['qualities'][3] if g > 0)
    assert labelled > 0


def test_reference_override_moves_the_patches(computed):
    from services.nuc import nucgeo
    lo = nucgeo.geometry_analysis(computed, [OBS], patch_params={'min_share': 0.01}, ref_override={'ds0': 0.0})
    hi = nucgeo.geometry_analysis(computed, [OBS], patch_params={'min_share': 0.01}, ref_override={'ds0': 9.0})
    assert lo['references']['ds0'] == 0.0 and hi['references']['ds0'] == 9.0
    assert lo['nPatches'] > hi['nPatches']
    nucgeo.geometry_analysis(computed, [OBS], patch_params={'min_share': 0.01}, ref_override={'ds0': None})


def test_association_returns_sites_states_and_tests(computed):
    from services.nuc import nucgeo
    r = nucgeo.geometry_analysis(computed, [OBS], patch_params={'min_share': 0.01, 'site_min_share': 0.01})
    a = r['association']
    assert 'sites' in a and a['state'] == 'nfr'
    if a['site'] is not None:
        assert a['stateNames'] == ['closed', 'open']
        assert {z['state'] for z in a['profiles']['series']} <= {0, 1}
        assert 'rows' in a['tests']
    t = nucgeo.geometry_analysis(computed, [OBS], patch_params={'min_share': 0.01}, site=40_000, site_state='tf')
    assert t['association']['site'] == 40_000 and t['association']['stateNames'] == ['unbound', 'bound']


def test_read_end_modes_reach_rides_on_the_nucreg_layer(computed):
    from fiberhmm.nuc.regularity import RegularityParams
    from services.nuc import regularity as R
    from services.nuc.store import STORE
    path = _path(computed)
    sha, occ = sorted(STORE.rows_of(path))[7]
    blank = _inject(path, sha, occ, ['nucreg'])['layers'].get('nucreg')
    R.set_dataset_params(computed, 'ds0', RegularityParams(ends='truncated'), [path])
    try:
        trunc = _inject(path, sha, occ, ['nucreg'])['layers'].get('nucreg')
    finally:
        R.set_dataset_params(computed, 'ds0', RegularityParams(), [path])
    assert blank and trunc and 'reach' in blank and 'reach' in trunc
    wb = blank['reach'][1] - blank['reach'][0]
    wt = trunc['reach'][1] - trunc['reach'][0]
    assert wt >= wb
    assert R.parse_params({'ends': 'truncated', 'end_min_bp': 1200.0}).end_min_bp == 1200
    assert R.parse_params({'ends': 'blank'}).digest() == RegularityParams().digest()


def test_rewindowed_rows_keep_the_regularity_scale_and_rebase_the_reach():
    from services.working_sets import _project_layer_intervals
    layer = {'intervals': [[1000, 1250, 250], [1250, 1500, 250]], 'qualities': [[100, 120], [90, 88]],
             'quality_names': ['score', 'period'], 'annotation_names': ['a', 'b'],
             'scale': {'zero': 3.0, 'top': 6.0, 'reference': True}, 'params_digest': 'abcd1234', 'reach': [800, 1900]}
    out = _project_layer_intervals(layer, 500, 5000)
    assert out['scale'] == layer['scale'] and out['params_digest'] == 'abcd1234'
    assert out['reach'] == [300, 1400] and out['intervals'][0][:2] == [500, 750]


def test_rows_cached_for_every_layer_never_answer_a_request_naming_regularity_or_patches():
    from services.nuc.layers import LAYER_GROUPS, ON_DEMAND_GROUPS
    from services.working_sets import NAMED_ONLY_LAYERS, layer_key_covers
    assert set(ON_DEMAND_GROUPS) | {'nucreg'} <= NAMED_ONLY_LAYERS <= set(LAYER_GROUPS) | set(ON_DEMAND_GROUPS)
    assert layer_key_covers(None, None) and layer_key_covers(None, ('nuc', 'nucseg', 'nucsz', 'tf'))
    assert not layer_key_covers(None, ('nuc', 'nucreg', 'tf')) and not layer_key_covers(None, ('nucpatch',))
    assert layer_key_covers(('nuc', 'nucpatch', 'nucreg', 'tf'), ('nucpatch', 'nucreg'))


def test_a_cohort_after_an_all_layer_load_keeps_its_regularity_and_patch_lanes(computed):
    """A cluster run loads every layer; the clustered panels then ask for their cohort (filter_ids) naming nucreg and
    nucpatch. Their rows must carry both lanes, not the all-layer rows' (which hold neither)."""
    from services.read_endpoint import _compact_reads_payload
    kw = dict(chrom=CONTIG, start=VIEW[0], end=VIEW[1], dataset_id='ds0', include_layers=True,
              include_layer_qualities=True, max_reads=1000)
    named = 'nuc,nucpatch,nucreg,nucseg,nucsz,tf'
    every = _compact_reads_payload(computed, **kw, layer_names=None)
    assert every['reads'] and not any((r.get('layers') or {}).get('nucpatch') for r in every['reads'])

    def lanes(payload):
        rows = payload['reads']
        return (sum(1 for r in rows if (r.get('layers') or {}).get('nucreg')),
                sum(1 for r in rows if (r.get('layers') or {}).get('nucpatch')), len(rows))
    reg, patch, n = lanes(_compact_reads_payload(computed, **kw, layer_names=named))
    assert reg > n // 2 and patch > 0
    ids = ','.join(r['id'] for r in every['reads'][:30])
    reg, patch, n = lanes(_compact_reads_payload(computed, **kw, layer_names=named, filter_ids=ids))
    assert n == 30 and reg > n // 2 and patch > 0


def test_low_regularity_patches_get_their_own_geometries_and_kind_fields(computed):
    from fiberhmm.nuc.geometries import GeometryParams, find_geometries
    from services.nuc import nucgeo
    from services.nuc.store import STORE
    p, _g, _v = nucgeo.parse_params({'low': {'enter': -1.0, 'extend': 2.0}})
    assert p.low is not None and p.low.extend < p.extend and p.low.enter <= p.low.extend
    assert nucgeo.parse_params({'low': None})[0].low is None
    hi = nucgeo.geometry_analysis(computed, [OBS], patch_params={'min_share': 0.01})
    both = nucgeo.geometry_analysis(computed, [OBS], patch_params={'min_share': 0.01, 'low': {'enter': -0.5,
                                                                                           'extend': 0.0}})
    assert both['kinds'] == ['high', 'low'] and hi['kinds'] == ['high']
    assert both['nPatchesByKind']['high'] == hi['nPatches']
    high_rows = [(g['start'], g['end'], g['molecules']) for g in both['geometries'] if g['kind'] == 'high']
    assert high_rows == [(g['start'], g['end'], g['molecules']) for g in hi['geometries']]
    low = [g for g in both['geometries'] if g['kind'] == 'low']
    assert all(g['id'].startswith('L') for g in low) and all(g['id'].startswith('G') for g in hi['geometries'])
    assert [g['number'] for g in low] == list(range(1, len(low) + 1))
    assert 'shareLow' in both['profiles'] and 'low' in both['patchStats']['o1']
    assert 'groupLow' in both['assignments']['ds0']
    assert all(z['kind'] in ('high', 'low') for z in both['nested'])
    # the layer carries flag bit 4 on low patches; geometry numbers count within the kind
    path = _path(computed)
    lows = 0
    for sha, occ in sorted(STORE.rows_of(path))[:150]:
        layer = _inject(path, sha, occ, ['nucpatch'])['layers'].get('nucpatch')
        if layer:
            lows += sum(1 for f in layer['qualities'][2] if f & 16)
    assert lows > 0
    nucgeo.geometry_analysis(computed, [OBS], patch_params={'min_share': 0.01})


def test_hub_states_of_a_panel_geometry_are_the_scan_mapping_and_never_change_parameters(computed):
    """The hub's nuc-geometry stateSpec: hit ids as the scan writes them; per-read states 1 (carries), 0 (partly or
    absent), '.' (no call / not spanned) through /api/features/states; a request whose parameters are no longer the
    dataset's is computed with its own (the same states), never applied to the lanes nor relabelling them."""
    from services.feature_states import feature_states
    from services.nuc import nucgeo
    # (the panel sends its complete settings, regularity included)
    request = dict(observations=[OBS], patches={'min_share': 0.01, 'low': {}}, regularity={}, spanning=False,
                   include_duplicates=False, site_state='nfr', show='patch')
    res = nucgeo.geometry_analysis(computed, request['observations'], patch_params=request['patches'],
                                   reg_params=request['regularity'])
    assert res['geometries']
    for g in res['geometries']:
        assert g['hitId'] == (f"geometry:{g['start']}-{g['end']}" if g['kind'] == 'high' else f"geometry-low:{g['start']}-{g['end']}")
    g = max(res['geometries'], key=lambda r: r['molecules'])
    hit = dict(setId='browser:nuc-geometry:p1', hitId=g['hitId'], typeId='nuc.geometry', chrom=CONTIG, start=g['start'],
               end=g['end'], anchor=(g['start'] + g['end']) // 2, label=g['id'], datasets=['ds0'],
               stateSpec=dict(kind='nuc-geometry', geometryId=g['geometryId'], request=request))
    out = feature_states(computed, [dict(kind='nuc-geometry', source=hit['setId'], id=hit['hitId'], hub_hit=hit)])
    rows = out['by_dataset']['ds0']
    carried = set(res['assignments']['ds0']['carried'])
    members = {q for q, s in rows.items() if s == '1'}
    index = res['geometries'].index(g) + 1
    expected = {q for q, lst in res['assignments']['ds0']['carried'].items() if index in lst}
    assert members == expected and len(members) == g['perObservation']['o1']['full']
    zeros = sum(1 for s in rows.values() if s == '0')
    assert zeros == g['perObservation']['o1']['callable'] - g['perObservation']['o1']['full']
    assert carried >= members
    # another panel (or a cluster view) moved the dataset's settings since: the replay computes with its own request
    # settings and gives the same states; the lanes keep the other panel's settings and labels
    nucgeo.geometry_analysis(computed, [OBS], patch_params={'min_share': 0.01, 'enter': 2.5, 'extend': 1.5, 'low': {}},
                             request_scope='other-panel')
    before = nucgeo.path_params(_path(computed))
    assert before['patch'].enter == 2.5
    labels = nucgeo.labels_revision(_path(computed))
    again = feature_states(computed, [dict(kind='nuc-geometry', source=hit['setId'], id=hit['hitId'], hub_hit=hit)])
    assert again['by_dataset']['ds0'] == rows
    assert nucgeo.path_params(_path(computed)) == before and nucgeo.labels_revision(_path(computed)) == labels
    # and again after a regularity change elsewhere (the earlier failure: refused until the panel re-chose)
    nucgeo.geometry_analysis(computed, [OBS], patch_params={'min_share': 0.01, 'enter': 2.5, 'extend': 1.5, 'low': {}},
                             reg_params={'ends': 'extend'}, request_scope='other-panel')
    again = feature_states(computed, [dict(kind='nuc-geometry', source=hit['setId'], id=hit['hitId'], hub_hit=hit)])
    assert again['by_dataset']['ds0'] == rows
    from services.nuc import regularity as R
    assert R.path_params(_path(computed)).ends == 'extend'
    nucgeo.geometry_analysis(computed, [OBS], patch_params={'min_share': 0.01}, reg_params={},
                             request_scope='other-panel')


def test_hub_states_after_a_server_restart_adopt_the_request(computed):
    """After a restart no settings are chosen in the server session: a saved selection's replay analyses the view and
    gives the same states with its own settings; it never chooses the lanes' settings (the panel's first request
    does)."""
    from services.feature_states import feature_states
    from services.nuc import nucgeo
    from services.nuc import regularity as R
    request = dict(observations=[OBS], patches={'min_share': 0.01, 'enter': 2.25, 'low': {}},
                   regularity={'window_bp': 2000, 'step_bp': 250, 'min_calls': 15}, spanning=False,
                   include_duplicates=False, site_state='nfr', show='patch', analysis=SETTINGS)
    res = nucgeo.geometry_analysis(computed, request['observations'], patch_params=request['patches'],
                                   reg_params=request['regularity'])
    g = max(res['geometries'], key=lambda r: r['molecules'])
    hit = dict(setId='browser:nuc-geometry:p1', hitId=g['hitId'], typeId='nuc.geometry', chrom=CONTIG, start=g['start'],
               end=g['end'], anchor=(g['start'] + g['end']) // 2, label=g['id'], datasets=['ds0'],
               stateSpec=dict(kind='nuc-geometry', geometryId=g['geometryId'], request=request))
    ref = dict(kind='nuc-geometry', source=hit['setId'], id=hit['hitId'], hub_hit=hit)
    before = feature_states(computed, [ref])['by_dataset']['ds0']
    # a restart: the session's analysis, chosen settings and every response are gone (stored calibration stays)
    from services.nuc import jobs
    active = dict(computed.nuc_active)
    computed.nuc_active.clear()
    computed.__dict__.pop('nuc_geometry', None)
    computed.__dict__.pop('nuc_regularity', None)
    with nucgeo._LOCK:
        nucgeo._PATH_PARAMS.clear(); nucgeo._RESPONSES.clear(); nucgeo._STATES.clear()
    from services.nuc import reference as REF
    with R._LOCK:
        R._PATH_PARAMS.clear()
    with REF._LOCK:
        refs = dict(REF._REFS)
        REF.clear()                    # the reference comes back from the cache directory, unchanged
    assert refs and all(REF._file(k).is_file() for k in refs if refs[k]['usable'])
    assert R.chosen_params(computed, 'ds0') is None
    n_jobs = len(jobs.list_jobs(computed))
    after = feature_states(computed, [ref])['by_dataset']['ds0']
    assert after == before
    # the replay analysed the view first (the panel's Analyse, its parameters): one job, complete
    new = jobs.list_jobs(computed)[n_jobs:]
    assert len(new) == 1 and new[0]['status'] == 'complete'
    assert computed.nuc_active['ds0'].settings_hash == active['ds0'].settings_hash
    assert REF._REFS and {k: v['median'] for k, v in REF._REFS.items()} == \
        {k: v['median'] for k, v in refs.items() if k in REF._REFS}
    # a geometry whose id moved (an analysis recomputed with other molecules) is found again by kind and both ends
    moved = dict(hit, stateSpec=dict(hit['stateSpec'], geometryId=g['geometryId'].split('_', 1)[0] + '_000000000000'))
    assert feature_states(computed, [dict(ref, hub_hit=moved)])['by_dataset']['ds0'] == before
    far = dict(moved, start=g['start'] + 5000, end=g['end'] + 5000)
    with pytest.raises(ValueError, match='not in this analysis any more'):
        feature_states(computed, [dict(ref, hub_hit=far)])
    # a replay never chooses settings: none are chosen until the panel's own request
    assert R.chosen_params(computed, 'ds0') is None and nucgeo.chosen(computed, 'ds0') is None
    again = nucgeo.geometry_analysis(computed, request['observations'], patch_params=request['patches'],
                                     reg_params=request['regularity'], request_scope='panel-after-restart')
    assert again['updatedDatasets'] == ['ds0']
    assert nucgeo.path_params(_path(computed))['patch'].enter == 2.25 and R.chosen_params(computed, 'ds0') is not None
    nucgeo.geometry_analysis(computed, [OBS], patch_params={'min_share': 0.01})


def test_replay_analyse_replaced_by_the_panels_own_waits_for_it(monkeypatch):
    """The replay's Analyse replaced by a newer one (the panel opening at the same moment): it waits for that one and
    carries on instead of failing; any other failure is reported."""
    from services.nuc import jobs as J
    from services.nuc import nucgeo
    active, submitted = {}, []
    monkeypatch.setattr(J, 'active_config', lambda st, d: active.get(d))
    monkeypatch.setattr(J, 'list_jobs', lambda st: [])

    def submit(st, req):
        submitted.append(req)
        return dict(job_id=f'j{len(submitted)}')

    def wait_replaced(st, job_id, timeout=None):
        active['ds0'] = object()           # the panel's Analyse, which replaced this one, has finished
        return dict(status='cancelled', message=J._REPLACED)
    monkeypatch.setattr(J, 'submit', submit)
    monkeypatch.setattr(J, 'wait', wait_replaced)
    req = dict(observations=[OBS], analysis=SETTINGS)
    nucgeo._ensure_analysed(object(), req)
    assert len(submitted) == 1 and submitted[0]['parameters'] == SETTINGS and submitted[0]['views'][0]['chrom'] == CONTIG
    active.clear()
    monkeypatch.setattr(J, 'wait', lambda st, job_id, timeout=None: dict(status='error', message='boom'))
    with pytest.raises(ValueError, match='boom'):
        nucgeo._ensure_analysed(object(), req)
