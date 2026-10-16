"""Stripping @PG must not mirror reverse reads (3.0.0 release).

FiberHMM 3.0 declares coord=molecular only in its @PG DS. A pipeline that drops or rewrites @PG (or @PG and @CO)
used to make FiberBrowser read the file's MA and ns/nl in SEQ frame, so reverse reads were drawn mirrored. Spec MA
(FiberHMM >= 2.13.2 writes every type with the "." strand) is molecular whatever the header says; a
FIBERHMM-CHEMISTRY declaration (@CO, kept when @PG goes) decides the legacy tags; with no evidence at all, a read's
spec MA decides its legacy tags too. Historical SEQ-frame MA ("+" strand, FiberHMM <= 2.12) still reads as SEQ.
"""
from pathlib import Path

import pysam
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services.bam_tags import (
    legacy_tag_frame_report, ma_footprint_groups_are_molecular, ma_group_is_molecular,
    read_legacy_tags_are_molecular,
)

DEMO = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "napa_ddda.bam"
REGION = ("chr19", 47514000, 47520000)


def test_dot_footprint_groups_mark_a_molecular_read():
    assert ma_footprint_groups_are_molecular("4504;nuc.QQQ:37-149,241-136;msp.:1-36;tf.QQQ:300-20")
    assert ma_footprint_groups_are_molecular("100;msp.:1-36")
    assert not ma_footprint_groups_are_molecular("4365;nuc+QQQ:26-1958,2072-124;msp+:1-25")   # FiberHMM <= 2.13.1
    # tag-m5c appends "." groups to historical reads: they say nothing about the footprints' frame.
    assert not ma_footprint_groups_are_molecular("4365;nuc+QQQ:26-1958;msp+:1-25;ddda_mcg.:30-2")
    assert not ma_footprint_groups_are_molecular("100")
    assert not ma_footprint_groups_are_molecular(None)
    assert ma_group_is_molecular(".", False) and not ma_group_is_molecular("+", False) and ma_group_is_molecular("+", True)


def test_chemistry_never_decides_the_legacy_frame():
    """merge and pair add FIBERHMM-CHEMISTRY while passing historical reads through (FiberHMM's rule)."""
    chem = "FIBERHMM-CHEMISTRY:v1:assay=daf;enzyme=ddda;platform=pacbio;mode=daf"
    report = legacy_tag_frame_report({"CO": [chem]})
    assert (report["frame"], report["source"]) == ("seq", "default")
    assert (legacy_tag_frame_report({})["frame"], legacy_tag_frame_report({})["source"]) == ("seq", "default")
    old = {"PG": [{"ID": "fiberhmm-apply", "PN": "fiberhmm-apply", "VN": "1.0"}]}
    assert legacy_tag_frame_report(old)["frame"] == "seq"
    assert legacy_tag_frame_report({**old, "CO": [chem]})["frame"] == "seq"


class _Read:
    def __init__(self, ma):
        self._ma = ma

    def has_tag(self, tag):
        return tag == "MA" and self._ma is not None

    def get_tag(self, tag):
        return self._ma


def test_a_read_spec_ma_decides_its_legacy_tags_only_without_header_evidence():
    spec, old = _Read("10;nuc.Q:1-5"), _Read("10;nuc+Q:1-5;ddda_mcg.:1-2")
    assert read_legacy_tags_are_molecular(spec, (False, True))          # no evidence: the read's MA decides
    assert not read_legacy_tags_are_molecular(old, (False, True))
    assert not read_legacy_tags_are_molecular(_Read(None), (False, True))
    assert not read_legacy_tags_are_molecular(spec, (False, False))     # the header said SEQ: kept
    assert read_legacy_tags_are_molecular(old, (True, False))


