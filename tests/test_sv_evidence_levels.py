"""Evidence certainty is per molecule and target, independently of drawing thresholds."""
import pytest
from services.sv_events import (alignment_evidence, carrier_evidence, classify_allele_evidence,
                                classify_molecules, extract_sv_events, sv_summary_for_reads)
from services.sv_endpoint import _compact_record
from test_sv_events import _seg


def test_multi_allelic_clips_are_ambiguous_and_never_enter_a_putative_split():
    targets = [dict(t='I', ref=1000, len=n) for n in (100, 300)]
    clip = dict(id='clip', reference_start=0, reference_end=1000,
                sv=[dict(t='S', side='R', ref=1000, len=100, q=1000)])
    for target in targets:
        allele, ev = classify_allele_evidence(clip, target['t'], target['ref'], target['len'],
                                             targets=targets, include_putative=True)
        assert allele == 2 and ev['level'] == 'ambiguous'
        assert len(ev['targets']) == 2
    assert classify_allele_evidence(clip, 'I', 1000, 100)[1]['level'] == 'putative'
    assert classify_allele_evidence(clip, 'I', 1000, 100, include_putative=True)[0] == 0


@pytest.mark.parametrize('reverse', [False, True])
@pytest.mark.parametrize('mapq,sa_cigar,confirmed', [
    (60, '1000S500M', True), (0, '1000S500M', False),
    (60, '500M1000S', False), (60, '900S600M', False),
])
def test_deletion_junction_requires_mapq_and_nonoverlapping_query_intervals(reverse, mapq, sa_cigar, confirmed):
    strand = '-' if reverse else '+'
    rec = _seg([(0, 1000), (4, 500)], start=0, reverse=reverse,
               sa=f'chrT,2001,{strand},{sa_cigar},{mapq},0;')
    read = _compact_record(rec, 'chrT', 10)
    allele, ev = classify_allele_evidence(read, 'D', 1000, 1000, chrom='chrT')
    assert (allele == 0) is confirmed
    assert ev['level'] == ('confirmed' if confirmed else 'putative')


@pytest.mark.parametrize('reverse', [False, True])
def test_inversion_junction_never_confirms_a_deletion(reverse):
    rec = _seg([(0, 1000), (4, 500)], start=0, reverse=reverse,
               sa=f'chrT,2001,{"+" if reverse else "-"},1000S500M,60,0;')
    assert classify_allele_evidence(_compact_record(rec, 'chrT', 10), 'D', 1000, 1000)[0] == 2


@pytest.mark.parametrize('reverse', [False, True])
def test_insertion_junction_can_confirm_only_when_query_gap_sequence_is_available(reverse):
    strand = '-' if reverse else '+'
    for cigar, wanted in [([(0, 100), (4, 150)], 'confirmed'),
                           ([(0, 100), (4, 50), (5, 100)], 'putative'),
                           ([(0, 100), (5, 150)], 'putative')]:
        rec = _seg(cigar, start=900, reverse=reverse, sa=f'chrT,1001,{strand},200H50M,60,0;')
        ev = carrier_evidence(_compact_record(rec, 'chrT', 10), 'I', 1000, 100, 'chrT')
        assert ev['level'] == wanted


def test_insertion_inside_a_deletion_is_not_reference_with_or_without_blocks():
    rec = _seg([(0, 1000), (2, 3000), (0, 1000)], start=0)
    read = _compact_record(rec, 'chrT', 10)
    assert classify_allele_evidence(read, 'I', 2000, 100)[0] == 2
    read.pop('aligned_blocks')
    assert classify_allele_evidence(read, 'I', 2000, 100)[0] == 2
    normal = _compact_record(_seg([(0, 5000)], start=0), 'chrT', 10)
    assert classify_allele_evidence(normal, 'I', 2000, 100)[0] == 1


def test_all_molecule_records_and_evidence_are_retained_independent_of_file_order():
    a = _compact_record(_seg([(0, 100), (1, 100), (0, 500)], start=900), 'chrT', 10)
    b = {**a, 'sv': [dict(t='S', ref=1000, len=100, side='R', q=100)], 'reference_end': 1000}
    for entries in [[(a, 'sequence'), (b, 'clip')], [(b, 'clip'), (a, 'sequence')]]:
        calls = classify_molecules(entries, t='I', ref=1000, length=100)
        assert len(calls) == 1
        call = next(iter(calls.values()))
        assert call['record'] == 'sequence' and call['evidence']['level'] == 'confirmed'
        assert len(call['evidence_bundle']) == 2
        assert {entry['record'] for entry in call['evidence_bundle']} == {'sequence', 'clip'}


def test_summary_keeps_confirmed_putative_ambiguous_and_reference_separate():
    rows = [dict(id='seed', reference_start=0, reference_end=3000,
                 sv=[dict(t='I', ref=1000, len=100, q=1000)]),
            dict(id='clip', reference_start=0, reference_end=1000,
                 sv=[dict(t='S', ref=1000, len=100, q=1000, side='R')])]
    c = sv_summary_for_reads(rows, 0, 3000, 50)['clusters'][0]
    assert (c['support'], c['confirmed'], c['putative'], c['ambiguous'], c['informative']) == (1, 1, 1, 0, 1)
    rows.append(dict(id='other', reference_start=0, reference_end=3000,
                     sv=[dict(t='I', ref=1000, len=300, q=1000)]))
    assert all(c['ambiguous'] == 1 and c['putative'] == 0 for c in sv_summary_for_reads(rows, 0, 3000, 50)['clusters'])


def test_split_offers_confirmed_only_or_including_putative_with_separate_counts(monkeypatch):
    from services import sv_endpoint
    records = [_compact_record(_seg([(0, 100), (1, 100), (0, 500)], start=900), 'chrT', 10),
               {**_compact_record(_seg([(0, 100), (4, 100)], start=900), 'chrT', 10), 'id': 'clip'}]
    monkeypatch.setattr(sv_endpoint, 'scan_view', lambda *_: records)
    kwargs = dict(dataset_id='synthetic', chrom='chrT', start=0, end=3000, t='I', ref=1000, length=100)
    strict = sv_endpoint.sv_split_payload(None, **kwargs)
    inclusive = sv_endpoint.sv_split_payload(None, **kwargs, include_putative=True)
    assert strict['counts'] == [1, 0, 1]
    assert inclusive['counts'] == [2, 0, 0]
    assert strict['evidence_counts'] == inclusive['evidence_counts'] == dict(confirmed=1, putative=1, ambiguous=0)
