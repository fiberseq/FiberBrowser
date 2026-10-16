# FiberBrowser Jupyter Integration

Connect to a running FiberBrowser from a Jupyter notebook for interactive,
reproducible analysis. The bridge is bidirectional: notebooks can drive the
live browser, and the browser continuously syncs viewport, peaks, selected
reads/genes, read order, clusters, Analysis Rules, primer-cart state,
labeling-quality settings, and reproducibility controls back to Python.

## Quick Start

```python
# In Jupyter notebook
import sys
sys.path.append('/path/to/FiberBrowser')

from browser_client import BrowserClient

# Connect to running browser (start browser first with: python browser.py -b your.bam)
client = BrowserClient("http://localhost:8000")
```

A local FiberBrowser answers only requests that carry its per-launch access
token. Run as the same user as the server, the client finds it by itself in
`~/.fiberhmm/browser_runtime.json` (written by the server, readable only by
you). Otherwise pass the link the server printed,
`BrowserClient("http://localhost:8000/?token=...")`, or `token="..."`, or set
`FIBERBROWSER_TOKEN`. `BrowserClient.headless(...)` handles the token itself.

```python

# Get current region
region = client.get_region()
print(f"Viewing: {region['chrom']}:{region['start']}-{region['end']}")

# Get reads as DataFrame
reads_df = client.get_reads()
print(f"Got {len(reads_df)} reads")
print(reads_df.head())
```

For fully scripted workflows without opening the UI first:

```python
from browser_client import BrowserClient

with BrowserClient.headless(bam="your.bam", gtf="genes.gtf", fasta="genome.fa") as client:
    client.goto("chr2R", 9970000, 9985000)
    reads = client.get_reads()
```

## Bidirectional Sync

**The browser tracks its current state, so Jupyter always sees what the browser sees:**

```python
# User navigates in browser to a new gene...
# Then in Jupyter:
region = client.get_region()  # Returns the NEW region
reads_df = client.get_reads()  # Returns reads from the NEW region

# User clusters reads in browser...
# Then in Jupyter:
clusters = client.get_clusters()  # Returns cluster assignments
df = client.get_reads_with_clusters()  # Returns reads with 'cluster' column

# Preserve the same top-to-bottom read order visible in the browser:
viewer_order = client.get_browser_read_order()

# Get read IDs selected in the browser, dataset-scoped when needed:
dataset_id = client.get_datasets()[0]["id"]
selected = client.get_selection(dataset_id)
```

## Active Browser Control

These methods enqueue commands that the open browser applies on its next
Jupyter poll. One-shot commands such as navigation, peak import, and settings
updates are delivered once; persistent state such as read order/filter and
selection remains inspectable until cleared or replaced.

```python
dataset_id = client.get_datasets()[0]["id"]

client.goto("chr2R", 9974319, 9984319)
# `display_cap` limits how many reads the browser renders (0 = no cap);
# `analysis_cap` limits the working set used by backend analyses;
# `profile_read_cap` caps reads used for browser-side metaprofiles.
client.set_reproducibility(seed="paper-v1", analysis_cap=20000, display_cap=600, profile_read_cap=0, spanning=True)
client.set_cluster_settings(method="kmeans", k=10, small_footprint_threshold_bp=90)

# Display/layer state
client.set_visible_layers(tf=True, nuc=True, fire=False, deam=True)
client.set_metaprofile_layers(tf=True, nuc=True, fire=True)
client.set_layer_cache(tf=True, nuc=True, fire=True, deam=False)
client.set_display_settings(fill_read_height=True, show_coverage_histogram=True)
client.set_legacy_layer_inference(enabled=True, nuc_min_size=90)

# Selection/order/filter state
client.set_jupyter_selection(["read_a", "read_b"], dataset_id=dataset_id)
client.set_read_order(["read_b", "read_a"], dataset_id=dataset_id)
client.set_read_filter(["read_a"], dataset_id=dataset_id)

# Labeling display state saved with labeling presets/sessions
client.set_labeling_display(
    read_background="#111827",
    no_read_background="#000000",
    smoothing_enabled=True,
    smoothing_sigma_x=1.0,
    smoothing_sigma_y=0.5,
    layer_opacities={"tf": 1.0, "nuc": 0.8, "fire": 0.4},
)
```

## Navigation

```python
# Go to specific region
client.goto('chr1', 10000, 20000)

# Go to a gene (requires GTF loaded in browser)
client.goto_gene('ACT1', padding=2000)
```

## Getting Browser State

```python
# Get current region (updates when user navigates in browser)
region = client.get_region()

# Get reads in current view
reads_df = client.get_reads()

# Get cluster assignments (after clustering in browser)
clusters = client.get_clusters()
# Returns: {'assignments': {'read1': 0, 'read2': 1, ...}, 'cluster_counts': {0: 50, 1: 30}, ...}

# Get reads with cluster info merged
df = client.get_reads_with_clusters()
# DataFrame includes 'cluster' column
```

## Filtering Reads

```python
# Show only specific reads (hide all others)
interesting = reads_df[reads_df['n_footprints'] > 10]['id'].tolist()
client.set_read_filter(interesting)

# Inspect the active filter
active_filter = client.get_read_filter()

# Clear filter to show all reads again
client.clear_read_filter()
```

## Pushing Custom Reads

