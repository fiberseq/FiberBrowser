"""Header-stripped legacy ns/nl/as/al files: the reads' m6A decides the frame (services/legacy_frame).

Without @PG/@CO the header gives no frame evidence, and molecular-frame legacy tags (fibertools <= 0.12, FiberHMM's
legacy tags) used to be read in SEQ frame, so every reverse read was drawn mirrored (``L - x``). Nucleosomes hold few
m6A calls and MSPs many; read in the wrong frame they land on unrelated sequence, so the reads tell the frames apart.
A header with explicit evidence still wins. All fixtures are synthetic (8 kb contig chrT, reads read_fwd / read_rev).
"""
from __future__ import annotations

import array
from pathlib import Path

import pysam
import pytest

from services import legacy_frame as lf
from services.compact_read_loader import build_compact_reads_from_bam

FIX = Path(__file__).parent / "fixtures"
FT062 = FIX / "fibertools_frame" / "ft0.6.2_addnuc_fire.bam"        # fibertools 0.6.2: ns/nl + as/al, molecular
CALL = FIX / "fibertools_frame" / "fiberhmm3.0.0_call.bam"          # FiberHMM 3.0: legacy tags, coord=molecular
SIMPLE = FIX / "fire_simple"
APPLY = SIMPLE / "fiberhmm_apply_scores.bam"                         # fiberhmm-apply --scores
CALL_FT062 = SIMPLE / "call_then_ft062_fire.bam"
APPLY_FT062 = SIMPLE / "apply_then_ft062_fire.bam"
MOLECULAR_FILES = [p for p in (FT062, CALL, APPLY, CALL_FT062, APPLY_FT062) if p.exists()]
L = 8000
SEQ_HEADER_PG = {"ID": "fiberhmm-apply", "PN": "fiberhmm-apply", "VN": "1.0"}   # FiberHMM v1.0: SEQ frame


@pytest.fixture(autouse=True)
def _fresh_cache():
    lf._CACHE.clear()
    try:
        from services import fire_quality
        fire_quality._CACHE.clear()
    except ImportError:
        pass
    yield
    lf._CACHE.clear()


def _rewrite(src, dst, edit_header=None, edit_read=None):
    with pysam.AlignmentFile(str(src)) as bam:
        header = bam.header.to_dict()
        if edit_header:
            edit_header(header)
        with pysam.AlignmentFile(str(dst), "wb", header=header) as out:
            for read in bam:
                if edit_read:
                    edit_read(read)
                out.write(read)
    pysam.index(str(dst))
    return dst


def _no_history(header):
    header.pop("PG", None)
    header.pop("CO", None)


def _strip(src, tmp_path, name=None, edit_read=None):
    return _rewrite(src, tmp_path / (name or f"stripped_{Path(src).name}"), _no_history, edit_read)


def _to_seq_frame(read):
    """Rewrite a reverse read's legacy intervals from molecular into SEQ (reference-forward) frame."""
    if not read.is_reverse:
        return
    n = read.query_length
    for st, lt in (("ns", "nl"), ("as", "al")):
        if read.has_tag(st):
            starts, lengths = list(read.get_tag(st)), list(read.get_tag(lt))
            read.set_tag(st, array.array("I", [n - (s + l) for s, l in zip(starts, lengths)]))


def _placement(path):
    """read_rev's nucleosome and MSP intervals (sorted) and its as/al overlay spans."""
    reads = build_compact_reads_from_bam(str(path), "chrT", 0, L, spanning_only=False, hide_terminal_gaps=False)
    rev = next(r for r in reads if r["id"] == "read_rev")
    layers = rev.get("layers") or {}
    spans = {name: sorted(tuple(iv[:2]) for iv in (layers.get(name) or {}).get("intervals") or ())
             for name in ("nuc", "msp")}
    spans["fire"] = sorted(tuple(iv[:2]) for iv in rev.get("fire") or ())
    return spans


def _mirrored(spans):
    return {k: sorted((L - e, L - s) for s, e in v) for k, v in spans.items()}


# ── stripped copies place reverse reads as their with-header twins ──────────

@pytest.mark.parametrize("path", MOLECULAR_FILES, ids=lambda p: p.name)
def test_stripped_molecular_files_place_reverse_reads_as_with_header(path, tmp_path):
    stripped = _strip(path, tmp_path)
    want = _placement(path)
    assert want["nuc"] or want["msp"]
    assert _placement(stripped) == want
    verdict = lf.file_legacy_frame(str(stripped), pysam.AlignmentFile(str(stripped)).header)
    assert (verdict["frame"], verdict["basis"], verdict["tuple"]) == ("molecular", lf.BASIS_READS, (True, False))
    assert verdict["reads"]["reverse_reads"] == 1   # one reverse read with ~25 nucleosomes is decisive