def _slice(tmp_path, name, header, edit=None, n=20):
    src = pysam.AlignmentFile(str(DEMO))
    path = tmp_path / f"{name}.bam"
    kept = {True: 0, False: 0}
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for read in src.fetch(*REGION):
            if not read.has_tag("MA") or kept[read.is_reverse] >= n:
                continue
            kept[read.is_reverse] += 1
            record = pysam.AlignedSegment.from_dict(read.to_dict(), out.header)
            if edit:
                edit(record)
            out.write(record)
    pysam.index(str(path))
    return str(path)


def _load(path):
    from routers.reads import router
    from state.browser_state import BrowserState
    from state.dependencies import get_state
    state = BrowserState(None)
    state.add_dataset("d", path)
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_state] = lambda: state
    body = TestClient(app).get("/api/reads/compact", params=dict(
        dataset_id="d", chrom=REGION[0], start=REGION[1], end=REGION[2], include_layers="true", max_reads=1000)).json()
    return {read["id"]: (read["intervals"], (read.get("layers") or {}).get("tf", {}).get("intervals"))
            for read in body["reads"]}


def _base_header():
    """The demo header without any frame declaration (its @PG lines, if any, and coord=molecular @CO lines);
    FIBERHMM-CHEMISTRY stays."""
    header = pysam.AlignmentFile(str(DEMO)).header.to_dict()
    header.pop("PG", None)
    header["CO"] = [c for c in header.get("CO", []) if "coord=molecular" not in c.lower()]
    assert any(c.startswith("FIBERHMM-CHEMISTRY:v1:") for c in header["CO"])
    return header


@pytest.mark.skipif(not DEMO.exists(), reason="demo BAM not present")
def test_reverse_reads_are_not_mirrored_without_pg(tmp_path):
    base = _base_header()
    reverse = {r.query_name for r in pysam.AlignmentFile(str(DEMO)).fetch(*REGION) if r.is_reverse}
    # The producer's own declaration: what the file means.
    declared = _load(_slice(tmp_path, "declared", {**base, "CO": [*base["CO"], "fiberhmm:coord=molecular"]}))
    # As fiberhmm-call 3.0 writes it: the declaration in @PG DS only.
    pg = {**base, "PG": [{"ID": "fiberhmm-call", "PN": "fiberhmm-call", "VN": "3.0.0",
                          "DS": "FiberHMM fused apply+recall; coord=molecular"}]}
    with_pg = _load(_slice(tmp_path, "with_pg", pg))
    no_pg = _load(_slice(tmp_path, "no_pg", base))                                   # @PG stripped
    bare = _load(_slice(tmp_path, "bare", {k: v for k, v in base.items() if k != "CO"}))  # @PG and @CO stripped
    rev_ids = [i for i in declared if i in reverse]
    assert len(rev_ids) >= 10
    for rid in rev_ids:
        assert with_pg[rid] == declared[rid]
        assert no_pg[rid] == declared[rid]
        assert bare[rid] == declared[rid]


@pytest.mark.skipif(not DEMO.exists(), reason="demo BAM not present")
def test_historical_seq_frame_ma_without_a_declaration_stays_seq(tmp_path):
    """FiberHMM <= 2.12 wrote "+"-strand MA in SEQ frame and declared nothing: still read as SEQ, so its reverse
    reads differ from the same strings read as molecular."""
    bare = {k: v for k, v in _base_header().items() if k != "CO"}

    def old_strand(record):
        record.set_tag("MA", record.get_tag("MA").replace(".", "+"), "Z")
    reverse = {r.query_name for r in pysam.AlignmentFile(str(DEMO)).fetch(*REGION) if r.is_reverse}
    seq = _load(_slice(tmp_path, "old_bare", bare, old_strand))
    marked = _load(_slice(tmp_path, "old_marked", {**bare, "CO": ["fiberhmm:coord=molecular"]}, old_strand))
    rev_ids = [i for i in seq if i in reverse]
    assert rev_ids
    assert any(seq[rid][1] != marked[rid][1] for rid in rev_ids)
