"""B6 round 6: reverse-strand frames, DAF-C block lengths, notebook FASTA."""
import array
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'browser'))

from services.bam_tags import legacy_starts_in_seq_frame  # noqa: E402

DEMO = ROOT / 'browser' / 'data' / 'demo' / 'napa_ddda.bam'
REGION = ('chr19', 47514000, 47518000)


def test_legacy_starts_flip_only_molecular_reverse_reads():
    reverse = SimpleNamespace(query_length=100, is_reverse=True)
    forward = SimpleNamespace(query_length=100, is_reverse=False)
    assert legacy_starts_in_seq_frame([10], [20], reverse, True) == [70]
    assert legacy_starts_in_seq_frame([10], [20], reverse, False) == [10]
    assert legacy_starts_in_seq_frame([10], [20], forward, True) == [10]


def _compact_footprints(reads):
    """Reverse reads' footprints (absolute reference intervals) from the compact loader."""
    out = {}
    for r in reads:
        if r.get('alignment_orientation') != 'reverse':
            continue
        out[r['id']] = sorted((REGION[1] + iv[0], REGION[1] + iv[1])
                              for iv in r.get('intervals', []) if len(iv) >= 3 and iv[2] > 0)
    return out


@pytest.mark.skipif(not DEMO.exists(), reason='demo BAM not present')
def test_demo_reverse_reads_agree_with_the_compact_loader():
    import pysam
    from services.bam_tags import bam_legacy_tags_are_molecular
    from services.compact_read_loader import build_compact_reads_from_bam
    from services.dafc_reads import query_bam_for_dafc
    from services.dense_bam_loader import load_reads_from_bam

    with pysam.AlignmentFile(str(DEMO)) as bam:
        assert bam_legacy_tags_are_molecular(bam.header)  # the case this test covers
    chrom, start, end = REGION
    result = build_compact_reads_from_bam(
        str(DEMO), chrom, start, end, spanning_only=False, hide_terminal_gaps=False,
        include_layers=False, infer_legacy_layers=False)
    compact_reads = result[0] if isinstance(result, tuple) else result
    compact_reads = compact_reads.get('reads', compact_reads) if isinstance(compact_reads, dict) else compact_reads
    expected = _compact_footprints(compact_reads)
    assert expected, 'the demo region has reverse reads with footprints'

    # DAF-C linked reads: blocks are absolute reference intervals.
    dafc = {r['name']: sorted((r['start'] + int(s), r['start'] + int(s) + int(n))
                              for s, n in zip(r['blockStarts'].split(','), r['blockSizes'].split(',')) if s)
            for r in query_bam_for_dafc(str(DEMO), chrom, start, end) if r['strand'] == '-' and r['blockStarts']}
    checked = 0
    for name, footprints in expected.items():
        if name not in dafc:
            continue
        inside = [(a, b) for a, b in dafc[name] if a >= start and b <= end]
        want = [(a, b) for a, b in footprints if a > start and b < end]
        assert set(want) <= set(inside), name
        checked += 1
    assert checked > 0

    # Dense signed rows: a footprint's bases carry its (positive) size.
    frame = load_reads_from_bam(str(DEMO), chrom, start, end, spanning_only=False)
    positions = [c for c in frame.columns if c != 'read_id']
    rows = {rid: frame.loc[i, positions].to_numpy() for i, rid in enumerate(frame['read_id'])}
    dense_checked = 0
    for name, footprints in expected.items():
        row = rows.get(name)
        if row is None:
            continue
        for a, b in footprints:
            if a > start and b < end:
                assert np.all(row[a - start:b - start] > 0), (name, a, b)
                dense_checked += 1
    assert dense_checked > 0


def test_dafc_block_length_spans_a_deletion(tmp_path):
    import pysam
    from services.dafc_reads import query_bam_for_dafc

    path = tmp_path / 'd.bam'
    header = {'HD': {'VN': '1.6'}, 'SQ': [{'SN': 'chr1', 'LN': 10000}]}
    with pysam.AlignmentFile(str(path), 'wb', header=header) as out:
        seg = pysam.AlignedSegment(out.header)
        seg.query_name = 'r'
        seg.query_sequence = 'A' * 100
        seg.reference_id = 0
        seg.reference_start = 100
        seg.cigarstring = '50M10D50M'
        seg.mapping_quality = 60
        seg.set_tag('ns', array.array('I', [40]))
        seg.set_tag('nl', array.array('I', [20]))
        out.write(seg)
    pysam.index(str(path))
    (row,) = query_bam_for_dafc(str(path), 'chr1', 0, 1000)
    # Query 40..59 covers reference 140..149, the 10-base deletion, then 160..169.
    assert (row['blockStarts'], row['blockSizes']) == ('40', '30')


def test_set_fasta_enables_notebook_sequence_services(tmp_path):
    """client.set_fasta loads the browser reference (fasta_path) only; the
    notebook sequence endpoint must read it."""
    from models.requests import SequenceRegion, SequenceRequest
    from services import jupyter_endpoint

    fa = tmp_path / 'ref.fa'
    fa.write_text('>chr1\n' + 'ACGT' * 50 + '\n')
    state = SimpleNamespace(fasta_path=str(fa), primer_fasta=None)
    req = SequenceRequest(regions=[SequenceRegion(chrom='chr1', start=0, end=8, name='a')])
    result = jupyter_endpoint.get_sequences_for_request(state, req)
    assert result['success'], result
    assert result['sequences'][0]['sequence'].upper() == 'ACGTACGT'

    # Nothing loaded at all: still the clear message.
    empty = jupyter_endpoint.get_sequences_for_request(SimpleNamespace(fasta_path=None, primer_fasta=None), req)
    assert not empty['success'] and 'set_fasta' in empty['error']

