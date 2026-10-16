"""Regression tests for extracted orthogonal track loading."""

from services import orthogonal_tracks


class DummyFasta:
    references = ["chr1"]

    def get_reference_length(self, chrom):
        assert chrom == "chr1"
        return 1000

    def fetch(self, chrom, start, end):
        assert chrom == "chr1"
        return "A" * max(0, end - start)


def test_load_orthogonal_tracks_parses_labels_and_skips_missing(tmp_path):
    track_a = tmp_path / "signal_a.bw"
    track_b = tmp_path / "signal_b.bigWig"
    missing = tmp_path / "missing.bw"
    tracks_file = tmp_path / "tracks.txt"

    track_a.write_text("")
    track_b.write_text("")
    tracks_file.write_text(
        "\n".join(
            [
                "# comment",
                str(track_a),
                f"{track_b} Explicit Label",
                f"{missing} Missing Label",
                "",
            ]
        )
        + "\n"
    )

    expected = [
        {"path": str(track_a), "label": "signal_a"},
        {"path": str(track_b), "label": "Explicit Label"},
    ]

    assert orthogonal_tracks.load_orthogonal_tracks(str(tracks_file)) == expected


def test_load_orthogonal_tracks_diagnostics_are_opt_in(tmp_path, capsys, monkeypatch):
    track_a = tmp_path / "signal_a.bw"
    missing = tmp_path / "missing.bw"
    tracks_file = tmp_path / "tracks.txt"

    track_a.write_text("")
    tracks_file.write_text(f"{track_a}\n{missing} Missing Label\n")
    monkeypatch.delenv(orthogonal_tracks.TRACK_DIAGNOSTICS_ENV, raising=False)

    assert orthogonal_tracks.load_orthogonal_tracks(str(tracks_file)) == [
        {"path": str(track_a), "label": "signal_a"},
    ]
    assert capsys.readouterr().out == ""

    monkeypatch.setenv(orthogonal_tracks.TRACK_DIAGNOSTICS_ENV, "1")
    assert orthogonal_tracks.load_orthogonal_tracks(str(tracks_file)) == [
        {"path": str(track_a), "label": "signal_a"},
    ]
    output = capsys.readouterr().out
    assert "Loading orthogonal tracks from" in output
    assert "Track file not found" in output
    assert "Loaded 1 tracks" in output


def test_load_orthogonal_tracks_missing_config_returns_empty(tmp_path):
    tracks_file = tmp_path / "missing.txt"

    assert orthogonal_tracks.load_orthogonal_tracks(str(tracks_file)) == []


def test_custom_motif_hits_are_not_shared_between_references(monkeypatch, tmp_path):
    import pysam
    orthogonal_tracks.clear_custom_motif_annotation_cache()
    a, b = tmp_path / "a.fa", tmp_path / "b.fa"
    a.write_text(">chr1\n" + "A" * 200 + "\n")
    b.write_text(">chr1\n" + "C" * 200 + "\n")
    pysam.faidx(str(a))
    pysam.faidx(str(b))
    seen = []

    def scanner(seq, pssm, threshold):
        seen.append(seq[:3])
        return [{"start": 10, "end": 14, "strand": "+", "rel_score": 0.9}]

    track = {"path": "motif://sequence/GAGA", "label": "GAGA", "format": "custom_motif", "motif_name": "GAGA",
             "motif_type": "sequence", "pssm": object(), "threshold": 0.85, "counts": {"A": [1], "C": [0], "G": [0], "T": [0]}}
    for fa in (a, b):
        orthogonal_tracks.get_track_annotations(track, "chr1", 0, 100, fasta=pysam.FastaFile(str(fa)), motif_scanner=scanner)
    assert seen == ["AAA", "CCC"]  # the second reference was scanned, not served from the first's cache


def test_custom_motif_annotations_reuse_tile_cache(monkeypatch):
    orthogonal_tracks.clear_custom_motif_annotation_cache()
    monkeypatch.setattr(orthogonal_tracks, "CUSTOM_MOTIF_CACHE_TILE_BP", 100)

    calls = []

    def scanner(seq, pssm, threshold):
        calls.append((len(seq), pssm, threshold))
        return [
            {"start": 30, "end": 34, "strand": "+", "rel_score": 0.9},
            {"start": 95, "end": 99, "strand": "-", "rel_score": 0.8},
        ]

    track = {
        "path": "motif://sequence/GAGA",
        "label": "GAGA",
        "format": "custom_motif",
        "motif_name": "GAGA",
        "motif_type": "sequence",
        "pssm": object(),
        "threshold": 0.85,
        "counts": {"A": [1], "C": [0], "G": [0], "T": [0]},
    }

    first = orthogonal_tracks.get_track_annotations(
        track,
        "chr1",
        10,
        60,
        fasta=DummyFasta(),
        motif_scanner=scanner,
    )
    assert first["intervals"] == [{
        "start": 30,
        "end": 34,
        "name": "GAGA",
        "strand": "+",
        "score": 900,
    }]
    first["intervals"][0]["score"] = 1
    second = orthogonal_tracks.get_track_annotations(
        track,
        "chr1",
        20,
        80,
        fasta=DummyFasta(),
        motif_scanner=scanner,
    )

    assert len(calls) == 1
    assert calls[0][0] == 101  # the 100-bp tile plus a motif length past its right edge
    assert second["intervals"] == [{
        "start": 30,
        "end": 34,
        "name": "GAGA",
        "strand": "+",
        "score": 900,
    }]
