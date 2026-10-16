"""Frame of the legacy ns/nl/as/al tags from @PG provenance (docs/reference/footprint-tag-frame.md).

The last footprint writer on the @PG PP chain decides, not header order; producer identity comes from PN, then the
ID base, then the CL program.
"""
from __future__ import annotations

import itertools

import pytest

from services import bam_tags
from test_fibertools_frame_fixtures import EXPECTED, FIXTURES, _copy_with_header, _intervals, _render

REPORT = bam_tags.legacy_tag_frame_report
FT_REV_NUCS = EXPECTED["fixtures"]["ft0.6.2_addnuc_fire.bam"]["nuc"]["read_rev"]

FT = {"ID": "ft.1", "PN": "fibertools-rs", "CL": "ft predict-m6a in.bam out.bam"}
FHMM_OLD = {"ID": "fiberhmm-apply", "PN": "fiberhmm-apply", "CL": "fiberhmm-apply -i in.bam -o out.bam"}
FHMM_NEW = {"ID": "fiberhmm-call", "PN": "fiberhmm-call", "CL": "fiberhmm-call -i in.bam -o out.bam",
            "DS": "FiberHMM fused apply+recall; coord=molecular"}
SORT = {"ID": "samtools", "PN": "samtools", "CL": "samtools sort -o out.bam"}


def _chain(*records):
    """Link records into one PP chain in the order given (the order they ran)."""
    out = []
    for i, rec in enumerate(records):
        rec = dict(rec)
        rec.pop("PP", None)
        if i:
            rec["PP"] = out[-1]["ID"]
        out.append(rec)
    return out


def _frame(pgs, co=()):
    return REPORT({"PG": list(pgs), "CO": list(co)})["frame"]


# ------------------------------------------------------------------ chain order, not header order

@pytest.mark.parametrize("ran", [(FT, FHMM_OLD, SORT), (FHMM_OLD, FT, SORT)])
def test_every_header_order_of_one_chain_gives_the_same_frame(ran):
    chain = _chain(*ran)
    want = "seq" if ran[1] is FHMM_OLD else "molecular"   # the later writer decides
    for order in itertools.permutations(chain):
        assert _frame(order) == want, [r["ID"] for r in order]


def test_reordered_header_on_the_real_fixture_keeps_reverse_nucleosomes(tmp_path):
    # Codex round 10: fibertools is the final writer but its record is serialised before its FiberHMM ancestor.
    def edit(header):
        header["PG"] = [
            {"ID": "ft.renamed", "PN": "fibertools-rs", "PP": "fiberhmm-call.renamed", "CL": "ft fire prior.bam calls.bam"},
            {"ID": "fiberhmm-call.renamed", "PN": "fiberhmm-call", "CL": "fiberhmm-call raw.bam"},
            {"ID": "samtools.1", "PN": "samtools", "PP": "ft.renamed", "CL": "samtools sort calls.bam"},
        ]
    path = _copy_with_header(FIXTURES / "ft0.6.2_addnuc_fire.bam", tmp_path / "reordered.bam", edit_header=edit)
    assert _intervals(_render(path)["read_rev"], "nuc") == FT_REV_NUCS


def test_unmarked_fiberhmm_writer_after_fibertools_in_the_chain_wins_even_when_listed_first():
    pgs = _chain(FT, FHMM_OLD)
    assert _frame([pgs[1], pgs[0]]) == "seq"


def test_header_order_is_the_chain_only_when_no_record_has_pp():
    assert _frame([FT, FHMM_OLD]) == "seq"
    assert _frame([FHMM_OLD, FT]) == "molecular"
    # One PP anywhere switches to ancestry: two unlinked roots are two chains that disagree.
    report = REPORT({"PG": [FHMM_OLD, FT, dict(SORT, PP="ft.1")]})
    assert report["ambiguous"] and report["votes"] == {"molecular": 1, "seq": 1}


# ------------------------------------------------------------------ producer identity

