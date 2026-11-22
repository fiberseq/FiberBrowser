"""BrowserClient surfaces for the 3.1 features (API parity, 3.1.1): request mapping, no server."""
from __future__ import annotations

import warnings

import pytest

from browser_client import ANALYSIS_PANEL_TYPES, BrowserClient


class Recorder(BrowserClient):
    def __init__(self, snapshot=None, prefs=None):
        self.url = "http://test"
        self.calls = []
        self.snapshot = snapshot or {}
        self.prefs = prefs or {}

    def _get(self, endpoint, params=None):
        self.calls.append(("GET", endpoint, params or {}))
        if endpoint == "/api/jupyter/settings":
            return {"settings": self.snapshot}
        if endpoint == "/api/preferences/analysis":
            return self.prefs
        if endpoint.startswith("/api/meta_locus/pools/"):
            return {"pool_id": "p1", "status": "ready"}
        if endpoint.startswith("/api/sequence_search/jobs/"):
            return {"success": True, "job_id": "j1", "status": "done", "result": {"hits": [{"chrom": "chr1"}]}}
        return {}

    def _post(self, endpoint, data=None, params=None):
        self.calls.append(("POST", endpoint, data or {}, params or {}))
        if endpoint == "/api/meta_locus/pools":
            return {"pool_id": "p1", "status": "building"}
        if endpoint == "/api/sequence_search":
            return {"success": True, "job_id": "j1", "status": "running"}
        return {"success": True}

    def _delete(self, endpoint, params=None):
        self.calls.append(("DELETE", endpoint, params or {}))
        return {"success": True}

    def _post_response(self, endpoint, data=None, params=None, timeout=60, files=None):
        self.calls.append(("POST", endpoint, data or {}, params or {}))

        class R:
            def json(self_inner):
                return {"success": True}
        return R()

    def get_region(self):
        return {"chrom": "chr1", "start": 100, "end": 500}

    def last(self):
        return self.calls[-1]


# ---------- read policy on every read path ----------

def test_read_policy_reaches_every_read_method_and_calls_override_it():
    c = Recorder()
    assert c.get_read_policy() == {}
    c.set_read_policy(include_qcfail=True, include_duplicates=True, hide_uncalled=False, min_fp_quality=10)

    c.get_compact_reads()
    params = c.last()[2]
    assert params["include_qcfail"] == "true" and params["include_duplicates"] == "true"
    assert params["hide_uncalled"] == "false" and params["min_fp_quality"] == 10

    c.get_all_reads_response()
    assert c.last()[2]["include_qcfail"] == "true"

    c.get_coverage(include_qcfail=False)
    params = c.last()[2]
    assert params["include_qcfail"] == "false" and "min_fp_quality" not in params

    c.get_reads()
    assert c.last()[2]["hide_uncalled"] == "false"

    c.get_read_stats(["r1"], dataset_id="ds1")
    body = c.last()[2]
    assert body["include_qcfail"] is True and body["hide_uncalled"] is False and body["min_fp_quality"] == 10

    c.cluster([0], hide_uncalled=True)
    assert c.last()[3]["hide_uncalled"] == "true"

    c.set_read_policy(reset=True)
    c.get_compact_reads()
    assert not {"include_qcfail", "include_duplicates", "hide_uncalled"} & set(c.last()[2])


def test_min_footprints_minus_one_is_all_reads_including_uncalled():
    c = Recorder()
    c.get_reads(min_footprints=-1)
    params = c.last()[2]
    assert params["min_footprints"] == -1 and params["hide_uncalled"] == "false"
    c.get_compact_reads(min_footprints=-1)
    assert c.last()[2]["min_footprints"] == -1 and c.last()[2]["hide_uncalled"] == "false"
    c.get_read_stats(["r1"], dataset_id="ds1", min_footprints=-1)
    assert c.last()[2]["min_footprints"] == -1 and c.last()[2]["hide_uncalled"] is False


def test_read_policy_can_set_the_browser_toggles_too():
    c = Recorder()
    c.set_read_policy(include_qcfail=True, hide_uncalled=False, sync_browser=True)
    _, endpoint, body, _ = c.last()
    assert endpoint == "/api/jupyter/settings"
    assert body == {"min_footprints": -1, "show_qc_fail_reads": True}


