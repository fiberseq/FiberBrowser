"""Unit tests for the lightweight Python client request mapping."""

import base64
import io
import json

from browser_client import BrowserClient


PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
)


class DummyClient(BrowserClient):
    def __init__(self):
        self.url = "http://test"
        self.calls = []

    def _get(self, endpoint: str, params: dict = None) -> dict:
        self.calls.append(("GET", endpoint, params or {}))
        if endpoint == "/api/jupyter/reads":
            return {"reads": [{"id": "jr1"}]}
        if endpoint == "/api/jupyter/browser_order":
            if params and params.get("dataset_id") == "primary":
                return {"read_ids": ["read_a", "read_b"]}
            return {"read_ids": ["r_screen_1", "r_screen_2"]}
        if endpoint == "/api/jupyter/filter":
            return {"read_ids": ["r_filter_1", "r_filter_2"], "active": True}
        if endpoint == "/api/jupyter/selection":
            if params and params.get("dataset_id") == "ds1":
                return {"read_ids": ["read_ds1"], "dataset_id": "ds1"}
            return {"read_ids": ["selected_a"]}
        if endpoint == "/api/jupyter/custom_reads/custom_ds":
            return {"reads": [{"id": "custom_r1", "intervals": [[10, 20]]}], "count": 1}
        if endpoint == "/api/jupyter/markers":
            return {"markers": [{"id": "marker-1", "group": "peaks"}]}
        if endpoint == "/api/jupyter/footprint_colors":
            return {"footprint_colors": [{"id": "color-1", "group": "hits"}]}
        if endpoint == "/api/linked/sessions":
            return {"sessions": [{"id": "linked-1", "n_reads": 2}]}
        if endpoint == "/api/linked/session/linked-1":
            return {"id": "linked-1", "version": 3, "n_reads": 2}
        if endpoint == "/api/linked/reads/data":
            return {"reads": [{"read_id": "r1"}], "n_reads": 1}
        if endpoint == "/api/linked/reads/compact":
            return {"reads": [{"id": "r1"}], "count": 1}
        if endpoint == "/api/primers":
            return getattr(self, "primer_response", {"success": False, "message": "No primers designed"})
        if endpoint == "/api/jupyter/settings":
            return {
                "settings": {
                    "analysis_sample_seed": "paper-v1",
                    "analysis_sample_count": None,
                    "display_sample_count": 500,
                    "read_display_mode": "sample",
                    "all_reads_display_cap": 10000,
                    "background_read_cap": 750,
                    "spanning_only": True,
                    "cluster_method": "kmeans",
                    "cluster_k": 10,
                    "small_footprint_threshold_bp": 90,
                    "accessibility_threshold": 0.45,
                    "selected_peak_count": 2,
                    "peaks_locked": True,
                    "peak_rules": [{"id": "rule-a", "source": "tf_layer", "enabled": True}],
                    "peak_modes": {"7": "accessibility"},
                    "cluster_feature_rules": [{"id": "cluster-tf", "terms": [{"source": "layer", "layer": "tf"}]}],
                    "analysis_sort_rules": [{"id": "sort-pol2", "terms": [{"source": "transcription_state", "transcriptionState": "pause"}], "metric": "count"}],
                    "analysis_filter_rules": [{"id": "filter-fire", "terms": [{"source": "layer", "layer": "fire"}], "metric": "count", "operator": "gte", "threshold": 1}],
                    "active_colormap": {
                        "name": "Paper labels",
                        "backgroundColor": "#ffffff",
                        "readBackgroundColor": "#f1f5f9",
                        "noReadBackgroundColor": "#ffffff",
                        "rules": [],
                        "layerOpacities": {"nuc": 1, "tf": 0.9, "fire": 0.55},
                        "displaySmoothing": {"enabled": False, "sigmaX": 0, "sigmaY": 0},
                        "qualityFilters": [],
                    },
                    "selected_peaks": [7],
                    "peaks_by_rule": {"rule-a": [{"index": 7, "start": 200, "end": 260}]},
                    "selected_genes": [{"id": "tx1", "name": "GeneA", "chrom": "chr2L", "start": 100, "end": 300, "strand": "+", "exons": []}],
                    "transcription_state_filters": {"pause": True, "pic": False, "elongating": None},
                    "primer_saved_primers": [{"name": "PrimerA", "pair": {"fwd_seq": "ATGC", "rev_seq": "GCAT"}, "chrom": "chr2L"}],
                    "primer_mode": "standard",
                    "primer_cart_track_display": "design",
                    "capture_regions": [{"id": "cap1", "chrom": "chr2L", "start": 100, "end": 200}],
                    "capture_padding": 25,
                    "active_quality_filters": [{"layer": "fire", "quality_name": "aq", "min_value": 230}],
                    "catalog": [{"id": "cat1", "kind": "bigbed", "label": "TF"}],
                    "composite_tracks": [{"id": "comp1", "label": "TF track"}],
                    "saved_tracks": [{"id": "saved1", "name": "TF saved"}],
                    "enabled_mod_types": {"nuc": True, "tf": True, "fire": False},
                    "enabled_meta_profiles": {"nuc": True, "tf": True},
                    "cached_layer_types": {"tf": True, "fire": False},
                    "click_target_layer": "tf",
                    "footprint_analysis_layer": "tf",
                    "fill_read_height": True,
                    "coacc_settings": {
                        "coaccTrackMode": "heatmap",
                        "coaccSignalType": "small_fp",
                        "coaccLayer": "tf",
                        "coaccNormalization": "correlation",
                        "coaccBinSize": 100,
                    },
                    "read_row_height": 12,
                    "show_coverage_histogram": True,
                    "max_region_for_reads": 250000,
                    "show_genome_overview": False,
                    "session_manifest": {
                        "sessionName": "Paper session",
                        "generatedAt": "2026-04-30T00:00:00Z",
                        "viewport": {"chrom": "chr2L", "start": 100, "end": 200},
                        "reference": {"genome": "dm6"},
                        "datasets": [{"label": "primary", "paths": ["/tmp/a.bam"], "layers": ["nuc", "tf"]}],
                        "labeling": {
                            "presetName": "Paper labels",
                            "rules": 0,
                            "enabledRules": 0,
                            "readBackgroundColor": "#f1f5f9",
                            "noReadBackgroundColor": "#ffffff",
                            "displaySmoothing": {"enabled": False, "sigmaX": 0, "sigmaY": 0},
                            "layerOpacities": {"nuc": 1, "tf": 0.9, "fire": 0.55},
                            "qualityFilters": [],
                        },
                        "reproducibility": {
                            "seed": "paper-v1",
                            "analysisCap": None,
                            "displayCap": 500,
                            "displayMode": "sample",
                            "allReadsDisplayCap": 10000,
                            "selectedPeaks": 1,
                            "peaksLocked": True,
                            "clusterMethod": "kmeans",
                            "clusterK": 10,
                            "footprintRules": {"total": 1, "enabled": 1, "pinned": 1, "layers": ["TF"]},
                        },
                        "warnings": [],
                    },
                }
            }
        if endpoint == "/api/jupyter/analysis_state":
            return {
                "manifest": {"sessionName": "Paper session"},
                "reproducibility": {"analysis_sample_seed": "paper-v1"},
                "peaks_locked": True,
                "peak_rules": [{"id": "rule-a", "source": "tf_layer", "enabled": True}],
                "selected_peaks": [7],
                "peak_modes": {"7": "accessibility"},
                "selected_peak_count": 1,
                "peaks_by_rule": {"rule-a": [{"index": 7, "start": 200, "end": 260}]},
                "analysis_rules": {
                    "cluster_feature_rules": [{"id": "cluster-tf", "terms": [{"source": "layer", "layer": "tf"}]}],
                    "analysis_sort_rules": [{"id": "sort-pol2", "terms": [{"source": "transcription_state", "transcriptionState": "pause"}], "metric": "count"}],
                    "analysis_filter_rules": [{"id": "filter-fire", "terms": [{"source": "layer", "layer": "fire"}], "metric": "count", "operator": "gte", "threshold": 1}],
                },
                "capture_regions": [{"id": "cap1", "chrom": "chr2L", "start": 100, "end": 200}],
                "capture_padding": 25,
                "selected_genes": [{"id": "tx1", "name": "GeneA", "chrom": "chr2L", "start": 100, "end": 300, "strand": "+", "exons": []}],
                "transcription_state_filters": {"pause": True, "pic": False, "elongating": None},
                "primers": {
                    "saved_primers": [{"name": "PrimerA", "pair": {"fwd_seq": "ATGC", "rev_seq": "GCAT"}, "chrom": "chr2L"}],
                    "mode": "standard",
                    "cart_track_display": "design",
                },
                "active_colormap": {
                    "name": "Paper labels",
                    "backgroundColor": "#ffffff",
                    "readBackgroundColor": "#f1f5f9",
                    "noReadBackgroundColor": "#ffffff",
                    "rules": [],
                    "layerOpacities": {"nuc": 1, "tf": 0.9, "fire": 0.55},
                    "displaySmoothing": {"enabled": False, "sigmaX": 0, "sigmaY": 0},
                    "qualityFilters": [],
                },
                "active_quality_filters": [{"layer": "fire", "quality_name": "aq", "min_value": 230}],
                "display": {
                    "read_display_mode": "sample",
                    "all_reads_display_cap": 10000,
                    "enabled_mod_types": {"nuc": True, "tf": True, "fire": False},
                    "enabled_meta_profiles": {"nuc": True, "tf": True},
                    "cached_layer_types": {"tf": True, "fire": False},
                    "click_target_layer": "tf",
                    "footprint_analysis_layer": "tf",
                    "fill_read_height": True,
                    "read_row_height": 12,
                    "show_coverage_histogram": True,
                    "max_region_for_reads": 250000,
                    "show_genome_overview": False,
                },
                "coaccessibility": {
                    "coaccTrackMode": "heatmap",
                    "coaccSignalType": "small_fp",
                    "coaccLayer": "tf",
                    "coaccNormalization": "correlation",
                    "coaccBinSize": 100,
                },
                "catalog": [{"id": "cat1", "kind": "bigbed", "label": "TF"}],
                "composite_tracks": [{"id": "comp1", "label": "TF track"}],
                "saved_tracks": [{"id": "saved1", "name": "TF saved"}],
                "footprint_groups": [{"id": "fg1", "name": "TF class", "enabled": True, "sizeMin": 1, "sizeMax": 30, "layer": "tf"}],
                "active_panels": [{"id": "panel-cluster-detail", "content_type": "cluster-detail"}],
                "hidden_strip_panels": ["history"],
                "clusters": {
                    "assignments": {"primary": {"read_a": 0}},
                    "order": {"primary": [0]},
                    "read_sort_order": {"primary": ["read_a"]},
                },
            }
        if endpoint == "/api/jupyter/session_manifest":
            return {
                "manifest": {
                    "sessionName": "Paper session",
                    "generatedAt": "2026-04-30T00:00:00Z",
                    "viewport": {"chrom": "chr2L", "start": 100, "end": 200},
                    "reference": {"genome": "dm6"},
                    "datasets": [{"label": "primary", "paths": ["/tmp/a.bam"], "layers": ["nuc", "tf"]}],
                    "labeling": {
                        "presetName": "Paper labels",
                        "rules": 0,
                        "enabledRules": 0,
                        "readBackgroundColor": "#f1f5f9",
                        "noReadBackgroundColor": "#ffffff",
                        "displaySmoothing": {"enabled": False, "sigmaX": 0, "sigmaY": 0},
                        "layerOpacities": {"nuc": 1, "tf": 0.9, "fire": 0.55},
                        "qualityFilters": [],
                    },
                    "reproducibility": {
                        "seed": "paper-v1",
                        "analysisCap": None,
                        "displayCap": 500,
                        "selectedPeaks": 1,
                        "peaksLocked": True,
                        "clusterMethod": "kmeans",
                        "clusterK": 10,
                        "footprintRules": {"total": 1, "enabled": 1, "pinned": 1, "layers": ["TF"]},
                    },
                    "warnings": [],
                }
            }
        if endpoint == "/api/jupyter/region":
            return {"chrom": "chr1", "start": 100, "end": 500}
        if endpoint == "/api/jupyter/peaks":
            return {
                "peaks": [
                    {
                        "index": 7,
                        "chrom": "2R",
                        "start": 200,
                        "end": 260,
                        "layer": 2,
                        "score": 0.456,
                        "threshold": 0.15,
                        "isCustom": False,
                        "isSelected": True,
                        "ruleId": "rule-a",
                        "ruleName": "TF layer",
                        "source": "tf_layer",
                        "mode": "tf_layer",
                        "color": "#00aabb",
                    }
                ]
            }
        if endpoint == "/api/jupyter/clusters":
            return {
                "assignments": {"read_b": 1, "read_a": 1, "read_c": 2},
                "cluster_patterns": {1: [1, 0], 2: [0, 1]},
            }
        if endpoint == "/api/datasets":
            return {"datasets": [{"id": "primary", "label": "Primary sample"}]}
        if endpoint == "/api/reads/compact":
            return {"reads": [{"id": "r1"}]}
        if endpoint == "/api/reads/compact_all":
            return {
                "datasets": {
                    "primary": {
                        "reads": [{"id": "p1"}],
                        "display_count": 1,
                        "working_count": 8,
                        "total_in_scope": 13,
                        "total_spanning": 11,
                    },
                    "secondary": {
                        "reads": [{"id": "s1"}],
                        "display_count": 1,
                        "working_count": 2,
                        "total_in_scope": 3,
                        "total_spanning": 3,
                    },
                }
            }
        if endpoint == "/api/quality_filters":
            return {"filters": [{"layer": "fire", "quality_name": "aq", "min_value": 230}]}
        if endpoint == "/api/coacc/matrix/data":
            return {
                "matrix": [[1.0, None], [0.5, 1.0]],
                "chrom": params["chrom"],
                "start": params["start"],
                "end": params["end"],
                "bin_size": 100,
                "n_bins": 2,
                "n_reads": 10,
            }
        if endpoint == "/api/coacc/metadata":
            return {"n_bins": 2, "n_reads": 10}
        if endpoint == "/api/tracks/3/annotations":
            return {"intervals": [{"start": 10, "end": 20}]}
        if endpoint == "/api/microc/arcs":
            return {"arcs": [{"start": 100, "end": 1000}]}
        if endpoint == "/api/annotations/browse":
            return {"files": [{"name": "tf.bb", "path": "/tmp/tf.bb"}]}
        if endpoint == "/api/annotations/region":
            return {"annotations": {}, "types": []}
        return {}

    def _post(self, endpoint: str, data: dict = None, params: dict = None) -> dict:
        self.calls.append(("POST", endpoint, data or {}, params or {}))
        if endpoint == "/api/scan_peaks":
            return {"peaks": [{"start": 120, "end": 180, "layer": 0}]}
        if endpoint.startswith("/api/footprint/analyze"):
            return {"success": True}
        if endpoint == "/api/footprint/derived_layers/export":
            return {"success": True, "bundles": [{"dataset_id": "primary", "n_rows": 1}]}
        if endpoint == "/api/footprint/derived_layers/load":
            return {"success": True, "attached": [{"dataset_id": "ds1", "layer_ids": ["short_tf"]}]}
        if endpoint == "/api/footprint/rules/save":
            return {"success": True, "path": "/tmp/cart.fiberlayer-rules.json", "n_rules": len((data or {}).get("groups", []))}
        if endpoint == "/api/footprint/rules/load":
            return {
                "success": True,
                "path": (data or {}).get("path"),
                "groups": [{"id": "loaded", "name": "Loaded TF", "enabled": True, "sizeMin": 1, "sizeMax": 40, "layer": "tf"}],
                "n_rules": 1,
            }
        if endpoint == "/api/linked/session/create":
            return {"success": True, "session_id": "linked-1"}
        if endpoint == "/api/linked/session/linked-1/send":
            return {
                "success": True,
                "n_reads": 2,
                "version": 4,
                "contact_mode": (data or {}).get("contact_mode"),
                "split_view_mode": (data or {}).get("split_view_mode"),
            }
        if endpoint == "/api/session/export":
            return {
                "version": "2.0",
                "viewport": {
                    "chrom": (data or {}).get("chrom"),
                    "start": (data or {}).get("start"),
                    "end": (data or {}).get("end"),
                },
                "frontend": (data or {}).get("frontend_state", {}),
            }
        if endpoint == "/api/jupyter/settings":
            return {"success": True, "updated": sorted((data or {}).keys())}
        if endpoint == "/api/jupyter/actions":
            return {"success": True, "queued": len((data or {}).get("actions", [])), "label": (data or {}).get("label")}
        if endpoint == "/api/reads/stats":
            return {
                "per_read": [
                    {
                        "read_id": "r1",
                        "dataset_id": "ds1",
                        "aligned_span": 101,
                        "footprint_count": 3,
                        "avg_footprint_size": 42.0,
                        "accessibility_pct": 12.5,
                        "methyl_count": None,
                        "methyl_pct": None,
                        "mapq": 60,
                        "strand": "+",
                    },
                    {
                        "read_id": "r2",
                        "dataset_id": "ds1",
                        "aligned_span": 202,
                        "footprint_count": 5,
                        "avg_footprint_size": 55.0,
                        "accessibility_pct": 25.0,
                        "methyl_count": 1,
                        "methyl_pct": 0.5,
                        "mapq": 50,
                        "strand": "-",
                    },
                ],
                "aggregate": {},
                "requested_count": 2,
                "found_count": 2,
            }
        return {}

    def _delete(self, endpoint: str, params: dict = None) -> dict:
        self.calls.append(("DELETE", endpoint, params or {}))
        return {}

    def _get_bytes(self, endpoint: str, params: dict = None, timeout: int = 60) -> bytes:
        self.calls.append(("GET_BYTES", endpoint, params or {}, timeout))
        return b"PNG"

    def get_region(self) -> dict:
        return {"chrom": "chr1", "start": 100, "end": 500}


