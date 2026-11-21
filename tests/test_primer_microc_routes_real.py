"""The primer panel's three design modes and the Micro-C contact-map routes, run for real (coverage plan #43).

Primers: a random synthetic reference and a BLAST database built from it; each route (standard PCR, DAF-C, 4C) runs
primer3 and blastn with nothing patched, and every returned primer must be the reference sequence at the
coordinates it reports, flank or sit in its target, and be unique in the database. Needs ``makeblastdb`` and
``blastn``; skips (saying so) where BLAST is not installed.

Micro-C: a tiny synthetic contact table (distance decay plus one planted loop) written as a .cool, loaded through
``/api/dafc/load``; the matrix, strip, virtual 4C and arcs routes must return the planted counts.
"""
from __future__ import annotations

import random
import shutil
import subprocess

import pytest

COMP = str.maketrans('ACGT', 'TGCA')


def _rc(s):
    return s.translate(COMP)[::-1]


# ---------------------------------------------------------------------------------------------------------- primers

@pytest.fixture(scope='module')
def reference(tmp_path_factory):
    if shutil.which('makeblastdb') is None or shutil.which('blastn') is None:
        pytest.skip('BLAST+ (makeblastdb, blastn) is not installed: the primer routes need it')
    d = tmp_path_factory.mktemp('primers')
    rng = random.Random(7)
    seq = ''.join(rng.choice('ACGT') for _ in range(60_000))
    fa = d / 'syn.fa'
    fa.write_text('>chrP\n' + '\n'.join(seq[i:i + 60] for i in range(0, len(seq), 60)) + '\n')
    subprocess.run(['makeblastdb', '-in', str(fa), '-dbtype', 'nucl', '-out', str(d / 'syn')], check=True,
                   capture_output=True)
    return dict(fasta=str(fa), db=str(d / 'syn'), seq=seq)


@pytest.fixture
def primer_client(standalone_app, reference):
    import server as srv
    from starlette.testclient import TestClient
    from conftest import auth_headers
    from state import runtime_state
    from state.browser_state import BrowserState
    from state.runtime_state import set_browser_state
    previous, previous_runtime = srv.state, runtime_state._state
    st = BrowserState(None, None, None, None)
    st.fasta_path, st.primer_blast_db, st.current_genome, st.primer_fasta = reference['fasta'], reference['db'], 'syn', None
    srv.state = st
    set_browser_state(st)
    try:
        yield TestClient(standalone_app, headers=auth_headers())
    finally:
        srv.state = previous
        set_browser_state(previous_runtime)


def _check_pair(seq, p):
    assert p['fwd_seq'] == seq[p['fwd_start']:p['fwd_end']], p
    assert p['rev_seq'] == _rc(seq[p['rev_start']:p['rev_end']]), p
    assert p['fwd_len'] == len(p['fwd_seq']) and p['rev_len'] == len(p['rev_seq'])


def _unique(p):
    for side in ('fwd_blast_hits', 'rev_blast_hits'):
        if side in p:
            assert p[side]['on_target'] == 1 and p[side]['off_target'] == 0, p


def test_standard_pcr_primers_flank_the_target(primer_client, reference):
    seq = reference['seq']
    r = primer_client.post('/api/design_primers', json=dict(chrom='chrP', start=20_000, end=21_000, min_product=2_000,
                                                            max_product=6_000))
    assert r.status_code == 200
    body = r.json()
    assert body['success'] is True, body
    assert body['pairs']
    for p in body['pairs']:
        _check_pair(seq, p)
        _unique(p)
        assert p['fwd_end'] <= 20_000 and p['rev_start'] >= 21_000
        assert p['product_size'] == p['rev_end'] - p['fwd_start']
        assert 2_000 <= p['product_size'] <= 6_000
        assert 55 <= p['fwd_tm'] <= 65 and 55 <= p['rev_tm'] <= 65 and p['tm_diff'] <= 2.0


def test_dafc_primer_quads_flank_both_loci(primer_client, reference):
    seq = reference['seq']
    r = primer_client.post('/api/design_dafc_primers', json=dict(
        chrom='chrP', x_start=10_000, x_end=11_000, y_start=40_000, y_end=41_000, min_product=2_000, max_product=6_000))
    assert r.status_code == 200
    body = r.json()
    assert body['success'] is True, body
    assert body['quads']
    for q in body['quads']:
        for key, (a, b) in (('x_pair', (10_000, 11_000)), ('y_pair', (40_000, 41_000))):
            p = q[key]
            _check_pair(seq, p)
            assert p['fwd_end'] <= a and p['rev_start'] >= b
            assert 2_000 <= p['product_size'] <= 6_000


