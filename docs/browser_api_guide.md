# FiberBrowser Browser + API Guide

This guide is the shared operating manual for the GUI, Jupyter/Python client,
and local Copilot planner. It describes the browser mental model, the stable
API surfaces, and the workflow recipes that should be used for reproducible
single-molecule analysis.

## Copilot Fast Context

FiberBrowser is a local genome browser for fiber-seq, DAF-seq, BigBed, BAM,
contacts, motifs, annotations, and single-molecule analysis. The Copilot is a
tutor: its plans keep only teaching steps (`explain`, `try_it`, `open_panel`,
`open_sidebar`, `close_panel`, `navigate_gene`, `navigate_region`, `zoom_view`,
`pan_view`, `reset_view`, `go_to_top_locus`). Any other action is dropped from
the plan with a note naming the control that runs it, and the user clicks that
control. The Copilot never accesses local files, uploads files, configures S3, spawns
processes, or shuts down the server.

Plans are shown to the user as a visible trace: command interpretation, active
viewport context, safe API route status, warnings, action payloads, and
API-equivalent notes. Local-model troubleshooting also exposes prompt messages,
raw model response content, parsed JSON, validator warnings, timing, timeout,
fallback, and repair details so failures are debuggable from the UI.
The planner's system prompt lists the teaching actions, UI anchors and
milestones; it is built once per server so the local model's cache survives
across requests.

The Jupyter bridge (`POST /api/jupyter/actions`), the guided tour and the
headless API run the full set of typed browser actions, for example:

```json
{"type":"navigate_gene","gene":"eve","padding_bp":5000}
{"type":"navigate_region","chrom":"2R","start":9970000,"end":9980000}
{"type":"scan_peaks","scope":"enabled_rules"}
{"type":"set_peaks_locked","locked":true}
{"type":"select_peak_at","chrom":"2R","position":9974000,"tolerance_bp":500}
{"type":"cluster_selected_peaks"}
{"type":"cluster_peak_at_gene_tss","gene":"eve","padding_bp":5000,"tolerance_bp":500}
{"type":"add_region_label_rule","chrom":"2R","start":9973900,"end":9973980,"layer":"tf","color":"#22c55e"}
{"type":"query_motif_overlaps","chrom":"2R","start":9973900,"end":9973980}
{"type":"api_call","method":"POST","path":"/api/cluster_all?chrom=2R&start=9970000&end=9980000","body":{"peak_regions":[{"chrom":"2R","start":9973900,"end":9973980}]}}
```

Common user requests map to these recipes:

| Request | Preferred plan |
|---|---|
| "Go to eve +/- 5 kb" | Resolve `eve` exactly from the loaded GTF, then navigate to gene start/end plus padding. |
| "Scan peaks" | Use `scan_peaks`; if the user asks for reproducibility, also lock peaks. |
| "Cluster on the peak overlapping the TSS of eve" | Use `cluster_peak_at_gene_tss` with exact gene `eve`. The browser action navigates if needed, scans/selects the nearest TSS peak, and applies clustering results to the browser store. |
| "Relabel the footprint at -100 from the TSS as green" | Resolve the gene TSS, calculate strand-aware offset, add a fixed-region labeling rule on the TF layer. |
| "What motifs overlap that footprint?" | Query motif overlaps for the target footprint/region using currently loaded motif tracks. |
| "Export this for reproducibility" | Use session/settings/peaks/clusters/read-order APIs rather than screenshots alone. |

Gene names must be preserved exactly. If the user typed `eve`, do not replace it
with `mtSSB`, `everest`, or another partial match. If the exact gene is missing,
return a warning instead of guessing.

## Browser Mental Model

The live browser state has these core pieces:

| Concept | Meaning |
|---|---|
| Viewport | Current `chrom`, `start`, `end`, genome, zoom, and display geometry. |
| Dataset | A loaded BAM/BigBed/catalog item with stable dataset ID, label, layer capabilities, caches, and optional merged-source metadata. |
| Layers | Standard layers include `nuc`, `tf`, `fire`, `deam`, `m6a`, and compatible legacy-derived layers. MSP is treated as FIRE unless raw legacy behavior is needed. |
| Working set | Reads in the current analysis scope after span/quality/rule filters and analysis caps. This is what clustering and most analyses use. |
| Display set | Reads actually rendered on screen after fit/all display mode and display caps. Display sampling must not change analysis results. |
| In-scope/total reads | Reads available in the viewport before display sampling. Use hover/status/details when reconciling visible vs sampled vs total counts. |
| Peaks | Accessibility/footprint peak intervals. Peaks can be autoscan-derived or locked/imported for reproducibility. |
| Clusters | Read-to-cluster assignments from selected peaks/features and current clustering settings/seed. |
| Analysis rules | Reusable Cluster, Sort, and Filter rules. They populate the top-bar dropdowns and can target selected peaks, all peaks, the current window, selected genes/transcripts, or custom regions. |
| Labeling rules | Portable user rules that recolor/hide layer intervals by layer, size, position, gene overlap, or other predicates. |
| Derived footprint rules | Portable definitions for user-defined footprint/MSP/FIRE classes. Prefer rules for reusable definitions across datasets. |
| History/Copilot | Logs browser actions/API equivalents for reproducibility and export. |

Important distinction: display sampling is for rendering speed, while analysis
sampling/caps control calculations. Reproducible scientific results should
record seed, caps, peak lock state, selected peak intervals, clustering
parameters, active quality filters, and labeling rule presets.

## API Safety Model

The safe API catalog lists same-origin `/api/...` calls that do not touch
files or server lifecycle. These are safe examples:

```text
GET /api/status
GET /api/datasets
GET /api/gene_search?query=eve
POST /api/jupyter/goto {"chrom":"2R","start":9970000,"end":9980000}
GET /api/jupyter/region
GET /api/jupyter/peaks?selected_only=true
POST /api/scan_peaks {...}
POST /api/cluster_all?chrom=2R&start=9970000&end=9980000 {...}
POST /api/filter {...}
POST /api/sort_reads {...}
GET /api/jupyter/settings
POST /api/jupyter/settings {...}
POST /api/jupyter/actions {"actions":[{"type":"cluster_selected_peaks"}],"label":"Notebook"}
```

Copilot must not use routes or payloads involving local paths, uploads, file
pickers, S3 credentials, process management, shutdown, or output directories.
Blocked examples include `/api/load_fasta`, `/api/load_gtf`,
`/api/datasets/add`, `/api/files/upload`, `/api/s3/...`,
`/api/primer_blast_db/build`, and any body/query key such as `path`, `file`,
`folder`, `output_dir`, `bucket`, or `url`.

## Core Endpoint Cookbook

### Status, Datasets, And Genome

| Endpoint | Use |
|---|---|
| `GET /api/status` | Check server, genome, loaded data, and mode. |
| `GET /api/chroms` | List chromosomes/contigs. |
| `GET /api/datasets` | List loaded datasets, IDs, labels, layer capabilities, and merged-source metadata. |
| `GET /api/gene_search?query=eve` | Search loaded GTF genes before navigation or TSS-relative actions. |
| `GET /api/genes?chrom=2R&start=...&end=...` | Query genes in a region. |

### Navigation And Browser State

| Endpoint | Use |
|---|---|
| `POST /api/jupyter/goto` | Navigate the live browser to exact coordinates. Body: `{"chrom":"2R","start":9970000,"end":9980000}`. |
| `POST /api/jupyter/goto_gene` | Navigate by exact gene symbol when GTF is loaded. |
| `POST /api/jupyter/actions` | Queue UI-equivalent browser actions for the active frontend to execute, e.g. cluster selected peaks or cluster a peak at a gene TSS. |
| `GET /api/jupyter/region` | Return the live browser viewport. |
| `GET /api/jupyter/state` | Return the synchronized Jupyter/browser state snapshot. |
| `GET /api/jupyter/analysis_state` | Return panel-level analysis state used for reproducibility. |

### Reads, Working Sets, And Rendering