class NonPrimaryDatasetClient(DummyClient):
    def _get(self, endpoint: str, params: dict = None) -> dict:
        if endpoint == "/api/datasets":
            self.calls.append(("GET", endpoint, params or {}))
            return {"datasets": [{"id": "sample_a", "label": "Sample A"}]}
        if endpoint == "/api/reads/compact_all":
            self.calls.append(("GET", endpoint, params or {}))
            return {
                "datasets": {
                    "sample_a": {"reads": [{"id": "real1"}]},
                    "sample_b": {"reads": [{"id": "real2"}]},
                }
            }
        return super()._get(endpoint, params=params)


def test_browser_client_reuses_persistent_http_session():
    class FakeResponse:
        content = b"BYTES"

        def raise_for_status(self):
            return None

        def json(self):
            return {"ok": True}

    class FakeSession:
        def __init__(self):
            self.calls = []
            self.closed = False

        def get(self, url, params=None, timeout=None):
            self.calls.append(("GET", url, params, timeout))
            return FakeResponse()

        def post(self, url, json=None, params=None, timeout=None, files=None):
            self.calls.append(("POST", url, json, params, timeout, files))
            return FakeResponse()

        def delete(self, url, params=None, timeout=None):
            self.calls.append(("DELETE", url, params, timeout))
            return FakeResponse()

        def close(self):
            self.closed = True

    session = FakeSession()
    client = BrowserClient.__new__(BrowserClient)
    client.url = "http://test"
    client._session = session

    assert client._get("/api/status", {"x": 1}) == {"ok": True}
    assert client._post("/api/update", {"y": 2}, {"q": 3}) == {"ok": True}
    assert client._delete("/api/delete", {"z": 4}) == {"ok": True}
    assert client._get_bytes("/api/image", {"w": 5}, timeout=7) == b"BYTES"
    assert client._post_bytes("/api/render", {"r": 6}, timeout=8) == b"BYTES"
    client.close()

    assert session.calls == [
        ("GET", "http://test/api/status", {"x": 1}, 30),
        ("POST", "http://test/api/update", {"y": 2}, {"q": 3}, 30, None),
        ("DELETE", "http://test/api/delete", {"z": 4}, 30),
        ("GET", "http://test/api/image", {"w": 5}, 7),
        ("POST", "http://test/api/render", {"r": 6}, None, 8, None),
    ]
    assert session.closed is True


def test_save_session_embeds_frontend_reproducibility_state(tmp_path):
    client = DummyClient()
    out = tmp_path / "session.json"

    result = client.save_session(str(out))

    post_call = [call for call in client.calls if call[0] == "POST" and call[1] == "/api/session/export"][0]
    body = post_call[2]
    assert body["chrom"] == "chr1"
    assert body["start"] == 100
    assert body["end"] == 500
    assert body["frontend_state"]["analysis_sample_seed"] == "paper-v1"
    assert body["frontend_state"]["peaks_locked"] is True
    assert body["frontend_state"]["peak_rules"][0]["id"] == "rule-a"
    assert result["frontend"]["active_quality_filters"] == [{"layer": "fire", "quality_name": "aq", "min_value": 230}]
    assert '"analysis_sample_seed": "paper-v1"' in out.read_text()


def test_save_session_can_omit_frontend_state(tmp_path):
    client = DummyClient()
    out = tmp_path / "session.json"

    client.save_session(str(out), include_frontend_state=False)

    post_call = [call for call in client.calls if call[0] == "POST" and call[1] == "/api/session/export"][0]
    assert "frontend_state" not in post_call[2]


def test_get_compact_reads_maps_selective_layers():
    client = DummyClient()

    reads = client.get_compact_reads(
        include_methylation=False,
        layer_names=["tf", "msp"],
        max_reads=250,
        infer_legacy_layers=False,
        legacy_nuc_min_size=120,
        sample_seed="seed-display",
    )

    assert reads == [{"id": "r1"}]
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/reads/compact"
    assert params["include_layers"] == "true"
    assert params["layer_names"] == "tf,fire"
    assert params["include_methylation"] == "false"
    assert params["max_reads"] == 250
    assert params["infer_legacy_layers"] == "false"
    assert params["legacy_nuc_min_size"] == 120
    assert params["sample_seed"] == "seed-display"


def test_get_reads_maps_sample_seed_to_jupyter_reads():
    client = DummyClient()

    reads = client.get_reads(
        dataset_id="ds1",
        spanning=False,
        min_footprints=3,
        as_dataframe=False,
        sample_seed="seed-working",
    )

    assert reads == [{"id": "jr1"}]
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/jupyter/reads"
    assert params == {
        "spanning": "false",
        "dataset_id": "ds1",
        "min_footprints": 3,
        "sample_seed": "seed-working",
    }


def test_get_all_reads_parses_compact_all_shape_and_disables_cap():
    client = DummyClient()

    reads = client.get_all_reads(
        dataset_id="primary",
        layer_names="tf",
        infer_legacy_layers=True,
        legacy_nuc_min_size=80,
        profile_max_reads=1000,
        sample_seed="seed-all",
    )

    assert reads == [{"id": "p1"}]
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/reads/compact_all"
    assert params["dataset_id"] == "primary"
    assert params["max_reads"] == 0
    assert params["include_layers"] == "true"
    assert params["layer_names"] == "tf"
    assert params["infer_legacy_layers"] == "true"
    assert params["legacy_nuc_min_size"] == 80
    assert params["profile_max_reads"] == 1000
    assert params["sample_seed"] == "seed-all"


def test_get_all_reads_response_exposes_compact_all_count_metadata():
    client = DummyClient()

    payload = client.get_all_reads_response(dataset_id="primary", max_reads=500)

    assert payload["datasets"]["primary"]["reads"] == [{"id": "p1"}]
    assert payload["datasets"]["primary"]["display_count"] == 1
    assert payload["datasets"]["primary"]["working_count"] == 8
    assert payload["datasets"]["primary"]["total_in_scope"] == 13
    assert payload["datasets"]["primary"]["total_spanning"] == 11
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/reads/compact_all"
    assert params["dataset_id"] == "primary"
    assert params["max_reads"] == 500


def test_get_all_reads_resolves_legacy_primary_to_file_dataset_id():
    client = NonPrimaryDatasetClient()

    assert client.resolve_dataset_id("primary") == "sample_a"
    assert client.get_all_reads(dataset_id="primary") == [{"id": "real1"}]
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/reads/compact_all"
    assert params["dataset_id"] == "sample_a"
    assert client.get_all_reads() == [{"id": "real1"}]


def test_get_coacc_matrix_maps_layer_and_read_ids():
    client = DummyClient()

    matrix = client.get_coacc_matrix(
        chrom="chr2L",
        start=1000,
        end=2000,
        dataset_id="ds1",
        signal_type="small_fp",
        layer="tf",
        read_ids=["r1", "r2"],
        sample_seed="seed-coacc",
        as_dataframe=False,
    )

    assert matrix.shape == (2, 2)
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/coacc/matrix/data"
    assert params["dataset_ids"] == "ds1"
    assert params["signal_type"] == "small_fp"
    assert params["layer"] == "tf"
    assert params["read_ids"] == "r1,r2"
    assert params["sample_seed"] == "seed-coacc"

    client.get_coacc_matrix_data(
        chrom="chr2L",
        start=1000,
        end=2000,
        dataset_ids=["ds1", "ds2"],
        normalization="raw",
        min_coverage=5,
        read_ids=["r1"],
        read_ids_by_dataset={"ds1": ["r1"], "ds2": ["r2"]},
        signal_type="small_fp",
        layer="msp",
        bin_size=50,
        sample_seed="seed-matrix",
    )
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/coacc/matrix/data"
    assert params == {
        "chrom": "chr2L",
        "start": 1000,
        "end": 2000,
        "bin_size": 50,
        "dataset_ids": "ds1,ds2",
        "normalization": "raw",
        "min_coverage": 5,
        "read_ids": "r1",
        "read_ids_by_dataset": '{"ds1": ["r1"], "ds2": ["r2"]}',
        "signal_type": "small_fp",
        "layer": "fire",
        "sample_seed": "seed-matrix",
    }

    client.get_coacc_matrix_data(
        chrom="chr2L",
        start=1000,
        end=2000,
        dataset_ids=["ds1", "ds2"],
        read_ids_by_dataset={"ds1": [], "ds2": ["r2"]},
    )
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/coacc/matrix/data"
    assert json.loads(params["read_ids_by_dataset"]) == {"ds1": [], "ds2": ["r2"]}


def test_get_coacc_metadata_maps_layer():
    client = DummyClient()

    result = client.get_coacc_metadata(
        layer="msp",
        normalization="correlation",
        read_ids=["a"],
        sample_seed="seed-meta",
    )

    assert result == {"n_bins": 2, "n_reads": 10}
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/coacc/metadata"
    assert params["chrom"] == "chr1"
    assert params["layer"] == "fire"
    assert params["normalization"] == "correlation"
    assert params["read_ids"] == "a"
    assert params["sample_seed"] == "seed-meta"

    client.get_coacc_metadata(
        chrom="chr2L",
        start=1000,
        end=2000,
        dataset_ids=["ds1", "ds2"],
        layer="tf",
        sample_seed="seed-meta-2",
    )
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/coacc/metadata"
    assert params["dataset_ids"] == "ds1,ds2"
    assert params["layer"] == "tf"
    assert params["sample_seed"] == "seed-meta-2"

    client.get_coacc_arcs(
        chrom="chr2L",
        start=1000,
        end=2000,
        dataset_ids=["ds1", "ds2"],
        signal_type="small_fp",
        as_dataframe=False,
    )
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/coacc/arcs"
    assert params["dataset_ids"] == "ds1,ds2"
    assert params["signal_type"] == "small_fp"


def test_coacc_png_helpers_map_panel_and_track_endpoints(tmp_path):
    client = DummyClient()

    matrix_path = tmp_path / "coacc_matrix.png"
    result_path = client.save_coacc_matrix_png(
        str(matrix_path),
        chrom="chr2L",
        start=1000,
        end=2000,
        dataset_ids=["ds1", "ds2"],
        normalization="oe_distance",
        scaling="sqrt",
        colormap="viridis",
        vmin=0.1,
        vmax=3.0,
        bin_size=50,
        min_coverage=5,
        signal_type="small_fp",
        layer="tf",
        read_ids=["r1", "r2"],
        sample_seed="seed-image",
    )

    assert result_path == str(matrix_path)
    assert matrix_path.read_bytes() == b"PNG"
    _, endpoint, params, timeout = client.calls[-1]
    assert endpoint == "/api/coacc/matrix/image"
    assert timeout == 60
    assert params["dataset_ids"] == "ds1,ds2"
    assert params["normalization"] == "oe_distance"
    assert params["scaling"] == "sqrt"
    assert params["colormap"] == "viridis"
    assert params["vmin"] == 0.1
    assert params["vmax"] == 3.0
    assert params["bin_size"] == 50
    assert params["min_coverage"] == 5
    assert params["signal_type"] == "small_fp"
    assert params["layer"] == "tf"
    assert params["read_ids"] == "r1,r2"
    assert params["sample_seed"] == "seed-image"

    strip = client.get_coacc_strip_png(
        chrom="chr2L",
        start=1000,
        end=2000,
        width=640,
        height=96,
        dataset_id="ds1",
        layer="msp",
        sample_seed="seed-strip",
    )

    assert strip == b"PNG"
    _, endpoint, params, _ = client.calls[-1]
    assert endpoint == "/api/coacc/strip"
    assert params["width"] == 640
    assert params["height"] == 96
    assert params["dataset_ids"] == "ds1"
    assert params["layer"] == "fire"
    assert params["sample_seed"] == "seed-strip"