def test_4c_primers_sit_in_the_viewpoint(primer_client, reference):
    seq = reference['seq']
    r = primer_client.post('/api/design_4c_primers', json=dict(chrom='chrP', start=30_000, end=32_000))
    assert r.status_code == 200
    body = r.json()
    assert body['success'] is True, body
    assert body['pairs']
    for p in body['pairs']:
        # inverse PCR: both primers inside the viewpoint, each the reference (or its reverse complement) where it says
        for side in ('fwd', 'rev'):
            s, e, prim = p[f'{side}_start'], p[f'{side}_end'], p[f'{side}_seq']
            assert 30_000 <= s < e <= 32_000
            assert prim in (seq[s:e], _rc(seq[s:e])), p


def test_primer_routes_refuse_a_contig_not_in_the_reference(primer_client):
    body = primer_client.post('/api/design_primers', json=dict(chrom='chrNope', start=100, end=200)).json()
    assert body['success'] is False and 'not in FASTA' in body['message']


# ---------------------------------------------------------------------------------------------------------- Micro-C

RES, NBINS = 1_000, 100
LOOP = (20, 60)          # planted loop between bins 20 and 60 (40 kb apart)


@pytest.fixture
def microc_client(standalone_app, tmp_path):
    cooler = pytest.importorskip('cooler')
    import pandas as pd
    from models.domain import DAFCState
    from state.dependencies import get_dafc_state
    from starlette.testclient import TestClient
    from conftest import auth_headers
    bins = pd.DataFrame({'chrom': ['chrC'] * NBINS, 'start': [i * RES for i in range(NBINS)],
                         'end': [(i + 1) * RES for i in range(NBINS)]})
    rows = []
    for i in range(NBINS):
        for j in range(i, min(NBINS, i + 50)):
            count = max(1, 100 // (1 + j - i))
            if (i, j) == LOOP:
                count = 500
            rows.append((i, j, count))
    pixels = pd.DataFrame(rows, columns=['bin1_id', 'bin2_id', 'count'])
    cool = tmp_path / 'synthetic.cool'
    cooler.create_cooler(str(cool), bins, pixels)
    dafc = DAFCState()
    standalone_app.dependency_overrides[get_dafc_state] = lambda: dafc
    try:
        c = TestClient(standalone_app, headers=auth_headers())
        r = c.post('/api/dafc/load', params={'cool_file': str(cool)})
        assert r.status_code == 200, r.text
        yield c
    finally:
        standalone_app.dependency_overrides.pop(get_dafc_state, None)


def test_microc_matrix_virtual4c_arcs_and_strip_return_the_planted_contacts(microc_client):
    c = microc_client
    m = c.get('/api/microc/matrix/data', params=dict(chrom='chrC', start=0, end=NBINS * RES))
    assert m.status_code == 200, m.text
    body = m.json()
    mat = body['matrix']
    assert body['resolution'] == RES and body['n_bins'] == NBINS
    i, j = LOOP
    assert mat[i][j] == mat[j][i] == 500
    assert mat[5][5] == 100 and mat[5][6] == 50 and mat[5][70] == 0
    oe = c.get('/api/microc/matrix/data', params=dict(chrom='chrC', start=0, end=NBINS * RES, normalization='oe')).json()
    assert oe['matrix'][i][j] > 5, 'the loop stands out over the distance expected'
    v = c.get('/api/microc/virtual4c', params=dict(chrom='chrC', viewpoint_start=i * RES, viewpoint_end=(i + 1) * RES,
                                                   profile_start=(j - 10) * RES, profile_end=(j + 10) * RES))
    assert v.status_code == 200, v.text
    prof = v.json()['profile']
    assert len(prof) == 20
    assert prof[10] == 500 and max(prof) == 500, prof   # profile bin 10 = bin j: the planted partner
    assert prof[0] == 100 // (1 + (j - 10) - i)
    arcs = c.get('/api/microc/arcs', params=dict(chrom='chrC', start=0, end=NBINS * RES, normalization='oe',
                                                 min_distance=10_000, threshold=0.5))
    assert arcs.status_code == 200, arcs.text
    got = arcs.json()['arcs']
    assert got, arcs.json()
    top = max(got, key=lambda a: a['strength'])
    assert {top['start'] // RES, top['end'] // RES} & {i, j}, top
    strip = c.get('/api/microc/matrix/strip', params=dict(chrom='chrC', start=0, end=NBINS * RES, width=200, height=60))
    assert strip.status_code == 200 and strip.content[:8] == b'\x89PNG\r\n\x1a\n'
    assert c.get('/api/microc/matrix/data', params=dict(chrom='chrNope', start=0, end=10)).status_code == 404
