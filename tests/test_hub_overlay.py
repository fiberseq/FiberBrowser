"""Feature hub V1: the overlaid patch view (services/hub/overlay.py) on synthetic chromatin with live nuc outputs.

Gates covered here:
- the regular-array overlay for two datasets with denominators: each bin's denominator is the number of the
  observation's molecules whose measured track holds the sample points (never a molecule that doesn't reach them),
  the numerator those with a regular segment there, and two datasets of the same reads give the same series;
- anchor alignment follows the strand (a '-' locus is the mirror of the '+' one);
- graph mode counts a locus only on paths that carry it (absent and unresolved paths are left out, and counted);
- the pile is a seeded sample: stable across calls, capped.
"""
from __future__ import annotations

from types import SimpleNamespace as NS

import numpy as np
import pytest

pysam = pytest.importorskip('pysam')
pytest.importorskip('fiberhmm.scan.modules.nuc')

from nuc_fixtures import chromatin_bam

CONTIG, LENGTH = 'chrP', 160_000
SETTINGS = {'calibration': 'self', 'calibration_population': 400}


@pytest.fixture(scope='module')
def computed(tmp_path_factory):
    import os
    from services.nuc import jobs
    from services.nuc.store import STORE
    bam = chromatin_bam(tmp_path_factory.mktemp('overlay') / 'chromatin.bam', contig=CONTIG, length=LENGTH)
    old = os.environ.get('FIBERBROWSER_SCAN_CACHE_DIR')
    os.environ['FIBERBROWSER_SCAN_CACHE_DIR'] = str(tmp_path_factory.mktemp('overlay_cache'))
    STORE.clear()
    from models.domain import Dataset
    from state.browser_state import BrowserState
    st = BrowserState(None)
    st.datasets = {}
    for ds_id, label in (('ds0', 'Dataset A'), ('ds1', 'Dataset B')):
        ds = Dataset(ds_id, bam, label=label)
        ds.available_layers = {'footprint': True}
        st.datasets[ds_id] = ds
    st.chroms = [NS(name=CONTIG, size=LENGTH)]
    job = jobs.submit(st, dict(datasets=['ds0', 'ds1'], chrom=CONTIG, start=20_000, end=100_000, parameters=SETTINGS, workers=2))
    assert jobs.wait(st, job['job_id'], timeout=900)['status'] == 'complete'
    yield st
    STORE.clear()
    if old is None:
        os.environ.pop('FIBERBROWSER_SCAN_CACHE_DIR', None)
    else:
        os.environ['FIBERBROWSER_SCAN_CACHE_DIR'] = old


OBS = [dict(obsId='a', label='Dataset A', datasetId='ds0', kind='linear'), dict(obsId='b', label='Dataset B', datasetId='ds1', kind='linear')]
LOCI = [dict(key=f'l{i}', chrom=CONTIG, start=s, end=s + 2000, anchor=s + 1000) for i, s in enumerate((40_000, 52_000, 64_000, 76_000))]


def test_two_datasets_with_denominators(computed):
    from services.hub.overlay import overlay
    res = overlay(computed, dict(loci=LOCI, layer='regular', align='left', flank=500, observations=OBS, pileMax=50))
    a, b = res['series']
    assert a['molecules'] > 0 and a['loci'] == 4
    assert a['num'] == b['num'] and a['den'] == b['den']            # the same reads in two datasets
    num, den = np.array(a['num']), np.array(a['den'])
    assert (num <= den + 1e-9).all() and den.max() > 0
    assert len(a['x']) == len(num) and a['x'][0] < 0 < a['x'][-1]
    assert res['xLabel'] == 'bp from the left edge'
    dens = num[den > 0] / den[den > 0]
    assert 0 < dens.max() <= 1


