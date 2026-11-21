"""Round-2 audit regressions (Gemini's report, backend): lane labels follow the panel whose settings the lanes took
last, a lane adoption is installed whole even when two requests finish together, a zero grouping tolerance stays
zero. Synthetic Hia5 molecules (tests/nuc_fixtures.py)."""
from __future__ import annotations

import os
import threading
import time

import numpy as np
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
LOOSE = {'min_share': 0.01}


@pytest.fixture(scope='module')
def computed(tmp_path_factory):
    from models.domain import Dataset
    from state.browser_state import BrowserState
    from services.nuc import jobs, nucgeo
    from services.nuc.regularity import clear_references
    from services.nuc.store import STORE
    bam = chromatin_bam(tmp_path_factory.mktemp('nuc_r2agy') / 'chromatin.bam', contig=CONTIG, length=LENGTH)
    old = os.environ.get('FIBERBROWSER_SCAN_CACHE_DIR')
    os.environ['FIBERBROWSER_SCAN_CACHE_DIR'] = str(tmp_path_factory.mktemp('nuc_r2agy_cache'))
    STORE.clear(); clear_references(); nucgeo.clear()
    st = BrowserState(None)
    ds = Dataset('ds0', bam, label='Synthetic')
    ds.available_layers = {'footprint': True}
    st.datasets = {'ds0': ds}
    st.chroms = [NS(name=CONTIG, size=LENGTH)]
    job = jobs.submit(st, dict(datasets=['ds0'], chrom=CONTIG, start=VIEW[0], end=VIEW[1], parameters=SETTINGS,
                               workers=2))
    assert jobs.wait(st, job['job_id'], timeout=900)['status'] == 'complete'
    yield st
    STORE.clear(); clear_references(); nucgeo.clear()
    if old is None:
        os.environ.pop('FIBERBROWSER_SCAN_CACHE_DIR', None)
    else:
        os.environ['FIBERBROWSER_SCAN_CACHE_DIR'] = old


def _path(st):
    return st.datasets['ds0'].paths[0]


# ------------------------------------------------------------------------------- H6: labels follow the lane owner
def test_a_panel_re_asking_with_other_geometry_settings_never_relabels_another_panels_lanes(computed):
    """Two panels with the same patch settings but other grouping (fold): the labels are the panel's whose settings
    the lanes took last; the other panel re-asking (a cached answer) does not take them back."""
    from services.nuc import nucgeo
    path = _path(computed)
    a = dict(LOOSE, fold='none', tol_bp=150)
    b = dict(LOOSE, fold='all', tol_bp=900)
    nucgeo.geometry_analysis(computed, [OBS], patch_params=a, reg_params={}, request_scope='owner-a')
    la = nucgeo.labels_revision(path)
    nucgeo.geometry_analysis(computed, [OBS], patch_params=b, reg_params={}, request_scope='owner-b')
    lb = nucgeo.labels_revision(path)
    assert la and lb and la != lb, 'the two groupings label the patches differently'
    res = nucgeo.geometry_analysis(computed, [OBS], patch_params=a, reg_params={}, request_scope='owner-a')
    assert res['cached']
    assert nucgeo.labels_revision(path) == lb
    # the owner re-asking keeps them; the owner changing a setting relabels
    nucgeo.geometry_analysis(computed, [OBS], patch_params=b, reg_params={}, request_scope='owner-b')
    assert nucgeo.labels_revision(path) == lb
    # A changing only its grouping (same patches) takes the labels, as a settings change takes the lanes
    nucgeo.geometry_analysis(computed, [OBS], patch_params=dict(a, fold='near'), reg_params={},
                             request_scope='owner-a')
    lc = nucgeo.labels_revision(path)
    assert lc not in ('', lb)
    # the composed graph rows' identity does not follow the labels (they draw no patches)
    from services.nuc.store import nuc_identity
    ident = nuc_identity(computed.datasets['ds0'])
    nucgeo.geometry_analysis(computed, [OBS], patch_params=b, reg_params={}, request_scope='owner-b2')
    assert nucgeo.labels_revision(path) not in ('', lc)
    assert nuc_identity(computed.datasets['ds0']) == ident
    nucgeo.geometry_analysis(computed, [OBS], patch_params=dict(a, enter=2.5), reg_params={}, request_scope='owner-a')
    assert nucgeo.labels_revision(path) not in ('', lb, lc)
    nucgeo.geometry_analysis(computed, [OBS], patch_params=LOOSE, reg_params={}, request_scope='owner-reset')


