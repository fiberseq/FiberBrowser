"""Graph extras: shared visit fixtures, site sorts, repeat options and every annotation group."""
import copy
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from services.graph_panel import analysis, columns as gc, reads, site_sort
from services.read_columns import IntColumn


@pytest.fixture
def fixture():
    return json.loads((Path(__file__).parents[1] / "browser/frontend/src/features/graphPanel/fixtures/graphExtras.json").read_text())


def geometry(fixture, mode):
    res = fixture["topology"]
    return gc.region_columns(0, 0, 60, "target", gc.merge_occurrences([res], "target"),
        [gc.Observation("t", None), gc.Observation("s", "source")],
        {"source": gc.merge_occurrences([res], "source")}, {"source": {0: res}}, repeat_columns=mode)


def test_occurrence_columns_use_absolute_ids_and_do_not_mutate_tiles(fixture):
    before = copy.deepcopy(fixture)
    excluded = geometry(fixture, "exclude")
    assert not excluded.features and excluded.report["repeats"]
    kept = geometry(fixture, "by_occurrence")
    assert sum(f.length for f in kept.features) == fixture["expected_repeat_bp"]
    assert kept.features[0].nodes == ['["repeat","s-copy-a"]', '["repeat","s-copy-b"]']
    assert kept.features[0].blocks["s"] == [(0, 80, 30, 110, False)]
    assert fixture == before
    # Reversing responses and merging duplicate tiles does not renumber visits or change geometry.
    res = fixture["topology"]
    assert gc.merge_occurrences([res, res], "source") == gc.merge_occurrences([res], "source")
    fixture["topology"]["paths"].reverse()
    assert geometry(fixture, "by_occurrence").features == kept.features
    with pytest.raises(ValueError, match="repeat_columns"):
        geometry(fixture, "rank")


def test_repeat_option_validation_and_durable_geometry(fixture, monkeypatch):
    reg = SimpleNamespace(bindings=fixture["bindings"], maps=[{"target": "target", "source": "source"}])
    reg.binding = lambda k: next((b for b in reg.bindings if b["key"] == k), None)
    monkeypatch.setattr(reads, "read_bindings", lambda *_: [])
    body = {"target": "target", "regions": [{"start": 0, "end": 60}],
            "observations": [{"id": "t", "dataset_id": "d", "kind": "linear", "chrom": "chrA"}],
            "options": {"repeat_columns": "by_occurrence", "carrier_features": "drop"}}
    spec = analysis.parse(SimpleNamespace(datasets={"d": object()}), reg, body)
    assert spec["options"]["repeat_columns"] == "by_occurrence"
    assert spec["options"]["carrier_features"] == "drop"
    for key, value in (("repeat_columns", "rank"), ("carrier_features", "masked"), ("coverage_rule", "mask")):
        with pytest.raises(analysis.GraphRunError):
            analysis.parse(SimpleNamespace(datasets={"d": object()}), reg, {**body, "options": {key: value}})


def test_site_resolution_and_linear_fallback_alias(fixture):
    tiles = {"source": {0: fixture["topology"]}}
    site = site_sort.resolve_site(fixture["site"], "target", tiles)
    assert site["target_position"] is None and site["repeated"]
    assert site_sort.position_on_path(site, "source", tiles) == fixture["expected_source_position"]
    assert site_sort.position_on_path(site, "target", tiles) is None
    shared = site_sort.resolve_site({"binding": "source", "node": "left", "occurrence": "s-left", "offset": 7}, "target", tiles)
    assert shared["target_position"] == 7
    assert site_sort.position_on_path(shared, "target", tiles) == 7
    with pytest.raises(analysis.GraphRunError):
        site_sort.resolve_site({**fixture["site"], "offset": 40}, "target", tiles)


def test_site_sort_uses_containment_whole_sizes_and_missing_last():
    rows = [{"id": "a", "intervals": [[0, 100, 147]]},
            {"id": "b", "intervals": [[0, 100, -100]]},
            {"id": "c", "intervals": [[0, 40, 40]]}]
    assert site_sort.sort_rows(rows, 1050, 1000, "footprint") == ["a", "b", "c"]
    assert site_sort.sort_rows(rows, 1050, 1000, "accessibility") == ["b", "a", "c"]
    assert site_sort.site_value(rows[0], 1050, 1000, "rule", rule={"size_min": 140, "size_max": 160}) == 1
    assert site_sort.site_value(rows[2], 1050, 1000, "accessibility") is None
    gated = {"id": "synthetic", "intervals": [[0, 20, 147], [20, 30, -10], [30, 100, 147]], "qualities": [10, 240]}
    rule = {"size_min": 100, "quality_gates": [{"quality_name": "nq", "min_value": 200}]}
    assert site_sort.site_value(gated, 1050, 1000, "rule", rule=rule) == 1
    assert site_sort.site_value(gated, 1010, 1000, "rule", rule=rule) == 0


