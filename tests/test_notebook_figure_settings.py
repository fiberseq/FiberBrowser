"""Settings pushed from a notebook reach figures drawn with no browser tab (services/figure/notebook_settings.py),
and every notebook setting is decided on: it changes a figure (mapped) or it does not (with the reason)."""
from __future__ import annotations

import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from models.domain import JupyterState
from models.requests import JupyterBrowserSettingsRequest
from services.figure import notebook_settings as ns
from services.figure.spec import resolve_spec
from services.jupyter_endpoint import queue_browser_settings_update

FIGURE_DIR = Path(__file__).resolve().parents[1] / "browser" / "services" / "figure"


def _engine_fields() -> set[str]:
    """Frontend fields the figure engine reads (the same scan as useLiveFigureState.parity.test.ts)."""
    pattern = re.compile(r"""(?:(?:\bfe|\(fe or \{\}\))(?:\.get\(|\[)|_per_key\(fe,)\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]""")
    out: set[str] = set()
    for path in FIGURE_DIR.rglob("*.py"):
        out |= set(pattern.findall(path.read_text(encoding="utf-8")))
    return out


def test_every_notebook_setting_is_mapped_or_explained():
    fields = set(JupyterBrowserSettingsRequest.model_fields)
    decided = set(ns.FIGURE_FIELDS) | set(ns.NOT_FIGURE_FIELDS)
    assert sorted(fields - decided) == [], "a new notebook setting: map it in FIGURE_FIELDS or explain it in NOT_FIGURE_FIELDS"
    assert sorted(decided - fields) == [], "stale entries in notebook_settings"
    assert not set(ns.FIGURE_FIELDS) & set(ns.NOT_FIGURE_FIELDS)
    assert all(reason.strip() for reason in ns.NOT_FIGURE_FIELDS.values())


def test_mapped_settings_name_fields_the_engine_reads():
    read = _engine_fields()
    missing = sorted({f for f in ns.FIGURE_FIELDS.values()} - read)
    assert missing == []


def _state(*ids):
    return SimpleNamespace(
        datasets={i: {"id": i, "label": i, "available_layers": {"nuc": True, "tf": True, "fire": True}} for i in ids},
        dataset_order=list(ids), live_figure_state=None,
    )


def _push(js, **settings):
    return queue_browser_settings_update(js, JupyterBrowserSettingsRequest(**settings))


def _spec(state, js, monkeypatch, **kw):
    monkeypatch.setattr(ns, "notebook_state", lambda: js)
    monkeypatch.setattr(ns, "_allowed", lambda: True)
    return resolve_spec(state, chrom="chr1", start=0, end=1000, **kw)


def test_tabless_figure_takes_what_the_notebook_set(monkeypatch):
    js = JupyterState()
    _push(js, min_footprints=-1, show_qc_fail_reads=True, show_duplicate_reads=True, min_fp_quality=20,
          spanning_only=True, analysis_sample_seed="s1", enabled_mod_types={"fire": False})
    _push(js, layer_color_overrides={"msp": "#ABC", "nuc": "#112233"})
    _push(js, layer_color_overrides={"nuc": None})
    spec = _spec(_state("a"), js, monkeypatch)
    assert spec.source == "defaults"
    fe = spec.fe
    assert fe["minFootprints"] == -1
    assert fe["showQcFailReads"] is True and fe["showDuplicateReads"] is True
    assert fe["minFpQuality"] == 20 and fe["spanningOnly"] is True and fe["analysisSampleSeed"] == "s1"
    assert fe["enabledModTypes"]["fire"] is False
    assert fe["layerColorOverrides"] == {"fire": "#aabbcc"}
    # The colour reaches the effective map the tracks draw with.
    assert fe["_effectiveLayerColors"]["fire"] == "#aabbcc"


def test_a_render_request_still_overrides_notebook_settings(monkeypatch):
    js = JupyterState()
    _push(js, spanning_only=True)
    spec = _spec(_state("a"), js, monkeypatch, overrides={"spanningOnly": False})
    assert spec.fe["spanningOnly"] is False


