import os
import numpy as np
import pandas as pd
import sys

from routers.primers import _subsample_pair_indices, blast_and_build_pairs, fast_find_primers
from services.primer_candidates import (
    calc_primer_tm,
    count_valid_pairs_chunked,
    find_pair_participation,
    find_valid_pair_indices_chunked,
    has_tandem_repeat,
)
from services.primer_blast_scoring import parse_blast_hits
from services.primer_blast_runtime import BLAST_HIT_CACHE, blast_and_score_cached, blast_db_signature, cache_blast_hits
from services.primer_config import PRIMER_DIAGNOSTICS_ENV


def test_dafc_pair_cap_is_reproducible_from_sample_seed():
    fwd_idx = np.arange(100)
    rev_idx = np.arange(100) + 1000

    a_fwd, a_rev = _subsample_pair_indices(fwd_idx, rev_idx, 10, "paper-v1", "x", "chr2L")
    b_fwd, b_rev = _subsample_pair_indices(fwd_idx, rev_idx, 10, "paper-v1", "x", "chr2L")
    c_fwd, c_rev = _subsample_pair_indices(fwd_idx, rev_idx, 10, "paper-v2", "x", "chr2L")

    assert len(a_fwd) == 10
    assert np.array_equal(a_fwd, b_fwd)
    assert np.array_equal(a_rev, b_rev)
    assert not np.array_equal(a_fwd, c_fwd)
    assert np.array_equal(a_rev, a_fwd + 1000)
    assert np.array_equal(c_rev, c_fwd + 1000)


def test_dafc_pair_cap_preserves_small_pair_sets():
    fwd_idx = np.arange(5)
    rev_idx = np.arange(5) + 1000

    capped_fwd, capped_rev = _subsample_pair_indices(fwd_idx, rev_idx, 10, "paper-v1", "x")

    assert capped_fwd is fwd_idx
    assert capped_rev is rev_idx


def test_blast_hit_parser_scores_off_targets_and_three_prime_threats(tmp_path):
    blast_out = tmp_path / "blast.tsv"
    primer_a = "ACTACTACTACTACTACT"
    primer_b = "TGTGTGTGTGTGTGTGTG"
    primer_c = "ACACACACACACACACAC"
    primer_d = "ATATATATATATATATAT"
    blast_out.write_text(
        "\n".join([
            "p0\t100\t18\t1\t18\tchr2L\t100\t118",
            "p0\t95\t16\t1\t12\tchr2L\t500\t516",
            "p0\t92\t12\t7\t18\tchr2L\t900\t912",
            "p1\t100\t18\t1\t18\tchr2L\t200\t218",
            "p3\t100\t18\t1\t18\tchr2L\t300\t318",
            "p3\t100\t18\t1\t18\tchr3R\t800\t818",
        ]) + "\n"
    )

    passing, counts, raw_hits = parse_blast_hits(
        str(blast_out),
        {"p0": primer_a, "p1": primer_b, "p2": primer_c, "p3": primer_d},
    )

    assert primer_a not in passing
    assert counts[primer_a] == {"on_target": 1, "off_target": 1, "three_prime_threats": 1}
    assert primer_b in passing
    assert counts[primer_b] == {"on_target": 1, "off_target": 0, "three_prime_threats": 0}
    assert primer_c not in passing
    assert counts[primer_c] == {"on_target": 0, "off_target": 0, "three_prime_threats": 0}
    assert primer_d not in passing
    assert counts[primer_d] == {"on_target": 2, "off_target": 0, "three_prime_threats": 0}
    assert raw_hits[primer_a] == [(100.0, 18, 18), (95.0, 16, 12), (92.0, 12, 18)]


def test_primer_pair_blast_progress_is_opt_in(monkeypatch, capsys, tmp_path):
    blast_db = str(tmp_path / "test-blast-db")
    (tmp_path / "test-blast-db.nsq").write_text("db")
    valid_fwd = pd.DataFrame([{
        "sequences": "ACTACTACTACTACTACT",
        "starts": 100,
        "ends": 118,
        "tms": 60.0,
        "length": 18,
    }])
    valid_rev = pd.DataFrame([{
        "sequences": "TGTGTGTGTGTGTGTGTG",
        "starts": 250,
        "left_edge": 232,
        "tms": 60.5,
        "length": 18,
    }])

    monkeypatch.delenv(PRIMER_DIAGNOSTICS_ENV, raising=False)
    BLAST_HIT_CACHE.clear()
    cache_blast_hits(blast_db, {
        "ACTACTACTACTACTACT": [(100.0, 18, 18)],
        "TGTGTGTGTGTGTGTGTG": [(100.0, 18, 18)],
    })

    pairs = blast_and_build_pairs(
        valid_fwd,
        valid_rev,
        (np.array([0]), np.array([0])),
        150,
        220,
        blast_db,
    )

    assert len(pairs) == 1
    assert capsys.readouterr().out == ""


