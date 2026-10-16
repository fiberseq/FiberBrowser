"""Tests for portable Footprint Analysis cart rule files."""

import json

from services.footprint_rules import (
    RULE_SCHEMA,
    load_footprint_rule_file,
    save_footprint_rule_file,
)


def test_footprint_rule_file_round_trips_cart_groups(tmp_path):
    result = save_footprint_rule_file(
        output_dir=str(tmp_path),
        bundle_name="paper rules",
        context={
            "chrom": "chr2R",
            "start": 100,
            "end": 200,
            "dataset_ids": ["ds1"],
            "sample_seed": "paper-seed",
        },
        groups=[
            {
                "id": "short_tf",
                "name": "Short TF",
                "color": "#f97316",
                "layer": "tf",
                "sizeMin": 5,
                "sizeMax": 35,
                "referenceAbsStart": 120,
                "referenceAbsEnd": 160,
                "minFpCoverage": 0.5,
                "enabled": True,
                "sourceIndex": 0,
            }
        ],
    )

    assert result["schema"] == RULE_SCHEMA
    assert result["n_rules"] == 1
    assert result["path"].endswith(".fiberlayer-rules.json")

    loaded = load_footprint_rule_file(result["path"])
    assert loaded["schema"] == RULE_SCHEMA
    assert loaded["context"]["sample_seed"] == "paper-seed"
    assert loaded["groups"] == [
        {
            "id": "short_tf",
            "name": "Short TF",
            "color": "#f97316",
            "layer": "tf",
            "sizeMin": 5,
            "sizeMax": 35,
            "referenceAbsStart": 120,
            "referenceAbsEnd": 160,
            "minFpCoverage": 0.5,
            "overlapFraction": 0.0,
            "conditions": [],
            "enabled": True,
            "sourceIndex": 0,
        }
    ]


def test_fiberlayers_manifest_loads_as_portable_rules(tmp_path):
    manifest_path = tmp_path / "cart.fiberlayers.json"
    manifest_path.write_text(json.dumps({
        "schema": "fiberlayers.v1",
        "classes": {
            "short_fire": {
                "id": "short_fire",
                "label": "Short FIRE",
                "source_layer": "fire",
                "color": "#ea580c",
                "rules": {
                    "source_layer": "fire",
                    "size_min": 1,
                    "size_max": 80,
                    "reference_abs_start": 1100,
                    "reference_abs_end": 1200,
                    "min_fp_coverage": 0.75,
                },
            }
        },
    }), encoding="utf-8")

    loaded = load_footprint_rule_file(str(manifest_path))

    assert loaded["n_rules"] == 1
    group = loaded["groups"][0]
    assert group["id"] == "rule_short_fire"
    assert group["name"] == "Short FIRE"
    assert group["layer"] == "fire"
    assert group["derivedLayerId"] == "short_fire"
    assert group["sizeMin"] == 1
    assert group["sizeMax"] == 80
    assert group["referenceAbsStart"] == 1100
    assert group["referenceAbsEnd"] == 1200
    assert group["minFpCoverage"] == 0.75


def test_footprint_rules_normalize_legacy_msp_alias_to_fire(tmp_path):
    result = save_footprint_rule_file(
        output_dir=str(tmp_path),
        bundle_name="legacy msp",
        groups=[{
            "id": "legacy-msp",
            "name": "Legacy MSP rule",
            "layer": "msp",
            "sizeMin": 5,
            "sizeMax": 60,
        }],
    )

    loaded = load_footprint_rule_file(result["path"])

    assert loaded["groups"][0]["layer"] == "fire"


def test_footprint_rule_routes_save_and_load(client, tmp_path):
    save_response = client.post("/api/footprint/rules/save", json={
        "groups": [{
            "id": "g1",
            "name": "Reusable TF",
            "color": "#2f9e44",
            "layer": "tf",
            "sizeMin": 1,
            "sizeMax": 40,
            "enabled": True,
            "sourceIndex": -1,
        }],
        "output_dir": str(tmp_path),
        "bundle_name": "route rules",
        "chrom": "chr2R",
        "start": 1000,
        "end": 2000,
        "dataset_ids": ["ds1"],
        "sample_seed": "route-seed",
    })

    assert save_response.status_code == 200
    saved = save_response.json()
    assert saved["success"] is True
    assert saved["n_rules"] == 1

    load_response = client.post("/api/footprint/rules/load", json={"path": saved["path"]})

    assert load_response.status_code == 200
    loaded = load_response.json()
    assert loaded["success"] is True
    assert loaded["n_rules"] == 1
    assert loaded["groups"][0]["name"] == "Reusable TF"
    assert loaded["context"]["sample_seed"] == "route-seed"