# ----------------------------------------------------------------------- M18: an adoption is installed as a whole
def test_two_requests_finishing_together_install_one_panels_tuple(computed, monkeypatch):
    from services.nuc import nucgeo, regularity as R
    path = _path(computed)
    for scope, ends, enter in (('race-a', 'blank', 2.0), ('race-b', 'extend', 3.0)):
        nucgeo.geometry_analysis(computed, [OBS], patch_params=dict(LOOSE, enter=enter), reg_params={'ends': ends},
                                 request_scope=scope)
    inside = threading.Event()
    real_set = nucgeo.set_dataset_params

    def slow_set(state, ds_id, patch, ov, paths=()):
        if patch.enter == 2.25:             # A's patch install lands late
            inside.set()
            time.sleep(0.4)
        return real_set(state, ds_id, patch, ov, paths)
    monkeypatch.setattr(nucgeo, 'set_dataset_params', slow_set)
    errors = []

    def ask(scope, ends, enter):
        try:
            nucgeo.geometry_analysis(computed, [OBS], patch_params=dict(LOOSE, enter=enter),
                                     reg_params={'ends': ends}, request_scope=scope)
        except Exception as error:          # noqa: BLE001
            errors.append(error)
    ta = threading.Thread(target=ask, args=('race-a', 'blank', 2.25))
    ta.start()
    assert inside.wait(120)
    tb = threading.Thread(target=ask, args=('race-b', 'extend', 3.25))
    tb.start()
    ta.join(120); tb.join(120)
    assert not errors
    got = (R.path_params(path).ends, nucgeo.path_params(path)['patch'].enter)
    assert got in (('blank', 2.25), ('extend', 3.25)), got
    monkeypatch.setattr(nucgeo, 'set_dataset_params', real_set)
    nucgeo.geometry_analysis(computed, [OBS], patch_params=LOOSE, reg_params={}, request_scope='race-reset')


def test_a_zero_grouping_tolerance_stays_zero():
    from services.nuc import nucgeo
    assert nucgeo._tolerance({'params': {'geometry': {'tol_bp': 0}}}) == 0
    assert nucgeo._tolerance({'params': {'geometry': {}}}) == 500
    assert nucgeo._tolerance({}) == 500


# ------------------------------------------------------------------- H9: live-lift frames never fabricate ends
def _piece(q0, q1, t0, t1, strand='+', source='hapA'):
    return NS(q_start=q0, q_end=q1, t_start=t0, t_end=t1, strand=strand, source=source, primary=True)