# ---------- read filters, reverse view ----------

def test_set_read_filters_maps_to_browser_settings_and_validates():
    c = Recorder(snapshot={"min_footprints": -1, "show_qc_fail_reads": True})
    c.set_read_filters(all_reads=True, show_duplicates=True, min_fp_quality=30)
    assert c.last()[2] == {"min_footprints": -1, "show_duplicate_reads": True, "min_fp_quality": 30}
    c.set_read_filters(all_reads=False)
    assert c.last()[2] == {"min_footprints": 5}
    with pytest.raises(ValueError):
        c.set_read_filters(min_footprints=-3)
    with pytest.raises(ValueError):
        c.set_read_filters()
    assert c.get_read_filters()["min_footprints"] == -1
    c.set_reverse_view()
    assert c.last()[2] == {"reversed": True}


# ---------- metaprofile follow ----------

def test_metaprofile_layers_and_follow_mode():
    c = Recorder(snapshot={"enabled_meta_profiles": {"nuc": True}, "metaprofile_follow_active_layers": False})
    c.set_metaprofile_layers(tf=False)
    assert c.last()[2] == {"enabled_meta_profiles": {"tf": False}}
    c.set_metaprofile_layers(follow_active_layers=True)
    assert c.last()[2] == {"metaprofile_follow_active_layers": True}
    c.set_metaprofile_follow(False)
    assert c.last()[2] == {"metaprofile_follow_active_layers": False}
    with pytest.raises(ValueError):
        c.set_metaprofile_layers()
    assert c.get_metaprofile_layers() == {"layers": {"nuc": True}, "follow_active_layers": False}


# ---------- layer colours ----------

def test_layer_colours_session_and_saved_defaults(monkeypatch):
    c = Recorder(snapshot={"layer_color_overrides": {"nuc": "#111111"}}, prefs={"layer_colors": {"tf": "#222222", "nuc": "#999999"}})
    c.set_layer_colors(nuc="#4b5563", fire=None)
    assert c.last()[2] == {"layer_color_overrides": {"nuc": "#4b5563", "fire": None}}
    c.set_layer_colors({"tf": "#000000"}, replace=True)
    assert c.last()[2] == {"layer_color_overrides": {"tf": "#000000"}, "replace_layer_color_overrides": True}
    with pytest.raises(ValueError):
        c.set_layer_colors()
    c.reset_layer_colors()
    assert c.last()[2] == {"layer_color_overrides": {}, "replace_layer_color_overrides": True}
    c.reset_layer_colors("nuc")
    assert c.last()[2] == {"layer_color_overrides": {"nuc": None}}
    colors = c.get_layer_colors()
    assert colors["session"] == {"nuc": "#111111"}
    assert colors["saved_defaults"] == {"tf": "#222222", "nuc": "#999999"}
    assert colors["effective"] == {"tf": "#222222", "nuc": "#111111"}

    puts = []

    class Resp:
        status_code = 200

        def json(self):
            return {"layer_colors": {"tf": "#abcdef"}}

    class Session:
        def put(self, url, json=None, timeout=None):
            puts.append((url, json))
            return Resp()
    monkeypatch.setattr(c, "_http_session", lambda: Session())
    assert c.set_default_layer_colors(tf="#ABCDEF") == {"tf": "#abcdef"}
    assert puts == [("http://test/api/preferences/analysis", {"layer_colors": {"tf": "#ABCDEF"}})]
    assert c.last()[2] == {"user_layer_colors": {"tf": "#ABCDEF"}}  # the open tab takes them at once


def test_saving_default_colours_reports_a_refusal(monkeypatch):
    c = Recorder()

    class Resp:
        status_code = 403
        text = "no"

        def json(self):
            return {"detail": "Preferences are kept only by your own FiberBrowser"}

    class Session:
        def put(self, url, json=None, timeout=None):
            return Resp()
    monkeypatch.setattr(c, "_http_session", lambda: Session())
    with pytest.raises(RuntimeError, match="your own FiberBrowser"):
        c.set_default_layer_colors(nuc="#000000")


# ---------- Quantify a window ----------

