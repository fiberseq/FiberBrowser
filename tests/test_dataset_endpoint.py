import os
from types import SimpleNamespace
from io import BytesIO

from models.requests import AddDatasetRequest, MergeDatasetsRequest, UnmergeDatasetsRequest
from services.dataset_endpoint import (
    add_dataset_for_request,
    add_grouped_datasets_for_request,
    build_drop_window_script,
    infer_dataset_label_and_id,
    merge_datasets_for_request,
    unmerge_dataset_for_request,
    unique_upload_path,
    upload_general_file_for_request,
)


class FakeDatasetState:
    def __init__(self):
        self.calls = []
        self.datasets = {}
        self.dataset_order = []

    def add_dataset(self, dataset_id, path_arg, label=None):
        self.calls.append((dataset_id, path_arg, label))
        dataset = SimpleNamespace(
            id=dataset_id,
            paths=path_arg if isinstance(path_arg, list) else [path_arg],
            label=label,
            is_remote=False,
            to_dict=lambda: {"id": dataset_id, "path": path_arg, "label": label},
        )
        self.datasets[dataset_id] = dataset
        self.dataset_order.append(dataset_id)
        return dataset

    def get_dataset(self, dataset_id):
        return self.datasets.get(dataset_id)

    def remove_dataset(self, dataset_id):
        self.datasets.pop(dataset_id, None)
        if dataset_id in self.dataset_order:
            self.dataset_order.remove(dataset_id)


class FakeUpload:
    def __init__(self, filename, content=b"data"):
        self.filename = filename
        self.file = BytesIO(content)


def test_infer_dataset_label_and_id_for_single_and_multi_paths():
    assert infer_dataset_label_and_id(["/data/sample.bigBed"]) == ("sample", "sample")
    assert infer_dataset_label_and_id(["/data/rep1_tf.bb", "/data/rep1_nuc.bb"]) == (
        "rep1 (2 files)",
        "rep1_2_files",
    )


def test_add_dataset_for_request_adds_existing_local_bigbed(tmp_path):
    bigbed = tmp_path / "sample.bigBed"
    bigbed.write_text("placeholder")
    state = FakeDatasetState()

    result = add_dataset_for_request(state, AddDatasetRequest(path=str(bigbed)))

    assert result == {
        "success": True,
        "dataset": {"id": "sample", "path": str(bigbed), "label": "sample"},
    }
    assert state.calls == [("sample", str(bigbed), "sample")]


def test_add_dataset_for_request_reports_missing_path():
    result = add_dataset_for_request(FakeDatasetState(), AddDatasetRequest(path="/missing/sample.bb"))

    assert result["success"] is False
    assert "File or directory not found" in result["error"]


def test_add_dataset_for_request_explains_windows_mapped_drive_paths():
    result = add_dataset_for_request(FakeDatasetState(), AddDatasetRequest(path="/mnt/z/lab/sample.bam"))

    assert result["success"] is False
    assert "mapped network drive" in result["error"]
    assert "/mnt/z/lab/sample.bam" in result["error"]


def test_merge_datasets_for_request_removes_inputs_and_adds_combined_dataset():
    state = FakeDatasetState()
    state.add_dataset("a", "/data/a.bam", "A")
    state.add_dataset("b", "/data/b.bam", "B")

    result = merge_datasets_for_request(state, MergeDatasetsRequest(dataset_ids=["a", "b"]))

    assert result["success"] is True
    assert result["removed_ids"] == ["a", "b"]
    assert result["dataset"] == {
        "id": "a_b",
        "path": ["/data/a.bam", "/data/b.bam"],
        "label": "A + B",
    }
    assert state.dataset_order == ["a_b"]


def test_merge_collects_companion_layer_files():
    # Single-file BigBed datasets keep tf/msp/m5c in companion_layers, not .paths.
    # Merging must carry them along, otherwise the merged dataset loses every
    # overlay and shows only footprint-inferred layers.
    state = FakeDatasetState()
    a = state.add_dataset("a", "/data/a_footprint.bb", "A")
    a.companion_layers = {"tf": ["/data/a_tf.bb"], "m5c": ["/data/a_m5c.bb"]}
    b = state.add_dataset("b", "/data/b_footprint.bb", "B")
    b.companion_layers = {"tf": ["/data/b_tf.bb"], "m5c": ["/data/b_m5c.bb"]}

    result = merge_datasets_for_request(state, MergeDatasetsRequest(dataset_ids=["a", "b"]))

    assert result["success"] is True
    merged_paths = result["dataset"]["path"]
    for path in (
        "/data/a_footprint.bb", "/data/b_footprint.bb",
        "/data/a_tf.bb", "/data/b_tf.bb",
        "/data/a_m5c.bb", "/data/b_m5c.bb",
    ):
        assert path in merged_paths, f"{path} missing from merged dataset"


