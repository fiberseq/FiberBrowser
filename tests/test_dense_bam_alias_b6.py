"""The dense BAM loader resolves chromosome aliases against the BAM's own names (B6 review)."""
import pysam


def _bam(path):
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "1", "LN": 1000}]}
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        seg = pysam.AlignedSegment(out.header)
        seg.query_name = "r1"
        seg.reference_id = 0
        seg.reference_start = 100
        seg.query_sequence = "A" * 50
        seg.cigartuples = [(0, 50)]
        seg.mapping_quality = 60
        seg.query_qualities = pysam.qualitystring_to_array("I" * 50)
        out.write(seg)
    pysam.index(str(path))


def test_a_tagged_read_with_no_footprints_is_kept_as_accessible(tmp_path):
    import numpy as np
    from services.dense_bam_loader import load_reads_from_bam
    bam = tmp_path / "open.bam"
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "chr1", "LN": 1000}]}
    with pysam.AlignmentFile(str(bam), "wb", header=header) as out:
        seg = pysam.AlignedSegment(out.header)
        seg.query_name = "open"
        seg.reference_id = 0
        seg.reference_start = 100
        seg.query_sequence = "A" * 50
        seg.cigartuples = [(0, 50)]
        seg.mapping_quality = 60
        seg.query_qualities = pysam.qualitystring_to_array("I" * 50)
        seg.set_tag("ns", "", value_type="Z")  # present, but no footprints
        seg.set_tag("nl", "", value_type="Z")
        out.write(seg)
    pysam.index(str(bam))
    df = load_reads_from_bam(str(bam), "chr1", 100, 150, spanning_only=False)
    assert list(df["read_id"]) == ["open"]
    assert (df.drop(columns=["read_id"]).to_numpy() < 0).all()  # accessible across its span


def test_fasta_style_chrom_map_still_finds_reads_in_a_bam_named_differently(tmp_path):
    from services.dense_bam_loader import load_reads_from_bam
    bam = tmp_path / "reads.bam"
    _bam(bam)
    # The session's map follows a FASTA that names it chr1; the BAM says 1.
    df = load_reads_from_bam(str(bam), "chr1", 0, 1000, spanning_only=False, chrom_map={"chr1": "chr1"})
    assert len(df) == 1