def test_legacy_coacc_pil_helpers_delegate_to_png_helpers():
    class PngDummyClient(DummyClient):
        def _get_bytes(self, endpoint: str, params: dict = None, timeout: int = 60) -> bytes:
            self.calls.append(("GET_BYTES", endpoint, params or {}, timeout))
            return PNG_1X1

    client = PngDummyClient()

    matrix = client.get_coacc_image(
        chrom="chr2L",
        start=1000,
        end=2000,
        dataset_ids=["ds1", "ds2"],
        normalization="correlation",
        signal_type="small_fp",
        layer="tf",
        read_ids=["r1"],
        sample_seed="seed-image",
    )
    matrix.load()

    assert matrix.size == (1, 1)
    _, endpoint, params, _ = client.calls[-1]
    assert endpoint == "/api/coacc/matrix/image"
    assert params["dataset_ids"] == "ds1,ds2"
    assert params["normalization"] == "correlation"
    assert params["signal_type"] == "small_fp"
    assert params["layer"] == "tf"
    assert params["read_ids"] == "r1"
    assert params["sample_seed"] == "seed-image"

    strip = client.get_coacc_strip(
        chrom="chr2L",
        start=1000,
        end=2000,
        width=640,
        height=96,
        dataset_id="ds1",
        layer="msp",
        sample_seed="seed-strip",
    )
    strip.load()

    assert strip.size == (1, 1)
    _, endpoint, params, _ = client.calls[-1]
    assert endpoint == "/api/coacc/strip"
    assert params["width"] == 640
    assert params["height"] == 96
    assert params["dataset_ids"] == "ds1"
    assert params["layer"] == "fire"
    assert params["sample_seed"] == "seed-strip"


def test_analyze_footprints_maps_current_endpoint_and_payload():
    client = DummyClient()

    result = client.analyze_footprints(
        chrom="chr2L",
        start=1000,
        end=2000,
        dataset_ids=["ds1"],
        footprints=[{"start": 1100, "end": 1160}],
        layer="tf",
        max_reads=5000,
        sample_seed="seed-footprint",
        include_overlap_sizes=False,
        include_profiles=False,
        include_vplot=False,
        motif_track_indices=[2, 3],
        custom_pwms=[{"name": "PWM1", "counts": {"A": [1], "C": [0], "G": [0], "T": [0]}}],
    )

    assert result == {"success": True}
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/footprint/analyze?chrom=chr2L&region_start=1000&region_end=2000&spanning=false"
    assert params == {}
    assert body["dataset_ids"] == ["ds1"]
    assert body["footprints"] == [{
        "absStart": 1100,
        "absEnd": 1160,
        "size": 60,
        "readId": "footprint_0",
        "datasetId": "ds1",
    }]
    assert body["layer"] == "tf"
    assert body["max_reads"] == 5000
    assert body["sample_seed"] == "seed-footprint"
    assert body["motif_track_indices"] == [2, 3]
    assert body["custom_pwms"] == [{"name": "PWM1", "counts": {"A": [1], "C": [0], "G": [0], "T": [0]}}]
    assert body["include_read_analysis"] is True
    assert body["include_overlap_sizes"] is False
    assert body["include_profiles"] is False
    assert body["include_vplot"] is False


def test_analyze_footprints_maps_profile_layers_and_read_filters():
    client = DummyClient()

    client.analyze_footprints(
        chrom="chr2L",
        start=1000,
        end=2000,
        dataset_ids=["ds1", "ds2"],
        footprints=[(1100, 1160)],
        read_ids_by_dataset={"ds1": ["r1"], "ds2": ["r2"]},
        layers=["nuc", "tf", "msp", "fire"],
        include_read_analysis=False,
    )

    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/footprint/analyze?chrom=chr2L&region_start=1000&region_end=2000&spanning=false"
    assert params == {}
    assert body["dataset_ids"] == ["ds1", "ds2"]
    assert body["read_ids_by_dataset"] == {"ds1": ["r1"], "ds2": ["r2"]}
    assert body["layers"] == ["nuc", "tf", "fire"]
    assert body["include_read_analysis"] is False


def test_analyze_footprints_omits_dataset_ids_for_backend_default():
    client = NonPrimaryDatasetClient()

    client.analyze_footprints(
        chrom="chr2L",
        start=1000,
        end=2000,
        footprints=[{"start": 1100, "end": 1160}],
        read_ids=["r1"],
    )

    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/footprint/analyze?chrom=chr2L&region_start=1000&region_end=2000&spanning=false"
    assert params == {}
    assert body["dataset_ids"] == []
    assert body["footprints"][0]["datasetId"] == "sample_a"
    assert body["read_ids_by_dataset"] == {"sample_a": ["r1"]}


def test_save_derived_layers_uses_synced_cart_when_groups_omitted():
    client = DummyClient()

    result = client.save_derived_layers(
        output_dir="/tmp/out",
        chrom="chr2L",
        start=1000,
        end=2000,
        dataset_ids=["ds1"],
        bundle_name="paper layers",
        sample_seed="seed-layers",
    )

    assert result["success"] is True
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/footprint/derived_layers/export"
    assert params == {
        "chrom": "chr2L",
        "region_start": 1000,
        "region_end": 2000,
        "spanning": "true",
    }
    assert body["dataset_ids"] == ["ds1"]
    assert body["output_dir"] == "/tmp/out"
    assert body["bundle_name"] == "paper layers"
    assert body["sample_seed"] == "seed-layers"
    assert body["groups"] == [{"id": "fg1", "name": "TF class", "enabled": True, "sizeMin": 1, "sizeMax": 30, "layer": "tf"}]


def test_save_derived_layers_defaults_to_synced_reproducibility_seed():
    client = DummyClient()

    client.save_derived_layers(
        output_dir="/tmp/out",
        groups=[{"id": "fg1", "name": "TF class", "enabled": True, "sizeMin": 1, "sizeMax": 30, "layer": "tf"}],
        chrom="chr2L",
        start=1000,
        end=2000,
        dataset_ids=["ds1"],
    )

    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/footprint/derived_layers/export"
    assert params["spanning"] == "true"
    assert body["sample_seed"] == "paper-v1"


def test_save_footprint_rules_uses_synced_cart_and_reproducibility_defaults():
    client = DummyClient()

    result = client.save_footprint_rules(
        output_dir="/tmp/out",
        chrom="chr2L",
        start=1000,
        end=2000,
        dataset_ids=["ds1"],
        bundle_name="paper rules",
    )

    assert result["success"] is True
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/footprint/rules/save"
    assert params == {}
    assert body == {
        "groups": [{"id": "fg1", "name": "TF class", "enabled": True, "sizeMin": 1, "sizeMax": 30, "layer": "tf"}],
        "output_dir": "/tmp/out",
        "bundle_name": "paper rules",
        "chrom": "chr2L",
        "start": 1000,
        "end": 2000,
        "spanning": None,
        "dataset_ids": ["ds1"],
        "sample_seed": "paper-v1",
    }


def test_load_footprint_rules_can_apply_to_live_browser_cart():
    client = DummyClient()

    result = client.load_footprint_rules("/tmp/cart.fiberlayer-rules.json")

    assert result["success"] is True
    assert result["applied"]["success"] is True
    _, load_endpoint, load_body, load_params = client.calls[-2]
    assert load_endpoint == "/api/footprint/rules/load"
    assert load_params == {}
    assert load_body == {"path": "/tmp/cart.fiberlayer-rules.json"}
    _, apply_endpoint, apply_body, apply_params = client.calls[-1]
    assert apply_endpoint == "/api/jupyter/settings"
    assert apply_params == {}
    assert apply_body == {
        "footprint_groups": [{"id": "loaded", "name": "Loaded TF", "enabled": True, "sizeMin": 1, "sizeMax": 40, "layer": "tf"}]
    }


def test_footprint_rule_aliases_map_to_portable_rule_endpoints():
    client = DummyClient()

    save_result = client.save_fiberlayer_rules(
        output_dir="/tmp/out",
        chrom="chr2L",
        start=1000,
        end=2000,
        dataset_ids=["ds1"],
    )
    assert save_result["success"] is True
    _, save_endpoint, save_body, _ = client.calls[-1]
    assert save_endpoint == "/api/footprint/rules/save"
    assert save_body["output_dir"] == "/tmp/out"

    load_result = client.reload_fiberlayer_rules(
        "/tmp/cart.fiberlayer-rules.json",
        apply=False,
    )
    assert load_result["success"] is True
    _, load_endpoint, load_body, load_params = client.calls[-1]
    assert load_endpoint == "/api/footprint/rules/load"
    assert load_params == {}
    assert load_body == {"path": "/tmp/cart.fiberlayer-rules.json"}


def test_footprint_cooccurrence_tsv_matches_browser_export_schema(tmp_path):
    result = {
        "co_occupancy": {
            "ds1": {
                "total_reads": 4,
                "per_group": [
                    {"n_with": 2, "n_without": 2, "ids_with": ["r1", "r2"], "ids_without": ["r3", "r4"]},
                    {"n_with": 1, "n_without": 3, "ids_with": ["r1"], "ids_without": ["r2", "r3", "r4"]},
                ],
                "pairs": [{
                    "group_i": 0,
                    "group_j": 1,
                    "odds_ratio": float("inf"),
                    "p_value": 0.25,
                    "n_both": 1,
                    "n_i_only": 1,
                    "n_j_only": 0,
                    "n_neither": 2,
                    "ids_both": ["r1"],
                    "ids_i_only": ["r2"],
                    "ids_j_only": [],
                    "ids_neither": ["r3", "r4"],
                }],
            },
        },
    }
    groups = [
        {"id": "g1", "name": "TF", "enabled": True},
        {"id": "g2", "name": "Nuc", "enabled": True},
    ]
    datasets = [{"id": "ds1", "label": "Sample 1"}]

    tsv = BrowserClient.format_footprint_cooccurrence_tsv(result, groups, datasets=datasets)

    lines = tsv.splitlines()
    assert lines[0] == "scope\tdataset_id\tdataset_label\ttotal_reads\tgroup_i\tgroup_i_name\tgroup_j\tgroup_j_name\tcell\tn_reads\todds_ratio\tp_value\tq_value\tread_ids"
    assert lines[1] == "single\tds1\tSample 1\t4\t0\tTF\t\t\twith\t2\t\t\t\tr1,r2"
    assert lines[5] == "pair\tds1\tSample 1\t4\t0\tTF\t1\tNuc\tboth\t1\tinf\t0.25\t\tr1"

    out = tmp_path / "coocc.tsv"
    client = DummyClient()
    assert client.save_footprint_cooccurrence_tsv(str(out), result, groups, datasets=datasets) == str(out)
    assert out.read_text(encoding="utf-8") == tsv


def test_load_derived_layers_posts_bundle_path_and_dataset_scope():
    client = DummyClient()

    result = client.load_derived_layers("/tmp/cart.fiberlayers.json", dataset_ids=["ds1", "ds2"])

    assert result["success"] is True
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/footprint/derived_layers/load"
    assert params == {}
    assert body == {
        "path": "/tmp/cart.fiberlayers.json",
        "dataset_ids": ["ds1", "ds2"],
    }


def test_cluster_detail_clients_map_current_analysis_options():
    client = DummyClient()

    client.get_cluster_vplot(
        chrom="chr2L",
        start=100,
        end=1000,
        layer="tf",
        normalize="shared",
        size_bin=5,
        sample_seed="seed-vplot",
    )
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/cluster/vplot"
    assert params == {"chrom": "chr2L", "region_start": 100, "region_end": 1000}
    assert body["layer"] == "tf"
    assert body["normalize"] == "shared"
    assert body["size_bin"] == 5
    assert body["sample_seed"] == "seed-vplot"

    client.fetch_cluster_vplot(
        chrom="chr2L",
        region_start=100,
        region_end=1000,
        layer="msp",
        normalize="per_cluster",
        size_bin=10,
        sample_seed="seed-fetch-vplot",
    )
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/cluster/vplot"
    assert params == {"chrom": "chr2L", "region_start": 100, "region_end": 1000}
    assert body["layer"] == "fire"
    assert body["normalize"] == "per_cluster"
    assert body["size_bin"] == 10
    assert body["sample_seed"] == "seed-fetch-vplot"

    client.get_cluster_projection(
        peak_regions=[{"start": 100, "end": 150, "mode": "accessibility"}],
        dataset_ids=["ds1"],
        chrom="chr2L",
        start=100,
        end=1000,
        method="pca",
        simulate_autocull=True,
        min_fraction=0.1,
        sample_seed="seed-projection",
        cluster_feature_rules=[{"id": "cluster-tf"}],
    )
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/cluster_projection"
    assert params == {"chrom": "chr2L", "start": 100, "end": 1000, "spanning": "false"}
    assert body["dataset_ids"] == ["ds1"]
    assert body["peak_regions"] == [{"start": 100, "end": 150, "mode": "accessibility"}]
    assert body["simulate_autocull"] is True
    assert body["min_fraction"] == 0.1
    assert body["sample_seed"] == "seed-projection"
    assert body["cluster_feature_rules"] == [{"id": "cluster-tf"}]

    client.fetch_cluster_projection(
        chrom="chr2L",
        start=100,
        end=1000,
        dataset_ids=["ds1"],
        peak_regions=[{"start": 100, "end": 150, "mode": "tf"}],
        method="umap",
        spanning=True,
        n_components=2,
        cluster_feature_rules=[{"id": "cluster-nuc"}],
    )
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/cluster_projection"
    assert params == {"chrom": "chr2L", "start": 100, "end": 1000, "spanning": "true"}
    assert body["dataset_ids"] == ["ds1"]
    assert body["peak_regions"] == [{"start": 100, "end": 150, "mode": "tf"}]
    assert body["method"] == "umap"
    assert body["cluster_feature_rules"] == [{"id": "cluster-nuc"}]

    peak_regions = [{"start": 100, "end": 150, "mode": "cluster_rule:cluster-tf"}]
    cluster_rules = [{"id": "cluster-tf", "terms": [{"source": "layer", "layer": "tf"}]}]
    client.dissolve_cluster(
        2,
        assignments={"ds1": {"r1": 2}},
        peak_regions=peak_regions,
        dataset_ids=["ds1"],
        chrom="chr2L",
        start=100,
        end=1000,
        cluster_feature_rules=cluster_rules,
    )
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/dissolve_cluster"
    assert body["cluster_feature_rules"] == cluster_rules
    assert params == {"chrom": "chr2L", "start": 100, "end": 1000, "spanning": "false"}

    client.auto_cull_clusters(
        chrom="chr2L",
        start=100,
        end=1000,
        assignments={"ds1": {"r1": 2}},
        peak_regions=peak_regions,
        dataset_ids=["ds1"],
        spanning=True,
        cluster_feature_rules=cluster_rules,
    )
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/auto_cull_clusters"
    assert body["cluster_feature_rules"] == cluster_rules
    assert body["subnucleosomal_threshold"] == 90
    assert body["accessibility_threshold"] == 0.5
    assert params == {"chrom": "chr2L", "start": 100, "end": 1000, "spanning": "true"}

    client.assign_to_clusters(
        cluster_patterns={1: [1, 0]},
        peak_regions=peak_regions,
        dataset_ids=["ds1"],
        chrom="chr2L",
        start=100,
        end=1000,
        cluster_feature_rules=cluster_rules,
    )
    _, endpoint, body, params = client.calls[-1]
    assert endpoint.startswith("/api/assign_to_clusters?")
    assert body["cluster_feature_rules"] == cluster_rules