@pytest.mark.parametrize("columnar", [False, True])
def test_every_annotation_group_survives_transport_clip_and_budgets(columnar):
    iv = [[0, 20, 20], [40, 80, 40]]
    raw = IntColumn(np.asarray(iv, dtype=np.int64)) if columnar else iv
    row = {"id": "synthetic", "layers": {name: {"intervals": raw, "quality_names": ["code", "custom_byte"],
        "qualities": [[2, 3], [180, 220]]} for name in ["fpcls", "nfrvar", "nfrmol", "nucmol", "custom"]},
        "methyl_m5c": [5], "deam": [[9, 0]], "possible_deam_ct": [8],
        "live_lift": {"calls": {}, "call_parts": {}, "molecular_spans": [[0, 100, 0, 1, True]],
                      "record": "record", "source": {"contig": "chrA", "start": 100, "end": 200}}}
    wire = reads.compact_full(row, 100, "d", "source")
    assert set(wire["layers"]) == {"fpcls", "nfrvar", "nfrmol", "nucmol", "custom", "m5c", "deam", "deam_opportunity_ct"}
    assert wire["layers"]["custom"]["custom_byte"] == [180, 220]
    assert reads.marks_of(wire) == 13
    clipped = reads.clip_to_windows(wire, [[150, 160]])
    assert clipped["layers"]["custom"]["iv"] == [[140, 180, 40]]
    assert clipped["layers"]["custom"]["code"] == [3]
    assert "m5c" not in clipped["layers"] and reads.marks_of(clipped) == 5
    assert len(wire["layers"]["custom"]["iv"]) == 2


def test_site_request_uses_source_rows_and_preserves_scope(fixture, monkeypatch):
    reg = SimpleNamespace(bindings=fixture["bindings"], maps=[{"target": "target", "source": "source"}])
    reg.binding = lambda k: next((b for b in reg.bindings if b["key"] == k), None)
    monkeypatch.setattr(reads, "read_bindings", lambda *_: [{"dataset_id": "d", "kind": "lifted", "paths": {"source": "chrA"}}])
    async def tiles(*_):
        return {"source": {0: fixture["topology"]}}
    monkeypatch.setattr(analysis, "fetch_tiles", tiles)
    seen = []
    def rows(_state, source, start, end, _cache):
        seen.append(source.binding)
        return [{"id": "a", "intervals": [[0, end - start, 147]]},
                {"id": "b", "intervals": [[0, end - start, -140]]},
                {"id": "excluded", "intervals": [[0, end - start, 300]]}], {}
    monkeypatch.setattr(analysis, "graph_window_rows", rows)
    body = {"target": "target", "regions": [{"start": 0, "end": 60}], "site": fixture["site"],
            "observations": [{"id": "obs", "dataset_id": "d", "kind": "graph", "binding": "source", "read_ids": ["a", "b"]}]}
    result = asyncio.run(site_sort.handle(SimpleNamespace(datasets={"d": object()}), reg, body))
    assert seen == ["source"]
    assert result["site"]["target_position"] is None
    assert result["results"]["obs"]["read_sort_order"] == ["a", "b"]
    with pytest.raises(analysis.GraphRunError, match="coordinate-dependent"):
        asyncio.run(site_sort.handle(SimpleNamespace(datasets={"d": object()}), reg,
                                    {**body, "sort_by": "rule", "rule": {"conditions": [{"type": "gene"}]}}))


def test_unavailable_helper_returns_structured_fallback_without_changing_state(monkeypatch):
    from starlette.requests import Request
    from routers.graph_panel import graph_sort_site_route
    from services.graph_panel import service
    async def unavailable():
        return SimpleNamespace(available=False)
    monkeypatch.setattr(service, "ensure_ready", unavailable)
    async def receive():
        return {"type": "http.request", "body": b'{}', "more_body": False}
    state = SimpleNamespace(panels=[{"collapsedByGraphGroup": "host"}])
    before = copy.deepcopy(state.panels)
    response = asyncio.run(graph_sort_site_route(Request({"type": "http", "method": "POST", "path": "/api/graph/sort_site"}, receive), state))
    assert response.status_code == 503
    assert json.loads(response.body)["error"]["code"] == "helper_unavailable"
    assert state.panels == before


def test_session_transport_keeps_host_only_members_and_site_fallback_provenance(fixture):
    from services.sessions_endpoint import state_import_payload
    state = SimpleNamespace(dataset_order=[], datasets={}, gtf_data=None, fasta=None)
    frontend = {"panels": [{"id": "host", "viewMode": "linear", "graphView": {"role": "host",
        "runOptions": {"repeat_columns": "by_occurrence"}}, "graphSiteSort": {"site": fixture["site"], "order": ["a"]}},
        {"id": "member", "collapsed": True, "collapsedByGraphGroup": "host", "graphMemberOf": "host"}]}
    payload = state_import_payload(state, viewport={}, frontend=json.loads(json.dumps(frontend)))
    assert payload["frontend"] == frontend
    assert payload["frontend"]["panels"][1]["collapsed"] is True