Push a modified matrix directly to the browser:

```python
# Get reads and convert to matrix
reads_df = client.get_reads()
matrix, index_df = BrowserClient.to_matrix(reads_df)

# Filter/modify the matrix
mask = matrix[:, 1150] < 150  # e.g., gap at position 1150
filtered_matrix = matrix[mask]
filtered_index = index_df[mask]

# Push to browser - replaces the view
client.push_reads(filtered_matrix, filtered_index, label="Filtered at 1150")

# Clear when done (restores normal BAM view)
client.clear_pushed_reads()
```

## Highlighting Reads

```python
# Highlight specific reads in red
high_fp = reads_df[reads_df['n_footprints'] > 10]['id'].tolist()
result = client.highlight_reads(high_fp, color='#ff0000', label='High FP')

# Different colors for different groups
client.highlight_reads(cluster_a, color='#0066ff', label='Cluster A')
client.highlight_reads(cluster_b, color='#00ff66', label='Cluster B')

# Clear highlights
client.clear_highlights()

# Remove specific highlight
client.remove_highlight(result['highlight_id'])
```

## Custom Footprint Colors

```python
# Color specific footprints on specific reads
client.color_footprints({
    'read_id_1': [
        {'start': 1000, 'end': 1150, 'color': '#ff0000'},  # Red footprint
        {'start': 2000, 'end': 2200, 'color': '#00ff00'},  # Green footprint
    ],
    'read_id_2': [
        {'start': 1500, 'end': 1650, 'color': '#0000ff'},  # Blue footprint
    ]
})

# Clear footprint colors
client.clear_footprint_colors()
```

## Position Markers

```python
# Add vertical marker lines
client.add_markers([
    {'position': 5000, 'color': '#ff0000', 'label': 'TSS'},
    {'position': 6000, 'color': '#0000ff', 'label': 'Peak'},
    {'position': 7000, 'color': '#00ff00'},  # No label
])

# Clear markers
client.clear_markers()
```

## Custom Read Ordering

```python
# Put specific reads at top of view
interesting_reads = ['read1', 'read2', 'read3']
client.set_read_order(interesting_reads)

# Check current order
order = client.get_read_order()

# Capture the current browser top-to-bottom order for reproducible exports
viewer_order = client.get_browser_read_order()

# Reset to default
client.clear_read_order()
```

## Reproducible Exports

```python
# Save currently synced browser peaks in the same BED6+ schema as the UI.
client.save_peaks_bed("peaks.bed", selected_only=False)

# Reload BED peaks into the live browser as locked selected peaks.
client.import_peaks_bed("peaks.bed", goto=True)

# Reload the exact Peak Rules JSON exported from the UI.
client.load_peak_rules_json("peak_rules.json", lock=False, rescan=True)

# Save/reload the Analysis Rules panel (Cluster, Sort, and Filter tabs).
client.save_analysis_rules_json("analysis_rules.json")
client.load_analysis_rules_json("analysis_rules.json")

# Or reload BED peaks into a notebook workflow and pass them directly to clustering.
peak_regions = client.peak_bed_regions("peaks.bed", mode="accessibility")
result = client.cluster_all(peak_regions=peak_regions, k=6, method="kmeans")

# Export cluster assignments in the browser's top-to-bottom read order.
# include_provenance=True prefixes comment lines with region, datasets,
# analysis seed/cap, span mode, peak lock, cluster method/K, thresholds,
# selected peak count, and active quality filters.
client.save_clusters_tsv(
    "clusters.tsv",
    include_provenance=True,
    provenance={"analysis_id": "figure-1"},
)

# Export selected read stats in the same viewer order used by the Read Stats table.
dataset_id = client.get_datasets()[0]["id"]
viewer_order = client.get_browser_read_order(dataset_id)
client.save_read_stats_tsv("read_stats.tsv", {dataset_id: viewer_order})
```

## Analysis Rules From Python

The Analysis Rules panel is scriptable from notebooks. Rule scopes resolve to
absolute genomic windows and can target selected peaks, all peaks, the current
window, selected genes/transcripts, or a custom region.

```python
rules = client.get_analysis_rules()

# Cluster using a Cluster-tab feature rule.
cluster_rule = rules["cluster_feature_rules"][0]
clusters = client.cluster_by_feature_rule(cluster_rule, method="kmeans", k=8)

# Sort/filter using reusable rules from the top-bar dropdowns.
sort_rule = rules["analysis_sort_rules"][0]
client.sort_by_analysis_rule(sort_rule)

filter_rule = rules["analysis_filter_rules"][0]
client.filter_by_analysis_rule(filter_rule)
```

Pol II sort/filter rules use the same states as the Transcription panel:
`pause`, `pic`, `elongating`, and `hyperburst`. Provide `scope.geneId`, pass
`selected_genes=...`, or sync selected genes from the browser before running
Pol II rules.

Cluster-rule feature vectors are also supported by cluster detail operations:

```python
peak_regions = client.resolve_cluster_feature_rule_regions(cluster_rule)
client.auto_cull_clusters(assignments=clusters["results"], peak_regions=peak_regions,
                          cluster_feature_rules=[cluster_rule])
client.get_cluster_projection(peak_regions, cluster_feature_rules=[cluster_rule])
```

## Primer Cart And Vendor Orders

