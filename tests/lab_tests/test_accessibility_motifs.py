"""Accessibility (preview) motifs: per-matrix p-value thresholds (exact score distributions), the enrichment and
differential statistics, family collapse, pinned key factors, and a regression that Zelda (vfl) and GAF (Trl) sites
are reported on a fly sequence that carries them."""
import itertools

import numpy as np
import pysam
import pytest

from lab.services import accessibility_analysis as aa
from lab.services import accessibility_motifs as AM
from services import motifs as M
from state.browser_state import BrowserState

from test_accessibility_views import _variant, run, state  # noqa: F401 (fixtures)
from test_accessibility_workflow import REQUEST, _empty_bam, _wait, planted_payload
from lab.services import accessibility_workflow as aw

BG = {'A': .3, 'C': .2, 'G': .2, 'T': .3}


def _random_counts(rng, length):
    return {b: list(v) for b, v in zip('ACGT', rng.integers(0, 40, size=(4, length)).astype(float))}


def _brute_tail(sm, bg):
    """P(S >= s) for every integer score s, enumerating all 4^L sequences."""
    probs = np.array([bg[b] for b in 'ACGT'])
    scores, weights = [], []
    for seq in itertools.product(range(4), repeat=sm.length):
        scores.append(sum(int(sm.int_pssm[b, i]) for i, b in enumerate(seq)))
        weights.append(float(np.prod(probs[list(seq)])))
    scores, weights = np.array(scores), np.array(weights)
    return {s: float(weights[scores >= s].sum()) for s in range(sm.smin, sm.smax + 2)}


@pytest.mark.parametrize('length,seed', [(3, 1), (5, 2), (6, 3)])
def test_the_p_value_threshold_matches_a_brute_force_score_distribution(length, seed):
    rng = np.random.default_rng(seed)
    sm = M.scored_matrix('T', 'test', _random_counts(rng, length), BG)
    assert sm.background == M.normalize_background(BG)
    brute = _brute_tail(sm, sm.background)
    for s, tail in brute.items():
        assert sm.pvalue(s) == pytest.approx(tail, rel=1e-9, abs=1e-15)
    for p in (1e-1, 1e-2, 1e-3, 1e-4):
        cut = sm.cutoff_for_p(p)
        if cut is None:                                   # even the best sequence is more likely than p
            assert brute[sm.smax] > p and sm.min_p > p
            continue
        assert brute[cut] <= p * (1 + 1e-9) and (cut == sm.smin or brute[cut - 1] > p * (1 + 1e-9))


def test_a_short_matrix_cannot_reach_a_strict_p_value():
    sm = M.scored_matrix('T', 'GATA', M.consensus_to_pwm('GATA'), M.UNIFORM_BACKGROUND)
    assert sm.min_p == pytest.approx(4 ** -4, rel=1e-6) and sm.cutoff_for_p(1e-4) is None
    assert sm.cutoff_for_relative(1.0) == sm.smax and sm.cutoff_for_relative(0.0) == sm.smin


def test_log_odds_matches_biopython_with_jaspar_pseudocounts():
    motifs = pytest.importorskip('Bio.motifs')
    from Bio.motifs import jaspar
    rng = np.random.default_rng(7)
    counts = _random_counts(rng, 9)
    m = motifs.Motif(alphabet='ACGT', counts=counts)
    m.background = BG
    bio = m.counts.normalize(pseudocounts=jaspar.calculate_pseudocounts(m)).log_odds(BG)
    ours = M.log_odds_pssm(counts, BG)
    assert np.allclose(ours, np.array([bio[b] for b in 'ACGT']), atol=1e-12)


def test_scanning_reports_exact_p_values_on_both_strands():
    motif = 'TTGACCGGTA'
    sm = M.scored_matrix('T', 'X', M.consensus_to_pwm(motif), BG)
    seq = 'C' * 30 + motif + 'C' * 30 + M.reverse_complement(motif) + 'C' * 30
    hits = M.scan_scored(seq, sm, sm.cutoff_for_p(1e-5))
    assert sorted((h['start'], h['strand']) for h in hits) == [(30, '+'), (70, '-')]
    for h in hits:
        assert h['p'] == pytest.approx(sm.min_p) and h['int_score'] == sm.smax
    assert M.background_composition('ACGT') == M.UNIFORM_BACKGROUND      # too short: uniform


def test_benjamini_hochberg_and_the_rate_test():
    from scipy.stats import binom
    q = AM.bh([0.01, 0.04, 0.03, 0.2, None])
    assert q[:4] == pytest.approx([0.04, 0.04*4/3, 0.04*4/3, 0.2]) and q[4] is None     # step-up, monotone
    assert AM.rate_test(3, 100, 2, 1000) == pytest.approx(binom.sf(2, 5, 100/1100))
    assert AM.rate_test(0, 100, 5, 1000) == 1.0 and AM.rate_test(1, 0, 5, 1000) is None
    # under the null (equal rates) the test is valid: P(p <= 0.05) <= 0.05
    rng = np.random.default_rng(1)
    ps = [AM.rate_test(int(rng.poisson(2.0)), 200, int(rng.poisson(20.0)), 2000) for _ in range(4000)]
    assert np.mean(np.array(ps) <= 0.05) <= 0.055
    assert AM.poisson_test(0, 0.1) == 1.0 and AM.poisson_test(2, 0.1) == pytest.approx(1 - np.exp(-.1)*(1 + .1))


def _entry(mid, name, counts, sites, pinned=None):
    return dict(matrix_id=mid, name=name, counts=counts, sites=[dict(start=a, end=a + 10, p=1e-5, score=10.) for a in sites],
                **({'pinned_as': pinned} if pinned else {}))


def test_families_collapse_similar_matrices_that_hit_the_same_bases():
    a = M.consensus_to_pwm('GGGAAATTCCC')
    b = M.consensus_to_pwm('GGGAAATTCCA')                   # the same family (Rel-like), one position differs
    c = M.consensus_to_pwm('TTGACCGGTAA')                   # unrelated
    fam = AM.families([_entry('MA1.1', 'dl', a, [100, 300, 500]), _entry('MA2.1', 'Dif', b, [101, 300, 502]),
                       _entry('MA3.1', 'other', c, [100, 300, 500])])
    names = sorted(sorted(e['name'] for e in g) for g in fam)
    assert names == [['Dif', 'dl'], ['other']]
    # similar shape but elsewhere: not redundant here
    fam = AM.families([_entry('MA1.1', 'dl', a, [100, 300, 500]), _entry('MA2.1', 'Dif', b, [900, 1200, 1500])])
    assert len(fam) == 2
    # versions of one matrix always collapse; two different pinned names never do
    fam = AM.families([_entry('MA5.1', 'x', a, [100]), _entry('MA5.2', 'x', c, [700])])
    assert len(fam) == 1
    fam = AM.families([_entry('MA1.1', 'dl', a, [100, 300], pinned='dl'), _entry('MA2.1', 'Dif', b, [100, 300], pinned='Dif')])
    assert len(fam) == 2
    assert AM.similarity(a, b) > .8 > AM.similarity(a, c)


