"""Tests for dataset registration helpers."""

from collections import OrderedDict
from types import SimpleNamespace

from models.domain import AnnotationState, ChromInfo, Dataset
from services import dataset_registration


def _state():
    return SimpleNamespace(
        datasets={},
        dataset_order=[],
        chroms=[],
        chrom_map={},
        annotation_state=AnnotationState(),
        _broad_cache=OrderedDict(),
        _working_set_cache=OrderedDict(),
    )


def test_add_dataset_to_state_discovers_companions_annotations_and_chroms(tmp_path, monkeypatch):
    primary = tmp_path / "sample.fp.bb"
    companion = tmp_path / "sample.tf.bb"
    annotation = tmp_path / "sample.annotations.bb"
    primary.write_text("")
    companion.write_text("")
    annotation.write_text("")

    monkeypatch.setattr(dataset_registration, "is_annotation_bigbed", lambda path: False)
    monkeypatch.setattr(dataset_registration, "detect_overlay_type", lambda path: "footprint")
    monkeypatch.setattr(
        dataset_registration,
        "find_companion_bigbed_files",
        lambda path, layer: {"tf": str(companion)} if path == str(primary) else {},
    )
    monkeypatch.setattr(
        dataset_registration,
        "find_annotation_bigbed_files",
        lambda path: [str(annotation)] if path == str(primary) else [],
    )
    monkeypatch.setattr(dataset_registration, "load_annotation_manifest", lambda path: {"types": []})

    state = _state()
    dataset = dataset_registration.add_dataset_to_state(
        state,
        "primary",
        str(primary),
        "Primary",
        detect_bam_chroms=lambda path: [],
        detect_bigbed_chroms=lambda path: [ChromInfo(name="chr1", size=1000)],
    )

    assert dataset.id == "primary"
    assert dataset.layer_type == "footprint"
    assert dataset.available_layers == {"footprint": True, "msp": True, "nuc": True, "tf": True}
    assert dataset.companion_layers == {"tf": [str(companion)]}
    assert state.dataset_order == ["primary"]
    assert state.chroms == [ChromInfo(name="chr1", size=1000)]
    assert "ann_sample.annotations" in state.annotation_state.files
    assert state.annotation_state.files["ann_sample.annotations"].dataset_ids == ["primary"]


def test_add_dataset_to_state_discovers_bigbed_directory_layers(tmp_path, monkeypatch):
    dataset_dir = tmp_path / "sample_recalled"
    dataset_dir.mkdir()
    footprint = dataset_dir / "sample_recalled_footprint.bb"
    tf = dataset_dir / "sample_recalled_tf.bb"
    msp = dataset_dir / "sample_recalled_msp.bb"
    deam = dataset_dir / "sample_recalled_deam.bb"
    annotation = dataset_dir / "sample_recalled.annotations.bb"
    for path in (footprint, tf, msp, deam, annotation):
        path.write_text("")

    monkeypatch.setattr(
        dataset_registration,
        "is_annotation_bigbed",
        lambda path: str(path).endswith(".annotations.bb"),
    )
    monkeypatch.setattr(dataset_registration, "detect_overlay_type", lambda path: (
        "footprint" if str(path).endswith("_footprint.bb") else
        "tf" if str(path).endswith("_tf.bb") else
        "msp" if str(path).endswith("_msp.bb") else
        "deam" if str(path).endswith("_deam.bb") else
        "unknown"
    ))
    monkeypatch.setattr(dataset_registration, "load_annotation_manifest", lambda path: {"types": []})

    state = _state()
    dataset = dataset_registration.add_dataset_to_state(
        state,
        "primary",
        str(dataset_dir),
        "Primary",
        detect_bam_chroms=lambda path: [],
        detect_bigbed_chroms=lambda path: [ChromInfo(name="chr1", size=1000)],
    )

    assert dataset.layer_type == "footprint"
    assert dataset.available_layers == {
        "deam": True,
        "footprint": True,
        "msp": True,
        "nuc": True,
        "tf": True,
    }
    assert dataset.companion_layers == {
        "deam": [str(deam)],
        "msp": [str(msp)],
        "tf": [str(tf)],
    }
    assert dataset.paths == [str(footprint), str(tf), str(msp), str(deam)]
    assert "ann_sample_recalled.annotations" in state.annotation_state.files