@pytest.mark.parametrize("edit", ["missing_pn", "samtools_id_mentions_fiberhmm"])
def test_identity_edits_keep_the_real_fixture_molecular(tmp_path, edit):
    def change(header):
        if edit == "missing_pn":
            for pg in header["PG"]:
                pg.pop("PN", None)
        else:
            header["PG"].append({"ID": "samtools-fiberhmm-output", "PN": "samtools", "PP": "ft.2",
                                 "CL": "samtools sort calls.bam"})
    path = _copy_with_header(FIXTURES / "ft0.6.2_addnuc_fire.bam", tmp_path / "edited.bam", edit_header=change)
    assert _intervals(_render(path)["read_rev"], "nuc") == FT_REV_NUCS


@pytest.mark.parametrize("record,family", [
    ({"ID": "ft.1", "PN": "fibertools-rs"}, "fibertools"),
    ({"ID": "ft.1-61483E4"}, "fibertools"),                                  # samtools-merged, no PN
    ({"ID": "x", "CL": "/opt/bin/ft add-nuc in.bam out.bam"}, "fibertools"),
    ({"ID": "fiberhmm-call-75E22241"}, "fiberhmm"),
    ({"ID": "fiberhmm-call.2", "PN": "fiberhmm-call"}, "fiberhmm"),
    ({"ID": "samtools-fiberhmm-output", "PN": "samtools"}, None),              # PN beats a contradictory ID
    ({"ID": "ft.1", "PN": "samtools"}, None),
    ({"ID": "samtools", "PN": "samtools", "CL": "samtools sort -o ~/work/x.bam"}, None),
    ({"ID": "whatever", "CL": "python pipeline.py fiberhmm-call"}, None),
])
def test_producer_identity(record, family):
    assert bam_tags._pg_family(record) == family


@pytest.mark.parametrize("cl,writes", [
    ("ft predict-m6a in.bam out.bam", True), ("ft -t 8 m6a in.bam out.bam", True),
    ("ft predict -m 254 in.bam out.bam", True), ("ft add in.bam out.bam", True),
    ("ft add-nuc --min-ml-score 225 in.cram out.bam", True), ("ft fire - -", True),
    ("fibertools-rs fiber-hmm in.bam out.bam", True),
    ("ft extract --all out.tsv in.bam", False), ("ft convert-tags in.bam out.bam", False),
    ("ft pileup in.bam", False), ("ft clear-kinetics in.bam out.bam", False),
])
def test_fibertools_footprint_writers(cl, writes):
    assert (bam_tags._pg_writer_frame({"ID": "ft.1", "PN": "fibertools-rs", "CL": cl}, False) == "molecular") is writes


def test_fiberhmm_passthrough_programs_do_not_reset_the_frame():
    # tag-m5c/dedup/... keep ns/nl as they found them; only apply/call/recall-* write the legacy tags.
    for pn in ("fiberhmm-tag-m5c", "fiberhmm-dedup", "fiberhmm-merge", "fiberhmm-pair", "fiberhmm-tag-consensus",
               "fiberhmm-strand-rescue-annotate", "fiberhmm-pipeline", "fiberhmm-call-m5c"):
        assert _frame(_chain(FT, {"ID": pn, "PN": pn, "CL": f"{pn} -i in.bam -o out.bam"})) == "molecular", pn
    for pn in sorted(bam_tags.FIBERHMM_FOOTPRINT_PROGRAMS):
        assert _frame(_chain(FT, {"ID": pn, "PN": pn, "CL": f"{pn} -i in.bam"})) == "seq", pn


def test_fiberhmm_writer_frame_follows_its_own_or_the_header_declaration():
    assert _frame(_chain(FT, FHMM_NEW)) == "molecular"
    assert _frame(_chain(FT, FHMM_OLD), co=["fiberhmm:coord=molecular"]) == "molecular"
    # PN "fiberhmm" with a FiberHMM writer as the CL program (older headers)
    assert _frame(_chain(FT, {"ID": "fiberhmm", "PN": "fiberhmm", "CL": "fiberhmm-apply -i in.bam"})) == "seq"


