"""Synthetic cross-language contract for clip evidence that aligns elsewhere."""
import copy
import json
from pathlib import Path

import pytest

from services.sv_conflicts import clip_conflict, normalize_conflict_options
from services.sv_events import classify_allele_evidence, classify_molecules, sv_summary_for_reads
from services.sv_endpoint import _compact_record
from test_sv_events import _seg

FIXTURE = json.loads((Path(__file__).parent / 'data/sv_conflicts.json').read_text())
REGRESSIONS = json.loads((Path(__file__).parent / 'data/sv_conflict_regressions.json').read_text())


@pytest.mark.parametrize('case', REGRESSIONS, ids=lambda c: c['name'])
def test_cigar_conflict_regressions(case):
    import pysam
    header = pysam.AlignmentHeader.from_dict({'SQ': [{'SN': 'chrT', 'LN': 1000000}]})
    rows = []
    for spec in case['records']:
        rec = pysam.AlignedSegment(header)
        rec.query_name = 'synthetic'
        rec.reference_id = 0
        rec.reference_start = spec['start']
        rec.mapping_quality = 60
        rec.flag = (16 if spec['reverse'] else 0) | (2048 if spec['supp'] else 0)
        rec.cigarstring = spec['cigar']
        rec.query_sequence = 'A' * rec.infer_query_length()
        if spec['sa']:
            rec.set_tag('SA', spec['sa'])
        rows.append(_compact_record(rec, 'chrT', 10))
    c = case['target']
    kwargs = dict(t=c['t'], ref=c['ref'], length=c['len'], chrom='chrT',
                  target_end=c.get('end', c['ref'] + c.get('ref_len', c['len'] if c['t'] == 'D' else 0)),
                  uncertainty=c.get('uncertainty'))
    for inputs in (rows, list(reversed(rows)), case['reads']):
        call = classify_molecules([(r, None) for r in inputs], **kwargs)['synthetic']
        assert call['evidence']['level'] == case['expected']
        levels = [(x['evidence'] or {}).get('level') for x in call['evidence_bundle']]
        assert sorted(levels, key=str) == sorted(case['levels'], key=str)
        if 'overlap' in case:
            assert call['evidence']['reason']['overlap'] == case['overlap']
    # The serialized frontend fixture must describe the extracted CIGAR geometry.
    for actual, expected in zip(rows, case['reads']):
        assert actual['sv_segments'] == expected['sv_segments']
        assert actual['sv'] == expected['sv']


@pytest.mark.parametrize('case', FIXTURE['cases'], ids=lambda c: c['name'])
def test_shared_signals_and_thresholds(case):
    read = case['read']
    options = case.get('options')
    allele, evidence = classify_allele_evidence(read, 'I', 1000, 100, chrom='chrT',
                                               include_putative=True, conflict_options=options)
    assert evidence['level'] == case['expected']
    assert allele == (2 if case['expected'] == 'conflicting' else 0)
    if case['expected'] == 'conflicting':
        reason = evidence['reason']
        assert reason['code'] == 'clip_elsewhere'
        assert reason['overlap'] >= normalize_conflict_options(options)['min_overlap']
        assert 'Supporting clip aligns elsewhere' in reason['message']
        assert classify_allele_evidence(read, 'I', 1000, 100, chrom='chrT', include_conflicting=True,
                                        conflict_options=options)[0] == 0


def test_conflict_precedes_competition_but_never_overrides_confirmation():
    read = copy.deepcopy(FIXTURE['cases'][0]['read'])
    targets = [dict(t='I', ref=1000, len=100), dict(t='I', ref=1000, len=300)]
    evidence = classify_allele_evidence(read, 'I', 1000, 100, targets=targets)[1]
    assert evidence['level'] == 'conflicting'
    read['sv'].append(dict(t='I', ref=1000, len=100, q=900))
    assert classify_allele_evidence(read, 'I', 1000, 100, targets=targets)[1]['level'] == 'confirmed'


@pytest.mark.parametrize('reverse', [False, True])
@pytest.mark.parametrize('hard', [False, True])
def test_real_cigar_and_sa_extraction_use_full_query_geometry(reverse, hard):
    rec = _seg([(0, 1000), (5 if hard else 4, 800)], start=0, reverse=reverse,
               sa=f'chrElsewhere,5001,{"-" if reverse else "+"},1000H800M,60,0;')
    read = _compact_record(rec, 'chrT', 10)
    allele, evidence = classify_allele_evidence(read, 'I', 1000, 100, include_putative=True)
    assert allele == 2 and evidence['level'] == 'conflicting'
    assert evidence['reason']['overlap'] == 800


