# Jupyter / Python API

[← Docs index](index.md) · [← README](../README.md)

`browser_client.py` is a Python client for a running FiberBrowser. It works in
both directions: a notebook can navigate the live browser, pull reads and
analysis results, push filters, highlights, peaks, rules and settings, and
render figures; the browser keeps its viewport, selected reads, read order,
peaks, clusters, rules and settings synced back so Python can read them. The
methods call the same HTTP API as the UI, so notebook and browser results match.

For longer worked examples see [JUPYTER_INTEGRATION.md](../JUPYTER_INTEGRATION.md).
The HTTP endpoints themselves are covered in the
[Browser API guide](browser_api_guide.md).

## Connect

```python
import sys
sys.path.append("/path/to/FiberBrowser")      # the folder that holds browser_client.py

from browser_client import BrowserClient, connect

client = BrowserClient("http://localhost:8000")   # or: client = connect()
print(client.get_region())
```

`BrowserClient(url)` checks `/api/status` and raises `ConnectionError` if no
server answers.

## Quick example

```python
client.goto_gene("NAPA")
reads = client.get_reads()                     # DataFrame: id, intervals, n_footprints, ...

# Reproducible settings in the live browser
client.set_reproducibility(seed="paper-v1", analysis_cap=20000, display_cap=600, spanning=True)
client.set_visible_layers(tf=True, nuc=True, fire=False)
client.set_display_settings(fill_read_height=True, show_coverage_histogram=True)

# Highlight reads with many footprints
busy = reads[reads["n_footprints"] > 10]["id"].tolist()
client.highlight_reads(busy, color="#ff0000", label="many footprints")

# Export read statistics in the order shown in the browser
dataset_id = client.get_default_dataset_id()
order = client.get_browser_read_order(dataset_id)
client.save_read_stats_tsv("read_stats.tsv", {dataset_id: order})
```

## Headless server

`BrowserClient.headless(...)` starts a server in a subprocess, waits for it, and
returns a connected client. Use it as a context manager so the server stops at
the end. The Copilot is off by default in headless mode.

```python
with BrowserClient.headless(bam="footprints.bam", gtf="genes.gtf", fasta="genome.fa") as client:
    client.goto("chr19", 47_514_000, 47_518_000)
    peaks = client.scan_peaks()
    client.save_figure("region.png")
```

Without `with`, call `client.close()` to stop the server.

## Figures

| Call | Output |
|------|--------|
| `figure(region=None, *, format='png', scale=2.0, session=None, ...)` | Bytes of a PNG, SVG or PDF of the browser's view (the **Export** button). By default the open tab's current view; pass `region="chr1:1-2000"` for another region with the same setup, or `session=` (path or dict) to render a saved session. |
| `save_view(filepath, region=None, **kwargs)` | `figure()` written to a file; format from the extension. |
| `render_view(region=None, **kwargs)` | `figure()` as a PIL image, for display in Jupyter. |
| `render(chrom=None, start=None, end=None, ...)` | A PIL image drawn on the server from the tab's state (or defaults). |
| `save_figure(filepath, **render_kwargs)` | `render()` written to a file. |

```python
client.save_view("fig1a.pdf")                                   # what the browser shows
client.save_view("fig1b.png", "chr19:47,514,000-47,518,000", scale=4)
client.save_view("fig1c.svg", session="figure1.json")
```

`figure()` uses `engine="headless"` (drawn in Python on the server) by default.
`engine="browser"` drives the real app in headless Chromium and needs Node and
Playwright.

## Panels

`open_panel(panel_type)` and `close_panel(panel_type)` accept a panel id or an
alias. `known_panel_types()` lists the ids:

| Panel on screen | Id | Some aliases |
|-----------------|----|--------------|
| Clusters | `cluster-detail` | `clusters`, `cluster` |
| Rules | `cluster-features` | `rules`, `analysis-rules` |
| Co-accessibility | `co-accessibility` | `coacc` |
| Footprints | `footprint-analysis` | `footprints` |
| Peak Detection | `peak-detection` | `peaks` |
| Transcription | `transcription-state` | `transcription` |
| Labeling | `colormap` | `labeling`, `quality` |
| Read Stats | `read-stats` | `stats`, `reads` |
| Tracks | `track-browser` | `tracks` |
| Annotations | `annotations` | `annotation` |
| Contacts | `contact-map` | `contact`, `dafc`, `microc` |
| Primers | `primer-design` | `primers` |
| Capture Regions | `capture` | |
| Tutorial | `history` | |
| Regions | `circular-genome` | `plasmid`, `navigator`, `circular` |

## Method reference

All methods are on `BrowserClient`. Region arguments (`chrom`, `start`, `end`)
default to the browser's current view when omitted. Most analysis methods take
`dataset_id` / `dataset_ids` (default: the first loaded dataset), `spanning`
(only reads covering the whole region), and `sample_seed` (reproducible
sampling). Long signatures are shortened with `…`; use `help(client.method)` for
the full argument list and docstring.

### Connection and status

| Method | Description |
|--------|-------------|
| `headless(bam=None, gtf=None, fasta=None, fire=None, dataset=None, port=None, timeout=30, quiet=True, …, **kwargs)` *(class method)* | Start a FiberBrowser server as a subprocess and connect to it. |
| `close()` | Close the HTTP session and shut down the headless server subprocess (if any). |
| `get_status()` | Get browser status info. |
| `get_region()` | Get the current viewport region. |
| `get_live_view()` | What the open browser tab shows (region, track-area size, age). |
| `refresh()` | Force browser to refresh the current view. |
| `clear_all()` | Clear all Jupyter-controlled state (highlights, ordering, markers, etc.). |
| `clear_cache()` | Clear all server-side read caches to force fresh data loading. |
| `get_cache_status()` | Get cache directory and per-genome cache status. |

### Navigation

| Method | Description |
|--------|-------------|
| `goto(chrom, start, end)` | Navigate the browser to a specific region. |
| `goto_gene(gene_name, padding=2000)` | Navigate to a gene by name. |
| `autozoom(distance=1000, chrom=None, start=None, end=None, spanning=False, **kwargs)` | Find the optimal window that maximizes spanning reads. |
| `queue_browser_actions(actions, label='Python')` | Queue UI-equivalent actions for the active browser frontend to execute. |
| `drive_browser(*, session=None, seed=None, analysis_cap=None, display_cap=None, spanning=None, peaks=None, …)` | Apply a reproducible browser state bundle from a notebook. |

### Datasets, files and sessions

