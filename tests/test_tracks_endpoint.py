from models.requests import MotifFileRequest, MotifPwmTrackRequest, MotifSequenceRequest, TracksBatchBody, TracksExportBody
from services.tracks_endpoint import (
    add_motif_file_tracks_for_request,
    add_motif_pwm_track_for_request,
    add_motif_sequence_track_for_request,
    add_track_for_request,
    build_multi_track_export_payload,
    build_single_track_export_payload,
    get_track_annotations_payload,
    get_track_data_payload,
    get_tracks_batch_payload,
    get_tracks_payload,
    remove_track_for_request,
    reorder_tracks_for_request,
    update_track_filter_for_request,
)


class FakeTrackState:
    def __init__(self):
        self.orthogonal_tracks = [
            {
                "path": "/tmp/a.bw",
                "label": "A",
                "format": "bigWig",
                "render_mode": "signal",
                "category": "signal",
            },
            {
                "path": "motif://sequence/GAGA",
                "label": "GAGA",
                "format": "custom_motif",
                "render_mode": "annotation",
                "motif_type": "sequence",
                "motif_name": "GAGA",
            },
        ]
        self.track_data_calls = []
        self.annotation_calls = []

    def get_track_data(self, track_idx, chrom, start, end, bins):
        self.track_data_calls.append((track_idx, chrom, start, end, bins))
        if track_idx == 0:
            return [1.0, 2.0]
        return None

    def get_track_annotations(self, track_idx, chrom, start, end, filter_names=None):
        self.annotation_calls.append((track_idx, chrom, start, end, filter_names))
        if track_idx == 0:
            return {"label": "A", "intervals": [{"start": 1, "end": 2}]}
        return None


def test_track_data_payload_handles_valid_missing_and_invalid_tracks():
    state = FakeTrackState()

    assert get_track_data_payload(state, 0, "chr2L", 10, 20, 2) == {
        "label": "A",
        "values": [1.0, 2.0],
        "render_mode": "signal",
    }
    assert state.track_data_calls == [(0, "chr2L", 10, 20, 2)]

    assert get_track_data_payload(state, 1, "chr2L", 10, 20, 2) == {
        "label": "GAGA",
        "values": [],
        "render_mode": "annotation",
    }
    assert get_track_data_payload(state, 99, "chr2L", 10, 20, 2) == {
        "error": "Track not found",
        "values": [],
    }


def test_track_annotations_payload_parses_filter_names_and_fallbacks():
    state = FakeTrackState()

    assert get_track_annotations_payload(state, 0, "chr2L", 10, 20, "A, B ,,") == {
        "label": "A",
        "intervals": [{"start": 1, "end": 2}],
    }
    assert state.annotation_calls == [(0, "chr2L", 10, 20, ["A", "B"])]

    assert get_track_annotations_payload(state, 1, "chr2L", 10, 20) == {
        "label": "GAGA",
        "intervals": [],
        "track_type": "",
    }
    assert get_track_annotations_payload(state, 99, "chr2L", 10, 20) == {
        "error": "Track not found",
        "intervals": [],
    }


def test_tracks_batch_payload_fetches_signal_and_annotations():
    state = FakeTrackState()

    payload = get_tracks_batch_payload(
        state,
        TracksBatchBody(
            track_indices=[0, 1, 99],
            chrom="chr2L",
            start=10,
            end=20,
            bins=2,
            annotation_filters={1: ["GAGA"]},
        ),
    )

    assert payload["tracks"][0] == {
        "index": 0,
        "label": "A",
        "values": [1.0, 2.0],
        "render_mode": "signal",
    }
    assert payload["tracks"][1] == {
        "index": 1,
        "label": "GAGA",
        "values": [],
        "intervals": [],
        "track_type": "",
        "render_mode": "annotation",
    }
    assert payload["tracks"][2] == {"index": 99, "error": "Track not found", "values": []}
    assert state.track_data_calls == [(0, "chr2L", 10, 20, 2)]
    assert state.annotation_calls == [(1, "chr2L", 10, 20, ["GAGA"])]


