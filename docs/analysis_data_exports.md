# Analysis data export and reproducible state guide

This guide is the data-access companion to the
[Analysis Methods and Statistical Interpretation Guide](analysis_methods_and_statistics.md).
It documents how to obtain the numeric values behind every analysis view,
which exports contain observation-level inputs, and how to save and reload a
browser state.

## The three data levels

FiberBrowser distinguishes three useful forms of data:

1. **Source records** are the BAM, BigBed, BigWig, cooler, FASTA, GTF, motif,
   and annotation files loaded into the browser. These remain the
   authoritative native data.
2. **Observation-level analysis input** is the read-, interval-, mark-, or
   contact-bin table admitted by the current viewport and filters. This is the
   preferred level for fitting a different statistical model.
3. **Plot data** is the exact numeric array supplied to a rendered chart after
   aggregation, normalization, smoothing, or embedding. It is the preferred
   level for reproducing a displayed figure exactly.

A plot-data TSV is not described as observation-level data when the backend
has already aggregated the observations. The export names and tables below
make that boundary explicit.

## Where to download data

For an individual chart, hover over it, open the down-arrow save menu, and
choose **Data TSV**. The same menu retains PNG, SVG, and PDF export. Chart TSVs
use long-form tables so they can be read directly by pandas, R, Julia, or a
spreadsheet.

Text cells whose first non-space character is `=`, `+`, `-`, or `@` receive a
leading apostrophe to prevent imported labels from executing as spreadsheet
formulas. Numeric cells, including negative measurements, are unchanged. Remove
that safety apostrophe only after treating the source label as trusted input.

**Export data** (top bar, or Cmd/Ctrl+Shift+E) lists the cross-panel exports:

- **Working-set reads & intervals (TSV)** downloads every admitted read for
  the current datasets and viewport with primary and named-layer intervals,
  layer quality values, and modification marks. `max_reads=0` is used, so the
  analysis is not silently limited to the displayed read sample. Large regions
  can produce large files.
- **Cluster assignments (TSV)** contains read-to-cluster assignments, ordering,
  patterns, and provenance.
- **Peaks (BED)** and **Cluster regions (BED)** preserve detection and feature
  coordinates.
- **Exact browser state (JSON)** is the canonical reloadable state bundle.

Some panels also provide a more specialized export beside their controls:
Read Stats TSV/JSON, transcription per-read TSV and result JSON, footprint
co-occupancy TSV, co-accessibility matrix TSV/JSON, track bedGraph/multi-TSV,
primer tables, capture-region tables, and footprint-rule/call bundles.

## Standard chart TSV schemas

| Chart | Key columns | Notes |
|---|---|---|
| Histogram | `group`, `series`, `value`, `ci_low`, `ci_high`, `n`, `color` | Confidence limits are on the same scale as the bar. |
| Profile | `series`, display/source index, relative bp, `value`, confidence limits, `n` | Display and source indices make reverse orientation explicit. |
| Donut | segment count, displayed total, fraction, percent, Wilson limits | The denominator is the displayed segment total. |
| Heatmap | row/column index and label, `color_value`, `display_value` | Separates normalized color input from printed/raw cell value. |
| V-plot | footprint-size and relative-position bin bounds, value | Values are the exact matrix supplied to the plot. |
| Scatter | point index/ID, dataset, cluster, x, y | Cluster projections include read IDs. |
| Signal profile | genomic bin bounds, signal, thresholds, detected peaks | Threshold and peak records are included in the same long table. |
| Sequence logo | position/base, supplied PWM value, probability, information content, letter height | Derived logo quantities can be independently checked. |

## Analysis-by-analysis export audit

