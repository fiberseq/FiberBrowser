"""Chained region matching across indels and origins, ambiguity, thresholds and frame read geometry."""
import random
from types import SimpleNamespace

import numpy as np
import pytest

from lab.services.region_sync import (sequence_hits, correlate, compare_pair, local_profile, profiles, validate,
                                     find_regions, submit, get_job, dispose, cluster_check, summarise, parse_paf,
                                     chain_hits, merge_candidates, contradicted_by_sequence, _read_vector, frame_index,
                                     thresholds, map_point)
from services.insertion_identify import minimap2_path

# Sequence blocks align with minimap2, which the apps bundle (CI installs it).
needs_minimap2 = pytest.mark.skipif(minimap2_path() is None,
                                    reason="minimap2 is not installed (the apps bundle it): sequence blocks can't run")


def dna(n, seed=7):
    rng = random.Random(seed)
    return ''.join(rng.choices('ACGT', k=n))


def test_known_correspondence_loads_coverage_without_alignment(monkeypatch):
    from lab.services import region_sync
    calls = []
    def load(state, window, need_sequence):
        calls.append((window['panelId'], need_sequence, window['readIds']))
        return dict(sequence=None, coverage=[[[0, 1000]]], reads=1, circular=None), False
    monkeypatch.setattr(region_sync, 'load_window', load)
    monkeypatch.setattr(region_sync, 'compare_pair', lambda *args: pytest.fail('Known maps do not need alignment'))
    windows = [dict(panelId=k, datasetId=k, chrom='chr1', start=0, end=1000, readIds=[k]) for k in ['a', 'b']]
    result = find_regions(SimpleNamespace(), dict(windows=windows, metrics=['sequence'], coverageOnly=True))
    assert calls == [('a', False, ['a']), ('b', False, ['b'])]
    assert result['coverage'] == dict(a=[[[0, 1000]]], b=[[[0, 1000]]])
    assert result['proposals'] == []


def rc(s):
    return s.translate(str.maketrans('ACGT', 'TGCA'))[::-1]


@needs_minimap2
@pytest.mark.parametrize('mode', ['shift', 'reverse'])
def test_sync_sequence_hits(mode):
    a = dna(5000)
    b = dna(300, 23)+a if mode == 'shift' else rc(a)
    hits, lines = sequence_hits(a, b, 100)
    assert hits and lines >= 1
    best = hits[0]
    assert best['template'][1]-best['template'][0] == best['window'][1]-best['window'][0]
    if mode == 'reverse':
        assert best['strand'] == '-' and best['template'] == [0, 5000] and best['window'] == [0, 5000]
        assert map_point(best, 0) == 5000 and map_point(best, 4999) == 1
    else:
        assert best['window'][0]-best['template'][0] == 300 and best['identity'] == 1 and len(best['blocks']) == 1


@needs_minimap2
@pytest.mark.parametrize('size,kind', [(50, 'insertion'), (1500, 'insertion'), (300, 'deletion')])
def test_sync_chains_across_indels(size, kind):
    a = dna(6000, 41)
    extra = dna(size, 42)
    b = a[:3000] + extra + a[3000:] if kind == 'insertion' else a[:3000] + a[3000 + size:]
    hits, _ = sequence_hits(a, b, 100, max_indel=2000)
    chain = hits[0]
    # One proposal spans both sides of the indel; its block map places each side exactly.
    assert chain['template'][0] <= 10 and chain['template'][1] >= 5990
    assert len(chain['blocks']) >= 2
    gap = max(chain['gaps'], key=lambda g: g['inserted'] + g['deleted'])
    if kind == 'insertion':
        assert abs(gap['inserted'] - size) <= 5 and gap['deleted'] <= 5
        assert abs(map_point(chain, 4000) - (4000 + size)) <= 5
    else:
        assert abs(gap['deleted'] - size) <= 5 and gap['inserted'] <= 5
        assert abs(map_point(chain, 5000) - (5000 - size)) <= 5
    assert abs(map_point(chain, 1000) - 1000) <= 5


@needs_minimap2
def test_sync_chaining_respects_the_indel_limit():
    a = dna(6000, 43)
    b = a[:3000] + dna(1500, 44) + a[3000:]
    hits, _ = sequence_hits(a, b, 100, max_indel=500)
    assert all(h['template'][1] - h['template'][0] <= 3100 for h in hits)
    assert len([h for h in hits if h['aligned'] >= 2900]) == 2


def test_sync_chain_hits_joins_collinear_paf_lines():
    lines = [('+', [[0, 1000, 0, 1000, 1000]]), ('+', [[1200, 2000, 1900, 2700, 800]]), ('+', [[500, 900, 5000, 5400, 400]])]
    chains = chain_hits(lines, 2000, 100)
    best = max(chains, key=lambda c: c['aligned'])
    assert best['aligned'] == 1800 and best['gaps'][0]['inserted'] == 900 and best['gaps'][0]['deleted'] == 200
    assert any(c['aligned'] == 400 for c in chains)            # the other copy stays its own proposal
    assert all(c['aligned'] == 1000 or c['aligned'] == 800 or c['aligned'] == 400 for c in chain_hits(lines, 100, 100))


