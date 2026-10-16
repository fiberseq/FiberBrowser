"""Mock browser state used by the dataset builder/validator.

Contains a synthetic GTF with every gene referenced from any record so that
`_resolve_gene` and the TSS-relative validators succeed during dry-runs.
Add a row here whenever a record references a new gene/locus.
"""
from __future__ import annotations

from types import SimpleNamespace

import pandas as pd


# (gene_name, gene_id, chrom, start, end, strand)
_GENES = [
    # Drosophila — match real dm6 layout the user works with
    ("eve",    "FBgn0000606", "2R",  9_974_000, 9_978_000, "+"),
    ("ftz",    "FBgn0001077", "2R",  9_990_000, 9_993_000, "+"),
    ("hb",     "FBgn0001180", "3R", 12_000_000, 12_005_000, "+"),
    ("sna",    "FBgn0003448", "2L",     15_000,     17_000, "-"),
    ("twi",    "FBgn0003900", "2L",    100_000,    103_000, "+"),
    ("Kr",     "FBgn0001325", "2R",    400_000,    405_000, "-"),
    ("kni",    "FBgn0001320", "3L",  1_000_000,  1_004_000, "+"),
    ("gt",     "FBgn0001150", "X",     200_000,    202_500, "-"),
    ("bcd",    "FBgn0000166", "3R",  3_500_000,  3_502_000, "+"),
    ("nos",    "FBgn0002962", "3R",  4_000_000,  4_002_500, "-"),
    ("dpp",    "FBgn0000490", "2L",     800_000,    806_000, "+"),
    ("wg",     "FBgn0284084", "2L",  7_300_000,  7_310_000, "-"),
    ("en",     "FBgn0000577", "2R",  7_400_000,  7_404_000, "+"),
    ("Ubx",    "FBgn0003944", "3R", 16_700_000, 16_720_000, "-"),
    ("Antp",   "FBgn0260642", "3R",  2_700_000,  2_780_000, "+"),
    ("Abd-B",  "FBgn0000015", "3R", 16_900_000, 16_950_000, "+"),
    # Universal vertebrate genes for cross-genome examples
    ("MYC",    "ENSG00000136997", "chr8",  127_700_000, 127_710_000, "+"),
    ("SOX2",   "ENSG00000181449", "chr3",  181_700_000, 181_715_000, "+"),
    ("GATA1",  "ENSG00000102145", "chrX",   48_640_000,  48_655_000, "+"),
    ("BRCA1",  "ENSG00000012048", "chr17",  43_044_000,  43_125_000, "-"),
    ("TP53",   "ENSG00000141510", "chr17",   7_661_000,   7_690_000, "-"),
    ("HOXA1",  "ENSG00000105991", "chr7",   27_092_000,  27_096_000, "-"),
    ("Pax6",   "MGI:97490",      "chr2",   105_500_000, 105_530_000, "-"),
    ("Klf4",   "MGI:1342287",    "chr4",   55_532_000,  55_540_000, "-"),
]


def make_mock_state(
    *,
    dataset_count: int = 2,
    selected_gene: str | None = None,
    cluster_method: str | None = None,
    cluster_k: int | None = None,
    analysis_sample_seed: int | None = None,
    analysis_sample_count: int | None = None,
    subnucleosomal_threshold: int | None = None,
    accessibility_threshold: float | None = None,
    peaks_locked: bool | None = None,
):
    """Build a SimpleNamespace shaped like BrowserState that the planner reads."""
    transcripts = pd.DataFrame(
        [
            {"gene_name": name, "gene_id": gid, "chrom": chrom,
             "start": start, "end": end, "strand": strand}
            for name, gid, chrom, start, end, strand in _GENES
        ]
    )
    datasets = {}
    dataset_order = []
    presets = [
        ("ds_emb_2_4hr", "Embryo 2-4hr", "bigbed",
         {"tf": True, "nuc": True, "fire": True}),
        ("ds_emb_2_5_3hr", "Embryo 2.5-3hr DAF", "bam",
         {"tf": True, "nuc": True, "fire": True, "deam": True, "m6a": True}),
        ("ds_emb_5_8hr", "Embryo 5-8hr", "bigbed",
         {"tf": True, "nuc": True, "fire": True}),
    ]
    for ds_id, label, layer_type, layers in presets[:dataset_count]:
        datasets[ds_id] = SimpleNamespace(
            label=label,
            layer_type=layer_type,
            data_type=layer_type,
            available_layers=layers,
        )
        dataset_order.append(ds_id)

    relative_gene = None
    relative_tss = None
    if selected_gene:
        for name, gid, chrom, start, end, strand in _GENES:
            if name == selected_gene:
                relative_gene = {
                    "id": gid, "name": name, "chrom": chrom,
                    "start": start, "end": end, "strand": strand,
                    "tss": start if strand != "-" else end - 1,
                }
                relative_tss = relative_gene["tss"]
                break

    return SimpleNamespace(
        gtf_data={"transcripts": transcripts},
        datasets=datasets,
        dataset_order=dataset_order,
        motif_tracks=[],
        selectedGenes=[relative_gene] if relative_gene else [],
        relativeGene=relative_gene,
        relativeTSS=relative_tss,
        cluster_method=cluster_method,
        cluster_k=cluster_k,
        analysis_sample_seed=analysis_sample_seed,
        analysis_sample_count=analysis_sample_count,
        subnucleosomal_threshold=subnucleosomal_threshold,
        accessibility_threshold=accessibility_threshold,
        peaks_locked=peaks_locked,
    )


def gene_by_name(name: str):
    """Helper for record authors — returns the synthetic gene tuple by name."""
    for entry in _GENES:
        if entry[0] == name:
            return entry
    raise KeyError(f"Mock gene '{name}' not registered. Add it to data/copilot_dataset/mock_state.py.")
