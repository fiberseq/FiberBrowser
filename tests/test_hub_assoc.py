"""Feature hub A2: association runs over hub sets (services/hub/assoc*.py) on synthetic table-mode scans.

Gates covered here:
- M1 over two scan sets equals ``fiberhmm-scan assoc --mode cooccur`` on the same scan (the same functions, the same
  pairs, tables, pooled odds ratio and p; the browser keys molecules by browser dataset);
- M3 over nuc marks equals ``fiberhmm-scan assoc --mode rate``;
- M4 uses the scan's callable territory within the view, both directions;
- a molecule without a state row never gets a 0 (absent is never unbound); an SV every molecule carries gives a
  "no contrast" limit, not numbers;
- haplotype groups read HP tags, unphased molecules are their own group (D14);
- cluster contrasts over their own regions are refused, or descriptive without p-values;
- the job manager runs, cancels and disposes association runs apart from scans.
"""
from __future__ import annotations

import json
import random
from argparse import Namespace
from pathlib import Path
from types import SimpleNamespace as NS

import numpy as np
import pytest

pysam = pytest.importorskip('pysam')
pytest.importorskip('fiberhmm.assoc')

from scan_fixtures import row, write_table

CONTIG, LENGTH = 'chrT', 200_000


def _bam(path: Path, reads):
    """(qname, start, length, hp) records, indexed."""
    header = {'HD': {'VN': '1.6', 'SO': 'coordinate'}, 'SQ': [{'SN': CONTIG, 'LN': LENGTH}]}
    with pysam.AlignmentFile(str(path), 'wb', header=header) as out:
        for qname, start, length, hp in sorted(reads, key=lambda r: r[1]):
            a = pysam.AlignedSegment()
            a.query_name, a.flag, a.reference_id, a.reference_start = qname, 0, 0, start
            a.mapping_quality, a.cigarstring, a.query_sequence = 60, f'{length}M', 'A' * length
            if hp:
                a.set_tag('HP', hp)
            out.write(a)
    pysam.index(str(path))
    return str(path)


def _mol(q):
    from fiberhmm.scan.identity import molecule_id
    return molecule_id([q])