@needs_minimap2
def test_sync_sequence_keeps_alternative_repeat_hits():
    a = dna(4000)
    hits, _ = sequence_hits(a+dna(400, 55)+a, a)
    starts = {p['template'][0] for p in hits if p['template'][1]-p['template'][0] >= 3900}
    assert 0 in starts and 4400 in starts


@needs_minimap2
def test_sync_circular_window_match_across_origin_is_one_hit():
    a = dna(6000, 3)
    plasmid = a[2000:] + a[:2000]          # the same sequence, origin rotated
    hits, _ = sequence_hits(a, plasmid, 100, circular=True)
    crossing = [h for h in hits if h['window'][1] > len(plasmid)]
    assert crossing and crossing[0]['template'][1] - crossing[0]['template'][0] >= 5900
    assert all(h['window'][1] - h['window'][0] <= len(plasmid) for h in hits)


@needs_minimap2
def test_sync_circular_template_wraps_and_both_sides_dedupe():
    a = dna(6000, 5)
    rotated = a[2000:] + a[:2000]
    # The template is the plasmid now: its coordinates continue past its end.
    hits, _ = sequence_hits(rotated, a, 100, circular_template=True)
    assert len(hits) == 1 and hits[0]['template'][1] > 6000 and hits[0]['template'][1] - hits[0]['template'][0] >= 5900
    # Both circular: one chain, inside one turn on each side.
    both, _ = sequence_hits(rotated, a, 100, circular=True, circular_template=True)
    assert len(both) == 1 and both[0]['aligned'] >= 5900
    assert both[0]['template'][1] - both[0]['template'][0] <= 6000 and both[0]['window'][1] - both[0]['window'][0] <= 6000


@pytest.mark.parametrize('reverse', [False, True])
def test_sync_profile_recovers_offset_and_strand(reverse):
    a = np.random.default_rng(22).random(200)
    b = np.r_[np.full(17, np.nan), a, np.full(10, np.nan)]
    if reverse: b = b[::-1]
    best = correlate(a, b)[0]
    assert best['strand'] == ('-' if reverse else '+')
    assert best['score'] == pytest.approx(1)
    assert best['template'] == [0,2000]
    assert best['window'] == ([100,2100] if reverse else [170,2170])
    assert correlate(np.ones(100), np.ones(100)) == []


def loaded(signal, sequence=None, **kw):
    return dict(signals={'accessibility': np.asarray(signal, float), 'nfr': np.asarray(signal, float)},
                sequence=sequence, coverage=[], reads=0, circular=None, whole=False, **kw)


def window(panel, width):
    return dict(genome=panel, panelId=panel, datasetId=panel, chrom='chr1', start=0, end=width)


def test_sync_local_profile_supports_its_offset_and_flags_another():
    rng = np.random.default_rng(4)
    a = rng.random(400)
    b = np.r_[np.full(30, np.nan), a]
    rigid = lambda key: dict(template=[1000, 2000], window=[1000 + key, 2000 + key], strand='+')
    at = local_profile(a, b, rigid(300))
    assert at['r'] == pytest.approx(1) and at['shift'] == 0
    off = local_profile(a, b, rigid(500))
    assert off['shift'] == -200 and off['best'] > off['r'] + .5


def test_sync_profiles_follow_the_block_map_across_an_insertion():
    rng = np.random.default_rng(6)
    a = rng.random(400)
    b = np.r_[a[:200], rng.random(80), a[200:]]          # 800 bp inserted at 2,000 in the window
    chain = dict(template=[0, 4000], window=[0, 4800], strand='+',
                 blocks=[dict(template=[0, 2000], window=[0, 2000]), dict(template=[2000, 4000], window=[2800, 4800])])
    assert local_profile(a, b, chain, span=4000)['r'] == pytest.approx(1)
    rigid = dict(template=[0, 4000], window=[0, 4000], strand='+')
    assert local_profile(a, b, rigid, span=4000)['r'] < .6


@needs_minimap2
def test_sync_sequence_and_profiles_agree_single_metric_is_not_disagreement():
    rng = np.random.default_rng(5)
    a_sig = rng.random(500)
    b_sig = np.r_[np.full(30, np.nan), a_sig][:500]
    seq = dna(5000, 9)
    a, b = loaded(a_sig, seq), loaded(b_sig, dna(300, 10) + seq[:4700])
    found, log = compare_pair(a, b, window('a', 5000), window('b', 5000), ['sequence', 'accessibility', 'nfr'], 100)
    assert log['sequence']['chains'] >= 1
    top = found[0]
    assert top['status'] == 'agreement' and top['supports'] == 3 and top['confidence'] > .9
    # Sequence alone: single-metric, never 'disagreement'.
    only, _ = compare_pair(a, b, window('a', 5000), window('b', 5000), ['sequence'], 100)
    assert only[0]['status'] == 'single-metric'
    # Unrelated flat-ish profiles propose nothing on their own.
    noise, _ = compare_pair(loaded(rng.random(500)), loaded(rng.random(500)), window('a', 5000), window('b', 5000), ['accessibility'], 100)
    assert noise == []