The Primer Design order list is part of the Jupyter-synced browser state. You
can export the same cart the UI exports, or pass an explicit list of saved
primer records.

```python
cart = client.get_primer_cart()
client.save_primer_order("primers_idt.csv", format="idt")
client.save_primer_order("primers_genewiz.csv", primers=cart["saved_primers"], format="genewiz")
client.save_primer_order("primers.fasta", format="fasta")

# Current Tm/repeat options are exposed directly too.
client.design_primers("chr2L", 100000, 101000,
                      tm_method="snapgene",
                      check_tandem_repeats=True)
```

Supported order formats are `idt`, `genewiz`, `eurofins`, `sigma`,
`generic`, and `fasta`.

## Matrix Conversion

Convert between interval format and position-based matrix for analysis:

```python
# Get reads
reads_df = client.get_reads()

# Convert to matrix (position x reads, values = footprint/gap sizes)
matrix, index_df = BrowserClient.to_matrix(reads_df)
print(f"Matrix shape: {matrix.shape}")  # (n_reads, region_width)

# Analyze the matrix
# - Positive values = footprint size
# - Negative values = gap size
# - Zero = no coverage

# Example: Find positions with high footprint coverage
footprint_mask = matrix > 0
coverage = footprint_mask.sum(axis=0)

# Reorder reads (e.g., by total footprint bases)
total_fp = (matrix > 0).sum(axis=1)
new_order = np.argsort(-total_fp)  # Descending
reordered_matrix = matrix[new_order]
reordered_index = index_df.iloc[new_order].reset_index(drop=True)

# Convert back to interval format
new_df = BrowserClient.from_matrix(reordered_matrix, reordered_index)

# Push custom order to browser
client.set_read_order(reordered_index['id'].tolist())
```

## Utility Functions

```python
# Clear all Jupyter-controlled state
client.clear_all()

# Force browser refresh
client.refresh()

# Set browser-wide reproducibility controls
client.set_reproducibility(seed="paper-v1", analysis_cap=20000, display_cap=0, profile_read_cap=0, spanning=True)

# Set browser clustering controls from a notebook
client.set_cluster_settings(method="kmeans", k=10, small_footprint_threshold_bp=90, accessibility_threshold=0.5)

# Set backend interval-quality filters used by working sets and analyses
client.set_quality_filters([{"layer": "fire", "quality_name": "aq", "min_value": 230}])

# Toggle live display layers, metaprofiles, and read cache prefetching
client.set_visible_layers(tf=True, nuc=True, fire=True, deam=False)
client.set_metaprofile_layers(tf=True, nuc=True, fire=True)
client.set_layer_cache(tf=True, nuc=True, fire=True, deam=False)

# Configure display behavior and legacy layer inference
client.set_display_settings(fill_read_height=True, read_row_height="auto", show_coverage_histogram=True)
client.set_legacy_layer_inference(enabled=True, nuc_min_size=90)

# Configure labeling display fields saved in the active preset
client.set_labeling_display(
    read_background="#f1f5f9",
    no_read_background="#ffffff",
    smoothing_enabled=False,
    layer_opacities={"tf": 1.0, "nuc": 0.85, "fire": 0.5},
)

# Capture/reapply the exact browser-side reproducibility + peak-rule settings.
# The snapshot includes seed/caps/span, peak lock/rules, active Labeling &
# Quality preset, quality filters, cluster method/K, layer/display settings,
# co-accessibility settings, active panels, and selected peak/read state.
settings = client.get_browser_settings()
client.save_browser_settings_json("browser_settings.json")
client.load_browser_settings_json("browser_settings.json", rescan=True)

# Save/reload the active Labeling & Quality preset, including quality filters
client.save_labeling_json("labeling_quality.json")
client.load_labeling_json("labeling_quality.json")
client.add_pol2_gene_exclusion_rule(gene_name="eve")

# Get reads selected by user in browser (if selection enabled)
selected = client.get_selection()

# Get browser status
status = client.get_status()
```

## TF Motif Search

Search for transcription factor binding motifs in detected peak sequences. Requires a reference FASTA loaded in the browser (`-f genome.fa` or `client.load_fasta('genome.fa')`).

### Browse JASPAR Motifs

```python
# List all available motifs
motifs = client.list_motifs()
print(motifs.head())
#   matrix_id     name  species     tf_family  length
# 0  MA0004.1    Arnt    9606    bHLH          6
# 1  MA0006.1    Ahr     9606    bHLH          6

# Filter by species (NCBI taxonomy ID: 9606=human, 10090=mouse, 7227=fly, 559292=yeast)
human_motifs = client.list_motifs(species=9606)

# Filter by TF family or name
bhlh = client.list_motifs(tf_family='bHLH')
ctcf = client.list_motifs(name_contains='CTCF')
```

### Search for Motifs in Peaks