def test_scan_and_cluster_reuses_sample_seed_for_scan_and_cluster():
    client = DummyClient()

    result = client.scan_and_cluster(
        k=4,
        method="kmeans",
        chrom="chr2L",
        start=100,
        end=1000,
        dataset_ids=["ds1"],
        sample_seed="seed-scan-cluster",
    )

    assert result["peak_regions"] == [{"start": 120, "end": 180, "mode": "accessibility"}]
    _, scan_endpoint, scan_body, scan_params = client.calls[-2]
    assert scan_endpoint == "/api/scan_peaks"
    assert scan_params == {"chrom": "chr2L", "start": 100, "end": 1000, "spanning": "false"}
    assert scan_body["dataset_ids"] == ["ds1"]
    assert scan_body["sample_seed"] == "seed-scan-cluster"

    _, cluster_endpoint, cluster_body, cluster_params = client.calls[-1]
    assert cluster_endpoint == "/api/cluster_all"
    assert cluster_params == {"chrom": "chr2L", "start": 100, "end": 1000, "spanning": "false"}
    assert cluster_body["sample_seed"] == "seed-scan-cluster"
    assert cluster_body["dataset_ids"] == ["ds1"]


def test_cluster_synced_peaks_falls_back_to_selected_peaks(monkeypatch):
    client = DummyClient()
    monkeypatch.setattr(client, "get_analysis_state", lambda: {"peaks_by_rule": {}, "selected_peaks": []})
    monkeypatch.setattr(client, "get_peaks", lambda selected_only=False, as_dataframe=True: (
        [{"index": 1000, "start": 150, "end": 190, "isCustom": True}] if not as_dataframe else None))
    client.cluster_synced_peaks(chrom="chr2L", start=100, end=300, dataset_ids=["primary"])
    _, endpoint, body, _ = client.calls[-1]
    assert endpoint == "/api/cluster_all"
    assert body["peak_regions"] == [{"start": 150, "end": 190, "mode": "accessibility"}]


def test_scan_and_cluster_tf_density_clusters_on_the_tf_feature():
    client = DummyClient()
    result = client.scan_and_cluster(k=4, chrom="chr2L", start=100, end=1000, signal_source="tf_density")
    assert client.calls[-2][2]["signal_source"] == "tf_density"
    assert [p["mode"] for p in result["peak_regions"]] == ["tf"]
    assert [p["mode"] for p in client.calls[-1][2]["peak_regions"]] == ["tf"]


def test_cluster_frontend_name_aliases_map_current_payloads():
    client = DummyClient()

    client.scan_peaks("chr2L", 100, 1000)
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/scan_peaks"
    assert params == {"chrom": "chr2L", "start": 100, "end": 1000, "spanning": "false"}
    assert body == {}

    client.cluster_reads("chr2L", 100, 1000, [1, 2], 4, "all", True, "ds1")
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/cluster"
    assert params == {
        "chrom": "chr2L",
        "start": 100,
        "end": 1000,
        "spanning": "true",
        "dataset_id": "ds1",
        "min_footprints": 0,
    }
    assert body == {"peak_indices": [1, 2], "k": 4, "filter_mode": "all"}

    client.cluster_all_reads(
        "chr2L",
        100,
        1000,
        [{"start": 120, "end": 180, "mode": "tf"}],
        5,
        False,
        ["ds1", "ds2"],
        method="minibatch",
        read_ids={"ds1": ["r1"]},
        max_reads=5000,
        sample_seed="seed-cluster",
        extra_chroms=["chr2R"],
    )
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/cluster_all"
    assert params == {"chrom": "chr2L", "start": 100, "end": 1000, "spanning": "false"}
    assert body["dataset_ids"] == ["ds1", "ds2"]
    assert body["method"] == "minibatch"
    assert body["read_ids"] == {"ds1": ["r1"]}
    assert body["max_reads"] == 5000
    assert body["sample_seed"] == "seed-cluster"
    assert body["extra_chroms"] == ["chr2R"]

    client.cluster_expand("chr2L", 100, 1000, [2, 3], "ds1", max_reads=250, sample_seed="seed-expand")
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/cluster_expand?chrom=chr2L&start=100&end=1000&spanning=false"
    assert params == {}
    assert body == {"cluster_ids": [2, 3], "max_reads": 250, "dataset_id": "ds1", "sample_seed": "seed-expand"}


def test_scan_peaks_can_scope_datasets_and_read_ids():
    client = DummyClient()

    client.scan_peaks(
        "chr2L",
        100,
        1000,
        dataset_ids=["ds1", "ds2"],
        read_ids=["legacy"],
        read_ids_by_dataset={"ds1": ["r1"], "ds2": ["r2", "r3"]},
        sample_seed="paper-seed",
        signal_source="tf_layer",
        return_signal=True,
    )

    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/scan_peaks"
    assert params == {"chrom": "chr2L", "start": 100, "end": 1000, "spanning": "false"}
    assert body["dataset_ids"] == ["ds1", "ds2"]
    assert body["read_ids"] == ["legacy"]
    assert body["read_ids_by_dataset"] == {"ds1": ["r1"], "ds2": ["r2", "r3"]}
    assert body["sample_seed"] == "paper-seed"
    assert body["signal_source"] == "tf_layer"
    assert body["return_signal"] is True


def test_filter_and_quality_clients_map_layer_and_seed_options():
    client = DummyClient()

    client.filter_by_peaks(
        peak_regions=[{"start": 120, "end": 180}],
        layer="tf",
        sample_seed="seed-filter",
        chrom="chr2L",
        start=100,
        end=1000,
    )
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/filter?chrom=chr2L&start=100&end=1000&spanning=false"
    assert params == {}
    assert body == {
        "filter_mode": "either",
        "peak_regions": [{"start": 120, "end": 180}],
        "layer": "tf",
        "sample_seed": "seed-filter",
    }

    client.get_interval_qualities(
        "tf",
        chrom="chr2L",
        start=100,
        end=1000,
        sample_seed="seed-quality",
    )
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/reads/compact"
    assert params["include_layers"] == "true"
    assert params["layer_names"] == "tf"
    assert params["sample_seed"] == "seed-quality"

    client.set_quality_filters([
        {"layer": "msp", "qualityName": "aq", "minValue": 230, "enabled": True},
        {"layer": "tf", "qualityName": "tq", "minValue": 200, "enabled": False},
    ])
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/quality_filters"
    assert body == {"filters": [{"layer": "fire", "quality_name": "aq", "min_value": 230}]}
    assert params == {}

    client.add_quality_filter("tf", "tq", 200)
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/quality_filters"
    assert body == {"filters": [
        {"layer": "fire", "quality_name": "aq", "min_value": 230},
        {"layer": "tf", "quality_name": "tq", "min_value": 200},
    ]}
    assert params == {}

    client.clear_quality_filters()
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/quality_filters"
    assert body == {"filters": []}
    assert params == {}


def test_fire_quality_helper_aliases_legacy_msp_layer():
    client = DummyClient()
    client.get_compact_reads = lambda **_kwargs: [
        {
            "id": "r1",
            "layers": {
                "msp": {
                    "quality_names": ["aq"],
                    "qualities": [[230, 240]],
                },
            },
        },
    ]

    assert client.get_interval_qualities("fire", "aq") == {"r1": [230, 240]}


def test_labeling_rule_helpers_append_browser_preset_rules():
    client = DummyClient()

    client.add_pol2_gene_exclusion_rule(gene_name="eve", gene_id="FBgn0000606")

    _, endpoint, body, params = client.calls[-2]
    assert endpoint == "/api/jupyter/settings"
    assert params == {}
    preset = body["active_colormap"]
    assert preset["name"] == "Paper labels"
    assert len(preset["rules"]) == 1
    rule = preset["rules"][0]
    assert rule["name"] == "Pol II not eve"
    assert rule["sizeMin"] == 35
    assert rule["sizeMax"] == 65
    assert rule["conditions"] == [{
        "target": "gene",
        "geneId": "FBgn0000606",
        "geneName": "eve",
        "negate": True,
    }]
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/quality_filters"
    assert body == {"filters": []}
    assert params == {}


def test_labeling_preset_applies_backend_quality_filters():
    client = DummyClient()

    result = client.set_labeling_preset({
        "name": "Paper labels",
        "rules": [],
        "qualityFilters": [
            {"layer": "msp", "qualityName": "aq", "minValue": 230, "enabled": True},
            {"layer": "tf", "qualityName": "tq", "minValue": 200, "enabled": False},
        ],
    })

    _, endpoint, body, params = client.calls[-2]
    assert endpoint == "/api/jupyter/settings"
    assert body["active_colormap"]["qualityFilters"][0]["layer"] == "fire"
    assert params == {}
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/quality_filters"
    assert body == {"filters": [{"layer": "fire", "quality_name": "aq", "min_value": 230}]}
    assert params == {}
    assert result["quality_filters"] == {}


def test_labeling_display_helpers_update_synced_preset():
    client = DummyClient()

    client.set_labeling_display(
        read_background="#111827",
        no_read_background="#020617",
        smoothing_enabled=True,
        smoothing_sigma_x=2,
        smoothing_sigma_y=0.5,
        layer_opacities={"msp": 0.25, "tf": 0},
        apply_quality_filters=False,
    )

    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/settings"
    assert params == {}
    preset = body["active_colormap"]
    assert preset["readBackgroundColor"] == "#111827"
    assert preset["noReadBackgroundColor"] == "#020617"
    assert preset["backgroundColor"] == "#020617"
    assert preset["displaySmoothing"] == {"enabled": True, "sigmaX": 2.0, "sigmaY": 0.5}
    assert preset["layerOpacities"]["fire"] == 0.25
    assert preset["layerOpacities"]["tf"] == 0.0

    client.calls.clear()
    client.set_layer_opacity("msp", 0.4, apply_quality_filters=False)

    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/settings"
    assert params == {}
    assert body["active_colormap"]["layerOpacities"]["fire"] == 0.4


def test_annotations_and_compile_clients_map_sample_seed():
    client = DummyClient()

    client.get_annotations(
        chrom="chr2L",
        start=100,
        end=1000,
        dataset_ids=["ds1", "ds2"],
        file_ids=["ann1"],
        as_dataframe=False,
        sample_seed="seed-annotations",
    )
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/annotations/region"
    assert params == {
        "chrom": "chr2L",
        "start": 100,
        "end": 1000,
        "dataset_ids": "ds1,ds2",
        "file_ids": "ann1",
        "sample_seed": "seed-annotations",
    }

    client.compile_regions(
        [("chr2L", 100, 200, "a")],
        dataset_id="ds1",
        target_width=500,
        sample_seed="seed-compile-client",
        include_deam_opportunities=True,
    )
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/reads/compile"
    assert params == {}
    assert body["regions"] == [{"chrom": "chr2L", "start": 100, "end": 200, "label": "a"}]
    assert body["dataset_ids"] == ["ds1"]
    assert body["target_width"] == 500
    assert body["sample_seed"] == "seed-compile-client"
    assert body["include_deam_opportunities"] is True


def test_read_stats_accepts_plain_read_id_list():
    client = DummyClient()

    result = client.get_read_stats(
        ["r1", "r2"],
        dataset_id="ds1",
        chrom="chr2L",
        start=100,
        end=200,
        as_dataframe=False,
        sample_seed="seed-stats",
    )

    assert [row["viewer_order"] for row in result["per_read"]] == [1, 2]
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/reads/stats"
    assert body == {"read_ids_by_dataset": {"ds1": ["r1", "r2"]}, "sample_seed": "seed-stats"}
    assert params == {"chrom": "chr2L", "start": 100, "end": 200, "spanning": "false"}

    client.fetch_read_stats("chr2L", 100, 500, True, {"ds1": ["a"]}, sample_seed="seed-fetch")
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/reads/stats"
    assert params == {"chrom": "chr2L", "start": 100, "end": 500, "spanning": "true"}
    assert body == {"read_ids_by_dataset": {"ds1": ["a"]}, "sample_seed": "seed-fetch"}


def test_read_stats_plain_list_defaults_to_first_loaded_dataset():
    client = NonPrimaryDatasetClient()

    client.get_read_stats(
        ["r1"],
        chrom="chr2L",
        start=100,
        end=200,
        as_dataframe=False,
    )

    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/reads/stats"
    assert body == {"read_ids_by_dataset": {"sample_a": ["r1"]}}
    assert params == {"chrom": "chr2L", "start": 100, "end": 200, "spanning": "false"}


def test_read_stats_tsv_preserves_requested_viewer_order(tmp_path):
    client = DummyClient()

    tsv = client.get_read_stats_tsv(
        {"ds1": ["r2", "r1"]},
        chrom="chr2L",
        start=100,
        end=200,
        sample_seed="seed-stats",
    )

    lines = tsv.strip().splitlines()
    assert lines[0] == "read_id\tdataset_id\taligned_span\tfootprint_count\tavg_footprint_size\taccessibility_pct\tmethyl_count\tmethyl_pct\tmapq\tstrand\tviewer_order"
    assert lines[1].startswith("r2\tds1\t202\t5\t55.0\t25.0\t1\t0.5\t50\t-\t1")
    assert lines[2].startswith("r1\tds1\t101\t3\t42.0\t12.5\t\t\t60\t+\t2")

    out = tmp_path / "read_stats.tsv"
    assert client.save_read_stats_tsv(str(out), {"ds1": ["r2", "r1"]}, chrom="chr2L", start=100, end=200) == str(out)
    assert out.read_text() == client.get_read_stats_tsv({"ds1": ["r2", "r1"]}, chrom="chr2L", start=100, end=200)


def test_get_browser_read_order_uses_separate_reproducibility_endpoint():
    client = DummyClient()

    assert client.get_browser_read_order("ds1") == ["r_screen_1", "r_screen_2"]

    method, endpoint, params = client.calls[-1]
    assert method == "GET"
    assert endpoint == "/api/jupyter/browser_order"
    assert params == {"dataset_id": "ds1"}

    assert client.get_browser_order("ds1") == ["r_screen_1", "r_screen_2"]


def test_explicit_read_filter_aliases_map_jupyter_filter_endpoints():
    client = DummyClient()

    client.set_read_filter(["r1", "r2"], dataset_id="ds1")
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/filter"
    assert params == {}
    assert body == {"read_ids": ["r1", "r2"], "dataset_id": "ds1"}

    assert client.get_read_filter("ds1") == ["r_filter_1", "r_filter_2"]
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/jupyter/filter"
    assert params == {"dataset_id": "ds1"}

    client.clear_read_filter("ds1")
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/jupyter/filter"
    assert params == {"dataset_id": "ds1"}


def test_peak_bed_export_and_parse_round_trip(tmp_path):
    client = DummyClient()

    bed = client.get_peaks_bed(selected_only=True)

    assert bed.splitlines()[:2] == [
        "# fiberbrowser_peaks_v1",
        "# columns=chrom\tstart\tend\tname\tbed_score\tstrand\trule_id\trule_name\tsource\tlayer\tsignal_score\tthreshold\tselected\tmode\tis_custom\tcolor",
    ]
    assert "2R\t200\t260\tTF layer\t456\t.\trule-a\tTF layer\ttf_layer\t2\t0.456\t0.15\t1\ttf_layer\t0\t#00aabb" in bed

    out = tmp_path / "peaks.bed"
    assert client.save_peaks_bed(str(out), selected_only=True) == str(out)
    parsed = BrowserClient.load_peak_bed(str(out), as_dataframe=False)
    assert parsed == [{
        "chrom": "2R",
        "start": 200,
        "end": 260,
        "name": "TF layer",
        "score": 0.456,
        "ruleId": "rule-a",
        "ruleName": "TF layer",
        "source": "tf_layer",
        "layer": 2,
        "threshold": 0.15,
        "selected": True,
        "mode": "tf_layer",
        "isCustom": False,
        "color": "#00aabb",
    }]


