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