def test_window_quant_window_spec_axis_and_card():
    c = Recorder(snapshot={"window_quant": {"window": None}})
    c.set_quant_window(start=1000, end=2000)
    assert c.last()[2] == {"window_quant": {"window": {"chrom": "chr1", "from": 1000, "to": 2000, "relative": False}}}
    c.set_quant_window()
    assert c.last()[2] == {"window_quant": {"window": None}}
    c.set_quant_spec(comparison="datasets", min_reads=50, layer_units="exact")
    assert c.last()[2] == {"window_quant": {"spec": {"comparison": "datasets", "minReads": 50, "layerUnits": "exact"}}}
    c.set_metaprofile_axis("relative", anchor="gene-end", gene="g1")
    assert c.last()[2]["window_quant"]["axis"] == {"mode": "relative", "anchor": "gene-end", "gene": "g1", "position": None}
    c.open_quantify("cluster")
    assert c.last()[2] == {"window_quant": {"open_in": "cluster"}}
    with pytest.raises(ValueError):
        c.set_metaprofile_axis(anchor="middle")
    with pytest.raises(ValueError):
        c.set_quant_window(start=10, end=5)
    with pytest.raises(ValueError):
        c.open_quantify("elsewhere")
    assert c.get_window_quant() == {"window": None}


# ---------- Plots ----------

def test_plots_open_keep_state_and_workspace():
    gallery = [{"id": "g1", "name": "Plot 1", "status": "kept", "plot_id": "p1"}]
    c = Recorder(snapshot={"workspace": "plots", "plots_workspace": {"current": {"id": "p1", "type": "metaprofile"}},
                           "plots_gallery": gallery})
    c.open_plot({"type": "metaprofile"}, group_by="cluster", sources=["nuc", "tf"])
    assert c.last()[2] == {"plot": {"type": "metaprofile", "groupBy": "cluster", "sources": ["nuc", "tf"]}}
    c.keep_plot("Fig 2b")
    _, endpoint, body, _ = c.last()
    assert endpoint == "/api/jupyter/actions" and body["actions"] == [{"type": "plots_keep", "name": "Fig 2b"}]
    c.set_workspace("hub")
    assert c.last()[2] == {"workspace": "hub"}
    c.close_plots()
    assert c.last()[2] == {"workspace": "browser"}
    with pytest.raises(ValueError):
        c.set_workspace("plotz")
    state = c.get_plots_state()
    assert state["workspace"] == "plots" and state["gallery"] == gallery
    assert c.get_plot_spec() == {"id": "p1", "type": "metaprofile"}
    c.load_bed_regions("/data/sites.bed")
    assert c.last()[1:3] == ("/api/plots/bed_regions", {"path": "/data/sites.bed"})


# ---------- meta-locus ----------

def test_meta_locus_rest_wrappers():
    c = Recorder()
    status = c.start_meta_locus_pool("/data/tss.bed", dataset_ids="ds1", flank_bp=2000, wait=True, poll_interval=0)
    assert status["status"] == "ready"
    first = next(call for call in c.calls if call[1] == "/api/meta_locus/pools")
    assert first[2] == {"anchor": "centre", "flank_bp": 2000, "bed_path": "/data/tss.bed", "dataset_ids": ["ds1"]}
    with pytest.raises(ValueError):
        c.start_meta_locus_pool()
    c.get_meta_locus_reads("p1", seed=3, count=100, cursor={"ds1": 100}, include_duplicates=True)
    assert c.last()[1:3] == ("/api/meta_locus/pools/p1/reads", {"seed": 3, "count": 100, "include_duplicates": True, "cursor": {"ds1": 100}})
    with pytest.raises(ValueError, match="include_qcfail"):
        c.get_meta_locus_reads("p1", include_qcfail=True)   # the pool's working set has no QC-fail reads
    c.set_meta_locus_view("p1", more=500, resample=True)
    assert c.last()[2] == {"more": 500, "resample": True}
    c.find_more_meta_locus("p1", {"ds1": ["r1"]}, k=50)
    assert c.last()[2] == {"read_ids": {"ds1": ["r1"]}, "k": 50}
    c.delete_meta_locus_pool("p1")
    assert c.last() == ("DELETE", "/api/meta_locus/pools/p1", {})