def test_metaprofile_toggles_then_follow(monkeypatch):
    js = JupyterState()
    state = _state("a")
    _push(js, enabled_meta_profiles={"tf": False})
    fe = _spec(state, js, monkeypatch).fe
    default = next(c for c in fe["compositeTracks"] if c["id"] == "__default_metaprofile__")
    assert default["followActiveLayers"] is False
    visible = {s["ref"]["ruleId"]: s["visible"] for s in default["sources"]}
    assert visible.get("tf") is False

    _push(js, metaprofile_follow_active_layers=True)
    fe = _spec(state, js, monkeypatch).fe
    default = next(c for c in fe["compositeTracks"] if c["id"] == "__default_metaprofile__")
    assert default["followActiveLayers"] is True


def test_notebook_read_filter_and_order_reach_the_figure(monkeypatch):
    js = JupyterState()
    js.read_filter = {"a": ["r1", "r2"]}
    js.read_order = {"a": ["r2", "r1"]}
    fe = _spec(_state("a"), js, monkeypatch).fe
    assert fe["filteredReadIds"]["a"] == ["r1", "r2"]
    assert fe["readSortOrder"]["a"] == ["r2", "r1"]


def test_a_live_tab_or_session_is_not_changed(monkeypatch):
    js = JupyterState()
    _push(js, min_footprints=-1)
    state = _state("a")
    state.live_figure_state = {"frontend_state": {"minFootprints": 3}, "viewport": {"chrom": "chr1", "start": 0, "end": 1000}}
    assert _spec(state, js, monkeypatch).fe["minFootprints"] == 3


def test_not_applied_on_public_or_tour_servers(monkeypatch):
    js = JupyterState()
    _push(js, min_footprints=-1)
    monkeypatch.setattr("services.runtime.get_public_mode", lambda: True)
    fe = {"minFootprints": 5}
    ns.apply(fe, _state("a"), js)
    assert fe["minFootprints"] == 5


def test_record_merges_like_the_tab():
    store = ns.record({}, {"enabled_mod_types": {"nuc": True}, "open_panel": "plots"})
    store = ns.record(store, {"enabled_mod_types": {"tf": True}})
    assert store["enabled_mod_types"] == {"nuc": True, "tf": True}
    assert "open_panel" not in store
    store = ns.record(store, {"layer_color_overrides": {"nuc": "#111111"}})
    store = ns.record(store, {"replace_layer_color_overrides": True, "layer_color_overrides": {"tf": "#222222"}})
    assert store["layer_color_overrides"] == {"tf": "#222222"}
    store = ns.record(store, {"replace_layer_color_overrides": True})
    assert store["layer_color_overrides"] == {}


def test_clear_all_forgets_notebook_settings():
    js = JupyterState()
    _push(js, min_footprints=2)
    js.clear_all()
    assert js.notebook_settings == {}


@pytest.mark.parametrize("bad", [{"min_footprints": -2}, {"min_fp_quality": 256}, {"workspace": "elsewhere"}])
def test_settings_are_validated(bad):
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        JupyterBrowserSettingsRequest(**bad)


def test_colour_patches_are_normalised_and_capped():
    from services.layer_aliases import normalize_jupyter_settings
    out = normalize_jupyter_settings({"layer_color_overrides": {"msp ": "#ABC", "mod": "red", "nuc": None},
                                      "user_layer_colors": {f"l{i}": "#000000" for i in range(500)}})
    assert out["layer_color_overrides"] == {"fire": "#aabbcc", "nuc": None}
    assert len(out["user_layer_colors"]) == 200


def test_analysis_state_reports_the_parity_settings():
    from services.jupyter_payloads import build_analysis_state
    state = build_analysis_state({"min_footprints": -1, "layer_color_overrides": {"nuc": "#111111"},
                                  "user_layer_colors": {"tf": "#222222"}, "window_quant": {"window": None},
                                  "plots_gallery": [{"id": "g1"}], "workspace": "plots",
                                  "metaprofile_follow_active_layers": False})
    assert state["read_filters"]["min_footprints"] == -1
    assert state["layer_colors"] == {"session": {"nuc": "#111111"}, "saved_defaults": {"tf": "#222222"}}
    assert state["plots"]["gallery"] == [{"id": "g1"}]
    assert state["workspace"] == "plots"
    assert state["display"]["metaprofile_follow_active_layers"] is False