def test_add_dataset_to_state_registers_fiberlayer_bundle_classes(tmp_path, monkeypatch):
    dataset_dir = tmp_path / "sample_recalled"
    dataset_dir.mkdir()
    footprint = dataset_dir / "sample_recalled_footprint.bb"
    derived = dataset_dir / "sample_recalled.fiberlayers.bb"
    manifest = dataset_dir / "sample_recalled.fiberlayers.json"
    footprint.write_text("")
    derived.write_text("")
    manifest.write_text(
        '{"schema":"fiberlayers.v1","classes":{"short_tf":{"label":"Short TF","source_layer":"tf","color":"#d95f02"}}}'
    )

    monkeypatch.setattr(dataset_registration, "is_annotation_bigbed", lambda path: False)
    monkeypatch.setattr(dataset_registration, "detect_overlay_type", lambda path: "footprint")
    monkeypatch.setattr(dataset_registration, "find_annotation_bigbed_files", lambda path: [])

    state = _state()
    dataset = dataset_registration.add_dataset_to_state(
        state,
        "primary",
        str(dataset_dir),
        "Primary",
        detect_bam_chroms=lambda path: [],
        detect_bigbed_chroms=lambda path: [ChromInfo(name="chr1", size=1000)],
    )

    assert dataset.available_layers["footprint"] is True
    assert dataset.available_layers["short_tf"] is True
    assert dataset.derived_layers["short_tf"]["label"] == "Short TF"
    assert dataset.derived_layers["short_tf"]["source_layer"] == "tf"
    assert dataset.derived_layers["short_tf"]["bundle_path"] == str(derived)


def test_add_dataset_to_state_registers_fiberlayer_bed_fallback_classes(tmp_path, monkeypatch):
    dataset_dir = tmp_path / "sample_recalled"
    dataset_dir.mkdir()
    footprint = dataset_dir / "sample_recalled_footprint.bb"
    derived = dataset_dir / "sample_recalled.fiberlayers.bed"
    manifest = dataset_dir / "sample_recalled.fiberlayers.json"
    footprint.write_text("")
    derived.write_text("chr1\t10\t20\tread1\t0\t+\t10\t20\t255,0,0\t1\t10,\t0,\tshort_fire\tfire\trule1\t.\n")
    manifest.write_text(
        '{"schema":"fiberlayers.v1","classes":{"short_fire":{"label":"Short FIRE","source_layer":"fire","color":"#ea580c"}}}'
    )

    monkeypatch.setattr(dataset_registration, "is_annotation_bigbed", lambda path: False)
    monkeypatch.setattr(dataset_registration, "detect_overlay_type", lambda path: "footprint")
    monkeypatch.setattr(dataset_registration, "find_annotation_bigbed_files", lambda path: [])

    state = _state()
    dataset = dataset_registration.add_dataset_to_state(
        state,
        "primary",
        str(dataset_dir),
        "Primary",
        detect_bam_chroms=lambda path: [],
        detect_bigbed_chroms=lambda path: [ChromInfo(name="chr1", size=1000)],
    )

    assert dataset.available_layers["short_fire"] is True
    assert dataset.derived_layers["short_fire"]["label"] == "Short FIRE"
    assert dataset.derived_layers["short_fire"]["source_layer"] == "fire"
    assert dataset.derived_layers["short_fire"]["bundle_path"] == str(derived)


def test_add_dataset_to_state_discovers_explicit_bigbed_file_list_layers(tmp_path, monkeypatch):
    footprint = tmp_path / "sample_footprint.bb"
    tf = tmp_path / "sample_tf.bb"
    msp = tmp_path / "sample_msp.bb"
    for path in (footprint, tf, msp):
        path.write_text("")

    monkeypatch.setattr(dataset_registration, "is_annotation_bigbed", lambda path: False)
    monkeypatch.setattr(dataset_registration, "detect_overlay_type", lambda path: (
        "footprint" if str(path).endswith("_footprint.bb") else
        "tf" if str(path).endswith("_tf.bb") else
        "msp" if str(path).endswith("_msp.bb") else
        "unknown"
    ))
    monkeypatch.setattr(dataset_registration, "find_annotation_bigbed_files", lambda path: [])

    state = _state()
    dataset = dataset_registration.add_dataset_to_state(
        state,
        "primary",
        [str(footprint), str(tf), str(msp)],
        "Primary",
        detect_bam_chroms=lambda path: [],
        detect_bigbed_chroms=lambda path: [ChromInfo(name="chr1", size=1000)],
    )

    assert dataset.layer_type == "footprint"
    assert dataset.available_layers == {"footprint": True, "nuc": True, "tf": True, "msp": True}
    assert dataset.companion_layers == {"tf": [str(tf)], "msp": [str(msp)]}
    assert dataset.paths == [str(footprint), str(tf), str(msp)]


