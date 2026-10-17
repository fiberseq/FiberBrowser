"""DAF-C reads from BAMs (services/dafc_reads.query_bam_for_dafc): nucleosomes from
legacy ns/nl, FiberHMM 3.0 MA and fibertools Ma, and an unrepaired graph lift's
ex-supplementaries hidden. Synthetic BAMs written with pysam in tmp_path.
"""
from __future__ import annotations

from array import array

from services import dafc_reads
from test_graph_lift import CHROM_LEN, VG_LIFT_PGS, _split_molecule_specs, _write_bam


def _nuc_blocks(rows):
    return {r["name"]: (r["blockStarts"], r["blockSizes"], r["footprintsCalled"]) for r in rows}


def test_dafc_reads_take_nucleosomes_from_ma_and_ft_ma(tmp_path):
    specs = [
        # FiberHMM MA, molecular frame declared in the header (coord=molecular).
        (("fh_fwd", 1_000, 2_000), {"tags": [("MA", "2000;nuc.Q:101-150,1001-147;tf.Q:501-20", "Z")]}),
        (("fh_rev", 1_000, 2_000), {"reverse": True, "tags": [("MA", "2000;nuc.Q:101-150", "Z")]}),
        # fibertools Ma: always molecular.
        (("ft_rev", 1_000, 2_000), {"reverse": True, "tags": [("Ma", "2000;nuc.:101-150;msp.:251-100", "Z")]}),
        # Legacy ns/nl still read.
        (("legacy", 1_000, 2_000), {"tags": [("ns", array("I", [100]), None), ("nl", array("I", [150]), None)]}),
        (("uncalled", 1_000, 2_000), {}),
    ]
    pgs = [{"ID": "fiberhmm-apply", "PN": "fiberhmm-apply", "VN": "3.0.1",
            "CL": "fiberhmm-apply -i a.bam", "DS": "coord=molecular"}]
    path = _write_bam(tmp_path / "dafc.bam", pgs, specs)
    rows = _nuc_blocks(dafc_reads.query_bam_for_dafc(path, "chr1", 0, CHROM_LEN))
    assert rows["fh_fwd"] == ("100,1000", "150,147", True)     # nuc only, not the TF
    # Reverse read, molecular frame: [100, 250) of 2000 -> SEQ [1750, 1900).
    assert rows["fh_rev"] == ("1750", "150", True)
    assert rows["ft_rev"] == ("1750", "150", True)
    assert rows["legacy"] == ("100", "150", True)
    assert rows["uncalled"] == ("", "", False)


def test_dafc_reads_hide_unrepaired_lift_ex_supplementaries(tmp_path):
    path = _write_bam(tmp_path / "dafc_lift.bam", VG_LIFT_PGS, _split_molecule_specs())
    rows = dafc_reads.query_bam_for_dafc(path, "chr1", 0, CHROM_LEN)
    assert sorted((r["name"], r["start"]) for r in rows) == [("m1", 1_000), ("m1", 16_000), ("m2", 2_000)]


def test_dafc_ma_nucleosomes_project_through_aligned_bases(tmp_path):
    # 100M200I100M: query [100, 300) is inserted. A nucleosome wholly inside the
    # insertion has no reference block; one ending inside it stops at the last
    # aligned base (no extra base), as the read track's MA parser projects them.
    specs = [
        (("inside", 1_000, 400), {"cigar": "100M200I100M", "tags": [("MA", "400;nuc+Q:151-100", "Z")]}),
        (("ends_in", 1_000, 400), {"cigar": "100M200I100M", "tags": [("MA", "400;nuc+Q:51-100", "Z")]}),
    ]
    rows = _nuc_blocks(dafc_reads.query_bam_for_dafc(_write_bam(tmp_path / "ins.bam", [], specs), "chr1", 0, CHROM_LEN))
    assert rows["inside"] == ("", "", True)
    assert rows["ends_in"] == ("50", "50", True)
