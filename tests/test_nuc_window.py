"""Nucleosome panel window mode and selection (P-H): /api/nuc/window measures each observation inside a window with
FiberHMM's window metrics (an anchor's phasing in both frames, the dephasing readout against background anchors),
and /api/nuc/select names the molecules behind a summary's bar parts, NRL bins and events.
"""
from __future__ import annotations

from types import SimpleNamespace as NS

import pytest

pysam = pytest.importorskip('pysam')
pytest.importorskip('fiberhmm.scan.modules.nuc')

from nuc_fixtures import chromatin_bam

CONTIG, LENGTH = 'chrW', 160_000
SETTINGS = {'calibration': 'self', 'calibration_population': 400}
VIEW = (40_000, 70_000)


@pytest.fixture(scope='module')
def bam(tmp_path_factory):
    return chromatin_bam(tmp_path_factory.mktemp('nuc_window') / 'chromatin.bam', contig=CONTIG, length=LENGTH)


@pytest.fixture(scope='module')
def computed(bam, tmp_path_factory):
    """One live compute over the view, shared by the tests (the store is process-wide)."""
    import os
    from services.nuc import jobs
    from services.nuc.store import STORE
    old = os.environ.get('FIBERBROWSER_SCAN_CACHE_DIR')
    os.environ['FIBERBROWSER_SCAN_CACHE_DIR'] = str(tmp_path_factory.mktemp('nuc_window_cache'))
    STORE.clear()
    st = _state(bam)
    job = jobs.submit(st, dict(datasets=['ds0'], chrom=CONTIG, start=VIEW[0] - 10_000, end=VIEW[1] + 10_000,
                               parameters=SETTINGS, workers=2))
    assert jobs.wait(st, job['job_id'], timeout=900)['status'] == 'complete'
    yield st
    STORE.clear()
    if old is None:
        os.environ.pop('FIBERBROWSER_SCAN_CACHE_DIR', None)
    else:
        os.environ['FIBERBROWSER_SCAN_CACHE_DIR'] = old


def _state(bam):
    from models.domain import Dataset
    from state.browser_state import BrowserState
    st = BrowserState(None)
    ds = Dataset('ds0', bam, label='Synthetic')
    ds.available_layers = {'footprint': True}
    st.datasets = {'ds0': ds}
    st.chroms = [NS(name=CONTIG, size=LENGTH)]
    return st


OBS = dict(obsId='o1', label='Synthetic', datasetId='ds0', kind='linear', chrom=CONTIG, start=VIEW[0], end=VIEW[1])


def test_window_metrics_with_an_anchor_and_backgrounds(computed):
    from services.nuc.window import window_analysis
    win = dict(chrom=CONTIG, start=50_000, end=52_000)
    plain = window_analysis(computed, [OBS], win)['observations'][0]
    assert 'error' not in plain, plain
    m = plain['metrics']
    assert m['n_molecules'] >= 5 and m['nrl_quantiles'] and 150 < m['nrl_quantiles'][2] < 230
    assert 'phasing' not in m and 'dephasing' not in m
    anchored = window_analysis(computed, [OBS], win, anchor=dict(pos=51_000, orientation=0),
                               background=[dict(chrom=CONTIG, pos=p, orientation=0) for p in range(44_000, 66_000, 2_500)])
    a = anchored['observations'][0]
    m = a['metrics']
    assert set(m['phasing']) == {'anchor', 'molecule'}
    assert m['phasing']['anchor']['bins'] and m['phasing']['anchor']['P'] > 100
    assert sum(m['state_counts'].values()) == m['n_molecules']
    dep = m['dephasing']
    assert dep['n_background'] == a['background'] == 9
    assert dep['coherence']['stat'] == 'coherence'
    assert a['anchor'] == dict(chrom=CONTIG, pos=51_000, orientation=0)


def test_window_needs_computed_molecules(bam, computed):
    from services.nuc.window import window_analysis
    st = _state(bam)   # another session: no active configuration of its own
    out = window_analysis(st, [OBS], dict(chrom=CONTIG, start=50_000, end=52_000))['observations'][0]
    assert 'Compute' in out['error']


def test_selection_matches_the_summary(computed):
    from services.nuc.observations import summarize
    from services.nuc.window import select_reads
    summary = summarize(computed, [OBS])['observations'][0]
    nrl = summary['spacing']['nrl']
    edges, counts = nrl['edges'], nrl['counts']
    picked = 0
    for i, c in enumerate(counts):
        if not c:
            continue
        sel = select_reads(computed, OBS, dict(kind='nrl', lo=edges[i], hi=edges[i + 1]))
        assert len(sel['readIds']) == c
        assert sel['qnames'] == sorted(sel['readIds'])          # native rows: the record key is the QNAME
        picked += c
    assert picked == sum(counts) > 0
    mono = select_reads(computed, OBS, dict(kind='coarse', name='mono'))
    assert 0 < len(mono['readIds']) <= summary['molecules']
    regular = select_reads(computed, OBS, dict(kind='segment', state='regular'))
    assert len(regular['readIds']) > 0
    assert select_reads(computed, OBS, dict(kind='event', name='missing'))['molecules'] == mono['molecules']
    with pytest.raises(Exception):
        select_reads(computed, OBS, dict(kind='nonsense'))
