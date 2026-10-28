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
    _src, _recs, _w, cfg, cohort, _c = observation_cohort(computed, dict(OBS[0], chrom=CONTIG, start=int(pts.min()),
                                                                           end=int(pts.max()) + 1), policy)
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
            dict(LOCI[3], paths={'p2': dict(status='carried', hap='PAT', datasets=['ds0'])}),
            dict(LOCI[3], key='partial', paths={'p1': dict(status='partial', hap='MAT', datasets=['ds0'])})]
    obs = [dict(obsId='g', label='MAT path', datasetId='ds0', kind='graph', graph=dict(hap='MAT'))]
    res = overlay(computed, dict(loci=loci, layer='regular', align='left', flank=500, observations=obs, pileMax=0))
    s = res['series'][0]
    assert res['graphMode'] is True
    # carried; a partial carrier on a native panel is left out (no lift to mask the columns it lacks; a lifted panel
    # measures it where its lift maps each base)
    assert s['loci'] == 1
    assert s['lociSkipped'] == {'absent': 1, 'unresolved': 2, 'partial': 1}
    alone = overlay(computed, dict(loci=[loci[0], loci[4]], layer='regular', align='left', flank=500, observations=obs, pileMax=0))['series'][0]
    assert s['den'] == alone['den'] and s['num'] == alone['num']
    # a linear panel of a haplotype the columns name follows the same rule; one they don't name is measured
    lin = overlay(computed, dict(loci=loci, layer='regular', align='left', flank=500, pileMax=0,
                                 observations=[dict(obsId='m', label='MAT panel', datasetId='ds0', kind='linear', liftHap='MAT'),
                                               dict(obsId='n', label='native', datasetId='ds1', kind='linear')]))['series']
    assert lin[0]['lociSkipped'] == {'absent': 1, 'unresolved': 1, 'partial': 1} and lin[0]['loci'] == 2   # the PAT-only locus has no MAT status: measured
    assert lin[1]['lociSkipped'] == {} and lin[1]['loci'] == 5


def test_pile_is_a_stable_capped_sample(computed):
    from services.hub.overlay import overlay
    req = dict(loci=LOCI, layer='nucleosome', align='scaled', flank=500, observations=OBS[:1], pileMax=30)
    r1, r2 = overlay(computed, req), overlay(computed, req)
    assert len(r1['pile']) == 30 < r1['pileTotal']
    assert [(p['locus'], p['molecule']) for p in r1['pile']] == [(p['locus'], p['molecule']) for p in r2['pile']]
    assert r1['scaledBins'] == 100 and len(r1['series'][0]['x']) == 100 + 2 * len([x for x in r1['series'][0]['x'] if x < 0])


def test_axis_samples_stay_inside_their_bins():
    """Bins are bounded: no sample beyond the range's end (a cut last bin), the scaled flanks cut at the flank, and a
    '-' locus mirrors onto bases inside the locus."""
    from services.hub.overlay import Axis
    ax = Axis('anchor', 1000, [2000], bin_bp=30)
    pts, bins = ax.samples(10_000, 10_100, 11_000, False)
    assert pts.min() >= 10_000 and pts.max() <= 12_000 and bins.max() == ax.nbins - 1
    assert ax.edges[0] == -1000 and ax.edges[-1] == 1001
    mpts, _ = ax.samples(10_000, 10_100, 11_000, True)
    assert mpts.min() >= 10_000 and mpts.max() <= 12_000
    sc = Axis('scaled', 1005, [50], bin_bp=10)
    assert sc.left_edges[0] == -1005 and sc.right_edges[-1] == 1005
    p, b = sc.samples(10_000, 10_001, 10_000, True)          # a one-base patch on '-'
    body = p[(b >= sc.n_left) & (b < sc.n_left + 100)]
    assert set(body.tolist()) == {10_000}
    p2, _ = sc.samples(10_000, 10_050, 10_025, True)
    assert p2.min() >= 10_000 - 1005 and p2.max() < 10_050 + 1005


def test_zero_flank_is_kept(computed):
    from services.hub.overlay import overlay
    res = overlay(computed, dict(loci=LOCI[:1], layer='regular', align='left', flank=0, observations=OBS[:1], pileMax=0))
    assert res['flank'] == 0 and res['x'][0] > 0


def test_insertion_loci_are_absent_on_this_genome(computed):
    from services.hub.overlay import overlay
    locus = dict(LOCI[0], end=LOCI[0]['start'] + 1, insertion=True)
    s = overlay(computed, dict(loci=[locus], layer='regular', align='anchor', flank=300, observations=OBS[:1], pileMax=0))['series'][0]
    assert s['lociSkipped'] == {'absent': 1} and s['molecules'] == 0


def test_pile_rows_cover_what_was_sampled():
    """A pile row drawn from samples covers each sample's own share of its bin: a fully sampled scaled locus is one
    run from the left flank's end to the right flank's end."""
    from services.hub.overlay import Axis, _runs
    ax = Axis('scaled', 1000, [400], bin_bp=10)
    pts, bins, x, w = ax.samples_x(10_000, 10_400, 10_200, False)
    runs = _runs(x, w, np.ones(len(x), bool))
    # one run from the left flank's end (-1000 bp) through the patch (0-1) to the right flank's end (1 + 1000 bp)
    assert runs == [(-1000.0, 1001.0)]
    ax2 = Axis('left', 500, [1000], bin_bp=20)
    _p, _b, x2, w2 = ax2.samples_x(5000, 6000, 5500, False)
    assert _runs(x2, w2, np.ones(len(x2), bool)) == [(-500.0, 1500.0)]


