"""Exact CIGAR replacement spans, raw geometry and canonical repeat alleles."""
import pysam
import pytest

from services.sv_events import deletion_spans, extract_sv_events, sv_summary_for_reads
from services.sv_endpoint import _compact_record
from services.compact_read_loader import build_compact_reads_from_bam
from services.insertion_lens import _carrier_plan, splice_read
from services.alt_allele_align import AltLayout, realign, D
from test_sv_events import _seg


def fasta_file(tmp_path, seq):
    path = str(tmp_path / 'reference.fa')
    with open(path, 'w') as handle:
        handle.write('>chrT\n' + seq + '\n')
    pysam.faidx(path)
    return pysam.FastaFile(path)


def haplotype(ref, event):
    return ref[:event['ref']] + event['alt_seq'] + ref[event['ref_end']:]


def test_i_m_i_keeps_inserted_bases_separate_from_the_replaced_reference(tmp_path):
    ref = 'C' * 100 + 'G' * 10 + 'C' * 100
    seq = 'C' * 100 + 'A' * 50 + 'G' * 10 + 'T' * 50 + 'C' * 100
    read = _seg([(0, 100), (1, 50), (0, 10), (1, 50), (0, 100)], start=0, seq=seq)
    event, = extract_sv_events(read, 50, include_seq=True, reference=fasta_file(tmp_path, ref))
    assert (event['len'], event['ref_len'], event['alt_len'], event['inserted_len']) == (100, 10, 110, 100)
    assert event['seq'] == 'A' * 50 + 'T' * 50
    assert [p['t'] for p in event['raw_pieces']] == ['I', 'M', 'I']
    assert haplotype(ref, event) == seq
    plan = _carrier_plan(read, dict(kind='cigar', event=event), event['len'])
    assert (plan['len'], plan['allele_len'], plan['ref_end']) == (110, 100, 110)
    assert splice_read(read, dict(q=plan['q'], len=plan['len'])).cigarstring == '310M'


def test_d_m_d_keeps_the_matched_bridge_and_thresholds_count_deleted_bases(tmp_path):
    ref = 'C' * 100 + 'A' * 20 + 'G' * 10 + 'T' * 20 + 'C' * 100
    seq = 'C' * 100 + 'G' * 10 + 'C' * 100
    read = _seg([(0, 100), (2, 20), (0, 10), (2, 20), (0, 100)], start=0, seq=seq)
    event, = extract_sv_events(read, 40, include_seq=True, reference=fasta_file(tmp_path, ref))
    assert (event['len'], event['ref_len'], event['alt_len'], event['deleted_len']) == (40, 50, 10, 40)
    assert deletion_spans([event]) == [(100, 120), (130, 150)]
    assert haplotype(ref, event) == seq
    assert extract_sv_events(read, 41) is None
    summary = sv_summary_for_reads([_compact_record(read, 'chrT', 10)], 0, 300, 40)
    assert summary['clusters'][0]['end'] == 150


@pytest.mark.parametrize('extra', [[], [(2, 20), (0, 100)]])
def test_exact_replacement_extraction_is_monotonic(extra):
    read = _seg([(0, 100), (2, 20), (0, 10), (2, 20), (0, 100)] + extra, start=0)
    for cutoff in range(10, 61):
        targets = [e for e in extract_sv_events(read, cutoff) or [] if e['t'] == 'D' and e['ref'] == 100]
        assert bool(targets) == (cutoff <= 40)


@pytest.mark.parametrize('kind', ['I', 'D'])
def test_homopolymer_indels_normalize_with_raw_anchors_and_haplotype_equivalence(tmp_path, kind):
    ref = 'C' + 'A' * 100 + 'G'
    fasta = fasta_file(tmp_path, ref)
    rows = []
    for i, anchor in enumerate([20, 50]):
        cigar = [(0, anchor), (1 if kind == 'I' else 2, 10), (0, len(ref) - anchor - (10 if kind == 'D' else 0))]
        seq = ref[:anchor] + ('A' * 10 if kind == 'I' else '') + ref[anchor + (10 if kind == 'D' else 0):]
        rec = _seg(cigar, start=0, seq=seq)
        rec.query_name = f'molecule-{i}'
        event, = extract_sv_events(rec, 10, reference=fasta)
        assert event['ref'] == 1 and event['raw_ref'] == anchor and event['q'] == anchor
        assert event['uncertainty'] == [1, 101 if kind == 'I' else 91]
        assert haplotype(ref, event) == seq
        assert deletion_spans([event]) == ([(anchor, anchor + 10)] if kind == 'D' else [])
        rows.append(_compact_record(rec, 'chrT', 10, reference=fasta))
    clusters = sv_summary_for_reads(rows, 0, len(ref), 10)['clusters']
    assert len(clusters) == 1 and clusters[0]['support'] == 2