def test_a_patch_ending_inside_an_unlifted_insertion_is_open_and_cut_there(monkeypatch):
    """Source pieces [0, 1000) -> [10000, 11000) and [1500, 3000) -> [11000, 12500): source 1000..1500 is inserted
    sequence with no target position. A patch ending inside it is cut at the insertion (open, clipped), never closed
    at 11000 (every molecule's end inside the insertion would land there and pile up into a shared closed end)."""
    import fiberhmm.nuc.patches as P
    from services.nuc import nucgeo
    from services.nuc.frames import ViewFrame
    frame = ViewFrame([_piece(0, 1000, 10_000, 11_000), _piece(1500, 3000, 11_000, 12_500)], (10_000, 12_500))
    rf = frame.record('hapA', 0, 3000)
    assert rf.hidden_ends(200, 1200) == (False, True)
    assert rf.hidden_ends(200, 900) == (False, False)
    assert rf.hidden_ends(1200, 2500) == (True, False)
    # a small indel between two blocks of one chain (HIDDEN_GAP_BP) places an end that falls in it
    small = ViewFrame([_piece(0, 1000, 10_000, 11_000), _piece(1010, 3000, 11_000, 12_990)], (10_000, 12_990))
    assert small.record('hapA', 0, 3000).hidden_ends(200, 1005) == (False, False)
    assert small.record('hapA', 0, 3000).hidden_ends(200, 3500) == (False, True)
    patches = [NS(start=0, end=1, kind='high', mean_score=1.0, period=190, ref=(200, 1200)),
               NS(start=1, end=2, kind='high', mean_score=1.0, period=190, ref=(1600, 2500))]
    monkeypatch.setattr(P, 'patch_ref_interval', lambda mol, p, snapped: (p.ref[0], p.ref[1], False, False))
    entry = dict(track=NS(score=[]), env=[], mol=NS(), density=10.0)
    lay, _sc, _rt = nucgeo._layout(entry, NS(patches=patches, tile_state=[]), 'ds0', True, (9_000, 13_000), 'u',
                                   rf=rf)
    first, second = lay.patches
    assert (first.start, first.end) == (10_200, 11_000)
    assert first.open_right and first.clip_right and not first.open_left and not first.clip_left
    assert not (second.open_left or second.open_right or second.clip_left or second.clip_right)


def test_a_record_crossing_an_inversion_beside_the_view_keeps_the_views_orientation():
    from services.nuc.frames import ViewFrame
    pieces = [_piece(0, 4000, 10_000, 14_000), _piece(4000, 4300, 18_000, 18_300, strand='-')]
    rf = ViewFrame(pieces, (10_500, 13_500)).record('hapA', 0, 4300)
    assert rf is not None and not rf.reverse and len(rf.pieces) == 1
    assert rf.hidden_ends(3000, 4200) == (False, True)
    # inside the view both orientations: no single frame
    assert ViewFrame(pieces, (13_000, 18_200)).record('hapA', 0, 4300) is None


# ------------------------------------------------------------------ H10: a load older than a layer change
def test_a_load_that_started_before_a_layer_change_is_not_cached():
    """An in-flight read load started before the regularity layers changed (``refresh_after``) built its nucreg /
    nucpatch rows with the old settings: it must not write them back into the read cache after the invalidation."""
    from collections import OrderedDict
    from services.dataset_registration import invalidate_dataset_layer_caches
    from services.working_sets import _store_broad_cache_entry, layer_epoch
    st = NS(_broad_cache=OrderedDict(), _working_set_cache=OrderedDict())
    lanes = ('ds', 'chrR', 0, 1000, False, ('nucpatch', 'nucreg'), False, True, 90, 0, ())
    plain = ('ds', 'chrR', 0, 1000, False, ('nuc',), False, True, 90, 0, ())
    e_lanes, e_plain = layer_epoch(st, 'ds', lanes[5]), layer_epoch(st, 'ds', plain[5])
    invalidate_dataset_layer_caches(st, 'ds', ['nucreg', 'nucpatch'])
    _store_broad_cache_entry(st, lanes, [{'id': 'r1'}], 0, e_lanes)
    _store_broad_cache_entry(st, plain, [{'id': 'r1'}], 0, e_plain)
    assert lanes not in st._broad_cache, 'rows built before the layer change were cached'
    assert plain in st._broad_cache, 'rows without those layers are unaffected'
    # a load started after the change caches as usual, and joins no older load (its in-flight key differs)
    e_now = layer_epoch(st, 'ds', lanes[5])
    assert e_now != e_lanes
    _store_broad_cache_entry(st, lanes, [{'id': 'r1'}], 0, e_now)
    assert lanes in st._broad_cache


