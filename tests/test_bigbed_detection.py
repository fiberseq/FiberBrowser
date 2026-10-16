"""Tests for BigBed layer type and companion discovery helpers."""

import os

import services.bigbed_detection as bd
from services.bigbed_detection import detect_overlay_type, display_layer_type, find_companion_bigbed_files


def test_detect_overlay_type_uses_filename_fallbacks():
    assert detect_overlay_type("/tmp/sample_footprint.bb") == "footprint"
    assert detect_overlay_type("/tmp/sample_tf.bigbed") == "tf"
    assert detect_overlay_type("/tmp/sample_msp.bb") == "msp"
    assert detect_overlay_type("/tmp/sample_fire.bb") == "fire"
    assert detect_overlay_type("/tmp/sample_deam.bb") == "deam"
    assert detect_overlay_type("/tmp/sample_mod.bb") == "m6a"
    assert detect_overlay_type("/tmp/sample_unknown.bb") == "unknown"


def test_display_layer_type_uses_fire_for_legacy_msp_key():
    assert display_layer_type("msp") == "FIRE"
    assert display_layer_type("fire") == "FIRE"
    assert display_layer_type("tf") == "TF"
    assert display_layer_type("unknown") == "Unknown"


def test_find_companion_bigbed_files_matches_legacy_stems(tmp_path):
    primary = tmp_path / "sample_footprint.bb"
    tf = tmp_path / "sample_tf.bb"
    msp = tmp_path / "sample_msp.bb"
    fire = tmp_path / "sample_fire.bb"
    other = tmp_path / "other_tf.bb"
    duplicate_primary = tmp_path / "sample_fp.bb"
    for path in (primary, tf, msp, fire, other, duplicate_primary):
        path.write_text("", encoding="utf-8")

    companions = find_companion_bigbed_files(str(primary), "footprint")

    assert companions == {
        "fire": str(fire),
        "tf": str(tf),
        "msp": str(msp),
    }


def test_fiberhmm_nucleosome_table_maps_to_footprint(monkeypatch):
    # `fiberhmm_nucleosome` (newer recall naming) is the same read-backbone layer
    # as `fiberhmm_footprint`; without the mapping it falls through to 'unknown'.
    bd._bigbed_autosql_type_cache.clear()
    bd._bigbed_autosql_sample_cache.clear()
    monkeypatch.setattr(
        bd, "_read_bigbed_autosql",
        lambda path: 'table fiberhmm_nucleosome\n"Sample: s1. nucleosome calls"\n(\n)',
    )

    assert bd.detect_bigbed_autosql_type("/tmp/x_nucleosome.bb") == "footprint"
    assert detect_overlay_type("/tmp/x_nucleosome.bb") == "footprint"


def test_detects_fiberhmm_duplicate_autosql_field(monkeypatch):
    bd._bigbed_duplicate_field_cache.clear()
    monkeypatch.setattr(
        bd,
        "_read_bigbed_autosql",
        lambda path: 'table fiberhmm_nucleosome\n(\nuint isDuplicate; "BAM 0x400"\n)',
    )

    assert bd.bigbed_has_duplicate_field("/tmp/marked.bb") is True


def test_companions_group_by_sample_tag_across_naming(tmp_path, monkeypatch):
    # recall-* naming: a nucleosome primary plus msp/tf companions share a
    # `Sample:` autoSQL tag but NOT a filename stem. Grouping must key on the
    # metadata Sample tag, and must not pull in a different sample in the dir.
    bd._bigbed_autosql_type_cache.clear()
    bd._bigbed_autosql_sample_cache.clear()
    files = {
        "recall-nucs_chr2R_nucleosome.bb": ("fiberhmm_nucleosome", "2r_call_nucs"),
        "recall-nucs_chr2R_msp.bb": ("fiberhmm_msp", "2r_call_nucs"),
        "recall-nucs_chr2R_tf.bb": ("fiberhmm_tf", "2r_call_nucs"),
        "recall-tfs_chr2R_msp.bb": ("fiberhmm_msp", "2r_call_tfs"),  # other sample
    }
    for name in files:
        (tmp_path / name).write_text("", encoding="utf-8")

    def fake_sql(path):
        table, sample = files[os.path.basename(path)]
        return f'table {table}\n"Sample: {sample}. calls"\n(\n)'

    monkeypatch.setattr(bd, "_read_bigbed_autosql", fake_sql)

    primary = str(tmp_path / "recall-nucs_chr2R_nucleosome.bb")
    companions = find_companion_bigbed_files(primary, detect_overlay_type(primary))

    assert companions == {
        "msp": str(tmp_path / "recall-nucs_chr2R_msp.bb"),
        "tf": str(tmp_path / "recall-nucs_chr2R_tf.bb"),
    }