def test_sync_summary_counts_disagreement_only_between_metrics():
    c = dict(metrics={'sequence': dict(verdict='supports', score=.99), 'accessibility': dict(verdict='disagrees', score=.0),
                      'nfr': dict(verdict='abstains', score=None)})
    out = summarise(c, ['sequence', 'accessibility', 'nfr'])
    half = summarise(dict(metrics={'sequence': dict(verdict='supports', score=1.0, share=.5), 'anchor': dict(verdict='supports', score=1.0)}), ['sequence', 'anchor'])
    assert half['confidence'] == pytest.approx(.75)
    assert out['status'] == 'disagreement' and out['assessed'] == 2 and out['confidence'] == pytest.approx(.99 / 1.5, abs=1e-3)


def test_sync_profiles_keep_holes_masked_and_nfr_gap():
    reads = [{'intervals':[(0,100,100),(100,300,0),(300,400,100),(500,600,0)]}]
    signal, coverage = profiles(reads, 700)
    assert signal['accessibility'][15] == 1
    assert np.isnan(signal['accessibility'][45])
    assert signal['nfr'][15] == 1
    assert np.isnan(signal['nfr'][55])
    assert coverage == [[[0,400],[500,600]]]


def test_sync_request_bounds():
    w = dict(panelId='a',datasetId='ds',chrom='chr1',start=0,end=15000)
    assert validate(dict(windows=[w,{**w,'panelId':'b'}],metrics=['nfr']))
    with pytest.raises(ValueError): validate(dict(windows=[w,w],metrics=['sequence']))
    with pytest.raises(ValueError): validate(dict(windows=[w,{**w,'panelId':'b','end':999999}],metrics=['nfr']))


def test_sync_uses_each_reference_and_keeps_read_scope(monkeypatch):
    from services import panel_genomes, analysis_query
    calls = []
    views = {'a':SimpleNamespace(tag='a'), 'b':SimpleNamespace(tag='b')}
    monkeypatch.setattr(panel_genomes,'genome_view',lambda state,key:views[key])
    monkeypatch.setattr(panel_genomes,'dataset_genome',lambda state,key:key)
    def query(view, **kw):
        calls.append((view.tag,kw))
        return SimpleNamespace(dataset_ids=[kw['dataset_id']], build_working_set=lambda v, ds, **_:SimpleNamespace(reads=[]))
    monkeypatch.setattr(analysis_query.AnalysisReadQuery,'from_request',query)
    windows=[dict(panelId=k,datasetId=k,genome=k,chrom='chr1',start=100,end=1100,readIds=[],anchor=dict(position=500,strand='-' if k=='b' else '+')) for k in ['a','b']]
    r=find_regions(SimpleNamespace(),dict(windows=windows,metrics=['anchor']))
    assert [c[0] for c in calls] == ['a','b']
    assert calls[0][1]['read_ids'] == []
    p=r['proposals'][0]
    assert p['strand'] == '-'
    assert p['template'][1]-p['template'][0] == p['window'][1]-p['window'][0]
    assert r['coverage'] == {'a':[], 'b':[]}


def test_sync_dispose_isolates_jobs():
    state=SimpleNamespace(_region_sync_jobs={'one':{'state':'running'}})
    job=get_job(state,'one')
    dispose(state)
    assert job['state'] == 'cancelled'
    with pytest.raises(KeyError):get_job(state,'one')
    with pytest.raises(KeyError):get_job(SimpleNamespace(),'one')


def test_sync_job_routes_progress_cancel_and_workspace_isolation(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from lab.routers.region_sync import router
    from lab.services import region_sync
    from state.dependencies import get_state
    state = SimpleNamespace()
    # Keep the worker queued so cancellation and progress are deterministic.
    monkeypatch.setattr(region_sync._POOL, 'submit', lambda work: None)
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_state] = lambda: state
    client = TestClient(app)
    base = '/api/lab/region-sync/jobs'
    windows = [dict(panelId=k,datasetId=k,genome=None,chrom='chr1',start=0,end=1000) for k in ['a','b']]
    response = client.post(base, json=dict(windows=windows,metrics=['accessibility']))
    assert response.status_code == 200
    job = response.json()
    assert job['state'] == 'queued' and job['fraction'] == 0
    assert client.post(base,json=dict(windows=windows,metrics=['accessibility'])).status_code == 422
    assert client.get(f"{base}/{job['id']}").json()['state'] == 'queued'
    assert client.delete(f"{base}/{job['id']}").json()['state'] == 'cancelled'
    app.dependency_overrides[get_state] = lambda: SimpleNamespace()
    assert client.get(f"{base}/{job['id']}").status_code == 404