def _scan(out: Path, bam: str, *, fp_hits, nfr_hits, states, openness, marks=(), callable_runs=((0, LENGTH),),
          dataset_id='dataset_1', scan_id='feedfacefeedface'):
    """A table-mode scan: fp.class and nfr.region hits with states, nfr/molecules openness, optional nuc marks."""
    from services.scan.identity import content_id
    order = {CONTIG: 0}
    tables = {}
    hit_cols = ['hit_id', 'type', 'anchor', 'strand', 'unit_id', 'score', 'label', 'flags', 'parent_id']
    unit = f'{CONTIG}:0-{LENGTH}'
    for module, type_id, hits in (('fp', 'fp.class', fp_hits), ('nfr', 'nfr.region', nfr_hits)):
        n = write_table(out / module / 'hits.tsv.bgz', hit_cols,
                        [row(CONTIG, s, e, h, type_id, (s + e) // 2, '.', unit, '0.5', h.split(':')[-1], '', '')
                         for h, s, e in hits], order)
        tables[f'{module}/hits.tsv.bgz'] = dict(rows=n)
        rows = [row(CONTIG, s, e, h, dataset_id, 0, q, f'{q}sha:0', _mol(q), st) + ([ch] if module == 'fp' else [])
                for (h, s, e, q, st, ch) in states if h.split(':')[0] == module]
        cols = ['hit_id', 'dataset_id', 'input_index', 'qname', 'record', 'molecule', 'state'] + (['channel'] if module == 'fp' else [])
        n = write_table(out / module / 'states.tsv.bgz', cols, rows, order)
        tables[f'{module}/states.tsv.bgz'] = dict(rows=n)
    n = write_table(out / 'nfr' / 'molecules.tsv.bgz', ['dataset_id', 'input_index', 'qname', 'record', 'molecule', 'openness'],
                    [row(CONTIG, s, s + 3000, dataset_id, 0, q, f'{q}sha:0', _mol(q), o) for q, s, o in openness], order)
    tables['nfr/molecules.tsv.bgz'] = dict(rows=n)
    modules = {
        'fp': dict(version='1.0', settings_hash='aaaa', feature_types=[dict(type_id='fp.class', module='fp', label='Footprint class',
                   plural='Footprint classes', provides=['hit', 'state'], anchor='centre', scores=[])]),
        'nfr': dict(version='1.0', settings_hash='bbbb', feature_types=[dict(type_id='nfr.region', module='nfr', label='NFR',
                    plural='NFRs', provides=['hit', 'state'], anchor='centre', scores=[], transferable_state=True)]),
    }
    if marks:
        n = write_table(out / 'nuc' / 'marks.tsv.bgz',
                        ['group', 'dataset_id', 'input_index', 'qname', 'record', 'molecule', 'mol_start', 'mol_len', 'q', 'name'],
                        [row(CONTIG, s, e, g, dataset_id, 0, q, f'{q}sha:0', _mol(q), 0, e - s, code, '') for g, q, s, e, code in marks], order)
        tables['nuc/marks.tsv.bgz'] = dict(rows=n)
        modules['nuc'] = dict(version='2.2', settings_hash='cccc', feature_types=[])
    n = write_table(out / 'callable.tsv.bgz', ['dataset_id', 'min_molecules'],
                    [row(CONTIG, a, b, dataset_id, 5) for a, b in callable_runs], order)
    tables['callable.tsv.bgz'] = dict(rows=n)
    n = write_table(out / 'units.tsv.bgz', ['unit_id', 'zone_start', 'zone_end', 'mode', 'status', 'records'],
                    [row(CONTIG, 0, LENGTH, unit, 0, LENGTH, 'bed', 'done', 10)], order)
    tables['units.tsv.bgz'] = dict(rows=n)
    manifest = {
        'schema': 'fiberhmm.scan.v1', 'scan_id': scan_id, 'fiberhmm': {'version': '3.1.0'},
        'reference': {'contigs': [[CONTIG, LENGTH]], 'contigs_sha256': 'x' * 64}, 'frame': {'kind': 'linear'},
        'datasets': [{'dataset_id': dataset_id, 'ordinal': 0, 'chemistry': None,
                      'files': [{'name': Path(bam).name, 'path': str(bam), 'input_index': 0, 'content_id': content_id(bam), 'size': 1}]}],
        'read_policy': {}, 'units': {'mode': 'bed', 'count': 1}, 'modules': modules,
        'outputs': {'annotate': False, 'annotated': [], 'tables': tables},
        'status': {'units_total': 1, 'units_done': 1, 'units_failed': [], 'seams_open': 0},
    }
    (out / 'manifest.json').write_text(json.dumps(manifest))
    return out


def _state(*datasets):
    st = NS(datasets={}, chroms=[NS(name=CONTIG, size=LENGTH)])
    for ds in datasets:
        st.datasets[ds.id] = ds
    return st


def _dataset(ds_id, path, label=None):
    from models.domain import Dataset
    ds = Dataset(ds_id, path, label=label or ds_id.upper())
    ds.data_type = 'bam'
    return ds


@pytest.fixture
def world(tmp_path):
    """60 molecules over two fp.class / nfr.region pairs; B's state follows A's on 70% of molecules."""
    rng = random.Random(7)
    reads, states, openness = [], [], []
    fp_hits = [('fp:class:chrT:10500:aaaa0001', 10490, 10510), ('fp:class:chrT:40500:aaaa0002', 40490, 40510)]
    nfr_hits = [('nfr:region:chrT:11500:bbbb0001', 11400, 11600), ('nfr:region:chrT:41500:bbbb0002', 41400, 41600)]
    for i in range(60):
        q = f'm64001_{i:03d}/{1000 + i}/ccs'
        locus = 10_000 if i < 30 else 40_000
        reads.append((q, locus - 200, 3000, 1 + (i % 2) if i % 10 else 0))
        a = rng.random() < 0.5
        b = a if rng.random() < 0.7 else not a
        fh, nh = (fp_hits[0], nfr_hits[0]) if i < 30 else (fp_hits[1], nfr_hits[1])
        states.append((fh[0], fh[1], fh[2], q, '1' if a else '0', 'pooled'))
        if i % 15 != 3:          # some molecules have no B state at all (no row: not evaluated)
            states.append((nh[0], nh[1], nh[2], q, '1' if b else '0', ''))
        openness.append((q, locus - 200, round(rng.random(), 3)))
    bam = _bam(tmp_path / 'a.bam', reads)
    scan = _scan(tmp_path / 'scan', bam, fp_hits=fp_hits, nfr_hits=nfr_hits, states=states, openness=openness)
    st = _state(_dataset('ds_a', bam, 'Sample A'))
    from services.scan import registry
    opened = registry.open_scan(st, scan)
    sets = {s['typeId']: s['setId'] for s in opened.sets(st)}
    return NS(state=st, scan=scan, bam=bam, sets=sets, reads=reads, states=states)


def _defn(mode, a, b=None, **extra):
    from services.hub.assoc import normalize_request
    req = dict(mode=mode, a=a, b=b, scope=dict(kind='view', chrom=CONTIG, start=0, end=60_000),
               options=dict(nBoot=50, nPerm=99, seed=3))
    req.update(extra)
    return normalize_request(req)


def test_m1_over_scan_sets_equals_fiberhmm_scan_assoc(world):
    from fiberhmm.assoc.cli import run as cli_run
    from services.hub.assoc import run
    out = run(world.state, _defn('M1', dict(kind='scan', setId=world.sets['fp.class'], typeId='fp.class'),
                                 dict(kind='scan', setId=world.sets['nfr.region'], typeId='nfr.region')))
    assert out['status'] == 'ok', out.get('limits')
    cli = cli_run(Namespace(scan_dir=str(world.scan), mode='cooccur', a='fp.class', b='nfr.region', region=[f'{CONTIG}:0-60000'],
                            group=None, haplotype_tag='HP', labels=None, group_label=None, density='rho_read',
                            max_distance=5000, test='adjusted', strata=None, n_perm=99, n_boot=50, seed=3, response=None, bed=None))
    mine, theirs = out['result'], cli
    assert mine['n_pairs_tested'] == theirs['n_pairs_tested'] == 2
    assert mine['pooled']['n_molecules'] == theirs['pooled']['n_molecules']
    assert mine['pooled']['or'] == pytest.approx(theirs['pooled']['or'], rel=1e-9)
    assert mine['pooled']['p'] == pytest.approx(theirs['pooled']['p'], rel=1e-9)
    assert 'pairs' not in mine and mine['pairs_rows_moved'] == 2      # the rows live in out['anchors']
    by = {(p['a'], p['b']): p for p in out['anchors']}
    for p in theirs['pairs']:
        q = by[(p['a'], p['b'])]
        assert q['table'] == p['table'] and q['p'] == pytest.approx(p['p_exact'])
        assert q['excludedNoB'] == p['excluded_no_b_state']
    assert out['effects'][0]['key'] == 'pooled' and out['anchors'] and out['inputs']['covariates']['openness'] > 0
    assert out['cli'] and 'fiberhmm-scan assoc' in out['cli'] and '--mode cooccur' in out['cli']


def test_missing_state_rows_are_never_zero(world):
    """Molecules with no B state row (not evaluated) are left out of B, never counted as state 0."""
    from services.hub.assoc_inputs import Molecules, scan_set_hits, scan_set_states
    mols = Molecules()
    t = scan_set_hits(world.state, world.sets['nfr.region'], [(CONTIG, 0, 60_000)])
    scan_set_states(world.state, t, world.sets['nfr.region'], mols)
    have = {(mols.qnames[m] and next(iter(mols.qnames[m]))) for _h, m, _s in t.rows}
    no_row = {q for i, (q, *_r) in enumerate(world.reads) if i % 15 == 3}
    assert no_row and not (no_row & have)
    assert len(t.rows) == 60 - len(no_row)


def test_haplotype_groups_and_unphased(world):
    from services.hub.assoc import run
    out = run(world.state, _defn('M1', dict(kind='scan', setId=world.sets['fp.class'], typeId='fp.class'),
                                 dict(kind='scan', setId=world.sets['nfr.region'], typeId='nfr.region'),
                                 group=dict(kind='haplotype')))
    assert out['status'] == 'ok'
    info = out['inputs']['group']
    assert info['unphased'] == 6 and info['phased'] == 54        # every 10th read has no HP tag
    res = out['result']
    assert set(res['groups']) == {'HP1', 'HP2'}
    assert res['group_info']['unphased'] == 6
    assert any(e['key'] == 'unphased' for e in out['effects']) or res.get('unphased') is None
    assert 'interaction' in res


def test_cluster_contrast_post_selection(world):
    from services.hub.assoc import run
    labels = {'ds_a': {q: ('C0' if i % 3 else 'C1') for i, (q, *_r) in enumerate(world.reads)}}
    a = dict(kind='scan', setId=world.sets['fp.class'], typeId='fp.class')
    b = dict(kind='scan', setId=world.sets['nfr.region'], typeId='nfr.region')
    refused = run(world.state, _defn('M1', a, b, group=dict(kind='cluster', labels=labels, clusterRegions=[[CONTIG, 10_400, 10_600]], flank=100)))
    assert refused['status'] == 'refused' and refused['postSelection']['status'] == 'refused'
    accepted = run(world.state, _defn('M1', a, b, group=dict(kind='cluster', labels=labels, clusterRegions=[[CONTIG, 10_400, 10_600]],
                                                             flank=100, acceptPostSelection=True)))
    assert accepted['status'] == 'ok' and accepted['postSelection']['status'] == 'post-selection'
    inter = accepted['result'].get('interaction') or {}
    assert inter.get('p') is None and all(d.get('p_wald') is None for d in inter.get('differences') or [])
    clean = run(world.state, _defn('M1', a, b, group=dict(kind='cluster', labels=labels, clusterRegions=[[CONTIG, 150_000, 150_500]], flank=100)))
    assert clean['postSelection']['status'] == 'ok'


def test_sv_carried_by_every_molecule_says_no_contrast(world, monkeypatch):
    """A = an SV (carriage from the SV split); every informative molecule carries it: a limit, not an effect."""
    import services.sv_endpoint as sv
    qnames = [r[0] for r in world.reads[:30]]
    monkeypatch.setattr(sv, 'sv_split_payload', lambda state, **kw: dict(
        assignments={q: (0 if i % 7 else 2) for i, q in enumerate(qnames)}))
    from services.hub.assoc import run
    a = dict(kind='inline', typeId='var.sv', label='SVs', hits=[dict(hitId=f'sv:{CONTIG}:I:11000:2300', chrom=CONTIG, start=11000,
             end=11000, anchor=11000, legacyRefs=[dict(kind='sv', datasetId='ds_a')])])
    b = dict(kind='scan', setId=world.sets['fp.class'], typeId='fp.class')
    out = run(world.state, _defn('M1', a, b))
    assert out['inputs']['a']['counts'].get('not_informative', 0) == 5
    assert any('no reference molecules' in s for s in out['limits']), out['limits']


def test_m4_overlap_in_callable_territory(world):
    from fiberhmm.assoc.overlap import HitSet, overlap_enrichment
    from services.hub.assoc import run
    peaks = [dict(hitId=f'peak:{i}', chrom=CONTIG, start=s, end=s + 150, anchor=s + 75) for i, s in
             enumerate([10_420, 11_450, 25_000, 40_430, 41_480, 52_000])]
    out = run(world.state, _defn('M4', dict(kind='scan', setId=world.sets['fp.class'], typeId='fp.class'),
                                 dict(kind='inline', typeId='peaks.peak', label='Peaks', hits=peaks)))
    res = out['result']
    assert set(res) >= {'A->B', 'B->A', 'territory_bp'} and res['territory_bp'] == 60_000
    direct = overlap_enrichment(HitSet.from_rows([dict(chrom=CONTIG, start=10490, end=10510), dict(chrom=CONTIG, start=40490, end=40510)]),
                                HitSet.from_rows([dict(chrom=CONTIG, start=p['start'], end=p['end']) for p in peaks]),
                                [(CONTIG, 0, 60_000)], None, n_relocations=99, seed=3)
    assert res['A->B']['global_p'] == pytest.approx(direct['global_p'])
    assert [r['observed'] for r in res['A->B']['rows']] == [r['observed'] for r in direct['rows']]
    assert out['curve']['A->B']['rows'] and out['inputs']['strata'].startswith('one stratum per contig')


def test_m4_leaves_out_insertion_hits(world):
    from services.hub.assoc import run
    peaks = [dict(hitId='peak:1', chrom=CONTIG, start=10_420, end=10_570, anchor=10_500),
             dict(hitId='peak:ins', chrom='chrT_MATERNAL', start=500, end=600, frame=dict(kind='source'),
                  target=dict(chrom=CONTIG, start=12_000, end=12_000, anchor=12_000, insertion=True)),
             dict(hitId='peak:none', chrom='chrT_MATERNAL', start=900, end=950, frame=dict(kind='source'))]
    out = run(world.state, _defn('M4', dict(kind='scan', setId=world.sets['fp.class'], typeId='fp.class'),
                                 dict(kind='inline', typeId='peaks.peak', label='Peaks', hits=peaks)))
    b = out['inputs']['b']
    assert b['hits'] == 1 and b['counts']['unplaced'] == 1 and b['counts']['in_insertion'] == 1
    assert any('inside an insertion' in n for n in b['notes'])


def test_m3_rate_equals_fiberhmm_scan_assoc(tmp_path):
    from fiberhmm.assoc.cli import run as cli_run
    from services.hub.assoc import run
    rng = random.Random(5)
    reads, marks = [], []
    for i in range(40):
        q = f'm64002_{i:03d}/{2000 + i}/ccs'
        s0 = 2000 + 45_000 * (i % 4) + 50 * i       # four 50 kb bootstrap blocks
        reads.append((q, s0, 4000, 1 + i % 2))
        marks.append(('nucseg', q, s0, s0 + 1500, '1'))          # regular
        marks.append(('nucseg', q, s0 + 1500, s0 + 3500, '2'))   # disordered
        marks.append(('nucseg', q, s0 + 3500, s0 + 4000, '3'))   # low information
        for _k in range(rng.randint(2, 6)):
            c = s0 + rng.randint(0, 3400)
            marks.append(('nucsz', q, c - 10, c + 10, '17'))      # TF bit (16) set
    bam = _bam(tmp_path / 'n.bam', reads)
    scan = _scan(tmp_path / 'nscan', bam, fp_hits=[], nfr_hits=[], states=[], openness=[], marks=marks)
    st = _state(_dataset('ds_n', bam, 'Sample N'))
    from services.scan import registry
    registry.open_scan(st, scan)
    out = run(st, _defn('M3', dict(kind='marks', typeId='nuc.seg.regular', label='Regular arrays'), dict(kind='tf'),
                        scope=dict(kind='view', chrom=CONTIG, start=0, end=LENGTH)))
    cli = cli_run(Namespace(scan_dir=str(scan), mode='rate', a='nuc.seg.regular', b='tf', region=[f'{CONTIG}:0-{LENGTH}'],
                            group=None, haplotype_tag='HP', labels=None, group_label=None, density='rho_read', max_distance=5000,
                            test='adjusted', strata=None, n_perm=99, n_boot=50, seed=3, response=None, bed=None))
    res = out['result']
    assert res['n_molecules'] == cli['n_molecules'] == 40
    assert res['rate_ratio'] == pytest.approx(cli['rate_ratio'], rel=1e-12)
    assert res['p_shift'] == pytest.approx(cli['p_shift'])
    assert res['rate_ratio_lo'] == pytest.approx(cli['rate_ratio_lo'], rel=1e-12)
    grouped = run(st, _defn('M3', dict(kind='marks', typeId='nuc.seg.regular'), dict(kind='tf'), group=dict(kind='haplotype'),
                            scope=dict(kind='view', chrom=CONTIG, start=0, end=LENGTH)))
    assert set(grouped['result']['groups']) == {'HP1', 'HP2'} and 'interaction' in grouped['result']
    assert [e['key'] for e in grouped['effects']][:3] == ['all', 'group:HP1', 'group:HP2']


def test_requests_are_validated():
    from services.hub.assoc import normalize_request
    from services.hub.assoc_inputs import AssocInputError
    with pytest.raises(AssocInputError):
        normalize_request(dict(mode='M9', a={}))
    with pytest.raises(AssocInputError, match='feature B'):
        normalize_request(dict(mode='M1', a=dict(kind='scan', setId='x')))
    with pytest.raises(AssocInputError, match='response'):
        normalize_request(dict(mode='M2', a=dict(kind='scan', setId='x')))
    d = normalize_request(dict(mode='M3', a=dict(kind='marks', typeId='nuc.seg.regular'), options=dict(nPerm=5, test='x')))
    assert d['b'] == {'kind': 'tf'} and d['options']['nPerm'] == 20 and d['options']['test'] == 'adjusted'


def test_jobs_run_cancel_and_dispose(world):
    import threading
    from services.hub import assoc
    gate = threading.Event()
    out = assoc.submit(world.state, dict(mode='M4', a=dict(kind='anchors', anchors=[dict(chrom=CONTIG, pos=100)]),
                                         b=dict(kind='anchors', anchors=[dict(chrom=CONTIG, pos=200)]),
                                         scope=dict(kind='view', chrom=CONTIG, start=0, end=1000)),
                       runner=lambda state, defn, progress, cancel: (gate.wait(5), progress('compute', 'x'), {'status': 'ok'})[-1])
    with pytest.raises(assoc.AssocInputError, match='already running'):
        assoc.submit(world.state, dict(mode='M4', a=dict(kind='anchors', anchors=[]), b=dict(kind='anchors', anchors=[])))
    assoc.cancel(world.state, out['job_id'])
    gate.set()
    done = assoc.wait(world.state, out['job_id'], timeout=10)
    assert done['status'] == 'cancelled' and 'result' not in done
    ok = assoc.submit(world.state, dict(mode='M4', a=dict(kind='anchors', anchors=[]), b=dict(kind='anchors', anchors=[]),
                                        scope=dict(kind='view', chrom=CONTIG, start=0, end=10)),
                      runner=lambda state, defn, progress, cancel: {'status': 'ok', 'x': 1})
    assert assoc.wait(world.state, ok['job_id'], timeout=10)['result'] == {'status': 'ok', 'x': 1}
    gate2 = threading.Event()
    third = assoc.submit(world.state, dict(mode='M4', a=dict(kind='anchors', anchors=[]), b=dict(kind='anchors', anchors=[])),
                         runner=lambda state, defn, progress, cancel: (gate2.wait(5), progress('compute', 'y'), {'status': 'ok'})[-1])
    from services.scan.jobs import dispose_session
    dispose_session(world.state)
    gate2.set()
    assert assoc.wait(world.state, third['job_id'], timeout=10)['status'] == 'cancelled'
    assert [j['job_id'] for j in assoc.list_jobs(world.state)][-1] == third['job_id']


def test_haplotype_of_a_molecule_folds_its_records():
    """D14: a molecule is phased only when every record carries the same HP tag."""
    from services.hub.assoc_inputs import Molecules
    m = Molecules()
    a, b, c, d = (m.add('ds', f't{i}', f'q{i}') for i in range(4))
    m.note_hap(a, 'HP1'); m.note_hap(a, 'HP1')
    m.note_hap(b, 'HP1'); m.note_hap(b, None)
    m.note_hap(c, 'HP1'); m.note_hap(c, 'HP2')
    assert [m.hap_of(i) for i in (a, b, c, d)] == ['HP1', None, None, None]


def test_cluster_contrast_without_recorded_regions_is_refused(world):
    from services.hub.assoc import run
    labels = {'ds_a': {q: ('C0' if i % 3 else 'C1') for i, (q, *_r) in enumerate(world.reads)}}
    a = dict(kind='scan', setId=world.sets['fp.class'], typeId='fp.class')
    b = dict(kind='scan', setId=world.sets['nfr.region'], typeId='nfr.region')
    out = run(world.state, _defn('M1', a, b, group=dict(kind='cluster', labels=labels, clusterRegions=[], flank=100)))
    assert out['status'] == 'refused' and 'records no regions' in out['postSelection']['note']
    whole = run(world.state, _defn('M1', a, b, scope=dict(kind='scan'),
                                   group=dict(kind='cluster', labels=labels, clusterRegions=[[CONTIG, 40_400, 40_600]], flank=100)))
    assert whole['status'] == 'refused'          # a whole-scan scope is checked against the hits' own windows


def test_phasing_needs_a_transferable_anchor_state(world):
    from services.hub.assoc import run
    from services.hub.assoc_inputs import AssocInputError
    with pytest.raises(AssocInputError, match='random'):
        run(world.state, _defn('M2', dict(kind='scan', setId=world.sets['fp.class'], typeId='fp.class'), response=dict(kind='phasing')))


def test_scalar_response_folds_records_per_molecule(tmp_path, monkeypatch):
    """M2 with a scan measure: a molecule's records that agree count once, records that disagree drop out."""
    reads = [(f'm64003_{i:03d}/{3000 + i}/ccs', 10_000, 3000, 0) for i in range(24)]
    bam = _bam(tmp_path / 'f.bam', reads)
    fp_hits = [('fp:class:chrT:10500:cccc0001', 10490, 10510)]
    states = [(fp_hits[0][0], 10490, 10510, q, '1' if i % 2 else '0', 'pooled') for i, (q, *_r) in enumerate(reads)]
    states.append((fp_hits[0][0], 10490, 10510, reads[0][0], '1', 'pooled'))     # a second record of molecule 0, disagreeing
    states.append((fp_hits[0][0], 10490, 10510, reads[1][0], '1', 'pooled'))     # a second record of molecule 1, agreeing
    scan = _scan(tmp_path / 'fscan', bam, fp_hits=fp_hits, nfr_hits=[], states=states,
                 openness=[(q, 9_800, 0.1 * (i % 7)) for i, (q, *_r) in enumerate(reads)])
    # the two extra rows reuse record ids: make them distinct records
    st = _state(_dataset('ds_f', bam, 'Sample F'))
    from services.scan import registry
    opened = registry.open_scan(st, scan)
    set_id = {s['typeId']: s['setId'] for s in opened.sets(st)}['fp.class']
    seen = {}
    import fiberhmm.assoc.condition as C
    real = C.condition

    def spy(app, loci, metric, **kw):
        seen['pairs'] = list(zip(app.locus.tolist(), app.molecule.tolist(), app.state.tolist()))
        return real(app, loci, metric, **kw)
    monkeypatch.setattr(C, 'condition', spy)
    from services.hub.assoc import run
    out = run(st, _defn('M2', dict(kind='scan', setId=set_id, typeId='fp.class'), response=dict(kind='scalar', module='nfr', column='openness'),
                        scope=dict(kind='view', chrom=CONTIG, start=0, end=60_000)))
    assert out['status'] == 'ok'
    keys = [(l, m) for l, m, _s in seen['pairs']]
    assert len(keys) == len(set(keys)) == 23        # 24 molecules, one dropped (its records disagree), none twice


def test_m3_every_bound_dataset_has_its_molecules(tmp_path):
    from services.hub.assoc import run
    reads, marks = [], []
    for i in range(12):
        q = f'm64004_{i:03d}/{4000 + i}/ccs'
        s0 = 2000 + 45_000 * (i % 4) + 50 * i
        reads.append((q, s0, 4000, 0))
        marks += [('nucseg', q, s0, s0 + 2000, '1'), ('nucseg', q, s0 + 2000, s0 + 4000, '2'), ('nucsz', q, s0 + 500, s0 + 520, '17'),
                  ('nucsz', q, s0 + 2500, s0 + 2520, '17')]
    bam = _bam(tmp_path / 'b.bam', reads)
    scan = _scan(tmp_path / 'bscan', bam, fp_hits=[], nfr_hits=[], states=[], openness=[], marks=marks)
    st = _state(_dataset('ds_1', bam, 'One'), _dataset('ds_2', bam, 'Two'))       # one BAM opened twice
    from services.scan import registry
    registry.open_scan(st, scan)
    out = run(st, _defn('M3', dict(kind='marks', typeId='nuc.seg.regular'), dict(kind='tf'), group=dict(kind='dataset'),
                        scope=dict(kind='view', chrom=CONTIG, start=0, end=LENGTH)))
    assert out['inputs']['molecules'] == 24
    assert set(out['result']['groups']) == {'One', 'Two'}