def test_denominator_counts_molecules_measured(computed):
    """At one bin of one locus, the denominator equals the molecules whose measured track holds the bin's sample
    points, counted independently from the observation's cohort and the nuc module's measured track."""
    from services.hub.overlay import SAMPLES_PER_BIN, Axis, _inside, overlay
    from services.nuc.inputs import browser_read_policy
    from services.nuc.observations import observation_cohort
    from services.nuc.patches import molecule_track
    from services.nuc.store import STORE
    locus = LOCI[1]
    res = overlay(computed, dict(loci=[locus], layer='regular', align='anchor', flank=1000, observations=OBS[:1], pileMax=0))
    s = res['series'][0]
    axis = Axis('anchor', 1000, [2000])
    pts, bins = axis.samples(locus['start'], locus['end'], locus['anchor'], False)
    policy = browser_read_policy(computed)
    _src, _recs, _w, cfg, cohort, _c = observation_cohort(computed, dict(OBS[0], chrom=CONTIG, start=locus['anchor'] - 1000,
                                                                           end=locus['anchor'] + 1001), policy)
    den = np.zeros(axis.nbins)
    num = np.zeros(axis.nbins)
    for rec, row in cohort:
        if row.low_information:
            continue
        hit = STORE.get_result(rec.path, rec.sha, rec.occ, cfg.config_for(rec.path))
        measured, kinds = molecule_track(row, hit[0] if hit else None, rec.blocks)
        m = _inside(pts, measured)
        np.add.at(den, bins[m], 1)
        np.add.at(num, bins[m & _inside(pts, sorted(kinds['reg']))], 1)
    assert np.allclose(np.array(s['den']), np.round(den / SAMPLES_PER_BIN, 3))
    assert np.allclose(np.array(s['num']), np.round(num / SAMPLES_PER_BIN, 3), atol=1e-3)
    # a molecule that doesn't reach a position is never counted there: the denominator falls toward the flanks' ends
    # only as molecules end, and never exceeds the cohort
    assert max(s['den']) <= len(cohort)


def test_anchor_alignment_follows_strand(computed):
    from services.hub.overlay import overlay
    plus = dict(LOCI[2], strand='+')
    minus = dict(LOCI[2], strand='-')
    rp = overlay(computed, dict(loci=[plus], layer='regular', align='anchor', flank=800, observations=OBS[:1], binBp=20, pileMax=0))['series'][0]
    rm = overlay(computed, dict(loci=[minus], layer='regular', align='anchor', flank=800, observations=OBS[:1], binBp=20, pileMax=0))['series'][0]
    # the axis is symmetric around the anchor ([-800, 801)); mirrored up to the anchor base itself
    np.testing.assert_allclose(rp['den'][:-1], rm['den'][::-1][1:], atol=0.5)


def test_graph_mode_counts_carriers_only(computed):
    from services.hub.overlay import overlay
    loci = [dict(LOCI[0], paths={'p1': dict(status='carried', hap='MAT', datasets=['ds0'])}),
            dict(LOCI[1], paths={'p1': dict(status='absent', hap='MAT', datasets=['ds0'])}),
            dict(LOCI[2], paths={'p1': dict(status='unresolved', hap='MAT', datasets=['ds0'])}),
            dict(LOCI[3], paths={'p2': dict(status='carried', hap='PAT', datasets=['ds0'])})]
    obs = [dict(obsId='g', label='MAT path', datasetId='ds0', kind='graph', graph=dict(hap='MAT'))]
    res = overlay(computed, dict(loci=loci, layer='regular', align='left', flank=500, observations=obs, pileMax=0))
    s = res['series'][0]
    assert res['graphMode'] is True
    assert s['loci'] == 1
    assert s['lociSkipped'] == {'absent': 1, 'unresolved': 2}
    alone = overlay(computed, dict(loci=[loci[0]], layer='regular', align='left', flank=500, observations=obs, pileMax=0))['series'][0]
    assert s['den'] == alone['den'] and s['num'] == alone['num']


def test_pile_is_a_stable_capped_sample(computed):
    from services.hub.overlay import overlay
    req = dict(loci=LOCI, layer='nucleosome', align='scaled', flank=500, observations=OBS[:1], pileMax=30)
    r1, r2 = overlay(computed, req), overlay(computed, req)
    assert len(r1['pile']) == 30 < r1['pileTotal']
    assert [(p['locus'], p['molecule']) for p in r1['pile']] == [(p['locus'], p['molecule']) for p in r2['pile']]
    assert r1['scaledBins'] == 100 and len(r1['series'][0]['x']) == 100 + 2 * len([x for x in r1['series'][0]['x'] if x < 0])


def test_requests_are_validated(computed):
    from services.hub.overlay import OverlayError, overlay
    with pytest.raises(OverlayError, match='No loci'):
        overlay(computed, dict(loci=[], observations=OBS))
    with pytest.raises(OverlayError, match='layer'):
        overlay(computed, dict(loci=LOCI, layer='x', observations=OBS))
    with pytest.raises(OverlayError, match='dataset panel'):
        overlay(computed, dict(loci=LOCI, observations=[]))
