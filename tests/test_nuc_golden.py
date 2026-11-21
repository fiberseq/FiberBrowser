"""An independent golden case for the shared FiberHMM/FiberBrowser nucleosome maths (coverage plan #25).

The nucleosome parity tests compare FiberBrowser with the same FiberHMM functions, so a drift in the shared maths moves
both sides and they stay equal; the real-data checks (``test_nuc_real.py``) are gated on private paths. This case
pins absolute answers on synthetic data instead: ``tests/fixtures/nuc_golden/synthetic_chromatin.json`` holds the
counts derived by parsing the BAM's calls directly (no FiberBrowser or FiberHMM code) and the planted repeat lengths.
The live Analyse plus ``summarize`` must reproduce them.
"""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace as NS

import pytest

pysam = pytest.importorskip('pysam')
pytest.importorskip('fiberhmm.scan.modules.nuc')

from nuc_fixtures import chromatin_bam

GOLDEN = json.loads((Path(__file__).parent / 'fixtures' / 'nuc_golden' / 'synthetic_chromatin.json').read_text())
GEN = GOLDEN['generator']


def _calls(read):
    """Nucleosome calls of one record in reference coordinates, parsed from its MA tag (molecular coordinates)."""
    parts = read.get_tag('MA').split(';')
    length, out = int(parts[0]), []
    for group in parts[1:]:
        name, body = group.split(':', 1)
        if not name.startswith('nuc.'):
            continue
        for item in body.split(','):
            s, n = item.split('-')
            s, n = int(s) - 1, int(n)
            a, b = (length - (s + n), length - s) if read.is_reverse else (s, s + n)
            out.append((read.reference_start + a, read.reference_start + b))
    return out


def _truth(bam, start, end):
    with pysam.AlignmentFile(bam) as f:
        reads = list(f.fetch(GEN['contig'], start, end))
    calls = [c for r in reads for c in _calls(r)]
    return dict(molecules=len(reads), footprints=sum(1 for a, b in calls if start <= (a + b) // 2 < end),
                sizes={b - a for a, b in calls})


@pytest.fixture(scope='module')
def golden_state(tmp_path_factory):
    import os
    from models.domain import Dataset
    from services.nuc import jobs
    from services.nuc.store import STORE
    from state.browser_state import BrowserState
    root = tmp_path_factory.mktemp('nuc_golden')
    bam = chromatin_bam(root / 'chromatin.bam', contig=GEN['contig'], length=GEN['length'], step=GEN['step'],
                        seed=GEN['seed'])
    old = os.environ.get('FIBERBROWSER_SCAN_CACHE_DIR')
    os.environ['FIBERBROWSER_SCAN_CACHE_DIR'] = str(root / 'cache')
    STORE.clear()
    st = BrowserState(None)
    ds = Dataset('ds0', bam, label='Synthetic')
    ds.available_layers = {'footprint': True}
    st.datasets = {'ds0': ds}
    st.chroms = [NS(name=GEN['contig'], size=GEN['length'])]
    a = GOLDEN['analyse']
    job = jobs.submit(st, dict(datasets=['ds0'], chrom=GEN['contig'], start=a['start'], end=a['end'],
                               parameters=a['parameters'], workers=2))
    assert jobs.wait(st, job['job_id'], timeout=600)['status'] == 'complete'
    yield bam, st
    STORE.clear()
    if old is None:
        os.environ.pop('FIBERBROWSER_SCAN_CACHE_DIR', None)
    else:
        os.environ['FIBERBROWSER_SCAN_CACHE_DIR'] = old


@pytest.mark.parametrize('view', GOLDEN['views'], ids=[v['name'] for v in GOLDEN['views']])
def test_the_fixture_still_plants_the_golden_truth(golden_state, view):
    """Guards the generator: if nuc_fixtures changes, the golden file must be re-derived, not silently trusted."""
    bam, _st = golden_state
    t = _truth(bam, view['start'], view['end'])
    assert (t['molecules'], t['footprints']) == (view['molecules'], view['footprints'])
    assert t['sizes'] == {GOLDEN['footprint_size_bp']}


@pytest.mark.parametrize('view', GOLDEN['views'], ids=[v['name'] for v in GOLDEN['views']])
def test_the_live_summary_matches_the_golden_values(golden_state, view):
    from services.nuc.observations import summarize
    _bam, st = golden_state
    obs = dict(obsId='o', label='Synthetic', datasetId='ds0', kind='linear', chrom=GEN['contig'], start=view['start'],
               end=view['end'])
    o = summarize(st, [obs])['observations'][0]
    assert o['computed'] == o['molecules'] == view['molecules'] and o['notComputed'] == 0
    sizes = o['sizes']
    assert sizes['footprints'] == view['footprints']
    # every planted call is 147 bp: one mononucleosome each (a call cut by a molecule end may be edge-truncated)
    coarse = sizes['coarse']
    assert coarse['mono'] + coarse['edge_truncated'] + coarse['cant_tell'] == view['footprints']
    assert coarse['mono'] >= view['footprints'] - 5
    assert coarse['short'] == coarse['long'] == coarse['multi2'] == coarse['multi3'] == 0
    lo, hi = view['nrl_median']
    nrl = o['spacing']['nrl']
    assert nrl['n'] == view['molecules']
    assert lo <= nrl['quantiles'][2] <= hi, (view['name'], nrl['quantiles'])


def test_the_arrays_differ_by_their_planted_repeat(golden_state):
    """190 bp versus 172 bp: the two regular views must be told apart by the planted difference (18 bp)."""
    from services.nuc.observations import summarize
    _bam, st = golden_state
    med = {}
    for view in GOLDEN['views'][:2]:
        obs = dict(obsId=view['name'], label='S', datasetId='ds0', kind='linear', chrom=GEN['contig'],
                   start=view['start'], end=view['end'])
        med[view['name']] = summarize(st, [obs])['observations'][0]['spacing']['nrl']['quantiles'][2]
    assert 12 <= med['array_190'] - med['array_172'] <= 24, med