def test_fast_find_primers_skips_primer3_when_cheap_filters_reject_all(monkeypatch):
    class _Primer3Sentinel:
        @staticmethod
        def calc_tm(_seq):
            raise AssertionError("primer3 should not be called when cheap filters reject all candidates")

    monkeypatch.setitem(sys.modules, "primer3", _Primer3Sentinel)

    primers = fast_find_primers(
        "GGGGGGGGGGGGGGGGGGGGGGGGG",
        0,
        min_len=18,
        max_len=20,
        min_tm=55,
        max_tm=65,
        max_gs=0,
    )

    assert primers.empty


def test_tandem_repeat_filter_detects_periodic_non_homopolymer_runs():
    assert has_tandem_repeat("TTACACACACACACGG")
    assert has_tandem_repeat("GGATGATGATGATGTT")
    assert not has_tandem_repeat("TTACGTACTTAGCGAT")


def test_wallace_tm_method_does_not_require_primer3(monkeypatch):
    class _Primer3Sentinel:
        @staticmethod
        def calc_tm(_seq, **_kwargs):
            raise AssertionError("primer3 should not be called for Wallace Tm")

    monkeypatch.setitem(sys.modules, "primer3", _Primer3Sentinel)

    assert calc_primer_tm("ACGTACGTACGTACGTACGT", "wallace") == 60.0


def test_tm_method_defaults_to_primer3(monkeypatch):
    from services.primer_candidates import normalize_tm_method

    # Unset / unknown / aliased values all resolve to the primer3 default.
    assert normalize_tm_method(None) == "primer3"
    assert normalize_tm_method("") == "primer3"
    assert normalize_tm_method("not-a-real-method") == "primer3"

    calls = []

    class _Primer3Fake:
        @staticmethod
        def calc_tm(_seq, **kwargs):
            calls.append(kwargs)
            return 60.0

    monkeypatch.setitem(sys.modules, "primer3", _Primer3Fake)
    # Default (method omitted) uses bare primer3 defaults, not snapgene salts.
    assert calc_primer_tm("ACGTACGTACGTACGTACGT") == 60.0
    assert calls == [{}]


def test_snapgene_tm_method_uses_snapgene_like_conditions(monkeypatch):
    calls = []

    class _Primer3Fake:
        @staticmethod
        def calc_tm(_seq, **kwargs):
            calls.append(kwargs)
            return 61.2

    monkeypatch.setitem(sys.modules, "primer3", _Primer3Fake)

    assert calc_primer_tm("ACGTACGTACGTACGTACGT", "snapgene") == 61.2
    assert calls == [{
        "mv_conc": 50.0,
        "dv_conc": 0.0,
        "dntp_conc": 0.0,
        "dna_conc": 250.0,
        "tm_method": "santalucia",
        "salt_corrections_method": "santalucia",
    }]


def test_fast_find_primers_rejects_tandem_repeats_before_tm(monkeypatch):
    class _Primer3Sentinel:
        @staticmethod
        def calc_tm(_seq, **_kwargs):
            raise AssertionError("primer3 should not be called when repeat filter rejects all candidates")

    monkeypatch.setitem(sys.modules, "primer3", _Primer3Sentinel)

    primers = fast_find_primers(
        "AC" * 20,
        0,
        min_len=18,
        max_len=20,
        min_tm=0,
        max_tm=100,
        max_gs=10,
        check_tandem_repeats=True,
    )

    assert primers.empty


def test_cached_blast_scoring_requires_home_hit(tmp_path):
    db_path = str(tmp_path / "test-db")
    (tmp_path / "test-db.nsq").write_text("db")
    primer_home = "ACTACTACTACTACTACT"
    primer_no_home = "ACACACACACACACACAC"
    BLAST_HIT_CACHE.clear()
    cache_blast_hits(db_path, {
        primer_home: [(100.0, len(primer_home), len(primer_home))],
        primer_no_home: [],
    })

    passing, counts, n_cached, n_blasted, stderr = blast_and_score_cached(
        [primer_home, primer_no_home],
        db_path,
    )

    assert passing == {primer_home}
    assert counts[primer_no_home]["on_target"] == 0
    assert n_cached == 2
    assert n_blasted == 0
    assert stderr == ""


