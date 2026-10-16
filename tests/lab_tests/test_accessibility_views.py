"""Accessibility (preview), round 2: the analysis views of a finished run (EXPERIMENTAL).

Read splits for a pair / a combination (read names per dataset, the 2x2 table), variant views (size and edges,
V-plots, phasing), prevalence per read group, the motif map and its enrichment baselines, sequence features,
membership TSV, frozen-catalogue quantification in other datasets, and runs restored from a session."""
import csv
import io

import numpy as np
import pysam
import pytest

from models.requests import SessionExportRequest, SessionImportRequest
from lab.services import accessibility_analysis as aa
from lab.services import accessibility_workflow as aw
from services.sessions_endpoint import build_session_export_for_request, import_session_for_request
from state.browser_state import BrowserState

from test_accessibility_workflow import REQUEST, _empty_bam, _wait, planted_payload

MOTIF = 'GCCGATAAGGCC'


def _fasta(tmp_path):
    rng = np.random.default_rng(4)
    seq = list(''.join(rng.choice(list('ACGT'), 5000, p=[.3, .2, .2, .3])))
    for at in (1740, 1200):                       # inside the right register only; and once in the background
        seq[at:at + len(MOTIF)] = MOTIF
    seq[1550:1559] = 'AAAAAAAAA'                   # a poly(dA:dT) tract inside the full NFR and the left register
    path = tmp_path / 'ref.fa'
    path.write_text('>chrT\n' + ''.join(seq) + '\n')
    pysam.faidx(str(path))
    return path


@pytest.fixture
def state(tmp_path, monkeypatch):
    s = BrowserState(None, fasta_path=str(_fasta(tmp_path)))
    s.add_dataset('d', str(_empty_bam(tmp_path)))
    s.add_dataset('e', str(_empty_bam(tmp_path, 'other.bam')))

    def fake_load(state_, request, options, progress):
        progress('loading', 'synthetic molecules')
        if request['dataset_ids'] == ['e']:
            return planted_payload(seed=9, dataset='e')
        return planted_payload()
    monkeypatch.setattr('services.consensus_workflow.load_payload', fake_load)
    return s


@pytest.fixture
def run(state):
    job = _wait(state, aw.submit(state, REQUEST)['job_id'])
    assert job['status'] == 'complete', job['message']
    assert 'element_states' not in job['result']           # stays on the server, like the molecules
    return job


def _variant(job, nfr, lo, hi, tol=25):
    n = next(n for n in job['result']['nfrs'] if n['id'] == nfr)
    return next(v for v in n['variants'] if abs(v['L'] - lo) <= tol and abs(v['R'] - hi) <= tol)


def test_pair_split_groups_are_the_2x2_table_with_read_names(state, run):
    result = aw._complete(state, run['job_id'])['result']
    for pair in run['result']['pairs']:
        s = aa.split(state, run['job_id'], pair['b'], pair['a'])
        assert (s['a'], s['b']) == (pair['a'], pair['b'])
        assert s['table'] == pair['table'] and [g['molecules'] for g in s['groups'][:4]] == pair['table']
        assert [g['key'] for g in s['groups']] == ['11', '10', '01', '00', 'na'] and s['groups'][4]['id'] == aa.NA_GROUP
        assert sum(g['molecules'] for g in s['groups']) == len(result['molecules'])
        assert sum(g['count'] for g in s['groups']) == len(s['by_dataset']['d']) == 300    # one name per molecule here
        assert s['excluded'].get('shared', 0) == pair['shared']
        assert s['recomputed']['mh'] == pytest.approx(pair['mh'], abs=1e-3)
        assert s['groups'][0]['label'].endswith('+') and '−' in s['groups'][3]['label']
    p = next(p for p in run['result']['pairs'] if p['a'].startswith('N1') != p['b'].startswith('N1'))
    s = aa.split(state, run['job_id'], p['a'], p['b'])
    assert s['spacing']['kind'] == 'between' and s['spacing']['median'] > 700 and 'nucleosomes' in s['spacing']['note']
    assert set(s['profiles']) == {'11', '10', '01', '00', 'na'} and s['strata'] and s['excluded_text'] == {}   # all eligible