def test_merging_multi_layer_samples_keeps_every_companion_file(tmp_path, monkeypatch):
    # Merging several full samples (each footprint+tf+m5c) must keep EVERY file
    # of each layer type, not just the first — otherwise the rest leak into the
    # primary read source (lost TF footprints, vanished m5c). Regression for the
    # BigBed merge bug.
    files = {}
    for sample in ("s1", "s2", "s3"):
        for layer in ("footprint", "tf", "m5c"):
            p = tmp_path / f"{sample}_{layer}.bb"
            p.write_text("")
            files[(sample, layer)] = p

    monkeypatch.setattr(dataset_registration, "is_annotation_bigbed", lambda path: False)
    monkeypatch.setattr(dataset_registration, "detect_overlay_type", lambda path: (
        "footprint" if str(path).endswith("_footprint.bb") else
        "tf" if str(path).endswith("_tf.bb") else
        "m5c" if str(path).endswith("_m5c.bb") else
        "unknown"
    ))
    monkeypatch.setattr(dataset_registration, "find_annotation_bigbed_files", lambda path: [])

    all_paths = [str(p) for p in files.values()]
    state = _state()
    dataset = dataset_registration.add_dataset_to_state(
        state, "merged", all_paths, "Merged",
        detect_bam_chroms=lambda path: [],
        detect_bigbed_chroms=lambda path: [ChromInfo(name="chr1", size=1000)],
    )

    assert dataset.layer_type == "footprint"
    # All three samples' tf and m5c files are retained per layer type.
    assert sorted(dataset.companion_layers["tf"]) == sorted(
        str(files[(s, "tf")]) for s in ("s1", "s2", "s3")
    )
    assert sorted(dataset.companion_layers["m5c"]) == sorted(
        str(files[(s, "m5c")]) for s in ("s1", "s2", "s3")
    )
    # Only footprint files are primary read sources (companions excluded).
    companion_paths = {p for paths in dataset.companion_layers.values() for p in paths}
    primary = [p for p in dataset.paths if p not in companion_paths]
    assert sorted(primary) == sorted(
        str(files[(s, "footprint")]) for s in ("s1", "s2", "s3")
    )


def test_configure_bam_dataset_layers_uses_deeper_probe(monkeypatch):
    seen = {}

    def fake_diagnose_bam_tags(path, limit):
        seen["path"] = path
        seen["limit"] = limit
        if limit < 50:
            return {
                "has_nucleosomes": True,
                "has_m6a": False,
                "has_m5c": False,
                "has_deam": False,
                "has_msps": True,
                "has_fire": True,
                "ma_layers": ["nuc", "msp"],
            }
        return {
            "has_nucleosomes": True,
            "has_m6a": False,
            "has_m5c": False,
            "has_deam": True,
            "has_msps": True,
            "has_fire": True,
            "ma_layers": ["nuc", "msp", "tf", "nuc_sr", "tf_sr"],
        }

    monkeypatch.setattr(dataset_registration, "diagnose_bam_tags", fake_diagnose_bam_tags)

    dataset = Dataset("sample", "https://example.org/sample.bam", "Sample", data_type="bam")
    dataset_registration.configure_bam_dataset_layers(dataset, dataset.path)

    assert seen == {
        "path": "https://example.org/sample.bam",
        "limit": dataset_registration.BAM_LAYER_DETECTION_SAMPLE_LIMIT,
    }
    assert dataset.available_layers["tf"] is True
    assert dataset.available_layers["fire"] is True
    assert dataset.available_layers["msp"] is True
    assert dataset.available_layers["nuc_sr"] is True
    assert dataset.available_layers["tf_sr"] is True
    assert "deam_opportunity" not in dataset.available_layers


def test_dataset_registration_diagnostics_are_opt_in(capsys, monkeypatch):
    def fake_diagnose_bam_tags(_path, limit):
        return {
            "has_nucleosomes": True,
            "has_m6a": False,
            "has_m5c": False,
            "has_deam": False,
            "has_msps": False,
            "has_fire": True,
            "ma_layers": ["nuc", "tf"],
        }

    monkeypatch.setattr(dataset_registration, "diagnose_bam_tags", fake_diagnose_bam_tags)
    monkeypatch.delenv(dataset_registration.DATASET_DIAGNOSTICS_ENV, raising=False)
    dataset = Dataset("sample", "https://example.org/sample.bam", "Sample", data_type="bam")

    dataset_registration.configure_bam_dataset_layers(dataset, dataset.path)
    assert capsys.readouterr().out == ""

    monkeypatch.setenv(dataset_registration.DATASET_DIAGNOSTICS_ENV, "1")
    dataset_registration.configure_bam_dataset_layers(dataset, dataset.path)
    assert "BAM layers" in capsys.readouterr().out