def test_single_track_export_payload_builds_export_and_fallback_values():
    state = FakeTrackState()

    result = build_single_track_export_payload(
        state,
        track_idx=0,
        chrom="chr2L",
        start=10,
        end=20,
        bins=2,
        format="tsv",
    )

    assert result["export"]["filename"] == "A_chr2L_10_20.tsv"
    assert result["export"]["media_type"] == "text/tab-separated-values"
    assert result["export"]["content"].splitlines() == [
        "chrom\tstart\tend\tA",
        "chr2L\t10\t15\t1.0",
        "chr2L\t15\t20\t2.0",
    ]
    assert state.track_data_calls == [(0, "chr2L", 10, 20, 2)]

    missing = build_single_track_export_payload(
        state,
        track_idx=1,
        chrom="chr2L",
        start=10,
        end=20,
        bins=2,
    )
    assert "chr2L\t10\t15\t0.0" in missing["export"]["content"]
    assert "chr2L\t15\t20\t0.0" in missing["export"]["content"]


def test_single_track_export_payload_reports_invalid_requests():
    state = FakeTrackState()

    assert build_single_track_export_payload(
        state,
        track_idx=9,
        chrom="chr2L",
        start=10,
        end=20,
    ) == {"error": "Track not found", "status_code": 404}
    assert build_single_track_export_payload(
        state,
        track_idx=0,
        chrom="chr2L",
        start=20,
        end=20,
    ) == {"error": "Invalid region", "status_code": 400}


def test_multi_track_export_payload_uses_labels_and_zero_fills_invalid_tracks():
    state = FakeTrackState()

    result = build_multi_track_export_payload(
        state,
        TracksExportBody(
            track_indices=[0, 99, 1],
            labels=["Signal", "Missing", "Motif"],
            chrom="chr2L",
            start=10,
            end=20,
            bins=2,
        ),
    )

    assert result["export"]["filename"] == "tracks_chr2L_10_20.tsv"
    assert result["export"]["content"].splitlines() == [
        "chrom\tstart\tend\tSignal\tMissing\tMotif",
        "chr2L\t10\t15\t1.0\t0.0\t0.0",
        "chr2L\t15\t20\t2.0\t0.0\t0.0",
    ]


def test_multi_track_export_payload_reports_invalid_region():
    state = FakeTrackState()

    result = build_multi_track_export_payload(
        state,
        TracksExportBody(track_indices=[0], chrom="chr2L", start=20, end=10),
    )

    assert result == {"error": "Invalid region", "status_code": 400}


def test_track_list_filter_reorder_and_remove_helpers():
    state = FakeTrackState()

    payload = get_tracks_payload(state)
    assert payload["tracks"][0] == {
        "index": 0,
        "label": "A",
        "path": "/tmp/a.bw",
        "render_mode": "signal",
        "format": "bigWig",
        "category": "signal",
        "filter_names": [],
    }
    assert payload["tracks"][1]["motif_name"] == "GAGA"

    assert update_track_filter_for_request(state, 0, {"filter_names": ["CTCF"]}) == {
        "success": True,
        "filter_names": ["CTCF"],
    }
    assert state.orthogonal_tracks[0]["filter_names"] == ["CTCF"]
    # The list says which names a track is filtered to, so the browser never
    # reuses a filtered track for an unfiltered entry of the same file.
    assert get_tracks_payload(state)["tracks"][0]["filter_names"] == ["CTCF"]
    assert update_track_filter_for_request(state, 0, {"filter_names": []}) == {
        "success": True,
        "filter_names": None,
    }

    assert reorder_tracks_for_request(state, {"from_index": 1, "to_index": 0}) == {
        "success": True,
        "message": "Tracks reordered",
    }
    assert [track["label"] for track in state.orthogonal_tracks] == ["GAGA", "A"]

    assert remove_track_for_request(state, 0) == {
        "success": True,
        "message": "Removed track: GAGA",
    }
    assert [track["label"] for track in state.orthogonal_tracks] == ["A"]

    assert update_track_filter_for_request(state, 9, {}) == {"success": False, "message": "Track not found"}
    assert reorder_tracks_for_request(state, {"from_index": 0, "to_index": 9}) == {
        "success": False,
        "message": "Invalid index",
    }
    assert remove_track_for_request(state, 9) == {"success": False, "message": "Track not found"}