def test_meta_locus_live_actions():
    c = Recorder(snapshot={"meta_locus": {"bed_path": "/data/tss.bed", "seed": 2}})
    c.open_meta_locus("/data/tss.bed", flank_bp=5000, count=500, seed=2, enable_preview=True)
    action = c.last()[2]["actions"][0]
    assert action == {"type": "open_meta_locus", "bed_path": "/data/tss.bed", "anchor": "centre", "flank_bp": 5000,
                      "navigate": True, "count": 500, "seed": 2, "enable_preview": True}
    c.meta_locus_more_reads(250)
    assert c.last()[2]["actions"] == [{"type": "meta_locus_more_reads", "count": 250}]
    c.meta_locus_resample()
    assert c.last()[2]["actions"] == [{"type": "meta_locus_resample"}]
    for method, kind in ((c.meta_locus_back, "meta_locus_back"), (c.meta_locus_return, "meta_locus_return"),
                         (c.meta_locus_clear_extra, "meta_locus_clear_extra")):
        method()
        assert c.last()[2]["actions"] == [{"type": kind}]
    assert c.get_meta_locus_state()["seed"] == 2


# ---------- Find sequence, genomes, runs ----------

def test_find_sequence_polls_until_done():
    c = Recorder()
    job = c.find_sequence(">q\nACGT ACGT", max_mismatches=1, poll_interval=0)
    assert job["status"] == "done" and job["result"]["hits"]
    start = next(call for call in c.calls if call[1] == "/api/sequence_search")
    assert start[2] == {"sequence": ">q\nACGT ACGT", "max_mismatches": 1}
    assert c.find_sequence("ACGT", wait=False)["status"] == "running"
    c.add_sequence_search_track("j1", label="hits")
    assert c.last()[1:3] == ("/api/sequence_search/jobs/j1/track", {"label": "hits"})
    c.cancel_sequence_search("j1")
    assert c.last() == ("DELETE", "/api/sequence_search/jobs/j1", {})


def test_recent_genomes_and_annotation_reset():
    c = Recorder()
    c.get_recent_genomes(limit=4)
    assert c.last() == ("GET", "/api/recent_genomes", {"limit": 4})
    c.pin_genome("registry:dm6")
    assert c.last()[2] == {"key": "registry:dm6", "pinned": True}
    c.unpin_genome("registry:dm6")
    assert c.last()[2] == {"key": "registry:dm6", "pinned": False}
    c.reorder_pinned_genomes(["a", "b"])
    assert c.last()[2] == {"keys": ["a", "b"]}
    c.open_recent_genome("registry:dm6")
    assert c.last()[1:3] == ("/api/recent_genomes/open", {"key": "registry:dm6", "confirm_large": False})
    c.reset_annotation("dm6", confirm_large=True)
    assert c.last()[1] == "/api/genome/reset_annotation" and c.last()[3] == {"genome_id": "dm6", "confirm_large": "true"}
    c.load_genome("dm6", confirm_large=True)
    assert c.last()[3] == {"genome_id": "dm6", "confirm_large": "true"}


def test_runs_pass_min_mapq_explicitly_and_recall_keeps_the_plan():
    c = Recorder()
    samples = [{"name": "s1", "files": [{"path": "/data/s1.bam"}]}]
    c.validate_fiberhmm_run(samples, {"genome_id": "dm6"}, min_mapq=20)
    body = c.last()[2]
    assert c.last()[1] == "/api/pipeline/validate" and body["options"]["min_mapq"] == 20 and body["enzyme"] == "dddb"
    c.run_fiberhmm(samples, {"genome_id": "dm6"}, options={"cores_per_job": 2})
    assert c.last()[1] == "/api/pipeline/jobs" and "min_mapq" not in c.last()[2]["options"]
    c.recall_library_entry("e1")
    assert c.last()[1:3] == ("/api/library/entries/e1/recall", {"dry_run": True})
    c.recall_library_entry("e1", dry_run=False, plan_id="plan9", keep_old=["min_mapq"])
    assert c.last()[2] == {"dry_run": False, "plan_id": "plan9", "keep_old": ["min_mapq"]}


# ---------- named nucleosome classes, panel types ----------