def test_peak_bed_regions_loads_generic_bed(tmp_path):
    bed = tmp_path / "generic.bed"
    bed.write_text("2R\t100\t150\tpeak_a\n2R\t200\t260\tpeak_b\t750\t.\n")

    assert BrowserClient.peak_bed_regions(str(bed), mode="accessibility") == [
        {"start": 100, "end": 150, "mode": "accessibility"},
        {"start": 200, "end": 260, "mode": "accessibility"},
    ]


def test_set_peaks_posts_jupyter_import_payload():
    client = DummyClient()

    client.set_peaks(
        [{"start": 100, "end": 150, "name": "peak_a"}],
        chrom="2R",
        label="locked peaks",
        lock=True,
        select=False,
        replace_existing=False,
    )

    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/import_peaks"
    assert params == {}
    assert body == {
        "peaks": [{"start": 100, "end": 150, "name": "peak_a", "chrom": "2R"}],
        "chrom": "2R",
        "label": "locked peaks",
        "lock": True,
        "select": False,
        "replace_existing": False,
    }


def test_import_peaks_bed_can_goto_and_reload_locked_set(tmp_path):
    client = DummyClient()
    bed = tmp_path / "peaks.bed"
    bed.write_text("2R\t100\t150\tpeak_a\n2R\t300\t360\tpeak_b\n")

    client.import_peaks_bed(str(bed), label="saved peaks", goto=True, padding=25)

    _, goto_endpoint, goto_body, goto_params = client.calls[-2]
    assert goto_endpoint == "/api/jupyter/goto"
    assert goto_body == {"chrom": "2R", "start": 75, "end": 385}
    assert goto_params == {}

    _, import_endpoint, import_body, import_params = client.calls[-1]
    assert import_endpoint == "/api/jupyter/import_peaks"
    assert import_params == {}
    assert import_body["label"] == "saved peaks"
    assert import_body["lock"] is True
    assert import_body["select"] is True
    assert import_body["replace_existing"] is True
    assert import_body["peaks"][0]["chrom"] == "2R"


def test_peak_rules_json_can_reload_live_browser(tmp_path):
    client = DummyClient()
    rules_json = tmp_path / "peak_rules.json"
    rules_json.write_text(
        '{"rules":[{"id":"rule-a","name":"TF","source":"tf_layer","enabled":true,'
        '"color":"#00aabb","opacity":0.6,"useGradient":true,'
        '"smoothWidth":100,"thresholds":[0.5,0.3,0.15,0.08],"minPeakWidth":80,"minReads":5}]}'
    )

    client.load_peak_rules_json(str(rules_json), lock=False, clear_peaks=True, rescan=True)

    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/peak_rules"
    assert params == {}
    assert body["lock"] is False
    assert body["clear_peaks"] is True
    assert body["rescan"] is True
    assert body["rules"][0]["id"] == "rule-a"
    assert body["rules"][0]["source"] == "tf_layer"


def test_clusters_tsv_uses_browser_viewer_order(tmp_path):
    client = DummyClient()

    tsv = client.get_clusters_tsv("primary")

    assert tsv.splitlines() == [
        "read_id\tdataset\tcluster\tpattern\tviewer_order",
        "read_a\tPrimary sample\t1\t10\t1",
        "read_b\tPrimary sample\t1\t10\t2",
        "read_c\tPrimary sample\t2\t01\t3",
    ]

    out = tmp_path / "clusters.tsv"
    assert client.save_clusters_tsv(str(out), "primary") == str(out)
    assert out.read_text() == tsv

    provenance_tsv = client.get_clusters_tsv(
        "primary",
        include_provenance=True,
        provenance={"notebook": "figure-1"},
    )
    lines = provenance_tsv.splitlines()
    assert lines[0] == "# fiberbrowser_export: cluster_assignments"
    assert "# chrom: chr1" in lines
    assert "# start: 100" in lines
    assert "# end: 500" in lines
    assert '# dataset_ids: ["primary"]' in lines
    assert '# dataset_labels: ["Primary sample"]' in lines
    assert "# analysis_sample_seed: paper-v1" in lines
    assert "# analysis_sample_count: " in lines
    assert "# cluster_method: kmeans" in lines
    assert "# cluster_k: 10" in lines
    assert "# small_footprint_threshold_bp: 90" in lines
    assert "# accessibility_threshold: 0.45" in lines
    assert "# selected_peak_count: 2" in lines
    assert "# peaks_locked: true" in lines
    assert "# quality_filters: []" in lines
    assert "# notebook: figure-1" in lines
    assert "read_id\tdataset\tcluster\tpattern\tviewer_order" in lines


def test_working_set_info_maps_sample_seed():
    client = DummyClient()

    client.get_working_set_info(
        chrom="chr2L",
        start=100,
        end=500,
        dataset_id="ds1",
        spanning=True,
        sample_seed="seed-working",
    )

    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/working_set_info"
    assert params == {
        "chrom": "chr2L",
        "start": 100,
        "end": 500,
        "spanning": "true",
        "dataset_id": "ds1",
        "sample_seed": "seed-working",
    }


def test_microc_apa_maps_current_endpoint_shape():
    client = DummyClient()

    client.get_microc_apa(
        peaks=[{"start": 1000, "end": 1200}, {"start": 5000, "end": 5200}],
        chrom="chr2L",
        window=20000,
        resolution=5000,
        normalization="none",
    )

    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/microc/apa"
    assert body == {"peaks": [{"start": 1000, "end": 1200}, {"start": 5000, "end": 5200}]}
    assert params == {
        "chrom": "chr2L",
        "window": 20000,
        "normalization": "none",
        "resolution": 5000,
    }


def test_microc_apa_accepts_legacy_anchors():
    client = DummyClient()

    client.get_microc_apa(anchors=[1000, 5000], chrom="chr3R")

    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/microc/apa"
    assert body == {"peaks": [{"start": 1000, "end": 1000}, {"start": 5000, "end": 5000}]}
    assert params["chrom"] == "chr3R"


def test_primer_client_maps_current_request_models():
    client = DummyClient()

    client.design_primers(
        chrom="chr2L",
        start=100,
        end=200,
        tm_method="snapgene",
        check_tandem_repeats=False,
    )
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/design_primers"
    assert params == {}
    assert body["tm_method"] == "snapgene"
    assert body["check_tandem_repeats"] is False

    client.design_dafc_primers(
        chrom="chr2L",
        x_start=100,
        x_end=200,
        y_start=1000,
        y_end=1200,
        y_chrom="chr3R",
        tm_method="santalucia",
        check_tandem_repeats=False,
        exclude_regions={"chr3R": [[1050, 1060]]},
        sample_seed="paper-v1",
    )
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/design_dafc_primers"
    assert params == {}
    assert body["chrom"] == "chr2L"
    assert body["x_start"] == 100
    assert body["y_chrom"] == "chr3R"
    assert body["tm_method"] == "santalucia"
    assert body["check_tandem_repeats"] is False
    assert body["exclude_regions"] == {"chr3R": [[1050, 1060]]}
    assert body["sample_seed"] == "paper-v1"

    client.design_4c_primers(chrom="chr2L", start=1000, end=1300, max_spacing=700, tm_method="breslauer")
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/design_4c_primers"
    assert params == {}
    assert body["chrom"] == "chr2L"
    assert body["start"] == 1000
    assert body["end"] == 1300
    assert body["max_spacing"] == 700
    assert body["tm_method"] == "breslauer"
    assert body["check_tandem_repeats"] is True


def test_primer_client_reads_latest_result_shapes():
    client = DummyClient()

    client.primer_response = {"success": True, "pairs": [{"fwd_seq": "AAA"}], "pair": {"fwd_seq": "AAA"}}
    assert client.get_primers() == [{"fwd_seq": "AAA"}]
    assert client.get_primer_results()["pairs"] == [{"fwd_seq": "AAA"}]

    client.primer_response = {"success": True, "quads": [{"x_pair": {"fwd_seq": "AAA"}}]}
    assert client.get_primers() == [{"x_pair": {"fwd_seq": "AAA"}}]

    client.primer_response = {"success": True, "pair": {"fwd_seq": "CCC"}}
    assert client.get_primers() == [{"fwd_seq": "CCC"}]

    client.primer_response = {"success": False, "message": "No primers designed"}
    assert client.get_primers() == []


def test_primer_order_export_matches_ui_formats_and_escapes_formulas(tmp_path):
    client = DummyClient()
    primers = [
        {"name": "=BadName", "pair": {"fwd_seq": "ATGC", "rev_seq": "GCAT"}},
        {"name": "Pair2", "pair": {"fwd_seq": "AAAA", "rev_seq": "TTTT"}},
    ]

    idt = client.format_primer_order(primers, format="idt")
    assert idt["filename"] == "primer_order_idt.csv"
    assert idt["mime_type"] == "text/csv"
    assert idt["content"].splitlines()[0] == "Name,Sequence,Scale,Purification"
    assert "'=BadName_F,ATGC,25 nmole,STD" in idt["content"]

    genewiz = client.format_primer_order(primers, format="genewiz")
    assert "25 nmol,Desalted" in genewiz["content"]

    eurofins = client.format_primer_order(primers, format="eurofins")
    assert eurofins["content"].splitlines()[0] == "Well,Oligo Name,Sequence,PlateName"
    assert "A1,'=BadName_F,ATGC,FiberBrowser_1" in eurofins["content"]

    fasta = client.format_primer_order(primers, format="fasta")
    assert fasta["mime_type"] == "text/plain"
    assert fasta["content"].startswith(">=BadName_F\nATGC")

    out = tmp_path / "primers.csv"
    assert client.save_primer_order(str(out), primers=primers, format="generic") == str(out)
    assert out.read_text().splitlines()[0] == "Name,Sequence,Direction"


def test_merge_datasets_uses_current_label_field():
    client = DummyClient()

    client.merge_datasets(["a", "b"], merged_label="merged")

    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/datasets/merge"
    assert body == {"dataset_ids": ["a", "b"], "label": "merged"}
    assert params == {}

    client.unmerge_dataset("merged")
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/datasets/unmerge"
    assert body == {"dataset_id": "merged"}
    assert params == {}


def test_refresh_dataset_capabilities_maps_endpoint():
    client = DummyClient()

    client.refresh_dataset_capabilities("sample")

    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/datasets/sample/refresh_capabilities"
    assert body == {}
    assert params == {}


def test_refresh_dataset_capabilities_defaults_to_first_loaded_dataset():
    client = NonPrimaryDatasetClient()

    client.refresh_dataset_capabilities()

    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/datasets/sample_a/refresh_capabilities"
    assert body == {}
    assert params == {}


def test_add_dataset_url_maps_convenience_endpoint():
    client = DummyClient()

    client.add_dataset_url("https://example.org/sample.bam", label="remote")

    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/datasets/add_url"
    assert body == {}
    assert params == {"url": "https://example.org/sample.bam", "label": "remote"}


def test_catalog_and_remote_source_clients_map_current_router_shapes():
    client = DummyClient()

    client.get_catalog()
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/catalog"
    assert params == {}

    client.catalog_load(2)
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/catalog/load"
    assert body == {}
    assert params == {"group_index": 2}

    client.catalog_unload(2)
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/catalog/unload"
    assert body == {}
    assert params == {"group_index": 2}

    client.catalog_track_load(4)
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/catalog/tracks/load"
    assert body == {}
    assert params == {"track_index": 4}

    client.catalog_track_unload(4)
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/catalog/tracks/unload"
    assert body == {}
    assert params == {"track_index": 4}

    client.configure_s3(profile="lab", region="us-east-1", endpoint_url="https://r2.example")
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/s3/configure"
    assert body == {}
    assert params == {"profile": "lab", "region": "us-east-1", "endpoint_url": "https://r2.example"}

    client.test_s3_access("s3://bucket/file.bam")
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/s3/test"
    assert params == {"url": "s3://bucket/file.bam"}

    client.list_s3_bucket("bucket", prefix="runs/", max_keys=10)
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/s3/list"
    assert params == {"bucket": "bucket", "prefix": "runs/", "max_keys": 10}

    client.get_presigned_url("s3://bucket/file.bb", expiration=120)
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/s3/presign"
    assert params == {"url": "s3://bucket/file.bb", "expiration": 120}


def test_external_track_clients_map_current_router_shapes():
    client = DummyClient()

    client.get_ucsc_curated("dm6")
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/ucsc/curated"
    assert params == {"genome": "dm6"}

    client.search_ucsc_tracks("dm6", "CTCF")
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/ucsc/search"
    assert params == {"genome": "dm6", "query": "CTCF"}

    client.browse_ucsc_tracks("dm6")
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/ucsc/browse"
    assert params == {"genome": "dm6"}

    client.get_encode_facets("hg38")
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/encode/facets"
    assert params == {"genome": "hg38"}

    client.search_encode("hg38", assay="ChIP-seq", target="CTCF", biosample="K562", query="fold", limit=5)
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/encode/search"
    assert params == {
        "genome": "hg38",
        "limit": 5,
        "assay": "ChIP-seq",
        "target": "CTCF",
        "biosample": "K562",
        "query": "fold",
    }

    client.get_chipatlas_status()
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/chipatlas/status"
    assert params == {}

    client.get_chipatlas_facets("dm6")
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/chipatlas/facets"
    assert params == {"genome": "dm6"}

    client.search_chipatlas("dm6", antigen_class="TFs", antigen="GAF", cell_type_class="Embryo", cell_type="stage", limit=7)
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/chipatlas/search"
    assert params == {
        "genome": "dm6",
        "limit": 7,
        "antigen_class": "TFs",
        "antigen": "GAF",
        "cell_type_class": "Embryo",
        "cell_type": "stage",
    }


