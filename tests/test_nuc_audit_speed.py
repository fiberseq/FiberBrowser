"""Speed fixes of the nucleosome panel's regularity and geometry requests, with identical results. Synthetic Hia5
molecules (tests/nuc_fixtures.py).

- A dataset's calibration population is decoded once: a reference for new regularity parameters only scores it again,
  and equals the scan's ``nucreg_reference`` for the same parameters.
- The two requests of one settings change share their tiles (single flight per record), and whichever computes the
  tiles moves the files' revision.
- A read-end mode change derives its tracks from the records' full-window tracks (identical tiles and scores).
- Revisions are content identities: returning to earlier settings gives the earlier revision (the read caches find
  their rows again) and the cached response.
- A geometry relabel moves only the labels' identity (an overlay the lanes fetch), never the rows' revision.
"""
from __future__ import annotations

import threading
from types import SimpleNamespace as NS

import numpy as np
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
def computed(tmp_path_factory):
    import os
    from models.domain import Dataset
    from state.browser_state import BrowserState
    from services.nuc import jobs, nucgeo
    from services.nuc.regularity import clear_references
    from services.nuc.store import STORE
    bam = chromatin_bam(tmp_path_factory.mktemp('nuc_speed') / 'chromatin.bam', contig=CONTIG, length=LENGTH)
    old = os.environ.get('FIBERBROWSER_SCAN_CACHE_DIR')
    os.environ['FIBERBROWSER_SCAN_CACHE_DIR'] = str(tmp_path_factory.mktemp('nuc_speed_cache'))
    STORE.clear(); clear_references(); nucgeo.clear()
    st = BrowserState(None)
    ds = Dataset('ds0', bam, label='Synthetic')
    ds.available_layers = {'footprint': True}
    st.datasets = {'ds0': ds}
    st.chroms = [NS(name=CONTIG, size=LENGTH)]
    job = jobs.submit(st, dict(datasets=['ds0'], chrom=CONTIG, start=VIEW[0], end=VIEW[1], parameters=SETTINGS, workers=2))
    assert jobs.wait(st, job['job_id'], timeout=900)['status'] == 'complete'
    yield st
    STORE.clear(); clear_references(); nucgeo.clear()
    if old is None:
        os.environ.pop('FIBERBROWSER_SCAN_CACHE_DIR', None)
    else:
        os.environ['FIBERBROWSER_SCAN_CACHE_DIR'] = old


def _fresh():
    from services.nuc import nucgeo
    from services.nuc.regularity import clear_references
    clear_references(); nucgeo.clear()


def _source(st):
    from services.nuc.inputs import nuc_source
    from services.nuc.jobs import active_config
    return nuc_source(st, 'ds0'), active_config(st, 'ds0')


def test_the_population_is_decoded_once_and_references_equal_the_scans(computed, monkeypatch):
    from fiberhmm.nuc import thinning
    from fiberhmm.scan.modules.nuc import nucreg_reference
    from fiberhmm.scan.reads import passes
    from services.nuc import reference as REF
    from services.nuc.engine import nuc_params
    from services.nuc.regularity import parse_params
    _fresh()
    src, cfg = _source(computed)
    calls = []
    real_load = thinning.load_population
    monkeypatch.setattr(thinning, 'load_population', lambda *a, **k: calls.append(1) or real_load(*a, **k))
    refs = {e: REF.dataset_reference(list(src.paths), cfg, parse_params({'ends': e}))
            for e in ('blank', 'extend', 'truncated')}
    assert len(calls) == 1                                    # one decode for three parameter sets
    filters = (cfg.policy or {}).get('filters') or {}
    cut, min_cut, _m = REF._defaults()
    for ends, ref in refs.items():
        want = nucreg_reference(list(src.paths), nuc_params(cfg.settings), parse_params({'ends': ends}),
                                REF._regions(cfg, list(src.paths)) or REF._data_regions(cfg, list(src.paths)),
                                n_population=int(SETTINGS['calibration_population']), n_windows=REF.REFERENCE_WINDOWS,
                                seed=REF.REFERENCE_SEED, read_filter=lambda r: passes(r, filters),
                                cut_windows=cut, min_cut_scores=min_cut)
        assert ref['median'] == REF._num(want.median) and ref['n_windows'] == int(want.n)
        for k in ('width_deltas', 'width_n'):
            assert ref.get(k) == want.to_dict().get(k)


