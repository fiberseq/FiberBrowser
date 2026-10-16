"""Smoke tests for browser/services/derived_layers.py.

Covers manifest discovery, sidecar detection, payload resolution, and the
manifest-to-definitions normalization. Filesystem-based behavior is exercised
through pytest's tmp_path so the tests stay hermetic.
"""

import json
from pathlib import Path

import pytest

from services import derived_layers as dl


# ---------------------------------------------------------------------------
# is_derived_layer_manifest / is_derived_layer_bigbed / is_derived_layer_bed
# ---------------------------------------------------------------------------

def test_is_derived_layer_manifest_accepts_v1_schema():
    assert dl.is_derived_layer_manifest({"schema": "fiberlayers.v1"}) is True
    assert dl.is_derived_layer_manifest({"schema_version": "fiberlayers.v2"}) is True


def test_is_derived_layer_manifest_rejects_other_shapes():
    assert dl.is_derived_layer_manifest(None) is False
    assert dl.is_derived_layer_manifest([]) is False
    assert dl.is_derived_layer_manifest({"schema": "ucsc.bigbed"}) is False
    assert dl.is_derived_layer_manifest({}) is False


def test_is_derived_layer_bigbed_recognizes_marker_basename(tmp_path: Path):
    # A `.fiberlayers.bb` filename is enough — no manifest needed.
    bb_path = tmp_path / "sample.fiberlayers.bb"
    bb_path.write_bytes(b"\x00\x00")  # contents irrelevant for basename check
    assert dl.is_derived_layer_bigbed(str(bb_path)) is True


def test_is_derived_layer_bigbed_falls_back_to_manifest(tmp_path: Path):
    bb_path = tmp_path / "regular.bb"
    bb_path.write_bytes(b"\x00\x00")
    # No marker in basename, no manifest → not a derived-layer bundle.
    assert dl.is_derived_layer_bigbed(str(bb_path)) is False

    # Add a sibling manifest with the right schema → recognized.
    (tmp_path / "regular.json").write_text(json.dumps({"schema": "fiberlayers.v1"}))
    assert dl.is_derived_layer_bigbed(str(bb_path)) is True


def test_is_derived_layer_bed_requires_marker_and_manifest(tmp_path: Path):
    bed_path = tmp_path / "sample.fiberlayers.bed"
    bed_path.write_text("")
    # No manifest yet → not recognized.
    assert dl.is_derived_layer_bed(str(bed_path)) is False

    (tmp_path / "sample.fiberlayers.json").write_text(json.dumps({"schema": "fiberlayers.v1"}))
    assert dl.is_derived_layer_bed(str(bed_path)) is True

    # A plain BED without the marker is never a derived-layer payload.
    plain = tmp_path / "plain.bed"
    plain.write_text("")
    assert dl.is_derived_layer_bed(str(plain)) is False


# ---------------------------------------------------------------------------
# load_derived_layer_manifest / load_derived_layer_manifest_file
# ---------------------------------------------------------------------------

def test_load_derived_layer_manifest_finds_sibling_json(tmp_path: Path):
    bundle = tmp_path / "exp.fiberlayers.bb"
    bundle.write_bytes(b"\x00")
    manifest = {"schema": "fiberlayers.v1", "files": {"bigbed": "exp.fiberlayers.bb"}}
    (tmp_path / "exp.fiberlayers.json").write_text(json.dumps(manifest))

    result = dl.load_derived_layer_manifest(str(bundle))
    assert result == manifest


def test_load_derived_layer_manifest_returns_none_when_missing(tmp_path: Path):
    bundle = tmp_path / "absent.fiberlayers.bb"
    bundle.write_bytes(b"\x00")
    assert dl.load_derived_layer_manifest(str(bundle)) is None


def test_load_derived_layer_manifest_skips_invalid_json(tmp_path: Path):
    bundle = tmp_path / "broken.fiberlayers.bb"
    bundle.write_bytes(b"\x00")
    (tmp_path / "broken.fiberlayers.json").write_text("not-json{{{")
    # Falls through to the next candidate — none exists, returns None.
    assert dl.load_derived_layer_manifest(str(bundle)) is None


def test_load_derived_layer_manifest_file_validates_schema(tmp_path: Path):
    good = tmp_path / "good.fiberlayers.json"
    good.write_text(json.dumps({"schema": "fiberlayers.v1"}))
    assert dl.load_derived_layer_manifest_file(str(good)) == {"schema": "fiberlayers.v1"}

    bad = tmp_path / "bad.fiberlayers.json"
    bad.write_text(json.dumps({"schema": "ucsc.bigbed"}))
    assert dl.load_derived_layer_manifest_file(str(bad)) is None

    missing = tmp_path / "missing.fiberlayers.json"
    assert dl.load_derived_layer_manifest_file(str(missing)) is None