def test_molecule_reduction_and_summary_count_all_four_tiers_once(monkeypatch):
    from services import sv_endpoint
    conflict = FIXTURE['cases'][0]['read']
    seed = dict(id='seed', reference_start=0, reference_end=3000,
                sv=[dict(t='I', ref=1000, len=100, q=1000)])
    clean = {**conflict, 'id': 'clean', 'sv_segments': conflict['sv_segments'][:1]}
    rows = [seed, clean, conflict, conflict]
    c, = sv_summary_for_reads(rows, 0, 3000, 50, chrom='chrT')['clusters']
    assert (c['confirmed'], c['putative'], c['conflicting'], c['ambiguous'], c['informative']) == (1, 1, 1, 0, 1)
    monkeypatch.setattr(sv_endpoint, 'scan_view', lambda *_: rows)
    kwargs = dict(dataset_id='synthetic', chrom='chrT', start=0, end=3000, t='I', ref=1000, length=100)
    default = sv_endpoint.sv_split_payload(None, **kwargs)
    assert default['counts'] == [2, 0, 1]
    assert default['evidence_counts'] == dict(confirmed=1, putative=1, conflicting=1, ambiguous=0)
    assert default['evidence_reasons']['synthetic']['code'] == 'clip_elsewhere'
    assert sv_endpoint.sv_split_payload(None, **kwargs, include_conflicting=True)['counts'] == [3, 0, 0]
    assert sv_endpoint.sv_split_payload(None, **kwargs, conflict_options={'enabled': False})['counts'] == [3, 0, 0]
    # A fetched confirming record remains authoritative on either input order.
    for entries in ([(seed, None), ({**conflict, 'id': 'seed'}, None)],
                    [({**conflict, 'id': 'seed'}, None), (seed, None)]):
        assert classify_molecules(entries, t='I', ref=1000, length=100)['seed']['evidence']['level'] == 'confirmed'


def test_deletion_clips_use_the_same_conflict_rule():
    read = FIXTURE['cases'][0]['read']
    allele, evidence = classify_allele_evidence(read, 'D', 1000, 500, include_putative=True)
    assert allele == 2 and evidence['level'] == 'conflicting'


def test_lens_retains_conflicting_rows_and_reasons(monkeypatch):
    from services import insertion_lens
    rec = _seg([(0, 1000), (4, 800)], start=0, sa='chrElsewhere,5001,+,1000H800M,60,0;')
    monkeypatch.setattr(insertion_lens, '_site_records', lambda *a, **kw: iter([(rec, 'chrT', 'synthetic.bam', None)]))
    kwargs = dict(pos=1000, ref=1000, length=100, bam_handle_getter=lambda _: None)
    site = insertion_lens.classify_site([], 'chrT', **kwargs)
    plan = site['carriers'][0][0]
    assert plan['evidence_level'] == 'conflicting'
    assert plan['evidence_reason']['overlap'] == 800
    legacy = insertion_lens.classify_site([], 'chrT', **kwargs, conflict_options={'enabled': False})
    assert legacy['carriers'][0][0]['evidence_level'] == 'putative'
    lens = insertion_lens.build_lens([], 'chrT', **kwargs, consensus=False, loader=lambda *a, **kw: [])
    assert lens['cluster']['conflicting'] == 1 and lens['cluster']['putative'] == 0
    assert lens['carriers'][0]['evidence_reason'] == plan['evidence_reason']
    legacy_lens = insertion_lens.build_lens([], 'chrT', **kwargs, consensus=False,
                                           loader=lambda *a, **kw: [], conflict_options={'enabled': False})
    assert legacy_lens['cluster']['putative'] == 1 and legacy_lens['cluster']['conflicting'] == 0


def test_invalid_thresholds_are_bounded_and_fall_back():
    assert normalize_conflict_options('{') == normalize_conflict_options()
    assert normalize_conflict_options({'min_mapq': float('nan')})['min_mapq'] == 20
    assert normalize_conflict_options({'max_distance': -1, 'min_clip_fraction': 2}) == {
        **normalize_conflict_options(), 'max_distance': 0, 'min_clip_fraction': 1}