def test_two_requests_share_tiles_and_either_one_moves_the_revision(computed, monkeypatch):
    from services.nuc import nucgeo, regularity as R
    _fresh()
    path = computed.datasets['ds0'].paths[0]
    R.regularity_analysis(computed, [OBS], params={}, request_scope='p')       # the lanes take the defaults
    # other parameters, lanes on them: the geometry request computes the tiles first, the regularity one finds them
    R.set_dataset_params(computed, 'ds0', R.parse_params({'step_bp': 200}), computed.datasets['ds0'].paths)
    rev = R.revision(path)
    computed_by = []
    real_compute = R._compute_tiles
    monkeypatch.setattr(R, '_compute_tiles', lambda *a, **k: computed_by.append(threading.get_ident()) or real_compute(*a, **k))
    nucgeo.geometry_analysis(computed, [OBS], reg_params={'step_bp': 200}, patch_params={'min_share': 0.01})
    assert computed_by and R.revision(path) != rev               # tiles added for the lanes' parameters
    n = len(computed_by)
    R.regularity_analysis(computed, [OBS], params={'step_bp': 200})
    assert len(computed_by) == n                                  # nothing computed twice
    # concurrent requests over one cohort: each record computed once
    _fresh()
    seen, lock = [], threading.Lock()

    def spy(path_, cfg, rows, todo, *a, **k):
        with lock:
            seen.extend(todo)
        return real_compute(path_, cfg, rows, todo, *a, **k)
    monkeypatch.setattr(R, '_compute_tiles', spy)
    t = [threading.Thread(target=R.regularity_analysis, args=(computed, [OBS]), kwargs=dict(params={'ends': 'extend'})),
         threading.Thread(target=nucgeo.geometry_analysis, args=(computed, [OBS]),
                          kwargs=dict(reg_params={'ends': 'extend'}, patch_params={'min_share': 0.01}))]
    for x in t:
        x.start()
    for x in t:
        x.join()
    assert seen and len(seen) == len(set(seen))


def test_read_end_changes_reuse_full_windows_with_identical_tiles(computed):
    from services.nuc import regularity as R
    from services.nuc.store import STORE
    path = computed.datasets['ds0'].paths[0]
    keys = sorted(STORE.rows_of(path))[:80]
    rows = STORE.rows_of(path)
    src, cfg = _source(computed)
    for ends in ('extend', 'truncated', 'blank'):
        _fresh()
        p = R.parse_params({'ends': ends})
        R.ensure(path, cfg, rows, keys, R.parse_params({}))                  # the full windows first
        R.ensure(path, cfg, rows, keys, p)                                   # derived from them
        derived = {k: (R.cached_tiles(path, *k, R.digest8(p)), R.cached_scores(path, *k, R.digest8(p))) for k in keys}
        _fresh()
        with R._LOCK:
            R._BASE.clear()
        R.ensure(path, cfg, rows, keys, p)                                   # computed directly
        for k in keys:
            t, s = R.cached_tiles(path, *k, R.digest8(p)), R.cached_scores(path, *k, R.digest8(p))
            assert derived[k][0] == t
            assert (s is None and derived[k][1] is None) or np.array_equal(s, derived[k][1], equal_nan=True)


def test_returning_settings_find_their_revision_and_response_again(computed):
    from services.nuc import regularity as R
    _fresh()
    path = computed.datasets['ds0'].paths[0]
    a = R.regularity_analysis(computed, [OBS], params={'ends': 'blank'}, request_scope='p')
    rev_blank = R.revision(path)
    R.regularity_analysis(computed, [OBS], params={'ends': 'extend'}, request_scope='p')
    assert R.revision(path) != rev_blank
    import time
    t = time.time()
    back = R.regularity_analysis(computed, [OBS], params={'ends': 'blank'}, request_scope='p')
    assert R.revision(path) == rev_blank                       # the read caches' identity of the blank rows again
    assert back['observations'] == a['observations'] and time.time() - t < 1.0
    assert back['updatedDatasets'] == ['ds0']                  # the lanes moved back (the datasets are re-read)