# ---------------------------------------------------------------------------
# resolve_derived_layer_payload_path
# ---------------------------------------------------------------------------

def test_resolve_payload_rejects_empty_input():
    payload, err = dl.resolve_derived_layer_payload_path("")
    assert payload is None
    assert err and "No derived-layer bundle" in err


def test_resolve_payload_rejects_unknown_extension():
    payload, err = dl.resolve_derived_layer_payload_path("/tmp/some_file.txt")
    assert payload is None
    assert err and "Select a `.fiberlayers" in err


def test_resolve_payload_via_manifest_picks_bigbed_when_present(tmp_path: Path):
    manifest = {
        "schema": "fiberlayers.v1",
        "files": {"bigbed": "exp.fiberlayers.bb"},
    }
    json_path = tmp_path / "exp.fiberlayers.json"
    json_path.write_text(json.dumps(manifest))
    bb_path = tmp_path / "exp.fiberlayers.bb"
    bb_path.write_bytes(b"\x00")

    resolved, err = dl.resolve_derived_layer_payload_path(str(json_path))
    assert err is None
    assert resolved == str(bb_path)


def test_resolve_payload_via_manifest_falls_back_to_bed(tmp_path: Path):
    manifest = {
        "schema": "fiberlayers.v1",
        "files": {"bed": "exp.fiberlayers.bed"},
    }
    json_path = tmp_path / "exp.fiberlayers.json"
    json_path.write_text(json.dumps(manifest))
    bed_path = tmp_path / "exp.fiberlayers.bed"
    bed_path.write_text("")

    resolved, err = dl.resolve_derived_layer_payload_path(str(json_path))
    assert err is None
    assert resolved == str(bed_path)


def test_resolve_payload_via_manifest_reports_missing_payload(tmp_path: Path):
    manifest = {"schema": "fiberlayers.v1", "files": {"bigbed": "exp.fiberlayers.bb"}}
    json_path = tmp_path / "exp.fiberlayers.json"
    json_path.write_text(json.dumps(manifest))
    # Manifest says bigbed exists but the file doesn't — should report error.
    resolved, err = dl.resolve_derived_layer_payload_path(str(json_path))
    assert resolved is None
    assert err and "payload is present" in err


def test_resolve_payload_for_bigbed_directly(tmp_path: Path):
    bb = tmp_path / "exp.fiberlayers.bb"
    bb.write_bytes(b"\x00")
    resolved, err = dl.resolve_derived_layer_payload_path(str(bb))
    assert err is None
    assert resolved == str(bb)


def test_resolve_payload_rejects_missing_bigbed(tmp_path: Path):
    resolved, err = dl.resolve_derived_layer_payload_path(str(tmp_path / "absent.fiberlayers.bb"))
    assert resolved is None
    assert err and "not found" in err


def test_resolve_payload_rejects_bigbed_without_marker(tmp_path: Path):
    bb = tmp_path / "regular.bb"
    bb.write_bytes(b"\x00")
    resolved, err = dl.resolve_derived_layer_payload_path(str(bb))
    assert resolved is None
    assert err and "not a FiberBrowser" in err


def test_resolve_payload_rejects_bed_without_marker(tmp_path: Path):
    bed = tmp_path / "plain.bed"
    bed.write_text("")
    resolved, err = dl.resolve_derived_layer_payload_path(str(bed))
    assert resolved is None
    assert err and "not a FiberBrowser" in err


def test_resolve_derived_layer_bigbed_path_is_alias(tmp_path: Path):
    bb = tmp_path / "exp.fiberlayers.bb"
    bb.write_bytes(b"\x00")
    assert dl.resolve_derived_layer_bigbed_path(str(bb)) == dl.resolve_derived_layer_payload_path(str(bb))


# ---------------------------------------------------------------------------
# find_derived_layer_bigbeds
# ---------------------------------------------------------------------------