def test_tandem_repeat_rotations_have_one_canonical_allele(tmp_path):
    ref = 'C' + 'AT' * 50 + 'G'
    fasta = fasta_file(tmp_path, ref)
    for anchor in [21, 50]:
        insert = ref[anchor:anchor + 2] * 10
        seq = ref[:anchor] + insert + ref[anchor:]
        rec = _seg([(0, anchor), (1, 20), (0, len(ref) - anchor)], start=0, seq=seq)
        event, = extract_sv_events(rec, 10, reference=fasta)
        assert event['ref'] == 1 and event['alt_seq'] == 'AT' * 10
        assert event['raw_ref'] == anchor and haplotype(ref, event) == seq


def test_public_compact_loader_normalizes_without_moving_query_or_deletion_cuts(tmp_path):
    ref = 'C' + 'A' * 100 + 'G'
    fasta = fasta_file(tmp_path, ref)
    rec = _seg([(0, 50), (1, 10), (0, 52)], start=0, seq=ref[:50] + 'A' * 10 + ref[50:])
    path = str(tmp_path / 'molecule.bam')
    with pysam.AlignmentFile(path, 'wb', header=rec.header) as bam:
        bam.write(rec)
    pysam.index(path)
    rows = build_compact_reads_from_bam(path, 'chrT', 0, 102, spanning_only=False, sv_reference=fasta.filename.decode())
    event, = rows[0]['sv']
    assert (event['ref'], event['raw_ref'], event['q']) == (1, 50, 50)


def test_alt_layout_replaces_reference_bases_instead_of_duplicating_them():
    layout = AltLayout('chrT', 100, 110, 100, 100, replaced_len=10)
    assert layout.ref_to_alt(110) == 210
    assert layout.alt_to_ref(210) == 110
    assert layout.describe(210)['ref'] == 110
    ref = 'C' * 100 + 'G' * 10 + 'C' * 100
    alt = 'C' * 100 + 'A' * 50 + 'G' * 10 + 'T' * 50 + 'C' * 100
    result = realign([(0, len(ref))], 0, ref, {'kind': 'reference'}, layout, alt)
    assert result.cigar == [(0, 100), (D, 50), (0, 10), (D, 50), (0, 100)]


def test_exact_reference_replacement_is_not_seeded_as_a_variant(tmp_path):
    ref = 'C' * 100 + 'A' * 50 + 'C' * 100
    rec = _seg([(0, 100), (1, 50), (2, 50), (0, 100)], start=0, seq=ref)
    assert extract_sv_events(rec, 50, reference=fasta_file(tmp_path, ref)) is None


@pytest.mark.parametrize('alt,expected', [('A' * 49 + 'T', (1, 1, 1)), ('A' * 50 + 'T' * 5, (5, 0, 5))])
def test_minimized_replacements_recompute_size_and_apply_the_cutoff(tmp_path, alt, expected):
    from services.sv_alleles import normalize_allele
    ref = 'C' * 100 + 'A' * 50 + 'G' * 100
    rec = _seg([(0, 100), (1, len(alt)), (2, 50), (0, 100)], start=0,
               seq=ref[:100] + alt + ref[150:])
    fasta = fasta_file(tmp_path, ref)
    raw, = extract_sv_events(rec, 50)
    event = normalize_allele(raw, rec, fasta)
    assert (event['len'], event['ref_len'], event['alt_len']) == expected
    assert event['inserted_len'] == expected[2] and event['deleted_len'] == expected[1]
    assert haplotype(ref, event) == rec.query_sequence
    assert extract_sv_events(rec, 50, reference=fasta) is None