@pytest.mark.parametrize("path", MOLECULAR_FILES, ids=lambda p: p.name)
def test_header_with_evidence_is_not_scanned(path, monkeypatch):
    monkeypatch.setattr(lf, "reads_legacy_frame", lambda *_: pytest.fail("the header decides"))
    verdict = lf.file_legacy_frame(str(path), pysam.AlignmentFile(str(path)).header)
    assert (verdict["frame"], verdict["basis"]) == ("molecular", lf.BASIS_HEADER)


def test_diagnostics_expose_the_frame_and_its_basis(tmp_path):
    from services.bam_diagnostics import diagnose_bam_tags
    with_header = diagnose_bam_tags(str(FT062), limit=10)
    assert (with_header["legacy_frame"], with_header["legacy_frame_basis"]) == ("molecular", "header")
    lf._CACHE.clear()
    stripped = diagnose_bam_tags(str(_strip(FT062, tmp_path)), limit=10)
    assert (stripped["legacy_frame"], stripped["legacy_frame_basis"]) == ("molecular", "m6A in reads")


def test_files_endpoint_says_the_reads_decided(tmp_path):
    from services.files_endpoint import diagnose_bam_payload
    result = diagnose_bam_payload(None, bam_path=str(_strip(FT062, tmp_path)))
    text = " ".join(result.get("recommendations") or [])
    assert "fit molecular frame" in text and "can't be confirmed" not in text


# ── no false flips ──────────────────────────────────────────────────────────

def _has_ma(path):
    with pysam.AlignmentFile(str(path)) as bam:
        return any(read.has_tag("MA") for read in bam)


@pytest.mark.parametrize("path", [p for p in MOLECULAR_FILES if not _has_ma(p)], ids=lambda p: p.name)
def test_true_seq_frame_file_is_not_flipped(path, tmp_path):
    """The same chromatin with the reverse read's tags rewritten into SEQ frame: the reads say SEQ, nothing flips,
    and the read lands where the molecular file puts it. (Files whose reads carry FiberHMM >= 2.13.2 "." MA groups
    keep the per-read rule when the reads say SEQ: see test_seq_verdict_keeps_the_per_read_ma_rule.)"""
    seq_file = _strip(path, tmp_path, name=f"seq_{path.name}", edit_read=_to_seq_frame)
    verdict = lf.file_legacy_frame(str(seq_file), pysam.AlignmentFile(str(seq_file)).header)
    assert verdict["frame"] == "seq" and verdict["basis"] == lf.BASIS_READS
    assert verdict["reads"]["frame"] == "seq"
    assert _placement(seq_file) == _placement(path)


def test_seq_verdict_keeps_the_per_read_ma_rule(tmp_path):
    """Header without evidence, reads decisive SEQ: the loaders keep the old per-read rule (a read whose MA has "."
    footprint groups is molecular), so a merge of FiberHMM >= 2.13.2 reads into an old SEQ-frame file is not
    flattened to one frame. Only a molecular verdict overrides it."""
    seq_file = _strip(CALL, tmp_path, name="seq_call.bam", edit_read=_to_seq_frame)
    verdict = lf.file_legacy_frame(str(seq_file), pysam.AlignmentFile(str(seq_file)).header)
    assert (verdict["frame"], verdict["basis"], verdict["tuple"]) == ("seq", lf.BASIS_READS, (False, True))


def test_explicit_seq_header_wins_over_contradicting_reads(tmp_path):
    """A header that names a SEQ-frame writer (FiberHMM v1.0) is followed even when the reads fit molecular frame:
    the placement is the header's (mirrored here), as before this change."""
    def seq_header(h):
        _no_history(h)
        h["PG"] = [dict(SEQ_HEADER_PG)]
    seq_hdr = _rewrite(FT062, tmp_path / "seq_header.bam", seq_header)
    verdict = lf.file_legacy_frame(str(seq_hdr), pysam.AlignmentFile(str(seq_hdr)).header)
    assert (verdict["frame"], verdict["basis"]) == ("seq", lf.BASIS_HEADER)
    assert "reads" not in verdict
    assert _placement(seq_hdr) == _mirrored(_placement(FT062))