def test_find_derived_layer_bigbeds_returns_only_marker_files(tmp_path: Path):
    # Two derived-layer bundles + one unrelated BigBed.
    (tmp_path / "a.fiberlayers.bb").write_bytes(b"\x00")
    (tmp_path / "b.fiberlayers.bed").write_text("")
    (tmp_path / "b.fiberlayers.json").write_text(json.dumps({"schema": "fiberlayers.v1"}))
    (tmp_path / "unrelated.bb").write_bytes(b"\x00")

    found = dl.find_derived_layer_bigbeds(str(tmp_path / "anchor.bam"))
    found_basenames = {Path(p).name for p in found}
    assert "a.fiberlayers.bb" in found_basenames
    assert "b.fiberlayers.bed" in found_basenames
    assert "unrelated.bb" not in found_basenames


def test_find_derived_layer_bigbeds_empty_when_no_parent(tmp_path: Path):
    # Path with no parent directory still survives the call.
    assert dl.find_derived_layer_bigbeds("just-a-name") == []


def test_find_derived_layer_bigbeds_skips_urls():
    assert dl.find_derived_layer_bigbeds("https://example.com/foo.bb") == []


# ---------------------------------------------------------------------------
# derived_layer_definitions_from_manifest
# ---------------------------------------------------------------------------

def test_definitions_from_dict_classes_normalize_fields():
    manifest = {
        "schema": "fiberlayers.v1",
        "classes": {
            "tf_small": {
                "label": "Small TFs",
                "source_layer": "tf",
                "kind": "footprint_class",
                "color": "#ff0000",
                "rules": {"sizeMin": 20, "sizeMax": 80},
                "version": 1,
            }
        },
        "source_dataset": {"id": "ds1", "label": "Sample"},
        "provenance": {"exporter": "FiberBrowser"},
    }
    out = dl.derived_layer_definitions_from_manifest(manifest, bundle_path="/tmp/exp.fiberlayers.bb")
    assert "tf_small" in out
    entry = out["tf_small"]
    assert entry["id"] == "tf_small"
    assert entry["label"] == "Small TFs"
    assert entry["source_layer"] == "tf"
    assert entry["color"] == "#ff0000"
    assert entry["rules"] == {"sizeMin": 20, "sizeMax": 80}
    assert entry["bundle_path"] == "/tmp/exp.fiberlayers.bb"
    assert entry["source_dataset"] == {"id": "ds1", "label": "Sample"}
    assert entry["provenance"] == {"exporter": "FiberBrowser"}


def test_definitions_from_list_classes_uses_id_or_name():
    manifest = {
        "schema": "fiberlayers.v1",
        "classes": [
            {"id": "by_id", "label": "Has id"},
            {"name": "by_name", "label": "Has name"},  # no id, falls back to name
            {"label": "skipped"},  # no id/name, skipped
        ],
    }
    out = dl.derived_layer_definitions_from_manifest(manifest, bundle_path="/tmp/x.fiberlayers.bb")
    assert set(out) == {"by_id", "by_name"}
    assert out["by_id"]["label"] == "Has id"
    assert out["by_name"]["label"] == "Has name"


def test_definitions_from_layers_alias():
    # `layers` is accepted as a synonym for `classes`.
    manifest = {"schema": "fiberlayers.v1", "layers": {"x": {"label": "X"}}}
    out = dl.derived_layer_definitions_from_manifest(manifest, bundle_path="/tmp/y.fiberlayers.bb")
    assert "x" in out
    assert out["x"]["label"] == "X"


def test_definitions_empty_for_missing_or_bad_manifest():
    assert dl.derived_layer_definitions_from_manifest(None, bundle_path="/tmp/x.fiberlayers.bb") == {}
    # Manifest with neither classes nor layers → empty mapping.
    assert dl.derived_layer_definitions_from_manifest(
        {"schema": "fiberlayers.v1"}, bundle_path="/tmp/x.fiberlayers.bb"
    ) == {}


def test_load_derived_layer_definitions_round_trip(tmp_path: Path):
    bundle = tmp_path / "exp.fiberlayers.bb"
    bundle.write_bytes(b"\x00")
    manifest = {
        "schema": "fiberlayers.v1",
        "classes": {"a": {"label": "Alpha"}},
    }
    (tmp_path / "exp.fiberlayers.json").write_text(json.dumps(manifest))

    defs = dl.load_derived_layer_definitions(str(bundle))
    assert "a" in defs
    assert defs["a"]["label"] == "Alpha"


# ---------------------------------------------------------------------------
# URL inputs are gracefully ignored for filesystem operations
# ---------------------------------------------------------------------------

def test_load_derived_layer_manifest_handles_urls_gracefully():
    # Remote bundles don't get a sidecar lookup.
    assert dl.load_derived_layer_manifest("https://example.com/foo.fiberlayers.bb") is None
