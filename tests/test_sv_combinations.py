"""Reads split by several SVs at once (fb-n13): each read's genotype string (carrier + / reference − /
not informative), the same classification as the single-SV split (clipped carriers included), complete
reads by default, ``?`` for an SV a read is not informative at with ``partial``; rare patterns in Other."""
from __future__ import annotations

import pytest

from services import snp_scan
from sv_fixtures import CHROM, DEL_LEN, DEL_START, INS_LEN, INS_POS, VIEW, write_sv_bam

M = snp_scan.MINUS
SVS = [{"t": "D", "ref": DEL_START, "len": DEL_LEN, "name": "DEL"}, {"t": "I", "ref": INS_POS, "len": INS_LEN, "name": "INS"}]


@pytest.fixture(scope="module")
def sv_state(tmp_path_factory):
    from state.browser_state import BrowserState
    bam = write_sv_bam(tmp_path_factory.mktemp("svcombo") / "sv.bam")
    state = BrowserState(None, None, None, None)
    state.add_dataset("sv", str(bam), label="sv")
    return state


def _groups(res):
    return {g["label"]: g["count"] for g in res["groups"] if g["count"]}


def _payload(state, **extra):
    from services.variants_endpoint import alleles_payload
    body = {"dataset_id": "sv", "chrom": CHROM, "start": 6_000, "end": 18_000, "svs": SVS, "min_reads": 1, "min_fraction": 0.0, **extra}
    return alleles_payload(state, body)


def test_two_svs_group_complete_reads_by_genotype(sv_state):
    res = _payload(sv_state)
    assert _groups(res) == {f"DEL+ · INS+": 5, f"DEL+ · INS{M}": 5, f"DEL{M} · INS+": 4, f"DEL{M} · INS{M}": 4,
                            "Not informative": 6}
    assert res["svs"] == [f"D:{DEL_START}:{DEL_LEN}", f"I:{INS_POS}:{INS_LEN}"] and res["snps"] == []
    by_read = res["assignments"]
    label = {g["id"]: g["label"] for g in res["groups"]}
    assert label[by_read["sv/del0/ccs"]] == "DEL+ · INS+"
    assert label[by_read["sv/del7/ccs"]] == f"DEL+ · INS{M}"
    # A split-read (clipped) deletion carrier is a carrier here too; its primary never reaches the insertion.
    assert label[by_read["sv/clip1/ccs"]] == "Not informative"


def test_partial_shows_question_marks_for_uninformative_svs(sv_state):
    res = _payload(sv_state, partial=True)
    groups = _groups(res)
    assert groups["DEL+ · INS?"] == 3            # the clipped carriers: no call at the insertion
    assert groups[f"DEL? · INS{M}"] == 1         # ni1 starts after the deletion, spans the insertion
    assert groups["Not informative"] == 2        # ni0, ni2: informative at neither
    assert sum(groups.values()) == res["n_reads"]


def test_rare_patterns_merge_into_other(sv_state):
    res = _payload(sv_state, min_reads=5)
    groups = _groups(res)
    assert groups["DEL+ · INS+"] == 5 and groups[f"DEL+ · INS{M}"] == 5
    assert groups["Other (2 rare)"] == 8


def test_bad_sv_requests_are_refused(sv_state):
    from services.variants_endpoint import VariantsRequestError
    with pytest.raises(VariantsRequestError):
        _payload(sv_state, svs=[{"t": "X", "ref": 1, "len": 2}])
    with pytest.raises(VariantsRequestError):
        _payload(sv_state, svs=SVS * 3)


def test_genotypes_at_distant_svs_and_snps():
    """Distant SVs: most reads reach only one, so complete genotypes are rare and partial ones say which
    SV a read saw; a SNP column reads as its position and base."""
    cols = [{"id": "100:snv:A/G", "name": "101", "kind": "snv"},
            {"id": "I:5000:9000", "name": "roo", "kind": "sv"}, {"id": "I:90000:1900", "name": "hobo", "kind": "sv"}]
    names = ["a", "b", "c", "d", "e"]
    letters = [["G", "+", None], ["A", "-", None], [None, None, "+"], ["G", "+", "-"], [None, None, None]]
    strict = snp_scan.genotype_groups(names, letters, cols, min_reads=1, min_fraction=0)
    assert _groups(strict) == {f"101 G · roo+ · hobo{M}": 1, "Not informative": 4}
    loose = snp_scan.genotype_groups(names, letters, cols, partial=True, min_reads=1, min_fraction=0)
    assert _groups(loose) == {"101 G · roo+ · hobo?": 1, f"101 A · roo{M} · hobo?": 1, "101 ? · roo? · hobo+": 1,
                              f"101 G · roo+ · hobo{M}": 1, "Not informative": 1}
    assert loose["covering"] == 1 and loose["placed"] == 4