def test_track_client_maps_current_router_shapes():
    client = DummyClient()

    client.get_chromosomes()
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/chroms"
    assert params == {}

    client.get_track_data(3, chrom="chr2L", start=10, end=20, bins=25)
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/tracks/3"
    assert params == {"chrom": "chr2L", "start": 10, "end": 20, "bins": 25}

    client.get_tracks_batch([3, 4], chrom="chr2L", start=10, end=20, bins=25, annotation_filters={4: ["GAF"]})
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/tracks/batch"
    assert body == {
        "track_indices": [3, 4],
        "chrom": "chr2L",
        "start": 10,
        "end": 20,
        "bins": 25,
        "annotation_filters": {4: ["GAF"]},
    }

    assert params == {}

    client.add_track(
        "ucsc://dm6/jaspar",
        label="JASPAR",
        render_mode="annotation",
        track_type="bigbed",
        ucsc_genome="dm6",
        ucsc_track="jaspar",
        filter_names=["GAF", "M1BP"],
        category="motifs",
    )
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/add_track"
    assert body == {}
    assert params == {
        "path": "ucsc://dm6/jaspar",
        "label": "JASPAR",
        "render_mode": "annotation",
        "track_type": "bigbed",
        "ucsc_genome": "dm6",
        "ucsc_track": "jaspar",
        "filter_names": "GAF,M1BP",
        "category": "motifs",
    }

    intervals = client.get_track_annotations(3, chrom="chr2L", start=10, end=20, filter_names="GAF")
    assert intervals == [{"start": 10, "end": 20}]
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/tracks/3/annotations"
    assert params == {"chrom": "chr2L", "start": 10, "end": 20, "filter_names": "GAF"}

    client.add_motif_track("GAF", "GAGAG", threshold=0.9)
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/tracks/add_motif_sequence"
    assert body["label"] == "GAF"
    assert body["sequence"] == "GAGAG"
    assert body["threshold"] == 0.9
    assert "name" not in body
    assert params == {}

    client.add_motif_sequence_track("GAGAG", label="GAF", threshold=0.85)
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/tracks/add_motif_sequence"
    assert body == {"sequence": "GAGAG", "label": "GAF", "threshold": 0.85}
    assert params == {}

    pwm = {"A": [1, 0], "C": [0, 1], "G": [0, 0], "T": [0, 0]}
    client.add_motif_pwm_track("PWM1", pwm, label="PWM track", threshold=0.82)
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/tracks/add_motif_pwm"
    assert body == {"name": "PWM1", "counts": pwm, "label": "PWM track", "threshold": 0.82}
    assert params == {}

    client.add_motif_track_file("/tmp/motifs.meme", format="meme", threshold=0.75)
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/tracks/add_motif_file"
    assert body == {"file_path": "/tmp/motifs.meme", "threshold": 0.75, "format": "meme"}
    assert params == {}

    client.add_motif_file_tracks("/tmp/motifs.jaspar", format="jaspar", threshold=0.8)
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/tracks/add_motif_file"
    assert body == {"file_path": "/tmp/motifs.jaspar", "threshold": 0.8, "format": "jaspar"}
    assert params == {}

    client.get_bigbed_names("https://example.org/tf.bb", genome="dm6", sample_size=250000)
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/bigbed/names"
    assert params == {"url": "https://example.org/tf.bb", "genome": "dm6", "sample_size": 250000}

    client.filter_track(2, ["GAF", "M1BP"])
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/tracks/2/filter"
    assert body == {"filter_names": ["GAF", "M1BP"]}
    assert params == {}

    client.update_track_filter(2, None)
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/tracks/2/filter"
    assert body == {"filter_names": None}
    assert params == {}

    client.reorder_tracks(4, 1)
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/tracks/reorder"
    assert body == {"from_index": 4, "to_index": 1}
    assert params == {}

    client.remove_track(5)
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/tracks/5"
    assert params == {}


def test_reference_client_maps_circular_plasmid_routes():
    client = DummyClient()

    client.load_plasmid("/tmp/plasmid.gbk")
    assert client.calls[-1] == ("POST", "/api/load_plasmid", {}, {"path": "/tmp/plasmid.gbk"})

    client.load_plasmids(["/tmp/a.gbk", "/tmp/b.gbk"])
    assert client.calls[-1] == ("POST", "/api/load_plasmids", {"paths": ["/tmp/a.gbk", "/tmp/b.gbk"]}, {})

    client.set_circular_chrom("chrM", False)
    assert client.calls[-1] == ("POST", "/api/circular_chrom", {}, {"chrom": "chrM", "circular": False})

    client.mark_circular_chrom("plasmid")
    assert client.calls[-1] == ("POST", "/api/circular_chrom", {}, {"chrom": "plasmid", "circular": True})


def test_jupyter_and_pol2_frontend_aliases_map_current_shapes(tmp_path):
    client = DummyClient()

    client.get_jupyter_reads("ds1", chrom="chr2L", start=100, end=200, sample_seed="seed-jupyter")
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/jupyter/reads"
    assert params == {"dataset_id": "ds1", "chrom": "chr2L", "start": 100, "end": 200, "sample_seed": "seed-jupyter"}

    client.set_jupyter_selection(["r1", "r2"])
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/selection"
    assert body == ["r1", "r2"]
    assert params == {}

    assert client.get_selection(dataset_id="ds1") == ["read_ds1"]
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/jupyter/selection"
    assert params == {"dataset_id": "ds1"}

    client.set_jupyter_selection(["r3"], dataset_id="ds1")
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/selection"
    assert body == ["r3"]
    assert params == {"dataset_id": "ds1"}

    client.set_read_filter(["r1"], dataset_id="ds1")
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/filter"
    assert body == {"read_ids": ["r1"], "dataset_id": "ds1"}
    assert params == {}
    assert client.get_read_filter(dataset_id="ds1") == ["r_filter_1", "r_filter_2"]

    client.set_read_order(["r2", "r1"], dataset_id="ds1")
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/order"
    assert body == {"read_ids": ["r2", "r1"], "dataset_id": "ds1"}
    assert params == {}

    assert client.cluster_selected_peaks_in_browser(label="Notebook") == {
        "success": True,
        "queued": 1,
        "label": "Notebook",
    }
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/actions"
    assert body == {"actions": [{"type": "cluster_selected_peaks"}], "label": "Notebook"}
    assert params == {}

    client.cluster_peak_at_gene_tss_in_browser("ftz", padding=5000, tolerance_bp=250, label="Notebook")
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/actions"
    assert body["actions"] == [{
        "type": "cluster_peak_at_gene_tss",
        "gene": "ftz",
        "padding_bp": 5000,
        "tolerance_bp": 250,
    }]
    assert params == {}

    client.highlight_reads(["r1"], color="#ff0000", label="Notebook hit", dataset_id="ds1")
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/highlights"
    assert body["read_ids"] == ["r1"]
    assert body["dataset_id"] == "ds1"
    assert params == {}

    client.color_footprints({"r1": [{"start": 10, "end": 20, "color": "#00ff00"}]}, group="hits")
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/footprint_colors"
    assert body["group"] == "hits"
    assert body["footprint_colors"]["r1"][0]["start"] == 10
    assert params == {}

    assert client.get_footprint_colors() == [{"id": "color-1", "group": "hits"}]
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/jupyter/footprint_colors"
    assert params == {}

    client.remove_footprint_color("color-1")
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/jupyter/footprint_colors/color-1"
    assert params == {}

    client.add_markers([{"position": 150, "color": "#0000ff"}], group="peaks")
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/markers"
    assert body == {"markers": [{"position": 150, "color": "#0000ff"}], "group": "peaks"}
    assert params == {}

    assert client.get_markers() == [{"id": "marker-1", "group": "peaks"}]
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/jupyter/markers"
    assert params == {}

    client.remove_marker("marker-1")
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/jupyter/markers/marker-1"
    assert params == {}

    assert client.get_custom_reads("custom_ds") == [{"id": "custom_r1", "intervals": [[10, 20]]}]
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/jupyter/custom_reads/custom_ds"
    assert params == {}

    client.set_reproducibility(seed="paper-v1", analysis_cap=10000, display_cap=0, spanning=True)
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/settings"
    assert body == {
        "analysis_sample_seed": "paper-v1",
        "analysis_sample_count": 10000,
        "display_sample_count": None,
        "spanning_only": True,
    }
    assert params == {}

    client.set_reproducibility(display_mode="all", all_reads_display_cap=15000)
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/settings"
    assert body == {"read_display_mode": "all", "all_reads_display_cap": 15000}
    assert params == {}

    client.set_reproducibility(profile_read_cap=0)
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/settings"
    assert body == {"background_read_cap": None}
    assert params == {}

    client.set_cluster_settings(
        method="combinatorial",
        k=12,
        subnucleosomal_threshold=85,
        accessibility_threshold=0.4,
    )
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/settings"
    assert body == {
        "cluster_method": "combinatorial",
        "cluster_k": 12,
        "small_footprint_threshold_bp": 85,
        "accessibility_threshold": 0.4,
    }
    assert params == {}

    client.set_peak_lock(True)
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/peak_rules"
    assert body == {
        "rules": [],
        "lock": True,
        "clear_peaks": False,
        "rescan": False,
    }
    assert params == {}

    client.unlock_peaks()
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/peak_rules"
    assert body["lock"] is False
    assert body["clear_peaks"] is False

    settings = client.get_browser_settings()
    assert settings["analysis_sample_seed"] == "paper-v1"
    assert settings["active_colormap"]["name"] == "Paper labels"
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/jupyter/settings"
    assert params == {}

    client.sync_jupyter_browser_settings({"analysis_sample_seed": "paper-v2", "spanning_only": False})
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/settings/sync"
    assert body == {"analysis_sample_seed": "paper-v2", "spanning_only": False}
    assert params == {}

    client.apply_browser_settings(settings, clear_peaks=False, rescan=True)
    _, endpoint, body, params = client.calls[-2]
    assert endpoint == "/api/jupyter/settings"
    assert body == {
        "analysis_sample_seed": "paper-v1",
        "analysis_sample_count": None,
        "display_sample_count": 500,
        "read_display_mode": "sample",
        "all_reads_display_cap": 10000,
        "background_read_cap": 750,
        "spanning_only": True,
        "selected_peaks": [7],
        "peak_modes": {"7": "accessibility"},
        "peaks_by_rule": {"rule-a": [{"index": 7, "start": 200, "end": 260}]},
        "cluster_feature_rules": [{"id": "cluster-tf", "terms": [{"source": "layer", "layer": "tf"}]}],
        "analysis_sort_rules": [{"id": "sort-pol2", "terms": [{"source": "transcription_state", "transcriptionState": "pause"}], "metric": "count"}],
        "analysis_filter_rules": [{"id": "filter-fire", "terms": [{"source": "layer", "layer": "fire"}], "metric": "count", "operator": "gte", "threshold": 1}],
        "active_colormap": {
            "name": "Paper labels",
            "backgroundColor": "#ffffff",
            "readBackgroundColor": "#f1f5f9",
            "noReadBackgroundColor": "#ffffff",
            "rules": [],
            "layerOpacities": {"nuc": 1, "tf": 0.9, "fire": 0.55},
            "displaySmoothing": {"enabled": False, "sigmaX": 0, "sigmaY": 0},
            "qualityFilters": [],
        },
        "cluster_method": "kmeans",
        "cluster_k": 10,
        "small_footprint_threshold_bp": 90,
        "accessibility_threshold": 0.45,
        "capture_regions": [{"id": "cap1", "chrom": "chr2L", "start": 100, "end": 200}],
        "capture_padding": 25,
        "catalog": [{"id": "cat1", "kind": "bigbed", "label": "TF"}],
        "composite_tracks": [{"id": "comp1", "label": "TF track"}],
        "saved_tracks": [{"id": "saved1", "name": "TF saved"}],
        "selected_genes": [{"id": "tx1", "name": "GeneA", "chrom": "chr2L", "start": 100, "end": 300, "strand": "+", "exons": []}],
        "transcription_state_filters": {"pause": True, "pic": False, "elongating": None},
        "primer_saved_primers": [{"name": "PrimerA", "pair": {"fwd_seq": "ATGC", "rev_seq": "GCAT"}, "chrom": "chr2L"}],
        "primer_mode": "standard",
        "primer_cart_track_display": "design",
        "enabled_mod_types": {"nuc": True, "tf": True, "fire": False},
        "enabled_meta_profiles": {"nuc": True, "tf": True},
        "cached_layer_types": {"tf": True, "fire": False},
        "click_target_layer": "tf",
        "footprint_analysis_layer": "tf",
        "fill_read_height": True,
        "coacc_settings": {
            "coaccTrackMode": "heatmap",
            "coaccSignalType": "small_fp",
            "coaccLayer": "tf",
            "coaccNormalization": "correlation",
            "coaccBinSize": 100,
        },
        "read_row_height": 12,
        "show_coverage_histogram": True,
        "max_region_for_reads": 250000,
        "show_genome_overview": False,
    }
    assert params == {}
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/peak_rules"
    assert body == {
        "rules": [{"id": "rule-a", "source": "tf_layer", "enabled": True}],
        "lock": True,
        "clear_peaks": False,
        "rescan": True,
    }

    client.apply_browser_settings({
        "selected_read_ids": {"ds1": ["r1", "r2"], "ds2": ["r3"]},
    })
    _, endpoint, body, params = client.calls[-2]
    assert endpoint == "/api/jupyter/selection"
    assert body == ["r1", "r2"]
    assert params == {"dataset_id": "ds1"}
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/selection"
    assert body == ["r3"]
    assert params == {"dataset_id": "ds2"}

    out = tmp_path / "browser_settings.json"
    assert client.save_browser_settings_json(str(out)) == str(out)
    assert '"analysis_sample_seed": "paper-v1"' in out.read_text()

    labels_json = tmp_path / "labels.json"
    assert client.save_labeling_json(str(labels_json)) == str(labels_json)
    assert '"name": "Paper labels"' in labels_json.read_text()

    client.load_labeling_json(str(labels_json))
    _, endpoint, body, params = client.calls[-2]
    assert endpoint == "/api/jupyter/settings"
    assert body["active_colormap"]["name"] == "Paper labels"
    assert body["active_colormap"]["readBackgroundColor"] == "#f1f5f9"
    assert body["active_colormap"]["displaySmoothing"] == {"enabled": False, "sigmaX": 0, "sigmaY": 0}
    assert body["active_colormap"]["layerOpacities"]["fire"] == 0.55
    assert body["active_colormap"]["qualityFilters"] == []
    assert params == {}
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/quality_filters"
    assert body == {"filters": []}
    assert params == {}

    manifest = client.get_session_manifest()
    assert manifest["sessionName"] == "Paper session"
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/jupyter/session_manifest"
    assert params == {}

    manifest_txt = tmp_path / "manifest.txt"
    assert client.save_session_manifest(str(manifest_txt), text=True) == str(manifest_txt)
    manifest_text = manifest_txt.read_text()
    assert "FiberBrowser session: Paper session" in manifest_text
    assert "Labeling: Paper labels, 0 rules (0 enabled)" in manifest_text
    assert "Footprint rules: 1 total, 1 enabled, 1 pinned, layers=TF" in manifest_text

    peak_state = client.get_peak_state()
    assert peak_state["peaks_locked"] is True
    assert peak_state["selected_peaks"] == [7]
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/jupyter/analysis_state"
    assert params == {}

    assert client.get_capture_regions()[0]["id"] == "cap1"
    assert client.get_footprint_rule_summary()["layers"] == ["TF"]
    assert client.get_active_filters()["active_quality_filters"][0]["layer"] == "fire"
    assert client.get_track_cart()["composite_tracks"][0]["id"] == "comp1"
    display_state = client.get_analysis_state()["display"]
    assert display_state["click_target_layer"] == "tf"
    assert display_state["cached_layer_types"]["fire"] is False
    assert display_state["fill_read_height"] is True
    assert display_state["read_display_mode"] == "sample"
    assert display_state["all_reads_display_cap"] == 10000
    assert display_state["show_coverage_histogram"] is True
    assert client.get_coacc_settings()["coaccTrackMode"] == "heatmap"
    assert client.get_coacc_settings()["coaccLayer"] == "tf"
    assert client.get_cluster_state()["read_sort_order"]["primary"] == ["read_a"]
    panel_state = client.get_panel_state()
    assert panel_state["active_panels"][0]["content_type"] == "cluster-detail"
    assert panel_state["hidden_strip_panels"] == ["history"]
    assert "annotations" in panel_state["known_panel_types"]
    assert "circular-genome" in panel_state["known_panel_types"]
    assert BrowserClient.normalize_panel_type("clusters") == "cluster-detail"
    assert BrowserClient.normalize_panel_type("quality") == "colormap"
    assert BrowserClient.normalize_panel_type("genome navigator") == "circular-genome"

    client.open_panel("cluster-detail")
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/settings"
    assert body == {"open_panel": "cluster-detail"}
    assert params == {}

    client.set_coacc_settings(
        track_mode="arc",
        signal_type="all_fp",
        layer="fire",
        normalization="oe_distance",
        scaling="sqrt",
        colormap="viridis",
        min_coverage=35,
        bin_size=250,
        arc_threshold=2.5,
        arc_max_arcs=75,
        arc_min_distance=4,
        v4c_viewpoint={"start": 120, "end": 140, "label": "vp"},
    )
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/settings"
    assert body == {
        "coacc_settings": {
            "coaccTrackMode": "arc",
            "coaccSignalType": "all_fp",
            "coaccLayer": "fire",
            "coaccNormalization": "oe_distance",
            "coaccScaling": "sqrt",
            "coaccColormap": "viridis",
            "coaccMinCoverage": 35,
            "coaccBinSize": 250,
            "coaccArcThreshold": 2.5,
            "coaccArcMaxArcs": 75,
            "coaccArcMinDistance": 4,
            # A viewpoint given without a chromosome is the current view's.
            "coaccV4cViewpoint": {"start": 120, "end": 140, "label": "vp", "chrom": "chr1"},
        }
    }
    assert params == {}

    client.set_display_settings(click_target_layer="msp", footprint_analysis_layer="all")
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/settings"
    assert body == {"click_target_layer": "fire", "footprint_analysis_layer": None}
    assert params == {}

    client.open_panel("clusters")
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/settings"
    assert body == {"open_panel": "cluster-detail"}
    assert params == {}

    client.open_panel("plasmid")
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/settings"
    assert body == {"open_panel": "circular-genome"}
    assert params == {}

    client.close_panel("stats")
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/settings"
    assert body == {"close_panel": "read-stats"}
    assert params == {}

    client.set_hidden_panels(["history", "stats", "history"])
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/settings"
    assert body == {"hidden_strip_panels": ["history", "read-stats"]}
    assert params == {}

    client.hide_strip_panels("clusters")
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/settings"
    assert body == {"hidden_strip_panels": ["history", "cluster-detail"]}
    assert params == {}

    client.show_strip_panels("history")
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/settings"
    assert body == {"hidden_strip_panels": []}
    assert params == {}

    client.set_capture_regions([{"id": "cap2", "chrom": "chr3R", "start": 5, "end": 10}], padding=50)
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/settings"
    assert body == {
        "capture_regions": [{"id": "cap2", "chrom": "chr3R", "start": 5, "end": 10}],
        "capture_padding": 50,
    }
    assert params == {}

    client.set_display_settings(
        enabled_mod_types={"tf": True, "fire": False},
        cached_layer_types={"tf": True},
        click_target_layer="tf",
        footprint_analysis_layer="tf",
        fill_read_height=True,
        read_row_height="auto",
        profile_read_cap=750,
        show_coverage_histogram=True,
        max_region_for_reads=250000,
        show_genome_overview=False,
    )
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/settings"
    assert body == {
        "enabled_mod_types": {"tf": True, "fire": False},
        "cached_layer_types": {"tf": True},
        "click_target_layer": "tf",
        "footprint_analysis_layer": "tf",
        "fill_read_height": True,
        "read_row_height": "auto",
        "background_read_cap": 750,
        "show_coverage_histogram": True,
        "max_region_for_reads": 250000,
        "show_genome_overview": False,
    }
    assert params == {}

    client.set_legacy_layer_inference(False, 120)
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/settings"
    assert body == {"legacy_layer_inference": False, "legacy_nuc_min_size": 120}
    assert params == {}

    client.set_visible_layers(tf=True, nuc=True, msp=False, deam=False)
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/settings"
    assert body == {"enabled_mod_types": {"tf": True, "nuc": True, "fire": False, "deam": False}}
    assert params == {}

    client.set_metaprofile_layers(["tf", "nuc"], deam=False)
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/settings"
    assert body == {"enabled_meta_profiles": {"tf": True, "nuc": True, "deam": False}}
    assert params == {}

    client.set_layer_cache({"tf_layer": True, "msp": False, "methyl_m6a": True})
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/settings"
    assert body == {"cached_layer_types": {"tf": True, "fire": False, "m6a": True}}
    assert params == {}

    client.set_track_cart(
        catalog=[{"id": "cat2"}],
        composite_tracks=[{"id": "comp2"}],
        saved_tracks=[{"id": "saved2"}],
    )
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/settings"
    assert body == {
        "catalog": [{"id": "cat2"}],
        "composite_tracks": [{"id": "comp2"}],
        "saved_tracks": [{"id": "saved2"}],
    }
    assert params == {}

    client.cluster_synced_peaks(chrom="chr2L", start=100, end=300, dataset_ids=["primary"])
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/cluster_all"
    assert body["peak_regions"] == [{"start": 200, "end": 260, "mode": "accessibility"}]
    assert body["method"] == "kmeans"
    assert body["k"] == 10
    assert params == {"chrom": "chr2L", "start": 100, "end": 300, "spanning": "false"}

    client.fetch_pol2_com(
        chrom="chr2L",
        start=1000,
        end=2000,
        spanning=True,
        dataset_ids=["ds1"],
        gene_ids=["geneA"],
        fp_size_min=30,
        fp_size_max=70,
        n_bins=50,
        smoothing_sigma=1.5,
        sample_seed="seed-pol2",
    )
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/pol2_com"
    assert params == {"chrom": "chr2L", "start": 1000, "end": 2000, "spanning": "true"}
    assert body == {
        "gene_ids": ["geneA"],
        "fp_size_min": 30,
        "fp_size_max": 70,
        "n_bins": 50,
        "smoothing_sigma": 1.5,
        "sample_seed": "seed-pol2",
        "dataset_ids": ["ds1"],
    }