| Analysis or view | Exact displayed values | Least-aggregated practical export for independent analysis |
|---|---|---|
| Cluster frequency, bar or line | Data TSV includes every cluster/dataset count, full dataset denominator, rate, Wilson limits, pairwise difference, odds ratio, p, and q | Cluster Assignments TSV; Working-set Reads & Intervals TSV |
| Cluster composition donut | Data TSV includes segment counts, displayed denominator, fractions, and Wilson limits | Cluster Assignments TSV |
| Labeling-rule enrichment | Data TSV includes matched/total counts, Wilson limits, cluster-vs-rest counts, odds ratio, p, and q | Cluster Assignments TSV plus working-set intervals and saved labeling rules/state JSON |
| Cluster metaprofiles and overview sparklines | Data TSV contains every plotted aggregate profile bin and orientation | Working-set intervals can be used to recompute read-level contributions; the clustering response itself retains only aggregates |
| Cluster V-plots | Data TSV contains every size/position cell and bin boundary | Working-set intervals plus cluster assignments |
| PCA, UMAP, and t-SNE projections | Data TSV contains read ID, cluster, and displayed coordinates | Cluster Assignments TSV and state JSON preserve feature definitions; re-embedding from raw data requires working-set intervals and selected peak regions |
| Footprint overlap | Histogram Data TSV contains rate, Wilson limits, and denominator | Working-set intervals contain the interval observations; analysis response also retains individual first-overlap sizes |
| Footprint size distributions | Data TSV contains count, count-scale Wilson limits, and denominator per bin | Working-set intervals; Read Stats JSON for selected reads |
| Footprint profiles | Data TSV contains aggregate values and the 500-resample pointwise bootstrap limits | Working-set intervals permit a new whole-read bootstrap; returned plot data do not contain the sparse read-by-position contribution matrix |
| Footprint co-occupancy | Panel Export TSV contains per-group/pair counts, odds ratio, p, q, and supporting read IDs | The same TSV is observation-identifying; rule JSON and state JSON preserve definitions |
| Footprint V-plots | Data TSV contains every matrix cell and bin boundary | Working-set intervals |
| Footprint sequence, motif hits, and logos | Logo Data TSV contains PWM inputs and derived information values; sequence text is selectable; hit lists are returned in the analysis JSON | FASTA and footprint-rule/call bundle exports; source FASTA/motif models |
| Footprint loaded-signal overlays | Data TSV contains source/display indices, values, and highlighted footprint bins | Track Browser bedGraph/multi-TSV or the original signal file |
| Transcription-state prevalence | Data TSV contains class and segment counts, denominators, percentages, and Wilson limits | Panel per-read state TSV and full result/settings JSON |
| Elongating-count histograms | Data TSV contains counts, limits, and `n` | Panel per-read state TSV |
| Mean Pol II per cluster | Data TSV contains means and deterministic bootstrap limits | Per-read state TSV plus Cluster Assignments TSV |
| Transcription co-occurrence | Data TSV contains normalized color values, raw counts, all four contingency cells, odds ratio, p, and q | Per-read state TSV |
| Pol II center-of-mass matrices | Data TSV contains matrix kind, dataset, read ID, center-of-mass ordering value, bin, and cell value | This is already a read-observation matrix; per-read state TSV supplies classifications |
| Read Stats distributions | Data TSV contains histogram counts, intervals, and denominator | Read Stats per-read TSV; Read Stats JSON also retains CIGAR and detailed response fields |
| Annotation density | Export TSV contains type, dataset, genomic bin bounds, value, and color | Original annotation BigBed and working-set reads; the density endpoint retains only aggregate bins |
| Co-accessibility matrix/arcs/virtual 4C | Panel TSV/JSON contains values, coverage, bins, and complete settings | Matrix JSON/TSV is the direct analysis result; working-set intervals allow an alternative read-by-bin construction |
| Peak-detection signal | Data TSV contains genomic signal bins, thresholds, and peak records | Peaks BED, peak-rule JSON/state, and working-set intervals or original signal track |
| Contact matrix | Toolbar TSV contains every X/Y bin coordinate, resolution, normalized value, and effective normalization | Original `.cool`/`.mcool` is authoritative; TSV is the exact numeric viewport matrix before display scaling/colormapping |
| Contact arcs, virtual 4C, and APA | Track TSV contains filtered arc values, raw/prepared/display 4C profiles, or APA matrix values and summary scores | Cooler source plus selected peaks/regions. These descriptive views do not manufacture read-level observations from an aggregate cooler |
| BigWig/composite/metaprofile tracks | Track Browser Export view writes bedGraph or TSV | Original BigWig/BigBed plus composite/cart JSON |
| Main read, coverage, and metaprofile tracks | No pixel scraping is needed | Working-set Reads & Intervals TSV reconstructs read/layer/mark-derived displays; native source files remain authoritative |
| Single-read CIGAR/footprint view | Read Stats JSON contains the detailed selected-read record; the CIGAR string can also be copied | Original BAM is authoritative |
| Circular genome navigator | This is a coordinate navigator rather than a numeric estimator | Original plasmid/GenBank/GTF source plus navigator regions in state JSON |
| Primer and capture workflows | Panel-specific full TSV/CSV/BED/FASTA/vendor exports | The full TSV and source/state JSON retain design inputs and settings |
| Copilot/history | Command-history TSV and reloadable state JSON | State JSON includes command and labeled snapshot history |
| Python plugin histogram/donut/heatmap/profile/V-plot/scatter/table | Standard charts and plugin scatter/table offer Data TSV | The plugin response defines the observational unit. A raster-only plugin image cannot yield numeric data unless the plugin supplies a table/series alongside it |

## Reloading the exact browser state

Use either **Export data → Exact browser state (JSON)** or **Save** in the top
bar (**Save session** in the sidebar's Session section). Reload it with **Open**
in the top bar.

The JSON bundle contains:

- viewport, orientation, panels, layout, bookmarks, selections, and navigation;
- dataset and overlay source paths/URLs, reference genome, FASTA, GTF, and
  orthogonal tracks;
- clustering assignments, patterns, centroids, ordering, branches, peak
  regions/rules/locks, filters, labeling/quality rules, and sampling seed/caps;
- footprint groups, selected footprints, transcription filters, saved clusters,
  capture regions, saved tracks, annotation settings, and primer state;
- co-accessibility and contact-map view/normalization settings;
- contact cooler/BigBed source paths and portable contact/split-view settings;
- labeled undo/history snapshots, command history, and a reproducibility
  manifest with warnings.

The bundle references large source files rather than embedding their bytes.
An exact reload therefore requires the same local paths or accessible URLs.
Missing datasets, overlays, annotations, FASTA, or contact-map sources are
reported during import. Transient request/loading flags and caches are
recomputed and are intentionally not treated as scientific state.
Live linked-session IDs, their server registry, and linked-read caches are also
excluded: those resources belong to the running server process and cannot be
safely replayed from a portable file. Reconnect to a currently live linked
session after import if needed.

## Recommended external-analysis workflow

1. Save the state JSON before exporting results.
2. Export the relevant observation-level table when one exists.
3. Export the chart Data TSV to preserve the exact displayed transformation.
4. Keep the native source files and the software commit/version.
5. In an external script, join tables by `dataset_id`, `read_id`, cluster, or
   genomic bin rather than relying on row order alone.
6. Treat biological replicates—not pooled reads—as independent units for
   condition-level inference.

The state JSON plus plot TSV is sufficient to reproduce what the browser drew;
the observation-level table plus native sources is the appropriate starting
point for a different statistical analysis.