| Method | Description |
|--------|-------------|
| `get_datasets()` | Get list of loaded datasets. |
| `get_default_dataset_id()` | Return the first loaded dataset ID, or None when no dataset is loaded. |
| `resolve_dataset_id(dataset_id=None)` | Resolve omitted or legacy `primary` aliases to the first loaded dataset. |
| `add_dataset(path=None, paths=None, url=None, label=None)` | Add a new dataset (BAM, BigBed file(s), or remote URL). |
| `add_dataset_url(url, label=None)` | Add a remote BAM/BigBed dataset via the URL convenience endpoint. |
| `remove_dataset(dataset_id)` | Remove a dataset. |
| `refresh_dataset_capabilities(dataset_id=None)` | Re-detect a loaded dataset's available layers and clear stale read caches. |
| `merge_datasets(dataset_ids, merged_label=None)` | Merge multiple datasets into one combined view. |
| `unmerge_datasets(dataset_id)` | Unmerge a previously merged dataset. |
| `diagnose_bam(bam_path=None, dataset_idx=None, chrom=None, limit=10)` | Diagnose BAM file tags and capabilities. |
| `load_folder(path)` | Load a folder dataset via the same endpoint used by the UI. |
| `pick_folder()` | Open the backend folder picker. |
| `pick_file(file_type='gtf')` | Open the backend file picker for a specific file type. |
| `pick_dataset()` | Pick one or more dataset files. |
| `pick_any_file()` | Pick one or more supported data files. |
| `pick_overlay_file(overlay_type=None)` | Pick an overlay file, optionally constrained by overlay type. |
| `pick_annotation_file()` | Pick an annotation BigBed file. |
| `pick_file_primer(file_type)` | Pick primer-design support files (`fasta` or `blast`). |
| `upload_file(file_path)` | Upload a local file to the browser process. |
| `save_session(filepath, chrom=None, start=None, end=None, include_frontend_state=True)` | Export the current browser session to a JSON file. |
| `load_session(filepath, path_mapping=None, search_root=None)` | Import a browser session from a JSON file. |
| `check_session_files(filepath, search_root=None, mapping=None)` | List a session's input files and whether each exists on this computer. |
| `get_session_manifest()` | Return the latest browser-synced reproducibility/session manifest. |
| `save_session_manifest(filepath, text=False)` | Save the latest session manifest as JSON or a simple text report. |
| `format_session_manifest(manifest)` *(static)* | Format a browser session manifest for lab notes or methods sections. |

### Reference genome, genes and sequence

| Method | Description |
|--------|-------------|
| `get_genomes()` | Get list of available online genomes. |
| `load_genome(genome_id)` | Load an online genome (remote FASTA + cached GTF). |
| `load_fasta(path)` | Load a reference FASTA file at runtime. |
| `set_fasta(fasta_path)` | Set reference genome FASTA file for sequence extraction. |
| `load_gtf(path)` | Load a GTF or GFF3 annotation file. |
| `remove_gtf()` | Remove loaded GTF annotations. |
| `get_chroms()` | Get list of chromosomes with sizes. |
| `get_genes(chrom=None, start=None, end=None)` | Get gene annotations in a region. |
| `search_gene(query)` | Search for a gene by name. |
| `get_sequence(chrom, start, end)` | Get reference DNA sequence for a region (max 10kb). |
| `load_plasmid(path)` | Load a native plasmid/genome map as a supplemental chromosome. |
| `load_plasmids(paths)` | Load multiple native plasmid/genome maps as supplemental chromosomes. |
| `set_circular_chrom(chrom, circular=True)` | Mark or unmark a loaded chromosome/reference as circular. |

### Reads

| Method | Description |
|--------|-------------|
| `get_reads(dataset_id=None, spanning=True, min_footprints=0, as_dataframe=True, sample_seed=None)` | Get reads from the browser's WORKING SET (same reads used for analysis). |
| `get_jupyter_reads(dataset_id, chrom=None, start=None, end=None, sample_seed=None)` | Frontend-name wrapper for `/api/jupyter/reads`. |
| `get_compact_reads(chrom=None, start=None, end=None, dataset_id=None, spanning=True, …)` | Get compact read data with intervals and per-type modification marks. |
| `get_all_reads(chrom=None, start=None, end=None, dataset_id=None, spanning=True, …)` | Get all compact reads for one dataset. |
| `get_all_reads_response(chrom=None, start=None, end=None, dataset_id=None, spanning=True, …)` | Get the raw compact-all response, including per-dataset count metadata. |
| `get_reads_with_clusters(dataset_id=None, spanning=True)` | Get reads with cluster assignments merged in. |
| `get_working_set_info(chrom=None, start=None, end=None, dataset_id=None, spanning=False, sample_seed=None)` | Get info about the working set for a region. |
| `get_read_info(chrom=None, start=None, end=None, spanning=False)` | Get read count for a region. |
| `get_coverage(chrom=None, start=None, end=None, dataset_id=None, bins=500)` | Get per-bin read coverage for a region. |
| `get_reads_image(chrom=None, start=None, end=None, dataset_id=None, width=2000, height=None, spanning=True)` | Get reads rendered as a PNG image (server-side). |
| `get_custom_reads(dataset_id)` | Get reads previously pushed from Python/Jupyter for a custom dataset. |
| `push_reads(matrix=None, index_df=None, reads_df=None, label='Jupyter')` | Push custom reads to display in browser. |
| `clear_pushed_reads()` | Clear all pushed custom reads. |
| `to_matrix(reads_df, region_width=None)` *(static)* | Convert interval-based reads DataFrame to position matrix. |
| `from_matrix(matrix, index_df=None)` *(static)* | Convert position matrix back to interval-based DataFrame. |
| `reorder_reads(reads_df, new_order)` *(static)* | Reorder reads DataFrame by row indices. |

### Modifications, deamination and layer quality