def test_pinned_motifs_are_always_reported(state, run):
    from services.motifs import consensus_to_pwm
    right = _variant(run, 'N1', 1690, 1780)
    pwms = [('X0001.1', 'PLANTED', consensus_to_pwm('GCCGATAAGGCC')), ('X0002.1', 'ABSENT', consensus_to_pwm('TATACGCGTATACG'))]
    m = aa.nfr_motifs(state, run['job_id'], 'N1', pwms=pwms, p=1e-6, pinned=['ABSENT', 'NOPE'])
    rows = {r['name']: r for r in m['families']}
    assert rows['ABSENT']['pinned'] == ['ABSENT'] and rows['ABSENT']['total'] == 0
    assert rows['PLANTED']['pinned'] == [] and rows['PLANTED']['enrichment'][right['name']]['sites'] == 1
    assert m['pinned']['missing'] == ['NOPE'] and m['tested'] == 2
    # without pinning, a motif without sites is tested (counted in m) but not listed
    m = aa.nfr_motifs(state, run['job_id'], 'N1', pwms=pwms, p=1e-6, pinned=[])
    assert [r['name'] for r in m['families']] == ['PLANTED'] and m['tested'] == 2


# ---------------------------------------------------------------- regression: Zelda and GAF on a fly sequence
VFL = 'CAGGTAG'
TRL = 'GAGAGAGAG'


@pytest.fixture
def fly_state(tmp_path, monkeypatch):
    rng = np.random.default_rng(11)
    seq = list(''.join(rng.choice(list('ACGT'), 5000, p=[.3, .2, .2, .3])))
    for at, site in ((1700, VFL), (1725, TRL), (1755, VFL)):        # inside the right register (1690-1780)
        seq[at:at + len(site)] = site
    path = tmp_path / 'fly.fa'
    path.write_text('>chrT\n' + ''.join(seq) + '\n')
    pysam.faidx(str(path))
    s = BrowserState(None, fasta_path=str(path))
    s.add_dataset('d', str(_empty_bam(tmp_path)))
    monkeypatch.setattr('services.consensus_workflow.load_payload', lambda *a, **k: planted_payload())
    monkeypatch.setattr('services.motifs.jaspar_genome', lambda state: ('dm6', False))
    monkeypatch.setattr('services.motifs.coordinate_genome', lambda state: 'dm6')
    return s


def test_zelda_and_gaf_sites_are_reported_on_a_fly_sequence(fly_state):
    pytest.importorskip('pyjaspar')
    job = _wait(fly_state, aw.submit(fly_state, REQUEST)['job_id'])
    assert job['status'] == 'complete', job['message']
    right = _variant(job, 'N1', 1690, 1780)
    m = aa.nfr_motifs(fly_state, job['job_id'], 'N1')                  # every fly CORE matrix, the default pinned set
    assert m['species']['taxid'] == 7227 and m['scanned'] > 200
    # Ibf1 (not in JASPAR CORE) is no longer a default: it is reported as retired, quietly
    assert 'vfl' in m['pinned']['requested'] and 'Ibf1' not in m['pinned']['requested'] and m['pinned']['retired'] == ['Ibf1']
    rows = {r['name']: r for r in m['families']}
    vfl, trl = rows['vfl'], rows['Trl']
    assert vfl['common'] == 'Zelda' and trl['common'] == 'GAF'
    assert vfl['pinned'] == ['vfl'] and trl['pinned'] == ['Trl']
    assert vfl['enrichment'][right['name']]['sites'] == 2 and trl['enrichment'][right['name']]['sites'] >= 1
    starts = {s['start'] for s in vfl['sites']}
    assert {1700, 1755} <= starts
    # they rank on their statistics, and pinned rows are listed whatever their rank
    assert vfl['enrichment'][right['name']]['p_local'] < .05
    assert all(r['pinned'] or r['total'] for r in m['families'])


# ---------------------------------------------------------------- Codex review regressions
def test_an_at_only_background_is_regularised_and_scores():
    bg = M.background_composition('AAAT' * 100)
    assert bg['A'] == bg['T'] and bg['C'] == bg['G'] > 0 and sum(bg.values()) == pytest.approx(1)
    sm = M.scored_matrix('T', 'GC', M.consensus_to_pwm('GCGCGC'), bg)
    assert np.isfinite(sm.int_pssm).all() and 0 < sm.min_p < 1


def test_the_score_cache_keys_on_the_background_used_and_the_counts():
    a = AM._scored(M, 'X1', 'x', M.consensus_to_pwm('ACGTACGT'), {'A': .30001, 'C': .2, 'G': .2, 'T': .30001})
    b = AM._scored(M, 'X1', 'x', M.consensus_to_pwm('ACGTACGT'), {'A': .38, 'C': .12, 'G': .12, 'T': .38})
    assert a.background != b.background and a.background == M.normalize_background({'A': .30001, 'C': .2, 'G': .2, 'T': .30001})
    c = AM._scored(M, 'X1', 'x', M.consensus_to_pwm('TTTTGGGG'), {'A': .30001, 'C': .2, 'G': .2, 'T': .30001})
    assert not np.array_equal(a.int_pssm, c.int_pssm)                  # same ID, other counts: not the cached one


def test_intervals_are_half_open_everywhere():
    assert AM._inside(100, [[100, 150]]) and not AM._inside(150, [[100, 150]])
    assert AM._minus([[100, 200]], [[150, 250]]) == [[100.0, 150.0]]


def test_exposure_counts_only_complete_called_windows():
    called = np.array([c in 'ACGT' for c in 'CN' * 50 + 'ACGTACGTACGT'])
    starts = np.concatenate([[0], np.cumsum(np.lib.stride_tricks.sliding_window_view(called, 8).all(axis=1))])
    assert AM.window_exposure(starts, 0, 8, [[0, 100]]) == 0                # fragmented: no window fits
    assert AM.window_exposure(starts, 0, 8, [[100, 112]]) == 5             # starts 100-104, centres 104-108
    assert AM.rate_test(1, 50, 0, 0) is None                               # no background exposure: no comparison


def test_unreachable_families_count_in_the_model_correction_and_pins_stay_apart(state, run):
    from services.motifs import consensus_to_pwm
    pwms = [('X0001.1', 'A', consensus_to_pwm('GCCGATAAGGCC')), ('X0001.2', 'B', consensus_to_pwm('TATACGCGTATACG')),
            ('X0003.1', 'SHORT', consensus_to_pwm('GATA'))]
    m = aa.nfr_motifs(state, run['job_id'], 'N1', pwms=pwms, p=1e-6, pinned=['A', 'B', 'SHORT'])
    rows = {r['name']: r for r in m['families']}
    assert rows['A']['pinned'] == ['A'] and rows['B']['pinned'] == ['B']   # versions of one matrix, two pins: apart
    assert not rows['SHORT']['reachable'] and m['tested'] == 3
    right = _variant(run, 'N1', 1690, 1780)['name']
    e = rows['SHORT']['enrichment'][right]
    assert e['p_model'] == 1.0 and e['expected'] == 0
    a = rows['A']['enrichment'][right]
    assert a['q_model'] == pytest.approx(min(1, a['p_model'] * 3))        # m = 3 families, A the only small p