# ------------------------------------------------------------------ malformed / merged histories

def test_pp_cycles_terminate():
    pgs = [dict(FT, PP="fiberhmm-apply"), dict(FHMM_OLD, PP="ft.1")]
    assert REPORT({"PG": pgs})["frame"] in ("seq", "molecular")
    assert _frame([dict(SORT, PP="samtools")]) == "seq"     # self-parent


def test_pp_to_a_missing_id_ends_the_chain():
    assert _frame([FT, dict(SORT, PP="not-there")]) == "molecular"    # FT is its own chain
    assert _frame([dict(FT, PP="gone"), dict(SORT, PP="ft.1")]) == "molecular"


def test_duplicate_ids_link_to_the_nearest_preceding_record():
    pgs = [dict(FHMM_OLD, ID="dup"), dict(SORT, PP="dup"), dict(FT, ID="dup"), dict(SORT, ID="s2", PP="dup")]
    report = REPORT({"PG": pgs})
    assert report["votes"] == {"molecular": 1, "seq": 1} and report["ambiguous"]


def test_merged_branches_that_disagree_are_ambiguous():
    old_branch = _chain(dict(FHMM_OLD, ID="fiberhmm-apply"), dict(SORT, ID="samtools"))
    ft_branch = _chain(dict(FT, ID="ft.1-570F7E82"), dict(SORT, ID="samtools-39D564CF"))
    report = REPORT({"PG": old_branch + ft_branch})
    assert report["ambiguous"] and report["frame"] == "seq" and report["source"] == "majority"
    two_ft = ft_branch + _chain(dict(FT, ID="ft.1-60F6C071"), dict(SORT, ID="samtools-11AAC8BA"))
    report = REPORT({"PG": old_branch + two_ft})
    assert report["ambiguous"] and report["frame"] == "molecular"
    # An @CO declaration covers every FiberHMM writer, so the branches then agree.
    report = REPORT({"PG": old_branch + ft_branch, "CO": ["fiberhmm:coord=molecular"]})
    assert report["frame"] == "molecular" and not report["ambiguous"]
    # A declaration only in one branch's own record: still a conflict, resolved to the declared frame.
    new_branch = _chain(FHMM_NEW, dict(SORT, ID="samtools-7BAE9814"))
    report = REPORT({"PG": old_branch + new_branch})
    assert report["ambiguous"] and report["frame"] == "molecular" and report["source"] == "declared"


def test_no_writer_uses_the_declaration_or_the_seq_default():
    assert REPORT({"PG": [SORT]}) == {"frame": "seq", "source": "default", "ambiguous": False,
                                      "votes": {"molecular": 0, "seq": 0}, "writers": [], "chains": 1}
    assert REPORT({"CO": ["fiberhmm:coord=molecular"]})["frame"] == "molecular"
    assert REPORT(None)["frame"] == "seq"


def test_diagnosis_reports_the_frame_and_warns_on_ambiguity(tmp_path):
    from services.files_endpoint import diagnose_bam_payload

    result = diagnose_bam_payload(None, bam_path=str(FIXTURES / "ft0.6.2_addnuc_fire.bam"), chrom="chrT", limit=5)
    assert result["legacy_tag_frame"]["frame"] == "molecular"
    assert result["legacy_tag_frame"]["writers"] == [{"id": "ft.2", "frame": "molecular"}]
    assert not any("disagree" in r for r in result["recommendations"])

    def merge(header):
        header["PG"] += _chain(dict(FHMM_OLD, ID="fiberhmm-apply"), dict(SORT, ID="samtools-merged"))
    path = _copy_with_header(FIXTURES / "ft0.6.2_addnuc_fire.bam", tmp_path / "merged.bam", edit_header=merge)
    result = diagnose_bam_payload(None, bam_path=str(path), chrom="chrT", limit=5)
    assert result["legacy_tag_frame"]["ambiguous"] is True
    assert any("disagree" in r for r in result["recommendations"])