def test_named_nucleosome_conditions_are_dropped_with_a_warning():
    c = Recorder()
    rules = [{"id": "r1", "terms": [{"layer": "nuc", "nucNamed": ["octasome"], "nucCoarse": ["mono"]}]}]
    with pytest.warns(UserWarning, match="named nucleosome-class"):
        c.set_analysis_rules(cluster_feature_rules=rules)
    sent = c.last()[2]["cluster_feature_rules"]
    assert sent == [{"id": "r1", "terms": [{"layer": "nuc", "nucCoarse": ["mono"]}]}]
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        c.set_analysis_rules(analysis_sort_rules=[{"id": "s", "nucNamed": []}])  # empty: nothing to say
    with pytest.warns(UserWarning):
        c.set_labeling_preset({"rules": [{"id": "x", "nucCondition": {"nucNamed": ["hexasome"]}}]}, apply_quality_filters=False)
    assert "nucNamed" not in str(c.last()[2])


def test_panel_types_include_the_31_panels_and_aliases():
    for panel in ("nucleosomes", "sequence-search", "variants", "insertion-lens", "graph-view", "feature-hub", "dataset-layout"):
        assert panel in ANALYSIS_PANEL_TYPES
    assert BrowserClient.normalize_panel_type("find-sequence") == "sequence-search"
    assert BrowserClient.normalize_panel_type("nuc") == "nucleosomes"


def test_new_settings_go_through_set_browser_settings():
    c = Recorder()
    c.set_browser_settings(min_footprints=-1, layer_color_overrides={"nuc": "#000000"})
    endpoint, body = c.last()[1], c.last()[2]
    assert endpoint == "/api/jupyter/settings"
    assert body["min_footprints"] == -1 and body["layer_color_overrides"] == {"nuc": "#000000"}


def test_a_saved_snapshot_replays_the_31_settings():
    c = Recorder()
    snapshot = {"min_footprints": -1, "show_qc_fail_reads": True, "metaprofile_follow_active_layers": None,
                "layer_color_overrides": {"nuc": "#111111"}, "user_layer_colors": None,
                "window_quant": {"window": None, "openIn": "track"}, "workspace": "plots", "reversed": True,
                "plots_workspace": {"current": {"id": "p1", "type": "heatmap"}}}
    c.apply_browser_settings(snapshot)
    body = next(call for call in c.calls if call[1] == "/api/jupyter/settings")[2]
    assert body["min_footprints"] == -1 and body["show_qc_fail_reads"] is True and body["reversed"] is True
    assert body["layer_color_overrides"] == {"nuc": "#111111"} and body["replace_layer_color_overrides"] is True
    assert body["plot"] == {"id": "p1", "type": "heatmap"} and body["workspace"] == "plots"
    assert body["window_quant"] == {"window": None, "openIn": "track"}
    # Not reported is not a value; the computer's saved default colours are not replayed from a snapshot.
    assert "metaprofile_follow_active_layers" not in body and "user_layer_colors" not in body


def test_explicit_zero_quality_overrides_the_policy():
    c = Recorder()
    c.set_read_policy(min_fp_quality=100)
    c.get_compact_reads(min_fp_quality=0)
    assert c.last()[2]["min_fp_quality"] == 0
    c.get_all_reads_response(min_fp_quality=0)
    assert c.last()[2]["min_fp_quality"] == 0
    c.get_compact_reads()
    assert c.last()[2]["min_fp_quality"] == 100


def test_snapshot_replay_restores_bed_sets_and_never_saved_defaults():
    c = Recorder()
    c.apply_browser_settings({"user_layer_colors": {"nuc": "#123456"},
                              "plots_workspace": {"current": {"id": "p1", "type": "bed"}, "regionSets": [{"id": "s1"}]}})
    body = next(call for call in c.calls if call[1] == "/api/jupyter/settings")[2]
    assert "user_layer_colors" not in body
    assert body["plots_region_sets"] == [{"id": "s1"}] and body["plot"]["id"] == "p1"
    c.set_browser_settings(user_layer_colors={"tf": "#000000"})
    assert c.last()[2] == {"user_layer_colors": {"tf": "#000000"}}
    c.set_browser_settings(reversed=True)
    assert c.last()[2] == {"reversed": True}


def test_pipeline_log_is_plain_text():
    c = Recorder()

    class R:
        text = "line 1\nline 2\n"
    c._get_response = lambda endpoint, params=None, timeout=60: R()
    assert c.get_pipeline_job_log("job1") == "line 1\nline 2\n"