# ---------------------------------------------------------------- round 3: the hierarchy of evidence at sites
def test_site_layers_are_nested_and_tested_per_layer(state, run, monkeypatch):
    from lab.services import accessibility_occupancy as OC
    from services.motifs import consensus_to_pwm
    job = aw._session(state)[0][run['job_id']]
    mols = job['result']['molecules']
    min_gap = int(job['result']['parameters'].get('min_gap_bp', 60))
    cache = {}
    open_at = sorted(u for u, m in mols.items() if OC.read_state(m, 1746, min_gap, cache) == 'open')
    closed_at = sorted(u for u, m in mols.items() if OC.read_state(m, 1746, min_gap, cache) == 'closed')
    assert len(open_at) > 40 and len(closed_at) > 40
    state_ = {u: int(i % 2 == 0) for i, u in enumerate(open_at)}           # half the open reads footprinted
    state_.update({u: 1 for u in closed_at[:3]})                           # 3 footprinted-but-closed: QC
    state_.update({u: 0 for u in closed_at[3:20]})
    cls = [dict(id='class_7', label='class 7', start=1735., end=1757., prevalence=.2, state=state_)]
    monkeypatch.setattr(OC, 'class_source', lambda st, jb: dict(key=('test',), classes=cls, job_id='c1', joined='run'))
    right = _variant(run, 'N1', 1690, 1780)['name']
    full = _variant(run, 'N1', 1500, 1720)['name']
    m = aa.nfr_motifs(state, run['job_id'], 'N1', pwms=[('X0001.1', 'PLANTED', consensus_to_pwm('GCCGATAAGGCC'))], p=1e-6,
                      pinned=['PLANTED'], flank=600)
    row = m['families'][0]
    site = next(s for s in row['sites'] if s['start'] == 1740)
    L = site['layers']
    assert [c['id'] for c in site['classes']] == ['class_7']
    assert L[right]['p_open'] > .9 and L[full]['p_open'] < .1                 # the right register opens over the site
    r = L[right]
    assert r['p_fp_given_open'] == pytest.approx(r['footprinted']/r['labelled'], abs=1e-4)
    assert 0.3 < r['p_fp_given_open'] < 0.7
    assert r['p_footprinted'] == pytest.approx(r['p_open']*r['p_fp_given_open'], abs=1e-3)
    st = r['stack']
    assert st['closed'] + st['open_unfootprinted'] + st['open_footprinted'] == pytest.approx(1, abs=1e-3)
    # the tests compare disjoint groups: here every right-register read is also a left-register member (the split
    # reads carry both openings), so only the full variant has reads of its own and nothing is tested at this site
    assert site['q_open_diff'] is None and site['p_fp_diff'] is None
    occ = m['occupancy']
    assert occ['shared_reads'] > 0
    assert occ['available'] and occ['classes'] == 1
    # members that are not open at the site (nucleosome or linker protection) are counted by reason and left out
    assert sum(occ['excluded_members'].values()) == 3
    assert sum(sum(x['excluded_members'].values()) for x in L.values()) == 3
    assert occ['unlabelled_share'] is not None and all(x['unlabelled_open'] == x['open'] - x['labelled'] for x in L.values())
    assert all(x['footprinted'] <= x['open'] for x in L.values())
    assert row['footprint_classes'] == ['class 7']
    # meta-profile around the planted family: open at the centre for the right register, footprinted only over the class
    prof = aa.nfr_motif_profile(state, run['job_id'], 'N1', ['X0001.1'], 'nfr', pwms=[('X0001.1', 'PLANTED', consensus_to_pwm('GCCGATAAGGCC'))],
                                p=1e-6, pinned=['PLANTED'], flank=150)     # the window holds only the planted site at 1740
    assert prof['sites'] == 1
    i0 = prof['offsets'].index(0)
    v = prof['variants'][right]
    assert v['p_open'][i0] > .9 and 0.3 < v['p_fp_given_open'][i0] < 0.7
    far = prof['offsets'].index(-100)
    assert v['p_fp_given_open'][far] in (None, 0.0)
    assert 'all' in prof['variants'] and prof['sites'] >= 1


def test_site_layers_without_classes_still_report_openness(state, run):
    from services.motifs import consensus_to_pwm
    m = aa.nfr_motifs(state, run['job_id'], 'N1', pwms=[('X0001.1', 'PLANTED', consensus_to_pwm('GCCGATAAGGCC'))], p=1e-6, flank=600)
    site = next(s for r in m['families'] for s in r['sites'] if s['start'] == 1740)
    assert site['classes'] == [] and site['p_fp_diff'] is None
    assert all(x['p_fp_given_open'] is None and x['p_open'] is not None for x in site['layers'].values() if x['reads'])
    assert m['occupancy']['classes'] == 0


def test_motif_options_modes_and_validation():
    from services.motif_scoring import motif_options
    o = motif_options()
    assert o['mode'] == 'p' and o['p'] == 1e-4 and o['relative'] == 0.8
    assert motif_options(relative=0.9)['mode'] == 'relative'                  # an older request: relative only
    assert motif_options(mode='p', relative=0.9, p=3e-5)['mode'] == 'p'      # each mode keeps its own threshold
    for bad in (dict(mode='x'), dict(p=1), dict(relative=0.2), dict(background='gc'), dict(strand='x'),
                dict(family_similarity=0.1), dict(custom='x'), dict(pinned='CTCF')):
        with pytest.raises(ValueError):
            motif_options(**bad)


def test_custom_motifs_from_text_and_scanned_like_jaspar(state, run):
    from services.motif_scoring import parse_motif_text, genome_composition
    assert parse_motif_text('GCCGATAAGGCC')[0]['counts']['G'][0] == 100
    rows = parse_motif_text('A [ 0 10 0 ]\nC [ 10 0 0 ]\nG [ 0 0 10 ]\nT [ 0 0 0 ]', 'X')
    assert rows[0]['counts']['C'] == [10, 0, 0] and rows[0]['name'] == 'X'
    cols = parse_motif_text('0.1 0.7 0.1 0.1\n0.7 0.1 0.1 0.1\n0.1 0.1 0.7 0.1')
    assert cols[0]['counts']['C'][0] == pytest.approx(0.7)
    jas = parse_motif_text('>MA9999.1 Foo\nA [ 1 2 3 ]\nC [ 1 2 3 ]\nG [ 1 2 3 ]\nT [ 4 2 1 ]')
    assert jas[0]['name'] == 'Foo'
    meme = parse_motif_text('MEME version 4\n\nMOTIF M1 bar\nletter-probability matrix: alength= 4 w= 3\n0.1 0.2 0.3 0.4\n0.4 0.3 0.2 0.1\n0.25 0.25 0.25 0.25\n')
    assert meme and len(meme[0]['counts']['A']) == 3
    for bad in ('', '1 2\n3 4', 'A [ -1 2 3 ]\nC [ 1 2 3 ]\nG [ 1 2 3 ]\nT [ 1 2 3 ]'):
        with pytest.raises(ValueError):
            parse_motif_text(bad)
    # a custom matrix is scanned with the species' (here the test's) and is pinnable by name
    from services.motifs import consensus_to_pwm
    m = aa.nfr_motifs(state, run['job_id'], 'N1', pwms=[('X0002.1', 'OTHER', consensus_to_pwm('TATACGCGTATACG'))], p=1e-6,
                      custom=[dict(name='MINE', counts=consensus_to_pwm('GCCGATAAGGCC'))], pinned=['MINE'], flank=600)
    mine = next(r for r in m['families'] if r['name'] == 'MINE')
    assert mine['pinned'] == ['MINE'] and mine['members'][0]['source'] == 'custom' and mine['total'] >= 1
    # the strand filter keeps one orientation
    both = aa.nfr_motifs(state, run['job_id'], 'N1', pwms=[('X0001.1', 'P', consensus_to_pwm('GCCGATAAGGCC'))], p=1e-6, flank=600)
    plus = aa.nfr_motifs(state, run['job_id'], 'N1', pwms=[('X0001.1', 'P', consensus_to_pwm('GCCGATAAGGCC'))], p=1e-6, flank=600, strand='+')
    minus = aa.nfr_motifs(state, run['job_id'], 'N1', pwms=[('X0001.1', 'P', consensus_to_pwm('GCCGATAAGGCC'))], p=1e-6, flank=600, strand='-')
    n = lambda r: sum(f['region_sites'] for f in r['families'])  # noqa: E731
    assert n(plus) + n(minus) >= n(both) and n(plus) >= 1
    # the genome background: the FASTA's composition, sampled
    comp = genome_composition(state.fasta, path_key='test-fasta', windows=20, width=1000)
    assert comp and sum(comp.values()) == 20_000
    g = aa.nfr_motifs(state, run['job_id'], 'N1', pwms=[('X0001.1', 'P', consensus_to_pwm('GCCGATAAGGCC'))], p=1e-6, flank=600, background='genome')
    assert g['threshold']['background'] == 'genome'