def test_occurrence_run_fits_and_assigns_with_its_saved_geometry(fixture, monkeypatch):
    from state.browser_state import BrowserState
    state = BrowserState(None)
    state.datasets = {"d": SimpleNamespace(id="d", live_lift=None)}
    monkeypatch.setattr(analysis, "observation_snapshot", lambda *_: {"s": {"revision": "one"}})
    def rows(_state, _source, start, end, cache=None):
        width = end - start
        return [{"id": f"synthetic-{i}", "intervals": [[0, width, 147 if i % 2 else -width]]} for i in range(6)], {}
    monkeypatch.setattr(analysis, "graph_window_rows", rows)
    reg = SimpleNamespace(id="package", revisions={k: "one" for k in ("package", "graph", "db", "maps")})
    spec = {"target": "target", "target_size": 1000, "regions": [{"start": 0, "end": 60, "mode": "accessibility"}],
        "observations": [{"id": "s", "dataset_id": "d", "kind": "graph", "binding": "source", "contig": "chrA", "read_ids": None}],
        "binding_order": ["target", "source"], "options": {"repeat_columns": "by_occurrence", "carrier_features": "refine",
            "coverage_rule": "require_all", "insertions": True, "carrier_min_samples": 3}}
    tiles = {"source": {0: fixture["topology"]}}
    fitted = analysis.run(state, reg, {"method": "combinatorial", "k": 2}, tiles, spec=spec)
    assert any(f["kind"] == "insertion" and f["length"] == 80 for f in fitted["columns"]["shared"])
    assert fitted["columns"]["repeat_occurrences"] == {"s": 2}
    saved = json.loads(json.dumps({k: fitted[k] for k in ("stages", "label_ids", "settings", "revisions")}))
    assigned = analysis.assign(state, reg, {"run": saved}, tiles, spec=spec)
    assert assigned["results"]["s"]["assignments"] == fitted["results"]["s"]["assignments"]
    with pytest.raises(analysis.GraphRunError, match="geometry|changed"):
        analysis.assign(state, reg, {"run": saved}, tiles, spec={**spec, "options": {**spec["options"], "repeat_columns": "exclude"}})


def test_native_table_layers_enter_the_graph_cache_and_refresh_with_scan_revision(fixture, monkeypatch, tmp_path):
    from live_lift_fixtures import make_record, write_bam
    from services.scan import overlay
    bam = write_bam(tmp_path / "synthetic.bam", lambda h: [make_record(h, "synthetic", "chrA", 100, "300M",
        tags=[("MA", "300;nuc+Q:1-80,121-80,241-60")])], contigs=(("chrA", 1000),))
    dataset = SimpleNamespace(id="d", label="Synthetic", data_type="bam", paths=[bam], live_lift=None, is_remote=False)
    state = SimpleNamespace(datasets={"d": dataset}, chroms=[SimpleNamespace(name="chrA", size=1000)])
    reg = SimpleNamespace(id="package", bindings=fixture["bindings"], maps=[{"target": "target", "source": "source"}])
    reg.binding = lambda k: next((b for b in reg.bindings if b["key"] == k), None)
    scan = SimpleNamespace(scan_id="scan", manifest_digest="one")
    monkeypatch.setattr(overlay, "overlay_scans", lambda *_: [(scan, [], {})])
    calls = []
    def apply(_state, _did, _chrom, _start, _end, rows):
        calls.append(scan.manifest_digest)
        assert all(r["reference_start"] == 100 and r["reference_end"] == 400 and r["library_id"] == bam for r in rows)
        return [{**r, "layers": {**r.get("layers", {}), "fpcls": {"intervals": [[110 - _start, 130 - _start, 20]],
            "annotation_names": ["hit"], "quality_names": ["q0"], "qualities": [[1 if scan.manifest_digest == "one" else 2]]}}} for r in rows]
    monkeypatch.setattr(overlay, "apply_scan_overlays", apply)
    body = {"datasets": [{"dataset_id": "d"}], "paths": [{"binding": "target", "windows": [{"start": 0, "end": 500}]}]}
    reads.clear_cache()
    try:
        first = reads.load(state, reg, body)
        assert first["reads"][0]["layers"]["fpcls"]["q0"] == [1]
        assert first["reads"][0]["layers"]["fpcls"]["iv"] == [[110, 130, 20]]
        assert first["reads"][0]["layers"]["fpcls"]["annotation_names"] == ["hit"]
        assert reads.load(state, reg, body)["reads"] == first["reads"]
        assert calls == ["one"]
        scan.manifest_digest = "two"
        assert reads.load(state, reg, body)["reads"][0]["layers"]["fpcls"]["q0"] == [2]
        assert calls == ["one", "two"]
        budgeted = reads.load(state, reg, body, max_marks=0)
        assert budgeted["reads"][0]["calls_omitted"] and "layers" not in budgeted["reads"][0]
    finally:
        reads.clear_cache()
