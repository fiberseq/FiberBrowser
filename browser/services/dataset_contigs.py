"""Which datasets have reads on a contig (e.g. a plasmid just loaded)."""
from __future__ import annotations

from utils.chrom import resolve_reference_name


def _file_contigs(path: str) -> set[str]:
    lower = path.lower()
    if lower.endswith((".bb", ".bigbed")):
        from services.remote_sources.opening import open_bigwig
        handle = open_bigwig(path)
        if handle is None:  # unopenable file: no contigs
            return set()
        try:
            return set((handle.chroms() or {}).keys())
        finally:
            handle.close()
    from services.remote_sources.opening import open_alignment_file
    with open_alignment_file(path, "rb") as bam:
        return set(bam.references)


def dataset_contigs(dataset) -> set[str]:
    """Contig names in a dataset's file headers (cached on the dataset)."""
    cached = getattr(dataset, "_header_contigs", None)
    if cached is not None:
        return cached
    names: set[str] = set()
    for path in getattr(dataset, "paths", None) or [dataset.path]:
        try:
            names |= _file_contigs(path)
        except Exception:
            continue
    try:
        dataset._header_contigs = names
    except Exception:
        pass
    return names


def datasets_with_contig(state, chrom: str) -> list[str]:
    """Datasets with reads on ``chrom``: a contig of that name (chr1 / 1, ...), or one
    linked to it in this workspace (a plasmid map for a BAM contig of another name);
    a contig linked to another chromosome (another frame) does not count."""
    from services.plasmid_reconcile import contig_links
    return [ds_id for ds_id, ds in (getattr(state, "datasets", {}) or {}).items()
            if resolve_reference_name(chrom, dataset_contigs(ds),
                                      links=contig_links(state, dataset_id=ds_id)) is not None]