def test_a_find_classes_run_made_after_the_nfr_run_is_joined_without_rerunning(state, run, monkeypatch, tmp_path):
    import gzip
    from lab.services import accessibility_occupancy as OC
    from lab.services import accessibility_workflow as W
    from services.motifs import consensus_to_pwm
    job = aw._session(state)[0][run['job_id']]
    mols = job['result']['molecules']
    min_gap = int(job['result']['parameters'].get('min_gap_bp', 60))
    cache = {}
    open_at = sorted(u for u, m in mols.items() if OC.read_state(m, 1746, min_gap, cache) == 'open')
    d = tmp_path / 'classes_run'
    d.mkdir()
    (d / 'classes.tsv').write_text('class_id\tchannel\tsupported\tprevalence\tstart\tend\nclass_009\td::CT\tTrue\t0.3\t1735\t1757\n')
    with gzip.open(d / 'molecules.tsv.gz', 'wt') as fh:
        fh.write('class_id\tchannel\tunit_id\tposterior\tlog_bf\tlabel\n')
        for i, u in enumerate(open_at):
            fh.write(f"class_009\td::CT\t{u}\t0.9\t3\t{'member' if i % 3 == 0 else 'non_member'}\n")
    assert not OC.class_source(state, job)['classes']                         # nothing yet
    assert aa.class_status(state, run['job_id'])['classes'] == 0
    monkeypatch.setattr(W, '_matching_class_job', lambda *a, **k: dict(job_id='cls1', artifact_dir=str(d)))
    src = OC.class_source(state, job)
    assert src['joined'] == 'posthoc' and src['job_id'] == 'cls1' and len(src['classes']) == 1
    # the run-level status the Co-accessibility tab asks: classes found after this run (its pair tests need a new run)
    assert aa.class_status(state, run['job_id']) == dict(class_job='cls1', joined='posthoc', classes=1, reason=None)
    m = aa.nfr_motifs(state, run['job_id'], 'N1', pwms=[('X0001.1', 'PLANTED', consensus_to_pwm('GCCGATAAGGCC'))], p=1e-6, flank=600)
    site = next(s for r in m['families'] for s in r['sites'] if s['start'] == 1740)
    right = _variant(run, 'N1', 1690, 1780)['name']
    assert site['classes'][0]['id'] == 'class_009' and m['occupancy']['joined'] == 'posthoc'
    assert 0.2 < site['layers'][right]['p_fp_given_open'] < 0.5                # one in three labelled open reads


def test_run_find_classes_from_the_nfr_run_uses_its_window_and_settings(state, run, monkeypatch):
    seen = {}
    import services.consensus_workflow as CW
    monkeypatch.setattr(CW, 'submit', lambda st, body: seen.update(body) or dict(job_id='c9', status='queued'))
    out = aa.submit_class_run(state, run['job_id'])
    assert out == dict(job_id='c9', status='queued', existing=False, message=None)
    r = run['result']['region']
    assert (seen['chrom'], seen['start'], seen['end']) == (r['chrom'], r['start'], r['end'])
    assert seen['dataset_ids'] == ['d'] and seen['chemistry_overrides'] == {'d': 'ddda'}
    assert seen['parameters'] == {'input': (run['request'].get('loader_parameters') or {}).get('input') or {}}
    # the analysed region names the NFR run by its one short name, not its id (round 2, run labels)
    assert seen['region_label'].startswith('window of NFR run ') and run['job_id'][:8] not in seen['region_label']


def test_nfr_run_name_is_its_order_and_start_time():
    import time as _t
    from types import SimpleNamespace
    from lab.services import accessibility_workflow as W
    st = SimpleNamespace()
    jobs, _ = W._session(st)
    t0 = _t.mktime((2026, 10, 6, 14, 2, 0, 0, 0, -1))
    jobs.update(b=dict(job_id='b', created_at=t0), a=dict(job_id='a', created_at=t0 - 60))
    assert W.run_name(st, 'a') == 'NFR run 1 · 6 Oct 14:01'
    assert W.run_name(st, 'b') == 'NFR run 2 · 6 Oct 14:02'
    assert W.run_name(st, 'zzzz9999') == 'NFR run zzzz…'


# ---------------------------------------------------------------- round 3: pooled over NFRs and runs
def test_pooled_statistics_match_references():
    from lab.services import accessibility_pooled as PO
    sm = pytest.importorskip('statsmodels.stats.contingency_tables')
    tables = [(12, 5, 6, 14), (8, 10, 4, 15), (20, 7, 11, 13)]
    r = PO.cmh(tables)
    st = sm.StratifiedTable([np.array([[a, b], [c, d]]) for a, b, c, d in tables])
    assert r['p'] == pytest.approx(st.test_null_odds(correction=True).pvalue, rel=1e-6)
    assert r['odds_ratio'] == pytest.approx(st.oddsratio_pooled, rel=1e-3)
    # the stratified rate test: one stratum is the exact conditional binomial test (two-sided)
    one = PO.mh_rate_ratio([(30, 1000, 10, 1000)])
    from scipy.stats import binomtest
    assert one['p'] == pytest.approx(binomtest(30, 40, .5).pvalue, rel=1e-6) and one['ratio'] == pytest.approx(3.0)
    # a few events against a small expectation: the exact p (2 x (100/2100)^3), not the normal approximation's ~1e-14
    few = PO.mh_rate_ratio([(3, 100, 0, 2000)])
    assert few['p'] == pytest.approx(2*(100/2100)**3, rel=1e-6)
    assert PO.mh_rate_ratio([(0, 10, 0, 10)])['p'] is None and PO.cmh([(0, 0, 3, 4)])['p'] is None
    # under the null the pooled rate test is calibrated
    rng = np.random.default_rng(3)
    ps = [PO.mh_rate_ratio([(rng.poisson(2.), 100, rng.poisson(4.), 200) for _ in range(8)])['p'] for _ in range(3000)]
    assert np.mean(np.array([p for p in ps if p is not None]) <= .05) <= .065


def test_variant_types_from_the_engines_labels():
    from lab.services.accessibility_pooled import variant_type
    assert [variant_type(r) for r in ('full', 'full-like', 'core', 'trimmed-left', 'extended-right', 'shifted-left',
                                       'alternative-left', 'satellite-right', 'merged V1+V3', None)] == \
        ['full', 'full', 'core', 'core', 'extended', 'shifted', 'alternative', 'alternative', 'merged', 'other']