def test_combination_split_and_bad_requests(state, run):
    ids = [e['id'] for e in run['result']['elements'] if e['kind'] == 'nfr']
    full = max(run['result']['nfrs'][0]['variants'], key=lambda v: v['width'])['id']
    picks = [i for i in ids if i.startswith('N2')][:1] + [i for i in ids if i.startswith('N1') and i != full][:2]
    s = aa.split(state, run['job_id'], elements=picks)
    assert s['kind'] == 'combination' and s['groups'][-1]['key'] == 'na'
    assert sum(g['molecules'] for g in s['groups']) == 300
    assert all(len(g['key']) == len(picks) for g in s['groups'][:-1])
    with pytest.raises(ValueError, match='overlap'):
        aa.split(state, run['job_id'], full, next(i for i in ids if i.startswith('N1') and i != full))
    with pytest.raises(ValueError):
        aa.split(state, run['job_id'], 'N1:V1')


def test_variant_views_shape_vplots_phasing_and_overview(state, run):
    full = _variant(run, 'N1', 1500, 1720)
    shape = aa.variant_view(state, run['job_id'], full['id'], 'shape')
    assert shape['boundary'][full['name']]['minus1']['median'] < 1500 < 1720 < shape['boundary'][full['name']]['plus1']['median']
    vp = aa.variant_view(state, run['job_id'], full['id'], 'vplots')
    cover = np.array(vp['own']['coverage'])
    assert vp['variant'] == full['id']
    widths = [g[1] - g[0] for g in (tuple(p[:2]) for p in shape['edges']['points']) if True]
    assert cover.sum() == pytest.approx(sum(p[1] - p[0] for p in shape['edges']['points'] if p[2] == full['name'])/vp['step'], rel=1e-6)
    assert np.array(vp['all']['centre']).sum() == len(widths)
    ph = aa.variant_view(state, run['job_id'], full['id'], 'phasing')
    x = np.array(ph['members']['x']); i = int(np.argmin(abs(x - 1610)))
    assert ph['members']['occupancy'][i] < .1 < ph['others']['occupancy'][i]
    ov = aa.overview(state, run['job_id'], 'N1')
    assert set(ov['variants']) == {v['name'] for v in run['result']['nfrs'][0]['variants']}
    with pytest.raises(ValueError):
        aa.variant_view(state, run['job_id'], full['id'], 'nope')


def test_prevalence_per_read_group_and_dataset(state, run):
    full = _variant(run, 'N1', 1500, 1720)
    groups = aa.split(state, run['job_id'], full['id'], next(e['id'] for e in run['result']['elements'] if e['id'].startswith('N2')))
    open_names = [n for n, g in groups['by_dataset']['d'].items() if g in (0, 1)]
    closed_names = [n for n, g in groups['by_dataset']['d'].items() if g in (2, 3)]
    out = aa.variant_prevalence(state, run['job_id'], full['id'], {'open': {'d': open_names}, 'closed': {'d': closed_names}}, bootstrap=20)
    rows = {r['group']: r for r in out['groups']}
    assert rows['open']['prevalence'] > .8 and rows['closed']['prevalence'] < .1
    assert rows['all']['prevalence'] == pytest.approx(full['prevalence'], abs=1e-4)
    assert rows['open']['ci'][0] <= rows['open']['prevalence'] <= rows['open']['ci'][1]
    with pytest.raises(ValueError):
        aa.variant_prevalence(state, run['job_id'], full['id'], {'x': ['not', 'a', 'dict']})


def _planted(**kw):
    from services.motifs import consensus_to_pwm
    return dict(pwms=[('X0001.1', 'PLANTED', consensus_to_pwm(MOTIF))], p=1e-6, **kw)


