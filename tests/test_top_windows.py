"""Best-covered windows, deepest first (the 'go to reads' tour)."""
from pathlib import Path
from types import SimpleNamespace

import pytest

DEMO_BAM = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "napa_ddda.bam"


@pytest.mark.skipif(not DEMO_BAM.exists(), reason="NAPA demo BAM not present")
def test_top_windows_rank_by_depth_without_overlaps():
    from services.random_window import top_covered_windows
    ds = SimpleNamespace(id="napa", data_type="bam", paths=[str(DEMO_BAM)])
    state = SimpleNamespace(get_dataset=lambda i: ds if i == "napa" else None, dataset_order=["napa"], chroms=[])
    res = top_covered_windows(state, span=4000, dataset_id="napa", n=5, samples=40)
    assert res["success"]
    windows = res["windows"]
    assert windows[0]["chrom"] == "chr19" and windows[0]["start"] < 47_518_000 and windows[0]["end"] > 47_514_000
    depths = [w["depth"] for w in windows]
    assert depths == sorted(depths, reverse=True) and depths[0] > 100
    for i, a in enumerate(windows):
        for b in windows[i + 1:]:
            assert not (a["chrom"] == b["chrom"] and a["start"] < b["end"] and b["start"] < a["end"])
    again = top_covered_windows(state, span=4000, dataset_id="napa", n=5, samples=40)
    assert again["windows"] == windows  # stable order


def _fake_reads(monkeypatch, reads, contig="chr1", size=100_000):
    """Coverage from `reads` ([(start, end)]) on one contig; every sample lands on the first read."""
    import services.random_window as rw

    def coverage(_datasets, _contig, lo, hi, bins, **_kw):
        size_ = (hi - lo) / bins
        return {"coverage": [
            float(sum(1 for s, e in reads if s < lo + (k + 1) * size_ and e > lo + k * size_)) for k in range(bins)
        ]}

    monkeypatch.setattr(rw, "compute_binned_read_coverage", coverage)
    # The file's contigs with reads (the search checks them against the reference first).
    monkeypatch.setattr(rw, "_bam_contigs", lambda _path: [(contig, float(len(reads)), size)])
    monkeypatch.setattr(rw, "_sample_anchor", lambda _ds, _rng, _span, *_contigs: (contig, reads[0][0], size))
    rw._TOP_WINDOW_CACHE.clear()


def test_a_narrow_window_contains_the_reads_it_reports(monkeypatch):
    from services.random_window import top_covered_windows
    _fake_reads(monkeypatch, [(1020, 1030)])
    ds = SimpleNamespace(id="d", data_type="bam", paths=["x.bam"])
    state = SimpleNamespace(get_dataset=lambda i: ds, dataset_order=["d"], chroms=[])
    w = top_covered_windows(state, span=10, dataset_id="d", n=1, samples=3)["windows"][0]
    assert w["depth"] == 1 and w["start"] < 1030 and w["end"] > 1020


def test_contig_aliases_are_one_contig(monkeypatch):
    import services.random_window as rw
    from services.random_window import top_covered_windows
    _fake_reads(monkeypatch, [(5000, 9000)])
    names = iter(["chr1", "1"] * 10)
    monkeypatch.setattr(rw, "_sample_anchor", lambda _ds, _rng, _span, *_contigs: (next(names), 5000, 100_000))
    monkeypatch.setattr(rw, "_resolve_state_chrom", lambda _state, contig: "chr1")
    ds = SimpleNamespace(id="d", data_type="bam", paths=["x.bam"])
    state = SimpleNamespace(get_dataset=lambda i: ds, dataset_order=["d"], chroms=[])
    windows = top_covered_windows(state, span=1000, dataset_id="d", n=5, samples=4)["windows"]
    assert len(windows) == 1 and windows[0]["chrom"] == "chr1"