def test_saved_state_rules_keep_their_state_link():
    from services.footprint_rules import normalize_footprint_group

    group = normalize_footprint_group({
        "name": "State 3", "layer": "tf_cr", "consensusStateId": "F7", "consensusJobId": "job",
        "sourceDatasetId": "ds", "familyId": 4, "minFamilyConfidence": 0.5,
    }, idx=0)
    assert group["consensusStateId"] == "F7"
    assert group["consensusJobId"] == "job"
    assert group["sourceDatasetId"] == "ds"
    assert group["familyId"] == 4
    assert group["minFamilyConfidence"] == 0.5
    plain = normalize_footprint_group({"name": "TF", "sizeMin": 10, "sizeMax": 35}, idx=1)
    assert "consensusStateId" not in plain and "familyId" not in plain



def test_family_model_bounds_survive_normalization():
    from services.footprint_rules import normalize_footprint_group
    out = normalize_footprint_group({"name": "F", "familyModelAbsStart": 110, "familyModelAbsEnd": 130,
                                     "referenceAbsStart": 100, "referenceAbsEnd": 150, "consensusStage": "resolved"})
    assert (out["familyModelAbsStart"], out["familyModelAbsEnd"], out["consensusStage"]) == (110, 130, "resolved")


def _saved_class_group(**extra):
    info = {
        "id": "S1", "family": "class_001", "className": "Class 1", "runLabel": "run 1 · stringency 0.90",
        "start": 1179.4, "end": 1211.0,
        "channels": [
            {"key": "daf::CT", "datasetId": "daf", "strand": "CT", "label": "DAF CT", "daf": True},
            {"key": "daf::GA", "datasetId": "daf", "strand": "GA", "label": "DAF GA", "daf": True},
            {"key": "hia5::pooled", "datasetId": "hia5", "strand": "pooled", "label": "Hia5", "daf": False},
        ],
        "stats": {"daf::CT": {"prevalence": 0.41, "molecules": 60, "supported": True},
                  "hia5::pooled": {"prevalence": 0.38, "molecules": 44, "supported": True}},
        "picked": ["daf::CT", "hia5::pooled"],
    }
    group = {"id": "g1", "name": "S1 · Class 1 · DAF CT", "color": "#7c3aed", "consensusJobId": "run1",
             "consensusStateId": "class_001", "sourceDatasetId": "daf", "consensusStrand": "CT",
             "consensusTier": "core+edge", "enabled": True, "sourceIndex": -1, "savedClass": info}
    group.update(extra)
    return group


def test_rules_round_trip_keeps_the_saved_class_definition(tmp_path):
    """Release audit: the whitelist dropped savedClass (S1 identity, channels, per-channel stats)."""
    group = _saved_class_group()
    result = save_footprint_rule_file(groups=[group], output_dir=str(tmp_path))
    loaded = load_footprint_rule_file(result["path"])["groups"][0]
    assert loaded["savedClass"] == group["savedClass"]
    assert loaded["consensusTier"] == "core+edge" and loaded["consensusStrand"] == "CT"


def test_rules_drop_a_malformed_saved_class_but_keep_the_rule(tmp_path):
    bad = [
        _saved_class_group(savedClass="S1"),
        _saved_class_group(savedClass={"id": "nope", "family": "class_001"}),
        _saved_class_group(savedClass={**_saved_class_group()["savedClass"], "channels": [{"key": 3}]}),
    ]
    result = save_footprint_rule_file(groups=bad, output_dir=str(tmp_path))
    loaded = load_footprint_rule_file(result["path"])["groups"]
    assert len(loaded) == 3 and not any("savedClass" in g for g in loaded)
    assert all(g["consensusStateId"] == "class_001" for g in loaded)