| Method | Description |
|--------|-------------|
| `get_available_mods(dataset_id=None)` | Report which modification layers the backend has detected. |
| `get_modifications(mod_type='m6a', chrom=None, start=None, end=None, dataset_id=None, spanning=True, …)` | Return per-read modification positions for the current viewport. |
| `get_deam_by_strand(strand, chrom=None, start=None, end=None, dataset_id=None, spanning=True, **kwargs)` | Deamination positions filtered to a single strand flavor. |
| `count_modifications(mod_type='m6a', chrom=None, start=None, end=None, dataset_id=None, spanning=True, …, **kwargs)` | Per-read mark count for the given modification type. |
| `scan_mod_peaks(mod_type='m6a', chrom=None, start=None, end=None, dataset_id=None, spanning=True, **kwargs)` | Peak-call on per-base modification density. |
| `cluster_by_mod(mod_type='m6a', k=5, method='kmeans', chrom=None, start=None, end=None, spanning=False, …, **kwargs)` | Scan peaks on modification density, then cluster reads by them. |
| `get_interval_qualities(layer, quality_name=None, chrom=None, start=None, end=None, dataset_id=None, …)` | Pull per-interval quality arrays for one layer. |
| `filter_reads_by_quality(layer, quality_name, min=None, max=None, mode='any', chrom=None, start=None, …)` | Return read IDs whose layer intervals pass a quality gate. |
| `get_quality_filters()` | Return active backend interval-quality filters. |
| `set_quality_filters(filters)` | Set backend quality filters used by working sets and analyses. |
| `add_quality_filter(layer, quality_name, min_value, replace=False)` | Append one backend quality filter, optionally replacing all existing filters. |
| `clear_quality_filters()` | Disable all backend interval-quality filters. |
| `get_quality_impact(chrom=None, start=None, end=None, filters=None, dataset_ids=None)` | What each quality filter keeps in a region, and which scores the data carries. |
| `set_class_support(min_value, layers=None, chrom=None, start=None, end=None)` | Filter footprint-class calls by class support (q0, 0-255); `None` turns it off. |
| `get_overlays()` | Get list of loaded modification overlays. |
| `add_overlay(path, overlay_type=None)` | Add a modification overlay from a bigBed file. |
| `remove_overlay(overlay_id)` | Remove a modification overlay. |
| `get_overlay_marks(overlay_id, chrom=None, start=None, end=None)` | Get modification marks from an overlay for a region. |

### Metaprofiles and FIRE

| Method | Description |
|--------|-------------|
| `get_meta(chrom=None, start=None, end=None, dataset_id=None, read_ids=None)` | Get meta profile (nucleosome and small-footprint occupancy) for a region. |
| `get_meta_all(chrom=None, start=None, end=None, dataset_ids=None, spanning=False)` | Get metaprofiles for all datasets at once. |
| `get_fire(chrom=None, start=None, end=None)` | Get FIRE peaks and signal for a region. |

### Peaks

| Method | Description |
|--------|-------------|
| `scan_peaks(chrom=None, start=None, end=None, dataset_id=None, dataset_ids=None, spanning=False, …, **kwargs)` | Scan for peaks using multi-threshold detection. |
| `detect_peaks(chrom=None, start=None, end=None, signal_source='accessibility', threshold_strong=0.5, …)` | Auto-detect peaks from signal tracks. |
| `detect_signal_peaks(signal, chrom, start, end, label='', min_distance=100, min_width=80, …)` | Detect peaks from an arbitrary numeric signal array. |
| `make_peaks(regions, mode='accessibility')` *(static)* | Create peak region dicts for clustering from simple coordinate tuples. |
| `get_peaks(selected_only=False, as_dataframe=True)` | Get peak coordinates from browser. |
| `set_peaks(peaks, chrom=None, label=None, lock=True, select=True, replace_existing=True)` | Push a peak set into the live browser and optionally lock it. |
| `get_peak_state()` | Return browser-synced peak rules, locked peaks, and selected peaks. |
| `set_peak_rules(rules, lock=None, clear_peaks=True, rescan=False)` | Push exact peak-rule settings into the live browser. |
| `set_peak_lock(locked=True)` | Set the live browser peak-lock state without changing peak rules. |
| `lock_peaks()` | Lock current browser peaks so autoscan cannot move them. |
| `unlock_peaks()` | Unlock current browser peaks so peak rules can rescan. |
| `load_peak_rules_json(filepath, lock=None, clear_peaks=True, rescan=False)` | Load a Peak Rules JSON export into the live browser. |
| `format_peak_bed(peaks)` *(class method)* | Format peaks as FiberBrowser BED6+ text. |
| `get_peaks_bed(selected_only=False)` | Return current browser peaks as FiberBrowser BED6+ text. |
| `save_peaks_bed(filepath, selected_only=False)` | Write current browser peaks as FiberBrowser BED6+ and return the path. |
| `parse_peak_bed(text)` *(static)* | Parse BED3/BED6 or FiberBrowser BED6+ peak text into peak dicts. |
| `load_peak_bed(filepath, as_dataframe=True)` *(class method)* | Load BED3/BED6 or FiberBrowser BED6+ peaks from disk. |
| `peak_bed_regions(filepath, mode='accessibility')` *(class method)* | Load a BED file as `cluster_all(peak_regions=...)` region dicts. |
| `import_peaks_bed(filepath, chrom=None, label=None, lock=True, select=True, replace_existing=True, …)` | Load a BED3/BED6/FiberBrowser BED6+ peak file into the live browser. |
| `get_peak_sequences(peaks=None, extend=0, strand='+', as_dataframe=True)` | Extract DNA sequences for peaks. |
| `get_selected_peak_sequences(extend=0, strand='+')` | Convenience method: get sequences for selected peaks only. |

### Clustering