def test_motif_map_enrichment_baselines_and_differential(state, run):
    from scipy.stats import binom
    right = _variant(run, 'N1', 1690, 1780)
    full = _variant(run, 'N1', 1500, 1720)
    m = aa.variant_motifs(state, run['job_id'], right['id'], flank=600, pinned=[], **_planted())
    assert m['focus'] == right['name'] and m['threshold']['mode'] == 'p' and m['tested'] == 1
    row, = m['families']
    assert row['total'] == 2                                     # the planted site in the right register + the background one
    mine, other = row['enrichment'][right['name']], row['enrichment'][full['name']]
    assert mine['sites'] == 1 and other['sites'] == 0
    assert row['background']['sites'] == 1
    bg = row['background']['bp']                                  # eligible centres outside every NFR and variant
    assert 0 < bg <= m['background']['bp']
    assert mine['p_local'] == pytest.approx(binom.sf(0, 2, mine['bp']/(mine['bp'] + bg)))
    assert mine['q_local'] == pytest.approx(mine['p_local'])     # one family tested: q = p
    assert mine['log2_vs_local'] == pytest.approx(np.log2((1.5/mine['bp'])/(1.5/bg)), abs=1e-3)
    d = row['differential'][right['name']]
    assert d['only'] == 1 and d['siblings'] == 0 and d['open_delta'] > .5 and d['open_site'] == 1740
    site = next(s for s in row['sites'] if s['start'] == 1740)
    assert site['in'] == [right['name']] and site['open'][right['name']] > .8 and site['open'][full['name']] < .2
    assert site['p'] < 1e-6
    assert m['sentences'] == []                                   # not significant (q > 0.1) and not pinned
    pinned = aa.variant_motifs(state, run['job_id'], right['id'], flank=600, pinned=['PLANTED'], **_planted())
    assert pinned['families'][0]['pinned'] == ['PLANTED']
    assert pinned['sentences'] and pinned['sentences'][0].startswith(f"{right['name']} opens over a PLANTED site at 1,740")
    with pytest.raises(ValueError):
        aa.variant_motifs(state, run['job_id'], right['id'], p=2)
    with pytest.raises(ValueError):
        aa.variant_motifs(state, run['job_id'], right['id'], relative=2)
    with pytest.raises(ValueError):
        aa.nfr_motifs(state, run['job_id'], 'N9')


def test_sequence_features_and_membership_tsv(state, run):
    full = _variant(run, 'N1', 1500, 1720)
    f = aa.variant_sequence(state, run['job_id'], full['id'], flank=200)
    assert any(t['start'] == 1550 and t['length'] >= 9 for t in f['variants'][full['name']]['tracts'])
    assert 0 < f['variants'][full['name']]['gc'] < 1 and f['gc_track']['gc']
    rows = list(csv.DictReader(io.StringIO(aa.membership_tsv(state, run['job_id'], full['id'])), delimiter='\t'))
    assert len(rows) == 300 and all(r['member'] == str(int(float(r['p']) >= .5)) for r in rows if r['p'])
    assert all(r['opening_start'] for r in rows if r['configuration'] and full['name'] in r['configuration'].split('+'))


def test_the_sequence_endpoint_returns_the_bases_of_the_window(state, run):
    """Copy sequence / Download FASTA on an NFR card (fb-n13): the bases come with the features, aligned to window."""
    ref = pysam.FastaFile(state.fasta_path)
    out = aa.nfr_sequence(state, run['job_id'], 'N1', flank=100)
    lo, hi = out['window']
    assert out['chrom'] == 'chrT' and out['sequence'] == ref.fetch('chrT', lo, hi).upper() and len(out['sequence']) == hi - lo
    for name, f in out['variants'].items():
        a, b = f['span']
        assert out['sequence'][a - lo:b - lo] == ref.fetch('chrT', a, b).upper(), name


def test_the_sequence_window_holds_rounded_fractional_edges():
    """A variant edge of 250.8 past the NFR is exported through base 251: the window ceils its right edge (Codex)."""
    nfr = {'start': 100, 'end': 240, 'variants': [{'L': 99.6, 'R': 250.8}]}
    assert aa._window(nfr, 0) == (99, 251)
    assert aa._window(nfr, 10) == (89, 261)


def test_an_alt_allele_datasets_sequence_is_its_own_contig(state, tmp_path):
    """An insert-expanded dataset reads its own (synthetic) reference: the bases are that contig's, not the main one's."""
    from services import panel_genomes
    rng = np.random.default_rng(21)
    alt = ''.join(rng.choice(list('ACGT'), 5000))
    alt_fa = tmp_path / 'alt.fa'
    alt_fa.write_text('>chrT\n' + alt + '\n')
    pysam.faidx(str(alt_fa))
    panel_genomes.attach(state, ['d'], fasta_path=str(alt_fa))
    job = _wait(state, aw.submit(state, REQUEST)['job_id'])
    assert job['status'] == 'complete', job['message']
    out = aa.nfr_sequence(state, job['job_id'], 'N1', flank=50)
    lo, hi = out['window']
    assert out['sequence'] == alt[lo:hi]