def test_pooled_over_the_run_finds_the_planted_variant_specific_site(state, run, monkeypatch):
    from lab.services import accessibility_occupancy as OC
    from services.motifs import consensus_to_pwm
    job = aw._session(state)[0][run['job_id']]
    mols = job['result']['molecules']
    cache = {}
    open_at = sorted(u for u, m in mols.items() if OC.read_state(m, 1746, 60, cache) == 'open')
    cls = [dict(id='class_7', label='class 7', start=1735., end=1757., prevalence=.2, state={u: int(i % 2 == 0) for i, u in enumerate(open_at)})]
    monkeypatch.setattr(OC, 'class_source', lambda st, jb: dict(key=('test',), classes=cls, job_id='c1', joined='run'))
    pwms = [('X0001.1', 'PLANTED', consensus_to_pwm('GCCGATAAGGCC')), ('X0002.1', 'OTHER', consensus_to_pwm('TATACGCGTATACG'))]
    out = aa.pooled_motifs(state, [run['job_id']], pwms=pwms, p=1e-6, flank=600)
    assert out['nfrs'] >= 1 and out['runs'] == 1 and out['job_ids'] == [run['job_id']]
    fam = next(f for f in out['families'] if f['name'] == 'PLANTED')
    cells = {c['type']: c for c in out['cells'] if c['family'] == fam['id']}
    # the full opening's reads are closed at the planted site (1740, in the right register), the others' open
    full = cells['full']['open']
    assert full['strata'] == 1 and full['direction'] == -1 and full['p'] < 1e-10
    # every right-register read here is also a member of the left (trimmed) variant: with disjoint groups that type has
    # no reads of its own to compare, so no stratum (rather than counting the same molecules twice)
    assert cells['alternative']['open']['strata'] == 0
    assert all(c[m]['q'] is None or 0 <= c[m]['q'] <= 1 for c in out['cells'] for m in ('sites', 'open', 'footprinted'))
    with pytest.raises(ValueError):
        aa.pooled_motifs(state, [])


def test_batch_submits_one_run_per_region_with_the_runs_settings(state, run, monkeypatch):
    seen = []
    monkeypatch.setattr(aw, 'submit', lambda st, req: seen.append(req) or dict(job_id=f'j{len(seen)}', status='queued'))
    import time as _time
    b = aa.submit_batch(state, run['job_id'], [dict(chrom='chrT', start=100, end=3000, label='a'), dict(chrom='chrT', start=3000, end=4000)], poll=0.01)
    for _ in range(200):
        out = aa.get_batch(b['id'])
        if out['status'] == 'complete':
            break
        _time.sleep(0.02)
    assert [j['job_id'] for j in out['jobs']] == ['j1', 'j2']
    assert seen[0]['dataset_ids'] == ['d'] and seen[0]['start'] == 100 and 'nfr_regions' not in seen[0]['parameters']
    assert seen[0]['region_label'] == 'a'
    with pytest.raises(ValueError):
        aa.submit_batch(state, run['job_id'], [])


# ---------------------------------------------------------------- ChIP-Atlas peaks over the run
def test_chipatlas_peaks_are_fetched_once_and_overlap_the_variants(state, run, monkeypatch, tmp_path):
    import time as _time
    from lab.services import chipatlas_peaks as CP
    monkeypatch.setattr(CP, 'data_dir', lambda: str(tmp_path))
    (tmp_path / 'experimentList.tab').write_text(
        'SRX1\tdm6\tTFs and others\tvfl\tEmbryo\tcycle 14\nSRX9\tdm6\tTFs and others\tvfl\tEmbryo\t2-3h\n'
        'SRX5\thg38\tTFs and others\tvfl\tx\ty\nSRX7\tdm6\tHistone\tH3K27ac\tEmbryo\tz\n')
    idx = CP.antigen_index('dm6')
    assert [e[0] for e in idx['vfl']] == ['SRX9', 'SRX1'] and 'h3k27ac' not in idx      # newest first, TFs only
    assert (tmp_path / 'index_dm6.json').exists()
    fetched = []
    monkeypatch.setattr(CP, 'read_peaks', lambda path, chrom, a, b: [(1700, 1790, '500')] if 'SRX9' in path else [])
    monkeypatch.setattr(CP, '_valid_bigbed', lambda path: True)
    def fetch(url):
        fetched.append(url)
        return b'bb'
    monkeypatch.setattr('services.motifs.jaspar_genome', lambda st: ('dm6', False))
    monkeypatch.setattr('services.motifs.coordinate_genome', lambda st: 'dm6')
    real_submit = CP.submit
    monkeypatch.setattr(CP, 'submit', lambda *a, **k: real_submit(*a, **{**k, 'fetch': fetch}))
    t = aa.chipatlas_peaks(state, run['job_id'], ['vfl', 'nope'], 5)
    for _ in range(100):
        st = CP.status(t['id'])
        if st['status'] != 'running':
            break
        _time.sleep(0.05)
    assert st['status'] == 'complete' and st['total'] == 2
    assert fetched == ['https://chip-atlas.dbcls.jp/data/dm6/eachData/bb05/SRX9.05.bb', 'https://chip-atlas.dbcls.jp/data/dm6/eachData/bb05/SRX1.05.bb']
    vfl = next(f for f in st['factors_out'] if f['factor'] == 'vfl')
    assert vfl['with_peak'] == 1 and vfl['available'] == 2
    right = _variant(run, 'N1', 1690, 1780)['name']
    assert vfl['overlap']['N1'][right] == 0.5 and st['bound'][0]['factor'] == 'vfl'
    assert next(f for f in st['factors_out'] if f['factor'] == 'nope')['experiments'] == []
    # a second fetch reads the cached files
    CP.peak_file('dm6', 'SRX9', fetch)
    assert len(fetched) == 2


def test_chipatlas_experiment_selector_counts_and_filters(state, run, monkeypatch, tmp_path):
    import time as _time
    from lab.services import chipatlas_peaks as CP
    monkeypatch.setattr(CP, '_index_cache', {})        # keyed by the list's mtime: another test's list could share it
    monkeypatch.setattr(CP, 'data_dir', lambda: str(tmp_path))
    (tmp_path / 'experimentList.tab').write_text(
        'SRX1\tdm6\tTFs and others\tvfl\tEmbryo\t2-4h embryos\nSRX9\tdm6\tTFs and others\tvfl\tCell line\tS2\n'
        'SRX4\tdm6\tTFs and others\tvfl\tCell line\tKc167\nSRX3\tdm6\tTFs and others\tTrl\tCell line\tS2\n')
    monkeypatch.setattr('services.motifs.jaspar_genome', lambda st: ('dm6', False))
    monkeypatch.setattr('services.motifs.coordinate_genome', lambda st: 'dm6')
    every = aa.chipatlas_experiments(state, run['job_id'])
    assert every['present'] and every['total'] == 4 and every['matching'] == 4
    assert every['cell_type_classes'][0] == {'key': 'Cell line', 'count': 3}
    assert {'key': 'S2', 'cell_type_class': 'Cell line', 'count': 2} in every['cell_types']
    vfl = aa.chipatlas_experiments(state, run['job_id'], ['vfl'], ['Cell line'], [])
    assert (vfl['total'], vfl['matching'], vfl['factors']) == (3, 2, {'vfl': 2})
    s2 = aa.chipatlas_experiments(state, run['job_id'], ['vfl', 'Trl'], [], ['S2'])
    assert s2['matching'] == 2 and s2['factors'] == {'vfl': 1, 'Trl': 1}
    # the fetch takes only the chosen experiments (newest first), and says which choice it used
    fetched = []
    monkeypatch.setattr(CP, 'read_peaks', lambda path, chrom, a, b: [])
    monkeypatch.setattr(CP, '_valid_bigbed', lambda path: True)
    real_submit = CP.submit
    monkeypatch.setattr(CP, 'submit', lambda *a, **k: real_submit(*a, **{**k, 'fetch': lambda url: fetched.append(url) or b'bb'}))
    t = aa.chipatlas_peaks(state, run['job_id'], ['vfl'], 5, ['Cell line'], [])
    for _ in range(100):
        st = CP.status(t['id'])
        if st['status'] != 'running':
            break
        _time.sleep(0.05)
    assert st['status'] == 'complete' and st['total'] == 2 and st['selection']['cell_type_classes'] == ['Cell line']
    assert [u.rsplit('/', 1)[1] for u in fetched] == ['SRX9.05.bb', 'SRX4.05.bb']
    assert st['factors_out'][0]['available'] == 2
    # no experiment list yet: an empty selector, not an error
    monkeypatch.setattr(CP, 'data_dir', lambda: str(tmp_path / 'none'))
    assert aa.chipatlas_experiments(state, run['job_id'])['present'] is False