def test_sync_cluster_check_reports_window_shares(monkeypatch):
    from services import panel_genomes, analysis_query
    monkeypatch.setattr(panel_genomes, 'genome_view', lambda state, key: SimpleNamespace())
    def reads(prefix, n):
        # Half open at 0-200, half open at 600-800 (both cover the whole 1 kb).
        return [dict(id=f'{prefix}{i}', intervals=[(0, 200, 0 if i % 2 else 200), (200, 600, 0), (600, 800, 200 if i % 2 else 0), (800, 1000, 0)])
                for i in range(n)]
    data = {'a': reads('a', 40), 'b': reads('b', 60)}
    monkeypatch.setattr(analysis_query.AnalysisReadQuery, 'from_request',
                        lambda view, **kw: SimpleNamespace(build_working_set=lambda v, ds, **_: SimpleNamespace(reads=data[ds])))
    windows = [dict(panelId=k, datasetId=k, chrom='chr1', start=0, end=1000, strand='+') for k in 'ab']
    out = cluster_check(SimpleNamespace(), dict(windows=windows, k=2))
    assert [w['used'] for w in out['windows']] == [40, 60]
    assert sorted(out['windows'][0]['clusters']) == [20, 20]
    assert all(c['agreement'] == pytest.approx(1) for c in out['clusters'])
    assert out['separation'] == pytest.approx(0, abs=1e-6)
    with pytest.raises(ValueError):
        cluster_check(SimpleNamespace(), dict(windows=[windows[0], dict(windows[1], end=900)]))
    # Several copies of one panel are separate windows with their own block maps and shares.
    copies = [dict(windows[0], key='a'), dict(windows[1], key='b#a', blocks=[dict(frame=[0, 1000], genomic=[0, 1000])]),
              dict(windows[1], key='b#b', strand='-', blocks=[dict(frame=[0, 1000], genomic=[0, 1000])])]
    pooled = cluster_check(SimpleNamespace(), dict(windows=copies, k=2, length=1000))
    assert [w['key'] for w in pooled['windows']] == ['a', 'b#a', 'b#b'] and all(w['used'] for w in pooled['windows'])


@needs_minimap2
def test_sync_sequence_overrides_a_contradicted_profile_shift():
    rng = np.random.default_rng(8)
    half = rng.random(250)
    sig = np.r_[half, half[::-1]]            # symmetric: reversed profile correlates perfectly
    seq = dna(5000, 12)
    found, log = compare_pair(loaded(sig, seq), loaded(sig, seq), window('a', 5000), window('b', 5000), ['sequence', 'accessibility'], 100)
    assert [p['strand'] for p in found] == ['+'] and found[0]['status'] == 'agreement'
    assert log.get('suppressed', 0) >= 1


@needs_minimap2
def test_sync_reversed_window_profiles_support_the_reverse_offset():
    rng = np.random.default_rng(3)
    a_sig = rng.random(500)
    seq = dna(5000, 21)
    b_seq = dna(300, 22) + rc(seq[:4700])
    b_sig = np.r_[rng.random(30), a_sig[:470][::-1]]
    found, _ = compare_pair(loaded(a_sig, seq), loaded(b_sig, b_seq), window('a', 5000), window('b', 5000), ['sequence', 'accessibility', 'nfr'], 100)
    top = found[0]
    assert top['strand'] == '-' and top['template'] == [0, 4700] and top['window'] == [300, 5000]
    assert all(top['metrics'][m]['verdict'] == 'supports' and top['metrics'][m]['shift'] == 0 for m in ('accessibility', 'nfr'))



def test_sync_profile_shifts_merge_but_never_absorb_chains_or_anchors():
    hit = lambda a, b, metric='accessibility', key=0: dict(template=[a, b], window=[a + key, b + key], strand='+', score=.5, metric=metric)
    merged = merge_candidates([hit(0, 1000, 'sequence', 500), hit(0, 1000, 'anchor', 900), hit(0, 800), hit(200, 900, 'nfr'), hit(0, 1000, 'nfr', 500)])
    assert sorted(m['metric'] for m in merged) == ['accessibility', 'anchor', 'sequence']
    profile = next(m for m in merged if m['metric'] == 'accessibility')
    assert profile['sources'] == ['accessibility', 'nfr'] and profile['template'] == [0, 900]


def test_sync_contradiction_uses_the_union_of_chain_blocks():
    profile = dict(template=[0, 1000], window=[0, 1000], strand='+', score=.9, metric='nfr')
    repeats = [dict(template=[0, 100], window=[w, w + 100], strand='+', identity=1.0) for w in (200, 400, 600, 800, 900)]
    assert not contradicted_by_sequence(profile, repeats)
    assert contradicted_by_sequence(profile, repeats + [dict(template=[100, 600], window=[300, 800], strand='+', identity=1.0)])