def test_quantify_in_another_dataset(state, run):
    import time
    with pytest.raises(ValueError, match='set the assay type first'):
        aa.submit_transfer(state, run['job_id'], ['e'], 'N1')
    t = aa.submit_transfer(state, run['job_id'], ['e'], 'N1', {'e': 'ddda'})
    for _ in range(600):
        t = aa.get_transfer(state, t['transfer_id'])
        if t['status'] not in ('queued', 'running'):
            break
        time.sleep(.1)
    assert t['status'] == 'complete', t['message']
    full = _variant(run, 'N1', 1500, 1720)
    other = t['result']['datasets']['e']
    assert other['callable'] == 300 and abs(other['variants'][full['name']]['prevalence'] - full['prevalence']) < .12
    with pytest.raises(ValueError):
        aa.submit_transfer(state, run['job_id'], [], 'N1')


def test_a_restored_run_keeps_the_views_and_an_old_run_says_rerun(state, run):
    s0 = aa.split(state, run['job_id'], *[p for p in (run['result']['pairs'][0]['a'], run['result']['pairs'][0]['b'])])
    session = build_session_export_for_request(state, SessionExportRequest(chrom='chrT', start=1000, end=3400))['session']
    after = BrowserState(None)
    restored = import_session_for_request(after, SessionImportRequest(session=session))
    assert restored['results']['accessibility_runs_restored'] == 1
    s1 = aa.split(after, run['job_id'], s0['a'], s0['b'])
    assert s1['table'] == s0['table'] and s1['by_dataset'] == s0['by_dataset']
    # a preview v0 run (round 1) restores, shows its overview, and asks for a re-run where it lacks the data
    job = aw._complete(after, run['job_id'])
    job['result'] = {k: v for k, v in job['result'].items() if k != 'element_states'} | dict(schema='fiberhmm.accessibility.preview.v0')
    job.pop('_views', None)
    assert aa.overview(after, run['job_id'], 'N1')['all']['n'] == 300
    with pytest.raises(ValueError, match='run Find variants again'):
        aa.split(after, run['job_id'], s0['a'], s0['b'])


def test_router_views(state, run):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from lab.routers.accessibility import router
    from state.dependencies import get_state
    app = FastAPI(); app.include_router(router)
    app.dependency_overrides[get_state] = lambda: state
    client = TestClient(app)
    jid = run['job_id']
    full = _variant(run, 'N1', 1500, 1720)
    vid = full['id'].replace(':', '%3A')
    p = run['result']['pairs'][0]
    assert client.post(f'/api/accessibility/jobs/{jid}/split', json=dict(a=p['a'], b=p['b'])).json()['table'] == p['table']
    assert client.post(f'/api/accessibility/jobs/{jid}/split', json=dict(a=p['a'])).status_code == 422
    assert client.get(f'/api/accessibility/jobs/{jid}/overview', params=dict(nfr='N1')).json()['nfr'] == 'N1'
    for view in ('shape', 'vplots', 'phasing'):
        assert client.get(f'/api/accessibility/jobs/{jid}/variants/{vid}/{view}').status_code == 200
    assert client.get(f'/api/accessibility/jobs/{jid}/variants/{vid}/nope').status_code == 422
    tsv = client.get(f'/api/accessibility/jobs/{jid}/variants/{vid}/members.tsv')
    assert tsv.status_code == 200 and tsv.text.startswith('variant\tunit_id')
    assert client.get(f'/api/accessibility/jobs/{jid}/variants/{vid}/sequence').json()['variants']
    assert client.post(f'/api/accessibility/jobs/{jid}/nfrs/N1/motifs', json=dict(p=5)).status_code == 422
    assert client.post(f'/api/accessibility/jobs/{jid}/nfrs/N9/motifs', json={}).status_code == 422
    assert client.post(f'/api/accessibility/jobs/{jid}/variants/{vid}/motifs', json=dict(background='gc')).status_code == 422
    r = client.post(f'/api/accessibility/jobs/{jid}/variants/{vid}/prevalence', json=dict(groups={}, bootstrap=10)).json()
    assert r['groups'][-1]['group'] == 'all'
    assert client.post(f'/api/accessibility/jobs/nope/split', json=dict(a='x', b='y')).status_code == 404
    assert client.get('/api/accessibility/transfers/nope').status_code == 404


