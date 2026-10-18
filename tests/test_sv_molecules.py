"""Supplementary-only local molecules and reciprocal segment consolidation."""
import pysam
import pytest

from services.compact_read_loader import build_compact_reads_from_bam
from services.insertion_lens import build_lens
from services.sv_endpoint import _compact_record, classify_records
from services.sv_events import classify_molecules, sv_summary_for_reads
from services.sv_molecules import consolidate_evidence, unique_segments
from test_sv_events import _seg


@pytest.fixture(params=[False, True], ids=['forward', 'reverse'])
def regional_bam(tmp_path, request):
    reverse = request.param
    strand = '-' if reverse else '+'
    left = _seg([(0, 1000), (4, 500)], start=0, reverse=reverse,
                sa=f'chrT,2001,{strand},1000H500M,60,0;')
    right = _seg([(5, 1000), (0, 500)], start=2000, reverse=reverse, supplementary=True,
                 sa=f'chrT,1,{strand},1000M500S,60,0;')
    left.query_name = right.query_name = 'joined'
    only = _seg([(5, 100), (0, 100), (1, 100), (0, 500)], start=900,
                reverse=reverse, supplementary=True, sa=f'chrT,9001,{strand},100M700H,60,0;')
    only.query_name = 'supp-only'
    outside = _seg([(0, 100), (5, 700)], start=9000, reverse=reverse)
    outside.query_name = 'supp-only'
    path = str(tmp_path / 'molecules.bam')
    with pysam.AlignmentFile(path + '.unsorted', 'wb', header=left.header) as bam:
        for rec in [left, right, only, outside]:
            bam.write(rec)
    pysam.sort('-o', path, path + '.unsorted')
    pysam.index(path)
    return path


def test_public_loader_recovers_supplementary_only_and_keeps_one_row_per_molecule(regional_bam):
    rows = build_compact_reads_from_bam(regional_bam, 'chrT', 0, 3000, spanning_only=False,
                                        hide_terminal_gaps=False)
    assert {r['id'] for r in rows} == {'joined', 'supp-only'}
    assert len(rows) == 2
    joined = next(r for r in rows if r['id'] == 'joined')
    assert len(joined['sv_alignments']) == 2 and len(joined['sv_segments']) == 2
    assert len({(s['pos'], s['q_start'], s['q_end']) for s in joined['sv_segments']}) == 2
    summary = sv_summary_for_reads(rows, 0, 3000, 50, chrom='chrT')
    assert summary['n_reads'] == 2
    insertion = next(c for c in summary['clusters'] if c['t'] == 'I')
    assert insertion['support'] == 1


def test_reciprocal_sa_and_merged_file_records_are_counted_once(regional_bam):
    with pysam.AlignmentFile(regional_bam) as bam:
        records = [(r, 'chrT') for r in bam.fetch('chrT', 0, 3000)]
    for order in [records, list(reversed(records)), records + records]:
        calls = classify_records(order, t='D', ref=1000, length=1000)
        assert set(calls) == {'joined', 'supp-only'}
        assert calls['joined']['evidence']['level'] == 'confirmed'
        assert calls['joined']['allele'] == 0
        assert len(calls['joined']['evidence_bundle']) in (2, 4)
        assert len(calls['joined']['read']['sv_segments']) == 2


def test_bundle_joins_actual_segments_even_without_sa_and_preserves_raw_evidence():
    left = _seg([(0, 1000), (4, 500)], start=0)
    right = _seg([(5, 1000), (0, 500)], start=2000, supplementary=True)
    parts = [_compact_record(r, 'chrT', 10) for r in [left, right]]
    merged = consolidate_evidence(parts)
    calls = classify_molecules([(merged, None)], t='D', ref=1000, length=1000, chrom='chrT')
    assert calls['r']['allele'] == 0 and len(calls['r']['evidence_bundle']) == 2
    assert merged['sv_alignments'][1]['sequence_span'] == [1000, 1500]
    # A fetched low-MAPQ segment cannot be promoted by a high-MAPQ reciprocal SA description.
    right.mapping_quality = 0
    low = _compact_record(right, 'chrT', 10)
    fake_sa = {**low['sv_segments'][0], 't': 'SA', 'mapq': 60}
    segments = unique_segments([low, {'sv_segments': [fake_sa]}])
    assert len(segments) == 1 and segments[0]['mapq'] == 0


