"""Gene IDs as /api/genes emits them."""
from __future__ import annotations

import re

_WRAP = re.compile(r"^(?P<id>.+):wrap(?P<shift>-?\d+)$")


def split_wrapped_gene_id(gene_id: str) -> tuple[str, int]:
    """(transcript_id, coordinate shift) for an ID from /api/genes.

    On a circular contig viewed across its origin, /api/genes lists the copy
    past the origin as ``<transcript_id>:wrap<shift>`` with coordinates moved
    by ``shift``; any other ID is the transcript ID itself, unshifted.
    """
    match = _WRAP.match(str(gene_id))
    if not match:
        return str(gene_id), 0
    return match.group("id"), int(match.group("shift"))


def resolve_selected_transcripts(state, gene_ids, chrom=None) -> list[dict]:
    """The loaded GTF's transcripts for IDs from /api/genes, on ``chrom`` only.

    Each gene ID resolves to its transcript's bounds (a wrapped copy shifted);
    a transcript on another chromosome (alias-aware) is left out, so a gene
    selected on chr1 never applies its coordinates to chr2 reads.
    """
    from utils.chrom import normalize_chrom_name

    gtf = getattr(state, "gtf_data", None)
    if not gtf or "transcripts" not in gtf:
        return []
    transcripts = gtf["transcripts"]
    want = normalize_chrom_name(str(chrom)) if chrom else None
    genes = []
    for gene_id in gene_ids or []:
        transcript_id, shift = split_wrapped_gene_id(gene_id)
        matches = transcripts[transcripts["transcript_id"] == transcript_id]
        by_name = False
        if len(matches) == 0:
            # A gene name or gene ID (Copilot and notebooks often pass "eve"):
            # its longest transcript on this chromosome stands for the gene.
            for column in ("gene_name", "gene_id"):
                if column in transcripts:
                    values = transcripts[column].astype(str)
                    matches = transcripts[values == transcript_id]
                    if len(matches) == 0:
                        matches = transcripts[values.str.lower() == transcript_id.lower()]
                    if len(matches):
                        by_name = True
                        break
        if want is not None and len(matches) and "chrom" in matches:
            matches = matches[matches["chrom"].map(lambda c: normalize_chrom_name(str(c)) == want)]
        if len(matches) == 0:
            continue
        if by_name and len(matches) > 1:
            matches = matches.assign(_span=matches["end"] - matches["start"]).sort_values("_span", ascending=False)
        row = matches.iloc[0]
        genes.append({
            "id": gene_id,
            "start": int(row["start"]) + shift,
            "end": int(row["end"]) + shift,
            "strand": str(row["strand"]),
            "name": str(row.get("gene_name", gene_id)),
        })
    return genes
