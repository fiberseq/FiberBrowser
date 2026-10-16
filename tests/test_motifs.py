"""Regression tests for extracted motif helpers."""

import threading

import numpy as np
import pytest

from services import motifs


def test_motif_scanning_helpers():
    counts = motifs.consensus_to_pwm("ATGN")
    pssm = motifs.pwm_to_pssm(counts)

    assert np.allclose(pssm, motifs.pwm_to_pssm(counts))
    assert motifs.reverse_complement("AaCcGgTtNnX") == "NnNaAcCgGtT"

    sequence = "CCCATGACATGGG"
    assert motifs.scan_sequence(sequence, pssm, 0.8)
    assert motifs.scan_both_strands(sequence, pssm, 0.8)


def test_scan_sequence_vectorized_path_skips_ambiguous_windows():
    pssm = motifs.pwm_to_pssm(motifs.consensus_to_pwm("ATG"))

    hits = motifs.scan_sequence("ATGNATG", pssm, 0.8)

    assert [(hit["start"], hit["end"], hit["matched_seq"]) for hit in hits] == [
        (0, 3, "ATG"),
        (4, 7, "ATG"),
    ]


def test_parse_jaspar_file(tmp_path):
    motif_file = tmp_path / "example.jaspar"
    motif_file.write_text(
        "\n".join(
            [
                ">MA0001.1 TEST",
                "A [ 10 0 0 ]",
                "C [ 0 10 0 ]",
                "G [ 0 0 10 ]",
                "T [ 0 0 0 ]",
            ]
        )
    )

    parsed = motifs.parse_jaspar_file(str(motif_file))

    assert list(parsed) == ["TEST"]
    assert parsed["TEST"]["counts"]["A"] == [10.0, 0.0, 0.0]


def test_consensus_to_pwm_rejects_invalid_iupac():
    with pytest.raises(ValueError, match="Invalid IUPAC character"):
        motifs.consensus_to_pwm("ATX")


def test_jaspar_core_motifs_are_cached_per_species(monkeypatch):
    class FakeMotif:
        def __init__(self, matrix_id, a_total):
            self.matrix_id = matrix_id
            self.name = matrix_id
            self.counts = {
                "A": [a_total],
                "C": [1],
                "G": [1],
                "T": [1],
            }

    class FakeDb:
        def __init__(self):
            self.calls = 0

        def fetch_motifs(self, **kwargs):
            self.calls += 1
            assert kwargs["collection"] == "CORE"
            assert kwargs["species"] == [7227]
            return [FakeMotif("low", 1), FakeMotif("high", 10)]

    fake_db = FakeDb()
    motifs._jaspar_core_motif_cache.clear()
    monkeypatch.setattr(motifs, "get_jaspar_db", lambda release="JASPAR2024": fake_db)

    first = motifs.get_jaspar_core_motifs(7227)
    second = motifs.get_jaspar_core_motifs(7227)

    assert [m.matrix_id for m in first] == ["high", "low"]
    assert second is first
    assert fake_db.calls == 1


def test_jaspar_core_motifs_cache_crosses_threads(monkeypatch):
    class FakeMotif:
        matrix_id = "MA0001.1"
        name = "Motif"
        counts = {
            "A": [5],
            "C": [1],
            "G": [1],
            "T": [1],
        }

    class FakeDb:
        def __init__(self):
            self.calls = 0
            self.lock = threading.Lock()

        def fetch_motifs(self, **_kwargs):
            with self.lock:
                self.calls += 1
            return [FakeMotif()]

    fake_db = FakeDb()
    motifs._jaspar_core_motif_cache.clear()
    monkeypatch.setattr(motifs, "get_jaspar_db", lambda release="JASPAR2024": fake_db)

    barrier = threading.Barrier(4)
    results = []

    def fetch_from_thread():
        barrier.wait()
        results.append(motifs.get_jaspar_core_motifs(7227))

    threads = [threading.Thread(target=fetch_from_thread) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len({id(result) for result in results}) == 1
    assert fake_db.calls == 1
    assert results[0][0].counts["A"] == [5.0]
