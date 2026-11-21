"""CT/GA strand labels are in the molecule frame everywhere (owner, 26 Oct, validation F2).

fiberhmm-lift swaps st on a strand flip (st describes the stored SEQ); the browser
shows the source st, recovered from the kept Yp:Z source locus."""
import pysam

from services.read_strand import lift_flipped, record_strand_fields


def record(*, reverse=False, st=None, yp=None, seq="ACGTY" * 4):
    header = pysam.AlignmentHeader.from_dict({"HD": {"VN": "1.6"}, "SQ": [{"SN": "chrT", "LN": 1000}]})
    r = pysam.AlignedSegment(header)
    r.query_name, r.reference_id, r.reference_start = "m", 0, 10
    r.cigarstring = f"{len(seq)}M"
    r.flag = 16 if reverse else 0
    r.query_sequence = seq
    if st:
        r.set_tag("st", st)
    if yp:
        r.set_tag("Yp", yp)
    return r


def test_native_and_unflipped_records_keep_their_st():
    assert record_strand_fields(record(st="CT")) == {"strand": "CT"}
    assert record_strand_fields(record(st="CT", yp="chrS:11:+")) == {"strand": "CT"}
    assert not lift_flipped(record(reverse=True, st="GA", yp="chrS:11:-"))


def test_flipped_fiberhmm_lift_shows_the_source_st():
    # Source: forward, CT, Y marks. Lifted through a minus chain: reversed, SEQ revcomped (R marks), st swapped to GA.
    lifted = record(reverse=True, st="GA", yp="chrS:11:+", seq="ACGTR" * 4)
    assert lift_flipped(lifted)
    assert record_strand_fields(lifted) == {"strand": "CT", "strand_frame": "molecule"}   # no conflict: GA matches R


def test_flipped_record_whose_st_was_not_swapped_is_still_flagged():
    stale = record(reverse=True, st="CT", yp="chrS:11:+", seq="ACGTR" * 4)   # a tool that did not swap st
    assert record_strand_fields(stale) == {"strand": "GA", "strand_frame": "molecule", "strand_conflict": True}


def test_flipped_record_without_st_uses_its_marks_in_the_molecule_frame():
    assert record_strand_fields(record(reverse=True, yp="chrS:11:+", seq="ACGTR" * 4)) == {"strand": "CT", "strand_frame": "molecule"}
    assert record_strand_fields(record(reverse=True, seq="ACGTR" * 4)) == {}


def test_flipped_record_without_st_or_iupac_marks_flips_its_decoded_majority():
    """Codex r2 HIGH 2: MD-mismatch marks decode in the target frame; the fallback majority is swapped back."""
    from services.read_strand import read_strand
    fields = record_strand_fields(record(reverse=True, yp="chrS:11:+", seq="ACGTA" * 4))
    assert fields == {"lift_flipped": True}
    ga_marks = {"deam": [[1, 0], [2, 0], [3, 0]], **fields}           # G>A marks in the target frame
    assert read_strand(ga_marks) == "CT"                             # the source molecule's CT
    assert read_strand({"deam": [[1, 0], [2, 0], [3, 0]]}) == "GA"   # an unflipped record is unchanged
