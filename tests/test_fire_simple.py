"""Whether a file's MSP scores are fibertools FIRE scores: one per-file rule, reads first (services/fire_quality).

Supported: FIRE only, and FiberHMM -> FIRE, in both encodings (fibertools 0.13 fire group; fibertools <= 0.12 aq on
as/al). Fixtures (tags written by the real tools; ``fixtures/fire_simple/make_fire_simple_fixtures.py``):

* fibertools_frame/ft0.13_addnuc_fire.bam      FIRE only, ft 0.13
* fibertools_frame/ft0.6.2_addnuc_fire.bam     FIRE only, ft 0.6.2
* fire_simple/call_then_ft013_fire.bam         fiberhmm-call -> ft fire 0.13
* fire_simple/call_then_ft062_fire.bam         fiberhmm-call -> ft fire 0.6.2 (FiberHMM MA + FIRE aq on as/al)
* fire_simple/apply_then_ft013_fire.bam        fiberhmm-apply --scores -> ft fire 0.13
* fire_simple/apply_then_ft062_fire.bam        fiberhmm-apply --scores -> ft fire 0.6.2 (FIRE aq replaces FiberHMM's)
* fibertools_frame/fiberhmm3.0.0_call.bam      FiberHMM only (no score)
* fire_simple/fiberhmm_apply_scores.bam        FiberHMM only, apply --scores (its posterior as aq)
"""
from __future__ import annotations

import array
import json
from pathlib import Path

import pysam
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services import fire_quality
from services.compact_read_loader import build_compact_reads_from_bam
from services.fire_quality import classify, file_fire_status, header_has_ft_fire
from services.read_quality_filters import apply_quality_filters

FIX = Path(__file__).parent / "fixtures"
SIMPLE = FIX / "fire_simple"
FT013 = FIX / "fibertools_frame" / "ft0.13_addnuc_fire.bam"
FT062 = FIX / "fibertools_frame" / "ft0.6.2_addnuc_fire.bam"
CALL = FIX / "fibertools_frame" / "fiberhmm3.0.0_call.bam"
CALL_FT013 = SIMPLE / "call_then_ft013_fire.bam"
CALL_FT062 = SIMPLE / "call_then_ft062_fire.bam"
APPLY_FT013 = SIMPLE / "apply_then_ft013_fire.bam"
APPLY_FT062 = SIMPLE / "apply_then_ft062_fire.bam"
APPLY = SIMPLE / "fiberhmm_apply_scores.bam"
FIRE_FILTER = {"layer": "fire", "quality_name": "aq", "min_value": 230}   # the default FIRE filter
L = 8000

# (file, MSPs per read, FIRE elements per read at aq >= 230)
FIRE_FILES = [
    (FT013, (24, 24), (8, 7)), (FT062, (24, 24), (8, 7)),
    (CALL_FT013, (26, 26), (9, 8)), (CALL_FT062, (26, 26), (9, 8)),
    (APPLY_FT013, (26, 23), (9, 8)), (APPLY_FT062, (26, 23), (9, 8)),
]
FIBERHMM_FILES = [(CALL, (26, 26)), (APPLY, (26, 23))]


@pytest.fixture(autouse=True)
def _fresh_cache():
    fire_quality._CACHE.clear()
    yield
    fire_quality._CACHE.clear()


def _reads(path):
    reads = build_compact_reads_from_bam(str(path), "chrT", 0, L, spanning_only=False, hide_terminal_gaps=False)
    return {r["id"]: r for r in reads}


def _msps(read, filters=()):
    read = apply_quality_filters(read, list(filters)) if filters else read
    return len(read["layers"]["msp"]["intervals"])


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


def _strip(src, tmp_path):
    def no_history(h):
        h.pop("PG", None)
        h.pop("CO", None)
    return _rewrite(src, tmp_path / f"stripped_{Path(src).name}", edit_header=no_history)


def _counts(path):
    reads = _reads(path)
    return ((_msps(reads["read_fwd"]), _msps(reads["read_rev"])),
            (_msps(reads["read_fwd"], [FIRE_FILTER]), _msps(reads["read_rev"], [FIRE_FILTER])))


# ── the supported matrix, headers kept ──────────────────────────────────────