```python
# First, scan peaks
client.scan_peaks()

# Search for specific motifs by name
results = client.search_motifs(motifs=['CTCF', 'SP1'])

# Or by JASPAR matrix ID
results = client.search_motifs(motif_ids=['MA0139.1', 'MA0079.5'])

# Results are a DataFrame with match details
print(results.head())
#   region  chrom  start    end  motif_id   motif_name  strand  score  rel_score  matched_seq
# 0   0     chr1   1050   1069  MA0139.1   CTCF          +      18.2    0.92     CCGCGNGGNGGCAG

# Adjust match stringency (default threshold=0.8)
strict = client.search_motifs(motifs=['CTCF'], threshold=0.9)

# Search both strands (default) or forward only
fwd_only = client.search_motifs(motifs=['CTCF'], both_strands=False)

# Use specific peaks instead of all detected peaks
peaks_df = client.scan_peaks()
top_peaks = peaks_df.head(5)
results = client.search_motifs(peaks=top_peaks, motifs=['CTCF'])
```

### Load Custom Motifs

```python
# Load motifs from a JASPAR or MEME format file
loaded = client.load_custom_motifs('my_motifs.jaspar')
print(loaded)  # {'loaded': 3, 'names': ['MyTF1', 'MyTF2', 'MyTF3']}

# Load a single custom PWM directly
client.load_custom_motif('MyMotif', {
    'A': [0.2, 0.8, 0.1, 0.0, 0.3],
    'C': [0.3, 0.1, 0.7, 0.0, 0.2],
    'G': [0.3, 0.0, 0.1, 1.0, 0.3],
    'T': [0.2, 0.1, 0.1, 0.0, 0.2],
})

# Use custom motifs in search (prefix with "custom:")
results = client.search_motifs(motifs=['custom:MyMotif'])
```

## Co-accessibility / Contact Matrices

Single-molecule co-accessibility computes how often pairs of bins are
both accessible on the same read, normalized into a matrix, slice
(virtual 4C), or arc-list. Every endpoint here mirrors the
Co-Accessibility panel in the browser, so notebook results match what
the user sees on screen.

```python
# Square matrix as a labeled DataFrame (chrom:bin labels on both axes)
matrix = client.get_coacc_matrix(
    normalization='oe_distance',  # 'raw' | 'oe' | 'oe_distance' | 'correlation'
    bin_size=0,                   # 0 = auto-pick a "nice" bin
    min_coverage=20,
    signal_type='accessibility',  # or 'nucleosome' | 'small_fp' | 'linker' | 'all_fp'
    layer=None,                   # e.g. 'fire' or 'tf' to override size heuristics
    dataset_ids=None,             # list/string for combined cohort
    sample_seed='paper',          # reproducibility seed shared with the panel
)

# Virtual 4C: 1D profile from a viewpoint position
slice_data = client.get_coacc_slice(position=2_345_000, normalization='oe')
profile = slice_data['profile']     # list of values
viewpoint_bin = slice_data['viewpoint_bin']

# Top co-accessible pairs as arcs (DataFrame with start, end, strength, coverage)
arcs = client.get_coacc_arcs(threshold=1.5, max_arcs=200, min_distance=2)

# Settings synced from the browser panel (normalization, scaling, signal_type, ...)
settings = client.get_coacc_settings()

# Coverage / read-count metadata for the current matrix scope
meta = client.get_coacc_metadata()  # n_reads, bin_size, n_bins, coverage stats

# Triangular heatmap strip as a PIL image (matches the browser track)
strip = client.get_coacc_strip(width=1000, height=120)
```

Every co-accessibility method takes the same scoping parameters the
browser uses (`dataset_ids`, `read_ids`, `read_ids_by_dataset`, `layer`,
`signal_type`, `sample_seed`), so a notebook can replay an exact panel
view by passing in the values from `get_coacc_settings()`.

```python
# Replay the panel's exact view
s = client.get_coacc_settings()
matrix = client.get_coacc_matrix(
    normalization=s['normalization'],
    bin_size=s['bin_size'],
    min_coverage=s['min_coverage'],
    signal_type=s['signal_type'],
)
```

## Primer Design

Primer design is configured once (FASTA + BLAST DB) then driven from a
notebook with the same backend the Primer Design panel uses. Long jobs
expose progress and abort hooks so the notebook can poll or cancel.

```python
# One-time configuration (BLAST is optional — primers can be designed without it)
client.set_primer_config(
    fasta_path='/path/to/genome.fa',
    blast_db_path='/path/to/genome_blastdb',  # omit to skip specificity checks
)

# Or build a local BLAST DB from the browser's loaded FASTA
client.build_primer_blast_db(force=False)  # writes alongside the FASTA

# Single-amplicon design — auto-uses the current browser region if chrom/start/end are omitted
result = client.design_primers(
    min_product=5_000, max_product=50_000,
    min_tm=55, max_tm=65,
    max_results=5,
)
for pair in result['pairs']:
    print(pair['fwd_seq'], pair['rev_seq'], pair['fwd_tm'], pair['rev_tm'])

# DAF-C / 3C two-locus pairs
dafc = client.design_dafc_primers(
    chrom='chr2R', x_start=9_950_000, x_end=9_960_000,
    y_start=10_010_000, y_end=10_020_000,
    max_results=5,
)

# Outward-facing 4C primers inside a viewpoint
fourc = client.design_4c_primers(min_spacing=50, max_spacing=500)
```

Async design jobs (DAF-C and 4C) return immediately; poll progress and
cancel from the notebook:

```python
import time

while True:
    progress = client.get_primer_progress()
    if not progress.get('active'):
        break
    print(f"{progress['stage']}: {progress['progress']}% — {progress['message']}")
    time.sleep(1)

# To cancel mid-run:
client.abort_primer_design()
```