# ---------------------------------------------------------------- Codex review regressions (nfr-r2)
def test_a_dataset_whose_names_are_all_ambiguous_still_gets_empty_groups():
    result = dict(molecules={'u1': dict(dataset='a', read_name='r', members=[]), 'u2': dict(dataset='a', read_name='r', members=[]),
                             'u3': dict(dataset='b', read_name='s', members=[])})
    by_dataset, ambiguous, counts = aa._read_groups(result, {0: ['u1', 'u3'], 1: ['u2']})
    assert by_dataset == {'a': {}, 'b': {'s': 0}} and ambiguous == {'a': 1}


def test_transfers_can_be_cancelled_and_go_with_the_session(state, run, monkeypatch):
    import threading
    gate = threading.Event()

    def slow_load(state_, request, options, progress):
        gate.wait(10)
        progress('loading', 'synthetic molecules')
        return planted_payload(seed=9, dataset='e')
    monkeypatch.setattr('services.consensus_workflow.load_payload', slow_load)
    t = aa.submit_transfer(state, run['job_id'], ['e'], 'N1', {'e': 'ddda'})
    assert aa.cancel_transfer(state, t['transfer_id'])['status'] == 'cancelled'
    gate.set()
    import time
    time.sleep(.5)
    assert aa.get_transfer(state, t['transfer_id'])['status'] == 'cancelled'
    t2 = aa.submit_transfer(state, run['job_id'], ['e'], 'N1', {'e': 'ddda'})
    aw.dispose_session(state)
    with pytest.raises(KeyError):
        aa.get_transfer(state, t2['transfer_id'])


def test_the_differential_only_counts_sites_in_the_variants_own_span(state, run):
    full = _variant(run, 'N1', 1500, 1720)
    m = aa.variant_motifs(state, run['job_id'], full['id'], flank=600, pinned=[], **_planted())
    row, = m['families']
    # the planted sites sit in the right register (1740) and the background (1200), never in the full NFR's span
    assert row['enrichment'][full['name']]['sites'] == 0 and row['differential'][full['name']]['only'] == 0
    assert row['differential'][full['name']]['open_delta'] is None and m['sentences'] == []


# ---------------------------------------------------------------- per-NFR views (the Saved tab is one entry per NFR)
def test_nfr_views_put_every_variant_side_by_side(state, run):
    jid = run['job_id']
    nfr = next(n for n in run['result']['nfrs'] if n['id'] == 'N1')
    names = [v['name'] for v in nfr['variants']]
    shape = aa.nfr_view(state, jid, 'N1', 'shape')
    assert shape['variants'] == names and set(names) <= set(shape['sizes']['variants'])
    vp = aa.nfr_view(state, jid, 'N1', 'vplots')
    assert set(vp['variants']) == set(names)
    for n in names:                                                # one grid for all: the variants' own are on it
        own = aa.variant_view(state, jid, f'N1:{n}', 'vplots')
        assert vp['variants'][n]['centre'] == own['own']['centre'] and own['window'] == vp['window']
    ph = aa.nfr_view(state, jid, 'N1', 'phasing')
    assert set(ph['variants']) == set(names) and ph['all']['reads'] == aa.variant_view(state, jid, f'N1:{names[0]}', 'phasing')['members']['reads'] + aa.variant_view(state, jid, f'N1:{names[0]}', 'phasing')['others']['reads']
    prev = aa.nfr_prevalence(state, jid, 'N1', {'g': {'d': ['read0', 'read1', 'read2']}}, 5)
    allrow = next(g for g in prev['groups'] if g['group'] == 'all')
    for v in nfr['variants']:
        assert allrow['variants'][v['name']]['prevalence'] == v['prevalence']
    assert next(g for g in prev['groups'] if g['group'] == 'g')['variants'].keys() == set(names)
    tsv = aa.nfr_membership_tsv(state, jid, 'N1').splitlines()
    head = tsv[0].split('\t')
    assert head[:7] == ['nfr', 'unit_id', 'read_name', 'dataset', 'strand', 'status', 'configuration']
    assert all(f'p_{n}' in head and f'member_{n}' in head for n in names) and len(tsv) == 301
    one = aa.membership_tsv(state, jid, f'N1:{names[0]}').splitlines()
    i, j = head.index(f'member_{names[0]}'), one[0].split('\t').index('member')
    assert [r.split('\t')[i] for r in tsv[1:]] == [r.split('\t')[j] for r in one[1:]]
    assert aa.nfr_sequence(state, jid, 'N1')['variants'].keys() == set(names)
    coarse = aa.nfr_view(state, jid, 'N1', 'vplots', step=20, size_step=20, pad=100)
    assert coarse['step'] == 20 and coarse['size_step'] == 20 and coarse['window'][1] - coarse['window'][0] < vp['window'][1] - vp['window'][0]
    with pytest.raises(ValueError):
        aa.nfr_view(state, jid, 'N1', 'vplots', step=1)
    with pytest.raises(ValueError):
        aa.nfr_view(state, jid, 'N1', 'nope')
    with pytest.raises(ValueError):
        aa.nfr_view(state, jid, 'N9', 'shape')