def test_merge_tolerates_legacy_string_companion_shape():
    state = FakeDatasetState()
    a = state.add_dataset("a", "/data/a_footprint.bb", "A")
    a.companion_layers = {"tf": "/data/a_tf.bb"}  # legacy single-string shape
    b = state.add_dataset("b", "/data/b_footprint.bb", "B")

    result = merge_datasets_for_request(state, MergeDatasetsRequest(dataset_ids=["a", "b"]))

    assert result["success"] is True
    assert "/data/a_tf.bb" in result["dataset"]["path"]


def test_unmerge_dataset_for_request_recreates_single_file_datasets():
    state = FakeDatasetState()
    state.add_dataset("merged", ["/data/a.bam", "/data/b.bigBed"], "Merged")

    result = unmerge_dataset_for_request(state, UnmergeDatasetsRequest(dataset_id="merged"))

    assert result["success"] is True
    assert result["removed_id"] == "merged"
    assert [dataset["id"] for dataset in result["datasets"]] == ["a", "b"]
    assert state.dataset_order == ["a", "b"]


def test_unmerge_splits_only_primary_footprints():
    # A merged BigBed dataset keeps companion files in .paths too. Unmerge must
    # split only the primary footprints (each re-detects its own companions),
    # otherwise it produces one dataset per overlay file (4x the originals).
    state = FakeDatasetState()
    merged = state.add_dataset(
        "merged",
        ["/d/a_fp.bb", "/d/b_fp.bb", "/d/a_tf.bb", "/d/b_tf.bb"],
        "Merged",
    )
    merged.companion_layers = {"tf": ["/d/a_tf.bb", "/d/b_tf.bb"]}

    result = unmerge_dataset_for_request(state, UnmergeDatasetsRequest(dataset_id="merged"))

    assert result["success"] is True
    assert [dataset["id"] for dataset in result["datasets"]] == ["a_fp", "b_fp"]


def test_unique_upload_path_avoids_existing_names(tmp_path):
    existing = tmp_path / "sample.bb"
    existing.write_text("existing")

    assert unique_upload_path(str(tmp_path), "sample.bb") == str(tmp_path / "sample_1.bb")


def test_upload_general_file_does_not_keep_uploaded_indexes(tmp_path):
    bam = tmp_path / "sample.bam"
    bam.write_text("bam")

    result = upload_general_file_for_request(FakeUpload("sample.bai", b"index"), str(tmp_path))

    assert result == {"success": True, "path": None, "filename": "sample.bai", "is_index": True}
    assert sorted(os.listdir(tmp_path)) == ["sample.bam"]


def test_add_grouped_pairs_bigbed_layer_companions(tmp_path):
    # Two samples; s1 has footprint+tf+msp, s2 has footprint+tf. A multi-select
    # of all five files should produce ONE dataset per sample, not one per file.
    names = [
        "s1_footprint.bb", "s1_tf.bb", "s1_msp.bb",
        "s2_footprint.bb", "s2_tf.bb",
    ]
    paths = []
    for name in names:
        fpath = tmp_path / name
        # Stand-ins (the fake state never reads them); not empty, since an empty
        # file is refused as "empty (0 bytes)" (fb-n2-files M21).
        fpath.write_bytes(b"stand-in")
        paths.append(str(fpath))

    state = FakeDatasetState()
    result = add_grouped_datasets_for_request(state, AddDatasetRequest(paths=paths))

    assert result["success"] is True
    # One dataset per sample (2), not one per file (5).
    assert len(state.calls) == 2
    primaries = [str(call[1]) for call in state.calls]
    # Footprint leads each group (the read layer becomes the dataset primary).
    assert any(p.endswith("s1_footprint.bb") for p in primaries)
    assert any(p.endswith("s2_footprint.bb") for p in primaries)
    # The companion layer files were consumed, not loaded as their own datasets.
    assert not any(p.endswith(("_tf.bb", "_msp.bb")) for p in primaries)


def test_add_grouped_keeps_unrelated_files_separate(tmp_path):
    names = ["sampleA_footprint.bb", "sampleA_tf.bb", "other_footprint.bb"]
    paths = []
    for name in names:
        fpath = tmp_path / name
        # Stand-ins (the fake state never reads them); not empty, since an empty
        # file is refused as "empty (0 bytes)" (fb-n2-files M21).
        fpath.write_bytes(b"stand-in")
        paths.append(str(fpath))

    state = FakeDatasetState()
    result = add_grouped_datasets_for_request(state, AddDatasetRequest(paths=paths))

    assert result["success"] is True
    # sampleA (footprint+tf paired) + other (standalone) = 2 datasets.
    assert len(state.calls) == 2


def test_build_drop_window_script_points_at_browser_api_and_file_types():
    script = build_drop_window_script(8765)

    assert 'SERVER_URL = "http://localhost:8765"' in script
    assert 'SERVER_URL + "/api/datasets/add"' in script
    assert 'SERVER_URL + "/api/jupyter/refresh"' in script
    assert "tkinterdnd2" in script
    assert "'.bam', '.bb', '.bigbed'" in script
