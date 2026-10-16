# Workflow: fibertools and FIRE outputs

[← Docs index](../index.md) · [← README](../../README.md)

[fibertools-rs](https://github.com/fiberseq/fibertools-rs) (`ft`) and the
[FIRE](https://github.com/fiberseq/FIRE) pipeline write fiber-seq results in
standard genome-browser formats. The FIRE pipeline collects them in a
`trackHub/` folder for the UCSC browser: per-fiber bigBeds in `bb/`, signal
bigWigs in `bw/`. FiberBrowser opens these files too. The per-fiber files open
as reads; peaks and signals open as tracks next to them.

## 1. What to open, and how

| FIRE / fibertools file | Open it as | What you see |
| --- | --- | --- |
| `bb/fire-fiber-decorators.bb` | **Dataset** (Open, or Load by path) | One read per fiber: nucleosomes as footprints, MSPs in the FIRE layer, m6A and 5mC marks |
| `bb/fire-fibers.bb` | **Dataset** | The same reads (FiberBrowser reads the `fire-fiber-decorators.bb` next to it) |
| the whole `bb/` folder | **Dataset** | The same reads, each fiber once |
| `bb/fire-peaks.bb` (older hubs: `FDR-FIRE-peaks.bb`) | **Track** | FIRE peaks (`peak-N`, score = 10 × peak score) |
| `bb/fire-wide-peaks.bb` (`FDR-wide-peaks.bb`) | **Track** | Wide peaks, plain intervals |
| `bb/hap_differences.bb` | **Track** | Peaks that differ between haplotypes |
| `bb/unreliable-coverage-regions.bb` | **Track** | Regions with too low or too high coverage |
| `bw/{all,hap1,hap2}.percent.accessible.bw` | **Track** (signal) | % of fibers with a FIRE element (0–100) |
| `bw/all.{fire,linker,nucleosome}.coverage.bw` | **Track** (signal) | Coverage by FIREs, linkers and nucleosomes |
| `bw/log_FDR.bw` | **Track** (signal) | −10 log10 FDR of accessibility |
| ft-tagged BAM (`ft fire` output) | **Dataset** | Reads with nucleosomes, MSPs and m6A from the BAM tags |

**Dataset:** **Open** in the top bar, or **Data & Sessions → Load by
path** (a path, or an `https://` URL of a file on a web server).

**Track:** the **Tracks** panel's add box (path or URL). `.bw` files can also
go through **Open**, which opens them as signal tracks. **Open** makes
every `.bb` a dataset, so add peak bigBeds in the Tracks panel. Don't add
the per-fiber bigBeds as tracks: a track draws each fiber as a plain bar, a
few rows deep.

**A whole FIRE track hub** opens from its `hub.txt` URL: open
`http://localhost:<port>/?hub=<hub.txt URL>` (or `fiberbrowser://open?hub=...`),
see [Open data from a link](open-from-links.md#3-track-hubs-hub). FiberBrowser
lists the hub's tracks and asks before loading them: the per-fiber bigBed opens
as a dataset (the hub's H1/H2/UNK fiber tracks, which filter one file, are one
entry), the decorators file is listed unticked (it opens the same fibers), and
peaks and bigWigs become tracks, each multiWig child its own track.

## 2. Per-fiber reads

`ft track-decorators` writes two files per sample, which the FIRE pipeline
turns into bigBeds:

- `fire-fibers.bb` has one row per fiber: its read name, span, strand and
  haplotype (`H1`, `H2` or `UNK`). It says nothing about what is on the fiber.
- `fire-fiber-decorators.bb` has, per fiber, one row for each kind of call:
  `m6A` marks, `5mC` marks, `NUC` nucleosomes, and MSPs split by FIRE
  confidence (`FIRE`, `LINKER`). Each row names its fiber (`chr:start-end:read`).

FiberBrowser builds one read per fiber from the decorator rows:

- **Footprints** are the nucleosomes. Older FIRE hubs keep the `NUC` rows and
  these are used as they are. The current FIRE pipeline removes the `NUC` rows
  from the decorators file; the footprints are then the stretches of the fiber
  between its MSPs, as for a BAM with only MSP (`as`/`al`) tags.
- **FIRE layer**: every MSP. fibertools colours an MSP by its FIRE FDR, and
  FiberBrowser turns the colour back into a FIRE quality (`aq`, 0–255): the
  lowest `aq` of that colour's FDR bin.

  | fibertools colour | FDR | `aq` |
  | --- | --- | --- |
  | dark red → red (`139,0,0` … `255,0,0`) | ≤ 1 % … ≤ 5 % | 253, 250, 248, 245, 243 |
  | orange (`255,140,0`) | ≤ 10 % | 230 |
  | yellow (`225,225,0`) | ≤ 25 % | 192 |
  | purple (`147,112,219`), linker | > 25 % | 0 |

  FiberBrowser paints an MSP as FIRE when `aq ≥ 230` (FDR ≤ 10 %, the
  **FIRE default** quality setting). Yellow MSPs (`aq` 192), which fibertools
  still names `FIRE`, stay in the layer as accessible stretches but are not
  painted as FIRE unless you lower the `aq` threshold (**Quality → Custom
  filters**). The colour, not the row name, decides: older fibertools named
  linker rows `FIRE` too.
- **m6A** and **5mC** marks come from the `m6A` and `5mC` rows. Turn them on
  like any other mark layer.

The `fire-fibers.bb` file is only needed for the fiber spans, and the
decorators rows carry those too. When you open `fire-fibers.bb`, FiberBrowser
reads the decorators bigBed in the same folder (for a URL: the
`fire-fiber-decorators.bb` next to it). Without one, each fiber is drawn as a
bare span.

FiberBrowser's usual read settings (spanning reads only, hide terminal gaps,
minimum footprints) apply. The terminal-gap *filter* (drop reads whose first
footprint is far from the read end) is a FiberHMM check and is not applied to
FIRE fibers.

## 3. Tracks

bigWigs open as signal tracks, with the values as written: percent accessible
on a 0–100 scale, coverage in fibers, −10 log10 FDR. For a two-haplotype view,
add `hap1.percent.accessible.bw` and `hap2.percent.accessible.bw` as two tracks.
FiberBrowser draws each bigWig as its own track; the FIRE hub's stacked
coverage (`container multiWig`) is three tracks here.

Peak bigBeds open as annotation tracks. `fire-peaks.bb` is a narrowPeak
(`bigNarrowPeak`) file; each peak shows its name and score. The wide-peak and
unreliable-region files are plain intervals.

## 4. ft-tagged BAMs

A BAM from `ft fire` (or `ft predict-m6a` + `ft add-nucleosomes`) opens
as a dataset. FiberBrowser reads m6A from `MM`/`ML`, nucleosomes from `ns`/`nl`,
MSPs from `as`/`al` and FIRE quality from `aq`. A BAM with MSP tags but no
nucleosome tags gets its footprints from the gaps between the MSPs.

## 5. Limitations

- The haplotype of each fiber (`H1`/`H2`/`UNK` in `fire-fibers.bb`) is not
  read. The FIRE hub's three fiber tracks (one per haplotype) are one dataset
  here, with every fiber.
- `hap_differences.bb` colours (`itemRgb`: which haplotype is more accessible)
  are not drawn; every interval has the track's colour.
- The TF layer is offered for FIRE datasets but is always empty; fibertools
  does not call TF footprints in these files.
- Decorator rows are indexed by the span of their calls. FiberBrowser reads
  5 kb beyond the window on each side to find the fibers crossing it, then
  reads every row of those fibers (their whole span), so footprints keep
  their true sizes at any zoom. With only the decorators file open, a fiber
  with no call within 5 kb of the window does not appear (open
  `fire-fibers.bb`, which lists every fiber's span). Remote files take a few
  seconds per new window.
- FiberBrowser recognises the per-fiber files by their table and their first
  rows (decorator rows named `m6A`, `5mC`, `NUC`, `FIRE` or `LINKER` inside
  the fiber they name; fiber rows with two 1-bp end blocks), not by the file
  name. The decorator table is UCSC's generic `decoration` table, so another
  bigBed with it (gene or feature decorations) opens as an ordinary
  annotation track. A decorators bigBed renamed from
  `fire-fiber-decorators.bb` is found next to a local `fire-fibers.bb`, but
  not next to a URL. Open the decorators file itself instead.
- FIRE peak bigBeds opened with **Open** become empty datasets. Add them
  in the Tracks panel.