def test_the_headless_read_request_carries_the_notebook_read_filters(monkeypatch):
    """End to end inside the engine: the read track asks the server for what the notebook set."""
    from test_figure_reads import _render
    js = JupyterState()
    _push(js, min_footprints=-1, show_qc_fail_reads=True, show_duplicate_reads=True, min_fp_quality=40)
    fe = _spec(_state("ds"), js, monkeypatch).fe
    _img, _ctx, data = _render([{"id": "r1", "intervals": [[1_000_100, 1_000_200, 100]]}], fe=fe)
    request = data.requests[0]
    assert request["min_footprints"] == -1          # the server reads -1 as "all reads, including uncalled"
    assert request["include_qcfail"] is True and request["include_duplicates"] is True
    assert request["min_fp_quality"] == 40


@pytest.mark.parametrize("track", ["plots", "Quantify", "gallery"])
def test_browser_only_charts_are_refused_by_name(track):
    import json as _json
    from models.requests import RenderRequest
    from services.figure import api
    response = api.render_request(RenderRequest(chrom="c", start=0, end=10, tracks=["axis", track], engine="headless"),
                                  SimpleNamespace())
    assert response.status_code == 400
    assert "drawn by the browser" in _json.loads(response.body)["error"]


def test_excluded_reads_stay_out_of_the_figure():
    """"Exclude selected" (a session's excludedReadIds) hides those reads, as the read track does, and the
    metaprofile is then computed from the reads drawn (no server profile, which would include them)."""
    from test_figure_reads import _render
    reads = [{"id": f"r{i}", "intervals": [[1_000_100, 1_000_200, 100]]} for i in range(4)]
    _img, ctx, data = _render(reads, fe={"excludedReadIds": {"ds": ["r1", "r3"]}})
    from services.figure.tracks import reads as rt
    shown = rt.display_read_ids(ctx)
    assert sorted(shown) == ["r0", "r2"]
    assert rt.profile_view(ctx)["use_server_meta"] is False



def _default(fe):
    return next(c for c in fe["compositeTracks"] if c["id"] == "__default_metaprofile__")


def test_a_toggle_that_changes_nothing_keeps_the_metaprofile_following(monkeypatch):
    js = JupyterState()
    _push(js, enabled_mod_types={"nuc": True}, enabled_meta_profiles={"nuc": True})
    assert _default(_spec(_state("a"), js, monkeypatch).fe)["followActiveLayers"] is True


def test_a_frozen_metaprofile_keeps_its_sources_when_layers_change_later(monkeypatch):
    js = JupyterState()
    _push(js, enabled_mod_types={"nuc": True})
    _push(js, metaprofile_follow_active_layers=False)
    _push(js, enabled_mod_types={"nuc": False})
    fe = _spec(_state("a"), js, monkeypatch).fe
    default = _default(fe)
    assert default["followActiveLayers"] is False
    assert {s["ref"]["ruleId"]: s["visible"] for s in default["sources"]}["nuc"] is True   # frozen while nuc was on
    assert fe["enabledModTypes"]["nuc"] is False
    # Following again: the source follows the layer toggle.
    _push(js, metaprofile_follow_active_layers=True)
    default = _default(_spec(_state("a"), js, monkeypatch).fe)
    assert {s["ref"]["ruleId"]: s["visible"] for s in default["sources"]}["nuc"] is False


