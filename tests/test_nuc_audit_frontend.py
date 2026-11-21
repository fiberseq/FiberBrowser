"""Backend halves of the frontend audit fixes: a panel's first request sets the lanes (they show what its controls
show, never what an earlier tab or session chose), and geometry rows carry per-dataset counts over each molecule once
(overlapping panels never double-count). Synthetic Hia5 molecules (tests/nuc_fixtures.py)."""
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
def computed(tmp_path_factory):
    import os
    from models.domain import Dataset
    from state.browser_state import BrowserState
    from services.nuc import jobs, nucgeo
    from services.nuc.regularity import clear_references
    from services.nuc.store import STORE
    bam = chromatin_bam(tmp_path_factory.mktemp('nuc_fe') / 'chromatin.bam', contig=CONTIG, length=LENGTH)
    old = os.environ.get('FIBERBROWSER_SCAN_CACHE_DIR')
    os.environ['FIBERBROWSER_SCAN_CACHE_DIR'] = str(tmp_path_factory.mktemp('nuc_fe_cache'))
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


def test_a_panels_first_request_sets_the_lanes_and_re_asks_never_flip_them(computed):
    from services.nuc import regularity as R
    path = computed.datasets['ds0'].paths[0]
    # an earlier session chose 'extend'
    R.regularity_analysis(computed, [OBS], params={'ends': 'extend'}, request_scope='old-tab')
    assert R.path_params(path).ends == 'extend'
    # a panel opened now with the defaults (sent in full): its first request sets the lanes to what it shows
    R.regularity_analysis(computed, [OBS], params={'ends': 'blank'}, request_scope='new-panel')
    assert R.path_params(path).ends == 'blank'
    # the old tab re-asking with unchanged settings never takes them back; a change of its settings does
    R.regularity_analysis(computed, [OBS], params={'ends': 'extend'}, request_scope='old-tab')
    assert R.path_params(path).ends == 'blank'
    R.regularity_analysis(computed, [OBS], params={'ends': 'truncated'}, request_scope='old-tab')
    assert R.path_params(path).ends == 'truncated'
    R.regularity_analysis(computed, [OBS], params={'ends': 'blank'}, request_scope='new-panel')
    assert R.path_params(path).ends == 'truncated'


def test_geometry_rows_count_each_molecule_once_per_dataset(computed):
    from services.nuc import nucgeo
    two = [OBS, dict(OBS, obsId='o2', label='Overlapping panel')]
    out = nucgeo.geometry_analysis(computed, two, patch_params={'min_share': 0.01, 'min_molecules': 2})
    rows = out['geometries']
    assert rows, 'the synthetic locus forms geometries'
    for g in rows:
        a, b = g['perObservation']['o1'], g['perObservation']['o2']
        d = g['perDataset']['ds0']
        assert a['molecules'] == b['molecules'] == d['molecules']          # not the sum of the two panels
        assert d['full'] == a['full'] and d['partial'] == a['partial'] and d['callable'] == a['callable']
