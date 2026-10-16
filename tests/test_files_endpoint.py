from types import SimpleNamespace
import shutil

import pandas as pd

from services import file_picker
from services import files_endpoint
from services.file_picker import pick_file_prompt, ps_quote, wslpath_to_unix
from services.files_endpoint import diagnose_bam_payload, load_folder_for_request, search_gene_payload


def test_search_gene_payload_exact_match_and_suggestions():
    state = SimpleNamespace(gtf_data={"transcripts": pd.DataFrame([
        {"gene_name": "sna", "chrom": "2L", "start": 1000, "end": 2000, "strand": "+"},
        {"gene_name": "sna-like", "chrom": "2R", "start": 3000, "end": 4000, "strand": "-"},
        {"gene_name": "even skipped", "chrom": "2R", "start": 5000, "end": 7000, "strand": "+"},
    ])})

    assert search_gene_payload(state, "SNA") == {
        "found": True,
        "chrom": "2L",
        "start": 0,
        "end": 6000,
        "tss": 1000,
        "gene_name": "sna",
    }
    assert search_gene_payload(state, "sna l") == {
        "found": False,
        "suggestions": ["sna-like"],
    }
    assert search_gene_payload(state, "missing") == {
        "found": False,
        "message": "Gene 'missing' not found",
    }


def test_search_gene_payload_reports_missing_gtf_and_empty_transcripts():
    assert search_gene_payload(SimpleNamespace(gtf_data=None), "sna") == {
        "found": False,
        "message": "No GTF loaded",
    }
    assert search_gene_payload(SimpleNamespace(gtf_data={"transcripts": pd.DataFrame()}), "sna") == {
        "found": False,
        "message": "No transcripts",
    }


def test_diagnose_bam_payload_uses_ordered_dataset_and_recommendations(monkeypatch):
    state = SimpleNamespace(
        dataset_order=["ds1"],
        datasets={"ds1": SimpleNamespace(data_type="bam", path="/data/sample.bam")},
    )
    monkeypatch.setattr(
        files_endpoint,
        "diagnose_bam_tags",
        lambda path, chrom, limit: {
            "path": path,
            "chrom": chrom,
            "limit": limit,
            "has_nucleosomes": False,
            "has_msps": False,
            "has_m6a": True,
            "fiberseq_missing": ["ns", "nl"],
        },
    )

    result = diagnose_bam_payload(state, dataset_idx=0, chrom="chr2R", limit=5)

    assert result["path"] == "/data/sample.bam"
    assert result["chrom"] == "chr2R"
    assert result["limit"] == 5
    assert len(result["recommendations"]) == 3
    assert diagnose_bam_payload(state, dataset_idx=2) == {"error": "Dataset index 2 out of range"}
    assert diagnose_bam_payload(
        SimpleNamespace(dataset_order=["bb"], datasets={"bb": SimpleNamespace(data_type="bigbed")}),
        dataset_idx=0,
    ) == {"error": "Dataset bb is not a BAM file (type: bigbed)"}


def test_load_folder_for_request_validates_and_registers_bigbed_folder(tmp_path):
    class State:
        def __init__(self):
            self.calls = []

        def add_dataset(self, dataset_id, path, label):
            self.calls.append((dataset_id, path, label))
            return SimpleNamespace(id=dataset_id, label=label)

    state = State()
    missing = tmp_path / "missing"
    empty = tmp_path / "empty"
    empty.mkdir()
    folder = tmp_path / "Run-1 BigBeds"
    folder.mkdir()
    (folder / "sample.bb").write_text("bb")

    missing_result = load_folder_for_request(state, str(missing))
    assert missing_result["success"] is False
    assert "Directory not found or not readable" in missing_result["message"]
    assert str(missing) in missing_result["message"]
    assert load_folder_for_request(state, str(empty)) == {
        "success": False,
        "message": "No BigBed file found in folder",
    }
    assert load_folder_for_request(state, str(folder)) == {
        "success": True,
        "dataset_id": "run_1_bigbeds",
        "label": "Run-1 BigBeds",
        "message": "Loaded Run-1 BigBeds",
    }
    assert state.calls == [("run_1_bigbeds", str(folder), "Run-1 BigBeds")]


def test_file_picker_prompt_and_path_helpers():
    assert pick_file_prompt("overlay", "m6a", multiple=False) == "Select m6A Overlay (bigBed)"
    assert pick_file_prompt("dataset", multiple=True) == "Select Dataset (BAM or BigBed) (Shift+Click for multiple)"
    assert ps_quote("Bob's data") == "'Bob''s data'"
    assert wslpath_to_unix("C:\\Users\\me\\sample.bam") == "/mnt/c/Users/me/sample.bam"


def test_wsl_picker_preserves_mapped_drive_path_before_conversion(monkeypatch):
    captured = {}

    def fake_run_powershell(script: str, timeout: int = 300):
        captured["script"] = script
        return SimpleNamespace(returncode=0, stdout="Z:\\lab\\sample.bam\n", stderr="")

    monkeypatch.setattr(file_picker, "is_wsl", lambda: True)
    monkeypatch.setattr(shutil, "which", lambda cmd: "powershell.exe" if cmd == "powershell.exe" else None)
    monkeypatch.setattr(file_picker, "run_powershell", fake_run_powershell)
    monkeypatch.setattr(file_picker, "convert_windows_path_to_wsl", lambda path: f"/converted/{path}")

    result = file_picker.wsl_pick_file("Select data", "dataset", multiple=False)

    assert result == {"success": True, "path": "/converted/Z:\\lab\\sample.bam"}
    assert "Resolve-FiberBrowserPath" not in captured["script"]
