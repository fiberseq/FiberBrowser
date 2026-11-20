"""The headless renderer's ported defaults match the browser's (figure_defaults.json)."""
from services.figure.defaults import defaults, layer_color, layer_label, metaprofile_source_entries


def test_layer_colors_and_labels_match_the_browser():
    for name, known in defaults()["layers"].items():
        assert layer_color(name) == known["color"], name
        assert layer_label(name) == known["label"], name


def test_default_metaprofile_sources_match_the_browser():
    for case in defaults()["metaprofileCases"]:
        entries = metaprofile_source_entries([case["dataset"]])
        assert [(e["key"], e["label"]) for e in entries] == [(s["key"], s["label"]) for s in case["sources"]]


def test_default_metaprofile_follows_the_default_layers_like_the_browser():
    from services.figure.defaults import default_metaprofile
    for case in defaults()["metaprofileCases"]:
        comp = default_metaprofile([case["dataset"]])
        assert comp["followActiveLayers"] is True
        assert [s["visible"] for s in comp["sources"]] == [s["visible"] for s in case["sources"]]


def test_default_metaprofile_follows_given_layers_unless_manual():
    from services.figure.defaults import apply_follow_active_layers, default_metaprofile
    ds = [{"id": "ds", "available_layers": {"nuc": True, "tf": True, "msp": True, "m6a": True}}]
    comp = default_metaprofile(ds, {"nuc": True, "tf": False, "msp": True, "mod": True})
    assert {s["ref"]["ruleId"]: s["visible"] for s in comp["sources"]} == {"nuc": True, "tf": False, "fire": True, "m6a": True}
    rule = {"id": "r", "ref": {"kind": "metaprofile", "ruleId": "rule-1"}, "visible": True}
    comp["sources"].append(rule)
    followed = apply_follow_active_layers([comp], {"nuc": False, "tf": True}, ds)[0]
    assert {s["ref"]["ruleId"]: s["visible"] for s in followed["sources"]} == {"nuc": False, "tf": True, "fire": False, "m6a": False, "rule-1": True}
    manual = apply_follow_active_layers([{**comp, "followActiveLayers": False}], {"nuc": False}, ds)[0]
    assert manual["sources"] == comp["sources"]


def test_custom_layer_color_is_the_browsers_palette_color():
    from services.figure.defaults import _js_hash
    # The browser's getLayerColor for a layer outside the loaded set
    # (figure_defaults.json records pol2/ctcf/enhancer as examples).
    palette = defaults()["extraLayerPalette"]
    for name in ("pol2", "ctcf", "enhancer"):
        assert palette[abs(_js_hash(name)) % len(palette)] == defaults()["layers"][name]["color"]
    assert layer_color("not_a_listed_layer") in palette


def test_extra_layer_colors_match_the_browser():
    from services.figure.defaults import assign_extra_layer_colors
    for case in defaults()["extraLayerCases"]:
        assert assign_extra_layer_colors(case["datasets"]) == case["colors"]


def test_profile_requests_ask_for_the_followed_layers():
    # The headless engine draws the followed sources; its profile requests must read the same ones.
    from types import SimpleNamespace
    from services.figure.spec import build_panels
    from services.figure.tracks.composite import active_metaprofile_keys
    from services.figure.defaults import default_metaprofile
    ds = {"id": "ds", "label": "ds", "available_layers": {"nuc": True, "tf": True, "msp": True}}
    saved = default_metaprofile([ds], {"nuc": True, "tf": True})
    fe = {"compositeTracks": [saved], "enabledModTypes": {"nuc": False, "tf": False, "fire": True}}
    build_panels(SimpleNamespace(datasets={"ds": ds}), fe)
    keys = active_metaprofile_keys(fe)
    assert "fire" in keys and "nuc" not in keys and "tf" not in keys


def test_curated_layers_take_no_palette_slot():
    from services.figure.defaults import assign_extra_layer_colors
    palette = defaults()["extraLayerPalette"]
    assert assign_extra_layer_colors([{"available_layers": {"cr_split_gap": True, "tf2": True}}]) == {"tf2": palette[0]}


def test_headless_following_matches_aliases_and_refreshes_default_colours():
    from types import SimpleNamespace
    from services.figure.spec import build_panels
    from services.figure.defaults import _hue_hex, _js_hash, assign_extra_layer_colors
    fp = {"id": "fp", "label": "fp", "available_layers": {"footprint": True, "msp": True}}
    nuc = {"id": "nuc", "label": "nuc", "available_layers": {"nuc": True, "tf2": True, "tf3": True}}
    src = lambda rid, color, **kw: {"id": rid, "ref": {"kind": "metaprofile", "ruleId": rid}, "color": color,
                                     "visible": True, "negate": False, "scale": 1, **kw}
    comp = {"id": defaults()["defaultMetaprofileId"], "kind": "metaprofile", "visible": True, "sources": [
        src("footprint", "#16a34a"), src("nuc", "#16a34a"),
        src("tf2", _hue_hex(abs(_js_hash("tf2")) % 360)), src("tf3", "#123456")]}
    fe = {"compositeTracks": [comp], "enabledModTypes": {"footprint": False, "nuc": False}}
    build_panels(SimpleNamespace(datasets={"fp": fp, "nuc": nuc}), fe)
    out = {s["ref"]["ruleId"]: s for s in fe["compositeTracks"][0]["sources"]}
    assert not out["footprint"]["visible"] and not out["nuc"]["visible"]
    assert out["tf2"]["color"] == assign_extra_layer_colors([fp, nuc])["tf2"]
    assert out["tf3"]["color"] == "#123456"


def test_curated_layer_colours_are_the_browsers():
    from services.figure.defaults import layer_color
    assert layer_color("cr_split_gap") == "#f59e0b"
    assert layer_color("deam_ct") == "#2563eb"


def test_headless_following_uses_the_browsers_layer_aliases():
    from services.figure.defaults import apply_follow_active_layers, layer_toggle_on
    ds = [{"id": "ds", "available_layers": {"nuc": True, "tf": True}}]
    comp = {"id": defaults()["defaultMetaprofileId"], "sources": [
        {"id": "a", "ref": {"kind": "metaprofile", "ruleId": "nuc_layer"}, "visible": True},
        {"id": "b", "ref": {"kind": "metaprofile", "ruleId": "methyl_m6a"}, "visible": False}]}
    out = apply_follow_active_layers([comp], {"nuc": False, "m6a": True}, ds)[0]["sources"]
    assert out[0]["visible"] is False
    assert layer_toggle_on("methyl_m6a", {"mod": True}) and layer_toggle_on("nucleosomes", {"nuc": True})
