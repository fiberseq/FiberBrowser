"""M15 (UI audit): "Go to reads" used a 20 kb window even for a ~700 bp
amplicon (a 5 px sliver). With ``fit`` the best-covered windows are narrowed
to the reads they hold, with a margin; long reads keep the requested span."""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pysam
import pytest

from test_find_reads_no_match import _bam

DEMO_BAM = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "napa_ddda.bam"


def _state(path: Path):
    ds = SimpleNamespace(id="amp", data_type="bam", paths=[str(path)])
    return SimpleNamespace(get_dataset=lambda i: ds if i == "amp" else None, dataset_order=["amp"], chroms=[])


@pytest.fixture(autouse=True)
def _fresh_cache():
    import services.random_window as rw
    rw._TOP_WINDOW_CACHE.clear()
    yield
    rw._TOP_WINDOW_CACHE.clear()


def test_an_amplicon_window_is_fitted_to_its_reads(tmp_path):
    from services.random_window import top_covered_windows
    # 300 copies of a 650 bp amplicon at 50,000 on a 200 kb contig.
    bam = _bam(tmp_path, "amp.bam", {"chr2L": 200_000}, [("chr2L", 50_000, 650)] * 300)
    res = top_covered_windows(_state(bam), span=20_000, dataset_id="amp", n=3, samples=20, fit=True)
    first = res["windows"][0]
    assert first["fitted"] is True
    assert first["start"] <= 50_000 and first["end"] >= 50_650          # the whole amplicon
    assert 650 < first["end"] - first["start"] <= 650 + 2 * 100 + 1    # plus a small margin

    unfitted = top_covered_windows(_state(bam), span=20_000, dataset_id="amp", n=3, samples=20)
    assert unfitted["windows"][0]["end"] - unfitted["windows"][0]["start"] == 20_000
    assert "fitted" not in unfitted["windows"][0]


def test_reads_wider_than_the_view_keep_the_span(tmp_path):
    from services.random_window import top_covered_windows
    bam = _bam(tmp_path, "long.bam", {"chr1": 200_000}, [("chr1", 40_000 + 500 * i, 15_000) for i in range(40)])
    res = top_covered_windows(_state(bam), span=10_000, dataset_id="amp", n=2, samples=20, fit=True)
    first = res["windows"][0]
    assert first["end"] - first["start"] == 10_000 and "fitted" not in first


def test_an_amplicon_longer_than_the_view_is_shown_whole(tmp_path):
    from services.random_window import top_covered_windows
    # A 3 kb amplicon (an amplicon set's second locus) while the view is 2 kb wide.
    bam = _bam(tmp_path, "amp3k.bam", {"chr2L": 200_000}, [("chr2L", 80_000 + (i % 5), 3_040) for i in range(200)])
    first = top_covered_windows(_state(bam), span=2_000, dataset_id="amp", n=1, samples=20, fit=True)["windows"][0]
    assert first["fitted"] is True
    assert first["start"] <= 80_000 and first["end"] >= 83_044
    assert first["end"] - first["start"] <= 3_044 + 2 * 305 + 1


def test_tiling_fragments_never_widen_the_view(tmp_path):
    from services.random_window import top_covered_windows
    # 1.5 kb fragments starting every 50 bp: they cover the whole 2 kb view.
    bam = _bam(tmp_path, "tile.bam", {"chr1": 200_000}, [("chr1", 50_000 + 50 * i, 1_500) for i in range(200)])
    first = top_covered_windows(_state(bam), span=2_000, dataset_id="amp", n=1, samples=20, fit=True)["windows"][0]
    assert first["end"] - first["start"] == 2_000 and "fitted" not in first


def test_one_long_amplicon_is_offered_once(tmp_path):
    from services.random_window import top_covered_windows
    # A 6 kb amplicon seen at a 1 kb zoom: several best windows lie inside it.
    bam = _bam(tmp_path, "amp6k.bam", {"chr2L": 200_000}, [("chr2L", 60_000 + (i % 3), 6_000) for i in range(150)])
    windows = top_covered_windows(_state(bam), span=1_000, dataset_id="amp", n=5, samples=40, fit=True)["windows"]
    fitted = [(w["start"], w["end"]) for w in windows if w.get("fitted")]
    assert len(fitted) == 1