def test_transcription_state_client_maps_keywords_and_counts_helper():
    client = DummyClient()

    client.filter_by_transcription_state(
        gene_ids="geneA",
        chrom="chr2L",
        start=1000,
        end=2000,
        spanning=True,
        dataset_ids="ds1",
        pause=True,
        elongating=2,
        elongating_max=5,
        sample_seed="seed-tx",
    )

    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/filter_by_transcription_state"
    assert params == {"chrom": "chr2L", "start": 1000, "end": 2000, "spanning": "true"}
    assert body == {
        "gene_ids": ["geneA"],
        "filters": {
            "pause": True,
            "elongating": 2,
            "elongating_max": 5,
        },
        "dataset_ids": ["ds1"],
        "sample_seed": "seed-tx",
    }

    client.get_transcription_state_counts(
        gene_ids=["geneA", "geneB"],
        chrom="chr2L",
        start=1000,
        end=2000,
        dataset_ids=["ds1", "ds2"],
        sample_seed="seed-counts",
    )

    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/filter_by_transcription_state"
    assert params == {"chrom": "chr2L", "start": 1000, "end": 2000, "spanning": "false"}
    assert body == {
        "gene_ids": ["geneA", "geneB"],
        "filters": {"pause": True, "pic": True, "elongating": 1},
        "dataset_ids": ["ds1", "ds2"],
        "sample_seed": "seed-counts",
    }


def test_copilot_client_methods_map_current_routes():
    client = DummyClient()

    client.get_copilot_capabilities()
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/nl/capabilities"
    assert params == {}

    client.plan_natural_language_command("go to Dfd", context={"chrom": "2R"}, model="m1", previous_turns=[{"text": "hi"}])
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/nl/plan"
    assert body == {
        "text": "go to Dfd",
        "context": {"chrom": "2R"},
        "model": "m1",
        "previous_turns": [{"text": "hi"}],
    }
    assert params == {}

    client.copilot_agent_step(text="cluster selected peaks", context={"chrom": "2R"})
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/nl/agent_step"
    assert body["messages"] == []
    assert body["text"] == "cluster selected peaks"
    assert body["context"] == {"chrom": "2R"}
    assert params == {}

    client.setup_copilot(model_id="fiberbrowser-copilot-3b-v1-q4")
    _, endpoint, body, _ = client.calls[-1]
    assert endpoint == "/api/nl/setup"
    assert body == {"model_id": "fiberbrowser-copilot-3b-v1-q4"}

    client.probe_copilot_backends()
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/nl/probe_backends"
    assert params == {}

    client.set_copilot_backend("mlx")
    _, endpoint, body, _ = client.calls[-1]
    assert endpoint == "/api/nl/set_backend"
    assert body == {"backend": "mlx"}

    client.log_copilot_session(session_id="s1", snapshots=[{"a": 1}], share=True)
    _, endpoint, body, _ = client.calls[-1]
    assert endpoint == "/api/nl/log_session"
    assert body["session_id"] == "s1"
    assert body["snapshots"] == [{"a": 1}]
    assert body["share"] is True

    client.get_copilot_share_status()
    _, endpoint, _ = client.calls[-1]
    assert endpoint == "/api/nl/share_status"

    client.get_copilot_share_upload_status()
    _, endpoint, _ = client.calls[-1]
    assert endpoint == "/api/nl/share_upload_status"

    client.clear_copilot_shared_usage()
    _, endpoint, _, _ = client.calls[-1]
    assert endpoint == "/api/nl/share_clear"

    client.send_copilot_shared_usage()
    _, endpoint, _, _ = client.calls[-1]
    assert endpoint == "/api/nl/share_send"


def test_analysis_rules_client_maps_settings_and_execution_helpers(tmp_path):
    client = DummyClient()
    gene = {"id": "tx1", "name": "GeneA", "chrom": "chr2L", "start": 100, "end": 300, "strand": "+", "exons": []}
    peak = {"index": 7, "chrom": "chr2L", "start": 120, "end": 160, "layer": 1}

    rules = client.get_analysis_rules()
    assert rules["cluster_feature_rules"][0]["id"] == "cluster-tf"
    assert rules["analysis_sort_rules"][0]["id"] == "sort-pol2"
    assert rules["analysis_filter_rules"][0]["id"] == "filter-fire"

    primer_cart = client.get_primer_cart()
    assert primer_cart["saved_primers"][0]["name"] == "PrimerA"
    client.set_primer_cart(saved_primers=[{"name": "PrimerB"}], mode="4c", cart_track_display="all")
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/settings"
    assert body == {
        "primer_saved_primers": [{"name": "PrimerB"}],
        "primer_mode": "4c",
        "primer_cart_track_display": "all",
    }
    assert params == {}

    client.set_analysis_rules(cluster_feature_rules=[{"id": "cluster-a"}], analysis_sort_rules=[{"id": "sort-a"}])
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/settings"
    assert body == {"cluster_feature_rules": [{"id": "cluster-a"}], "analysis_sort_rules": [{"id": "sort-a"}]}
    assert params == {}

    out = tmp_path / "analysis_rules.json"
    assert client.save_analysis_rules_json(str(out)) == str(out)
    client.load_analysis_rules_json(str(out))
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/jupyter/settings"
    assert body["cluster_feature_rules"][0]["id"] == "cluster-tf"
    assert body["analysis_sort_rules"][0]["id"] == "sort-pol2"
    assert body["analysis_filter_rules"][0]["id"] == "filter-fire"
    assert params == {}

    sort_rule = {
        "id": "sort-pol2",
        "scope": {"kind": "gene", "geneId": "tx1"},
        "terms": [{"source": "transcription_state", "transcriptionState": "pause"}],
        "metric": "count",
        "descending": False,
    }
    client.sort_by_analysis_rule(
        sort_rule,
        chrom="chr2L",
        start=50,
        end=350,
        dataset_ids="ds1",
        selected_genes=[gene],
        peaks=[peak],
        sample_seed="seed-rule",
    )
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/sort_reads"
    assert params == {"chrom": "chr2L", "start": 50, "end": 350, "spanning": "false"}
    assert body["sort_by"] == "transcription_state"
    assert body["dataset_ids"] == ["ds1"]
    assert body["transcription_state"] == "pause"
    assert body["gene_ids"] == ["tx1"]
    assert body["selected_peak_windows"] == [[100, 300]]
    assert body["peak_regions"] == [[120, 160]]
    assert body["descending"] is False
    assert body["sample_seed"] == "seed-rule"

    # A count rule on a layer sends the layer too (the server counts that layer's intervals).
    client.sort_by_analysis_rule(
        {"id": "sort-tf", "scope": {"kind": "currentWindow"},
         "terms": [{"source": "layer", "layer": "tf", "sizeMin": 20, "sizeMax": 80}], "metric": "count"},
        chrom="chr2L", start=50, end=350, dataset_ids="ds1", peaks=[peak],
    )
    _, endpoint, body, _ = client.calls[-1]
    assert endpoint == "/api/sort_reads"
    assert body["sort_by"] == "rule" and body["layer"] == "tf" and body["rule"]

    filter_rule = {
        "id": "filter-tf",
        "scope": {"kind": "currentWindow"},
        "terms": [{"source": "layer", "layer": "tf", "sizeMin": 20, "sizeMax": 80}],
        "metric": "count",
        "operator": "gte",
        "threshold": 2,
    }
    client.filter_by_analysis_rule(
        filter_rule,
        chrom="chr2L",
        start=50,
        end=350,
        dataset_ids=["ds1", "ds2"],
        peaks=[peak],
    )
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/filter_by_analysis_rule"
    assert params == {"chrom": "chr2L", "start": 50, "end": 350, "spanning": "false"}
    assert body["dataset_ids"] == ["ds1", "ds2"]
    assert body["scope_windows"] == [[50, 350]]
    assert body["peak_regions"] == [[120, 160]]
    assert body["rule"] == {"size_min": 20.0, "size_max": 80.0, "conditions": [], "quality_gates": []}

    cluster_rule = {
        "id": "cluster-tf",
        "scope": {"kind": "selectedPeaks"},
        "terms": [{"source": "layer", "layer": "tf"}],
    }
    client.cluster_by_feature_rule(
        cluster_rule,
        chrom="chr2L",
        start=50,
        end=350,
        dataset_ids="ds1",
        peaks=[peak],
        selected_peaks=[7],
        method="kmeans",
        k=4,
    )
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/cluster_all"
    assert params == {"chrom": "chr2L", "start": 50, "end": 350, "spanning": "false"}
    assert body["peak_regions"] == [{"start": 120, "end": 160, "mode": "cluster_rule:cluster-tf"}]
    assert body["cluster_feature_rules"] == [cluster_rule]
    assert body["dataset_ids"] == ["ds1"]
    assert body["method"] == "kmeans"
    assert body["k"] == 4