Inspect / clear the latest results as visible in the panel:

```python
client.get_primers()         # list of pair dicts (or quads for DAF-C / 4C)
client.get_primer_results()  # raw payload incl. metadata + warnings
client.get_primer_config()   # current FASTA + BLAST DB paths
client.clear_primers()       # drop the latest result from the panel
```

Without `primer3-py` installed, hairpin / homodimer / Tm filters fall
back to length-and-GC heuristics; the result payload's `warnings`
field surfaces a one-line install hint when this happens. BLAST is
similarly optional — `set_primer_config` with no `blast_db_path` skips
specificity checks.

## Example: Interactive Analysis Workflow

```python
from browser_client import BrowserClient
import pandas as pd

# Connect
client = BrowserClient()

# Navigate to region of interest
client.goto_gene('ACT1')

# Get reads
df = client.get_reads()

# Analyze: find reads with clustered small footprints
def has_tf_cluster(intervals):
    small_fp = [(s, e) for s, e, sz in intervals if 0 < sz < 80]
    if len(small_fp) < 3:
        return False
    # Check if 3+ small footprints within 500bp
    for i, (s1, e1) in enumerate(small_fp):
        nearby = sum(1 for s2, e2 in small_fp if abs(s1 - s2) < 500)
        if nearby >= 3:
            return True
    return False

df['has_tf_cluster'] = df['intervals'].apply(has_tf_cluster)
tf_reads = df[df['has_tf_cluster']]['id'].tolist()

# Highlight in browser
client.highlight_reads(tf_reads, color='#ff6600', label='TF Clusters')

# Add marker at gene TSS
gene_info = client.get_region()
client.add_markers([
    {'position': gene_info['start'] + 2000, 'color': '#ff0000', 'label': 'TSS'}
])
```

## API Reference

### Query Methods (Browser → Jupyter)
- `get_region()` - Current viewport (chrom, start, end) - **updates when user navigates**
- `get_reads(dataset_id=None)` - Reads as DataFrame from current view
- `get_clusters(dataset_id=None)` - Cluster assignments (after clustering in browser)
- `get_clusters_tsv(dataset_ids=None, include_provenance=False, provenance=None)` - Ordered cluster assignment TSV; provenance comments can capture the live browser settings used to create it
- `get_read_stats_tsv(read_ids_by_dataset, ...)` - Ordered per-read stats TSV matching the browser table/export order
- `get_reads_with_clusters(dataset_id=None)` - Reads with cluster column merged
- `get_peaks_bed(selected_only=False)` - Current browser peaks as FiberBrowser BED6+
- `save_peaks_bed(filepath, selected_only=False)` - Save current browser peaks as BED6+
- `load_peak_bed(filepath, as_dataframe=True)` - Load BED3/BED6/FiberBrowser BED6+ peaks
- `import_peaks_bed(filepath, goto=False)` - Reload BED peaks into the live browser as locked peaks
- `load_peak_rules_json(filepath, lock=None, clear_peaks=True, rescan=False)` - Reload the UI Peak Rules JSON into the browser
- `get_datasets()` - List of loaded datasets
- `get_status()` - Browser status info
- `get_selection(dataset_id=None)` - User/browser-selected reads; dataset-scoped when requested
- `get_read_order(dataset_id=None)` - Current custom read order
- `get_browser_read_order(dataset_id=None)` - Current browser top-to-bottom order
- `get_read_filter(dataset_id=None)` - Current Jupyter-controlled read filter
- `get_highlights()` - Current highlight groups
- `get_meta(chrom, start, end, dataset_id)` - Nucleosome/small-footprint meta profiles
- `get_fire(chrom, start, end)` - FIRE peaks and signal
- `get_working_set_info(chrom, start, end, dataset_id)` - Working set statistics
- `get_read_info(chrom, start, end)` - Read count for a region
- `get_jupyter_state()` - Full integration state (debug)
- `get_analysis_state()` - Browser-synced peaks, display/layer settings, cluster state, co-accessibility settings, selected reads, panels, and manifest summary
- `get_browser_settings()` / `save_browser_settings_json(filepath)` - Capture current browser settings for reproducibility, including seed/caps/span, peak settings, cluster parameters, active quality filters, layers, display state, co-accessibility settings, selected reads, and active panels
- `sync_jupyter_browser_settings(settings)` - Store a UI-style settings snapshot in the Jupyter bridge
- `apply_browser_settings(settings)` / `load_browser_settings_json(filepath)` - Reapply captured browser settings, including selected-read state and profile/read display caps
- `save_labeling_json(filepath)` / `load_labeling_json(filepath)` - Save or reload the active Labeling & Quality preset, including quality filters
- `get_labeling_preset()` / `set_labeling_preset(preset)` - Round-trip the active Labeling & Quality preset
- `add_labeling_rule(...)` / `add_pol2_gene_exclusion_rule(gene_name=...)` - Add reproducible labeling rules from notebooks
- `set_quality_filters(filters)` / `clear_quality_filters()` - Set or clear backend interval-quality filters
- `set_reproducibility(seed=None, analysis_cap=None, display_cap=None, display_mode=None, all_reads_display_cap=None, profile_read_cap=None, spanning=None)` - Push browser-wide seed/cap/span controls (`display_cap=0` disables the rendering cap)
- `set_cluster_settings(method, k, small_footprint_threshold_bp, accessibility_threshold)` - Push browser clustering controls
- `queue_browser_actions(actions, label)` - Queue UI-equivalent actions for the active browser frontend to execute
- `cluster_selected_peaks_in_browser()` - Run the same selected-peak clustering workflow as the browser Cluster button
- `cluster_peak_at_gene_tss_in_browser(gene_name, padding, tolerance_bp)` - Ask the browser to navigate/select the TSS-overlapping peak and cluster on it
- `set_display_settings(...)` - Push display controls including layer toggles, cache toggles, legacy inference, fill-height, row height, coverage histogram, and genome overview
- `set_visible_layers(...)` / `set_metaprofile_layers(...)` / `set_layer_cache(...)` - Convenience wrappers for layer visibility, metaprofiles, and optional layer prefetching
- `set_labeling_display(...)` / `set_layer_opacity(layer, opacity)` - Update read/no-read backgrounds, Gaussian smoothing, and layer opacity in the active labeling preset
- `set_peak_lock(locked=True)` / `lock_peaks()` / `unlock_peaks()` - Toggle current browser peak locking