# ---------------------------------------------------------------- panel integration: classes <-> variants
def test_classes_inside_an_nfr_and_the_variants_a_class_sits_in(state, run, monkeypatch):
    from lab.services import accessibility_occupancy as OC
    job = aw._session(state)[0][run['job_id']]
    mols = job['result']['molecules']
    cache = {}
    open_at = sorted(u for u, m in mols.items() if OC.read_state(m, 1746, 60, cache) == 'open')
    cls = [dict(id='class_7', class_id='class_7', label='class 7', start=1735., end=1757., prevalence=.2,
                state={u: int(i % 2 == 0) for i, u in enumerate(open_at)}),
           dict(id='class_9', class_id='class_9', label='class 9', start=3300., end=3320., prevalence=.1, state={})]
    monkeypatch.setattr(OC, 'class_source', lambda st, jb: dict(key=('test',), classes=cls, job_id='c1', joined='run'))
    right = _variant(run, 'N1', 1690, 1780)['name']
    inside = aa.nfr_classes(state, run['job_id'], 'N1')
    assert [c['id'] for c in inside['classes']] == ['class_7'] and inside['class_job'] == 'c1'
    c7 = inside['classes'][0]
    assert right in c7['inside'] and c7['layers'][right]['p_open'] > .9 and 0.3 < c7['layers'][right]['p_fp_given_open'] < 0.7
    back = aa.class_variants(state, run['job_id'], 'class_7')
    assert [x['nfr'] for x in back['nfrs']] == ['N1'] and right in back['nfrs'][0]['inside']
    with pytest.raises(ValueError):
        aa.class_variants(state, run['job_id'], 'class_404')
    # no classes: the reason comes along (the Footprints section shows it next to Run Find classes)
    monkeypatch.setattr(OC, 'class_source', lambda st, jb: dict(key=None, classes=[], job_id=None, joined=None, reason='no run here'))
    none = aa.nfr_classes(state, run['job_id'], 'N1')
    assert none['classes'] == [] and none['reason'] == 'no run here'


def test_two_classes_footprinted_together_on_molecules(state, run, monkeypatch):
    from lab.services import accessibility_occupancy as OC
    job = aw._session(state)[0][run['job_id']]
    mols = job['result']['molecules']
    cache = {}
    both_open = sorted(u for u, m in mols.items() if OC.read_state(m, 1540, 60, cache) == 'open' and OC.read_state(m, 1650, 60, cache) == 'open')
    assert len(both_open) > 40
    coop = {u: int(i % 2 == 0) for i, u in enumerate(both_open)}                 # A and B on the same molecules
    cls = [dict(id='class_a', label='class A', start=1530., end=1550., prevalence=.3, state=dict(coop)),
           dict(id='class_b', label='class B', start=1640., end=1660., prevalence=.3, state=dict(coop))]
    monkeypatch.setattr(OC, 'class_source', lambda st, jb: dict(key=('test',), classes=cls, job_id='c1', joined='run'))
    out = aa.class_cooccupancy(state, run['job_id'], 'N1')
    full = _variant(run, 'N1', 1500, 1720)['name']
    pair = next(p for p in out['pairs'] if p['variant'] == full)
    assert pair['a'] == 'class A' and pair['b'] == 'class B' and pair['distance'] == 110
    assert pair['table'][1] == pair['table'][2] == 0 and pair['p'] < 1e-6 and pair['direction'] == 1
    assert pair['odds_ratio'] is None                                         # infinite: not estimable, the test still holds


def test_kmers_enriched_in_the_variant_specific_opening(state, run):
    from lab.services import accessibility_kmers as KM
    from services.motifs import consensus_to_pwm
    assert KM.canonical('TTTACG') == 'CGTAAA' and len(KM.kmers_of(4)) == 136
    # the statistic: k-mer 0 is 5x as frequent in the own parts over 10 strata; the rest at the same rate
    kms = KM.kmers_of(4)
    index = {km: i for i, km in enumerate(kms)}
    rng = np.random.default_rng(2)
    strata = []
    for _ in range(10):
        base = rng.poisson(5., len(kms)).astype(float)
        own = rng.poisson(5., len(kms)).astype(float)
        own[0] = rng.poisson(25.)
        strata.append((own, 1000, base, 1000))
    rows, tested = KM.enrich(strata, strata, index, top=5)
    assert tested == 136 and rows[0]['kmer'] == kms[0] and rows[0]['siblings']['q'] < 1e-6 and rows[0]['siblings']['log2'] > 1.5
    # end to end on the run: every k-mer tested, the top ones matched to a matrix
    out = aa.kmer_enrichment(state, [run['job_id']], k=6, pwms=[('X0001.1', 'PLANTED', consensus_to_pwm('GCCGATAAGGCC'))])
    assert out['nfrs'] >= 1 and out['tested'] == len(KM.kmers_of(6))
    assert set(out['types']) >= {'full', 'alternative'} and all(t['strata']['siblings'] >= 1 for t in out['types'].values())
    rows = [r for t in out['types'].values() for r in t['kmers']]
    assert rows and all(r['match'] is None or r['match']['name'] == 'PLANTED' for r in rows)
    # oriented per type: two reciprocal strata no longer cancel (Codex review)
    kms = KM.kmers_of(4)
    one = np.full(len(kms), 1.); one[0] = 20.
    other = np.full(len(kms), 1.); other[0] = 0.
    rows1, _ = KM.enrich([(one, 1000, other, 1000)], [], {km: i for i, km in enumerate(kms)}, top=3)
    assert rows1[0]['kmer'] == kms[0] and rows1[0]['siblings']['p'] < 1e-4
    ip = M.integer_pssm(M.log_odds_pssm(consensus_to_pwm('GCCGATAAGGCC')))
    assert KM.best_matrix('GATAAG', [('PLANTED', 'X', ip, ip[::-1, ::-1].copy())]) == ('PLANTED', 'X', 1.0)
    with pytest.raises(ValueError):
        aa.kmer_enrichment(state, [run['job_id']], k=12)


def test_conservation_over_the_nfr_window(state, run, monkeypatch):
    monkeypatch.setattr('services.motifs.jaspar_genome', lambda st: ('dm6', False))
    monkeypatch.setattr('services.motifs.coordinate_genome', lambda st: 'dm6')

    class BW:
        def chroms(self, c=None):
            return {'chrT': 5000} if c is None else 5000
        def values(self, c, a, b):
            return [float('nan') if i % 10 == 0 else 1.5 for i in range(a, b)]
        def close(self):
            pass
    out = aa.nfr_conservation(state, run['job_id'], 'N1', 100, opener=lambda url: BW())
    assert out['genome'] == 'dm6' and 'phyloP' in out['track'] and out['window'][1] - out['window'][0] == len(out['values'])
    assert out['values'][0] is None or out['values'][0] == 1.5
    monkeypatch.setattr('services.motifs.jaspar_genome', lambda st: ('toy', False))
    monkeypatch.setattr('services.motifs.coordinate_genome', lambda st: 'toy')
    with pytest.raises(ValueError):
        aa.nfr_conservation(state, run['job_id'], 'N2', 100, opener=lambda url: BW())


