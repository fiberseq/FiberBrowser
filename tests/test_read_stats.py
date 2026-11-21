"""Regression tests for selected-read statistics."""

import asyncio

from models.domain import WorkingSet
from models.requests import ReadStatsRequest
from routers.read_stats import get_read_stats
from services import read_stats as read_stats_service


class FakeDataset:
    data_type = "bigbed"


class FakeState:
    def __init__(self):
        self.calls = []

    def translate_chrom(self, chrom):
        return chrom

    def get_dataset(self, dataset_id):
        return FakeDataset() if dataset_id == "ds1" else None

    def build_working_set(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return WorkingSet(
            [{"id": "r2", "intervals": [[0, 10, 10], [10, 20, -10]]}],
            total_overlapping=1,
            total_spanning=1,
            chrom=args[1],
            start=args[2],
            end=args[3],
        )


class FakeBamDataset:
    data_type = "bam"
    paths = ["broken.bam"]


class FakeBam:
    def fetch(self, _chrom, _start, _end):
        raise RuntimeError("boom")


class FakeBamState(FakeState):
    def get_dataset(self, dataset_id):
        return FakeBamDataset() if dataset_id == "ds1" else None


def test_read_stats_scopes_working_set_to_selected_ids_and_seed():
    state = FakeState()
    request = ReadStatsRequest(
        read_ids_by_dataset={"ds1": ["r2", "r3", "r2"]},
        sample_seed="seed-stats",
    )

    result = asyncio.run(
        get_read_stats(
            chrom="chr2L",
            start=100,
            end=200,
            spanning=True,
            request=request,
            state=state,
        )
    )

    _, kwargs = state.calls[0]
    assert kwargs["read_ids"] == ["r2", "r3"]
    assert kwargs["sample_seed"] == "seed-stats"
    assert kwargs["include_methylation"] is True
    assert result["found_count"] == 1
    assert result["requested_count"] == 2
    assert result["missing_read_ids_by_dataset"] == {"ds1": ["r3"]}
    assert result["sample_seed"] == "seed-stats"


def test_read_stats_bam_fetch_diagnostics_are_opt_in(capsys, monkeypatch):
    monkeypatch.setattr(read_stats_service, "get_bam_handle", lambda _path: FakeBam())
    monkeypatch.delenv(read_stats_service.READ_STATS_DIAGNOSTICS_ENV, raising=False)
    state = FakeBamState()
    request = ReadStatsRequest(read_ids_by_dataset={"ds1": ["r2"]})

    result = read_stats_service.compute_read_stats(
        state,
        chrom="chr2L",
        start=100,
        end=200,
        spanning=True,
        request=request,
    )

    assert result["found_count"] == 0
    assert result["missing_read_ids_by_dataset"] == {"ds1": ["r2"]}
    assert capsys.readouterr().out == ""

    monkeypatch.setenv(read_stats_service.READ_STATS_DIAGNOSTICS_ENV, "1")
    result = read_stats_service.compute_read_stats(
        state,
        chrom="chr2L",
        start=100,
        end=200,
        spanning=True,
        request=request,
    )

    assert result["found_count"] == 0
    assert "[read_stats] Error fetching from BAM broken.bam: boom" in capsys.readouterr().out


class RegionState(FakeState):
    """A read r2 at chr2L:100-200 and a read c1 only at chr3R:5000-6000."""

    def build_working_set(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        chrom, start, end = args[1], args[2], args[3]
        read = "c1" if chrom == "chr3R" else "r2"
        return WorkingSet([{"id": read, "intervals": [[0, 10, 10], [10, 20, -10]]}],
                          total_overlapping=1, total_spanning=1, chrom=chrom, start=start, end=end)


def test_read_stats_looks_up_reads_selected_at_another_locus_there():
    state = RegionState()
    request = ReadStatsRequest(
        read_ids_by_dataset={"ds1": ["r2"]},
        extra_regions=[{"chrom": "chr3R", "start": 5000, "end": 6000, "read_ids_by_dataset": {"ds1": ["c1"]}}],
    )
    result = asyncio.run(get_read_stats(chrom="chr2L", start=100, end=200, spanning=False,
                                        request=request, state=state))
    assert [(c[0][1], c[0][2], c[0][3]) for c in state.calls] == [("chr2L", 100, 200), ("chr3R", 5000, 6000)]
    assert sorted(r["read_id"] for r in result["per_read"]) == ["c1", "r2"]
    assert result["requested_count"] == 2 and result["found_count"] == 2
    assert result["missing_read_ids_by_dataset"] == {}
    assert result["aggregate"]["n_reads"] == 2 and result["aggregate"]["n_datasets"] == 1


class ManyReadsState(FakeState):
    """Every requested read exists, with i footprints for read r<i>."""

    def build_working_set(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        reads = []
        for rid in kwargs.get("read_ids") or []:
            n = int(rid[1:]) % 7
            reads.append({"id": rid, "intervals": [[i * 200, i * 200 + 147, 147] for i in range(n)] + [[n * 200, n * 200 + 50, -50]]})
        return WorkingSet(reads, total_overlapping=len(reads), total_spanning=len(reads),
                          chrom=args[1], start=args[2], end=args[3])


def test_read_stats_for_a_large_group_is_capped_in_request_order(monkeypatch):
    monkeypatch.setattr(read_stats_service, "MAX_READ_STATS_IDS", 5)
    state = ManyReadsState()
    request = ReadStatsRequest(
        read_ids_by_dataset={"ds1": [f"r{i}" for i in range(4)]},
        extra_regions=[{"chrom": "chr3R", "start": 0, "end": 900, "read_ids_by_dataset": {"ds1": ["r10", "r11", "r12"]}}],
    )
    result = asyncio.run(get_read_stats(chrom="chr2L", start=0, end=900, spanning=False, request=request, state=state))
    assert result["truncated"] is True
    assert result["requested_total"] == 7
    assert result["requested_count"] == 5
    assert [r["read_id"] for r in result["per_read"]] == ["r0", "r1", "r2", "r3", "r10"]
    # The extra region was looked up with only the reads inside the cap.
    assert state.calls[1][1]["read_ids"] == ["r10"]


def test_read_stats_small_group_is_not_truncated_and_has_footprint_count_distribution():
    state = ManyReadsState()
    request = ReadStatsRequest(read_ids_by_dataset={"ds1": [f"r{i}" for i in range(7)]})
    result = asyncio.run(get_read_stats(chrom="chr2L", start=0, end=2000, spanning=False, request=request, state=state))
    assert result["truncated"] is False and result["requested_total"] == 7
    hist = result["aggregate"]["hist_fp_count"]
    assert sum(b["count"] for b in hist) == 7
    # Reads r0..r6 carry 0..6 footprints.
    assert [r["footprint_count"] for r in result["per_read"]] == list(range(7))


def test_every_bam_read_has_its_alignment_bounds_not_only_a_single_read():
    """fb-n3-export (audit M6 / Codex #12): the read table's ref_start / ref_end
    were filled only when one read was asked for; every row was empty."""
    from pathlib import Path
    from types import SimpleNamespace

    import pysam
    import pytest

    demo = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "napa_ddda.bam"
    if not demo.exists():
        pytest.skip("demo BAM not present")
    region = ("chr19", 47_515_000, 47_516_000)
    with pysam.AlignmentFile(str(demo)) as bam:
        primaries = {}
        for r in bam.fetch(*region):
            if not (r.is_secondary or r.is_supplementary or r.is_unmapped) and r.query_name not in primaries:
                primaries[r.query_name] = r
            if len(primaries) == 3:
                break
    names = list(primaries)
    per_read: list = []
    read_stats_service._collect_bam_read_stats(
        dataset=SimpleNamespace(paths=[str(demo)]), dataset_id="ds1", wanted=set(names), read_ids=names,
        ws=SimpleNamespace(read_by_id={}), chrom=region[0], start=region[1], end=region[2], per_read=per_read,
        all_fp_sizes=[], all_acc_pcts=[], all_lengths=[], all_mapqs=[], all_methyl_pcts=[],
        strand_counts={"+": 0, "-": 0})
    assert sorted(r["read_id"] for r in per_read) == sorted(names)
    for row in per_read:
        src = primaries[row["read_id"]]
        assert (row["ref_start"], row["ref_end"]) == (src.reference_start, src.reference_end)
        assert row["strand"] in ("+", "-")
        # The CIGAR and read-relative detail stay a single read's.
        assert row["cigar_string"] is None and row["fp_intervals"] is None


def test_read_without_calls_is_not_called_not_fully_accessible(tmp_path):
    """A read the footprint caller skipped (e.g. under --min-read-length) carries no call tags. Its row is only a
    placeholder span, so footprints and accessibility are unknown (None, 'not called'), not 0 / 100%, and it is
    left out of the footprint and accessibility aggregates."""
    from types import SimpleNamespace

    import array
    import pysam

    header = pysam.AlignmentHeader.from_dict({"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "chr1", "LN": 10000}]})
    path = tmp_path / "calls.bam"
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for name, called in (("called", True), ("skipped", False)):
            r = pysam.AlignedSegment(header)
            r.query_name, r.query_sequence, r.flag, r.reference_id = name, "A" * 2000, 0, 0
            r.reference_start, r.mapping_quality, r.cigartuples = 1000, 60, [(0, 2000)]
            if called:
                r.set_tag("MA", "2000;nuc.Q:1-147,400-147;msp.:148-252", "Z")
                r.set_tag("AQ", array.array("B", [200, 200]))
            out.write(r)
    pysam.index(str(path))
    ws = SimpleNamespace(read_by_id={
        "called": {"intervals": [[0, 147, 147], [147, 399, 0], [399, 546, 147], [546, 2000, 0]], "methyl": [200, 300]},
        "skipped": {"intervals": [[0, 2000, 0]], "methyl": [5]},
    })
    per_read, fp, acc = [], [], []
    read_stats_service._collect_bam_read_stats(
        dataset=SimpleNamespace(paths=[str(path)]), dataset_id="ds1", wanted={"called", "skipped"},
        read_ids=["called", "skipped"], ws=ws, chrom="chr1", start=1000, end=3000, per_read=per_read,
        all_fp_sizes=fp, all_acc_pcts=acc, all_lengths=[], all_mapqs=[], all_methyl_pcts=[],
        strand_counts={"+": 0, "-": 0})
    rows = {r["read_id"]: r for r in per_read}
    assert rows["called"]["call_status"] == "called" and rows["called"]["footprint_count"] == 2
    skipped = rows["skipped"]
    assert skipped["call_status"] == "not called"
    assert skipped["accessibility_pct"] is None and skipped["footprint_count"] is None
    assert skipped["methyl_count"] == 1                # modifications are still reported
    assert len(acc) == 1 and fp == [147, 147]          # aggregates use the called read only
    agg = read_stats_service._build_aggregate(
        per_read=per_read, request=None, all_fp_sizes=fp, all_acc_pcts=acc, all_lengths=[2000, 2000],
        all_mapqs=[60, 60], all_methyl_pcts=[], strand_counts={"+": 2, "-": 0})
    assert agg["n_not_called"] == 1 and agg["mean_footprint_count"] == 2.0


def test_read_has_footprint_calls_recognises_ma_and_legacy_tags():
    class R:
        def __init__(self, tags):
            self.tags = tags

        def has_tag(self, t):
            return t in self.tags

        def get_tag(self, t):
            return self.tags[t]

    f = read_stats_service.read_has_footprint_calls
    assert f(R({"MA": "500;nuc.QQQ:1-147"}))
    assert f(R({"Ma": "500;msp.:10-50"}))
    assert f(R({"ns": [1, 200], "nl": [147, 147]}))
    assert not f(R({}))
    assert not f(R({"MA": "500;fp_CTCF.QQQ:10-20"}))       # only derived layers: no caller calls
    assert not f(R({"ns": 3, "nl": 5}))                      # scalar tags of another pipeline


def test_fully_accessible_called_reads_count_as_called_and_empty_groups_do_not():
    """A called read can be fully accessible: an msp group only, or an empty nuc group beside an msp group. A read
    whose groups are all empty has no calls."""
    from array import array

    class R:
        def __init__(self, tags):
            self.tags = tags

        def has_tag(self, t):
            return t in self.tags

        def get_tag(self, t):
            return self.tags[t]

    f = read_stats_service.read_has_footprint_calls
    assert f(R({"MA": "2000;msp.:1-2000"}))                          # msp only: called, fully accessible
    assert f(R({"MA": "2000;nuc.Q:;msp.:1-2000"}))                   # empty nuc group next to an msp group
    assert f(R({"as": array("I", [0]), "al": array("I", [2000])}))   # legacy MSP pair only
    assert not f(R({"MA": "2000;nuc.Q:;msp.:;tf.:"}))                # only empty groups: not called
    assert not f(R({"ns": array("I", []), "nl": array("I", [])}))    # empty legacy arrays
    assert not f(R({"ns": "raw", "nl": "none"}))                     # string tags (bam_tags.interval_tag_pair)


def test_strandless_ma_groups_are_not_calls_as_in_fiberhmm():
    """A section head without a strand character (``nuc:201-350``) is not spec MA. FiberHMM 3.2.0's
    ``parse_ma_tag`` rejects the whole tag, so its scan, extract and peaks see no calls; the uncalled-read rule
    agrees, value for value, with ``fiberhmm.io.legacy_tags.ma_has_footprint_groups`` wherever both see a non-empty
    group (FiberBrowser alone treats a tag whose call groups are all empty as no calls)."""
    from fiberhmm.io.legacy_tags import ma_has_footprint_groups

    class R:
        def __init__(self, tags):
            self.tags = tags

        def has_tag(self, t):
            return t in self.tags

        def get_tag(self, t):
            return self.tags[t]

    f = read_stats_service.read_has_footprint_calls
    rejected = [
        "4000;nuc:201-350,801-950;tf:1181-1210;msp:951-1800",   # every head strandless
        "4000;nucQ:201-350",                                     # quality spec but no strand
        "4000;nuc.:201-350;msp:951-1800",                        # one strandless section rejects the tag
        "4000;nuc.:201-350;junk",                                # a section with no colon
    ]
    accepted = [
        "4000;nuc.:201-350,801-950;tf.:1181-1210;msp.:951-1800",
        "4000;nuc+QQQ:201-350",
        "4000;tf-Q:1181-1210",
        "4000;fp_x.:5-10;msp.:951-1800",
        "4000;nuc.:201-350;;",                                   # empty sections are skipped, as FiberHMM does
    ]
    for value in rejected:
        assert not f(R({"MA": value})), value
        assert not f(R({"Ma": value})), value
        assert ma_has_footprint_groups(value) is False, value
    for value in accepted:
        assert f(R({"MA": value})), value
        assert ma_has_footprint_groups(value) is True, value
    # A strandless MA beside a valid Ma (or legacy arrays) still leaves the read called by those.
    assert f(R({"MA": rejected[0], "Ma": accepted[0]}))
    assert f(R({"MA": rejected[0], "ns": [1, 200], "nl": [147, 147]}))


def test_means_are_none_when_no_read_in_scope_is_called():
    per_read = [dict(read_id="a", footprint_count=None, accessibility_pct=None),
                dict(read_id="b", footprint_count=None, accessibility_pct=None)]
    agg = read_stats_service._build_aggregate(
        per_read=per_read, request=None, all_fp_sizes=[], all_acc_pcts=[], all_lengths=[2000, 2000],
        all_mapqs=[60, 60], all_methyl_pcts=[], strand_counts={"+": 2, "-": 0})
    assert agg["n_not_called"] == 2
    for key in ("mean_accessibility_pct", "mean_footprint_count", "mean_footprint_size", "median_footprint_size",
                "hist_accessibility", "hist_fp_count"):
        assert agg[key] is None, key
    # A called read without footprints (fully accessible): accessibility is known, footprint size has no value.
    called = per_read + [dict(read_id="c", footprint_count=0, accessibility_pct=100.0)]
    agg = read_stats_service._build_aggregate(
        per_read=called, request=None, all_fp_sizes=[], all_acc_pcts=[100.0], all_lengths=[2000] * 3,
        all_mapqs=[60] * 3, all_methyl_pcts=[], strand_counts={"+": 3, "-": 0})
    assert agg["mean_accessibility_pct"] == 100.0 and agg["mean_footprint_size"] is None and agg["n_not_called"] == 2