def test_a_reference_finished_in_the_background_drops_rows_built_without_it(computed):
    """The lane shown right after an Analyse, before any panel request: a read load starts the dataset's reference
    in the background (it used to start nothing: no panel had registered the file), and when it is ready the rows
    cached with the fallback scale and no patches are dropped (``reference._bump`` did nothing)."""
    from services.nuc import reference as REF, regularity as R
    path = _path(computed)
    R.clear_references()                       # no registration: as after a restart with outputs restored
    d8 = R.digest8(R.path_params(path))
    stale = ('ds0', CONTIG, VIEW[0], VIEW[1], False, ('nucpatch', 'nucreg'), True, True, 90, 0, ())
    plain = ('ds0', CONTIG, VIEW[0], VIEW[1], False, ('nuc',), True, True, 90, 0, ())
    computed._broad_cache[stale] = ([], time.time())
    computed._broad_cache[plain] = ([], time.time())
    assert R.reference_for_path(path, d8) is None
    assert REF.request_background(path, d8), 'no background reference was started'
    deadline = time.time() + 120
    while R.reference_for_path(path, d8) is None and time.time() < deadline:
        time.sleep(0.05)
    assert R.reference_for_path(path, d8) is not None
    while stale in computed._broad_cache and time.time() < deadline:
        time.sleep(0.05)
    assert stale not in computed._broad_cache, 'rows built before the reference stayed cached'
    assert plain in computed._broad_cache
    computed._broad_cache.pop(plain, None)


# ------------------------------------------------------------------- M19: speed traps on the panel's requests
def test_the_not_analysed_check_reads_each_bam_header_once(computed, monkeypatch):
    import pysam as _pysam
    from services.nuc import observations, record_count
    from services.nuc.inputs import browser_read_policy, nuc_source
    from services.nuc.jobs import active_config
    opened = []
    real_open = _pysam.AlignmentFile

    def counting(*a, **k):
        opened.append(a[0] if a else k.get('filename'))
        return real_open(*a, **k)
    monkeypatch.setattr(_pysam, 'AlignmentFile', counting)
    monkeypatch.setattr(record_count, 'count', lambda *a, **k: 3)
    source = nuc_source(computed, 'ds0')
    cfg = active_config(computed, 'ds0')
    obs = dict(OBS, start=120_000, end=130_000)          # outside the analysed view
    for _ in range(3):
        got = observations._not_analysed(computed, source, obs, cfg, browser_read_policy(computed))
        assert got is not None and got[5]['notAnalysed']
    # (the annotated-BAM probe reads it once too, cached): three requests, never a header read per request
    assert len(opened) <= 2, opened


def test_a_removed_datasets_decoded_population_is_released(tmp_path, monkeypatch):
    from services.nuc import reference as REF
    gone, kept = tmp_path / 'gone.bam', tmp_path / 'kept.bam'
    gone.write_bytes(b''); kept.write_bytes(b'')
    cfg = NS(calibrations={}, calibration=None, settings_hash='h', policy={}, settings={})
    import fiberhmm.nuc.thinning as TH
    monkeypatch.setattr(TH, 'load_population', lambda paths, *a, **k: ([NS(calls=np.zeros(8))], None, None, None))

    for f in (gone, kept):
        REF._population([str(f)], cfg, [], 10, None)
    keys = {REF.population_key([str(f)], cfg): f for f in (gone, kept)}
    assert set(keys) <= set(REF._POPS)
    REF.forget_paths([str(gone)])
    left = {keys[k] for k in keys if k in REF._POPS}
    assert left == {kept}
    REF.forget_paths([str(kept)])


def test_a_multi_file_datasets_reference_key_follows_every_files_calibration(tmp_path):
    from services.nuc import reference as REF
    a, b = tmp_path / 'a.bam', tmp_path / 'b.bam'
    a.write_bytes(b''); b.write_bytes(b'')
    params = NS(digest=lambda: 'p' * 16, ends='blank')

    def cfg(db):
        cals = {str(a): NS(digest='da', wrapper={}, label='x'), str(b): NS(digest=db, wrapper={}, label='y')}
        return NS(calibrations=cals, calibration=None, settings_hash='h', policy={}, settings={})
    paths = [str(a), str(b)]
    assert REF.key_of(paths, cfg('db1'), params) != REF.key_of(paths, cfg('db2'), params)
    assert REF.population_key(paths, cfg('db1')) != REF.population_key(paths, cfg('db2'))
    # one file: the key does not depend on other files (and is what it was)
    assert REF.key_of([str(a)], cfg('db1'), params) == REF.key_of([str(a)], cfg('db2'), params)
