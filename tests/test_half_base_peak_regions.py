"""Footprint-class edges on half bases (fb-n1-bugs 1).

A lattice-recaller class's span is the median of its calls' edges, so it can
end on a half base (47515967.5). "Cluster reads by N footprints" stored those
edges as the clustering's peak regions, and the Projection tab then failed
with an opaque 422 (PeakRegion.start/end are int). Peak regions now take a
fractional edge and widen it outward (floor start, ceil end); a 422 that still
happens names the field in one readable line.
"""
import math

import pytest
from pydantic import ValidationError

from models.requests import DissolveClusterRequest, PeakRegion, ProjectionRequest
from services.footprint_endpoint import _whole_bases
from services.validation_errors import field_path, validation_message


def test_half_base_edges_widen_to_cover_the_class():
    region = PeakRegion(start=47515967.5, end=47516044.5, mode="tf")
    assert (region.start, region.end) == (47515967, 47516045)
    assert isinstance(region.start, int) and isinstance(region.end, int)


def test_whole_bases_and_integral_floats_are_unchanged():
    assert PeakRegion(start=100, end=150).model_dump()["start"] == 100
    region = PeakRegion(start=100.0, end=150.0)
    assert (region.start, region.end) == (100, 150)


def test_every_request_carrying_peak_regions_accepts_class_edges():
    regions = [{"start": 47515967.5, "end": 47515997.5, "mode": "accessibility"},
               {"start": 47516044.5, "end": 47516088.5, "mode": "tf"}]
    projection = ProjectionRequest(peak_regions=regions)
    assert [(r.start, r.end) for r in projection.peak_regions] == [(47515967, 47515998), (47516044, 47516089)]
    dissolve = DissolveClusterRequest(cluster_to_dissolve=0, current_assignments={}, peak_regions=regions)
    assert dissolve.peak_regions[1].end == 47516089


@pytest.mark.parametrize("bad", [math.nan, math.inf, True, "abc"])
def test_non_positions_are_still_rejected_naming_the_field(bad):
    with pytest.raises(ValidationError) as caught:
        PeakRegion(start=10, end=bad)
    assert caught.value.errors()[0]["loc"] == ("end",)


def test_footprint_sequences_cover_fractional_edges():
    assert _whole_bases(1000.5, 1010.5) == (1000, 1011)
    assert _whole_bases(1000, 1010) == (1000, 1010)


def test_field_path_reads_like_the_request():
    assert field_path(("body", "peak_regions", 0, "end")) == "peak_regions[0].end"
    assert field_path(("query", "start")) == "start (query)"
    assert field_path(("body",)) == "request body"


def test_validation_message_is_one_readable_line():
    errors = [{"type": "int_parsing", "loc": ("body", "peak_regions", 0, "end"),
               "msg": "Input should be a valid integer", "input": "abc"}] * 5
    text = validation_message(errors)
    assert text.startswith("Invalid request: peak_regions[0].end: Input should be a valid integer (got 'abc')")
    assert text.endswith("and 2 more")


def test_projection_with_class_edges_reaches_the_map_with_whole_bases(client, monkeypatch):
    import services.clustering_endpoint as clustering_endpoint
    seen = {}

    def fake_projection(*, state, req, chrom, start, end, spanning):
        seen["regions"] = [(r.start, r.end, r.mode) for r in req.peak_regions]
        return {"coords_x": [], "coords_y": []}

    monkeypatch.setattr(clustering_endpoint, "run_cluster_projection_endpoint", fake_projection)
    resp = client.post("/api/cluster_projection?chrom=chr19&start=47515000&end=47517000", json={
        "peak_regions": [{"start": 47515967.5, "end": 47516044.5, "mode": "tf"}],
    })
    assert resp.status_code == 200, resp.text
    assert seen["regions"] == [(47515967, 47516045, "tf")]


@pytest.mark.parametrize("bad", ["NaN", "Infinity"])
def test_a_non_finite_edge_is_a_readable_422(client, bad):
    # NaN / Infinity are what Python's json writes for those floats; the 422 body must still be JSON.
    body = '{"peak_regions": [{"start": 10, "end": %s, "mode": "tf"}]}' % bad
    resp = client.post("/api/cluster_projection?chrom=chr19&start=47515000&end=47517000", content=body,
                       headers={"Content-Type": "application/json"})
    assert resp.status_code == 422, resp.text
    payload = resp.json()
    assert payload["detail"][0]["loc"] == ["body", "peak_regions", 0, "end"]
    assert payload["message"].startswith("Invalid request: peak_regions[0].end:")
    assert "finite" in payload["message"]


def test_a_422_names_the_field_and_keeps_the_detail_list(client):
    resp = client.post("/api/cluster_projection?chrom=chr19&start=47515000&end=47517000", json={
        "peak_regions": [{"start": 10, "end": "abc", "mode": "tf"}],
    })
    assert resp.status_code == 422
    body = resp.json()
    assert isinstance(body["detail"], list) and body["detail"][0]["loc"] == ["body", "peak_regions", 0, "end"]
    assert body["message"].startswith("Invalid request: peak_regions[0].end:")
