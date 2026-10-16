from types import SimpleNamespace

from models.domain import JupyterState
from services.jupyter_motifs import (
    collect_motifs_to_search,
    delete_custom_motif,
    detect_motif_file_format,
    format_jaspar_motif,
    list_available_jaspar_motifs,
    list_custom_motifs,
    register_custom_motif,
    search_motifs_in_regions,
    validate_custom_motif_counts,
)
from services import jupyter_motifs


VALID_COUNTS = {
    "A": [1, 0, 0],
    "C": [0, 1, 0],
    "G": [0, 0, 1],
    "T": [1, 1, 1],
}


def test_validate_custom_motif_counts_reports_missing_mismatched_and_empty_pwms():
    assert validate_custom_motif_counts({"A": [1], "C": [1], "G": [1]}) == (
        False,
        "Missing counts for base 'T'",
        0,
    )
    valid, error, length = validate_custom_motif_counts({
        "A": [1],
        "C": [1, 2],
        "G": [1],
        "T": [1],
    })
    assert valid is False
    assert "same length" in error
    assert length == 0
    assert validate_custom_motif_counts({"A": [], "C": [], "G": [], "T": []}) == (
        False,
        "PWM cannot be empty",
        0,
    )


def test_register_list_and_delete_custom_motif_updates_state_version():
    state = JupyterState()

    registered = register_custom_motif(state, "motif1", VALID_COUNTS)
    listed = list_custom_motifs(state.custom_motifs)
    stored_has_pssm = "pssm" in state.custom_motifs["motif1"]
    deleted = delete_custom_motif(state, "motif1")
    missing = delete_custom_motif(state, "motif1")

    assert registered["success"] is True
    assert registered["length"] == 3
    assert stored_has_pssm is True
    assert listed == {"success": True, "motifs": [{"name": "motif1", "length": 3}], "count": 1}
    assert deleted == {"success": True, "message": "Custom motif 'motif1' removed"}
    assert missing == {"success": False, "error": "Custom motif 'motif1' not found"}
    assert state.version == 2


def test_detect_motif_file_format_uses_extension_and_content(tmp_path):
    jaspar = tmp_path / "motifs.jaspar"
    meme = tmp_path / "motifs.meme"
    content_jaspar = tmp_path / "unknown.dat"
    content_meme = tmp_path / "unknown2.dat"

    jaspar.write_text(">M1\n")
    meme.write_text("MEME version 5\n")
    content_jaspar.write_text(">M2\n")
    content_meme.write_text("MEME version 5\n")

    assert detect_motif_file_format(str(jaspar), "auto") == "jaspar"
    assert detect_motif_file_format(str(meme), "auto") == "meme"
    assert detect_motif_file_format(str(content_jaspar), "auto") == "jaspar"
    assert detect_motif_file_format(str(content_meme), "auto") == "meme"
    assert detect_motif_file_format(str(jaspar), "meme") == "meme"


def test_format_and_list_available_jaspar_motifs(monkeypatch):
    motif = SimpleNamespace(
        matrix_id="MA0001.1",
        name="TestTF",
        species=[7227],
        tf_family=["zinc"],
        counts={"A": [1, 2], "C": [0, 0], "G": [0, 0], "T": [2, 1]},
    )

    class _Db:
        def fetch_motifs(self, **kwargs):
            assert kwargs == {"species": 7227, "tax_group": ["insects"], "tf_family": ["zinc"]}
            return [motif, SimpleNamespace(matrix_id="MA2", name="Other", length=4)]

    monkeypatch.setattr(jupyter_motifs.motif_service, "check_pyjaspar", lambda: True)
    monkeypatch.setattr(jupyter_motifs.motif_service, "get_jaspar_db", lambda: _Db())

    assert format_jaspar_motif(motif) == {
        "matrix_id": "MA0001.1",
        "name": "TestTF",
        "species": [7227],
        "tf_family": ["zinc"],
        "length": 2,
    }
    listed = list_available_jaspar_motifs(
        species=7227,
        tax_group="insects",
        tf_family="zinc",
        name_contains="test",
    )
    assert listed == {
        "success": True,
        "motifs": [format_jaspar_motif(motif)],
        "count": 1,
    }


def test_collect_motifs_to_search_handles_custom_motifs_and_missing_pyjaspar(monkeypatch):
    req = SimpleNamespace(motifs=[], motif_ids=[], custom_motifs=["custom:motif1"])
    custom = {"motif1": {"counts": VALID_COUNTS, "pssm": None, "length": 3}}
    monkeypatch.setattr(jupyter_motifs.motif_service, "pwm_to_pssm", lambda counts: {"pssm": counts["A"]})

    motifs_to_search, error = collect_motifs_to_search(req, custom)

    assert error is None
    assert motifs_to_search == [("custom:motif1", "motif1", {"pssm": [1, 0, 0]})]
    assert custom["motif1"]["pssm"] == {"pssm": [1, 0, 0]}

    req_with_jaspar = SimpleNamespace(motifs=["TF"], motif_ids=[], custom_motifs=[])
    monkeypatch.setattr(jupyter_motifs.motif_service, "check_pyjaspar", lambda: False)
    motifs_to_search, error = collect_motifs_to_search(req_with_jaspar, {})
    assert motifs_to_search == []
    assert error == {
        "success": False,
        "error": "pyjaspar not installed. Run: pip install pyjaspar",
        "hits": [],
    }


def test_search_motifs_in_regions_maps_hits_to_genomic_coordinates(monkeypatch):
    regions = [SimpleNamespace(chrom="2L", start=10, end=14, name="peak1")]
    fa = {"chr2L": "A" * 10 + "ACGTACGT"}
    motifs = [("custom:m1", "m1", {"fake": True})]

    def fake_scan_sequence(seq, pssm, threshold):
        assert seq == "AACGTA"
        assert pssm == {"fake": True}
        assert threshold == 0.8
        return [{"start": 1, "end": 4, "score": 5.0, "rel_score": 0.9, "matched_seq": "CGT"}]

    monkeypatch.setattr(jupyter_motifs.motif_service, "scan_sequence", fake_scan_sequence)

    hits = search_motifs_in_regions(
        regions,
        fa,
        motifs,
        extend=1,
        threshold=0.8,
        both_strands=False,
    )

    assert hits == [{
        "region": "peak1",
        "chrom": "2L",
        "region_start": 9,
        "region_end": 15,
        "motif_id": "custom:m1",
        "motif_name": "m1",
        "start": 10,
        "end": 13,
        "strand": "+",
        "score": 5.0,
        "rel_score": 0.9,
        "matched_seq": "CGT",
    }]