def test_custom_motifs_alone_on_an_assembly_jaspar_does_not_know(state, run):
    from services.motifs import consensus_to_pwm
    m = aa.nfr_motifs(state, run['job_id'], 'N1', custom=[dict(name='MINE', counts=consensus_to_pwm('GCCGATAAGGCC'))], pinned=[],
                      p=1e-6, flank=600)
    assert m['species'] is None and [r['name'] for r in m['families']] == ['MINE']


# ---------------------------------------------------------------- Codex review regressions (round 3)
def test_batch_queue_submits_each_region_after_the_previous_run(state, run, monkeypatch):
    import time as _time
    jobs, lock = aw._session(state)
    seen = []

    def fake_submit(st, req):
        with lock:
            if any(j['status'] in ('queued', 'running') for j in jobs.values()):
                raise ValueError('An Accessibility run is already running in this session')
            jid = f'b{len(seen)}'
            jobs[jid] = dict(job_id=jid, status='running')
        seen.append(req['start'])
        def finish():
            _time.sleep(0.05)
            with lock:
                jobs[jid]['status'] = 'complete'
        import threading
        threading.Thread(target=finish, daemon=True).start()
        return dict(job_id=jid, status='running')
    monkeypatch.setattr(aw, 'submit', fake_submit)
    b = aa.submit_batch(state, run['job_id'], [dict(chrom='chrT', start=s, end=s + 900) for s in (100, 1100, 2100)], poll=0.01)
    for _ in range(200):
        if aa.get_batch(b['id'])['status'] == 'complete':
            break
        _time.sleep(0.02)
    out = aa.get_batch(b['id'])
    assert seen == [100, 1100, 2100] and [j['status'] for j in out['jobs']] == ['complete']*3


def test_the_footprint_event_is_a_union_over_covering_classes():
    from lab.services.accessibility_occupancy import union_label
    a = dict(state={'r1': 1, 'r2': 0, 'r3': 0, 'r4': 0})
    b = dict(state={'r1': 0, 'r2': 0, 'r3': 1})            # r4: b abstained (no label)
    assert [union_label([a, b], u) for u in ('r1', 'r2', 'r3', 'r4', 'r5')] == [1, 0, 1, None, None]


def test_a_corrupt_cached_peak_file_is_fetched_again(monkeypatch, tmp_path):
    from lab.services import chipatlas_peaks as CP
    monkeypatch.setattr(CP, 'data_dir', lambda: str(tmp_path))
    d = tmp_path / 'peaks' / 'dm6'
    d.mkdir(parents=True)
    (d / 'SRX1.05.bb').write_bytes(b'truncated')
    fetched = []
    CP.peak_file('dm6', 'SRX1', lambda url: fetched.append(url) or b'new')
    assert fetched and (d / 'SRX1.05.bb').read_bytes() == b'new'


def test_conservation_near_a_chromosome_end_is_padded(state, run, monkeypatch):
    monkeypatch.setattr('services.motifs.jaspar_genome', lambda st: ('dm6', False))
    monkeypatch.setattr('services.motifs.coordinate_genome', lambda st: 'dm6')

    class BW:
        def chroms(self, c=None):
            return {'chrT': 1800} if c is None else 1800
        def values(self, c, a, b):
            assert b <= 1800
            return [2.0]*(b - a)
        def close(self):
            pass
    out = aa.nfr_conservation(state, run['job_id'], 'N1', 300, opener=lambda url: BW())
    lo, hi = out['window']
    assert hi > 1800 and len(out['values']) == hi - lo and out['values'][-1] is None and out['values'][0] == 2.0


# ---------------------------------------------------------------- coverage, NFR size at the site, the footprint layer's reason
def test_coverage_is_the_share_of_a_variants_own_openings_over_the_site(state, run):
    """The default per-site metric: among a variant's members, the share whose own opening covers the site core. A site
    in the middle of the right register's span is covered by nearly all its members and by none of the left's."""
    from services.motifs import consensus_to_pwm
    m = aa.nfr_motifs(state, run['job_id'], 'N1', pwms=[('X0001.1', 'PLANTED', consensus_to_pwm('GCCGATAAGGCC'))], p=1e-6, flank=600)
    site = next(s for r in m['families'] for s in r['sites'] if s['start'] == 1740)
    right = _variant(run, 'N1', 1690, 1780)['name']
    full = _variant(run, 'N1', 1500, 1720)['name']
    cv = site['coverage']
    assert cv[right]['p'] > .9 and cv[full]['p'] < .1
    assert cv[right]['ci'][0] <= cv[right]['p'] <= cv[right]['ci'][1]
    assert sum(v['share'] for v in cv.values() if v['share'] is not None) == pytest.approx(1, abs=1e-3)
    assert site['cover_delta'] > .8
    # sizes of the opening over the site, by the variant its configuration assigns it, and their test
    assert right in site['sizes'] and site['sizes'][right]['n'] >= 10
    assert 'q_cover_diff' in site and 'q_size_diff' in site
    assert 'coverage' in m['occupancy']['definitions'] and 'sizes' in m['occupancy']['definitions']
    sz = aa.nfr_site_sizes(state, run['job_id'], 'N1', [[site['start'], site['end']]])
    assert sz['labels'][0] in (right, full) and sum(len(v) for v in sz['sizes'].values()) == sum(v['n'] for v in site['sizes'].values())
    assert all(a <= b for v in sz['sizes'].values() for a, b in zip(v, v[1:]))
    with pytest.raises(ValueError):
        aa.nfr_site_sizes(state, run['job_id'], 'N1', [])


def test_the_size_test_compares_variants_with_enough_reads():
    from lab.services import accessibility_occupancy as OC
    rng = np.random.default_rng(3)
    assert OC.size_test({'V1': list(rng.normal(150, 10, 40)), 'V2': list(rng.normal(300, 10, 40))}) < 1e-6
    assert OC.size_test({'V1': list(rng.normal(150, 10, 40)), 'V2': list(rng.normal(150, 10, 40))}) > 1e-3
    assert OC.size_test({'V1': [150]*40, 'V2': [150]*40}) == 1.0
    assert OC.size_test({'V1': list(range(40)), 'V2': [1, 2]}) is None              # one variant with enough reads
    assert OC.size_test({'V1': list(range(40)), 'V2': list(range(5, 45)), 'V3': list(range(90, 130))}) < 1e-6