| Endpoint | Use |
|---|---|
| `GET /api/reads/compact` | Get compact reads for the active dataset/viewport, respecting display controls. |
| `GET /api/reads/compact_all` | Get compact reads across datasets for scripted display/export. |
| `GET /api/working_set_info` | Inspect working/display/in-scope/spanning counts. |
| `POST /api/reads/stats` | Compute per-read stats for selected/read-list exports. |
| `GET /api/reads/image` | Render read images for scripts. |
| `POST /api/render` | Produce a reproducible composite browser render. |
| `POST /api/render/compile` | Export expanded/full render outputs for large read sets. |
| `POST /api/render/figure` | Browser-identical figure (PNG/SVG/PDF) of the open browser's view or a saved session, via the Export button's own code in headless Chromium. |
| `POST/GET /api/render/live_state` | The open browser reports its view here; GET shows whether one is available (`full=true` includes its frontend state). |

The compact-read endpoints return JSON by default, including for the Python
client. Callers can request `Accept: application/vnd.fiberbrowser.reads.v1`
for columnar binary reads with the same data. Responses include `Vary: Accept`.
The binary body starts with `FBR1`, a little-endian 32-bit JSON header length,
and the UTF-8 header padded to an eight-byte boundary. The remaining bytes hold
aligned typed columns. Header vector descriptors contain an offset relative to
that data section, an element count, and a NumPy dtype string. Records use field
columns; lists use offsets or a fixed stride; dictionary columns hold string
and mixed metadata. Optional validity columns distinguish missing (0), null (1),
and present (2) values. The browser decoder in `src/api/readBinary.ts` exposes
ordinary read objects and expands numerical arrays only when accessed.

Optional `geometry` and `terminals` columns carry alignment bounds and
terminal-gap provenance separately from the read dictionaries. The browser
retains complete spans, with a half-window margin for eligible Load all
requests. Contained views reuse those columns and recompute uncapped layer
profiles locally; unsupported filters, circular geometry and ambiguous SV
boundaries fall back to the server. Expanded dense marks have a separate
128 MiB cache. `viewport_start` and `viewport_end` identify the visible view
when the requested span includes a prefetch margin; they do not change the
returned coordinates or counts. Requests outside a retained span currently
fetch a complete replacement span, not a delta.

The direct server cache also serves contained views. Accessibility and TF
density peak scans can reuse its primary intervals when the scan's read scope,
filters and sampling agree with that cohort.

`POST /api/render` accepts `engine: "headless" | "numpy" | "playwright"`. The
default `headless` engine draws the browser's view in Python on the server (no
browser needed) from a session, the open tab, or the browser's defaults. The
legacy `numpy` compositor is used when a request relies on its legacy-only
options without choosing an engine. `engine: "playwright"` drives the
live React app through a long-lived headless Chromium worker, so exports match
the on-screen browser's color rules, layer toggles, filters, read order, and
multi-dataset panels.

Common Playwright request fields include `tracks`, `dataset_id`,
`dataset_ids`, `read_ids`, `read_sort_order`, `cluster_order`, `show_layers`,
`show_mods`, `show_fire`, `show_cigar`, `quality_shading`, `format`, `dpi`,
`timeoutMs`, and `show_nudges`. Public `tracks` tokens include `axis`, `meta`,
`peaks`, `reads`, `genes`, `sequence`, and `signal`; `peaks` maps to the live
FIRE/peaks track, `genes` maps to the gene track, and `signal` expands loaded
orthogonal tracks. FASTA/GTF and orthogonal-track metadata are preloaded into
render state when available, so render-mode screenshots do not need normal
browser startup fetches.

Playwright responses include `X-Render-Engine: playwright` and
`X-Render-Diagnostics` with total duration, canvas count, pending fetch count
at capture, configured store-wait timeout, and phase timings such as
`goto_ms`, `store_hook_ms`, `inject_state_ms`, `settle_ms`, and
`screenshot_ms`. If the page does not fully settle before the request timeout,
the endpoint returns the best partial image with `X-Render-Partial: true` and
the timeout reason in `X-Render-Reason`.

Use read order APIs when exports need to match the current top-to-bottom viewer
order rather than alphabetical read names.

### Peaks

