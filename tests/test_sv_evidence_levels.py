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
    strict = sv_endpoint.sv_split_payload(None, **kwargs, include_putative=False)
    inclusive = sv_endpoint.sv_split_payload(None, **kwargs)
    assert strict['counts'] == [1, 0, 1]
    assert inclusive['counts'] == [2, 0, 0]
    assert strict['evidence_counts'] == inclusive['evidence_counts'] == dict(confirmed=1, putative=1, conflicting=0, ambiguous=0)


def test_summary_indexes_junctions_without_a_display_sized_clip():
    seed = _seg([(0, 100), (2, 1000), (0, 5)], start=0)
    seed.query_name = 'seed'
    junction = _seg([(0, 100), (5, 5)], start=0, sa='chrT,1101,+,100H5M,60,0;')
    junction.query_name = 'junction'
    rows = [_compact_record(r, 'chrT', 10) for r in (seed, junction)]
    c = sv_summary_for_reads(rows, 0, 1200, 50, chrom='chrT')['clusters'][0]
    assert c['support'] == 2 and c['sa_support'] == 1


def test_unrelated_cigar_deletion_does_not_make_a_clip_ambiguous():
    read = dict(id='molecule', sv=[dict(t='S', side='R', ref=1000, len=100, q=0),
                                    dict(t='D', ref=5000, len=1000, q=100)])
    targets = [dict(t='D', ref=ref, len=1000) for ref in (1000, 5000)]
    allele, evidence = classify_allele_evidence(read, 'D', 1000, 1000, targets=targets)
    assert allele == 2 and evidence['level'] == 'putative'


@pytest.mark.parametrize('op,size,reference', [(2, 1, True), (2, 9, True), (2, 10, True),
                                               (2, 11, False), (2, 500, False), (3, 1, False), (1, 9, True)])
def test_reference_flanks_tolerate_small_indels_but_not_large_deletions_or_skips(op, size, reference):
    read = _compact_record(_seg([(0, 1000), (op, size), (0, 1000)], start=0), 'chrT', 10)
    assert (classify_allele_evidence(read, 'I', 1000, 100)[0] == 1) is reference
    assert len(read['aligned_blocks']) == (1 if reference else 2)


def test_opposite_terminal_clip_does_not_compete_with_the_matching_clip():
    read = dict(id='double-clipped', sv=[dict(t='S', side='L', ref=750, len=100, q=0),
                                        dict(t='S', side='R', ref=1000, len=100, q=350)])
    targets = [dict(t='I', ref=p, len=100) for p in (750, 1000)]
    allele, ev = classify_allele_evidence(read, 'I', 1000, 100, targets=targets, include_putative=True)
    assert allele == 0 and ev['level'] == 'putative'
    # The same clip can compete across event types too.
    targets.append(dict(t='D', ref=1000, len=200))
    assert classify_allele_evidence(read, 'I', 1000, 100, targets=targets)[1]['level'] == 'ambiguous'


def test_equivalent_anchors_retain_clips_and_reconcile_other_alleles_before_reference(tmp_path):
    from test_sv_alleles import fasta_file
    ref = 'C' * 1000 + 'A' * 1000 + 'G' * 1000
    fasta = fasta_file(tmp_path, ref)
    seed = _seg([(0, 1500), (1, 50), (0, 1500)], start=0, seq=ref[:1500] + 'A' * 50 + ref[1500:])
    seed.query_name = 'seed'
    clip = _seg([(0, 300), (4, 50)], start=1200, seq=ref[1200:1500] + 'A' * 50)
    clip.query_name = 'clip'
    rows = [_compact_record(r, 'chrT', 10, reference=fasta) for r in (seed, clip)]
    summary = sv_summary_for_reads(rows, 0, 3000, 50)
    c, = summary['clusters']
    assert (c['confirmed'], c['putative'], c['informative']) == (1, 1, 1)
    calls = classify_molecules([(r, None) for r in rows], t='I', ref=1000, length=50)
    assert calls['clip']['evidence']['level'] == 'putative' and calls['clip']['allele'] == 0
    # A different allele anywhere in the equivalent interval excludes reference.
    other = dict(id='other', reference_start=0, reference_end=3000, aligned_blocks=[[0, 3000]],
                 sv=[dict(t='I', ref=1700, len=200, q=1700)])
    allele, evidence = classify_allele_evidence(other, 'I', 1000, 50, uncertainty=[1000, 2000])
    assert allele == 2 and evidence['kind'] == 'other'
    # A raw, noncanonical CIGAR placement is reconciled through the interval.
    other['sv'][0]['len'] = 50
    assert classify_allele_evidence(other, 'I', 1000, 50, uncertainty=[1000, 2000])[1]['level'] == 'confirmed'


def test_ambiguous_split_carriers_require_an_explicit_opt_in(monkeypatch):
    from services import sv_endpoint
    records = [dict(id=f'seed-{n}', reference_start=0, reference_end=3000,
                    sv=[dict(t='I', ref=1000, len=n, q=1000)]) for n in (100, 300)]
    records.append(dict(id='clip', reference_start=0, reference_end=1000,
                        sv=[dict(t='S', side='R', ref=1000, len=100, q=1000)]))
    monkeypatch.setattr(sv_endpoint, 'scan_view', lambda *_: records)
    kwargs = dict(dataset_id='synthetic', chrom='chrT', start=0, end=3000, t='I', ref=1000, length=100)
    default = sv_endpoint.sv_split_payload(None, **kwargs)
    inclusive = sv_endpoint.sv_split_payload(None, **kwargs, include_ambiguous=True)
    assert default['assignments']['clip'] == 2 and inclusive['assignments']['clip'] == 0
    assert default['evidence_counts'] == inclusive['evidence_counts'] == dict(confirmed=1, putative=0, conflicting=0, ambiguous=1)


def test_summary_indexes_the_observed_alleles_equivalent_interval_too():
    rows = [dict(id='target', reference_start=1500, reference_end=3000,
                 sv=[dict(t='D', ref=2000, len=100, q=500, ref_len=100, alt_len=0,
                          uncertainty=[2000, 2000])]),
            dict(id='equivalent', reference_start=900, reference_end=1200,
                 sv=[dict(t='D', ref=1000, len=100, q=100, ref_len=100, alt_len=0,
                          uncertainty=[1000, 3000])])]
    summary = sv_summary_for_reads(rows, 0, 5000, 50)
    target = next(c for c in summary['clusters'] if c['ref'] == 2000)
    assert target['confirmed'] == 2