def test_blank_class_and_fp_q_regression_the_layer_says_why_it_is_missing(state, run, monkeypatch):
    """Owner's report: 'class and fp q are always blank'. Cause: no Find classes run joined the NFR run (none in the
    session, or one on other molecules / settings), so no site had a class. The occupancy now carries the reason (the
    panel shows it with the Run Find classes action instead of two blank columns); once a compatible run exists the
    columns fill."""
    from lab.services import accessibility_occupancy as OC
    from lab.services import accessibility_workflow as W
    from services.motifs import consensus_to_pwm
    pw = [('X0001.1', 'PLANTED', consensus_to_pwm('GCCGATAAGGCC'))]
    m = aa.nfr_motifs(state, run['job_id'], 'N1', pwms=pw, p=1e-6, flank=600)
    assert m['occupancy']['classes'] == 0 and 'No Find classes run' in m['occupancy']['class_reason']
    # a run on other input settings: named as such
    monkeypatch.setattr(W, '_matching_class_job', lambda *a, reasons=None, **k: (reasons.extend(['other input settings', 'another region']), None)[1])
    m = aa.nfr_motifs(state, run['job_id'], 'N1', pwms=pw, p=1e-6, flank=601)
    assert 'other input settings' in m['occupancy']['class_reason'] and '2 Find classes runs' in m['occupancy']['class_reason']
    # the real mismatch check names the first failing requirement
    job = aw._session(state)[0][run['job_id']]
    req = dict(job['request'])
    other = dict(request=dict(req, dataset_ids=['e']), result={})
    assert W._class_job_mismatch(other, req, None, {}, False, 'r', lambda r: 'r', lambda a, b: True) == 'other datasets (or another order)'
    same = dict(request=dict(req, parameters=dict(input={'x': 1})), result={})
    assert W._class_job_mismatch(same, req, None, {}, False, 'r', lambda r: 'r', lambda a, b: True) == 'other input settings'
    # with classes joined, the class and fp q columns are filled at the site under the class
    mols = job['result']['molecules']
    cache = {}
    open_at = sorted(u for u, mm in mols.items() if OC.read_state(mm, 1746, 60, cache) == 'open')
    cls = [dict(id='class_7', label='class 7', start=1735., end=1757., prevalence=.2, state={u: int(i % 2 == 0) for i, u in enumerate(open_at)})]
    monkeypatch.setattr(OC, 'class_source', lambda st, jb: dict(key=('test',), classes=cls, job_id='c1', joined='run'))
    m = aa.nfr_motifs(state, run['job_id'], 'N1', pwms=pw, p=1e-6, flank=602)
    site = next(s for r in m['families'] for s in r['sites'] if s['start'] == 1740)
    assert site['classes'] and m['occupancy']['class_reason'] is None
    assert all(L['labelled'] > 0 for L in site['layers'].values() if L['open'])


def test_pooled_sizes_count_each_read_once_and_keep_the_groups_disjoint():
    """Codex review: pooling a family's sites must not turn one read over ten sites into ten observations."""
    from lab.services import accessibility_occupancy as OC
    nfr = dict(id='N1', variants=[dict(name='V1', L=0, R=1000), dict(name='V2', L=0, R=1000)])
    mols = {'a': dict(nfr={'N1': dict(status='callable', gaps=[[0, 1000]], map='V1')}),
            'b': dict(nfr={'N1': dict(status='callable', gaps=[[0, 900]], map='V2')}),
            # V1 over the first sites, V2 over the last: in neither group
            'c': dict(nfr={'N1': dict(status='callable', gaps=[[0, 300], [400, 1000]], map='V1+V2')})}
    result = dict(molecules=mols)
    centres = [50 + 100*i for i in range(10)]
    pooled = OC.pooled_sizes(result, nfr, centres, 10)
    assert pooled == {'V1': [1000.0], 'V2': [900.0]}
    assert OC.size_test(pooled) is None                         # two reads: under min_reads, untested


# ---------------------------------------------------------------- names: case, common names, aliases (fb-n13)
def test_motif_names_resolve_whatever_the_case_common_name_or_alias():
    from services.motif_scoring import motif_key, name_matches
    assert motif_key('Su(Hw)') == motif_key('su(hw)') == 'suhw' and motif_key('Krüppel') == 'kruppel'
    assert name_matches('Su(Hw)', 'MA0533.1', 'su(Hw)') and name_matches('suhw', 'MA0533.1', 'su(Hw)')
    assert name_matches('GAF', 'MA0205.2', 'Trl') and name_matches('gaga factor', 'MA0205.2', 'Trl')
    assert name_matches('Zelda', 'MA1462.1', 'vfl') and name_matches('zld', 'MA1462.1', 'vfl')
    assert name_matches('ma0533', 'MA0533.1', 'su(Hw)') and name_matches('Kruppel', 'MA0452.2', 'Kr')
    assert not name_matches('Su(H)', 'MA0533.1', 'su(Hw)') and not name_matches('GAF', 'MA1462.1', 'vfl')


def test_pinned_and_scanned_names_resolve_through_aliases(state, run):
    from services.motifs import consensus_to_pwm
    pwms = [('MA0533.1', 'su(Hw)', consensus_to_pwm('GCCGATAAGGCC')), ('MA0205.2', 'Trl', consensus_to_pwm('GAGAGAGAG'))]
    m = aa.nfr_motifs(state, run['job_id'], 'N1', pwms=pwms, p=1e-6, pinned=['Su(Hw)', 'GAF', 'Trl', 'NOPE'])
    rows = {r['name']: r for r in m['families']}
    assert rows['su(Hw)']['pinned'] == ['Su(Hw)'] and rows['su(Hw)']['total'] >= 1
    assert m['pinned']['names'] == {'Su(Hw)': ['su(Hw)'], 'GAF': ['Trl'], 'Trl': ['Trl']}
    assert rows['Trl']['pinned'] == ['GAF']                                  # the first name keeps a matrix pinned twice
    assert m['pinned']['missing'] == ['NOPE']
    only = aa.nfr_motifs(state, run['job_id'], 'N1', pwms=pwms, p=1e-6, motifs=['SU(HW)'], pinned=[])
    assert [r['name'] for r in only['families']] == ['su(Hw)']


def test_su_hw_and_gaf_resolve_in_jaspar_core_insects():
    pytest.importorskip('pyjaspar')
    from services import motif_scoring as S
    recs = [S._record(m.matrix_id, m.name, m.counts, 'species') for m in M.get_jaspar_core_motifs(7227) if all(m.counts.get(b) for b in 'ACGT')]
    for typed, name in (('Su(Hw)', 'su(Hw)'), ('su(hw)', 'su(Hw)'), ('GAF', 'Trl'), ('Zelda', 'vfl'), ('trl', 'Trl')):
        found, _ = S._resolve(M, typed, recs, M.genome_taxon('dm6'))
        assert {r['name'] for r in found} == {name}, typed


# ---------------------------------------------------------------- a genome declared for the run's FASTA
def test_nfr_motifs_follow_a_declared_genome_through_declare_redeclare_clear(tmp_path, monkeypatch):
    """The NFR motif view is cached per run; a genome declared, redeclared or cleared for its custom FASTA is a new
    species (the cache key carries the reference identity and the declaration revision)."""
    pytest.importorskip('pyjaspar')
    rng = np.random.default_rng(11)
    seq = ''.join(rng.choice(list('ACGT'), 5000, p=[.3, .2, .2, .3]))
    path = tmp_path / 'custom_contig.fa'
    path.write_text('>chrT\n' + seq + '\n')
    pysam.faidx(str(path))
    s = BrowserState(None, fasta_path=str(path))
    s.add_dataset('d', str(_empty_bam(tmp_path)))
    monkeypatch.setattr('services.consensus_workflow.load_payload', lambda *a, **k: planted_payload())
    job = _wait(s, aw.submit(s, REQUEST)['job_id'])
    assert job['status'] == 'complete', job['message']
    species = lambda: (aa.nfr_motifs(s, job['job_id'], 'N1')['species'] or {}).get('name')  # noqa: E731
    assert species() == 'vertebrates'                    # no genome: the vertebrate fallback
    M.declare_genome(s, 'dm6')
    assert species() == 'fly'
    M.declare_genome(s, 'hg38')
    assert species() == 'human'
    M.declare_genome(s, None)
    assert species() == 'vertebrates'
    # Coordinate lookups never use a declared genome: no ChIP-Atlas / phyloP assembly for a custom contig.
    M.declare_genome(s, 'dm6')
    with pytest.raises(ValueError, match='No assembly is known'):
        aa._run_genome(s, job)