def test_refresh_dataset_capabilities_redetects_and_invalidates_caches(tmp_path, monkeypatch):
    bam = tmp_path / "sample.bam"
    bam.write_text("")

    state = _state()
    dataset = Dataset("sample", str(bam), "Sample", data_type="bam")
    dataset.available_layers = {"nuc": True}
    state.datasets["sample"] = dataset
    state.dataset_order.append("sample")
    state._broad_cache[("sample", "chr1", 0, 10)] = ("stale", 0)
    state._working_set_cache[("sample", "chr1", 0, 10)] = ("stale", 0)

    def fake_configure_bam_dataset_layers(ds, primary_path):
        assert primary_path == str(bam)
        ds.layer_type = "bam"
        ds.available_layers = {"nuc": True, "tf": True}

    monkeypatch.setattr(
        dataset_registration,
        "configure_bam_dataset_layers",
        fake_configure_bam_dataset_layers,
    )

    refreshed = dataset_registration.refresh_dataset_capabilities(state, "sample")

    assert refreshed is dataset
    assert dataset.available_layers == {"nuc": True, "tf": True}
    assert state._broad_cache == OrderedDict()
    assert state._working_set_cache == OrderedDict()


def test_unique_dataset_id_and_cache_invalidation(tmp_path):
    existing = tmp_path / "existing.fp.bb"
    new = tmp_path / "new.fp.bb"
    existing.write_text("")
    new.write_text("")

    state = _state()
    state.datasets["primary"] = Dataset("primary", str(existing), "Existing")
    state.dataset_order.append("primary")
    state._broad_cache[("primary", "chr1", 0, 10)] = ("stale", 0)
    state._broad_cache[("other", "chr1", 0, 10)] = ("keep", 0)
    state._working_set_cache[("primary", "chr1", 0, 10)] = ("stale", 0)

    assert dataset_registration.unique_dataset_id("primary", state.datasets) == "primary_1"

    dataset_registration.invalidate_dataset_caches(state, "primary")

    assert list(state._broad_cache.values()) == [("keep", 0)]
    assert not state._working_set_cache


def test_m5c_bigbed_with_ddda_spans_offers_the_ddda_mcg_layer(monkeypatch):
    from types import SimpleNamespace
    from services import bigbed_detection, dataset_registration

    class FakeBigBed:
        def __init__(self, rows):
            self.rows = rows

        def chroms(self):
            return {"chr1": 1_000_000}

        def entries(self, chrom, start, end):
            return [row for row in self.rows if row[0] < end and row[1] > start]

    def rest(sizes, mls):
        return "\t".join(["r", "0", "+", "0", "0", "0", str(len(sizes)),
                          ",".join(map(str, sizes)) + ",", ",".join("0" for _ in sizes) + ",",
                          ",".join(map(str, mls)) + ","])

    handles = {
        "daf_m5c.bb": FakeBigBed([(100, 200, rest([1], [210])), (300, 400, rest([12, 1], [0, 0]))]),
        "native_m5c.bb": FakeBigBed([(100, 200, rest([1, 1], [210, 190]))]),
    }
    monkeypatch.setattr("services.bigbed_handles.get_bigbed_handle", lambda path: handles[path])
    bigbed_detection._m5c_ddda_span_cache.clear()

    daf = SimpleNamespace(layer_type="footprint", paths=["daf.bb"], available_layers={"footprint": True, "m5c": True},
                          companion_layers={"m5c": ["daf_m5c.bb"]})
    native = SimpleNamespace(layer_type="m5c", paths=["native_m5c.bb"], available_layers={"m5c": True},
                             companion_layers={})
    dataset_registration.add_m5c_interval_layer(daf)
    dataset_registration.add_m5c_interval_layer(native)
    assert daf.available_layers.get("ddda_mcg") is True
    assert "ddda_mcg" not in native.available_layers

    assert bigbed_detection.is_ddda_mcg_block(1, 0) and not bigbed_detection.is_ddda_mcg_block(1, 200)
    assert bigbed_detection.is_ddda_mcg_block(12, None) and not bigbed_detection.is_ddda_mcg_block(1, None)