def test_blast_cache_signature_changes_when_db_size_changes_with_same_mtime(tmp_path):
    db_path = str(tmp_path / "test-db")
    db_header = tmp_path / "test-db.nhr"
    db_header.write_text("a")
    old_stat = db_header.stat()
    seq = "ACTACTACTACTACTACT"

    BLAST_HIT_CACHE.clear()
    signature_a = blast_db_signature(db_path)
    cache_blast_hits(db_path, {seq: [(100.0, len(seq), len(seq))]})
    assert (seq, db_path, signature_a) in BLAST_HIT_CACHE

    db_header.write_text("ab")
    os.utime(db_header, ns=(old_stat.st_atime_ns, old_stat.st_mtime_ns))
    signature_b = blast_db_signature(db_path)

    assert signature_b != signature_a
    assert (seq, db_path, signature_b) not in BLAST_HIT_CACHE


def test_cached_blast_scoring_requires_single_home_hit(tmp_path):
    db_path = str(tmp_path / "test-db")
    (tmp_path / "test-db.nsq").write_text("db")
    primer_unique = "ACTACTACTACTACTACT"
    primer_duplicate = "ATATATATATATATATAT"
    BLAST_HIT_CACHE.clear()
    cache_blast_hits(db_path, {
        primer_unique: [(100.0, len(primer_unique), len(primer_unique))],
        primer_duplicate: [
            (100.0, len(primer_duplicate), len(primer_duplicate)),
            (100.0, len(primer_duplicate), len(primer_duplicate)),
        ],
    })

    passing, counts, n_cached, n_blasted, _stderr = blast_and_score_cached(
        [primer_unique, primer_duplicate],
        db_path,
    )

    assert passing == {primer_unique}
    assert counts[primer_duplicate]["on_target"] == 2
    assert n_cached == 2
    assert n_blasted == 0


def test_primer_pair_chunking_matches_dense_broadcast():
    valid_fwd = pd.DataFrame({
        "starts": np.array([100, 130, 190, 260]),
        "tms": np.array([60.0, 61.0, 64.0, 59.0]),
    })
    valid_rev = pd.DataFrame({
        "starts": np.array([500, 560, 620]),
        "tms": np.array([60.5, 63.0, 58.5]),
    })
    min_product = 350
    max_product = 470
    max_tm_diff = 2.0

    product_sizes = valid_rev["starts"].values[np.newaxis, :] - valid_fwd["starts"].values[:, np.newaxis]
    tm_diffs = np.abs(valid_fwd["tms"].values[:, np.newaxis] - valid_rev["tms"].values[np.newaxis, :])
    dense_mask = (
        (product_sizes >= min_product) &
        (product_sizes <= max_product) &
        (tm_diffs <= max_tm_diff)
    )
    dense_fi, dense_ri = np.where(dense_mask)

    fi, ri = find_valid_pair_indices_chunked(
        valid_fwd["starts"].values,
        valid_fwd["tms"].values,
        valid_rev["starts"].values,
        valid_rev["tms"].values,
        min_product,
        max_product,
        max_tm_diff,
        max_cells=5,
    )
    fwd_mask, rev_mask = find_pair_participation(
        valid_fwd,
        valid_rev,
        min_product,
        max_product,
        max_tm_diff,
        max_cells=5,
    )

    assert np.array_equal(fi, dense_fi)
    assert np.array_equal(ri, dense_ri)
    assert np.array_equal(fwd_mask, dense_mask.any(axis=1))
    assert np.array_equal(rev_mask, dense_mask.any(axis=0))
    assert count_valid_pairs_chunked(
        valid_fwd["starts"].values,
        valid_fwd["tms"].values,
        valid_rev["starts"].values,
        valid_rev["tms"].values,
        min_product,
        max_product,
        max_tm_diff,
        max_cells=5,
    ) == int(dense_mask.sum())


def test_blast_cache_signature_covers_alias_volumes(tmp_path):
    """An alias DB (.nal) whose volumes change must not reuse cached hits."""
    (tmp_path / "db.nal").write_text('TITLE db\nDBLIST "vol_a" "vol_b"\n')
    (tmp_path / "vol_a.nsq").write_text("a")
    vol_b = tmp_path / "vol_b.nsq"
    vol_b.write_text("b")
    db_path = str(tmp_path / "db")
    before = blast_db_signature(db_path)
    assert before is not None and any("vol_b.nsq" in row[0] for row in before)
    vol_b.write_text("b with new targets")
    assert blast_db_signature(db_path) != before


def test_blast_cache_signature_covers_numbered_volumes(tmp_path):
    (tmp_path / "db.00.nsq").write_text("a")
    db_path = str(tmp_path / "db")
    before = blast_db_signature(db_path)
    assert before is not None
    (tmp_path / "db.01.nsq").write_text("b")
    assert blast_db_signature(db_path) != before


def test_blast_cache_is_skipped_without_database_files(tmp_path):
    db_path = str(tmp_path / "missing-db")
    BLAST_HIT_CACHE.clear()
    assert blast_db_signature(db_path) is None
    cache_blast_hits(db_path, {"ACTACTACTACTACTACT": [(100.0, 18, 18)]})
    assert BLAST_HIT_CACHE == {}