@pytest.mark.parametrize("path, total, fire", FIRE_FILES)
def test_fire_files_keep_the_fire_elements_under_the_default_filter(path, total, fire):
    assert file_fire_status(path)["fire"] is True
    assert _counts(path) == (total, fire)
    msp = _reads(path)["read_fwd"]["layers"]["msp"]
    assert msp["quality_names"] == ["aq"] and msp["quality_source"] == "fire"


@pytest.mark.parametrize("path, total", FIBERHMM_FILES)
def test_fiberhmm_files_are_never_fire_filtered(path, total):
    assert file_fire_status(path)["fire"] is False
    assert _counts(path) == (total, total)


def test_fiberhmm_apply_scores_are_hq():
    msp = _reads(APPLY)["read_fwd"]["layers"]["msp"]
    assert msp["quality_names"] == ["hq"] and any(q < 230 for q in msp["qualities"][0])


def test_which_encoding_each_ft_writes_after_fiberhmm():
    """ft 0.13 rewrites FiberHMM's MA/AQ as Ma/Aq with a fire group; ft 0.6.2 keeps FiberHMM's MA and writes aq."""
    with pysam.AlignmentFile(str(CALL_FT013)) as bam:
        record = next(iter(bam))
        assert record.has_tag("Ma") and not record.has_tag("MA") and ";fire.Q:" in record.get_tag("Ma")
    with pysam.AlignmentFile(str(CALL_FT062)) as bam:
        record = next(iter(bam))
        assert record.has_tag("MA") and record.has_tag("aq") and not record.has_tag("Ma")


def test_ft013_scores_land_on_their_msps():
    msp = _reads(FT013)["read_rev"]["layers"]["msp"]
    by_span = {tuple(iv[:2]): q for iv, q in zip(msp["intervals"], msp["qualities"][0])}
    expected = json.loads((FIX / "fibertools_frame" / "expected.json").read_text())
    for start, end, aq in expected["fixtures"]["ft0.13_addnuc_fire.bam"]["fire"]["read_rev"]:
        assert by_span[(start, end)] == aq


def test_uppercase_ma_fire_group_from_a_fiberhmm_writer():
    """FiberHMM's consensus export copies Ma (fire group included) into MA: the fire group in MA is read too."""
    path = SIMPLE / "fire_then_tag_consensus.bam"
    assert file_fire_status(path)["basis"] == "fire group in reads"
    assert _counts(path) == ((26, 26), (9, 8))


# ── headers stripped: the reads decide ──────────────────────────────────────

@pytest.mark.parametrize("path", [FT013, CALL_FT013, APPLY_FT013])
def test_stripped_ft013_files_are_fire_from_their_fire_groups(path, tmp_path):
    stripped = _strip(path, tmp_path)
    assert not header_has_ft_fire(pysam.AlignmentFile(str(stripped)).header)
    assert file_fire_status(stripped) == {"fire": True, "basis": "fire group in reads"}
    assert _counts(stripped) == _counts(path)


@pytest.mark.parametrize("path", [FT062, CALL_FT062, APPLY_FT062])
def test_stripped_legacy_fire_files_are_fire_from_their_score_pattern(path, tmp_path, monkeypatch):
    monkeypatch.setattr(fire_quality, "MIN_SCORED_MSPS", 20)   # the fixtures have two reads
    stripped = _strip(path, tmp_path)
    status = file_fire_status(stripped)
    assert status["fire"] is True and status["basis"] == "score pattern" and status["zero_share"] >= 0.2
    assert _counts(stripped) == _counts(path)


def test_stripped_fiberhmm_apply_scores_are_not_fire(tmp_path, monkeypatch):
    stripped = _strip(APPLY, tmp_path)
    # Default: too few MSPs in this two-read file -> the header decides -> no ft fire -> not FIRE.
    assert file_fire_status(stripped) == {"fire": False, "basis": "header"}
    fire_quality._CACHE.clear()
    monkeypatch.setattr(fire_quality, "MIN_SCORED_MSPS", 20)
    status = file_fire_status(stripped)
    assert status["fire"] is False and status["basis"] == "score pattern" and status["zero_share"] == 0
    assert _counts(stripped) == ((26, 23), (26, 23))


def test_inconclusive_tiny_file_falls_back_to_the_header_then_not_fire(tmp_path):
    # A two-read legacy FIRE file has fewer than MIN_SCORED_MSPS scores: the header decides.
    assert file_fire_status(FT062) == {"fire": True, "basis": "header"}
    fire_quality._CACHE.clear()
    assert file_fire_status(_strip(FT062, tmp_path)) == {"fire": False, "basis": "header"}