def test_a_relabel_moves_the_labels_not_the_rows(computed):
    from services.nuc import nucgeo, regularity as R
    from services.nuc.layers import injector
    from services.nuc.store import STORE
    _fresh()
    path = computed.datasets['ds0'].paths[0]
    R.regularity_analysis(computed, [OBS], params={}, request_scope='p')
    first = nucgeo.geometry_analysis(computed, [OBS], patch_params={'min_share': 0.01, 'fold': 'none'},
                                     request_scope='p')
    assert first['geometries']
    rev, lrev = nucgeo.revision(path), nucgeo.labels_revision(path)
    reg_rev = R.revision(path)
    assert lrev
    second = nucgeo.geometry_analysis(computed, [OBS], patch_params={'min_share': 0.01, 'fold': 'none',
                                                                    'min_molecules': 2}, request_scope='p')
    assert second['geometries'] and len(second['geometries']) != len(first['geometries'])
    assert nucgeo.revision(path) == rev and R.revision(path) == reg_rev
    assert nucgeo.labels_revision(path) != lrev
    # the overlay names each live row's patches: the row's key and the patch index quality
    labels = nucgeo.patch_labels(computed, ['ds0'])['ds0']
    assert labels['identity'] and labels['files'] == [nucgeo.file_tag(path)]
    inject = injector(path, VIEW[0], VIEW[1], include_layers=True, requested_layers=['nucpatch'],
                      include_qualities=True, include_lift_meta=False)
    found = 0
    for sha, occ in sorted(STORE.rows_of(path)):
        row = dict(record_sha256=sha, alignment_occurrence=occ)
        inject(row)
        layer = row['layers'].get('nucpatch')
        if not layer:
            continue
        assert layer['lk'] == nucgeo.label_key(path, sha, occ) and layer['quality_names'][5] == 'patch'
        want = {i: (g, r) for i, g, r in labels['labels'].get(layer['lk'], [])}
        for idx, g, r in zip(layer['qualities'][5], layer['qualities'][3], layer['qualities'][4]):
            assert want.get(idx - 1, (0, 0)) == (g, r)                # the rows' own bytes agree with the overlay
            found += g > 0
    assert found
    # the dataset's identity carries it; a relabel never moves the regularity identity
    d = computed.datasets['ds0'].to_dict()
    assert d['patch_labels_identity'] == labels['identity']
    # ... nor the graph panel's row identity (its rows draw no patches: a relabel never evicts composed rows)
    from services.nuc.store import nuc_identity, regularity_identity
    ds = computed.datasets['ds0']
    reg_id, graph_id = regularity_identity(ds), nuc_identity(ds)
    nucgeo.geometry_analysis(computed, [OBS], patch_params={'min_share': 0.01, 'fold': 'none'}, request_scope='p')
    assert regularity_identity(ds) == reg_id and nuc_identity(ds) == graph_id


def test_tile_envelopes_in_one_pass_equal_the_per_interval_ones():
    from fiberhmm.nuc.records import make_molecule
    from services.nuc.regularity import mol_envelopes
    rng = np.random.default_rng(3)
    for reverse in (False, True):
        for trial in range(30):
            length = int(rng.integers(500, 6000))
            # aligned blocks with deletions and insertions (ordered on both sides), sometimes none at the start
            q, r, blocks = int(rng.integers(0, 50)), 1000, []
            while q < length - 10:
                n = int(rng.integers(1, 400))
                n = min(n, length - q)
                blocks.append((q, r, n))
                q += n + int(rng.integers(0, 30))          # an insertion
                r += n + int(rng.integers(0, 30))          # a deletion
            mol = make_molecule(length, nucs=[], hits=np.zeros(length, bool), name=f'm{trial}')
            mol.blocks = np.asarray(blocks, dtype=np.int64)
            mol.is_reverse = reverse
            a = rng.integers(-5, length, 200)
            b = a + rng.integers(-3, 600, 200)
            want = [mol.mol_interval_to_ref(int(x), int(y)) for x, y in zip(a, b)]
            assert mol_envelopes(mol, a, b) == want


def test_not_analysed_record_counts_on_the_helper_equal_bam_count(computed, monkeypatch):
    from services.nuc import record_count as RC
    from services.nuc.observations import _not_analysed
    from services.nuc.inputs import nuc_source
    from services.nuc.jobs import active_config
    path = computed.datasets['ds0'].paths[0]
    want = pysam.AlignmentFile(path, 'rb').count(CONTIG, 100_000, 140_000)
    assert want > 0
    monkeypatch.setattr(RC, 'USE_HELPER', True)
    try:
        assert RC.count(path, CONTIG, 100_000, 140_000) == want          # on the helper process
        monkeypatch.setattr(RC, 'USE_HELPER', False)
        assert RC.count(path, CONTIG, 100_000, 140_000) == want          # here
    finally:
        RC.shutdown()
    obs = dict(OBS, start=100_000, end=140_000)                           # a view nothing was computed over
    got = _not_analysed(computed, nuc_source(computed, 'ds0'), obs, active_config(computed, 'ds0'))
    assert got is not None and got[5]['records'] == got[5]['missing'] == want and got[5]['notAnalysed']


def test_an_analyse_starts_the_datasets_reference_when_asked(computed, monkeypatch):
    """With PREFETCH_ON_ANALYSE, an Analyse making the configuration active starts the dataset's reference for its
    current regularity parameters beside the molecules (the panel's first request finds it, or joins it)."""
    import time
    from services.nuc import jobs, reference as REF, regularity as R
    monkeypatch.setattr(REF, 'PREFETCH_ON_ANALYSE', True)
    _fresh()
    job = jobs.submit(computed, dict(datasets=['ds0'], chrom=CONTIG, start=VIEW[0], end=VIEW[1], parameters=SETTINGS,
                                     workers=2))
    assert jobs.wait(computed, job['job_id'], timeout=900)['status'] == 'complete'
    src, cfg = _source(computed)
    key = REF.key_of(list(src.paths), cfg, R.dataset_params(computed, 'ds0'))
    t = time.time()
    while key not in REF._REFS and time.time() - t < 120:
        time.sleep(0.2)
    assert REF._REFS[key]['median'] is not None
