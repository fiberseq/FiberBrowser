"""The frame of each MA group: group x header state x read orientation (docs/reference/footprint-tag-frame.md).

FiberBrowser's ``bam_tags.MAGroupFrame`` must decide exactly as FiberHMM's
``fiberhmm.io.annotation_frame.MAGroupFrame`` (FiberHMM 3.0.1): DddA m5C groups (any qualifier) and consensus
family layers molecular; every other group the header rule (``coord=molecular`` anywhere), except that a header
without frame evidence makes a ``.`` group molecular. FiberBrowser keeps its own copy so it reads the same with
FiberHMM 3.0.0; when the installed FiberHMM has ``MAGroupFrame`` the two are compared on the whole matrix.
"""
from __future__ import annotations

import json

import pytest

from services import bam_tags
from services.bam_tags import MAGroupFrame, bam_ma_group_frame

CONSENSUS = "FIBERHMM-CONSENSUS-MA:v1:" + json.dumps(
    {"layers": ["nuc_consensus"], "coordinates": "original_source_call_in_molecular_frame"})

HEADERS = {
    # coord=molecular declared (FiberHMM >= 2.13.2 / 3.x): evidence, molecular.
    "declared": {"HD": {"VN": "1.6"}, "CO": ["fiberhmm:coord=molecular"]},
    "declared_in_pg": {"HD": {"VN": "1.6"}, "PG": [{"ID": "fiberhmm-call", "PN": "fiberhmm-call",
                                                    "DS": "FiberHMM fused apply+recall; coord=molecular"}]},
    # An unmarked FiberHMM writer (<= 2.12): evidence, SEQ.
    "seq_writer": {"HD": {"VN": "1.6"}, "PG": [{"ID": "fiberhmm-apply", "PN": "fiberhmm-apply", "CL": "fiberhmm-apply -i x"}]},
    # A fibertools writer and no declaration: evidence (molecular legacy tags), but MA follows the header: SEQ.
    "fibertools": {"HD": {"VN": "1.6"}, "PG": [{"ID": "ft", "PN": "fibertools", "CL": "ft predict-m6a in.bam out.bam"}]},
    # @PG stripped, or only unrelated programs: no evidence.
    "stripped": {"HD": {"VN": "1.6"}},
    "unrelated": {"HD": {"VN": "1.6"}, "PG": [{"ID": "samtools", "PN": "samtools", "CL": "samtools view -b x"}],
                  "CO": ["FIBERHMM-CHEMISTRY:v1:assay=daf;enzyme=ddda;platform=pacbio;mode=daf"]},
    # A consensus export (its family layers molecular) on an otherwise SEQ-evidence header.
    "consensus_seq": {"HD": {"VN": "1.6"}, "PG": [{"ID": "fiberhmm-apply", "PN": "fiberhmm-apply"}], "CO": [CONSENSUS]},
}

GROUPS = [("nuc", "+"), ("nuc", "."), ("msp", "-"), ("msp", "."), ("tf", "."), ("tf", "+"),
          ("ddda_mcg", "."), ("ddda_mcg", "+"), ("ddda_ucg", "-"), ("ddda_mcg_hemi", "."), ("ddda_mcg_hemi", "+"),
          ("nuc_consensus", "+"), ("nuc_consensus", ".")]


def expected(header_state: str, name: str, strand: str) -> bool:
    if name in {"ddda_mcg", "ddda_ucg", "ddda_mcg_hemi"}:
        return True
    if name == "nuc_consensus" and header_state == "consensus_seq":
        return True
    if header_state in {"declared", "declared_in_pg"}:
        return True
    if header_state in {"seq_writer", "fibertools", "consensus_seq"}:
        return False
    return strand == "."          # no evidence


@pytest.mark.parametrize("state", sorted(HEADERS))
@pytest.mark.parametrize("name,strand", GROUPS)
def test_group_frame_matrix(state, name, strand):
    assert bam_ma_group_frame(HEADERS[state]).is_molecular(name, strand) is expected(state, name, strand)


class _Mapper:
    def query_to_ref(self, query_pos):
        return query_pos


@pytest.mark.parametrize("state", sorted(HEADERS))
@pytest.mark.parametrize("name,strand", GROUPS)
@pytest.mark.parametrize("reverse", [False, True])
def test_parsed_intervals_follow_the_group_frame(state, name, strand, reverse):
    """A 100-base read with one call at query 11-15 (1-based start 11, length 5): flipped on a reverse read only
    when its group is molecular."""
    frame = bam_ma_group_frame(HEADERS[state])
    layers = bam_tags.parse_ma_aq_tags_into_layers(
        f"100;{name}{strand}:11-5", None, _Mapper(), 0, 100, include_qualities=False,
        read_length=100, is_reverse=reverse, tags_are_molecular=frame,
        family_contracts=bam_tags.bam_consensus_contracts(HEADERS[state]))
    flipped = reverse and expected(state, name, strand)
    assert layers[name]["intervals"] == ([[85, 90, 5]] if flipped else [[10, 15, 5]])


def test_bare_flags_read_as_a_header_without_evidence():
    assert bam_tags.ma_group_frame(False).is_molecular("nuc", ".") is True
    assert bam_tags.ma_group_frame(False).is_molecular("nuc", "+") is False
    assert bam_tags.ma_group_frame(True).is_molecular("nuc", "+") is True
    assert bam_tags.ma_group_frame(False).is_molecular("ddda_mcg", "+") is True
    assert bam_tags.MA_ALL_MOLECULAR.is_molecular("nuc", "+") is True


def test_matches_fiberhmm_when_it_has_magroupframe():
    annotation_frame = pytest.importorskip("fiberhmm.io.annotation_frame")
    if not hasattr(annotation_frame, "MAGroupFrame"):
        pytest.skip("the installed FiberHMM predates MAGroupFrame (3.0.1)")
    for state, header in HEADERS.items():
        theirs = annotation_frame.MAGroupFrame(header)
        ours = bam_ma_group_frame(header)
        for name, strand in GROUPS:
            assert ours.is_molecular(name, strand) is bool(theirs.is_molecular(name, strand)), (state, name, strand)


def test_malformed_consensus_contract_keeps_the_header_frame():
    header = {"HD": {"VN": "1.6"}, "SQ": [{"SN": "chr1", "LN": 10000}],
              "CO": ["fiberhmm:coord=molecular", "FIBERHMM-CONSENSUS-MA:v1:{not json"]}
    assert bam_tags.bam_consensus_contracts(header) == {}
    frame = bam_tags.bam_ma_group_frame(header)
    assert frame.header_molecular
    assert frame.is_molecular("nuc", "+")