def test_nfr_routes(state, run):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from lab.routers.accessibility import router
    from state.dependencies import get_state
    app = FastAPI(); app.include_router(router)
    app.dependency_overrides[get_state] = lambda: state
    client = TestClient(app)
    jid = run['job_id']
    for view in ('shape', 'vplots', 'phasing', 'sequence'):
        assert client.get(f'/api/accessibility/jobs/{jid}/nfrs/N1/{view}').status_code == 200, view
    assert client.get(f'/api/accessibility/jobs/{jid}/nfrs/N1/nope').status_code == 422
    assert client.get(f'/api/accessibility/jobs/{jid}/nfrs/N1/members.tsv').text.startswith('nfr\tunit_id')
    r = client.post(f'/api/accessibility/jobs/{jid}/nfrs/N1/prevalence', json=dict(groups={}, bootstrap=5)).json()
    assert r['groups'][-1]['group'] == 'all' and r['names']


def test_single_variant_read_groups_take_the_variants_cluster_colour(state, run):
    groups = aw.read_groups(state, run['job_id'], 'N1')
    names = [v['name'] for v in groups['variants']]
    ids = [g['id'] for g in groups['groups']]
    assert len(set(ids)) == len(ids)
    for g in groups['groups']:
        if g['label'] in names:
            assert g['id'] == names.index(g['label'])
        else:
            assert g['id'] >= len(names)


def test_differential_variant_usage_between_groups(state, run):
    jid = run['job_id']
    mols = aw._session(state)[0][jid]['result']['molecules']
    full = _variant(run, 'N1', 1500, 1720)
    nfr = next(n for n in run['result']['nfrs'] if n['id'] == 'N1')
    from fiberhmm.inference.accessibility import analysis as A
    members = A.member_uids(aw._session(state)[0][jid]['result'], full['id'])
    names = lambda us: sorted({mols[u]['read_name'] for u in us})  # noqa: E731
    # group a: members of the full variant; group b: the rest: usage must differ strongly
    g = {'a': {'d': names(members)}, 'b': {'d': names(set(mols) - members)}}
    out = aa.nfr_prevalence(state, jid, 'N1', g, 5)
    t = out['tests']['groups']
    assert t['groups'] == ['a', 'b'] and t['p'] < 1e-10 and t['df'] >= 1
    assert t['variants'][full['name']]['share']['a'] == 1.0 and t['variants'][full['name']]['q'] < 1e-10
    # random halves: no difference
    rng = np.random.default_rng(0)
    us = sorted(mols)
    pick = set(rng.choice(us, len(us)//2, replace=False))
    g2 = {'x': {'d': names(pick)}, 'y': {'d': names(set(us) - pick)}}
    t2 = aa.nfr_prevalence(state, jid, 'N1', g2, 5)['tests']['groups']
    assert t2['p'] > 0.001
    assert aa.nfr_prevalence(state, jid, 'N1', {}, 5)['tests']['groups'] is None