| Endpoint | Use |
|---|---|
| `POST /api/scan_peaks` | Run enabled peak rules on the current analysis scope. |
| `GET /api/jupyter/peaks` | Return current peaks; `selected_only=true` restricts to selected/locked targets. |
| `POST /api/jupyter/import_peaks` | Push exact peak intervals into the live browser. |
| `POST /api/jupyter/peak_rules` | Apply peak-rule settings and lock/autoscan behavior. |
| `POST /api/detect_peaks` | Lower-level peak detection for scripted workflows. |

For reproducibility, prefer imported/locked peaks or explicit thresholds over
percentile-derived autoscan peaks when finalizing an analysis.

### Clustering And Read Organization

| Endpoint | Use |
|---|---|
| `POST /api/cluster_all?chrom=...&start=...&end=...` | Cluster reads across selected peaks/datasets using current method/K/thresholds. Body supports `peak_regions`, `peak_indices`, `k`, `method`, `dataset_ids`, `read_ids`, `max_reads`, `sample_seed`, and `cluster_feature_rules`. |
| `POST /api/cluster` | Cluster a single dataset/region. |
| `POST /api/assign_to_clusters` | Apply explicit read-to-cluster assignments. |
| `POST /api/cluster_expand` | Expand/focus clusters in the browser. |
| `POST /api/auto_cull_clusters` | Hide/cull low-signal clusters by current criteria. |
| `POST /api/cluster_projection` | Compute cluster projection/embedding. |
| `POST /api/cluster/vplot` | Compute cluster-centered V-plots. |
| `GET /api/jupyter/clusters` | Return browser-synced cluster assignments. |
| `POST /api/sort_reads` | Sort reads by cluster, name, screen order, position, or other supported modes. |
| `POST /api/filter_by_analysis_rule` | Filter reads by an Analysis Rules filter definition. |

Clustering should use the analysis/working set, not merely the display sample.
When the user asks for "cluster based on a peak", supply exact peak intervals
and record seed, K, method, layer thresholds, span mode, and quality filters.
When a `peak_regions` entry uses `mode:"cluster_rule:<id>"`, include the matching
`cluster_feature_rules` list on `cluster_all`, `assign_to_clusters`,
`dissolve_cluster`, `auto_cull_clusters`, and `cluster_projection` requests.

### Analysis Rules

| Rule surface | API/Python shape |
|---|---|
| Cluster rules | `cluster_feature_rules` contain named terms and scope; Python helpers include `get_analysis_rules`, `set_cluster_feature_rules`, and `cluster_by_feature_rule`. |
| Sort rules | `analysis_sort_rules` map to `sort_by_analysis_rule`; Pol II terms use `transcription_state` plus `gene_ids`. |
| Filter rules | `analysis_filter_rules` map to `filter_by_analysis_rule`; metric/operator/threshold mirror the UI. |
| Shared scope | `selectedPeaks`, `allPeaks`, `currentWindow`, `gene`, `transcript`, and `customRegion` resolve to absolute genomic windows. |

### Labeling, Quality, And Layers

| Endpoint | Use |
|---|---|
| `GET /api/quality_filters` | List active quality filters. |
| `POST /api/quality_filters` | Set active filters separately from visual labels. |
| `POST /api/filter` | Filter reads by clusters, labels, layers, size, region, or other criteria. |
| `GET /api/jupyter/settings` | Capture layer visibility, labeling, quality, display, peaks, and reproducibility settings. |
| `POST /api/jupyter/settings` | Apply browser settings from Python/Copilot workflows. |
| `POST /api/jupyter/settings/sync` | Sync a frontend settings snapshot into the bridge. |

Layer defaults should preserve the semantic layer split: `nuc` for nucleosomes,
`tf` for TF/subnucleosomal footprints, `fire` for FIRE/MSP accessibility gaps,
and deamination/m6A layers where available.

### Motifs And Tracks