### Navigation (Jupyter → Browser)
- `goto(chrom, start, end)` - Navigate to region
- `goto_gene(gene_name, padding=2000)` - Navigate to gene
- `search_gene(query)` - Search for a gene by name

### Dataset Management
- `get_datasets()` - List loaded datasets
- `add_dataset(path=None, paths=None, url=None, label=None)` - Add a dataset (BAM, BigBed, or URL)
- `add_dataset_url(url, label=None)` - Convenience wrapper for remote BAM/BigBed URLs
- `remove_dataset(dataset_id)` - Remove a dataset
- `merge_datasets(dataset_ids, merged_label=None)` / `unmerge_dataset(dataset_id)` - Merge or split dataset panels
- `refresh_dataset_capabilities(dataset_id=None)` - Re-detect available layers and clear stale read caches

### Linked Split Sessions
Use linked split sessions when a notebook needs to drive the same two-region
view that the browser uses for DAF-C, Micro-C, or haplotype-style comparisons.
Each session response includes `split_view_mode` and `split_view_semantics`, so
notebooks can distinguish row-coupled molecules from independent viewports.

```python
session = client.create_linked_session()["session_id"]

client.send_to_linked_session(
    session,
    regions={
        "chrom": "chr2L",
        "x_start": 1_000_000,
        "x_end": 1_010_000,
        "y_start": 2_000_000,
        "y_end": 2_010_000,
    },
    split_view_mode="molecule_linked",  # DAF-C / same-molecule rows
)

# Other semantic modes:
#   region_independent  -> two independent read queries, Micro-C-style
#   coordinate_synced   -> independent reads on mapped/homologous regions
client.send_to_linked_session(
    session,
    x_chrom="chr2L_hap1", x_start=1_000_000, x_end=1_010_000,
    y_chrom="chr2L_hap2", y_start=1_000_000, y_end=1_010_000,
    split_view_mode="coordinate_synced",
)

status = client.get_linked_session(session)
reads_x = client.get_linked_reads_compact(session, "x", max_reads=500, sample_seed="paper-v1")
reads_y = client.get_linked_reads_compact(session, "y", max_reads=500, sample_seed="paper-v1")
```

For `molecule_linked`, X and Y compact responses keep identical row identity
and ordering after reproducible sampling. For `region_independent` and
`coordinate_synced`, each pane fetches its own reads and should be clustered or
filtered as a viewport-specific read set.

Linked-session methods:
- `create_linked_session()` — open a new linked session and return its `session_id`
- `get_linked_sessions()` — list active linked sessions
- `get_linked_session(session_id)` — fetch one session's current state
- `send_to_linked_session(session_id, regions=None, **kwargs)` — push a region pair into the session
- `get_linked_reads_compact(session_id, region, max_reads=None, sample_seed=None)` — primary read API for the X/Y panes (compact intervals payload)
- `get_linked_reads_data(session_id)` — raw shape returned by the linked-reads endpoint
- `get_linked_reads_image(session_id, region, ...)` — server-rendered PNG strip for either pane
- `delete_linked_session(session_id)` — close and free the session

### Co-accessibility / Contact Matrices
- `get_coacc_matrix(chrom=None, start=None, end=None, normalization='oe', bin_size=0, min_coverage=20, signal_type='accessibility', layer=None, dataset_ids=None, read_ids=None, read_ids_by_dataset=None, sample_seed=None, as_dataframe=True)` — square matrix as DataFrame or numpy array
- `get_coacc_matrix_data(chrom, start, end, ...)` — raw response dict (matrix, bin_size, n_bins, …)
- `get_coacc_slice(position, normalization='oe', ...)` — virtual-4C profile from a viewpoint position
- `get_coacc_arcs(threshold=1.5, max_arcs=200, min_distance=2, ...)` — top co-accessible pairs as DataFrame
- `get_coacc_metadata(...)` — n_reads, bin_size, n_bins, coverage stats
- `get_coacc_strip(width=800, height=120, ...)` — PIL image of the triangular strip
- `get_coacc_settings()` — pull the panel's synced settings (normalization, scaling, signal_type, …)

