"""Confirmed junctions delimit full inserts even when their records are clipped."""
import pysam
import pytest

from live_lift_fixtures import make_record, write_bam
from services.insertion_lens import _carrier_plan, build_lens, splice_read
from services.sv_endpoint import classify_records


@pytest.mark.parametrize('reverse', [False, True])
@pytest.mark.parametrize('side,hard_left', [('L', 0), ('R', 0), ('R', 20)])
def test_confirmed_split_carrier_uses_exact_sequence_interval(tmp_path, reverse, hard_left, side):
    hard = f'{hard_left}H' if hard_left else ''
    left, right = f'{hard}100M250S', f'{hard}250S100M'
    strand = '-' if reverse else '+'
    path = write_bam(tmp_path / 'split.bam', lambda h: [make_record(
        h, 'synthetic-split', 'chrT', 900 if side == 'R' else 1000, left if side == 'R' else right,
        flag=16 if reverse else 0, seq='A' * 100 + 'C' * 150 + 'G' * 100,
        tags=[('SA', f'chrT,{1001 if side == "R" else 901},{strand},{right if side == "R" else left},60,0;')])],
        contigs=(('chrT', 3000),))
    with pysam.AlignmentFile(path) as bam:
        read, = bam.fetch()
        classified = classify_records([(read, 'chrT')], t='I', ref=1000, length=180, margin=20)
        evidence = classified[read.query_name]['evidence']
        assert (evidence['kind'], evidence['level']) == ('sa', 'confirmed')
        plan = _carrier_plan(read, evidence, 180)
        assert (plan['partial'], plan['q'], plan['len'], plan['ref'], plan['ref_end']) == (None, 100, 150, 1000, 1000)
        assert read.query_sequence[plan['q']:plan['q'] + plan['len']] == 'C' * 150
        spliced = splice_read(read, plan)
        # Only the insertion and this record's aligned flank acquire coordinates.
        pairs = dict(spliced.get_aligned_pairs(matches_only=True))
        assert pairs[100] == 1000 and pairs[249] == 1149
        assert (250 not in pairs) if side == 'R' else (99 not in pairs)
    lens = build_lens([path], 'chrT', pos=1000, ref=1000, length=180, loader=lambda *a, **k: [])
    assert lens['consensus']['seq'] == 'C' * 150
    assert len(lens['carriers']) == 1 and 'knots' in lens['carriers'][0]


def test_confirmed_split_only_sample_can_build_alternate_allele(tmp_path):
    from services.alt_allele import build_alt_allele, normalize_definition
    path = write_bam(tmp_path / 'split.bam', lambda h: [make_record(
        h, 'synthetic-split', 'chrT', 900, '100M250S', seq='A' * 100 + 'C' * 150 + 'G' * 100,
        tags=[('SA', 'chrT,1001,+,250S100M,60,0;')])], contigs=(('chrT', 3000),))
    definition = normalize_definition(dict(chrom='chrT', ref=1000, length=180, flank=100))
    meta = build_alt_allele([path], definition, str(tmp_path / 'alternate'))
    assert meta['layout']['insert_len'] == 150
    with pysam.FastaFile(str(tmp_path / 'alternate' / 'alt.fa')) as fasta:
        start = meta['layout']['insert_start']
        assert fasta.fetch(fasta.references[0], start, start + 150) == 'C' * 150