def test_sync_thresholds_default_validate_and_change_proposals():
    assert thresholds({}) == dict(profileSupport=.3, profileAloneR=.4, profileAloneZ=5.0, sequenceCover=.5, sequenceIdentity=.9, maxIndel=2000, shapeMinR=.6, shapeMinZ=4.0, shapeWidth=300, shapeLandmarks=0, minimum=200)
    with pytest.raises(ValueError):
        thresholds({'thresholds': {'maxIndel': -1}})
    with pytest.raises(ValueError):
        validate(dict(windows=[window('a', 1000), window('b', 1000)], metrics=['nfr'], thresholds={'profileSupport': 2}))
    rng = np.random.default_rng(9)
    a_sig = rng.random(300)
    b_sig = np.r_[np.full(20, np.nan), a_sig][:300] + rng.normal(0, .35, 300)
    args = (loaded(a_sig), loaded(b_sig), window('a', 3000), window('b', 3000), ['accessibility'])
    strict, _ = compare_pair(*args, thresholds({'thresholds': {'profileAloneR': .95}}))
    loose, _ = compare_pair(*args, thresholds({'thresholds': {'profileAloneR': .2, 'profileAloneZ': 2}}))
    assert strict == [] and loose and loose[0]['rigid']
    high, _ = compare_pair(*args, thresholds({'thresholds': {'profileAloneR': .2, 'profileAloneZ': 2, 'profileSupport': .99}}))
    assert high[0]['metrics']['accessibility']['verdict'] != 'supports'


def test_sync_cluster_vector_maps_bases_through_blocks():
    w = dict(start=0, end=1000, strand='+', blocks=[dict(frame=[0, 400], genomic=[0, 400]), dict(frame=[400, 800], genomic=[600, 1000])])
    index = frame_index(w, 800)
    assert index[399] == 399 and index[500] == -1 and index[600] == 400
    vector, cover = _read_vector(dict(intervals=[(0, 20, 0)]), index, 16)
    assert cover == pytest.approx(20 / 800)
    # A read open only inside the insertion contributes nothing to the frame.
    vector, cover = _read_vector(dict(intervals=[(0, 400, 150), (400, 600, 0), (600, 1000, 150)]), index, 16)
    assert np.nanmax(vector) == 0 and cover == 1
    rev = frame_index(dict(start=0, end=125, strand='-'), 125)
    assert rev[0] == 124 and rev[124] == 0
    with pytest.raises(ValueError):
        frame_index(dict(w, blocks=[dict(frame=[0, 10], genomic=[0, 20])]), 800)
    with pytest.raises(ValueError):
        frame_index(dict(w, blocks=[dict(frame=[0, 100], genomic=[0, 100]), dict(frame=[0, 100], genomic=[100, 200])]), 800)


def test_sync_circular_dedupe_keeps_chains_that_mostly_map_differently():
    from lab.services.region_sync import dedupe
    blk = lambda t, w: dict(template=list(t), window=list(w))
    # Agree only in the middle 200 bp; flanks map 100 bp apart.
    a = dict(strand='+', aligned=1000, template=[0, 1000], window=[0, 1000], blocks=[blk((0, 400), (0, 400)), blk((400, 600), (400, 600)), blk((600, 1000), (600, 1000))])
    b = dict(strand='+', aligned=1000, template=[0, 1000], window=[100, 1000], blocks=[blk((0, 400), (100, 500)), blk((400, 600), (400, 600)), blk((600, 900), (700, 1000))])
    assert len(dedupe([a, b], None, 5000)) == 2
    rotated = dict(a, template=[1000, 2000], blocks=[blk((t0 + 1000, t1 + 1000), w) for (t0, t1), w in ((x['template'], x['window']) for x in a['blocks'])])
    assert len(dedupe([a, rotated], 1000, None)) == 1


