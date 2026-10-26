# Setting up live lift and graph mode

[← Docs index](../index.md) · [← README](../../README.md)

Live lift and graph mode let you look at reads aligned to a sample's own
assembly (for example the maternal and paternal haplotypes of HG002) on the
reference genome, and on a pangenome graph. This page says what to install and
set up. The features themselves are described in:

- [Live lift](live-lift.md): reads from another assembly drawn on this genome
- [Linked panels](linked-panels.md): the source assembly beside the lifted view, joined by ribbons
- [Differences](differences.md): the Differences row, expanding insertions, the inspector
- [Structural variants](structural-variants.md): confirmed, putative and conflicting carriers
- [Graph mode](graph-mode.md): a dataset panel drawn on a pangenome graph

All of the files below are made with
[graphlift](https://github.com/mtcicero26/graphlift), which is free and open
source (MIT).

## What you need

| What | Used by | Where it comes from |
|---|---|---|
| **A lift map** (`*.graphlift.json`, with the files next to it) | live lift, linked panels, the Differences row | `gbz2chain` in [graphlift](https://github.com/mtcicero26/graphlift#chains-and-sidecar-gbz2chain), from a pangenome graph (for example an HPRC release) |
| **A BAM aligned to the sample's assembly** | live lift | your aligner, against the assembly whose contig names the map uses (for example `chr1_MATERNAL`) |
| **The graph helper** (`fiberbrowser-graph`) | graph mode, the graph view panel | the macOS app includes it; otherwise `pip install "fiberbrowser[graph]"` (see below) |
| **A graph package** | graph mode, the graph view panel | `fiberbrowser-graph prepare` in [graphlift](https://github.com/mtcicero26/graphlift#fiberbrowser-graph-helper-fiberbrowser-graph) |

A plain UCSC `.chain` file cannot drive live lift: FiberBrowser reads the
graphlift map (`gbz2chain` writes the chain and the map together).

## Live lift is on

<!-- ENABLEMENT (owner decision, 25 Oct): live lift is on by default; FIBERBROWSER_LIVE_LIFT only turns it off.
     If this changes again, this section is the one place to update (live-lift.md, linked-panels.md and graph-mode.md
     do not describe enablement). -->

Live lift needs no setup beyond a lift map: **Open ▾** has **Add live lift…**
and a BAM panel's **…** menu has **View on another assembly (live lift)…**.

To turn it off for a server (for example a shared one), start FiberBrowser with
`FIBERBROWSER_LIVE_LIFT=0`. The two menu items are then hidden, and a saved
session that holds a lifted dataset says that live lift is turned off on that
server.

## Installing the graph helper

The graph helper is a small native program that reads graph packages. Nothing
else in FiberBrowser depends on it.

- **macOS app:** included.
- **pip:** `pip install "fiberbrowser[graph]"` adds the
  `fiberbrowser-graph-native` companion package. It is not part of
  `fiberbrowser[all]`. At the time of writing the companion package is built
  for Apple silicon Macs only.
- **Anywhere else:** build `fiberbrowser-graph` from
  [graphlift](https://github.com/mtcicero26/graphlift) (`cargo build --release
  --locked`) and point FiberBrowser at it with
  `FIBERBROWSER_GRAPH_HELPER=/path/to/fiberbrowser-graph`.

Restart FiberBrowser after installing it. Without a helper, the graph view says
**Graph helper unavailable**, with the install command and a **Check again**
button.

## Registering a graph package

A graph package is a folder made by `fiberbrowser-graph prepare`. FiberBrowser
checks every file in it once, when you register it, and remembers it after
that.

- **In the app:** open the **Graph view** panel (a preview feature, see below),
  then **Register a graph package…** in its right-click menu (or in its empty
  state, *No graph package registered*). Enter the package folder and click
  **Register**. Checking a large package can take a few minutes.
- **At start-up:** `FIBERBROWSER_GRAPH_PACKAGES=/path/to/package` (several
  folders separated by `:`) registers packages without opening the panel.

![The graph view panel before a package is registered](../images/pangenome/setup-graph-register.png)

With more than one package registered, the graph view's right-click menu has a
**Graph package** submenu to switch between them. A package whose files change
after it was checked is refused until you register it again.

## Preview features

**Settings › Reads & Display › Read Display › Show preview features** shows
features that are still being finished. For graphs it controls only the
standalone **Graph view** panel, which is also where packages are registered
in the app. Graph mode on dataset panels (the **Linear ⇄ Graph** pill and
**View as graph**) does not depend on it.

![Show preview features in Settings](../images/pangenome/setup-preview-features.png)

## Trying everything at once: the demo launcher

`scripts/unified_demo.py` in a source checkout starts FiberBrowser with all of
the above ready, for that server only: live lift, the graph helper and a graph
package, and preview features. It then loads a sample as a lifted dataset
(**Sample A (lifted)**) and, if you give one, the same reads aligned to the
reference (**Sample A (GRCh38)**).

```bash
python scripts/unified_demo.py \
    --sample "Sample A" ~/pglift_work/demo_data/sample_a.alu_chr3.hg002v1.1.bam \
                        ~/pglift_work/demo_data/sample_a.alu_chr3.GRCh38.bam \
    --map ~/pglift_work/maps/hprc.GRCh38.HG002.chain.graphlift.json \
    --graph-package ~/pglift_work/graph/hprc-package \
    --fasta ~/pglift_work/ref/GRCh38.fa \
    --port 8883
```

It prints a link to open when the data is loaded. Ctrl+C stops the server.

| Option | What it does |
|---|---|
| `--sample LABEL LIFTED_BAM [NATIVE_BAM]` | A sample: its reads on its own assembly (added as a live-lift dataset, *LABEL (lifted)*) and, optionally, on the reference (*LABEL (GRCh38)*). Repeat for more samples. |
| `--map FILE` | The graphlift map (`.graphlift.json`) for the lifted BAMs. |
| `--graph-package DIR` | A graph package (repeatable). `--no-graph` leaves graphs off, so lifted datasets open as one panel per haplotype. |
| `--graph-helper PATH` | A `fiberbrowser-graph` you built; otherwise the companion package or the macOS app's copy is used. |
| `--fasta FILE` | The reference FASTA (with its `.fai`). |
| `--pooled` | Lifted datasets open as one pooled panel. |
| `--no-preview` | Leave preview features off. |
| `--port N` | The port (default 8883). |
| `--home DIR` | The server's home folder (default: a new temporary folder). |
| `--build` | Build this checkout's frontend first (into the server's home folder, never into the checkout). |

Every path has a default under one work folder, `~/pglift_work` (or
`$PGLIFT_WORK`): `demo_data/`, `maps/`, `graph/` and `ref/`, as in the example
above. `python scripts/unified_demo.py --help` lists them.

The launcher gives the server a home folder of its own, so it never reads or
changes your settings, Library or sessions in `~/.fiberhmm`. It listens on this
computer only, without an access token: use it for demos and testing, not as a
shared server.

## Troubleshooting

| Symptom | What to check |
|---|---|
| No **Add live lift…** in **Open ▾** | The server was started with `FIBERBROWSER_LIVE_LIFT=0` (live lift turned off). |
| *No lift map was found next to this BAM or in the Library* | Put the `.graphlift.json` (with its files) next to the BAM or in its folder, add it to the Library, or type its path in the dialog. |
| *Cannot read the map* | The file is not a graphlift map (a plain `.chain` is not enough), or the files next to it are missing. |
| **Graph helper unavailable** | Install `fiberbrowser[graph]`, or set `FIBERBROWSER_GRAPH_HELPER`, then restart. |
| **View as graph** is greyed out | Its tooltip says why: no helper, no registered package, or no package path matches the dataset. |
| No **Graph view** panel in the rail | Turn on **Show preview features**. |