### Primer Design
- `set_primer_config(fasta_path=None, blast_db_path=None)` / `get_primer_config()` — configure FASTA + BLAST DB
- `build_primer_blast_db(force=False, output_dir=None)` — build a local BLAST DB from the loaded FASTA
- `design_primers(chrom=None, start=None, end=None, min_product=5000, max_product=50000, min_tm=55, max_tm=65, max_results=5, **kwargs)` — single-amplicon design
- `design_dafc_primers(chrom, x_start, x_end, y_start, y_end, y_chrom=None, ...)` — DAF-C / 3C two-locus pairs (async — poll `get_primer_progress`)
- `design_4c_primers(chrom=None, start=None, end=None, min_spacing=50, max_spacing=500, ...)` — outward-facing 4C primers (async)
- `get_primer_progress()` — `{active, stage, progress, message, details?}`
- `abort_primer_design()` — cancel the active job
- `get_primers()` — current pair / quad list
- `get_primer_results()` — raw payload (success, pairs, warnings, ...)
- `clear_primers()` — drop the latest result

### Session Management
- `save_session(filepath, chrom, start, end)` - Export session to JSON file
- `load_session(filepath)` - Import session from JSON file

### Track Management
- `get_tracks()` - List orthogonal tracks (bigWig, bigBed, etc.)
- `add_track(path, label, render_mode)` - Add an orthogonal track
- `remove_track(track_idx)` - Remove a track by index
- `get_catalog()` / `catalog_load(group_index)` / `catalog_unload(group_index)` - Inspect and load curated dataset catalog groups
- `catalog_track_load(track_index)` / `catalog_track_unload(track_index)` - Load/unload catalog reference tracks
- `get_s3_status()` / `configure_s3(...)` / `test_s3_access(url)` - Inspect and configure optional S3 support
- `list_s3_bucket(bucket, prefix="", max_keys=100)` / `get_presigned_url(url, expiration=3600)` - Browse S3 prefixes and generate temporary URLs
- `get_ucsc_curated(genome)` / `search_ucsc_tracks(genome, query)` / `browse_ucsc_tracks(genome)` - UCSC external-track discovery
- `get_encode_facets(genome)` / `search_encode(...)` - ENCODE external-track discovery
- `get_chipatlas_status()` / `get_chipatlas_facets(genome)` / `search_chipatlas(...)` - ChIP-Atlas external-track discovery

### GTF & Genome Management
- `load_gtf(path)` - Load GTF/GFF3 annotation file
- `remove_gtf()` - Remove loaded GTF annotations
- `get_genomes()` - List available online genomes
- `load_genome(genome_id)` - Load an online genome (FASTA + GTF)
- `load_fasta(path)` - Load a reference FASTA file
- `get_sequence(chrom, start, end)` - Get reference DNA sequence (max 10kb)

### Overlay Management
- `get_overlays()` - List modification overlays
- `add_overlay(path, overlay_type)` - Add a modification overlay (m6A, m5C, etc.)
- `remove_overlay(overlay_id)` - Remove an overlay

### Analysis
- `scan_peaks(chrom, start, end, **kwargs)` - Multi-threshold peak detection
- `cluster(peak_indices, k, chrom, start, end, dataset_id)` - K-means clustering (single dataset)
- `cluster_all(peak_regions, k, method, dataset_ids, ...)` - Multi-dataset clustering
- `sort_reads(sort_by, chrom, start, end, **kwargs)` - Sort reads/clusters by metric
- `filter_by_transcription_state(gene_ids, filters, ...)` - Filter by transcription state
- `autozoom(distance, chrom, start, end, **kwargs)` - Auto-optimize viewing window

### Filtering (Jupyter → Browser)
- `set_read_filter(read_ids, dataset_id)` / `filter_reads(...)` - Show only specified reads
- `get_read_filter(dataset_id=None)` - Inspect active read filter
- `clear_read_filter(dataset_id=None)` / `clear_filter(...)` - Show all reads
- `push_reads(matrix, index_df, label)` - Push custom reads to display
- `clear_pushed_reads()` - Clear pushed reads, restore normal view
- `set_jupyter_selection(read_ids, dataset_id=None)` / `get_selection(dataset_id=None)` - Set or read the live browser read selection

### Highlighting (Jupyter → Browser)
- `highlight_reads(read_ids, color, label, dataset_id)` - Highlight reads
- `highlight_footprints(footprints, color, label, dataset_id)` - Highlight footprints
- `remove_highlight(highlight_id)` - Remove specific highlight
- `clear_highlights()` - Clear all highlights

### Footprint Colors (Jupyter → Browser)
- `color_footprints(footprint_colors, group)` - Custom footprint colors
- `clear_footprint_colors(group=None)` - Clear colors

### Markers (Jupyter → Browser)
- `add_markers(positions, group)` - Add position markers
- `clear_markers(group=None)` - Clear markers

### Read Ordering (Jupyter → Browser)
- `set_read_order(read_ids, dataset_id)` - Custom read order
- `get_browser_read_order(dataset_id)` - Latest top-to-bottom order reported by the browser
- `clear_read_order(dataset_id=None)` - Reset order