def test_lens_can_use_a_supplementary_only_cigar_insertion(regional_bam):
    lens = build_lens([regional_bam, regional_bam], 'chrT', pos=1000, ref=1000, length=100,
                      consensus=False, flank=50)
    assert lens['cluster']['carriers'] == 1
    confirmed = [r for r in lens['carriers'] if r['evidence_level'] == 'confirmed']
    assert [r['id'] for r in confirmed] == ['supp-only']
    assert confirmed[0]['len'] == 100 and len(confirmed[0]['evidence_bundle']) == 2


@pytest.mark.parametrize('reverse', [False, True])
def test_supplementary_only_with_annotations_outside_local_alignment_keeps_a_neutral_row(tmp_path, reverse):
    import array
    rec = _seg([(0, 100), (4, 900)], start=1000, reverse=reverse, supplementary=True)
    rec.set_tag('ns', array.array('i', [500]))
    rec.set_tag('nl', array.array('i', [50]))
    path = str(tmp_path / 'evidence-only.bam')
    with pysam.AlignmentFile(path, 'wb', header=rec.header) as bam:
        bam.write(rec)
    pysam.index(path)
    rows = build_compact_reads_from_bam(path, 'chrT', 900, 1200, spanning_only=False)
    assert len(rows) == 1 and rows[0]['supplementary'] is True
    assert rows[0]['intervals'] == [[100, 200, 0]]
    assert any(event['t'] == 'S' for event in rows[0]['sv'])


@pytest.mark.parametrize('reverse', [False, True])
def test_annotated_hard_clipped_recovery_is_neutral_on_both_strands(tmp_path, reverse):
    import array
    rec = _seg([(5, 100), (0, 200), (1, 50), (0, 200), (5, 100)], start=1000,
               reverse=reverse, supplementary=True)
    rec.set_tag('ns', array.array('i', [150]))
    rec.set_tag('nl', array.array('i', [50]))
    rec.set_tag('MA', 'nuc.:150+50;')
    path = str(tmp_path / 'hard-clipped.bam')
    header = rec.header.to_dict()
    header['CO'] = ['FIBERHMM-TAG-FRAME:v1:coord=molecular']
    with pysam.AlignmentFile(path, 'wb', header=header) as bam:
        bam.write(rec)
    pysam.index(path)
    kwargs = dict(spanning_only=False, include_layers=True, include_methylation=True,
                  hide_terminal_gaps=False, short_terminal_footprint_bp=0)
    row, = build_compact_reads_from_bam(path, 'chrT', 900, 1500, **kwargs)
    assert row['intervals'] == [[100, 500, 0]] and row['no_calls']
    assert not row.get('layers') and not row.get('methyl')
    assert any(e['t'] == 'I' for e in row['sv']) and row['sequence_span'] == [100, 550]
    assert build_compact_reads_from_bam(path, 'chrT', 900, 1500, min_footprints=1, **kwargs) == []


def test_circular_clipping_preserves_supplementary_bundles():
    from services.compact_read_loader import _clip_part_before
    read = dict(id='wrapped', intervals=[[0, 100, 0]], reference_start=0, reference_end=100,
                supplementary=True, sv_alignments=[dict(id='wrapped', sv=[])], sv_evidence=[])
    clipped = _clip_part_before(read, 50)
    assert clipped['supplementary'] and clipped['sv_alignments'] == read['sv_alignments']
    assert clipped['sv_evidence'] == []