def test_calls_between_two_polls_merge_as_if_applied_one_by_one():
    from services.jupyter_endpoint import merge_pending_settings as merge
    pending = {}
    for update in ({"window_quant": {"axis": {"mode": "relative"}}}, {"window_quant": {"window": {"chrom": "c", "from": 1, "to": 2}}},
                   {"window_quant": {"spec": {"comparison": "datasets"}}}, {"window_quant": {"spec": {"stat": "area"}}},
                   {"window_quant": {"open_in": "cluster"}}):
        pending = merge(pending, update)
    assert pending["window_quant"] == {"axis": {"mode": "relative"}, "window": {"chrom": "c", "from": 1, "to": 2},
                                       "spec": {"comparison": "datasets", "stat": "area"}, "open_in": "cluster"}
    colors = merge(merge({}, {"layer_color_overrides": {"nuc": "#111111"}}), {"layer_color_overrides": {"tf": None}})
    assert colors["layer_color_overrides"] == {"nuc": "#111111", "tf": None}
    replaced = merge(colors, {"layer_color_overrides": {"fire": "#222222"}, "replace_layer_color_overrides": True})
    assert replaced["layer_color_overrides"] == {"fire": "#222222"} and replaced["replace_layer_color_overrides"] is True
    # One spelling for the card's place: a later openIn: null wins over an earlier open_in.
    card = merge(merge({}, {"window_quant": {"open_in": "track"}}), {"window_quant": {"openIn": None}})
    assert card["window_quant"] == {"open_in": None}


def test_the_tab_gets_each_call_in_order():
    from services.jupyter_payloads import build_jupyter_poll_state
    js = JupyterState()
    _push(js, enabled_meta_profiles={"tf": False})
    _push(js, metaprofile_follow_active_layers=True)
    _push(js, enabled_mod_types={"nuc": False}, open_panel="nucleosomes")
    state = build_jupyter_poll_state(js)
    assert state["settings_updates"] == [
        {"enabled_meta_profiles": {"tf": False}},
        {"metaprofile_follow_active_layers": True},
        {"enabled_mod_types": {"nuc": False}, "panel_ops": [["open", "nucleosomes"]]},
    ]
    assert state["settings_update"]["panel_ops"] == [["open", "nucleosomes"]]   # the merged summary too
    assert "settings_updates" not in build_jupyter_poll_state(js)                # consumed


def test_browser_only_tracks_are_refused_for_every_engine():
    from fastapi.testclient import TestClient
    from fastapi import FastAPI
    from routers.render import router
    app = FastAPI()
    app.include_router(router)
    from state.dependencies import get_dafc_state, get_state
    app.dependency_overrides[get_state] = lambda: SimpleNamespace()
    app.dependency_overrides[get_dafc_state] = lambda: SimpleNamespace()
    client = TestClient(app)
    for engine in ("numpy", "headless", None):
        body = {"chrom": "c", "start": 0, "end": 10, "tracks": ["axis", "plots"]}
        if engine:
            body["engine"] = engine
        r = client.post("/api/render", json=body)
        assert r.status_code == 400 and "drawn by the browser" in r.json()["error"], engine



def test_a_cart_replacement_is_replayed_in_order(monkeypatch):
    """follow -> nuc layer off -> a manual cart showing nuc -> follow off: nuc stays shown (as in the tab)."""
    js = JupyterState()
    state = _state("a")
    _push(js, metaprofile_follow_active_layers=True)
    _push(js, enabled_mod_types={"nuc": False})
    cart = _default(_spec(state, js, monkeypatch).fe)
    manual = {**cart, "followActiveLayers": False,
              "sources": [{**s, "visible": True} if s["ref"]["ruleId"] == "nuc" else s for s in cart["sources"]]}
    _push(js, composite_tracks=[manual])
    _push(js, metaprofile_follow_active_layers=False)
    default = _default(_spec(state, js, monkeypatch).fe)
    assert {s["ref"]["ruleId"]: s["visible"] for s in default["sources"]}["nuc"] is True


def test_long_histories_keep_a_frozen_metaprofile(monkeypatch):
    js = JupyterState()
    _push(js, enabled_mod_types={"nuc": True})
    _push(js, metaprofile_follow_active_layers=False)
    for _ in range(1500):
        _push(js, enabled_mod_types={"nuc": False})
    assert len(js.notebook_settings[ns.METAPROFILE_OPS]) <= 4      # repeated layer toggles merge
    default = _default(_spec(_state("a"), js, monkeypatch).fe)
    assert default["followActiveLayers"] is False
    assert {s["ref"]["ruleId"]: s["visible"] for s in default["sources"]}["nuc"] is True


