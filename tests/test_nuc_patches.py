"""Nucleosome panel patch list (M4): per-observation patch scores. An observation's fraction over a scan's patch
equals the scan's own per-dataset fraction (same molecules, same measured bases), and each observation gets
FiberHMM's shift-within-read recurrence test with Benjamini-Hochberg q-values across the listed patches.
"""
from __future__ import annotations

from types import SimpleNamespace as NS

import pytest

pysam = pytest.importorskip('pysam')
pytest.importorskip('fiberhmm.scan.modules.nuc')

from nuc_fixtures import chromatin_bam

CONTIG, LENGTH = 'chrP', 160_000
SETTINGS = {'calibration': 'self', 'calibration_population': 400}
REGION = (30_000, 90_000)


@pytest.fixture(scope='module')
def bam(tmp_path_factory):
    return chromatin_bam(tmp_path_factory.mktemp('nuc_patches') / 'chromatin.bam', contig=CONTIG, length=LENGTH)


@pytest.fixture(scope='module')
def scan_dir(bam, tmp_path_factory):
    from fiberhmm.scan import run_units
    from fiberhmm.scan.units import plan
    out = tmp_path_factory.mktemp('nuc_patches_scan') / 'scan'
    run_units([{'dataset_id': 'dataset_1', 'paths': [bam]}], plan({CONTIG: LENGTH}, genome=True, contigs=[CONTIG]),
              modules=['nuc'], params={'nuc': SETTINGS}, out=out, annotate=False, cores=2)
    return out


@pytest.fixture(scope='module')
def computed(bam, tmp_path_factory):
    import os
    from services.nuc import jobs
    from services.nuc.store import STORE
    old = os.environ.get('FIBERBROWSER_SCAN_CACHE_DIR')
    os.environ['FIBERBROWSER_SCAN_CACHE_DIR'] = str(tmp_path_factory.mktemp('nuc_patches_cache'))
    STORE.clear()
    st = _state(bam)
    job = jobs.submit(st, dict(datasets=['ds0'], chrom=CONTIG, start=0, end=LENGTH, parameters=SETTINGS, workers=2))
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


OBS = dict(obsId='o1', label='Synthetic', datasetId='ds0', kind='linear', chrom=CONTIG, start=REGION[0], end=REGION[1])


def _scan_patches(scan_dir, st):
    from services.scan.registry import open_scan, close_scan
    from services.scan.serve import hits_for_view
    scan = open_scan(st, scan_dir)
    try:
        hits = hits_for_view(scan, 'nuc', CONTIG, 0, LENGTH)['hits']
    finally:
        close_scan(st, scan.scan_id)
    return [h for h in hits if h['typeId'].startswith('nuc.patch.')]


def test_fractions_match_the_scan_and_tests_are_per_observation(computed, scan_dir):
    from services.nuc.patches import patch_scores
    hits = _scan_patches(scan_dir, computed)
    kinds = {h['typeId'].rsplit('.', 1)[1] for h in hits}
    assert 'regular' in kinds, kinds
    listed = [dict(key=h['hitId'], type=h['typeId'].rsplit('.', 1)[1], chrom=h['chrom'], start=h['start'], end=h['end'])
              for h in hits]
    out = patch_scores(computed, [{**OBS, 'start': 0, 'end': LENGTH}], listed)['observations'][0]['patches']
    compared = 0
    for h in hits:
        kind = h['typeId'].rsplit('.', 1)[1]
        got = out[h['hitId']]
        if kind in ('phased', 'fuzzy'):
            assert 'note' in got
            continue
        want = h['raw'].get('dataset_1', {}).get('fraction', {})
        want = want.get('v') if isinstance(want, dict) else want
        assert got['fraction'] == pytest.approx(float(want), abs=1e-9), (h['hitId'], got, want)
        assert 0 <= got['p'] <= 1 and got['q'] is not None and got['q'] >= got['p'] - 1e-12
        compared += 1
    assert compared >= 1
    # The scan called these patches recurrent over all molecules: the one observation holds all of them.
    regular = [out[h['hitId']] for h in hits if h['typeId'] == 'nuc.patch.regular']
    assert any(r['significant'] for r in regular)


def test_an_observation_without_outputs_reports_them_missing(bam):
    from services.nuc.patches import patch_scores
    st = _state(bam)   # another session: nothing computed, no scan open
    out = patch_scores(st, [OBS], [dict(key='k', type='regular', chrom=CONTIG, start=40_000, end=42_000)])
    got = out['observations'][0]['patches']['k']
    assert got['p'] is None and got['fraction'] is None and got['notComputed'] > 0


def test_measured_bases_follow_the_records_aligned_blocks_whatever_the_source():
    """Codex E3: loaded rows (scan, annotated BAM) measure on the record's aligned blocks, like live rows and the scan
    module: a deletion inside a segment is not measured."""
    from services.nuc.patches import molecule_track
    from services.nuc.store import RecordOutputs
    # One record 900M8000D1100M from 0: a regular segment over [0, 9000) and a disordered one over [9000, 10000).
    row = RecordOutputs('r', 0, CONTIG, 0, 10_000, False, False, None,
                        {'nucseg': [(0, 1000, 0, 9000, (1, 200, 87), ''), (1000, 1000, 9000, 10_000, (2, 200, 0), '')]}, [], {})
    blocks = ((0, 900), (8900, 10_000))
    measured, kinds = molecule_track(row, None, blocks)
    assert measured == [(0, 900), (8900, 10_000)]
    assert kinds['reg'] == [(0, 9000)] and kinds['dis'] == [(9000, 10_000)]
    # Without blocks (no record at hand) the envelope is all that is known.
    assert molecule_track(row)[0] == [(0, 10_000)]


def test_a_window_across_an_insertion_keeps_every_projected_piece():
    """Codex E2: a lifted window projecting to source pieces on both sides of an insertion measures their hull on the
    contig they cover most, not the largest piece alone."""
    from services.nuc.observations import same_contig, window_hull
    assert window_hull([('h1', 0, 1000), ('h1', 5000, 6000)]) == ('h1', 0, 6000)
    assert window_hull([('h1', 0, 1000), ('h2', 0, 3000), ('h1', 5000, 5500)]) == ('h2', 0, 3000)
    assert window_hull([]) is None
    assert same_contig('chr3', '3') and not same_contig('chr3', 'chr13')