def test_cluster_style_contig_aliases_are_one_contig():
    from services.hub.assoc import _cluster_check, normalize_request
    d = normalize_request(dict(mode='M3', a=dict(kind='marks', typeId='nuc.seg.regular'),
                               group=dict(kind='cluster', clusterRegions=[['1', 150, 160]], flank=0)))
    assert _cluster_check(d, [('chr1', 100, 200)])['status'] == 'refused'


def test_requests_are_validated(computed):
    from services.hub.overlay import OverlayError, overlay
    with pytest.raises(OverlayError, match='No loci'):
        overlay(computed, dict(loci=[], observations=OBS))
    with pytest.raises(OverlayError, match='layer'):
        overlay(computed, dict(loci=LOCI, layer='x', observations=OBS))
    with pytest.raises(OverlayError, match='dataset panel'):
        overlay(computed, dict(loci=LOCI, observations=[]))


def test_lift_points_maps_each_sample_through_its_haplotypes_pieces(monkeypatch):
    """A lifted panel maps every sample through its haplotype's primary pieces: a target-only stretch (a deletion on
    that haplotype) has no source base (nothing measured there), a '-' piece reverses, another haplotype's piece and a
    second contig are never used."""
    import services.lift.live_lift as ll
    from services.hub.overlay import lift_points
    P = ll.LiftPiece
    pieces = [P(1, 1000, 1500, 100, 600, '+', True, 'h1', 'chrT_MAT'),
              P(1, 2400, 3000, 600, 1200, '+', True, 'h1', 'chrT_MAT'),        # 1500-2400: target only (deleted on MAT)
              P(2, 1000, 3000, 5000, 7000, '+', True, 'h2', 'chrT_PAT'),       # the other haplotype
              P(3, 3000, 3100, 900, 1000, '-', True, 'h1', 'chrT_MAT'),        # a reversed piece
              P(4, 3100, 3200, 50, 150, '+', True, 'h1', 'chrX_MAT')]           # another contig (fewer samples)
    monkeypatch.setattr(ll, 'select_pieces', lambda *a, **k: NS(pieces=pieces))
    monkeypatch.setattr(ll, 'lift_key', lambda *a, **k: 'k')
    handle = NS(map=NS(targets={'chrT': 1}), resolve_haplotypes=lambda h: ['h1', 'h2'], haplotype_labels={'h1': 'MAT', 'h2': 'PAT'})
    state = NS(datasets={'ds': NS(live_lift=NS(handle=handle, haplotypes=None, settings=None))})
    pts = np.array([1000, 1499, 1500, 2000, 2399, 2400, 2999, 3000, 3099, 3150])
    out, contig = lift_points(state, NS(browser_id='ds'), 'MAT', 'chrT', pts)
    assert contig == 'chrT_MAT'
    assert out.tolist() == [100, 599, -1, -1, -1, 600, 1199, 999, 900, -1]


def test_assembly_hits_are_lifted_per_sample_unless_inside_an_insertion(monkeypatch):
    """Codex round 3 (C): a placed (non-insertion) hit of an assembly scan is sampled on this genome's axis and each
    sample lifted, on its own dataset too; only a hit inside an insertion is sampled on its own source coordinates."""
    import services.hub.overlay as ov
    import services.nuc.inputs as ni
    import services.nuc.observations as no
    calls, fetched = [], []
    monkeypatch.setattr(ni, 'nuc_source', lambda state, ds: NS(browser_id=ds, kind='lifted', paths=()))
    monkeypatch.setattr(ni, 'browser_read_policy', lambda state, include_duplicates=False: {'filters': {}})

    def fake_lift(state, source, hap, chrom, pts):
        calls.append((chrom, int(pts.min()), int(pts.max())))
        return pts + 20_000, 'chrT_MAT'
    monkeypatch.setattr(ov, 'lift_points', fake_lift)

    def fake_cohort(state, scoped, policy):
        fetched.append(scoped['graph'])
        return None, [], [(scoped['graph']['contig'], scoped['graph']['start'], scoped['graph']['end'])], None, [], {'missing': 0}
    monkeypatch.setattr(no, 'observation_cohort', fake_cohort)
    obs = [dict(obsId='m', label='MAT', datasetId='ds_lift', kind='linear', liftHap='MAT')]
    src = dict(chrom='chrT_MAT', start=50_000, end=50_300, anchor=50_150, hap='MAT', datasetId='ds_lift')
    placed = dict(key='p', chrom='chrT', start=1000, end=1200, anchor=1100, source=src)
    ov.overlay(None, dict(loci=[placed], layer='regular', align='left', flank=100, observations=obs, pileMax=0))
    assert calls and calls[0][0] == 'chrT'                       # lifted from this genome's axis
    assert fetched[0]['contig'] == 'chrT_MAT' and 20_900 <= fetched[0]['start'] < 20_910    # the lifted samples' span
    calls.clear(); fetched.clear()
    inside = dict(key='i', chrom='chrT', start=1200, end=1201, anchor=1200, insertion=True, source=src)
    ov.overlay(None, dict(loci=[inside], layer='regular', align='left', flank=100, observations=obs, pileMax=0))
    assert not calls                                             # its own source coordinates, no lift
    assert fetched[0]['contig'] == 'chrT_MAT' and 49_900 <= fetched[0]['start'] < 49_910    # source coordinates