def test_add_track_helper_registers_ucsc_virtual_track():
    state = FakeTrackState()

    result = add_track_for_request(
        state,
        path="ucsc://dm6/refGene",
        label="RefSeq",
        category="Genes",
    )

    assert result == {
        "success": True,
        "message": "Added track: RefSeq (UCSC API)",
        "track_index": 2,
        "label": "RefSeq",
        "render_mode": "annotation",
    }
    assert state.orthogonal_tracks[-1] == {
        "path": "ucsc://dm6/refGene",
        "label": "RefSeq",
        "format": "ucsc_api",
        "ucsc_genome": "dm6",
        "ucsc_track": "refGene",
        "track_type": "bed",
        "render_mode": "annotation",
        "category": "Genes",
    }


def test_add_track_helper_registers_bed_file(tmp_path):
    state = FakeTrackState()
    bed = tmp_path / "features.bed"
    bed.write_text("chr2L\t10\t20\tA\nchr2L\t30\t40\tB\n")

    result = add_track_for_request(
        state,
        path=str(bed),
        filter_names="A, B",
    )

    assert result == {
        "success": True,
        "message": "Added track: features (BED, 2 intervals)",
        "track_index": 2,
        "label": "features",
        "render_mode": "annotation",
    }
    assert state.orthogonal_tracks[-1]["format"] == "bed"
    assert state.orthogonal_tracks[-1]["filter_names"] == ["A", "B"]
    assert len(state.orthogonal_tracks[-1]["bed_intervals"]["chr2L"]) == 2


def test_add_track_helper_dedupes_ucsc_track_without_explicit_render_mode():
    state = FakeTrackState()

    first = add_track_for_request(state, path="ucsc://dm6/refGene", label="RefSeq")
    assert first["success"] is True
    n_after_first = len(state.orthogonal_tracks)

    # Re-adding the same UCSC path without render_mode used to miss dedupe
    # because the default for these paths is "annotation" but the lookup
    # treated a missing render_mode as "signal".
    second = add_track_for_request(state, path="ucsc://dm6/refGene", label="RefSeq")
    assert second["success"] is True
    assert second["track_index"] == first["track_index"]
    assert "already loaded" in second["message"]
    assert len(state.orthogonal_tracks) == n_after_first


def test_add_track_helper_dedupes_bed_track_without_explicit_render_mode(tmp_path):
    state = FakeTrackState()
    bed = tmp_path / "features.bed"
    bed.write_text("chr2L\t10\t20\tA\n")

    first = add_track_for_request(state, path=str(bed))
    assert first["success"] is True
    n_after_first = len(state.orthogonal_tracks)

    second = add_track_for_request(state, path=str(bed))
    assert second["success"] is True
    assert second["track_index"] == first["track_index"]
    assert len(state.orthogonal_tracks) == n_after_first


def test_add_track_helper_reports_invalid_paths():
    state = FakeTrackState()

    assert add_track_for_request(state, path="ucsc://invalid") == {
        "success": False,
        "message": "Invalid UCSC API path format",
    }
    missing = add_track_for_request(state, path="/does/not/exist.bw")
    assert missing["success"] is False
    assert "File not found or not readable" in missing["message"]
    assert "/does/not/exist.bw" in missing["message"]