| Method | Description |
|--------|-------------|
| `cluster(peak_indices, k=5, chrom=None, start=None, end=None, spanning=False, dataset_id=None, …)` | Cluster reads for a single dataset using k-means. |
| `scan_and_cluster(k=5, method='kmeans', signal_source='accessibility', min_layer=0, max_layer=None, …, **kwargs)` | Convenience: scan peaks + cluster in one call. |
| `cluster_all(peak_regions=None, k=5, method='combinatorial', dataset_ids=None, chrom=None, start=None, …, **kwargs)` | Cluster reads across multiple datasets. |
| `cluster_all_reads(chrom, start, end, peak_regions, k, spanning, dataset_ids, method='kmeans', …)` | Alias matching the frontend `clusterAllReads` helper. |
| `cluster_synced_peaks(chrom=None, start=None, end=None, dataset_ids=None, method=None, k=None, …)` | Run `cluster_all` using the browser-synced locked/selected peaks. |
| `cluster_selected_peaks_in_browser(label='Python')` | Ask the live browser to run its normal Cluster button workflow. |
| `cluster_peak_at_gene_tss_in_browser(gene_name, padding=5000, tolerance_bp=500, label='Python')` | Ask the live browser to cluster on the peak overlapping a gene TSS. |
| `cluster_by_feature_rule(rule, chrom=None, start=None, end=None, spanning=False, dataset_ids=None, …, **kwargs)` | Cluster reads using a Rules > Cluster feature rule. |
| `cluster_by_annotations(annotation_types, peak_regions=None, method='combinatorial', k=5, chrom=None, …)` | Cluster reads based on annotation overlap patterns. |
| `cluster_by_footprints(groups=None, chrom=None, start=None, end=None, dataset_ids=None)` | Cluster reads by which footprint definitions they carry, without the browser. |
| `cluster_by_saved_footprints_in_browser(label='Python')` | Ask the live browser to cluster reads by which saved footprints they carry. |
| `get_clusters(dataset_id=None)` | Get cluster assignments (if clustering was performed in browser). |
| `get_cluster_state()` | Return browser-synced cluster assignments, cluster order, and read order. |
| `get_clusters_tsv(dataset_ids=None, include_patterns=True, include_provenance=False, provenance=None)` | Export cluster assignments as the same ordered TSV schema used by the UI. |
| `save_clusters_tsv(filepath, dataset_ids=None, include_patterns=True, include_provenance=False, …)` | Write `get_clusters_tsv()` output to `filepath` and return the path. |
| `get_element_info(dataset_id=None)` | Get element/peak information from combinatorial clustering. |
| `decode_cluster(cluster_id, dataset_id=None)` | Decode a cluster ID to show which elements are accessible. |
| `get_reads_for_element(element_idx, dataset_id=None)` | Get read IDs where a specific element is accessible. |
| `auto_cull_clusters(chrom=None, start=None, end=None, assignments=None, peak_regions=None, …)` | Auto-cull low-abundance and similar clusters. |
| `dissolve_cluster(cluster_id, assignments, peak_regions, dataset_ids=None, chrom=None, start=None, …, **kwargs)` | Dissolve a cluster by reassigning its reads to the nearest remaining clusters. |
| `assign_to_clusters(cluster_patterns, peak_regions, dataset_ids=None, chrom=None, start=None, end=None, …, **kwargs)` | Assign reads to existing cluster patterns (for dynamic clustering). |
| `expand_cluster(cluster_ids, chrom=None, start=None, end=None, spanning=False, max_reads=500, …)` | Expand clusters to get reads from all datasets matching the pattern. |
| `get_cluster_vplot(chrom=None, start=None, end=None, spanning=False, size_bin=10, pos_bin=10, size_min=10, …)` | Get V-plot data (footprint size vs. |
| `get_cluster_projection(peak_regions, dataset_ids=None, chrom=None, start=None, end=None, spanning=False, …)` | Project clustered reads into PCA/UMAP/t-SNE coordinates. |

### Analysis rules, sorting and filtering

| Method | Description |
|--------|-------------|
| `get_analysis_rules()` | Return browser-synced Rules panel definitions. |
| `set_analysis_rules(cluster_feature_rules=None, analysis_sort_rules=None, analysis_filter_rules=None)` | Replace Rules panel definitions from Python/Jupyter. |
| `set_cluster_feature_rules(rules)` | Replace Cluster tab feature rules in the Rules panel. |
| `set_analysis_sort_rules(rules)` | Replace Sort tab rules in the Rules panel. |
| `set_analysis_filter_rules(rules)` | Replace Filter tab rules in the Rules panel. |
| `save_analysis_rules_json(filepath)` | Save browser-synced cluster/sort/filter analysis rules as JSON. |
| `load_analysis_rules_json(filepath)` | Load a JSON file written by `save_analysis_rules_json` or the UI. |
| `resolve_analysis_rule_windows(rule, chrom=None, start=None, end=None, peaks=None, selected_peaks=None, …)` | Resolve a Rules scope to absolute genomic windows. |
| `resolve_cluster_feature_rule_regions(rule, chrom=None, start=None, end=None, peaks=None, …)` | Resolve a Cluster Analysis Rule to `cluster_all` peak regions. |
| `sort_reads(sort_by='fp_count', chrom=None, start=None, end=None, spanning=False, **kwargs)` | Sort reads/clusters by a metric. |
| `sort_by_analysis_rule(rule, chrom=None, start=None, end=None, spanning=False, dataset_ids=None, …)` | Run the same backend sort used by a Rules > Sort entry. |
| `sort_by_transcription_state(gene_ids, state_kind='elongating', chrom=None, start=None, end=None, …)` | Sort reads by a Pol II state metric using Transcription-panel definitions. |
| `filter_by_analysis_rule(rule=None, chrom=None, start=None, end=None, spanning=False, dataset_ids=None, …)` | Filter reads with the Rules backend endpoint. |
| `pin_analysis_filter_result(result)` | Pin a `filter_by_analysis_rule` response as the browser's active per-dataset read filter (one /api/jupyter/filter POST per dataset). |
| `filter_reads_by_ids(read_ids, dataset_id=None)` | Pin a specific set of read IDs as the browser's display filter. |
| `filter_by_peaks(peak_regions=None, peak_indices=None, filter_mode='either', dataset_id=None, chrom=None, …)` | Filter reads by peak region overlap. |
| `filter_by_annotations(annotation_types, filter_mode='has_any', chrom=None, start=None, end=None, …)` | Filter reads by annotation overlap. |

### Filtering, selection, order and highlights in the live browser

| Method | Description |
|--------|-------------|
| `filter_reads(read_ids, dataset_id=None)` | Filter browser view to show only specified reads. |
| `get_read_filter(dataset_id=None)` | Get the active Jupyter-controlled read filter for a dataset. |
| `clear_filter(dataset_id=None)` | Clear read filter, show all reads. |
| `get_selection(dataset_id=None)` | Get read IDs selected by user/browser or Python selection commands. |
| `set_jupyter_selection(read_ids, dataset_id=None)` | Set the read IDs selected in the live browser from Python/Jupyter. |
| `get_jupyter_state()` | Get full Jupyter integration state (for debugging). |
| `set_read_order(read_ids, dataset_id=None)` | Set custom read ordering. |
| `get_read_order(dataset_id=None)` | Get current custom read ordering. |
| `get_browser_read_order(dataset_id=None)` | Get the latest top-to-bottom read order reported by the browser. |
| `clear_read_order(dataset_id=None)` | Reset to default read ordering. |
| `highlight_reads(read_ids, color='#ff0000', label=None, dataset_id=None)` | Highlight specific reads with a color. |
| `highlight_footprints(footprints, color='#ff0000', label=None, dataset_id=None)` | Highlight specific footprints. |
| `get_highlights()` | Get all current highlights. |
| `remove_highlight(highlight_id)` | Remove a specific highlight by ID. |
| `clear_highlights(group=None)` | Clear read highlights. |
| `color_footprints(footprint_colors, group='default')` | Color specific footprints on specific reads. |
| `get_footprint_colors()` | Get all current Jupyter-controlled footprint color groups. |
| `remove_footprint_colors(color_id)` | Remove a specific footprint color group by ID. |
| `clear_footprint_colors(group=None)` | Clear footprint colorings. |
| `add_markers(positions, group='default')` | Add position markers (vertical lines) to the view. |
| `get_markers()` | Get all current Jupyter-controlled marker groups. |
| `remove_marker(marker_id)` | Remove a specific marker group by ID. |
| `clear_markers(group=None)` | Clear position markers. |

### Transcription state

| Method | Description |
|--------|-------------|
| `get_transcription_state_selection()` | Return selected genes and filter settings synced from the browser. |
| `set_selected_genes(genes)` | Replace the live browser's selected genes used by Pol II analyses. |
| `set_transcription_state_filters(filters)` | Replace the Transcription panel filter settings. |
| `filter_by_transcription_state(gene_ids, filters=None, chrom=None, start=None, end=None, spanning=False, …)` | Filter reads by transcription state criteria relative to gene(s). |
| `get_transcription_state_counts(gene_ids, chrom=None, start=None, end=None, spanning=False, …)` | Fetch the same state-count summary used when the browser panel opens. |
| `get_pol2_com(gene_ids, dataset_ids=None, fp_size_min=35, fp_size_max=65, n_bins=100, chrom=None, …)` | Pol II center-of-mass heatmap data sorted by COM position. |

### Footprints

| Method | Description |
|--------|-------------|
| `analyze_footprints(chrom=None, start=None, end=None, dataset_id=None, read_ids=None, footprints=None, …)` | Run footprint analysis on explicit footprint regions. |
| `format_footprint_cooccurrence_tsv(result, groups, datasets=None)` *(class method)* | Format Footprints co-occupancy output as TSV. |
| `save_footprint_cooccurrence_tsv(filepath, result, groups, datasets=None)` | Write Footprints co-occupancy output to a TSV file. |
| `get_footprint_rules()` | Return browser-synced saved footprint list (Footprints > Saved) rules. |
| `get_footprint_rule_summary()` | Return the session-manifest summary of saved footprint list (Footprints > Saved) rules. |
| `set_footprint_rules(groups)` | Replace the live browser saved footprint list (Footprints > Saved) from Python. |
| `save_footprint_rules(output_dir, groups=None, chrom=None, start=None, end=None, dataset_id=None, …)` | Save saved footprint list (Footprints > Saved) definitions as portable rule JSON. |
| `load_footprint_rules(path, apply=True, append=False)` | Load portable saved footprint list (Footprints > Saved) rules from JSON. |
| `save_derived_layers(output_dir, groups=None, chrom=None, start=None, end=None, dataset_id=None, …)` | Save footprint cart definitions as materialized `.fiberlayers` bundles. |
| `load_derived_layers(path, dataset_id=None, dataset_ids=None)` | Load a saved `.fiberlayers` bundle into matching loaded datasets. |

### Read statistics

| Method | Description |
|--------|-------------|
| `get_read_stats(read_ids_by_dataset, chrom=None, start=None, end=None, spanning=False, as_dataframe=True, …)` | Get per-read alignment and footprint statistics. |
| `get_read_stats_tsv(read_ids_by_dataset, chrom=None, start=None, end=None, spanning=False, …)` | Return selected read stats as TSV in browser/table viewer order. |
| `save_read_stats_tsv(filepath, read_ids_by_dataset, chrom=None, start=None, end=None, spanning=False, …)` | Write `get_read_stats_tsv()` output to `filepath` and return the path. |

### Browser settings, labeling and panels

| Method | Description |
|--------|-------------|
| `set_reproducibility(seed=None, analysis_cap=None, display_cap=None, spanning=None, display_mode=None, …)` | Push global browser reproducibility/display controls from a notebook. |
| `set_cluster_settings(method=None, k=None, small_footprint_threshold_bp=None, …)` | Push browser clustering controls from a notebook. |
| `set_display_settings(enabled_mod_types=None, enabled_meta_profiles=None, cached_layer_types=None, …)` | Push browser display/layer controls from a notebook. |
| `set_legacy_layer_inference(enabled=True, nuc_min_size=90)` | Configure inferred TF/nuc/FIRE layers for legacy footprint-only files. |
| `set_visible_layers(layers=None, **layer_states)` | Toggle read-level layer visibility from Python/Jupyter. |
| `set_metaprofile_layers(layers=None, **layer_states)` | Toggle metaprofile rows from Python/Jupyter. |
| `set_layer_cache(layers=None, **layer_states)` | Toggle which optional layers are prefetched into read-window caches. |
| `set_browser_settings(**kwargs)` | Push browser settings using either aliases or raw snapshot keys. |
| `get_browser_settings()` | Return the latest browser-synced reproducibility/peak settings. |
| `apply_browser_settings(settings, apply_peak_rules=True, clear_peaks=True, rescan=False)` | Apply a settings snapshot captured with `get_browser_settings`. |
| `sync_jupyter_browser_settings(settings)` | Store a browser settings snapshot using the same endpoint as the UI. |
| `save_browser_settings_json(filepath)` | Save current browser settings snapshot as JSON and return filepath. |
| `load_browser_settings_json(filepath, **kwargs)` | Load and apply a JSON settings snapshot saved from the browser. |
| `get_analysis_state()` | Return browser-synced peaks, filters, capture regions, and track cart. |
| `get_active_filters()` | Return active Labeling preset and analysis quality filters. |
| `set_labeling_preset(colormap, apply_quality_filters=True)` | Push the active Labeling preset into the live browser. |
| `get_labeling_preset()` | Return a copy of the currently synced Labeling preset. |
| `load_labeling_json(filepath, apply_quality_filters=True)` | Load a Labeling JSON export into the live browser. |
| `save_labeling_json(filepath)` | Save the currently synced browser Labeling preset as JSON. |
| `set_labeling_display(*, read_background=None, no_read_background=None, smoothing_enabled=None, …)` | Update Labeling display controls from Python/Jupyter. |
| `set_layer_opacity(layer, opacity, apply_quality_filters=True)` | Set one Labeling layer opacity from Python/Jupyter. |
| `add_labeling_rule(name, color='#888888', size_min=1, size_max=None, target_layers=None, conditions=None, …)` | Append one labeling rule to the live browser preset. |
| `add_pol2_gene_exclusion_rule(gene_name=None, gene_id=None, name=None, color='#ff69b4', size_min=35, …)` | Append a Pol II-sized footprint rule excluding one gene. |
| `normalize_panel_type(panel_type)` *(class method)* | Return the canonical browser panel id for a user-facing alias. |
| `known_panel_types()` *(class method)* | Return canonical built-in panel ids accepted by the browser strip. |
| `get_panel_state()` | Return active panels, hidden strip panels, and known built-in ids. |
| `open_panel(panel_type)` | Open an analysis panel in the live browser from Python/Jupyter. |
| `close_panel(panel_type)` | Close an analysis panel in the live browser from Python/Jupyter. |
| `set_hidden_panels(panel_types)` | Replace analysis-strip hidden panel settings. |
| `show_strip_panels(panel_types=())` | Unhide selected strip panels, or show all panels when omitted. |
| `hide_strip_panels(panel_types)` | Hide selected panels from the analysis strip without closing them. |

### Co-accessibility

| Method | Description |
|--------|-------------|
| `get_coacc_matrix(chrom=None, start=None, end=None, normalization='oe', bin_size=0, min_coverage=20, …)` | Get co-accessibility matrix as numpy array or pandas DataFrame. |
| `get_coacc_matrix_data(chrom, start, end, bin_size=None, dataset_ids=None, normalization=None, …)` | Frontend-name wrapper returning the raw co-accessibility response. |
| `get_coacc_slice(position, chrom=None, start=None, end=None, normalization='oe', bin_size=0, …)` | Get 1D co-accessibility profile from a viewpoint position (virtual 4C). |
| `get_coacc_arcs(chrom=None, start=None, end=None, threshold=1.5, normalization='oe', bin_size=0, …)` | Get top co-accessible pairs as arcs. |
| `get_coacc_metadata(chrom=None, start=None, end=None, bin_size=0, normalization='oe', min_coverage=20, …)` | Get co-accessibility metadata (n_reads, bins, coverage stats). |
| `get_coacc_image(chrom=None, start=None, end=None, normalization='oe', scaling='linear', colormap='fall', …)` | Get co-accessibility matrix as a PIL Image (heatmap). |
| `get_coacc_matrix_png(chrom=None, start=None, end=None, dataset_id=None, dataset_ids=None, …)` | Return the co-accessibility matrix PNG used by the browser panel. |
| `save_coacc_matrix_png(filepath, **kwargs)` | Save the co-accessibility matrix PNG and return `filepath`. |
| `get_coacc_strip(chrom=None, start=None, end=None, width=800, height=120, normalization='oe', …)` | Get co-accessibility triangular strip as PIL Image. |
| `get_coacc_strip_png(chrom=None, start=None, end=None, width=800, height=120, dataset_id=None, …)` | Return the compact triangular co-accessibility strip PNG used by the track. |
| `save_coacc_strip_png(filepath, **kwargs)` | Save the co-accessibility track strip PNG and return `filepath`. |
| `get_coacc_settings()` | Return browser-synced co-accessibility panel/track settings. |
| `set_coacc_settings(track_mode=None, signal_type=None, layer=None, normalization=None, scaling=None, …, **raw_settings)` | Push co-accessibility panel/track settings from Python/Jupyter. |

### Tracks and motifs

| Method | Description |
|--------|-------------|
| `get_tracks()` | Get list of loaded orthogonal tracks (bigWig, bigBed, etc.). |
| `get_tracks_batch(track_indices, chrom=None, start=None, end=None, bins=500, annotation_filters=None)` | Fetch multiple signal/annotation track payloads in one request. |
| `add_track(path, label=None, render_mode=None, track_type=None, ucsc_genome=None, ucsc_track=None, …)` | Add an orthogonal track (bigWig, bigBed, BED, or UCSC API track). |
| `remove_track(track_idx)` | Remove an orthogonal track by index. |
| `reorder_tracks(from_index, to_index)` | Move one orthogonal track from `from_index` to `to_index`. |
| `filter_track(track_idx, filter_names=None)` | Filter track annotations by one or more names; pass None/empty to clear. |
| `get_track_signal(track_idx, chrom=None, start=None, end=None, bins=500)` | Get signal values from an orthogonal track (BigWig, BED, etc.). |
| `get_track_data(track_idx, chrom=None, start=None, end=None, bins=None)` | Frontend-name wrapper returning the full track data response. |
| `get_track_annotations(track_idx, chrom=None, start=None, end=None, filter_names=None)` | Get annotation intervals from a track (BigBed, BED, motif). |
| `export_track(track_idx, chrom, start, end, format='bedgraph', bins=2000, output_path=None)` | Export one track region as bytes; optionally write to `output_path`. |
| `export_tracks_multi(track_indices, labels, chrom, start, end, bins=2000, output_path=None)` | Export multiple tracks as TSV bytes; optionally write to `output_path`. |
| `get_track_cart()` | Return browser-synced track catalog/cart/saved-presets state. |
| `set_track_cart(catalog=None, composite_tracks=None, saved_tracks=None)` | Replace browser track catalog/cart pieces from Python. |
| `get_bigbed_names(url, genome=None, sample_size=None)` | Get unique names from a BigBed-backed motif/annotation source. |
| `add_motif_track(name, sequence, threshold=0.8, render_mode=None)` | Add a motif track by DNA sequence (scans reference for matches). |
| `add_motif_pwm_track(name, counts, label=None, threshold=0.85)` | Add a motif track from a raw A/C/G/T PWM or count dictionary. |
| `add_motif_track_file(file_path, format=None, threshold=0.8)` | Add motif tracks from a file (JASPAR, MEME, PFM, HOMER). |
| `search_jaspar(query, limit=20, genome=None)` | Search JASPAR CORE by TF name or matrix ID (e.g. |
| `add_jaspar_motifs(names_or_ids, threshold=0.85)` | Add JASPAR motifs as scanned tracks, by matrix ID or TF name. |
| `list_motifs(species=None, tax_group=None, tf_family=None, name_contains=None, as_dataframe=True)` | List available JASPAR motifs with optional filtering. |
| `search_motifs(peaks=None, motifs=None, motif_ids=None, threshold=0.8, extend=0, both_strands=True, …)` | Search for TF motifs in peak sequences. |
| `load_custom_motif(name, pwm)` | Load a custom PWM for motif searching. |
| `load_custom_motifs(file_path, format='auto')` | Load motifs from a file. |
| `list_custom_motifs(as_dataframe=True)` | List all registered custom motifs. |
| `clear_custom_motifs(name=None)` | Remove custom motifs. |
| `delete_custom_motif(name)` | Remove a specific custom motif. |

### External track sources and S3

| Method | Description |
|--------|-------------|
| `get_ucsc_curated(genome)` | Get curated UCSC tracks for a genome. |
| `search_ucsc_tracks(genome, query)` | Search UCSC tracks for a genome. |
| `browse_ucsc_tracks(genome)` | Browse UCSC tracks grouped by category for a genome. |
| `get_encode_facets(genome)` | Get ENCODE search facets for a genome. |
| `search_encode(genome, assay=None, target=None, biosample=None, query=None, limit=25)` | Search ENCODE bigWig tracks. |
| `get_chipatlas_status()` | Get ChIP-Atlas metadata loading status. |
| `get_chipatlas_facets(genome)` | Get ChIP-Atlas facets for a genome. |
| `search_chipatlas(genome, antigen_class=None, antigen=None, cell_type_class=None, cell_type=None, limit=25)` | Search ChIP-Atlas tracks. |
| `get_s3_status()` | Get S3 support/configuration status. |
| `configure_s3(profile=None, region=None, endpoint_url=None)` | Configure S3 or S3-compatible storage access for this server. |
| `test_s3_access(url)` | Test access to an S3 URL such as `s3://bucket/key`. |
| `list_s3_bucket(bucket, prefix='', max_keys=100)` | List objects in an S3 bucket/prefix. |
| `get_presigned_url(url, expiration=3600)` | Generate a temporary presigned URL for an S3 object. |

### Dataset catalog

| Method | Description |
|--------|-------------|
| `get_catalog()` | Get the configured dataset catalog, if the server was launched with one. |
| `catalog_load(group_index)` | Load a catalog dataset group into the current browser session. |
| `catalog_unload(group_index)` | Unload a catalog dataset group from the current browser session. |
| `catalog_track_load(track_index)` | Load a catalog orthogonal track into the current browser session. |
| `catalog_track_unload(track_index)` | Unload a catalog orthogonal track from the current browser session. |

### Per-read annotations

| Method | Description |
|--------|-------------|
| `list_annotations()` | List loaded annotation files. |
| `add_annotation(path, label=None, dataset_ids=None)` | Add an annotation file (BED, BigBed, etc.). |
| `activate_annotation(file_id)` | Activate an annotation file for display. |
| `deactivate_annotation(file_id)` | Deactivate an annotation file from display. |
| `delete_annotation(file_id)` | Remove an annotation file. |
| `browse_annotations(directory)` | Browse annotation BigBed files in a local directory. |
| `get_annotations(chrom=None, start=None, end=None, dataset_ids=None, file_ids=None, as_dataframe=True, …)` | Get per-read annotations (e.g., FiberCNN/factorCNN predictions) in a region. |
| `get_annotation_profile(chrom=None, start=None, end=None, file_id=None, dataset_id=None, …)` | Get annotation density profile for a region. |
| `set_annotation_threshold(type_name, threshold)` | Set display threshold for an annotation type. |

### Multi-region compilation

| Method | Description |
|--------|-------------|
| `compile_regions(regions, dataset_id=None, spanning=True, max_reads_per_region=200, anchor='center', …)` | Compile reads from multiple genomic regions into a single normalized view. |
| `render_compiled(regions, width=2000, row_height=3, max_reads=500, show_mods=False, show_fire=False, …)` | Compile reads from multiple regions and render as a single PIL Image. |

### Contact maps (Micro-C / DAF-C)

| Method | Description |
|--------|-------------|
| `load_dafc(cool_file=None, bigbed_file=None)` | Load a .cool/.mcool or DAF-C BigBed file for contact analysis. |
| `get_dafc_status()` | Get DAF-C / Micro-C loading status. |
| `get_dafc_image(chrom=None, start=None, end=None, resolution=None, normalization='none', scaling='log', …)` | Get DAF-C/Micro-C contact matrix as PIL Image. |
| `select_dafc_region(chrom, x_start, x_end, y_start, y_end)` | Query a DAF-C/Micro-C selected contact region for contacts and linked reads. |
| `get_microc_matrix(chrom=None, start=None, end=None, normalization='none', resolution=None)` | Get Micro-C contact matrix data. |
| `get_microc_arcs(chrom=None, start=None, end=None, threshold=0.1, max_arcs=100, min_distance=5000, …)` | Get top Micro-C contact pairs as arcs. |
| `get_microc_virtual4c(viewpoint_start=None, viewpoint_end=None, profile_start=None, profile_end=None, …)` | Get Micro-C virtual 4C profile from a viewpoint position. |
| `get_microc_strip(chrom=None, start=None, end=None, width=800, height=120, normalization='none', …)` | Get Micro-C triangular strip as PIL Image. |
| `get_microc_apa(peaks=None, window=10000, resolution=None, chrom=None, normalization='oe', anchors=None)` | Aggregate Peak Analysis (APA) for Micro-C data. |
| `precompute_microc_expected(chrom=None, resolution=None)` | Precompute a chromosome's expected contacts for global O/E. |
| `get_microc_expected_status()` | Check status of expected value computation. |
| `create_linked_session()` | Create a linked split-view session for DAF-C or Micro-C regions. |
| `get_linked_sessions()` | List active linked split-view sessions. |
| `get_linked_session(session_id)` | Get linked split-view session state. |
| `send_to_linked_session(session_id, regions=None, read_ids=None, contact_mode=None, split_view_mode=None, …)` | Send a DAF-C/Micro-C region pair to a linked split-view session. |
| `get_linked_reads_data(session_id)` | Get raw linked read data for a split-view session. |
| `get_linked_reads_compact(session_id, region, max_reads=500, sort_by='x', hide_terminal_gaps=True, …)` | Get linked reads in compact ReadTrack format for region `'x'` or `'y'`. |
| `get_linked_reads_image(session_id, region, max_width=2000, row_height=3)` | Render linked reads for region `'x'` or `'y'` as a PIL image. |
| `delete_linked_session(session_id)` | Delete a linked split-view session. |

### Primers and capture regions

| Method | Description |
|--------|-------------|
| `get_primer_config()` | Get current primer design configuration (FASTA, BLAST DB). |
| `set_primer_config(fasta_path=None, blast_db_path=None)` | Configure primer design tool. |
| `build_primer_blast_db(force=False, output_dir=None)` | Build/select a local primer BLAST DB from the browser's loaded FASTA. |
| `design_primers(chrom=None, start=None, end=None, min_product=5000, max_product=50000, min_tm=55.0, …, **kwargs)` | Design PCR primers for a genomic region. |
| `design_dafc_primers(chrom, x_start, x_end, y_start, y_end, y_chrom=None, min_product=5000, …, **kwargs)` | Design DAF-C/3C primer pairs for two loci. |
| `design_4c_primers(chrom=None, start=None, end=None, min_spacing=50, max_spacing=500, min_tm=55.0, …, **kwargs)` | Design outward-facing 4C primers inside a viewpoint interval. |
| `get_primers()` | Get currently designed primers. |
| `get_primer_results()` | Get the raw latest primer-design result payload. |
| `get_primer_progress()` | Get progress for the active primer design job. |
| `abort_primer_design()` | Abort the active primer design job. |
| `clear_primers()` | Clear all designed primers. |
| `format_primer_order(primers=None, format='idt')` | Format primers for IDT, Azenta/GENEWIZ, Eurofins, Sigma, generic CSV, or FASTA. |
| `save_primer_order(filepath, primers=None, format='idt')` | Write a vendor primer-order file and return `filepath`. |
| `get_primer_cart()` | Return browser-synced primer cart state from the Primers panel. |
| `set_primer_cart(saved_primers=None, mode=None, cart_track_display=None)` | Replace Primer Design cart state in the live browser. |
| `get_capture_regions()` | Return browser-synced capture cart regions. |
| `set_capture_regions(regions, padding=None)` | Replace the browser capture cart from Python. |

### Copilot

| Method | Description |
|--------|-------------|
| `get_copilot_capabilities()` | Return Copilot-safe API routes, backend status, and model metadata. |
| `plan_natural_language_command(text, context=None, model=None, previous_turns=None)` | Plan a browser workflow from natural language without executing it. |
| `stream_natural_language_command(text, context=None, model=None, previous_turns=None, timeout=120)` | Yield NDJSON Copilot planning events from `/api/nl/stream`. |
| `get_copilot_agent_tools()` | Return the tool schema used by the experimental Copilot agent loop. |
| `copilot_agent_step(messages=None, text=None, context=None, model=None, previous_turns=None)` | Run one backend Copilot agent iteration. |
| `setup_copilot(model_id=None)` | Install/start the configured local Copilot model backend. |
| `probe_copilot_backends()` | Report whether MLX and Ollama Copilot backends are reachable. |
| `set_copilot_backend(backend)` | Switch the active Copilot backend to `'mlx'` or `'ollama'`. |
| `log_copilot_session(session_id=None, started_at=None, snapshots=None, command_history=None, …)` | Persist a browser session log for Copilot evaluation/training. |
| `get_copilot_share_status()` | Return local shared-usage file status. |
| `clear_copilot_shared_usage()` | Clear the local shared-usage file. |
| `reveal_copilot_shared_usage()` | Open the local shared-usage file/folder from the backend process. |
| `get_copilot_share_upload_status()` | Return whether a usage upload receiver is configured. |
| `send_copilot_shared_usage()` | Upload the local shared-usage file to the configured receiver. |

### Rendering and figures

| Method | Description |
|--------|-------------|
| `figure(region=None, *, chrom=None, start=None, end=None, session=None, load_session=False, format='png', …)` | Render a figure of the browser's view (Export button equivalent). |
| `render_view(region=None, **kwargs)` | `figure()` as a PIL image (PNG), e.g. |
| `save_view(filepath, region=None, **kwargs)` | Save `figure()` to a file; the format follows the extension (`.png`, `.svg`, `.pdf`). |
| `render(chrom=None, start=None, end=None, dataset_id=None, dataset_ids=None, tracks=None, width=None, …, **kwargs)` | Render the browser's view of a region as a PIL Image, headlessly. |
| `save_figure(filepath, **render_kwargs)` | Render the browser's view headlessly (see `render()`) and save it. |

### Aliases

These names call the method shown, or wrap the same endpoint with the frontend's name.

| Alias | Description |
|-------|-------------|
| `save_cluster_assignments_tsv` | Alias for `save_clusters_tsv`. |
| `set_read_filter` | Explicit alias for `filter_reads` used by notebook workflows. |
| `clear_read_filter` | Explicit alias for `clear_filter`. |
| `plan_copilot_command` | Alias for `plan_natural_language_command`. |
| `stream_copilot_command` | Alias for `stream_natural_language_command`. |
| `remove_footprint_color` | Alias for `remove_footprint_colors`. |
| `get_browser_order` | Alias for `get_browser_read_order`. |
| `sync_browser_settings` | Alias for `sync_jupyter_browser_settings`. |
| `set_colormap` | Backward-compatible alias for `set_labeling_preset`. |
| `load_colormap_json` | Backward-compatible alias for `load_labeling_json`. |
| `save_colormap_json` | Backward-compatible alias for `save_labeling_json`. |
| `reload_peak_rules_json` | Alias for `load_peak_rules_json`. |
| `import_peak_rules_json` | Alias for `load_peak_rules_json`. |
| `mark_circular_chrom` | Convenience wrapper for set_circular_chrom(chrom, True). |
| `mark_linear_chrom` | Convenience wrapper for set_circular_chrom(chrom, False). |
| `cluster_reads` | Alias matching the frontend `clusterReads` helper. |
| `fetch_pol2_com` | Alias matching the frontend `fetchPol2COM` helper. |
| `fetch_cluster_vplot` | Alias matching the frontend `fetchClusterVPlot` helper. |
| `fetch_cluster_v_plot` | Acronym-preserving alias for `fetch_cluster_vplot`. |
| `fetch_cluster_projection` | Alias matching the frontend `fetchClusterProjection` helper. |
| `fetch_read_stats` | Alias matching the frontend `fetchReadStats` helper. |
| `get_annotations_for_region` | Alias matching the frontend API name for per-read annotations. |
| `import_peak_bed` | Alias for `import_peaks_bed`. |
| `reload_peaks_bed` | Alias for `import_peaks_bed`. |
| `reload_footprint_rules` | Alias for `load_footprint_rules`. |
| `import_footprint_rules` | Alias for `load_footprint_rules`. |
| `save_fiberlayer_rules` | Alias for portable rule JSON; prefer over materialized layer bundles. |
| `load_fiberlayer_rules` | Alias for portable saved-footprint rule JSON loading. |
| `reload_fiberlayer_rules` | Alias for portable saved-footprint rule JSON loading. |
| `get_annotation_files` | Alias matching the frontend API name for loaded annotation files. |
| `add_annotation_file` | Alias matching the frontend API name for adding annotation files. |
| `activate_annotation_file` | Alias matching the frontend API name for activating annotations. |
| `get_chromosomes` | Frontend-name wrapper returning the full `/api/chroms` response. |
| `get_big_bed_names` | Acronym-preserving alias for `get_bigbed_names`. |
| `add_motif_sequence_track` | Alias matching the frontend `addMotifSequenceTrack` helper. |
| `add_motif_file_tracks` | Alias matching the frontend `addMotifFileTracks` helper. |
| `update_track_filter` | Alias matching the frontend `updateTrackFilter` helper. |
| `cluster_expand` | Alias matching the frontend `clusterExpand` helper. |
| `deactivate_annotation_file` | Alias matching the frontend API name for deactivating annotations. |
| `remove_annotation_file` | Alias matching the frontend API name for removing annotations. |
| `browse_annotation_files` | Alias matching the frontend API name for browsing annotation files. |
| `list_linked_sessions` | Alias for `get_linked_sessions`. |
| `design4c_primers` | Alias matching the frontend `design4cPrimers` helper. |
| `unmerge_dataset` | Alias matching the frontend API name for unmerging one dataset. |
| `get_chip_atlas_status` | Acronym-preserving alias for `get_chipatlas_status`. |
| `get_chip_atlas_facets` | Acronym-preserving alias for `get_chipatlas_facets`. |
| `search_chip_atlas` | Acronym-preserving alias for `search_chipatlas`. |
