"""M31 (UI audit): a nucleosome array's background accessibility (DAF-seq or
Fiber-seq linkers, ~35-45% of positions) sits above the default Medium
threshold (30%), so a 10 kb view at eve came back as one 4.8 kb "Medium peak"
drawn like the real one. Calls wider than ``max_peak_width`` are background,
not peaks: they are left out of ``peaks`` and reported under ``broad_peaks``."""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from models.requests import ScanPeaksRequest
from services import clustering_endpoint
from services.peak_scanning import DEFAULT_MAX_PEAK_WIDTH, build_peak_thresholds, detect_threshold_layers
from services.working_sets import WorkingSet

VIEW = 10_000
NDR = (6_000, 6_300)  # one real nucleosome-depleted region


def _array_read(i: int) -> dict:
    """A fiber over the whole view: 150 bp footprints, 100 bp accessible linkers
    (the scan's numerator is intervals below 90 bp, gaps included), open across
    the NDR. The phase differs per read, so the population is a flat ~40%
    accessible background around one fully open NDR."""
    phase = (i * 37) % 250
    blocks = []  # [start, end, size]
    for lo, hi in ((0, NDR[0]), (NDR[1], VIEW)):
        pos = lo - phase
        while pos < hi:
            for length, size in ((150, 150), (100, -100)):
                a, b = max(lo, pos), min(hi, pos + length)
                if b > a:
                    blocks.append([a, b, size if size > 0 else -(b - a)])
                pos += length
    blocks.append([NDR[0], NDR[1], -(NDR[1] - NDR[0])])
    return {"id": f"r{i}", "intervals": sorted(blocks)}


class _ArrayState:
    dataset_order = ["ds"]
    max_working_reads = None

    def __init__(self):
        self.datasets = {"ds": SimpleNamespace(cluster_assignments={})}

    def translate_chrom(self, chrom):
        return chrom

    def resolve_dataset_id(self, dataset_id=None):
        return "ds"

    def get_dataset(self, dataset_id):
        return self.datasets.get(dataset_id)

    def build_working_set(self, dataset_id, chrom, start, end, spanning=False, min_footprints=0, **kwargs):
        reads = [_array_read(i) for i in range(60)]
        return WorkingSet(reads, total_overlapping=len(reads), total_spanning=len(reads), chrom=chrom, start=start, end=end)


def _scan(**req):
    return clustering_endpoint.run_scan_peaks_endpoint(
        state=_ArrayState(), req=ScanPeaksRequest(**req), chrom="chr2R", start=0, end=VIEW,
        dataset_id="ds", spanning=False)


def test_background_accessibility_is_not_called_as_a_peak():
    result = _scan()
    widths = [p["width"] for p in result["peaks"]]
    assert widths and max(widths) <= DEFAULT_MAX_PEAK_WIDTH, widths
    # The real NDR is still the Strong peak.
    strong = [p for p in result["peaks"] if p["layer"] == 0]
    assert len(strong) == 1 and strong[0]["start"] < NDR[1] and strong[0]["end"] > NDR[0]
    # The plateau is reported, not lost.
    assert result["broad_peaks"] and all(b["width"] > DEFAULT_MAX_PEAK_WIDTH for b in result["broad_peaks"])
    assert sum(info["n_broad"] for info in result["layer_info"]) == len(result["broad_peaks"])
    # Indices stay 0..n-1 over the kept peaks (clustering refers to them).
    assert [p["index"] for p in result["peaks"]] == list(range(len(result["peaks"])))


def test_max_peak_width_zero_keeps_every_call():
    result = _scan(max_peak_width=0)
    assert max(p["width"] for p in result["peaks"]) > DEFAULT_MAX_PEAK_WIDTH
    assert result["broad_peaks"] == []


def test_a_broad_call_still_masks_lower_tiers():
    signal = np.full(5000, 0.4, dtype=np.float32)
    signal[2000:2300] = 0.8
    counts = np.full(5000, 100, dtype=np.int32)
    thresholds = build_peak_thresholds(0.5, 0.3, 0.15, 0.08, 5, 100)
    broad: list = []
    peaks, info = detect_threshold_layers(signal, counts, thresholds, 80, 5, 100, max_width=1000, broad_out=broad)
    assert [(p["start"], p["end"], p["layer"]) for p in peaks] == [(2000, 2300, 0)]
    # The 0.4 plateau is one broad Medium call on each side, not Weak/Rare pieces.
    assert {b["layer"] for b in broad} == {1} and len(broad) == 2
    assert [i["n_broad"] for i in info] == [0, 2, 0, 0]


DEMO_BAM = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "napa_ddda.bam"


@pytest.mark.skipif(not DEMO_BAM.exists(), reason="demo BAM not present")
def test_the_demos_peaks_are_unchanged(client, standalone_app):
    import server as srv
    from state.browser_state import BrowserState
    from state.runtime_state import set_browser_state
    from state import runtime_state
    previous, previous_runtime = srv.state, runtime_state._state
    srv.state = BrowserState(None, None, None, None)
    set_browser_state(srv.state)
    try:
        loaded = client.post("/api/demo/load").json()
        query = f"chrom=chr19&start=47514000&end=47518000&dataset_id={loaded['dataset_id']}"
        result = client.post(f"/api/scan_peaks?{query}", json={}).json()
        unlimited = client.post(f"/api/scan_peaks?{query}", json={"max_peak_width": 0}).json()
    finally:
        srv.state = previous
        set_browser_state(previous_runtime)
    assert result["broad_peaks"] == []
    assert [(p["start"], p["end"], p["layer"]) for p in result["peaks"]] == \
        [(p["start"], p["end"], p["layer"]) for p in unlimited["peaks"]]
    strong = [p for p in result["peaks"] if p["layer"] == 0]
    assert [(p["start"], p["end"]) for p in strong] == [(47514981, 47515677)]  # the NAPA promoter