def test_add_motif_sequence_track_helper_validates_and_registers_sequence():
    state = FakeTrackState()

    result = add_motif_sequence_track_for_request(
        state,
        MotifSequenceRequest(sequence="gaga", label="GAF", threshold=0.85),
    )

    assert result == {
        "success": True,
        "track_index": 2,
        "path": "motif://sequence/GAGA",
        "label": "GAF",
        "motif_name": "GAGA",
        "motif_type": "sequence",
        "message": "Added motif track: GAF",
    }
    track = state.orthogonal_tracks[-1]
    assert track["path"] == "motif://sequence/GAGA"
    assert track["motif_name"] == "GAGA"
    assert track["threshold"] == 0.85
    assert set(track["counts"]) == {"A", "C", "G", "T"}

    assert add_motif_sequence_track_for_request(state, MotifSequenceRequest(sequence="AT")) == {
        "success": False,
        "message": "Sequence must be at least 3 characters",
    }
    assert add_motif_sequence_track_for_request(state, MotifSequenceRequest(sequence="BAD!")) == {
        "success": False,
        "message": "Invalid characters. Use IUPAC DNA codes (A,C,G,T,R,Y,S,W,K,M,B,D,H,V,N)",
    }


def test_add_motif_file_tracks_helper_autodetects_jaspar(tmp_path):
    state = FakeTrackState()
    motif_file = tmp_path / "motifs.jaspar"
    motif_file.write_text(
        ">MA0001.1 TestTF\n"
        "A [ 1 0 0 1 ]\n"
        "C [ 0 1 0 0 ]\n"
        "G [ 0 0 1 0 ]\n"
        "T [ 0 0 0 1 ]\n"
    )

    result = add_motif_file_tracks_for_request(
        state,
        MotifFileRequest(file_path=str(motif_file), threshold=0.9),
    )

    assert result == {
        "success": True,
        "loaded": ["TestTF"],
        "tracks": [{
            "track_index": 2,
            "path": "motif://file/motifs.jaspar/TestTF",
            "label": "TestTF (motifs.jaspar)",
            "motif_name": "TestTF",
            "motif_type": "file",
            "motif_source": "motifs.jaspar",
            "threshold": 0.9,
        }],
        "count": 1,
        "message": "Loaded 1 motifs from motifs.jaspar",
    }
    track = state.orthogonal_tracks[-1]
    assert track["path"] == "motif://file/motifs.jaspar/TestTF"
    assert track["label"] == "TestTF (motifs.jaspar)"
    assert track["motif_type"] == "file"
    assert track["threshold"] == 0.9


def test_add_motif_pwm_track_helper_validates_and_registers_pwm():
    state = FakeTrackState()

    result = add_motif_pwm_track_for_request(
        state,
        MotifPwmTrackRequest(
            name="Custom PWM",
            label="Custom",
            threshold=0.82,
            counts={"A": [1, 0], "C": [0, 1], "G": [0, 0], "T": [0, 0]},
        ),
    )

    assert result == {
        "success": True,
        "track_index": 2,
        "path": "motif://pwm/Custom%20PWM",
        "label": "Custom",
        "motif_name": "Custom PWM",
        "motif_type": "pwm",
        "motif_source": "custom PWM",
        "message": "Added PWM motif track: Custom",
    }
    track = state.orthogonal_tracks[-1]
    assert track["path"] == "motif://pwm/Custom%20PWM"
    assert track["motif_type"] == "pwm"
    assert track["counts"]["A"] == [1.0, 0.0]
    assert track["threshold"] == 0.82

    bad = add_motif_pwm_track_for_request(
        state,
        MotifPwmTrackRequest(name="Bad", counts={"A": [1], "C": [1], "G": [1], "T": [1, 2]}),
    )
    assert bad["success"] is False
    assert "same length" in bad["message"]


def test_add_motif_file_tracks_helper_reports_missing_and_empty_files(tmp_path):
    state = FakeTrackState()
    empty_file = tmp_path / "empty.jaspar"
    empty_file.write_text("")

    assert add_motif_file_tracks_for_request(state, MotifFileRequest(file_path="/missing.jaspar")) == {
        "success": False,
        "message": "File not found: /missing.jaspar",
    }
    assert add_motif_file_tracks_for_request(state, MotifFileRequest(file_path=str(empty_file))) == {
        "success": False,
        "message": "No motifs found in file",
    }