@pytest.mark.parametrize('reverse', [False, True])
def test_daf_builders_consense_each_repeat_carrier_in_the_canonical_frame(tmp_path, reverse):
    pytest.importorskip('fiberhmm.daf.insert_consensus')
    from services.alt_allele import build_alt_allele, normalize_definition
    from services.insertion_lens import build_lens
    ref = 'C' * 1000 + 'ACGT' * 250 + 'G' * 1000
    fasta = fasta_file(tmp_path, ref)
    path = str(tmp_path / 'repeat.bam')
    records = []
    for i, anchor in enumerate([1100] * 4 + [1101] * 3 + [1102] * 4):
        insert = ref[anchor:anchor + 4] * 25
        rec = _seg([(0, anchor), (1, 100), (0, len(ref) - anchor)], start=0,
                   seq=ref[:anchor] + insert + ref[anchor:], reverse=reverse)
        rec.query_sequence = rec.query_sequence[:10] + ('Y' if i % 2 else 'R') + rec.query_sequence[11:]
        rec.query_name = f'carrier-{i}'
        rec.set_tag('st', 'CT' if i % 2 else 'GA')
        records.append(rec)
    with pysam.AlignmentFile(path, 'wb', header=records[0].header) as bam:
        for rec in records:
            bam.write(rec)
    pysam.index(path)
    meta = build_alt_allele([path], normalize_definition(dict(chrom='chrT', ref=1000, pos=1000, length=100, flank=500)),
                            str(tmp_path / 'alt'), fasta=fasta, daf=True)
    with pysam.FastaFile(str(tmp_path / 'alt' / 'alt.fa')) as alt:
        layout = meta['layout']
        assert alt.fetch(alt.references[0])[layout['insert_start']:layout['insert_end']] == 'ACGT' * 25
    assert meta['consensus']['method'] == 'daf'
    lens = build_lens([path], 'chrT', pos=1000, ref=1000, length=100, reference=fasta, daf=True,
                      include_sequences=True, loader=lambda *_a, **_k: [])
    assert lens['consensus']['method'] == 'daf' and lens['consensus']['seq'] == 'ACGT' * 25
    assert {c['q'] for c in lens['carriers']} == {1100, 1101, 1102}
    assert meta['consensus']['carriers_ct'] == 5 and meta['consensus']['carriers_ga'] == 6
    assert all(c['seq'] == ref[c['q']:c['q'] + 4] * 25 for c in lens['carriers'])
    assert all(c['knots'][0][0] == 0 and c['knots'][-1][0] == 100 for c in lens['carriers'])


@pytest.mark.parametrize('middle', [[(2, 10), (1, 100)], [(1, 100), (2, 10)],
                                    [(2, 5), (1, 100), (2, 5)]])
def test_lens_splices_boundary_deletions_and_updates_md(middle):
    rec = _seg([(0, 100)] + middle + [(0, 100)], start=900)
    rec.set_tag('MD', '100^AAAAAAAAAA100')
    event, = extract_sv_events(rec, 50)
    plan = _carrier_plan(rec, dict(kind='cigar', event=event), 100)
    assert plan['ref'] == 1000 and plan['ref_end'] == 1010
    spliced = splice_read(rec, plan)
    assert spliced.cigarstring == '300M' and spliced.reference_end == 1200
    assert spliced.get_tag('MD') == '300'
    assert rec.reference_end == 1110 and rec.get_tag('MD') == '100^AAAAAAAAAA100'


def test_insert_sequence_endpoint_concatenates_merged_i_pieces_without_matched_bridges(tmp_path, monkeypatch):
    from services import sv_endpoint
    from types import SimpleNamespace
    seq = 'C' * 20 + 'A' * 30 + 'G' * 5 + 'T' * 30 + 'C' * 20
    rec = _seg([(0, 20), (1, 30), (0, 5), (1, 30), (0, 20)], start=0, seq=seq)
    fasta = fasta_file(tmp_path, 'C' * 20 + 'G' * 5 + 'C' * 20)
    monkeypatch.setattr(sv_endpoint, '_bam_records', lambda *_a, **_k: [(rec, 'chrT')])
    out = sv_endpoint.sv_insert_seq_payload(SimpleNamespace(fasta=fasta), dataset_id='synthetic', chrom='chrT',
                                           ref=20, read_id=rec.query_name, q=20, length=60)
    assert out['seq'] == 'A' * 30 + 'T' * 30 and out['len'] == 60
