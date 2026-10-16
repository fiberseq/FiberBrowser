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


def test_custom_layer_color_is_the_browsers_hex_color():
    from services.figure.defaults import _hue_hex, _js_hash
    # The browser's getLayerColor for a layer without a curated color
    # (figure_defaults.json records pol2/ctcf/enhancer as examples).
    for name in ("pol2", "ctcf", "enhancer"):
        assert _hue_hex(abs(_js_hash(name)) % 360) == defaults()["layers"][name]["color"]
    assert layer_color("not_a_listed_layer").startswith("#") and len(layer_color("not_a_listed_layer")) == 7
