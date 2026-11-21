"""Plots and the uncalled-reads rule: reads without footprint calls are left out of the reads Plots counts (region reads
for BED profiles and summaries, BED size plots, view size plots) at every Min footprints threshold, and come back only
with "All reads, including uncalled" (the frontend's -1, sent as hide_uncalled=false on every request)."""
from array import array

import pysam
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from test_circular_origin_spanning import CONTIG, L, _record, _sequence, _state


@pytest.fixture
def client(tmp_path):
    header = pysam.AlignmentHeader.from_dict({"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": CONTIG, "LN": L}]})
    tags = {"ns": array("i", [150]), "nl": array("i", [100])}
    records = [_record(header, "called", 100, 300, _sequence(), tags=tags),
               _record(header, "uncalled", 100, 300, _sequence(), tags={}),
               _record(header, "empty_groups", 100, 300, _sequence(), tags={"MA": "200;nuc.Q:;msp.:"})]
    path = tmp_path / "uncalled.bam"
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for read in records:
            out.write(read)
    pysam.index(str(path))
    state = _state({"bam": str(path)})
    import routers.files as files_router
    import routers.clustering_visualization as cv
    from services.signal_evidence import SignalFilterMiddleware
    app = FastAPI()
    app.include_router(files_router.router)
    app.include_router(cv.router)
    app.add_middleware(SignalFilterMiddleware)
    app.dependency_overrides[files_router.get_state] = lambda: state
    app.dependency_overrides[cv.get_state] = lambda: state
    return TestClient(app)


SETS = [{"id": "s", "regions": [[CONTIG, 190, 210, "+", "r"]]}]


def _names(client, query=""):
    body = client.post(f"/api/plots/region_reads{query}", json={"sets": SETS, "dataset_ids": ["wrap"], "subsample": "all", "flank_bp": 80}).json()
    return sorted(row[5] for region in body["regions"] for row in region["reads"].get("wrap", []))


def test_region_reads_leave_uncalled_reads_out_by_default(client):
    assert _names(client) == ["called"]
    assert _names(client, "?hide_uncalled=false") == ["called", "empty_groups", "uncalled"]


def test_size_plots_count_only_called_reads_by_default(client):
    url = f"/api/cluster/vplot?chrom={CONTIG}&region_start=100&region_end=300"
    body = {"size_min": 0, "size_max": 200, "size_bin": 10, "pos_bin": 10, "raw_values": True, "group_by": "all", "normalization": "raw", "mode": "midpoint"}
    hidden = client.post(url, json=body).json()["data"]["wrap"]["-1"]["n_reads"]
    shown = client.post(url + "&hide_uncalled=false", json=body).json()["data"]["wrap"]["-1"]["n_reads"]
    assert (hidden, shown) == (1, 3)
    bed = {"sets": SETS, "dataset_ids": ["wrap"], "subsample": "all", "flank_bp": 80, "size_min": 10, "size_max": 200, "size_bin": 10, "pos_bin": 10, "phase": "count"}
    assert client.post("/api/plots/bed_sizes", json=bed).json()["groups"]["s|wrap"]["n_reads"] == 1
    assert client.post("/api/plots/bed_sizes?hide_uncalled=false", json=bed).json()["groups"]["s|wrap"]["n_reads"] == 3