def test_file_picker_aliases_map_current_router_shapes():
    client = DummyClient()

    client.pick_folder()
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/pick_folder"
    assert params == {}

    client.load_folder("/data/run")
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/load_folder"
    assert body == {}
    assert params == {"path": "/data/run"}

    client.pick_file("fasta")
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/pick_file"
    assert params == {"file_type": "fasta"}

    client.pick_dataset()
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/pick_file"
    assert params == {"file_type": "dataset", "multiple": "true"}

    client.pick_any_file()
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/pick_file"
    assert params == {"file_type": "any", "multiple": "true"}

    client.pick_overlay_file("bed")
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/pick_file"
    assert params == {"file_type": "overlay", "overlay_type": "bed"}

    client.pick_annotation_file()
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/pick_file"
    assert params == {"file_type": "annotation"}

    client.pick_file_primer("blast")
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/pick_file_primer"
    assert params == {"file_type": "blast"}

    client.build_primer_blast_db(force=True, output_dir="/tmp/fiberblast")
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/primer_blast_db/build"
    assert body == {}
    assert params == {"force": True, "output_dir": "/tmp/fiberblast"}


def test_annotation_client_maps_current_router_shapes():
    client = DummyClient()

    assert client.get_annotation_files() == []
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/annotations/files"
    assert params == {}

    client.add_annotation("/tmp/tf.bb", label="TF", dataset_ids=["ds1"])
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/annotations/add"
    assert body == {"path": "/tmp/tf.bb", "label": "TF", "dataset_ids": ["ds1"]}
    assert params == {}

    files = client.browse_annotation_files("/tmp")
    assert files == [{"name": "tf.bb", "path": "/tmp/tf.bb"}]
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/annotations/browse"
    assert params == {"dir": "/tmp"}

    client.get_annotation_profile(
        chrom="chr2L",
        start=10,
        end=20,
        dataset_id="ds1",
        annotation_types=["GAF", "M1BP"],
        bins=250,
    )
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/annotations/profile"
    assert params == {
        "chrom": "chr2L",
        "start": 10,
        "end": 20,
        "dataset_id": "ds1",
        "bins": 250,
        "annotation_types": "GAF,M1BP",
    }

    client.filter_by_annotations(["GAF"], chrom="chr2L", start=10, end=20)
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/annotations/filter"
    assert body["filter_mode"] == "has_any"
    assert body["annotation_types"] == ["GAF"]
    assert params == {}

    client.get_annotations_for_region(
        chrom="chr2L",
        start=10,
        end=20,
        dataset_ids="primary",
        file_ids="ann_tf",
        as_dataframe=False,
    )
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/annotations/region"
    assert params == {
        "chrom": "chr2L",
        "start": 10,
        "end": 20,
        "dataset_ids": "primary",
        "file_ids": "ann_tf",
    }

    client.filter_by_annotations(
        ["GAF"],
        chrom="chr2L",
        start=10,
        end=20,
        dataset_ids="primary",
        sample_seed="seed-annotation",
    )
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/annotations/filter"
    assert body["dataset_ids"] == ["primary"]
    assert body["sample_seed"] == "seed-annotation"
    assert params == {}

    client.cluster_by_annotations(
        ["GAF"],
        peak_regions=[{"start": 10, "end": 20}],
        chrom="chr2L",
        start=10,
        end=20,
        dataset_ids="primary",
        sample_seed="seed-annotation",
    )
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/annotations/cluster"
    assert body["dataset_ids"] == ["primary"]
    assert body["peak_regions"] == [{"start": 10, "end": 20}]
    assert body["sample_seed"] == "seed-annotation"
    assert params == {}

    client.deactivate_annotation("ann_tf")
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/annotations/deactivate"
    assert body == {"file_id": "ann_tf"}
    assert params == {}

    client.remove_annotation_file("ann_tf")
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/annotations/ann_tf"
    assert params == {}


def test_detect_signal_peaks_maps_generic_endpoint():
    client = DummyClient()

    client.detect_signal_peaks(
        [0.0, 1.0, 0.0],
        chrom="chr2L",
        start=100,
        end=400,
        label="custom",
        min_distance=50,
        min_width=25,
        threshold_pct=75,
        threshold_value=0.2,
    )

    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/detect_peaks"
    assert body == {
        "signal": [0.0, 1.0, 0.0],
        "chrom": "chr2L",
        "start": 100,
        "end": 400,
        "label": "custom",
        "min_distance_bp": 50,
        "min_width_bp": 25,
        "threshold_percentile": 75,
        "threshold_value": 0.2,
    }
    assert params == {}


def test_microc_client_maps_current_query_params():
    client = DummyClient()

    client.get_microc_matrix(
        chrom="chr2L",
        start=100,
        end=1000,
        normalization="oe_global",
        resolution=5000,
    )
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/microc/matrix/data"
    assert params == {
        "chrom": "chr2L",
        "start": 100,
        "end": 1000,
        "normalization": "oe_global",
        "resolution": 5000,
    }

    arcs = client.get_microc_arcs(
        chrom="chr2L",
        start=100,
        end=1000,
        threshold=0.2,
        max_arcs=50,
        min_distance=2000,
        max_distance=200000,
        resolution=1000,
        normalization="oe",
        stable_strength=True,
        acc_correct=True,
    )
    assert arcs == [{"start": 100, "end": 1000}]
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/microc/arcs"
    assert params["threshold"] == 0.2
    assert params["max_arcs"] == 50
    assert params["min_distance"] == 2000
    assert params["max_distance"] == 200000
    assert params["resolution"] == 1000
    assert params["normalization"] == "oe"
    assert params["stable_strength"] == "true"
    assert params["acc_correct"] == "true"

    client.get_microc_virtual4c(
        position=150,
        chrom="chr2L",
        start=100,
        end=1000,
        resolution=5000,
        normalization="oe",
    )
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/microc/virtual4c"
    assert params == {
        "chrom": "chr2L",
        "viewpoint_start": 150,
        "viewpoint_end": 151,
        "profile_start": 100,
        "profile_end": 1000,
        "normalization": "oe",
        "resolution": 5000,
    }

    client.select_dafc_region("chr2L", 100, 200, 1000, 1200)
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/dafc/select"
    assert params == {"chrom": "chr2L", "x_start": 100, "x_end": 200, "y_start": 1000, "y_end": 1200}


def test_linked_session_client_maps_current_router_shapes():
    client = DummyClient()

    created = client.create_linked_session()
    assert created["session_id"] == "linked-1"
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/linked/session/create"
    assert body == {}
    assert params == {}

    assert client.get_linked_sessions() == [{"id": "linked-1", "n_reads": 2}]
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/linked/sessions"
    assert params == {}

    assert client.get_linked_session("linked-1")["version"] == 3
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/linked/session/linked-1"
    assert params == {}

    sent = client.send_to_linked_session(
        "linked-1",
        chrom="chr2L",
        x_start=100,
        x_end=500,
        y_start=800,
        y_end=1200,
        read_ids=["r1", "r2"],
        contact_mode="dafc",
        split_view_mode="molecule_linked",
    )
    assert sent["contact_mode"] == "dafc"
    assert sent["split_view_mode"] == "molecule_linked"
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/linked/session/linked-1/send"
    assert body == {
        "regions": {
            "chrom": "chr2L",
            "x_start": 100,
            "x_end": 500,
            "y_start": 800,
            "y_end": 1200,
        },
        "read_ids": ["r1", "r2"],
        "contact_mode": "dafc",
        "split_view_mode": "molecule_linked",
    }
    assert params == {}

    client.send_to_linked_session(
        "linked-1",
        x_chrom="chr2L_hap1",
        x_start=100,
        x_end=500,
        y_chrom="chr2L_hap2",
        y_start=800,
        y_end=1200,
        split_view_mode="coordinate_synced",
    )
    _, endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/linked/session/linked-1/send"
    assert body["regions"] == {
        "chrom": "chr2L_hap1",
        "x_chrom": "chr2L_hap1",
        "x_start": 100,
        "x_end": 500,
        "y_chrom": "chr2L_hap2",
        "y_start": 800,
        "y_end": 1200,
    }
    assert body["split_view_mode"] == "coordinate_synced"
    assert params == {}

    client.get_linked_reads_data("linked-1")
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/linked/reads/data"
    assert params == {"session_id": "linked-1"}

    client.get_linked_reads_compact(
        "linked-1",
        "y",
        max_reads=250,
        sort_by="y",
        hide_terminal_gaps=False,
        terminal_gap_threshold=0,
        sample_seed="linked-seed",
    )
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/linked/reads/compact"
    assert params == {
        "session_id": "linked-1",
        "region": "y",
        "max_reads": 250,
        "sort_by": "y",
        "hide_terminal_gaps": "false",
        "terminal_gap_threshold": 0,
        "sample_seed": "linked-seed",
    }

    try:
        client.get_linked_reads_compact("linked-1", "z")
        raise AssertionError("invalid region should fail")
    except ValueError as exc:
        assert "region must be" in str(exc)

    client.delete_linked_session("linked-1")
    _, endpoint, params = client.calls[-1]
    assert endpoint == "/api/linked/session/linked-1"
    assert params == {}


def test_contact_image_clients_map_current_query_params():
    from PIL import Image

    png = io.BytesIO()
    Image.new("RGB", (1, 1)).save(png, format="PNG")
    calls = []

    class FakeResponse:
        content = png.getvalue()

        def raise_for_status(self):
            return None

    class FakeSession:
        def get(self, url, params=None, timeout=None):
            calls.append((url, params, timeout))
            return FakeResponse()

    client = DummyClient()
    client._session = FakeSession()

    client.get_dafc_image(
        chrom="chr2L",
        start=100,
        end=1000,
        resolution=5000,
        normalization="oe",
        x_start=100,
        x_end=500,
        y_start=600,
        y_end=1000,
        vmin=0.1,
    )
    url, params, timeout = calls[-1]
    assert url == "http://test/api/dafc/matrix/image"
    assert timeout == 60
    assert params["chrom"] == "chr2L"
    assert params["start"] == 100
    assert params["end"] == 1000
    assert params["resolution"] == 5000
    assert params["normalization"] == "oe"
    assert params["x_start"] == 100
    assert params["y_end"] == 1000
    assert params["vmin"] == 0.1
    assert "chrom1" not in params
    assert "bin_size" not in params

    client.get_microc_strip(
        chrom="chr3R",
        start=200,
        end=2000,
        resolution=1000,
        max_distance=50000,
        focus_start=500,
        focus_end=800,
    )
    url, params, timeout = calls[-1]
    assert url == "http://test/api/microc/matrix/strip"
    assert timeout == 60
    assert params["chrom"] == "chr3R"
    assert params["start"] == 200
    assert params["end"] == 2000
    assert params["resolution"] == 1000
    assert params["max_distance"] == 50000
    assert params["focus_start"] == 500
    assert params["focus_end"] == 800
    assert "bin_size" not in params

    client.get_linked_reads_image("linked-1", "x", max_width=1200, row_height=4)
    url, params, timeout = calls[-1]
    assert url == "http://test/api/linked/reads/image"
    assert timeout == 60
    assert params == {
        "session_id": "linked-1",
        "region": "x",
        "max_width": 1200,
        "row_height": 4,
    }


def test_render_maps_reproducible_view_options():
    from PIL import Image

    png = io.BytesIO()
    Image.new("RGB", (1, 1)).save(png, format="PNG")
    calls = []

    class FakeResponse:
        content = png.getvalue()
        headers = {"content-type": "image/png"}

        def raise_for_status(self):
            return None

    class FakeSession:
        def post(self, url, json=None, params=None, timeout=None, files=None):
            calls.append((url, json, timeout, params, files))
            return FakeResponse()

    client = DummyClient()
    client._session = FakeSession()

    img = client.render(
        dataset_ids="primary",
        tracks=("axis", "reads"),
        width=1200,
        row_height=4,
        max_reads=250,
        sample_seed="seed-render",
        use_clusters=True,
        cluster_order={"primary": [2, 1]},
        read_sort_order={"primary": ["read_b", "read_a"]},
        show_layers=True,
        show_mods=False,
        show_fire=True,
        show_cigar=True,
        spanning_only=False,
        sort_by="kmeans",
        n_clusters=4,
        title="Reproducible render",
        quality_shading=True,
    )

    assert img.size == (1, 1)
    url, payload, timeout, params, files = calls[-1]
    assert url == "http://test/api/render"
    assert timeout == 120
    assert params is None
    assert files is None
    assert payload["chrom"] == "chr1"
    assert payload["start"] == 100
    assert payload["end"] == 500
    assert payload["dataset_ids"] == ["primary"]
    assert payload["tracks"] == ["axis", "reads"]
    assert payload["max_reads"] == 250
    assert payload["sample_seed"] == "seed-render"
    assert payload["use_clusters"] is True
    assert payload["read_sort_order"] == {"primary": ["read_b", "read_a"]}
    assert payload["cluster_order"] == {"primary": [2, 1]}
    assert payload["show_layers"] is True
    assert payload["show_mods"] is False
    assert payload["spanning_only"] is False
    assert payload["sort_by"] == "kmeans"
    assert payload["n_clusters"] == 4
    assert payload["quality_shading"] is True
    assert "format" not in payload


def test_legacy_hyperburst_rule_term_raises_clear_error():
    import pytest

    term = {"source": "transcription_state", "transcriptionState": "hyperburst"}
    with pytest.raises(ValueError, match="hyperburst.*has been removed"):
        BrowserClient._analysis_rule_transcription_state(term)
    assert BrowserClient._analysis_rule_transcription_state(
        {"source": "transcription_state", "transcriptionState": "pic"}
    ) == "pic"


class _QualityClient(BrowserClient):
    """Records posts; serves quality filters and impact like the server."""

    def __init__(self, available):
        self.base_url = "http://test"
        self.posts = []
        self.filters = [{"layer": "fire", "quality_name": "aq", "min_value": 230}]
        self.available = available

    def _get(self, endpoint, params=None):
        assert endpoint == "/api/quality_filters"
        return {"filters": list(self.filters)}

    def _post(self, endpoint, data=None, params=None):
        self.posts.append((endpoint, data))
        if endpoint == "/api/quality_filters":
            self.filters = data["filters"]
            return {"success": True}
        if endpoint == "/api/quality/impact":
            return {"success": True, "filters": [], "available": self.available}
        raise AssertionError(endpoint)


def test_set_class_support_targets_layers_with_q0_and_keeps_other_filters():
    client = _QualityClient({"tf_sr": ["q0", "q1"], "nuc": ["nq"]})
    client.set_class_support(150, chrom="chr1", start=0, end=1000)
    assert client.filters == [
        {"layer": "fire", "quality_name": "aq", "min_value": 230},
        {"layer": "tf_sr", "quality_name": "q0", "min_value": 150},
    ]
    client.set_class_support(None)
    assert client.filters == [{"layer": "fire", "quality_name": "aq", "min_value": 230}]


def test_cluster_by_footprints_only_uses_reads_evaluated_for_every_definition():
    client = DummyClient()
    client.analyze_footprints = lambda **kwargs: {"co_occupancy": {"ds1": {"per_group": [
        {"ids_with": ["a", "b"], "ids_without": ["c", "x"]},
        {"ids_with": ["a"], "ids_without": ["b", "c"]},  # x was not evaluated here
    ]}}}
    result = client.cluster_by_footprints(groups=[{"name": "nuc"}, {"name": "tf"}], chrom="chr1", start=0, end=10)
    assert set(result["assignments"]["ds1"]) == {"a", "b", "c"}
    patterns = {entry["pattern"]: entry["label"] for entry in result["legend"]}
    assert patterns == {"11": "+nuc  +tf", "10": "+nuc  -tf", "00": "-nuc  -tf"}
