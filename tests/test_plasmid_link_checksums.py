"""A BAM contig whose @SQ M5 contradicts the other evidence is never a verified map link.

Reproductions from the 29 Sep review: a referenced FASTA replaced since the
alignment, and a contig differing from the map outside the sampled reads (its
MD tags agree, its checksum does not), were both linked as verified.
"""
from __future__ import annotations

import hashlib

from test_plasmid_reconcile import L, _rot, _seq, load_map, state, write_bam, write_fasta, write_map  # noqa: F401


def test_a_replaced_reference_fasta_does_not_verify_a_contradicting_m5(tmp_path):
    from services.plasmid_reconcile import bam_contig_evidence, match_contig

    seq = _seq(204)
    fasta = write_fasta(tmp_path / "replaced.fa", "checksumContig", seq)  # now holds the map
    bam = write_bam(tmp_path / "different.bam", "checksumContig", _seq(205), m5=True, fasta=fasta, md=False)
    evidence = bam_contig_evidence(bam)[0]
    assert evidence.m5 != hashlib.md5(seq.encode()).hexdigest()

    result = match_contig("checksumMap", seq, evidence)

    assert result["match"] is False
    assert "replaced.fa" in result["problem"]["message"]


def test_md_tags_do_not_override_a_contradicting_m5(tmp_path):
    from services.plasmid_reconcile import bam_contig_evidence, match_contig

    seq = _seq(204)
    changed = seq[:-1] + ("A" if seq[-1] != "A" else "C")  # differs at the last base, outside every read
    bam = write_bam(tmp_path / "mutation.bam", "mdContig", changed, m5=True)

    result = match_contig("checksumMap", seq, bam_contig_evidence(bam)[0])

    assert result["match"] is False
    problem = result["problem"]
    assert problem["kind"] == "checksum" and problem["can_confirm"] and problem["suggested_offset"] == 0
    assert "M5" in problem["message"]


def test_a_contradicting_m5_blocks_the_automatic_link_but_link_anyway_works(tmp_path, state):
    import asyncio

    from routers.genome import confirm_plasmid_link_endpoint

    seq = _seq(206)
    load_map(state, write_map(tmp_path / "pSum.gb", "pSum", seq))
    changed = seq[:-1] + ("A" if seq[-1] != "A" else "C")
    ds = state.add_dataset("changed", write_bam(tmp_path / "changed.bam", "pSum_seq", changed, m5=True))

    assert not ds.plasmid_report.get("links")
    assert ds.plasmid_report["problems"][0]["kind"] == "checksum"
    assert not (state.plasmid_metadata["pSum"].get("links") or [])

    result = asyncio.run(confirm_plasmid_link_endpoint(chrom="pSum", dataset_id="changed", contig="pSum_seq",
                                                       offset=0, state=state))
    assert result["success"] and result["link"]["verified"] is False


def test_a_rotated_contig_with_a_consistent_m5_is_still_verified(tmp_path, state):
    seq = _seq(207)
    load_map(state, write_map(tmp_path / "pOk.gb", "pOk", seq))
    rotated = _rot(seq, 321)
    fasta = write_fasta(tmp_path / "pOk_rot.fa", "pOk_rot", rotated)

    by_reads = state.add_dataset("reads", write_bam(tmp_path / "reads.bam", "pOk_rot", rotated, m5=True))
    by_fasta = state.add_dataset("fasta", write_bam(tmp_path / "fasta.bam", "pOk_rot", rotated, m5=True,
                                                    fasta=fasta, md=False))

    for ds, method in ((by_reads, "reads"), (by_fasta, "reference")):
        link = ds.plasmid_report["links"][0]
        assert (link["offset"], link["method"], link["verified"]) == (321, method, True)


def test_a_header_declaration_contradicting_m5_is_not_linked(tmp_path, state):
    seq = _seq(208)
    write_map(tmp_path / "pDec.gb", "pDec", seq)
    md5 = hashlib.md5(seq.encode()).hexdigest()
    other = _seq(209)
    bam = write_bam(tmp_path / "decl.bam", "pDec_aln", other, m5=True, md=False,
                    comments=[f"FIBERHMM-REFERENCE:v1:map=pDec.gb;contig=pDec_aln;circular=1;map_md5={md5}"])

    ds = state.add_dataset("decl", bam)

    assert not ds.plasmid_report.get("links")
    assert ds.plasmid_report["problems"][0]["kind"] == "checksum"