@needs_minimap2
def test_sync_per_panel_fasta_without_main_genome_finds_and_locates(tmp_path, standalone_app, monkeypatch):
    """The owner's setup: no main genome, BAMs with a per-panel FASTA (constructs + native)."""
    import os
    import pysam
    from state.browser_state import BrowserState
    from state import runtime_state
    from services import panel_genomes, insertion_identify
    from lab.services.region_sync import locate
    rng = random.Random(11)
    flank = lambda n: ''.join(rng.choice('ACGT') for _ in range(n))
    insert = flank(800)
    native = flank(20000) + insert + flank(9000)              # the shared segment at 20,000
    construct = flank(3000) + insert + flank(4000)            # a plasmid carrying it at 3,000
    fasta = tmp_path / 'refs.fa'
    fasta.write_text(f'>native\n{native}\n>construct\n{construct}\n')
    pysam.faidx(str(fasta))
    def bam(name, contig, length):
        header = {'HD': {'VN': '1.6', 'SO': 'coordinate'}, 'SQ': [{'SN': 'native', 'LN': len(native)}, {'SN': 'construct', 'LN': len(construct)}]}
        path = str(tmp_path / f'{name}.bam')
        with pysam.AlignmentFile(path + '.u.bam', 'wb', header=header) as out:
            for i in range(5):
                seg = pysam.AlignedSegment(out.header)
                seg.query_name, seg.reference_id, seg.reference_start = f'r{i}', 0 if contig == 'native' else 1, 100 * i
                seg.query_sequence, seg.cigarstring, seg.mapping_quality = 'ACGT' * 50, '200M', 60
                seg.query_qualities = pysam.qualitystring_to_array('I' * 200)
                out.write(seg)
        pysam.sort('-o', path, path + '.u.bam'); pysam.index(path)
        return path
    st = BrowserState(None)
    st.add_dataset('nat', bam('nat', 'native', len(native)), 'native')
    st.add_dataset('con', bam('con', 'construct', len(construct)), 'construct')
    runtime_state.set_browser_state(st)
    attached = panel_genomes.attach(st, ['nat', 'con'], fasta_path=str(fasta))
    key = attached['genome']['key']
    assert getattr(st, 'current_genome', None) in (None, '') and panel_genomes.dataset_genome(st, 'nat') == key
    w = lambda pid, ds, chrom, a, b: dict(panelId=pid, datasetId=ds, genome=key, chrom=chrom, start=a, end=b)
    found = find_regions(st, dict(windows=[w('a', 'nat', 'native', 15000, 29800), w('b', 'con', 'construct', 0, len(construct))], metrics=['sequence'], minimum=100))
    best = found['proposals'][0]
    assert best['template'][0] <= 20010 and best['template'][1] >= 20790 and best['status'] == 'single-metric'
    assert not [n for n in found['notes'] if n['kind'] in ('no-sequence', 'no-minimap2')]
    # The native window misses the segment: nothing found, said in words, and Locate finds it.
    missed = find_regions(st, dict(windows=[w('a', 'nat', 'native', 0, 15000), w('b', 'con', 'construct', 0, len(construct))], metrics=['sequence'], minimum=100))
    assert missed['proposals'] == [] and missed['notes'][0]['kind'] == 'nothing' and 'no shared sequence' in missed['notes'][0]['text']
    monkeypatch.setattr(insertion_identify, '_index_dir', lambda: str(tmp_path / 'mmi'))
    loci = locate(st, dict(template=w('a', 'nat', 'native', 0, 15000), query=w('b', 'con', 'construct', 0, len(construct))))['loci']
    assert loci[0]['chrom'] == 'native' and loci[0]['start'] <= 20010 and loci[0]['end'] >= 20790 and not loci[0]['inTemplate']
    assert os.path.isdir(tmp_path / 'mmi')


def test_sync_missing_minimap2_is_a_note_not_a_failure(monkeypatch):
    from services import insertion_identify
    monkeypatch.setattr(insertion_identify, 'minimap2_path', lambda: None)
    seq = dna(3000, 4)
    found, log = compare_pair(loaded(np.random.default_rng(1).random(300), seq), loaded(np.random.default_rng(2).random(300), seq),
                              window('a', 3000), window('b', 3000), ['sequence', 'accessibility'], 100)
    assert log['sequence'] == {'missing': 'minimap2'}
    from lab.services.region_sync import nothing_found, thresholds
    assert 'minimap2 not found' in nothing_found(log, ['sequence', 'accessibility'], thresholds({}))


@needs_minimap2
def test_sync_locate_keeps_a_nearby_copy_and_needs_containment_for_inside(tmp_path, standalone_app, monkeypatch):
    import pysam
    from state.browser_state import BrowserState
    from services import insertion_identify
    from lab.services.region_sync import locate
    rng = random.Random(21)
    rand = lambda n: ''.join(rng.choice('ACGT') for _ in range(n))
    a = rand(1000)
    contig = rand(10000) + a + rand(9000) + a + rand(10000)      # a at 10,000 and its copy at 20,000
    fasta = tmp_path / 'c.fa'
    fasta.write_text(f'>c\n{contig}\n')
    pysam.faidx(str(fasta))
    st = BrowserState(None)
    assert st._load_fasta(str(fasta)) is None
    monkeypatch.setattr(insertion_identify, '_index_dir', lambda: str(tmp_path / 'mmi'))
    w = lambda a, b: dict(panelId='p', datasetId='d', genome=None, chrom='c', start=a, end=b)
    loci = locate(st, dict(template=w(0, 15000), query=w(10000, 11000)))['loci']
    # The window's own copy is dropped; the copy 10 kb away (within one locus gap) stays.
    assert [(l['start'], l['end']) for l in loci] == [(20000, 21000)]
    assert loci[0]['inTemplate'] is False
    inside = locate(st, dict(template=w(19000, 22000), query=w(10000, 11000)))['loci']
    assert inside[0]['inTemplate'] is True



def smooth_noise(n, rng, k=9):
    return np.convolve(rng.normal(size=n + k), np.ones(k) / k, mode='valid')[:n]


def chromatin(n, rng, motif=None, at=None):
    """Synthetic accessibility / NFR / nucleosome channels; a shared element pasted at ``at``."""
    sig = {'accessibility': smooth_noise(n, rng), 'nfr': np.clip(smooth_noise(n, rng) * .05 + .05, 0, 1), 'nuc': smooth_noise(n, rng), 'depth': np.full(n, 200.0)}
    if motif is not None:
        for c in ('accessibility', 'nfr', 'nuc'):
            sig[c][at:at + len(motif[c])] = motif[c]
    return sig


