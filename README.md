# FiberBrowser

An interactive genome browser for Fiber-seq and DAF-seq data at single-molecule
resolution. Each row is one DNA molecule, drawn with its nucleosomes,
transcription-factor footprints, accessible patches and base modifications.
You can cluster, sort and filter molecules by their footprints, measure how
often a footprint is occupied and which footprints occur together, split reads
by haplotype or structural-variant allele, and export figures and the data
behind them.

FiberBrowser shows the footprints called by
[FiberHMM](https://github.com/fiberseq/FiberHMM). FiberBrowser 3.0 is released
together with FiberHMM 3.0 and installs it.

**Documentation:** [docs/index.md](https://github.com/fiberseq/FiberBrowser/blob/main/docs/index.md)
· [User guide](https://github.com/fiberseq/FiberBrowser/blob/main/docs/guide.md)
· [Tutorial](https://github.com/fiberseq/FiberBrowser/blob/main/docs/tutorial.md)
· [Reference](https://github.com/fiberseq/FiberBrowser/blob/main/docs/reference.md)
· [Changelog](https://github.com/fiberseq/FiberBrowser/blob/main/CHANGELOG.md)

## Install

| You want | Do this |
|----------|---------|
| The Mac app (Apple silicon, macOS 14+) | Download `FiberBrowser-<version>-arm64.dmg` from [Releases](https://github.com/fiberseq/FiberBrowser/releases) and drag it to Applications. It bundles Python, FiberHMM 3, minimap2 and BLAST+. |
| The Windows app (Windows 10 2004+ or 11, x64) | Run `FiberBrowser-<version>-Setup.exe` from [Releases](https://github.com/fiberseq/FiberBrowser/releases). It runs in WSL 2 and opens in its own window. |
| The `fiberbrowser` command (macOS, Linux, or WSL; Python 3.10+) | `pipx install "fiberbrowser[app]"` (or `python3 -m pip install "fiberbrowser[app]"`). This installs FiberHMM 3 (`fiberhmm[consensus]>=3.0.2,<4`) from PyPI. |
| A source checkout | `git clone https://github.com/fiberseq/FiberBrowser && cd FiberBrowser`, then `bash scripts/install.sh` (or `python3 -m pip install -r requirements.txt`) and `python browser.py`. |
| A read-only server for reviewers | The Docker image `ghcr.io/fiberseq/fiberbrowser:<version>` (runs `--public`). |

Extras for the pip install: `app` (its own window), `copilot` (local Copilot on
Apple silicon), `primers` (primer3-py, seqfold), `contact-maps` (cooler, h5py),
`umap`, `plots`, `pipeline` (mappy, for DAF-seq runs without minimap2), or
`all`. Details, conda, the Windows app and Docker:
[Installing FiberBrowser](https://github.com/fiberseq/FiberBrowser/blob/main/docs/install.md).

## Quick start

```bash
fiberbrowser                                          # empty browser; open files from the UI
fiberbrowser -b sample.bam -g genes.gtf -f genome.fa  # a BAM with gene annotations and a reference
fiberbrowser --app -b sample.bam                      # the same, in its own window
fiberbrowser --help                                   # every option
```

From a source checkout, `python browser.py` takes the same options. The server
listens on this computer only (port 8000, or the next free port) and opens its
access link, `http://localhost:8000/?token=...`, in your web browser. Every
launch has a new access token, so other users of the machine or network can't
use your browser.

New to FiberBrowser? Click **Take the tour** on the welcome screen. The tour
opens in a separate sandbox tab, loads two small bundled demos (DddA-seq reads
at the *NAPA* promoter, and H1 Fiber-seq reads around a 7.5 kb insertion) and
walks through the main tools in 58 steps. It never changes your own work. The
[tutorial](https://github.com/fiberseq/FiberBrowser/blob/main/docs/tutorial.md)
follows the same path in text, and the
[user guide](https://github.com/fiberseq/FiberBrowser/blob/main/docs/guide.md)
has a screenshot of every step.

## What you can do

**Molecule panels.** One read panel per dataset, with the layers each file
carries (nucleosomes, TF footprints, accessibility, m6A, 5mC, deamination, and
any custom Molecular-annotation layer), a metaprofile track, peaks, genes and
the reference sequence. Panels can be linked, merged, copied, stacked, shown
side by side, or moved independently (**Linked / Per panel**), and each panel
can be on its own genome.

**Clustering, sorting and filtering.** Select peaks and cluster the molecules by
their footprints there (K-means, Neighbourhoods on the t-SNE graph,
hierarchical, HDBSCAN, combinatorial), merge similar clusters, focus one,
compare their profiles, composition and V-plots, and see every read on a t-SNE,
UMAP or PCA map. Sort reads within clusters and filter them with reusable
rules.

**Metaprofiles.** Per-layer and per-rule profiles over the reads in view,
per dataset or per cluster, as a track or overlaid in the Clusters panel.

**Footprints and co-occupancy.** Cmd/Ctrl+click a footprint to see the sizes of
the footprints at that spot, save a size range as a definition, and look at its
sequence with JASPAR motif matches and a V-plot. **Co-occupancy** tests whether
saved footprints occur together on the same molecules (odds ratios, Fisher
exact tests with Benjamini–Hochberg correction), and can cluster the reads by
which ones they carry.

**Footprint classes (Preview).** **Find footprint classes** runs FiberHMM's
lattice recaller over every read in view, groups recurring footprints into
classes and gives each class's prevalence on each strand or chemistry. Saved
classes join co-occupancy, filtering and clustering.

**Variants: haplotypes and alleles.** The **Variants** panel finds the SNPs and
small indels in the reads in view, groups the reads by the alleles they carry,
and splits them into one panel per allele or per haplotype (from HP tags or
local allele patterns).

**Structural variants and inserts.** Deletions and insertions are drawn on the
reads and in an SV row; any SV can split the reads into carriers and reference
reads. The **Insertion lens** shows the chromatin inside a large insertion, and
**Identify** reports candidate transposable-element families and genome copies
of the insert. **Open carriers with the insert expanded** (Preview) re-aligns
the carriers onto the alternate allele so the reads inside the insert can be
clustered and analysed like any region.

**NFRs.** The NFRs panel runs FiberHMM's `fiberhmm-nfr` on the view: NFR
variants with their prevalence, which NFRs open together, and motifs at each
NFR.

**Sessions.** **Save** writes a session file that reopens the exact view,
datasets, clusters, rules and settings. Work is kept as you go; the next launch
offers to reopen it. Every change can be undone, and a timeline jumps back to
any step. **New Independent Workspace** opens a separate session on the same
server.

**Export.** **Export** makes a figure (PNG, or SVG and PDF with editable
vector text and tracks). **Data** (Cmd/Ctrl+Shift+E) exports read names, read
tables, a BAM of chosen reads, peaks and regions as BED, cluster assignments,
class and co-occupancy tables, and the session. Every chart saves its plotted
values as TSV.

**Python API.** `browser_client.py` drives a running browser from Jupyter, or
starts a headless server for scripted figures and analyses:

```python
from browser_client import BrowserClient

with BrowserClient.headless(bam="footprints.bam", gtf="genes.gtf", fasta="genome.fa") as client:
    client.goto_gene("NAPA")
    reads = client.get_reads()           # a DataFrame, one row per read
    client.save_view("napa.pdf")         # the figure the browser would draw
```

**Primer design.** The **Primers** panel designs PCR primers around selected
peaks (or for 3C and 4C), checks them with BLAST against the genome, and
exports an order list for common vendors. It needs the reference FASTA.

**The Library.** Every BAM, BigBed and plasmid map you open, your DAF-seq runs
and watched folders, in one searchable list with chemistry, genome, QC verdicts
and FiberHMM re-run advisories. **New DAF-seq run** aligns and calls raw reads
(FASTQ, or Nanopore POD5) from the app.

**Connect to cluster.** Open BAMs, BigBeds, FASTAs and plasmid maps that stay
on a cluster, over your own SSH connection. S3 and HTTPS URLs open directly.

**Tracks.** bigWig, bigBed and BED tracks, JASPAR or custom motif tracks,
UCSC, ENCODE and ChIP-Atlas hubs, contact maps (`.cool`/`.mcool`) and
co-accessibility matrices.

**Copilot (optional).** The Tutorial panel's Copilot tab answers "how do I…?"
questions by opening the right panels and pointing at the controls, like the
tour. It runs a small model on your computer: MLX on Apple silicon Macs (one
click downloads it), or a model you run with Ollama elsewhere. Nothing runs until
you set it up. FiberBrowser.app leaves it out. See
[Local Copilot](https://github.com/fiberseq/FiberBrowser/blob/main/docs/copilot.md).

What is supported and what is Preview in 3.0:
[What 3.0 includes](https://github.com/fiberseq/FiberBrowser/blob/main/docs/release-scope.md).

## Documentation

| Page | What it covers |
|------|----------------|
| [User guide](https://github.com/fiberseq/FiberBrowser/blob/main/docs/guide.md) | Every step of the guided tour with a screenshot, then footprint classes, haplotypes, figures, data export, sessions and workspaces. |
| [Tutorial](https://github.com/fiberseq/FiberBrowser/blob/main/docs/tutorial.md) | A written walkthrough of the tour on the bundled demos. |
| [Reference](https://github.com/fiberseq/FiberBrowser/blob/main/docs/reference.md) | Command-line options, environment variables, the access token, file formats, BAM tags and layers, the dataset catalog, panels, keyboard shortcuts. |
| [Installing FiberBrowser](https://github.com/fiberseq/FiberBrowser/blob/main/docs/install.md) | The Mac and Windows apps, pip and extras, conda, Docker, a source checkout. |
| [Workflows](https://github.com/fiberseq/FiberBrowser/blob/main/docs/index.md#workflows) | DAF-seq runs, the Library, data on a cluster or S3, plasmids, clustering and transcription states, haplotypes, live lift, linked panels, differences and structural variants, graph mode. |
| [Jupyter / Python API](https://github.com/fiberseq/FiberBrowser/blob/main/docs/jupyter-api.md) | `browser_client.py`: connecting, headless servers, figures, every method. |
| [Analysis methods and statistics](https://github.com/fiberseq/FiberBrowser/blob/main/docs/analysis_methods_and_statistics.md) | How each analysis is computed and tested. |
| [Deploying on a server](https://github.com/fiberseq/FiberBrowser/blob/main/docs/deployment/index.md) | Personal, lab and public servers; Open OnDemand. |
| [Plugins](https://github.com/fiberseq/FiberBrowser/blob/main/docs/plugins.md) | Adding an analysis panel with a Python plugin. |

## How to cite

If you use FiberBrowser in published work, please cite FiberBrowser and
[FiberHMM](https://github.com/fiberseq/FiberHMM), which calls the footprints it
shows. The reference with its version is in
[CITATION.cff](https://github.com/fiberseq/FiberBrowser/blob/main/CITATION.cff)
(GitHub's *Cite this repository*); see
[How to cite](https://github.com/fiberseq/FiberBrowser/blob/main/docs/citing.md).
In the app, **About FiberBrowser** and **⋮ → How to cite** give the citation,
and exported figures carry a citation line (on by default).

## License

MIT. See [LICENSE](https://github.com/fiberseq/FiberBrowser/blob/main/LICENSE).