def test_ambiguous_header_follows_decisive_reads(tmp_path):
    """Merged branches whose last footprint writers disagree: the reads decide."""
    def merged(h):
        _no_history(h)
        h["PG"] = [{"ID": "pbmm2", "PN": "pbmm2"}, {**SEQ_HEADER_PG, "PP": "pbmm2"},
                   {"ID": "ft", "PN": "fibertools-rs", "VN": "0.6.2", "PP": "pbmm2",
                    "CL": "ft add-nucleosomes in.bam out.bam"}]
    path = _rewrite(FT062, tmp_path / "merged.bam", merged)
    from services.bam_tags import legacy_tag_frame_report
    assert legacy_tag_frame_report(pysam.AlignmentFile(str(path)).header)["ambiguous"]
    verdict = lf.file_legacy_frame(str(path), pysam.AlignmentFile(str(path)).header)
    assert (verdict["frame"], verdict["basis"]) == ("molecular", lf.BASIS_READS)
    assert _placement(path) == _placement(FT062)


# ── inconclusive reads fall back to the header rule ─────────────────────────

def _drop_mm(read):
    for tag in ("MM", "ML", "Mm", "Ml"):
        if read.has_tag(tag):
            read.set_tag(tag, None)


def _weak_ml(read):
    if read.has_tag("ML"):
        read.set_tag("ML", array.array("B", [lf.ML_CUTOFF - 1] * len(read.get_tag("ML"))))


@pytest.mark.parametrize("edit", [_drop_mm, _weak_ml], ids=["no MM/ML", "ML below cutoff"])
def test_inconclusive_reads_fall_back_to_the_header_rule(edit, tmp_path):
    stripped = _strip(FT062, tmp_path, edit_read=edit)
    verdict = lf.file_legacy_frame(str(stripped), pysam.AlignmentFile(str(stripped)).header)
    assert verdict["reads"]["frame"] is None
    assert (verdict["frame"], verdict["basis"], verdict["tuple"]) == ("seq", lf.BASIS_DEFAULT, (False, True))
    # The old rule: no header evidence and no "." MA footprint groups -> SEQ (the pre-fix, mirrored placement).
    assert _placement(stripped) == _mirrored(_placement(FT062))


def test_unreadable_path_is_inconclusive():
    assert lf.reads_legacy_frame("/nonexistent/x.bam")["frame"] is None
    assert lf.bam_legacy_frame_for("/nonexistent/x.bam", {}) == (False, True)


def test_classifier_rules():
    base = {"nuc_n": 25, "msp_n": 24}
    # nucleosomes empty in the molecular frame, MSPs rich: molecular
    assert lf.classify({**base, "nuc_mol": 5, "nuc_seq": 446, "msp_mol": 1025, "msp_seq": 584})["frame"] == "molecular"
    assert lf.classify({**base, "nuc_mol": 446, "nuc_seq": 5, "msp_mol": 584, "msp_seq": 1025})["frame"] == "seq"
    # both frames low (an unmethylated or DAF file), or similar: inconclusive
    assert lf.classify({**base, "nuc_mol": 1, "nuc_seq": 6, "msp_mol": 2, "msp_seq": 3})["frame"] is None
    assert lf.classify({**base, "nuc_mol": 400, "nuc_seq": 430, "msp_mol": 600, "msp_seq": 590})["frame"] is None
    # too few intervals
    assert lf.classify({"nuc_n": 3, "nuc_mol": 0, "nuc_seq": 200})["frame"] is None
    # MSPs alone decide a file without ns/nl
    assert lf.classify({"msp_n": 24, "msp_mol": 842, "msp_seq": 420})["frame"] == "molecular"
    # nucleosomes and MSPs disagreeing: inconclusive
    assert lf.classify({**base, "nuc_mol": 5, "nuc_seq": 446, "msp_mol": 400, "msp_seq": 800})["frame"] is None


def test_forward_reads_do_not_vote(tmp_path):
    def forward_only(read):
        if read.is_reverse:
            read.is_unmapped = True
    stripped = _strip(FT062, tmp_path, edit_read=forward_only)
    with pysam.AlignmentFile(str(stripped)) as bam:
        assert lf.scan_reads(bam.fetch(until_eof=True))["reverse_reads"] == 0


def test_verdict_is_cached_per_file(tmp_path, monkeypatch):
    stripped = _strip(FT062, tmp_path)
    first = lf.reads_legacy_frame(str(stripped))
    monkeypatch.setattr(lf, "scan_reads", lambda *_a, **_k: pytest.fail("cached"))
    assert lf.reads_legacy_frame(str(stripped)) == first
