"""Coverage counts the molecules the read panel shows (review round 3 follow-up).

fiberhmm-pipeline marks PCR duplicates 0x400 and keeps them (--dedup-mode flag,
the default). The read loaders leave duplicate-flagged molecules out unless the
panel shows duplicates; coverage counted them regardless, on linear and circular
contigs alike, so the zoomed-out coverage disagreed with the reads it stands for.
"""
from array import array
from types import SimpleNamespace

import pysam
import pytest

from models.domain import Dataset
from services.read_coverage import compute_binned_read_coverage
from test_circular_origin_spanning import CONTIG, L, _payload, _record, _sequence, _state


def _bam(tmp_path, *, circular):
    sq = {"SN": CONTIG, "LN": L}
    if circular:
        sq["TP"] = "circular"
    header = pysam.AlignmentHeader.from_dict({"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [sq]})
    ext = _sequence() * 2
    tags = {"ns": array("i", [20]), "nl": array("i", [50]), "nq": array("B", [50])}
    records = [_record(header, "keep1", 100, 300, ext, tags=tags),
               _record(header, "keep2", 150, 300, ext, tags=tags),
               _record(header, "dup", 120, 300, ext, tags=tags, flag=0x400)]
    if circular:
        # An origin-spanning duplicate: its tail at 0..100 must follow the same rule.
        records.append(_record(header, "dupwrap", 900, 200, ext, flag=0x400, tags={
            "ns": array("i", [20, 150]), "nl": array("i", [50, 40]), "nq": array("B", [50, 50])}))
    unsorted = tmp_path / "unsorted.bam"
    with pysam.AlignmentFile(str(unsorted), "wb", header=header) as out:
        for record in records:
            out.write(record)
    path = tmp_path / "dups.bam"
    pysam.sort("-o", str(path), str(unsorted))
    pysam.index(str(path))
    return {"bam": str(path), "seq": _sequence()}


@pytest.mark.parametrize("circular", [False, True])
@pytest.mark.parametrize("include_duplicates", [False, True])
def test_coverage_counts_the_reads_the_panel_shows(tmp_path, circular, include_duplicates):
    from services.read_auxiliary_endpoint import get_coverage_payload

    state = _state(_bam(tmp_path, circular=circular))
    _payload_, reads = _payload(state, 0, 400, include_duplicates=include_duplicates, include_cigar=True)
    coverage = get_coverage_payload(state, chrom=CONTIG, start=0, end=400, bins=1,
                                    include_duplicates=include_duplicates)
    assert coverage["coverage"] == [len(reads)]
    expected = {"keep1", "keep2"} | ({"dup"} | ({"dupwrap"} if circular else set())
                                     if include_duplicates else set())
    assert set(reads) == expected


class _BigBed:
    """The pyBigWig calls coverage makes: rows as (start, end, rest)."""

    def __init__(self, rows):
        self.rows = rows

    def chroms(self):
        return {CONTIG: L}

    def entries(self, chrom, start, end):
        return [row for row in self.rows if row[0] < end and row[1] > start]


def _bigbed_coverage(rows, start, end, segments=None, **kwargs):
    dataset = Dataset("bb", "mol.bb", "bb", data_type="bigbed")
    handle = _BigBed(rows)
    return compute_binned_read_coverage(
        [dataset], CONTIG, start, end, 1, bam_handle_getter=lambda p: None,
        bigbed_handle_getter=lambda p: handle, query_segments=segments, **kwargs)["coverage"]


def test_a_bigbed_molecule_across_the_seam_counts_once_per_bin():
    # One molecule written as two rows either side of the origin; the wrapped
    # view merges them into one read, so one coverage bin counts it once.
    rows = [(950, 1000, "mol\t0"), (0, 50, "mol\t0")]
    assert _bigbed_coverage(rows, 900, 1100, [(900, 1000, 0), (0, 100, 1000)]) == [1]
    # A linear window shows the two rows as two reads.
    assert _bigbed_coverage(rows, 0, L) == [2]


def test_bigbed_duplicate_rows_follow_the_panel(monkeypatch):
    import services.bigbed_detection as detection

    monkeypatch.setattr(detection, "bigbed_has_duplicate_field", lambda path: True)
    rows = [(100, 300, "a\t0"), (120, 300, "b\t1")]
    assert _bigbed_coverage(rows, 0, 400) == [1]
    assert _bigbed_coverage(rows, 0, 400, include_duplicates=True) == [2]