### Display, Layers & Labeling (Jupyter → Browser)
- `set_visible_layers(layers=None, **layer_states)` - Toggle read-level layers; accepts aliases such as `msp=True` and normalizes them to `fire`
- `set_metaprofile_layers(layers=None, **layer_states)` - Toggle metaprofile rows
- `set_layer_cache(layers=None, **layer_states)` - Toggle which optional layers are prefetched into read-window caches
- `set_display_settings(...)` - Push raw display/layer settings including `fill_read_height`, `read_row_height`, `show_coverage_histogram`, `cached_layer_types`, and `legacy_layer_inference`
- `set_legacy_layer_inference(enabled=True, nuc_min_size=90)` - Configure legacy footprint splitting into inferred `nuc`, `tf`, and FIRE/MSP-compatible layers
- `set_labeling_display(...)` - Set read/no-read background colors, Gaussian smoothing, and per-layer opacity in the active labeling preset
- `set_layer_opacity(layer, opacity)` - Convenience wrapper for one layer opacity

### Export Helpers (Browser → Jupyter)
- `save_peaks_bed(filepath, selected_only=False)` - Save browser peaks as BED6+
- `import_peaks_bed(filepath, goto=False)` - Reload browser peak BEDs as locked selected peaks
- `load_peak_rules_json(filepath, lock=None, clear_peaks=True, rescan=False)` - Reload exported Peak Rules JSON
- `save_labeling_json(filepath)` / `load_labeling_json(filepath)` - Save/reload exported Labeling & Quality JSON
- `add_labeling_rule(...)` / `add_pol2_gene_exclusion_rule(gene_name=...)` - Add reproducible labeling rules from notebooks
- `peak_bed_regions(filepath, mode='accessibility')` - Convert BED peaks to clustering regions
- `save_clusters_tsv(filepath, dataset_ids=None, include_provenance=False, provenance=None)` - Save ordered cluster assignment TSV with optional reproducibility comments
- `save_read_stats_tsv(filepath, read_ids_by_dataset, ...)` - Save ordered Read Stats TSV

### Utilities
- `clear_all()` - Clear all Jupyter state
- `refresh()` - Force browser refresh
- `queue_browser_actions(actions, label)` - Queue browser-button-style actions through `/api/jupyter/actions`
- `set_reproducibility(seed=None, analysis_cap=None, display_cap=None, display_mode=None, all_reads_display_cap=None, profile_read_cap=None, spanning=None)` - Set browser-wide reproducibility and read display controls
- `set_cluster_settings(method=None, k=None, small_footprint_threshold_bp=None, accessibility_threshold=None)` - Set browser clustering controls
- `get_browser_settings()` / `save_browser_settings_json(filepath)` - Capture current browser settings for reproducibility (seed/caps/span, peak settings, cluster parameters, quality filters, layers, display state, co-accessibility settings, selected reads, active panels)
- `apply_browser_settings(settings)` / `load_browser_settings_json(filepath)` - Reapply captured browser settings, including selected-read state and profile/read display caps
- `set_peak_rules(rules, lock=None, clear_peaks=True, rescan=False)` - Push exact Peak Rules settings into the browser
- `get_labeling_preset()` / `set_labeling_preset(preset)` - Round-trip the active Labeling & Quality preset
- `set_quality_filters(filters)` / `get_quality_filters()` / `clear_quality_filters()` - Manage backend quality filters
- `set_peak_lock(locked=True)` / `lock_peaks()` / `unlock_peaks()` - Toggle peak locking without changing rules
- `clear_cache()` - Clear server-side read caches

### Matrix Conversion (static methods)
- `BrowserClient.to_matrix(reads_df, region_width=None)` - Convert to (n_reads, width) matrix
- `BrowserClient.from_matrix(matrix, index_df=None)` - Convert matrix back to interval format
- `BrowserClient.reorder_reads(reads_df, new_order)` - Reorder DataFrame by row indices

## Workflow Tests

The Jupyter/API bridge is covered by workflow tests rather than only method
unit tests:

```bash
# Direct endpoint-service tests for browser control, read control,
# reproducibility, collections, sequence extraction, and motif search
python -m pytest tests/test_jupyter_endpoint.py tests/test_jupyter_collections.py tests/test_jupyter_sequences.py tests/test_jupyter_motifs.py

# Active browser command queue, browser-to-notebook sync, and Python client parity
python -m pytest tests/test_jupyter_workflows.py tests/test_browser_client.py

# Slow smoke test that starts a standalone headless server and drives it
python -m pytest tests/test_headless_workflow.py
```

The first suite verifies that navigation, pushed reads, ordering, filtering,
selection, highlights, markers, footprint colors, peak import/rules, settings,
layer aliases, and synced browser state round-trip through the same endpoints
used by notebooks. The headless smoke test verifies `BrowserClient.headless()`
can launch a server and accept Jupyter commands without a pre-opened GUI.

### Backend Structure

The FastAPI Jupyter router is a thin compatibility layer. Core behavior lives
in tested service modules:

- `services.jupyter_endpoint` handles navigation, read retrieval, pushed reads,
  read order/filter/selection, peak sync, reproducibility settings, sequence
  extraction, and motif-search request orchestration.
- `services.jupyter_collections` handles highlights, markers, footprint colors,
  and one-shot peak import/rule queues.
- `services.jupyter_payloads` builds browser-poll and analysis-state snapshots.
- `services.jupyter_sequences` and `services.jupyter_motifs` contain the
  reusable sequence and motif primitives used by the endpoint service.