def element(rng, w=60):
    """A shared element with a direction (skewed accessibility, phased nucleosome ripple), so its strand is
    decided by its shape rather than by noise: a mirror-symmetric element ties the two strands, and the tie
    went either way with the BLAS / numpy version."""
    x = np.linspace(-1, 1, w)
    return {'accessibility': np.exp(-(x / .3) ** 2) * 3 * (1 + .6 * x) + rng.normal(0, .2, w),
            'nfr': np.exp(-(x / .25) ** 2) * .8,
            'nuc': -np.exp(-(x / .3) ** 2) * 3 + np.cos(x * 9 + 1) + rng.normal(0, .2, w)}


@pytest.mark.parametrize('reverse', [False, True])
def test_sync_local_shape_finds_a_shared_element_in_unrelated_flanks(reverse):
    from lab.services.region_sync import shape_match
    rng = np.random.default_rng(31)
    motif = element(rng)
    a = chromatin(1500, rng, motif, 400)
    b_motif = {c: (v[::-1] if reverse else v) for c, v in motif.items()}
    b = chromatin(1200, rng, b_motif, 900)
    blocks, log = shape_match(a, b, thresholds({}))
    assert blocks, log
    best = blocks[0]
    assert best['strand'] == ('-' if reverse else '+') and best['metric'] == 'shape'
    assert best['template'][0] <= 4300 and best['template'][1] >= 4300          # the element's centre in A
    assert best['window'][0] <= 9300 and best['window'][1] >= 9300            # and in B
    assert best['nfr'] is not None and abs(best['nfr'][0] - 4300) <= 100 and abs(best['nfr'][1] - 9300) <= 100
    assert log['seconds'] if 'seconds' in log else True


def test_sync_local_shape_finds_nothing_in_noise():
    from lab.services.region_sync import shape_match
    for seed in (1, 2, 3):
        rng = np.random.default_rng(seed)
        blocks, log = shape_match(chromatin(1500, rng), chromatin(1200, rng), thresholds({}))
        assert blocks == [], (seed, log)


def test_sync_shape_proposals_are_chromatin_only_and_never_count_as_agreement_alone():
    rng = np.random.default_rng(32)
    motif = element(rng)
    a, b = chromatin(1500, rng, motif, 400), chromatin(1200, rng, motif, 900)
    found, log = compare_pair(dict(signals=a, sequence=None, coverage=[], reads=0, circular=None, whole=False),
                              dict(signals=b, sequence=None, coverage=[], reads=0, circular=None, whole=False),
                              window('a', 15000), window('b', 12000), ['accessibility', 'nfr', 'shape'], thresholds({}))
    shape = [p for p in found if 'shape' in p['sources']]
    assert shape and 'chromatin-only' in shape[0]['flags'] and shape[0]['rigid']
    # Accessibility, NFR shape and local shape read the same reads: one line of evidence.
    assert shape[0]['status'] in ('single-metric', 'weak', 'disagreement')


@pytest.mark.parametrize('strand', ['+', '-'])
def test_sync_shape_chaining_keeps_the_best_seed_mapping(strand):
    from lab.services.region_sync import chain_shape, block_key
    def hit(t0, z):
        tpl = [t0, t0 + 300]
        win = [t0 + 500, t0 + 800] if strand == '+' else [2000 - t0 - 300, 2000 - t0]
        return dict(template=tpl, window=win, strand=strand, r=.8, z=z, score=.8, nfr=None)
    blocks = chain_shape([hit(400, 6), hit(100, 5)], 5000, 5000)
    assert len(blocks) == 1
    blk = blocks[0]
    assert blk['template'] == [100, 700]
    assert block_key(blk, strand) == block_key(hit(400, 6), strand)        # one mapping for the whole block
    assert blk['window'][1] - blk['window'][0] == 600


def test_sync_shape_rarely_matches_unrelated_smooth_chromatin():
    from lab.services.region_sync import shape_match
    def smooth(n, sigma, rng):
        x = rng.normal(size=n + 6 * sigma)
        k = np.exp(-0.5 * (np.arange(-3 * sigma, 3 * sigma + 1) / sigma) ** 2)
        return np.convolve(x, k / k.sum(), mode='valid')[:n]
    found = 0
    for trial in range(20):
        rng = np.random.default_rng(500 + trial)
        def sig(n):
            x = smooth(n, 15, rng); x = (x - x.mean()) / x.std()
            return {'accessibility': x, 'nfr': np.clip(.05 * x + .1, 0, 1), 'nuc': 1 - x, 'depth': np.full(n, 200.0)}
        found += bool(shape_match(sig(600), sig(500), thresholds({}))[0])
    assert found <= 2      # a family-wise ceiling against phase-randomised nulls; measured 1 of 30 at sigma 15