def test_classifier_rules():
    fire_like = [0] * 70 + [245] * 30
    fiberhmm_like = list(range(130, 230))
    assert classify(False, fire_like, {})["fire"] is True
    assert classify(False, fiberhmm_like, {})["fire"] is False
    # Inconclusive (5 % zeros): the header decides.
    mid = [0] * 5 + [200] * 95
    assert classify(False, mid, {})["basis"] == "header"
    assert classify(False, mid, {"PG": [{"ID": "ft.1", "PN": "fibertools-rs", "CL": "ft -t 4 fire a b"}]})["fire"]
    # Data first: a FiberHMM score pattern under an ft fire header is FiberHMM's.
    assert classify(False, fiberhmm_like, {"PG": [{"ID": "ft.1", "PN": "fibertools-rs", "CL": "ft fire a b"}]})[
        "fire"] is False


# ── round-5 cases ────────────────────────────────────────────────────────────

def _drop_fire_group(read):
    """ft 0.13 writes no fire group for a read without FIRE elements: remove it (and its Aq bytes)."""
    if not read.has_tag("Ma"):
        return
    groups = str(read.get_tag("Ma")).split(";")
    kept, aq, cursor, out_aq = [groups[0]], list(read.get_tag("Aq")) if read.has_tag("Aq") else [], 0, []
    for group in groups[1:]:
        head, _, body = group.partition(":")
        n = sum(bool(x) for x in body.split(","))
        width = len(head.split(".", 1)[1]) if "." in head else 0
        if head.startswith("fire"):
            cursor += n * width
            continue
        out_aq.extend(aq[cursor:cursor + n * width])
        cursor += n * width
        kept.append(group)
    read.set_tag("Ma", ";".join(kept), value_type="Z")
    read.set_tag("Aq", array.array("B", out_aq) if out_aq else None)


def test_ft013_read_without_a_fire_group_has_no_fire_elements(tmp_path):
    """Round 5 #2: in a FIRE file, a read with ft 0.13 Ma but no fire group fails the default filter entirely."""
    def only_fwd(read):
        if read.query_name == "read_fwd":
            _drop_fire_group(read)
    out = _rewrite(CALL_FT013, tmp_path / "no_fire_fwd.bam", edit_read=only_fwd)
    assert file_fire_status(out)["fire"] is True
    reads = _reads(out)
    assert _msps(reads["read_fwd"]) == 26 and _msps(reads["read_fwd"], [FIRE_FILTER]) == 0
    assert _msps(reads["read_rev"], [FIRE_FILTER]) == 8
    # No read with a fire group at all: the header (ft fire) makes the file FIRE.
    fire_quality._CACHE.clear()
    out = _rewrite(CALL_FT013, tmp_path / "no_fire_all.bam", edit_read=_drop_fire_group)
    assert file_fire_status(out) == {"fire": True, "basis": "header"}
    assert all(_msps(r, [FIRE_FILTER]) == 0 for r in _reads(out).values())


def test_real_all_0_and_all_128_scores_are_scores(tmp_path):
    for src, value, fire in ((FT062, 128, True), (APPLY, 128, False), (APPLY, 0, False)):
        def flat(read, value=value):
            if read.has_tag("aq"):
                read.set_tag("aq", array.array("B", [value] * len(read.get_tag("aq"))))
        fire_quality._CACHE.clear()
        out = _rewrite(src, tmp_path / f"flat_{value}_{src.name}", edit_read=flat)
        msp = _reads(out)["read_fwd"]["layers"]["msp"]
        assert msp["qualities"][0] == [value] * len(msp["intervals"])
        name = "aq" if fire else "hq"
        assert msp["quality_names"] == [name]
        keep_100 = {"layer": "fire" if fire else "msp", "quality_name": name, "min_value": 100}
        expected = len(msp["intervals"]) if value == 128 else 0
        assert _msps(_reads(out)["read_fwd"], [keep_100]) == expected


def test_score_copy_tolerates_one_bp():
    from services.fire_quality import apply_msp_quality_source
    read = {"id": "r", "intervals": [[0, 10, 10]], "layers": {
        "msp": {"intervals": [[100, 140, 40], [200, 210, 10]], "qualities": None, "quality_names": []},
        "fire": {"intervals": [[101, 140, 39]], "qualities": [[245]], "quality_names": ["q0"]}}}
    apply_msp_quality_source(read, True)
    assert read["layers"]["msp"]["qualities"] == [[245, 0]]