def test_a_long_queue_compacts_without_losing_order():
    from services.jupyter_endpoint import MAX_QUEUED_SETTINGS_CALLS
    from services.jupyter_payloads import build_jupyter_poll_state
    js = JupyterState()
    _push(js, min_footprints=-1, open_panel="nucleosomes")
    for i in range(MAX_QUEUED_SETTINGS_CALLS):
        _push(js, read_row_height=2 + i % 3)
    _push(js, enabled_mod_types={"nuc": False})
    _push(js, metaprofile_follow_active_layers=False)
    _push(js, enabled_mod_types={"tf": False})
    _push(js, workspace="browser")
    _push(js, plot={"type": "metaprofile"})
    calls = build_jupyter_poll_state(js)["settings_updates"]
    assert len(calls) < 20
    assert calls[0] == {"min_footprints": -1, "panel_ops": [["open", "nucleosomes"]]}   # its panel op keeps it apart
    assert calls[1]["read_row_height"] in (2, 3, 4)                                      # the row heights merged
    # Patches, nulls and stateful settings are never merged (each applies to what the one before left).
    from services.jupyter_endpoint import compact_settings_calls
    kept = [{"coacc_settings": {"coaccBinSize": 100}}, {"coacc_settings": {"coaccMinCoverage": 30}},
            {"min_fp_quality": 30}, {"min_fp_quality": None}, {"selected_peaks": [0]}, {"peak_rules": []},
            {"window_quant": {"spec": {"sizeFrom": 100}}}, {"window_quant": {"spec": {"sizeTo": 200}}},
            {"read_display_mode": "all"}, {"read_display_mode": "bogus"},
            {"cluster_k": 7}, {"cluster_k": 5}, {"analysis_sample_seed": "a"}, {"analysis_sample_seed": "b"}]
    assert compact_settings_calls(kept) == kept
    assert compact_settings_calls([{"read_row_height": 3}, {"show_qc_fail_reads": True}, {"read_row_height": 4}]) == [
        {"read_row_height": 4, "show_qc_fail_reads": True}]
    assert calls[-5:] == [{"enabled_mod_types": {"nuc": False}}, {"metaprofile_follow_active_layers": False},
                          {"enabled_mod_types": {"tf": False}}, {"workspace": "browser"}, {"plot": {"type": "metaprofile"}}]


def test_the_summary_keeps_the_follow_first_hint():
    from services.jupyter_endpoint import merge_pending_settings as merge
    hinted = merge(merge({}, {"metaprofile_follow_active_layers": False}), {"enabled_mod_types": {"nuc": False}})
    assert hinted["metaprofile_follow_first"] is True
    assert "metaprofile_follow_first" not in merge(merge({}, {"enabled_meta_profiles": {"tf": False}}),
                                                   {"metaprofile_follow_active_layers": True})


def test_a_following_cart_replacement_follows_before_a_freeze(monkeypatch):
    js = JupyterState()
    state = _state("a")
    _push(js, enabled_mod_types={"nuc": False})
    cart = _default(_spec(state, js, monkeypatch).fe)
    following = {**cart, "followActiveLayers": True,
                 "sources": [{**s, "visible": True} for s in cart["sources"]]}
    _push(js, composite_tracks=[following])
    _push(js, metaprofile_follow_active_layers=False)
    default = _default(_spec(state, js, monkeypatch).fe)
    assert {s["ref"]["ruleId"]: s["visible"] for s in default["sources"]}["nuc"] is False


def test_an_unlimited_profile_pool_reaches_a_tabless_figure():
    """Release audit 3.1.1: background_read_cap None (set_reproducibility(profile_read_cap=0): no cap) was skipped as
    'unset', so the figure kept the default cap of 1,000."""
    from types import SimpleNamespace
    from services.figure import notebook_settings as ns
    fe = {"backgroundReadCap": 1000}
    ns.apply(fe, None, SimpleNamespace(notebook_settings={"background_read_cap": None}, read_filter={}, read_order={}))
    assert fe["backgroundReadCap"] is None
    fe2 = {"backgroundReadCap": 1000, "minFootprints": 3}
    ns.apply(fe2, None, SimpleNamespace(notebook_settings={"min_footprints": None}, read_filter={}, read_order={}))
    assert fe2["minFootprints"] == 3