| Endpoint | Use |
|---|---|
| `GET /api/jupyter/motifs/list` | List built-in/custom motif libraries. |
| `POST /api/jupyter/motifs/search` | Scan selected peaks/sequences for motifs. |
| `POST /api/jupyter/motifs/custom` | Register custom motifs/PWMs for analysis. |
| `GET /api/jupyter/motifs/custom` | List custom motifs. |
| `POST /api/tracks/add_motif_sequence` | Add an IUPAC/sequence motif as a browser track. |
| `POST /api/tracks/add_motif_pwm` | Add a PWM motif as a browser track. |
| `GET /api/tracks` | List loaded external/motif/annotation tracks. |
| `POST /api/tracks/batch` | Fetch multiple signal/annotation track payloads in one request. |
| `POST /api/tracks/reorder` | Reorder visible tracks. |

For a user asking "what motifs overlap this footprint", query loaded motif
track intervals when available. If no motif tracks exist, suggest adding or
scanning a motif library first.

### Footprint, Co-Accessibility, And Contacts

| Endpoint | Use |
|---|---|
| `POST /api/footprint/analyze` | Run footprint size/position/co-occurrence analysis using selected reads/peaks/groups. |
| `POST /api/footprint/rules/save` | Save portable footprint rule definitions. File paths are blocked from Copilot. |
| `POST /api/footprint/rules/load` | Load portable footprint rules. File paths are blocked from Copilot. |
| `GET /api/coacc/matrix/data` | Compute co-accessibility matrix values. |
| `GET /api/coacc/matrix/image` | Render co-accessibility matrix image. |
| `GET /api/coacc/slice` | Query a co-accessibility slice. |
| `GET /api/coacc/arcs` | Query co-accessibility arcs. |
| `GET /api/microc/matrix/data` | Query Micro-C matrix data. |
| `GET /api/dafc/select` | Query contacts/linked reads for a selected contact-map rectangle. |
| `GET /api/microc/virtual4c` | Query virtual 4C profiles. |
| `GET /api/linked/sessions` | Inspect linked/split-view sessions. |

### Sessions And Reproducibility

| Endpoint | Use |
|---|---|
| `POST /api/session/export` | Export a full browser session. |
| `POST /api/session/import` | Import a full browser session. |
| `GET /api/jupyter/session_manifest` | Inspect portable session/analysis manifest. |
| `GET /api/jupyter/selection` | Get selected reads. |
| `POST /api/jupyter/selection` | Push selected reads into the live browser. |
| `GET /api/jupyter/browser_order` | Get current top-to-bottom viewer order where available. |
| `GET /api/jupyter/order` / `POST /api/jupyter/order` | Get or set explicit notebook-controlled read order. |

A reproducible analysis record should include: genome, region, dataset IDs and
labels, selected/locked peaks, peak rules, cluster settings, random seed,
analysis/display/profile caps, span mode, quality filters, layer visibility,
labeling rules, selected reads, and browser command history.

## Python/Jupyter Client Map

The recommended Python interface is `browser_client.py`:

```python
from browser_client import BrowserClient

client = BrowserClient("http://localhost:8000")
client.goto_gene("eve", padding=5000)
region = client.get_region()
peaks = client.get_peaks(selected_only=False, as_dataframe=True)
settings = client.get_browser_settings()
client.set_reproducibility(seed=123, analysis_cap=5000, display_cap=2000, spanning=True)
client.set_cluster_settings(method="kmeans", k=10)
clusters = client.cluster_all(peak_regions=peaks.to_dict("records"))
client.save_browser_settings_json("browser_settings.json")
```

Use the client when scripting reproducible notebooks because it wraps the same
endpoints used by the GUI and preserves browser-sync conventions. Useful method
families include:

| Client methods | Purpose |
|---|---|
| `goto`, `goto_gene`, `get_region` | Navigate and inspect viewport. |
| `get_reads`, `get_compact_reads`, `get_working_set_info` | Pull working/display reads. |
| `get_peaks`, `save_peaks_bed`, `import_peaks_bed`, `set_peak_rules` | Reproduce peak sets. |
| `get_analysis_rules`, `set_analysis_rules`, `cluster_by_feature_rule`, `sort_by_analysis_rule`, `filter_by_analysis_rule` | Script the Analysis Rules panel. |
| `cluster_all`, `get_clusters`, `get_clusters_tsv`, `assign_to_clusters`, `auto_cull_clusters`, `get_cluster_projection` | Cluster and export assignments, including cluster feature rules. |
| `sort_reads`, `sort_by_transcription_state`, `get_browser_read_order`, `get_read_stats_tsv` | Preserve visible read order in exports. |
| `get_browser_settings`, `apply_browser_settings`, `set_reproducibility` | Round-trip browser state. |
| `get_primer_cart`, `set_primer_cart`, `format_primer_order`, `save_primer_order` | Read/write the Primer Design cart and export vendor order files. |
| `search_motifs`, `load_custom_motif`, `add_motif_pwm_track` | Motif analysis/tracks. |
| `analyze_footprints`, `save_footprint_rules`, `save_derived_layers` | Footprint analysis/rules. |
| `get_coacc_matrix`, `get_microc_matrix`, `get_linked_session` | Contact/co-accessibility/split-view workflows. |
| `get_copilot_capabilities`, `plan_natural_language_command`, `stream_natural_language_command`, `set_copilot_backend` | Script local Copilot planning/backends from notebooks. |
| `render`, `render_view` | Scripted image/PDF-style exports. |

See `JUPYTER_INTEGRATION.md` for notebook examples and the complete method list.

## How the Copilot plans (3.0)

The Copilot teaches; it does not run analyses. A plan is a short walkthrough:
it may navigate and open panels, tabs and sidebar sections, then points at each
control with an explanation. The user clicks the controls that run something
(scan, cluster, filter, sort, merge, load or remove files, rules, primers,
export).

1. Decide whether the question is a how-to or a troubleshooting question
   ("why are no reads visible?"). For troubleshooting, explain the first
   blocking cause in the request's **Diagnostics** and point at its fix.
2. Use only the allowed actions: `explain`, `try_it`, `open_panel`,
   `close_panel`, `open_sidebar`, `navigate_gene`, `navigate_region`,
   `zoom_view`, `pan_view`, `reset_view`, `go_to_top_locus`. Any other action
   is dropped from the plan with a note naming the control that runs it.
3. Point only at anchor ids from the catalog (`browser/frontend/src/data/tutorialAnchors.json`)
   and use only the milestones and conditions it lists. An anchor marked
   `[needs X]` exists only while X holds: put a `try_it` that produces X first,
   or a `"requires": "X"`.
4. Put a `try_it` (the user's turn, waiting for a milestone such as `clustered`)
   before any step that explains results the user has to produce first. Use
   `skip_if` to drop steps the user has already done.
5. Keep 3–12 steps, preserve exact gene names and coordinates, and never
   invent numbers or results.

## Example Plans

User: `how do I cluster the reads at the eve promoter?`

```json
{
  "summary": "Go to eve, scan and select a peak, then cluster on it.",
  "actions": [
    {"type":"navigate_gene","gene":"eve","padding_bp":5000},
    {"type":"try_it","text":"Click Scan to find the accessible peaks in this view.","anchor":"scan-peaks-button","wait_for":"peaks_scanned","skip_if":"has_peaks"},
    {"type":"try_it","text":"Click the peak over the promoter to select it.","anchor":"peaks-track","wait_for":"peak_selected","skip_if":"has_selected_peak"},
    {"type":"explain","text":"Pick the method and K here; K-means usually works best.","anchor":"cluster-method"},
    {"type":"try_it","text":"Click Cluster.","anchor":"cluster-button","wait_for":"clustered"},
    {"type":"explain","text":"The Clusters panel lists the clusters with their profiles.","anchor":"clusters-overview","panel_type":"cluster-detail","tab":"overview"}
  ],
  "warnings": []
}
```

User: `how do I change the genome?`

```json
{
  "summary": "The genome list is in the sidebar's Reference & Tracks section.",
  "actions": [
    {"type":"open_sidebar","section":"genome"},
    {"type":"explain","text":"Choose a genome here; FiberBrowser downloads its FASTA and annotation once.","anchor":"genome-selector"},
    {"type":"explain","text":"Or load your own FASTA and annotation here.","anchor":"reference-files"}
  ],
  "warnings": []
}
```

The Jupyter bridge, the guided tour and the headless API still run the full
set of typed browser actions listed under [Copilot Fast Context](#copilot-fast-context).
