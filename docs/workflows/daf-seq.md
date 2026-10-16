# Workflow: DAF-seq

[← Docs index](../index.md) · [← README](../../README.md)

DAF-seq marks accessible DNA by deamination (C→T on one strand, G→A on the
other) instead of m6A methylation. FiberBrowser detects DAF data, draws the
deamination marks as their own layer, and lets you view and analyse each strand
separately. The bundled demo used by the [user guide](../guide.md) is a
DddA-seq dataset.

## 1. From reads to a viewable BAM

1. Align the reads and keep an `MD` tag (for example `minimap2 --MD`), then
   sort and index the BAM. For a plasmid reference, use
   `scripts/align_plasmid_reads.py` ([Plasmids](plasmids.md)).
2. Call footprints with [FiberHMM](https://github.com/fiberseq/FiberHMM).
   Its output BAM carries the nucleosome, accessible and TF-footprint calls
   (`MA`/`AQ`, or the legacy `ns/nl` and `as/al` tags). See the FiberHMM
   documentation for the DAF-seq options.

A plain aligned BAM also loads: it shows reads and deamination marks, but no
footprints until FiberHMM has called them.

## 2. Load it

Click **Open** and pick the BAM (or pass `-b file.bam`). Add the gene
annotation and the reference FASTA the same way (`-g`, `-f`). FiberBrowser
inspects the tags and adds one toggle per layer to the **Layers** group of the
toolbar.

## 3. Layers

| Toggle | What it shows | Source |
|--------|---------------|--------|
| **Nuc** / **FP** | Nucleosome footprints (**FP** when the file has no separate TF layer) | `nuc` in `MA`, or `ns`/`nl` |
| **TF** | TF-sized footprints | `tf` in `MA` |
| **Accessibility** | Accessible (MSP/FIRE) intervals | `msp` in `MA`, or `as`/`al` |
| **Deamination** | Individual deamination events | `MM`/`ML` deamination calls, IUPAC `R`/`Y` bases in the read, or C→T / G→A mismatches against the reference |
| **5mC** | 5mC marks | `MM`/`ML` 5mC calls, or a `_m5c.bb` BigBed |
| **DddA mCG** | Methylated CpG spans inferred from DddA deamination | `ddda_mcg` in `MA` |

Only layers present in the file appear. Mismatch-based deamination needs the
`MD` tag. Clustering, sorting, peaks, labeling and the analysis panels work the
same as for m6A fiber-seq data.

## 4. Strands

DAF-seq reads come from one of two strands: C→T (CT) or G→A (GA). A DAF-seq
panel has a strand chip in its header (**Both strands** ▾). Its menu:

| Item | Result |
|------|--------|
| **Both strands** | All reads (default). |
| **CT strand only (C→T reads)** | Only CT reads in this panel. |
| **GA strand only (G→A reads)** | Only GA reads in this panel. |
| **Split: CT \| GA side by side** | This panel shows CT; a copy next to it shows GA. Both follow the main view. |

Everything computed from a panel's reads follows its strand: clusters, peaks,
footprint counts and the metaprofile. The chip appears on datasets recognised
as DAF-seq: those whose assay type is DddA or DddB, or, when no assay type is
set, any dataset with a **Deamination** layer.

In the **Footprints** panel, **Compare strands** (or **Compare strands and
datasets** with several datasets loaded) shows how each footprint class looks on
the CT and GA strands, and can show one strand's reads so you quantify the
strand that fits best. See [Footprint classes](footprint-classes.md).

From Python, `get_deam_by_strand(strand, ...)` returns deamination positions
for one strand (`'CT'`/`'Y'` or `'GA'`/`'R'`); see the
[Jupyter / Python API](../jupyter-api.md).

## Missing layers

FiberHMM output BAMs often tag only the mapped, full-length molecules, which can
be a small fraction of the file. Layer detection samples reads across the
genome and then runs a sparse-tag pass to find these tags even when they are
rare. FiberHMM also writes an `@CO MA-TYPES:v1:...` header line that lists the
layers up front.

If a layer still looks absent:

1. Check that the tags exist:
   ```bash
   samtools view recalled.bam | grep -m1 -oE '(ns|nl|as|al|MA):'
   ```
   No output means the file has no footprint tags; re-run the FiberHMM call.
2. If the tags exist, reload the dataset, or start the browser with
   `FIBERBROWSER_BAM_DIAGNOSTICS=1` to log what layer detection finds.

Seeing **Deamination** but no footprint layers usually means the reads you are
looking at carry no FiberHMM tags. Deamination comes from the read sequence or
the `MM`/`ML` tags, not from FiberHMM's footprint tags.