def test_circular_seam_merge_keeps_the_fire_status():
    """Round 5 #3: a read merged across a circular origin keeps its FIRE scores as scores (0 is a score)."""
    from services.circular_genome import merge_compact_reads_by_id
    part = lambda s, e, q: {"id": "r", "intervals": [[s, e, e - s]], "fire_quality_source": "fire",
                            "layers": {"msp": {"intervals": [[s, e, e - s]], "qualities": [[q]],
                                               "quality_names": ["aq"], "quality_source": "fire"}}}
    merged = merge_compact_reads_by_id([part(0, 20, 0), part(50, 70, 0)])[0]
    assert merged["fire_quality_source"] == "fire" and merged["layers"]["msp"]["quality_source"] == "fire"
    assert _msps(merged, [FIRE_FILTER]) == 0


# ── out of scope: loads, follows the same per-file rule ─────────────────────

@pytest.mark.parametrize("edit", ["recall", "merged", "cycle"])
def test_out_of_scope_histories_load(edit, tmp_path):
    if edit == "recall":
        path = SIMPLE / "fire_then_fiberhmm_recall.bam"
    else:
        def header(h, edit=edit):
            pgs = [{"ID": "fiberhmm-apply", "PN": "fiberhmm-apply", "DS": "coord=molecular"},
                   {"ID": "ft.1", "PN": "fibertools-rs", "CL": "ft fire a b"}]
            if edit == "cycle":
                pgs[0]["PP"], pgs[1]["PP"] = "ft.1", "fiberhmm-apply"
            h["PG"] = pgs
        path = _rewrite(APPLY, tmp_path / f"{edit}.bam", edit_header=header)
    status = file_fire_status(path)
    assert status["basis"] in {"fire group in reads", "score pattern", "header"}
    assert all("msp" in r["layers"] for r in _reads(path).values())


# ── diagnostics and the API ──────────────────────────────────────────────────

@pytest.mark.parametrize("path, has_fire", [(p, True) for p, _, _ in FIRE_FILES] + [(p, False) for p, _ in FIBERHMM_FILES])
def test_has_fire_and_its_basis(path, has_fire):
    from services.bam_diagnostics import diagnose_bam_tags
    result = diagnose_bam_tags(str(path), limit=10)
    assert result["has_fire"] is has_fire
    assert result["fire_basis"] in {"fire group in reads", "score pattern", "header"}


def test_fiberhmm_bam_api_payloads_match_3_0_3():
    """A FiberHMM-called BAM's /api/reads/compact and /api/datasets payloads, FIRE filter on and off, equal the
    released 3.0.3's (fire_simple/fiberhmm3.0.0_call.api_3.0.3.json)."""
    from routers.datasets import router as ds_router
    from routers.reads import router as reads_router
    from state.browser_state import BrowserState
    from state.dependencies import get_state
    golden = json.loads((SIMPLE / "fiberhmm3.0.0_call.api_3.0.3.json").read_text())
    for filt in ("on", "off"):
        state = BrowserState(None)
        state.add_dataset("d", str(CALL))
        state.quality_filters = [FIRE_FILTER] if filt == "on" else []
        app = FastAPI()
        app.include_router(reads_router)
        app.include_router(ds_router)
        app.dependency_overrides[get_state] = lambda: state
        client = TestClient(app)
        for layers in ("nuc,tf,fire", "nuc,tf"):
            body = client.get("/api/reads/compact", params=dict(
                dataset_id="d", chrom="chrT", start=0, end=L, spanning="false", include_layers="true",
                layer_names=layers, max_reads=500, sample_seed="x")).json()
            reads = sorted(body["reads"], key=lambda r: (r["id"], r.get("reference_start", 0)))
            assert json.loads(json.dumps(reads, sort_keys=True, default=str)) == golden[f"reads|{filt}|{layers}"]
        dataset = client.get("/api/datasets").json()["datasets"][0]
        dataset = {k: v for k, v in dataset.items()
                   if k not in ("source_identity", "path", "paths", "color", "chemistry_metadata", "sample_keys")}
        assert json.loads(json.dumps(dataset, sort_keys=True, default=str)) == golden[f"dataset|{filt}"]
