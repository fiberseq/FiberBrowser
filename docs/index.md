# FiberBrowser documentation

[← README](../README.md)

FiberBrowser is an interactive genome browser for fiber-seq and DAF-seq data
at single-molecule resolution. Each row is one DNA molecule, with its
nucleosomes, TF footprints, accessible patches and base modifications drawn
along it. You can cluster molecules into states, quantify footprints and
transcription states, compare datasets, and export figures and data. It is the
visualization component of the [FiberHMM](https://github.com/fiberseq/FiberHMM)
pipeline.

## Quick start

```bash
pipx install "fiberbrowser[app]"           # or: pip install; Python 3.10+
fiberbrowser                               # opens http://localhost:8000/?token=...
fiberbrowser --app -b sample.bam -g genes.gtf -f genome.fa   # in its own window
```

On an Apple silicon Mac you can instead install **FiberBrowser.app** (a DMG on
the releases page); on Windows, **FiberBrowser-Setup.exe** (it runs in WSL 2).
**[Installing FiberBrowser](install.md)** covers the Mac and Windows apps,
pip/pipx and extras, conda, Docker, installing it as an app from Chrome or
Edge, menu shortcuts on Linux, and the source checkout
(`pip install -r requirements.txt`, `python browser.py`).

On a Mac, `bash scripts/install.sh` builds a clean `./.venv`; the double-click
launchers (`Launch Browser.command`, `Launch Browser.bat`, `Launch Browser.sh`)
start the browser without a terminal.

New to the browser? Read the illustrated **[User guide](guide.md)**, or click
**Start from the beginning** in the **Tutorial** panel (or **Take the tour** on the welcome screen). The tour
opens in a separate tab on its own server session, loads a small demo dataset,
and never changes your own work. The guide walks through the same steps with a
screenshot of each, then covers footprint classes, haplotype comparison, figure
export, sessions and workspaces.

## Guides

| Document | What it covers |
|----------|----------------|
| [Updates and the FiberHMM FiberBrowser runs](updates.md) | Which FiberHMM runs (apps: bundled by default; pip/source runs), Check for Updates, the update channels and manifests, signing in to GitHub, privacy, publishing an update. |
| [Installing FiberBrowser](install.md) | The Mac app, pip/pipx, extras, conda, Docker, the Chrome/Edge app, menu shortcuts, and releasing (maintainers). |
| **[User guide](guide.md)** | The illustrated guide: every step of the guided tour on the bundled demos (DddA-seq reads at the NAPA promoter; H1 Fiber-seq reads around an insertion for the Variants steps) with a screenshot, then footprint classes and saved classes, co-occupancy, DAF-seq strands, haplotype comparison, figure export, sessions and workspaces. |
| [Tutorial](tutorial.md) | A written walkthrough of the guided tour on the bundled demos, section by section: what to do and what you should see, including the structural-variant demo (Variants panel, haplotype split, SVs, the expanded insert and its CTCF site). |
| [Reference](reference.md) | Every CLI flag and environment variable, the access token and workspaces, supported file formats and remote files, BAM tags and layer toggles, the dataset catalog, screen layout, panels, online genomes, and keyboard shortcuts. |
| [Deploying on a server](deployment/index.md) (optional) | One config file for a server; a shared lab server with sign-in; an Open OnDemand app for clusters; FiberBrowser on a cluster just for you. |
| [A public server](deployment/public-server.md) | Publishing your datasets on the web for anyone (or reviewers): the catalog, BigBed and remote data, Docker Compose or systemd behind Caddy, sizing, limits, and the security design. |
| [Changelog](../CHANGELOG.md) | What changed in each release, and upgrading from 2.17. |
| [What 3.0 includes](release-scope.md) | Supported features (including the Variants panel), and the Preview features (insert-expanded panels behind **Show preview features**; the footprint-class section, labelled): their badges, known limitations and what graduates them. |
| [Identify](identify.md) | What Identify reports about an insertion: candidates with their evidence, **Ambiguous** and **No confident match**, and the thresholds. |

## Workflows

| Document | What it covers |
|----------|----------------|
| [A DAF-seq run, from raw reads](workflows/daf-seq-quick-run.md) | **New DAF-seq run**: FASTQ reads (e.g. a Plasmidsaurus zip) + a genome or plasmid map → aligned and called footprints with their QC (deamination CDF, periodicity), without a command line. |
| [The Library](workflows/library.md) | Your datasets in one place: files you open, finished DAF-seq runs and watched folders, with chemistry, genome or plasmid, QC verdicts and FiberHMM re-run advisories; search, tags, groups, open with the right reference, export a group as a `--catalog`. |
| [DAF-seq](workflows/daf-seq.md) | Loading DAF-seq BAMs, deamination and 5mC layers, strand panels (CT / GA, split by strand), missing-layer troubleshooting. |
| [Data on a cluster](workflows/remote-cluster-data.md) | **Connect to cluster…**: open BAM, BigBed, FASTA and plasmid maps that stay on a cluster (an HPC login node) from FiberBrowser on your laptop, over your own SSH (keys, Duo); also S3 buckets. Setup, what is transferred, speed, security. |
| [Lab data on S3](workflows/s3-lab-data.md) | Keeping the lab's BAMs, BigBeds and contact maps in AWS S3, Cloudflare R2, Backblaze B2 or an institutional store: choosing a provider (rough costs), bucket layout, uploading, public vs private, read-only keys for lab members, setting up the app and pip installs, a lab catalog, speed and caching, troubleshooting. |
| [Open data from a link](workflows/open-from-links.md) | For portal and dashboard authors: open remote BAM/bigBed/bigWig files at a locus with one link (`?session=` JSON, `?hub=` track hubs, `fiberbrowser://`), confirmed by the user; pre-signed URLs; the security model and public-server settings. |
| [fibertools and FIRE outputs](workflows/fibertools-fire-data.md) | Opening `ft`/FIRE results: per-fiber bigBeds as reads, FIRE peaks and percent-accessible/coverage bigWigs as tracks, ft-tagged BAMs. |
| [Plasmids and circular genomes](workflows/plasmids.md) | Opening a map with its BAMs in one step (renamed or rotated references are matched by sequence), aligning reads to a plasmid, the circular map in the Regions panel. |
| [Clustering and transcription states](workflows/clustering-and-transcription-states.md) | Peaks, clustering, merging, subcluster branches, snapshots, cluster focus, and per-molecule Pause / PIC / Elongating calls. |
| [Setting up live lift and graph mode](workflows/pangenome-setup.md) | What to install and switch on: lift maps and graph packages from [graphlift](https://github.com/mtcicero26/graphlift), `FIBERBROWSER_LIVE_LIFT`, the graph helper, preview features, and the `scripts/unified_demo.py` launcher. |
| [Live lift](workflows/live-lift.md) | Reads aligned to a sample's own assembly drawn on this genome without realigning: maps, **Add live lift…** and **View on another assembly…**, MAT/PAT panels, **Open as**, supplementaries, hatching, settings, exports. |
| [Linked panels](workflows/linked-panels.md) | A lifted panel and its source view on the sample's assembly: the ribbon, shared hover, shared navigation, several matches. |
| [Differences](workflows/differences.md) | The Differences row: click to expand an insertion, ⌘/Ctrl-click or right-click to inspect, the menu, the table, the inspector and the insertion lens. |
| [Structural variants](workflows/structural-variants.md) | Carrier evidence levels (confirmed, putative, conflicting, ambiguous), the SVs tab, the native Differences row, highlights and the conflicting-clip settings. |
| [Graph mode](workflows/graph-mode.md) | View a dataset panel on a pangenome graph: haplotype lanes, bands per panel, pop out and fold haplotypes, add panels, clustering on the graph, exports, the zoom-out hand-off, speed and memory. |
| [Haplotype comparison](workflows/haplotype-comparison.md) | Compare two haplotypes/loci side by side; cluster each view separately or co-cluster matched domains. |
| [Footprint classes](workflows/footprint-classes.md) | Short pointer to the Footprints panel's class-finding workflow (illustrated in the [guide](guide.md#24-footprint-classes)). |
| [Motifs at NFR variants](lab/workflows/nfr-motifs.md) | NFR analysis: motif sites per NFR variant as nested evidence (open from NFR shape, footprinted given open from Find classes), p-value motif scoring shared with the Footprints panel, profiles, ChIP-Atlas, conservation, and analyses pooled over many NFRs. |

## Programming and extending

| Document | What it covers |
|----------|----------------|
| [Jupyter / Python API](jupyter-api.md) | `browser_client.py`: connecting to a running browser, headless servers, figures, and the method reference. |
| [Plugins](plugins.md) | Adding a custom analysis panel with a Python plugin. |
| [Local Copilot](copilot.md) | The optional on-device assistant in the Tutorial panel: setup, use, troubleshooting. |
| [Browser API guide](browser_api_guide.md) | The browser's mental model, API safety model, HTTP endpoint cookbook and Python client map, shared by the UI, the Python client and the Copilot planner. |

## Methods and data

| Document | What it covers |
|----------|----------------|
| [Analysis methods and statistics](analysis_methods_and_statistics.md) | How each analysis is computed, what each plot shows, and which statistical tests are used. Written as a supplementary-methods reference. |
| [Analysis data exports](analysis_data_exports.md) | Where to download the numbers behind every view (plot data vs observation-level data) and how to reload an exact browser state. |
| [Lattice consensus](LATTICE_CONSENSUS.md) | The Footprints panel's footprint-class workflow: the lattice recaller's use, parameters and outputs. |
| [Genome windows](GENOME_WINDOWS.md) | Linked vs independent windows, multiple FASTA/annotation pairs, BED gene annotations, and clustering across windows. |
| [How to cite](citing.md) | Citing FiberBrowser (CITATION.cff) and FiberHMM; the citation in About, the toolbar and exported figures. |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Port 8000 is in use | The server takes the next free port and prints its link. Or choose one with `-p 8001`. |
| No genes shown | Load a GTF/GFF3/BED annotation, and check that chromosome names match the data (`chr1` vs `1`). |
| A footprint layer is missing on a DAF BAM | See [DAF-seq: missing layers](workflows/daf-seq.md#missing-layers). `FIBERBROWSER_BAM_DIAGNOSTICS=1` logs layer detection. |
| Reads do not appear on a plasmid | The BAM's contig is not the map's sequence; **Regions** says what differs. See [Plasmids](workflows/plasmids.md#when-a-bam-does-not-match). |
| Contact map does not load | `pip install cooler h5py`; check the file with `cooler info file.cool`. `FIBERBROWSER_DAFC_DIAGNOSTICS=1` logs details. |
| Clustering or footprint analysis is slow | Set **Analysis cap** (sidebar → **Analysis & Reproducibility → Reproducibility**), or zoom in. BigBed is faster than BAM for display. |
| Install or Copilot problems | `python browser.py --copilot-doctor` checks Python, packages and the Copilot setup and prints fixes. |
| Jupyter cannot connect | Confirm the server is running (open `http://localhost:8000`) and the port matches. |