@needs_minimap2
@pytest.mark.parametrize('inverted', [False, True])
def test_sync_internal_three_copies_excludes_diagonal(inverted):
    repeat = dna(472, 890)
    sequence = dna(350, 1) + repeat + dna(300, 2) + repeat + dna(300, 3) + (rc(repeat) if inverted else repeat) + dna(350, 4)
    hits, _ = sequence_hits(sequence, sequence, 200, diagonal=0, self_match=True, identity=.9)
    assert len(hits) == 3
    for c in hits:
        assert c['template'][0] < c['window'][0]
        assert c['aligned'] >= 470
        assert c['identity'] >= .98
        assert c['strand'] == ('-' if inverted and c['window'][0] > 1850 else '+')
    assert sorted({round(c[side][0] / 10) * 10 for c in hits for side in ('template', 'window')}) == [350, 1120, 1890]


@needs_minimap2
@pytest.mark.parametrize('repeat', ['A' * 500, 'AC' * 250, 'ATG' * 170, 'ACGTAC' * 85])
def test_sync_internal_rejects_low_complexity(repeat):
    sequence = dna(350, 1) + repeat + dna(350, 2) + repeat + dna(350, 3)
    hits, _ = sequence_hits(sequence, sequence, 200, diagonal=0, self_match=True, identity=.9)
    assert hits == []


@needs_minimap2
@pytest.mark.parametrize('offset', [0, 100])
def test_sync_same_locus_datasets_offer_repeats_not_identity(monkeypatch, offset):
    from lab.services import region_sync
    repeat = dna(472, 890)
    seq = dna(350, 1) + repeat + dna(300, 2) + repeat + dna(300, 3) + repeat + dna(350, 4)
    windows = [dict(window('a', len(seq)), genome=None), dict(window('b', len(seq)), genome=None, start=offset)]
    def load(state, w, want):
        part = seq[w['start']:w['end']]
        return loaded(np.zeros((len(part) + 9) // 10), part), False
    monkeypatch.setattr(region_sync, 'load_window', load)
    result = find_regions(SimpleNamespace(), dict(windows=windows, metrics=['sequence']))
    between = [p for p in result['proposals'] if p['panelId'] != p['partnerId']]
    assert len(between) >= 3
    assert all(p['strand'] != '+' or p['template'][0] != p['window'][0] for p in result['proposals'])
    assert any(n['text'] == 'Same sequence in both windows — showing repeats within it' for n in result['notes'])
    assert validate(dict(windows=windows[:1], metrics=['sequence']))


def test_sync_self_shape_masks_diagonal_before_seed_search():
    from lab.services.region_sync import shape_match
    rng = np.random.default_rng(894)
    motif = chromatin(80, rng)
    a = chromatin(600, rng)
    for key in a:
        for at in (60, 240, 420):
            a[key][at:at + 80] = motif[key]
    blocks, _ = shape_match(a, a, thresholds({'thresholds': {'shapeMinZ': 2}}), diagonal=0)
    assert blocks
    assert all(abs(p['window'][0] - p['template'][0]) >= 300 for p in blocks)
    assert any(abs(abs(p['window'][0] - p['template'][0]) - 1800) <= 30 for p in blocks)


@needs_minimap2
@pytest.mark.parametrize('copies', [2, 3])
def test_sync_adjacent_copies_survive_overlapping_envelopes(copies):
    repeat = dna(500, 890)
    sequence = dna(300, 1) + repeat * copies + dna(300, 2)
    hits, _ = sequence_hits(sequence, sequence, 200, diagonal=0, self_match=True, identity=.9)
    starts = {round(c[side][0] / 10) * 10 for c in hits for side in ('template', 'window')}
    assert starts == {300 + 500 * i for i in range(copies)}
    assert all(c['aligned'] >= 490 and c['template'][1] <= c['window'][0] for c in hits)


def test_sync_circular_window_overlap_excludes_physical_identity():
    from lab.services.region_sync import same_locus
    sequence = dna(2000, 451)
    wa = dict(window('a', 2400), start=1800, genome=None)
    wb = dict(window('b', 600), genome=None)
    assert same_locus(wa, wb, 2000)
    assert not same_locus(wa, dict(wb, chrom='other'), 2000)
    a = dict(loaded(np.zeros(60), (sequence * 2)[1800:2400]), circular=2000)
    b = dict(loaded(np.zeros(60), sequence[:600]), circular=2000)
    found, _ = compare_pair(a, b, wa, wb, ['sequence'], 200)
    assert found == []


@needs_minimap2
def test_sync_circular_repeat_keeps_the_full_origin_spanning_match():
    repeat = dna(500, 890)
    sequence = repeat[250:] + dna(300, 1) + repeat + dna(600, 2) + repeat[:250]
    assert len(sequence) == 1900
    hits, _ = sequence_hits(sequence, sequence, 200, circular=True, circular_template=True, diagonal=0, self_match=True, identity=.9)
    assert any(c['aligned'] >= 499 for c in hits)
    assert all((c['window'][0] - c['template'][0]) % 1900 for c in hits if c['strand'] == '+')
