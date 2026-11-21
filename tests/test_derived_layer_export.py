"""Smoke tests for browser/services/derived_layer_export.py.

The module is the materializer for `.fiberlayers` bundles. The end-to-end
write path needs a full BrowserState + AnalysisReadQuery, so this file
focuses on the pure helpers and a small in-memory roundtrip through
`_materialized_rows_for_reads`. Filesystem-touching helpers use tmp_path.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from services import derived_layer_export as dle
from services.derived_layer_export import (
    DerivedClass,
    MaterializedRow,
    SourceInterval,
)


# ---------------------------------------------------------------------------
# Pure formatters
# ---------------------------------------------------------------------------

def test_slug_normalizes_invalid_characters():
    assert dle._slug("Hello World") == "Hello_World"
    assert dle._slug("a/b\\c?d") == "a_b_c_d"
    assert dle._slug("--leading.trailing--") == "leading.trailing"
    assert dle._slug("") == "fiberlayers"  # empty falls back


def test_slug_lower_flag():
    assert dle._slug("MixedCase", lower=True) == "mixedcase"
    assert dle._slug("MixedCase", lower=False) == "MixedCase"


def test_stable_identifier_prefixes_when_starts_with_digit():
    assert dle._stable_identifier("1bad", fallback="x").startswith("layer_")
    assert dle._stable_identifier("good", fallback="x") == "good"


def test_stable_identifier_uses_slug_default_for_empty_input():
    # `_slug("")` already returns its own fallback ("fiberlayers"), so the
    # caller-supplied fallback is only consulted if `_slug` is somehow empty.
    assert dle._stable_identifier("", fallback="cart_3") == "fiberlayers"


def test_rgb_string_parses_hex_and_rgb_passthrough():
    assert dle._rgb_string("#ff8800") == "255,136,0"
    assert dle._rgb_string("12,34,56") == "12,34,56"


def test_rgb_string_falls_back_for_invalid_input():
    assert dle._rgb_string("nope") == "47,158,68"
    assert dle._rgb_string("") == "47,158,68"
    assert dle._rgb_string("#zzzzzz") == "47,158,68"


def test_comma_list_appends_trailing_comma():
    # Always emits a trailing comma — matches the BED12 blockSizes convention.
    assert dle._comma_list([1, 2, 3]) == "1,2,3,"
    assert dle._comma_list([]) == ","


def test_bed_field_strips_whitespace_chars():
    assert dle._bed_field("ok\tno\nyes\rwhat") == "ok_no_yes_what"
    assert dle._bed_field("") == "."


def test_normalize_quality_handles_int_float_and_none():
    assert dle._normalize_quality(None) is None
    assert dle._normalize_quality("garbage") is None
    # Float in [0, 1] is treated as a fraction → scaled to 0..255.
    assert dle._normalize_quality(0.5) == 128
    # Integer-valued float >1 is treated as already in 0..255 range.
    assert dle._normalize_quality(200.0) == 200
    # Plain ints pass through (clamped).
    assert dle._normalize_quality(300) == 255
    assert dle._normalize_quality(-10) == 0


# ---------------------------------------------------------------------------
# SourceInterval / MaterializedRow
# ---------------------------------------------------------------------------

def _row(intervals):
    return MaterializedRow(
        chrom="chr1",
        read_id="r1",
        class_id="c1",
        source_layer="footprint",
        rule_id="rule_a",
        color="#2f9e44",
        intervals=intervals,
    )


def test_materialized_row_geometry_properties():
    row = _row([SourceInterval(100, 150, 50), SourceInterval(200, 230, 30)])
    assert row.start == 100
    assert row.end == 230
    assert row.block_sizes == [50, 30]
    assert row.block_starts == [0, 100]


def test_materialized_row_score_clamps_quality_average():
    row = _row([SourceInterval(0, 10, 10, 255), SourceInterval(20, 30, 10, 255)])
    # Average quality = 255 → maps to ~1000.
    assert row.score == 1000


def test_materialized_row_score_zero_when_no_qualities():
    row = _row([SourceInterval(0, 10, 10), SourceInterval(20, 30, 10)])
    assert row.score == 0


def test_materialized_row_to_bed_fields_shape():
    row = _row([SourceInterval(100, 150, 50, 100), SourceInterval(200, 230, 30, 200)])
    fields = row.to_bed_fields()
    # bed12+4 → 16 fields (chrom..blockQuality).
    assert len(fields) == 16
    assert fields[0] == "chr1"
    assert fields[1] == "100"
    assert fields[2] == "230"
    assert fields[3] == "r1"
    assert fields[8] == "47,158,68"  # color → rgb
    assert fields[9] == "2"  # blockCount
    assert fields[10] == "50,30,"  # block sizes (trailing comma)
    assert fields[11] == "0,100,"  # block starts
    assert fields[12] == "c1"
    assert fields[13] == "footprint"
    assert fields[14] == "rule_a"
    # block qualities present and clamped 0..255
    assert fields[15] == "100,200"


def test_materialized_row_to_bed_fields_uses_dot_when_qualities_missing():
    row = _row([SourceInterval(100, 150, 50, None), SourceInterval(200, 230, 30, None)])
    fields = row.to_bed_fields()
    assert fields[15] == "."


# ---------------------------------------------------------------------------
# _dedupe_intervals / _interval_matches_rules
# ---------------------------------------------------------------------------

def test_dedupe_intervals_drops_exact_duplicates():
    intervals = [
        SourceInterval(10, 20, 10),
        SourceInterval(10, 20, 10),  # exact duplicate
        SourceInterval(10, 20, 11),  # same geometry → still one BED block
    ]
    result = dle._dedupe_intervals(intervals)
    assert len(result) == 1


def test_dedupe_intervals_prefers_family_metadata_for_same_geometry():
    plain = SourceInterval(10, 20, 10, 255)
    family = SourceInterval(
        10,
        20,
        10,
        200,
        family_id=7,
        family_confidence=204,
        family_confidence_kind="assignment",
    )
    result = dle._dedupe_intervals([plain, family])
    assert result == [family]


def test_coalesce_overlapping_intervals_produces_bed12_safe_union():
    result = dle._coalesce_overlapping_intervals([
        SourceInterval(10, 25, 15, 100),
        SourceInterval(20, 30, 10, 200),
        SourceInterval(30, 40, 10, 150),
    ])
    assert [(iv.start, iv.end) for iv in result] == [(10, 30), (30, 40)]


def test_interval_matches_rules_size_bounds():
    iv = SourceInterval(100, 150, 50)
    assert dle._interval_matches_rules(iv, {"sizeMin": 20, "sizeMax": 100}) is True
    assert dle._interval_matches_rules(iv, {"sizeMin": 100}) is False
    assert dle._interval_matches_rules(iv, {"sizeMax": 30}) is False


def test_interval_matches_rules_exact_family_and_confidence():
    iv = SourceInterval(
        100,
        150,
        50,
        255,
        family_id=7,
        family_confidence=204,
        family_confidence_kind="assignment",
    )
    assert dle._interval_matches_rules(iv, {
        "familyId": 7,
        "minFamilyConfidence": 0.8,
    }) is True
    assert dle._interval_matches_rules(iv, {"familyId": 8}) is False
    assert dle._interval_matches_rules(iv, {
        "familyId": 7,
        "minFamilyConfidence": 0.81,
    }) is False


def test_interval_matches_rules_does_not_gate_latent_support_as_assignment():
    iv = SourceInterval(
        100,
        150,
        50,
        10,
        family_id=7,
        family_confidence=254,
        family_confidence_kind="latent-support",
    )
    assert dle._interval_matches_rules(iv, {"familyId": 7}) is True
    assert dle._interval_matches_rules(iv, {
        "familyId": 7,
        "minFamilyConfidence": 0.5,
    }) is False


def test_interval_matches_rules_passes_through_when_no_reference():
    iv = SourceInterval(100, 150, 50)
    assert dle._interval_matches_rules(iv, {}) is True


def test_interval_matches_rules_target_overlap_modes():
    iv = SourceInterval(100, 200, 100)
    # contains_target requires target fully inside the footprint.
    assert dle._interval_matches_rules(iv, {
        "referenceAbsStart": 120,
        "referenceAbsEnd": 180,
        "overlapMode": "contains_target",
    }) is True
    # Target bigger than footprint → fail.
    assert dle._interval_matches_rules(iv, {
        "referenceAbsStart": 50,
        "referenceAbsEnd": 250,
        "overlapMode": "contains_target",
    }) is False

    # contained_by_target requires footprint fully inside target.
    assert dle._interval_matches_rules(iv, {
        "referenceAbsStart": 50,
        "referenceAbsEnd": 250,
        "overlapMode": "contained_by_target",
    }) is True


def test_interval_matches_rules_no_overlap_at_all():
    iv = SourceInterval(100, 200, 100)
    assert dle._interval_matches_rules(iv, {
        "referenceAbsStart": 300,
        "referenceAbsEnd": 400,
    }) is False


def test_interval_matches_rules_zero_width_reference_is_skipped():
    iv = SourceInterval(100, 200, 100)
    # ref_end <= ref_start → reference clause ignored, size still applies.
    assert dle._interval_matches_rules(iv, {
        "referenceAbsStart": 500,
        "referenceAbsEnd": 500,
    }) is True


# ---------------------------------------------------------------------------
# Group/class normalization
# ---------------------------------------------------------------------------

def test_active_groups_filters_disabled():
    groups = [
        {"id": "a", "enabled": True},
        {"id": "b", "enabled": False},
        {"id": "c"},  # default enabled
    ]
    active = dle._active_groups(groups)
    assert [g["id"] for g in active] == ["a", "c"]
    # Returned dicts are copies — caller can't mutate originals.
    active[0]["mutated"] = True
    assert "mutated" not in groups[0]


def test_class_definitions_make_unique_ids_when_repeated():
    groups = [
        {"id": "g1", "name": "Same Label", "color": "#aabbcc"},
        {"id": "g2", "name": "Same Label", "color": "#ddeeff"},  # collides on slug
    ]
    classes = dle._class_definitions(groups)
    assert len(classes) == 2
    assert classes[0].class_id != classes[1].class_id


def test_class_definitions_uses_explicit_derived_layer_id():
    groups = [{"id": "g", "name": "x", "derivedLayerId": "my_layer"}]
    classes = dle._class_definitions(groups)
    assert classes[0].class_id == "my_layer"


def test_requested_layers_collects_non_primary():
    classes = [
        DerivedClass("c1", "TF small", "tf", "#000", "r", {}, 0),
        DerivedClass("c2", "Nuc big", "nuc", "#111", "r", {}, 1),
        DerivedClass("c3", "Primary", "footprint", "#222", "r", {}, 2),
    ]
    assert dle._requested_layers(classes) == ("nuc", "tf")


def test_requested_layers_returns_none_for_all_fp():
    classes = [DerivedClass("c1", "All FP", "all_fp", "#000", "r", {}, 0)]
    # `all_fp` means "all layers" → caller passes None to load everything.
    assert dle._requested_layers(classes) is None


def test_requested_layers_pairs_fire_and_msp():
    fire_only = [DerivedClass("c1", "FIRE", "fire", "#000", "r", {}, 0)]
    msp_only = [DerivedClass("c1", "MSP", "msp", "#000", "r", {}, 0)]
    assert set(dle._requested_layers(fire_only)) == {"fire", "msp"}
    assert set(dle._requested_layers(msp_only)) == {"fire", "msp"}


# ---------------------------------------------------------------------------
# Source-interval extraction
# ---------------------------------------------------------------------------

def test_primary_intervals_skips_gaps_and_offsets_to_genome():
    read = {
        "intervals": [
            [0, 100, -150],   # gap, skipped
            [100, 150, 50],   # footprint
            [150, 200, -50],  # gap
            [200, 230, 30],   # footprint
        ],
        "qualities": [255, 200],  # one quality per positive interval
    }
    out = dle._primary_intervals(read, region_start=1_000)
    assert len(out) == 2
    assert out[0].start == 1_100 and out[0].end == 1_150 and out[0].size == 50
    assert out[0].quality == 255
    assert out[1].start == 1_200 and out[1].end == 1_230 and out[1].size == 30
    assert out[1].quality == 200


def test_layer_intervals_uses_preferred_quality_track():
    layer = {
        "intervals": [[10, 20, 10], [30, 40, 10]],
        "qualities": [[1, 2], [255, 128]],
        "quality_names": ["mq", "confidence"],
    }
    out = dle._layer_intervals(layer, region_start=0)
    # `confidence` track should be preferred over `mq`.
    assert out[0].quality == 255
    assert out[1].quality == 128


def test_layer_intervals_carries_bam_native_family_metadata():
    layer = {
        "intervals": [[10, 20, 10]],
        "qualities": [[255], [0], [0], [7], [204]],
        "quality_names": ["q0", "q1", "q2", "fi", "fq"],
    }
    out = dle._layer_intervals(layer, region_start=100)
    assert out[0].family_id == 7
    assert out[0].family_confidence == 204
    assert out[0].family_confidence_kind == "assignment"
    assert out[0].quality == 255


def test_layer_intervals_marks_named_latent_support_calibration():
    layer = {
        "intervals": [[10, 20, 10]],
        "annotation_names": ["fhlt_deadbeefdeadbeef_R0"],
        "qualities": [[10], [255], [128], [7], [254]],
        "quality_names": ["q0", "q1", "q2", "fi", "fq"],
    }
    out = dle._layer_intervals(layer, region_start=100)
    assert out[0].family_confidence_kind == "latent-support"
    assert out[0].quality == 10


def test_layer_intervals_materializes_unclipped_family_bounds():
    layer = {
        "intervals": [[0, 3, 5]],
        "source_intervals": [[-2, 3, 5]],
    }
    out = dle._layer_intervals(layer, region_start=1000)
    assert (out[0].start, out[0].end, out[0].size) == (998, 1003, 5)


def test_layer_intervals_skips_non_positive_sizes():
    layer = {"intervals": [[0, 10, -5], [10, 20, 0], [20, 30, 10]]}
    out = dle._layer_intervals(layer, region_start=0)
    assert len(out) == 1
    assert out[0].size == 10


def test_source_intervals_falls_back_to_primary_for_missing_nuc_layer():
    read = {"intervals": [[0, 50, 25]], "layers": {}}
    out = dle._source_intervals(read, "nuc", region_start=0)
    assert len(out) == 1
    assert out[0].size == 25


def test_source_intervals_fire_msp_alias():
    # Asking for `fire` should fall through to `msp` payload when fire absent.
    read = {"layers": {"msp": {"intervals": [[0, 30, 30]]}}}
    out = dle._source_intervals(read, "fire", region_start=100)
    assert len(out) == 1
    assert out[0].start == 100 and out[0].end == 130


def test_source_intervals_all_fp_skips_methylation_and_dedupes():
    read = {
        "layers": {
            "tf": {"intervals": [[0, 10, 10]]},
            "nuc": {"intervals": [[0, 10, 10]]},  # duplicates the tf interval
            "msp": {"intervals": [[20, 30, 10]]},  # filtered out (signal layer)
            "m6a": {"intervals": [[40, 50, 10]]},  # filtered out
        }
    }
    out = dle._source_intervals(read, "all_fp", region_start=0)
    # tf+nuc collapse into one interval; msp/m6a excluded.
    assert len(out) == 1
    assert out[0].start == 0 and out[0].end == 10


def test_source_intervals_all_fp_prefers_family_copy_and_clipped_bounds():
    read = {
        "layers": {
            "tf": {"intervals": [[0, 10, 10]]},
            "tf_sr": {
                "intervals": [[0, 10, 10]],
                "source_intervals": [[-2, 10, 12]],
                "quality_names": ["q0", "q1", "q2", "fi", "fq"],
                "qualities": [[255], [0], [0], [7], [204]],
            },
        },
    }
    out = dle._source_intervals(read, "all_fp", region_start=100)
    assert len(out) == 1
    assert (out[0].start, out[0].end) == (100, 110)
    assert out[0].family_id == 7


def test_source_intervals_all_fp_coalesces_cross_layer_overlap():
    read = {
        "layers": {
            "tf": {"intervals": [[0, 20, 20]]},
            "nuc_sr": {"intervals": [[10, 30, 20]]},
        },
    }
    out = dle._source_intervals(read, "all_fp", region_start=100)
    assert [(iv.start, iv.end, iv.size) for iv in out] == [(100, 130, 30)]


# ---------------------------------------------------------------------------
# _materialized_rows_for_reads — orchestration roundtrip
# ---------------------------------------------------------------------------

def test_materialized_rows_for_reads_filters_by_size_and_collects_stats():
    reads = [
        {"id": "r1", "intervals": [[0, 50, 25], [60, 100, 40], [200, 300, 5]]},
        {"id": "r2", "intervals": [[0, 100, 80]]},  # too big for size_max=50
        {"id": "r3", "intervals": [[0, 100, 25], [200, 300, 25]]},
        {"id": "", "intervals": [[0, 50, 25]]},  # empty id → skipped
    ]
    classes = [
        DerivedClass(
            class_id="small_fp",
            label="Small footprints",
            source_layer="footprint",
            color="#2f9e44",
            rule_id="rule1",
            rules={"sizeMin": 10, "sizeMax": 50},
            group_index=0,
        ),
    ]
    rows, stats = dle._materialized_rows_for_reads(
        chrom="chr1",
        region_start=0,
        reads=reads,
        classes=classes,
    )
    # r1 → 2 intervals (25, 40); r2 → none; r3 → 2 intervals; "" skipped.
    row_by_read = {row.read_id: row for row in rows}
    assert set(row_by_read) == {"r1", "r3"}
    assert len(row_by_read["r1"].intervals) == 2
    assert len(row_by_read["r3"].intervals) == 2

    assert stats["small_fp"]["reads"] == 2
    assert stats["small_fp"]["intervals"] == 4

    # Rows are sorted: r1 (start=0) then r3 (also start=0); the secondary key is
    # end, then read_id, so order should be (r1, r3).
    assert [r.read_id for r in rows] == ["r1", "r3"]


def test_materialized_rows_skips_class_with_no_matches_but_still_reports_stats():
    classes = [
        DerivedClass(
            class_id="impossible",
            label="Empty",
            source_layer="footprint",
            color="#000",
            rule_id="rule",
            rules={"sizeMin": 1000},
            group_index=0,
        ),
    ]
    rows, stats = dle._materialized_rows_for_reads(
        chrom="chr1",
        region_start=0,
        reads=[{"id": "r1", "intervals": [[0, 50, 10]]}],
        classes=classes,
    )
    assert rows == []
    assert stats["impossible"] == {"reads": 0, "intervals": 0}


def test_materialized_family_rows_keep_latent_q0_and_gate_assignment_only():
    reads = [{
        "id": "mixed",
        "layers": {
            "tf_sr": {
                "intervals": [[10, 30, 20], [40, 58, 18]],
                "annotation_names": ["", "fhlt_deadbeefdeadbeef_R0"],
                "quality_names": ["q0", "q1", "q2", "fi", "fq"],
                "qualities": [[255, 10], [0, 255], [0, 128], [7, 7], [204, 254]],
            },
        },
    }]
    classes = [
        DerivedClass(
            class_id="family_all",
            label="Family 7",
            source_layer="tf_sr",
            color="#123456",
            rule_id="all",
            rules={"familyId": 7, "minFamilyConfidence": 0},
            group_index=0,
        ),
        DerivedClass(
            class_id="family_assigned",
            label="Family 7 assigned",
            source_layer="tf_sr",
            color="#123456",
            rule_id="assigned",
            rules={"familyId": 7, "minFamilyConfidence": 0.5},
            group_index=1,
        ),
    ]
    rows, stats = dle._materialized_rows_for_reads(
        chrom="chr1",
        region_start=100,
        reads=reads,
        classes=classes,
    )
    row_by_class = {row.class_id: row for row in rows}
    assert [iv.quality for iv in row_by_class["family_all"].intervals] == [204, 10]
    assert [iv.quality for iv in row_by_class["family_assigned"].intervals] == [204]
    assert stats["family_all"]["intervals"] == 2
    assert stats["family_assigned"]["intervals"] == 1


# ---------------------------------------------------------------------------
# Filesystem helpers
# ---------------------------------------------------------------------------

def test_dedupe_base_appends_suffix_when_files_already_exist(tmp_path: Path):
    (tmp_path / "exp.fiberlayers.json").write_text("{}")
    deduped = dle._dedupe_base(str(tmp_path), "exp")
    assert deduped == "exp_2"


def test_dedupe_base_returns_original_when_clean(tmp_path: Path):
    assert dle._dedupe_base(str(tmp_path), "fresh") == "fresh"


def test_dataset_fingerprint_returns_stat_for_local_file(tmp_path: Path):
    target = tmp_path / "ds.bam"
    target.write_bytes(b"hello")
    fp = dle._dataset_fingerprint(str(target))
    assert fp is not None
    assert fp.startswith("stat:5:")  # size=5 bytes


def test_dataset_fingerprint_returns_none_for_url_or_missing():
    assert dle._dataset_fingerprint("https://example.com/foo.bam") is None
    assert dle._dataset_fingerprint("/no/such/file") is None
    assert dle._dataset_fingerprint("") is None


def test_write_helpers_round_trip(tmp_path: Path):
    bed_path = tmp_path / "out.bed"
    autosql_path = tmp_path / "out.as"
    chrom_path = tmp_path / "out.chrom.sizes"
    json_path = tmp_path / "out.json"

    rows = [_row([SourceInterval(100, 150, 50, 200), SourceInterval(200, 230, 30, 100)])]

    dle._write_bed(rows, str(bed_path))
    dle._write_autosql(str(autosql_path))

    class FakeChrom:
        def __init__(self, name, size):
            self.name = name
            self.size = size

    class FakeState:
        chroms = [FakeChrom("chr1", 5_000), FakeChrom("chr2", 8_000)]

    dle._write_chrom_sizes(FakeState(), "chr1", min_size=200, path=str(chrom_path))
    dle._write_json({"hello": "world"}, str(json_path))

    bed_text = bed_path.read_text()
    assert "chr1\t100\t230\tr1\t" in bed_text  # single row, columns separated by tabs

    autosql_text = autosql_path.read_text()
    assert "fiberbrowser_fiberlayers" in autosql_text

    chrom_text = chrom_path.read_text().strip().split("\n")
    sizes = dict(line.split("\t") for line in chrom_text)
    assert sizes["chr1"] == "5000"  # existing chrom size wins over min
    assert sizes["chr2"] == "8000"

    assert json.loads(json_path.read_text()) == {"hello": "world"}


def test_write_chrom_sizes_promotes_min_size_when_chrom_unknown(tmp_path: Path):
    out = tmp_path / "sizes.tsv"

    class FakeState:
        chroms = []

    dle._write_chrom_sizes(FakeState(), "chrZ", min_size=12345, path=str(out))
    text = out.read_text().strip()
    assert text == "chrZ\t12345"


def test_convert_to_bigbed_returns_warning_when_tool_missing(monkeypatch, tmp_path: Path):
    # Force shutil.which to act as if bedToBigBed isn't installed.
    monkeypatch.setattr(dle.shutil, "which", lambda name: None)
    ok, warning = dle._convert_to_bigbed(
        str(tmp_path / "in.bed"),
        str(tmp_path / "in.chrom.sizes"),
        str(tmp_path / "in.as"),
        str(tmp_path / "out.bb"),
    )
    assert ok is False
    assert warning and "bedToBigBed" in warning


def test_convert_to_bigbed_returns_warning_when_subprocess_fails(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(dle.shutil, "which", lambda name: "/usr/bin/bedToBigBed")

    class FakeCompleted:
        returncode = 1
        stdout = ""
        stderr = "syntax error"

    monkeypatch.setattr(dle.subprocess, "run", lambda *a, **k: FakeCompleted())
    ok, warning = dle._convert_to_bigbed("a", "b", "c", "d")
    assert ok is False
    assert warning is not None
    assert "syntax error" in warning


# ---------------------------------------------------------------------------
# Class manifest entry
# ---------------------------------------------------------------------------

def test_class_manifest_entry_shape():
    cls = DerivedClass(
        class_id="tf_small",
        label="Small TFs",
        source_layer="tf",
        color="#ff0000",
        rule_id="rule_1",
        rules={"sizeMin": 20, "sizeMax": 80},
        group_index=0,
    )
    entry = dle._class_manifest_entry(cls)
    assert entry == {
        "id": "tf_small",
        "label": "Small TFs",
        "source_layer": "tf",
        "kind": "footprint_class",
        "color": "#ff0000",
        "rules": {"sizeMin": 20, "sizeMax": 80},
        "version": 1,
    }
