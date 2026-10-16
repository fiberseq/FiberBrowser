# FiberBrowser analysis methods and statistical interpretation

This guide describes how FiberBrowser constructs its quantitative analyses,
what each plot represents, which statistical procedures are applied, and which
views are intentionally descriptive. It is written as a supplementary methods
reference for figures and analyses produced with the browser.

The guide describes the current implementation. Analysis settings, dataset
labels, genomic coordinates, filters, and software version should also be
recorded when reporting results.

For the matching inventory of plot TSVs, observation-level exports, source
data, and reloadable state JSON, see the
[Analysis Data Export and Reproducible State Guide](analysis_data_exports.md).

## Scope and interpretation

FiberBrowser operates primarily on single-molecule reads. Unless a section says
otherwise, the observation unit for an interval or test is one read in the
analysis working set. A working set is defined by the selected dataset or
datasets, genomic viewport, overlap/spanning mode, active cluster focus,
read-level filters, layer-quality filters, and any deterministic analysis read
cap.

The browser does not currently represent biological condition and replicate as
a first-class statistical hierarchy. Consequently:

- Read-level confidence intervals describe sampling variation among the reads
  available to the analysis.
- Read-level tests assess differences or associations in those reads.
- They do not measure between-replicate biological variation and must not be
  reported as a substitute for replicate-level inference.
- Reads from multiple libraries should not be treated as independent biological
  replicates merely because the read count is large.

For condition-level conclusions, analyze biological replicates as the
independent units. Suitable future approaches include showing replicate-level
points and using replicate resampling, permutation, generalized linear models,
or hierarchical models.

## Quick reference

| Analysis or plot | Quantity shown | Unit or denominator | Uncertainty or test |
|---|---|---|---|
| Cluster frequency | Reads assigned to a cluster as a fraction of all assigned reads in that dataset | Read; separate full denominator for every dataset | 95% Wilson interval; pairwise Fisher exact test; odds ratio; percentage-point difference; BH q-value |
| Cluster composition donut | Composition of the currently displayed cluster set | Assigned read among displayed clusters | 95% Wilson interval for each displayed segment |
| Labeling-rule enrichment by cluster | Fraction of reads in a cluster matching a rule | Assigned read in that cluster | 95% Wilson interval; cluster-versus-rest Fisher exact test; odds ratio; BH q-value |
| Cluster metaprofile | Aggregated layer signal by position | Aggregate profile currently retained by the clustering store | No interval; per-read contributions are not retained |
| Cluster V-plot | Footprint count by size and relative position | Footprint event, nested within read | Descriptive matrix; no cellwise interval or test |
| Cluster projection | PCA, UMAP, or t-SNE coordinate per read | Read | No coordinate interval or test |
| Footprint overlap | Reads with a qualifying footprint overlapping a target | All reads in the dataset working set | 95% Wilson interval |
| Footprint size histogram | First overlapping footprint size for each overlapping read | One first-overlap size per overlapping read | Per-bin 95% Wilson interval on the count scale |
| Footprint metaprofile | Interval-center counts around selected footprint centers | Whole read, preserving all events from that read | Deterministic 500-resample whole-read percentile bootstrap; pointwise 95% band |
| Footprint co-occupancy | Presence or absence of two cart rules on a read | Read | Fisher exact test; odds ratio; BH q-value |
| Footprint V-plot | Footprint count by size and relative position | Footprint event, nested within read | Descriptive matrix; no cellwise interval or test |
| Motif sequence/logo view | Reference sequence, PWM, and thresholded motif matches | Reference sequence or supplied motif model | No inferential statistic |
| Transcription-state prevalence | Fraction of reads satisfying each state definition | Classified read | 95% Wilson interval |
| Elongating Pol II count distribution | Reads in each Pol II-count category | Classified read | Per-bin 95% Wilson interval on the count scale |
| Mean Pol II per read by cluster | Mean elongating Pol II count | Read assigned to the cluster | Deterministic 1,000-resample read bootstrap; 95% percentile interval |
| Transcription-state co-occurrence | Reads positive for pairs of states | Classified read | Fisher exact test; odds ratio; BH q-value |
| Pol II center-of-mass matrix | Per-read Pol II positions | Individual read shown as a row | No interval; this is a raw-observation matrix |
| Read Stats histograms | Distribution of a read-level metric | Read with that metric | Per-bin 95% Wilson interval on the count scale |
| Read Stats footprint-size histogram | Distribution of all footprint events | Footprint event nested within read | No event-level interval |
| Annotation density profile | Annotation density across the viewport | Aggregated annotation bins | No interval; endpoint does not return observation-level contributions |
| Co-accessibility matrix | Joint accessibility or normalized association between genomic bins | Reads covering both bins | Coverage masking; no cellwise interval or significance test |
| Peak-detection signal | Smoothed per-position signal and thresholded regions | Covered positions across reads | Algorithmic thresholds; no inferential interval or test |
| Coverage and browser metaprofiles | Coverage or aggregate layer signal by position | Loaded/read-profile pool | Descriptive only |
| Contact maps and APA | Contact intensity, normalized contact value, or aggregate contact matrix | Contact-map bins or selected peak pairs | Descriptive only; no cellwise interval or significance test |
| Signal tracks | Values supplied by a loaded track | Genomic bin or interval | No sampling interval |
| Sequence logos | Supplied PWM information content | Motif-model column | No sampling interval |
| Single-read tracks and CIGAR views | One read and its observed calls/alignment | Individual read | No inferential statistic |
| Plugin charts | Plugin-defined | Plugin-defined | Only intervals supplied by the plugin are displayed |

## Statistical procedures used by the browser

### Wilson score intervals for read proportions

For a binary read-level quantity with `k` positive reads among `n` reads,
FiberBrowser reports the observed proportion

```text
p = k / n
```

and a two-sided 95% Wilson score interval. With `z = 1.9599639845`, the
interval has center

```text
(p + z^2 / (2n)) / (1 + z^2 / n)
```

and half-width

```text
z / (1 + z^2 / n) * sqrt[p(1-p)/n + z^2/(4n^2)].
```

Wilson intervals are used instead of the normal approximation because they
remain bounded by zero and one and behave better for small samples and rates
near zero or one. If `n = 0`, the displayed interval is zero to zero and no
inferential interpretation is possible.

For a histogram in which each read contributes to one bin, the same interval is
computed for the bin fraction `k/n` and multiplied by `n` so that whiskers are
drawn on the count axis. These are marginal intervals for individual bins, not
a simultaneous confidence region for the full multinomial histogram.

### Read bootstrap intervals

For continuous read-level summaries, FiberBrowser uses a nonparametric
percentile bootstrap:

1. Sample `n` reads with replacement from the `n` observed reads.
2. Recompute the statistic on the resampled reads.
3. Repeat for the configured number of resamples.
4. Use the 2.5th and 97.5th percentiles as the pointwise 95% interval.

The mean elongating Pol II analysis uses 1,000 resamples. Footprint profile
bands use 500 resamples. Seeds are derived deterministically from the analysis
seed and data identity, so the same input and settings reproduce the same
limits.

For footprint profiles, the implementation constructs a sparse
read-by-position contribution matrix and resamples complete rows. Every
interval contributed by a read therefore travels with that read during
resampling. The plotted position bins are never resampled as if they were
independent observations. When several profile layers are calculated from the
same reads, the same bootstrap read weights are reused for all layers.

Profile bands are pointwise percentile bands. They are not simultaneous bands
covering the entire profile with 95% probability, and they are displayed on the
same aggregate-count scale as the profile.

### Fisher exact tests and odds ratios

Two-sided Fisher exact tests are used for 2-by-2 read-count tables. For two
binary properties `A` and `B`, the table is

| | B present | B absent |
|---|---:|---:|
| A present | both | A only |
| A absent | B only | neither |

The two-sided p-value sums tables with the same margins whose hypergeometric
probability is no greater than that of the observed table.

The accompanying odds ratio is

```text
OR = (both * neither) / (A_only * B_only).
```

For cross-dataset cluster comparisons, `A` represents dataset membership and
`B` represents membership in the cluster; the equivalent table is shown in the
cluster section below. An odds ratio above one indicates greater odds for the
first-named group or positive co-occurrence, depending on the analysis.

For cluster frequency, labeling-rule enrichment, and transcription-state
co-occurrence, FiberBrowser adds 0.5 to all four cells before calculating the
displayed odds ratio if any cell is zero. This Haldane-Anscombe correction
avoids an infinite or undefined display value and does not alter the Fisher
p-value. Footprint co-occupancy instead reports SciPy's raw conditional-table
odds ratio, as noted in that analysis section.

### Multiple-testing correction

Where a panel performs several related tests, FiberBrowser applies the
Benjamini-Hochberg procedure to the complete analysis family. The
adjusted values are reported as `q` values and significance markers are based
on `q < 0.05`, not on the unadjusted p-value.

The current families are:

- Cluster frequency: every assigned cluster multiplied by every pair of
  datasets, including clusters temporarily hidden or omitted from the chart.
- Labeling-rule enrichment: every enabled rule multiplied by every assigned
  cluster, including clusters temporarily hidden from the chart.
- Footprint co-occupancy: every tested cart-rule pair across every dataset in
  the analysis response.
- Transcription-state co-occurrence: every unique state pair across all
  displayed datasets.

A q-value controls false discovery rate within that defined family. It does not
correct across separate browser runs, genomic regions, parameter searches, or
figures selected after inspecting many analyses.

### Effect sizes and sample sizes

P-values are not used alone. Cross-dataset cluster comparisons report the raw
counts, dataset-specific denominators, rates, percentage-point difference, and
odds ratio. Enrichment and co-occurrence analyses report odds ratios alongside
p and q values. Figures should retain the counts or `n` values wherever space
allows.

## Working sets, coverage, and filtering

Statistics are conditional on the reads admitted to the analysis. Relevant
settings include:

- Dataset selection and whether datasets are analyzed separately or combined.
- Viewport chromosome and coordinates.
- Overlapping-read versus spanning-read mode.
- Cluster focus and explicitly selected clusters.
- Minimum-footprint, terminal-gap, and related read filters.
- Per-layer quality filters.
- Selected signal/footprint layer and any legacy-layer fallback.
- Deterministic analysis sampling cap and sampling seed.

The display read limit and browser-side profile-pool limit are rendering
controls and do not, by themselves, change backend analyses. The optional
analysis cap does change the analysis working set. When it is used, results
describe the deterministic sampled working set, not every available read.

Missing data are handled analysis by analysis. A denominator normally includes
only reads for which the plotted metric is defined. Coverage-sensitive methods
either preserve the available-read denominator explicitly or mask cells below
a selected coverage threshold.

## Clustering and Cluster Detail

### Clustering assignments

FiberBrowser represents each read by accessibility features across the selected
peak regions. Feature construction is layer-aware, with an explicit selected
layer preferred and documented legacy fallbacks where applicable. K-means,
mini-batch K-means, combinatorial grouping, HDBSCAN, and agglomerative
clustering are available.

Uncapped combinatorial clustering of large linear BAM cohorts uses a columnar
path when the index estimates at least 100,000 reads or cannot estimate the
cohort size. It decodes annotations in
bounded blocks, applies the same complete-feature coverage rule, and reduces
the native positional features to one byte per pattern bit and read. Every
eligible molecule contributes to assignments and dataset denominators. Pattern
frequency ties follow first occurrence; patterns beyond the 50 retained groups
join the nearest group using the native peak-overlap weights.

The response's `analysis_storage` records the engine, input count, pattern
bytes, largest positional-feature block and maximum expanded read batch.
Assignment maps and element-membership lists still scale with the full cohort.
Other clustering algorithms, capped or selected cohorts, multi-window queries,
circular references, companion layers and active consensus overlays retain
their existing paths.

Cluster assignments are algorithmic outputs, not hypothesis tests. The browser
does not attach a p-value or confidence interval to a cluster label. K-means and
other stochastic methods use a reproducible analysis seed, but reproducibility
under one seed is not evidence of biological cluster stability. Stability
analysis would require repeated read/replicate resampling and an agreement
measure such as adjusted Rand index or cluster-wise Jaccard overlap.

### Cluster frequency and unequal dataset coverage

For cluster `c` in dataset `d`, the plotted rate is

```text
rate(c, d) = reads assigned to c in d / all assigned reads in d.
```

Each dataset retains its own full assigned-read denominator even when the
datasets have different coverage. Hiding or selecting clusters changes which
cluster series are drawn; it does not redefine the denominator for the
cross-dataset rate comparison.

For cluster `c` and datasets `i` and `j`, the Fisher test uses

| | Cluster c | Any other cluster |
|---|---:|---:|
| Dataset i | `k_i` | `N_i - k_i` |
| Dataset j | `k_j` | `N_j - k_j` |

where `N_i` and `N_j` are all assigned reads in their respective datasets. The
panel reports:

- `k_i/N_i` and `k_j/N_j`;
- the two rates and their 95% Wilson intervals;
- the signed difference `100 * (k_i/N_i - k_j/N_j)` in percentage points;
- the odds ratio;
- the two-sided Fisher p-value; and
- a BH-adjusted q-value across all assigned cluster-by-dataset-pair tests.

Hiding or selecting clusters changes which rows are drawn, but not the BH
family or the q-value for a retained cluster.

This construction separates proportion from raw count. For example, 10 cluster
reads among 100 total reads is a 10% rate, whereas 20 cluster reads among 1,000
total reads is a 2% rate. The second dataset has more cluster reads but a lower
cluster rate; both denominators are preserved in the test.

The test assumes reads are independent sampling units. It does not establish a
condition effect when each dataset is a single biological sample.

### Cluster composition donuts

The composition view shows each visible cluster's share of the reads in the
currently displayed cluster set for a dataset. If clusters are hidden, the
donut is conditional on the remaining visible clusters and its segments are
renormalized to that displayed total. Each segment is annotated with a 95%
Wilson interval using its count and the displayed total.

Because all segments sum to one, their uncertainties are dependent. The
per-segment intervals are descriptive marginal intervals rather than a joint
multinomial confidence region. Use the cluster-frequency comparison, not a
visually renormalized donut, for unequal-coverage comparisons between datasets.

### Cluster labeling-rule enrichment

For each enabled labeling rule and cluster, a read is positive if at least one
of its intervals satisfies the rule. The **Differences** chart draws, per
cluster, the bar

```text
matching reads in cluster / reads in cluster  -  matching reads in all other clusters / their reads
```

in percentage points, with Newcombe's hybrid-score 95% interval built from the
two Wilson intervals; rows are sorted from more to less common, and rows with
q >= 0.05 are faded. The export keeps both rates with their Wilson intervals.
The cluster-versus-rest Fisher table is

| | Rule positive | Rule negative |
|---|---:|---:|
| Selected cluster | matched | cluster total - matched |
| All other clusters | rest matched | rest total - rest matched |

Odds ratios, p-values, and BH q-values are reported. The BH family spans all
enabled-rule-by-assigned-cluster cells, including temporarily hidden clusters
and data merged across the datasets in the panel. Rule definitions, genomic
context, selected layer, and quality filters are part of the method and should
be reported.

### Cluster metaprofiles

Cluster overview sparklines and the Profiles tab show aggregate layer signal by
genomic position for reads assigned to each cluster. Where multiple datasets
are combined for an overview sparkline, available dataset profiles are averaged
for display.

No confidence band is currently shown. The clustering response/store retains
the aggregate profile rather than each read's positional contribution. A band
computed by resampling those aggregate bins would treat genomic positions as
independent observations and would be invalid. Valid future uncertainty needs
per-read contributions or biological-replicate profiles upstream.

### Cluster V-plots

A V-plot bins footprint events by footprint size on one axis and position
relative to the selected reference/peak on the other. In **Midpoint** mode (the
traditional V-plot) each footprint adds 1 at its centre. In **Full footprint**
mode each footprint adds to every position bin it covers, in its size row (a
partly covered bin gets the covered fraction), so a row is the occupancy of
that footprint size along the window. **Per size row** divides each row by its
mean across the window (after smoothing, before the log): 1 = as common at that
position as the size is anywhere in the window. Rows drawn from fewer than 20
footprints (`row_min_footprints`) are left at 0, since a handful of footprints
divided by their own mean is noise. Counts may be smoothed, log-transformed for
display, or normalized per cluster or with a shared scale. Those operations
change visualization scale but do not create inferential statistics.

No cellwise confidence interval or p-value is shown. Multiple events from the
same read are correlated, neighboring cells are coupled by binning and optional
smoothing, and normalized matrices may no longer retain their original count
scale. A formal comparison should predeclare a scalar feature or region and
resample complete reads or biological replicates upstream.

### Projection and autocull views

PCA, UMAP, and t-SNE place individual reads in two display dimensions from the
clustering feature matrix. The coordinates are derived embeddings, not direct
measurements, so x/y error bars would not have a meaningful sampling
interpretation. Autocull previews and cluster reassignment summaries are also
algorithmic outputs.

Report the projection method, seed, feature source, selected peaks, and any
autocull thresholds. Apparent separation is exploratory; it is not a
significance test. Stability should be evaluated by re-running feature
construction and clustering under read or replicate resampling.

### Saved clusters and branch maps

Saved cluster snapshots, merge/dissolve operations, branch maps, and ordering
views record analysis state and cluster lineage. They introduce no additional
statistical calculation.

## Footprints panel

### Footprint rule membership

A cart rule defines a reference interval, target layer, footprint-size range,
and overlap requirements. A read is a member if it contains at least one
interval satisfying all enabled requirements. Minimum footprint coverage is the
fraction of the candidate footprint covered by the reference target; minimum
target coverage is the fraction of the reference target covered by the
candidate footprint.

These rule definitions determine the binary memberships used by overlap and
co-occupancy analyses. They should be exported or reported with the selected
layer and genomic coordinates.

### Overlap rates

For each selected reference footprint and dataset, the overlap rate is

```text
reads with at least one qualifying overlap / all reads in the working set.
```

Each read contributes at most once to a given reference footprint. If cart size
groups are enabled, the numerator is restricted to overlapping reads whose
selected overlap size falls in an enabled group; the denominator remains all
working-set reads. The UI also retains the unfiltered overlap count for context.

The displayed percentage and whiskers are the binomial rate and its 95% Wilson
interval. No cross-dataset p-value is currently attached to this plot; compare
rates with their raw numerators and denominators, and use replicate-level
methods for biological condition inference.

### Footprint size distributions

For each reference footprint, FiberBrowser finds the first overlapping interval
in each matching read and bins its size in 5-bp bins from 10 bp up to, but not
including, 305 bp. Thus a read contributes no more than one size to a given
reference footprint.

For each displayed bin, FiberBrowser treats membership in that bin as a binary
read-level outcome among all reads overlapping the reference footprint. A 95%
Wilson interval for the bin fraction is converted to the histogram's count
scale. Overlapping reads with sizes outside the plotted range remain in the
denominator. The bin whiskers are marginal, not a simultaneous interval for the
full size distribution.

Mean and median size labels are empirical summaries. They do not currently
carry bootstrap intervals.

### Footprint metaprofiles

For every selected reference footprint, the center of each qualifying interval
is placed relative to the reference center. Contributions are accumulated over
the selected window, producing an aggregate interval-center count at each
relative position. Aggregate and selected per-layer profiles use the same
coordinate convention.

Uncertainty is a deterministic, 500-resample whole-read percentile bootstrap.
Each sparse matrix row contains one read's complete contributions across every
reference footprint. Rows, not positions or individual events, are sampled with
replacement. Shared read weights are used for the aggregate and all layer
profiles from the same dataset. The shaded limits are pointwise 95% bands on
the aggregate-count scale.

The bootstrap represents variation among reads in the working set. It does not
account for biological-replicate variation, uncertainty in footprint calling,
or uncertainty introduced by selecting the reference footprint after viewing
the data.

### Footprint co-occupancy

For each cart-rule pair within each dataset, every working-set read is assigned
to one of four categories: both rules, first rule only, second rule only, or
neither rule. The browser reports the four counts, supporting read identifiers,
odds ratio, two-sided Fisher p-value, and BH q-value. Correction is applied once
across every rule pair and dataset returned in that analysis run.

The footprint co-occupancy odds ratio is the raw value returned by SciPy's
two-sided Fisher-exact calculation; no 0.5 zero-cell correction is applied in
this panel. It may therefore be displayed as zero or infinity when a
contingency-table cell is zero.

An odds ratio above one indicates that the two rule-defined footprints occur
together on reads more often than expected under independence of the two binary
memberships. It does not show physical interaction or directionality. Shared
genomic accessibility, read coverage, and selection of rules can all contribute
to association.

### Footprint V-plots

The footprint V-plot is a size-by-relative-position count matrix for qualifying
interval events. Its display may use smoothing, log scaling, and configurable
position and size bins. No cellwise inferential statistics are reported for the
same dependence and scale reasons described for cluster V-plots.

### Reference sequence, motif scans, and logos

The Sequence view extracts the reference sequence around selected footprints.
Motif scanning converts a supplied PWM to a log-odds position-specific scoring
matrix with a pseudocount and scans the sequence on both strands. A match is
reported when its normalized score passes the selected threshold.

The sequence logo visualizes the supplied PWM or motif database entry. It is not
estimated from the reads displayed in the browser, so no sampling confidence
interval is shown. Motif scores and thresholds are search/model scores, not
p-values. An enrichment claim would require an explicit foreground,
background, sequence-level sampling scheme, and multiple-testing correction;
the sequence/logo view does not provide that test.

### Loaded-track overlays

Signal and annotation tracks displayed around a footprint reproduce the values
or intervals returned by the loaded track. These are deterministic overlays for
the current files and coordinates. The browser does not infer a sampling model
or add error bars to a single track.

## Transcription State Analysis

### State definitions

States are evaluated per read and per selected gene using strand-aware regions.
When an explicit TF layer is available it supplies TF-sized intervals; otherwise
the primary interval collection is used.

Current default definitions are:

- **Pause:** the median positive-size TF footprint overlapping `TSS +10` to
  `TSS +50` bp is between 35 and 65 bp, inclusive.
- **PIC:** the median positive-size TF footprint overlapping `TSS -50` to
  `TSS +25` bp is either 20-40 bp or 60-80 bp, inclusive.
- **Elongating count:** the number of 35-65 bp TF footprints overlapping the
  gene body.

Coordinates are reversed appropriately for minus-strand genes. When several
genes are selected, Boolean states are combined with logical OR and the maximum
elongating count is retained for each read. Selecting several filters uses OR
logic: a read passes if it satisfies any selected state criterion.

These are operational classifications, not latent-state probabilities. Their
thresholds should be stated in methods and interpreted in the context of the
footprint caller and selected layers.

### State prevalence

For each dataset and each state, prevalence is

```text
reads positive for the state / classified matching reads.
```

States may overlap, so they are shown as separate bars rather than slices of a
composition. Each rate has a read-level 95% Wilson interval. Intervals from
different states are dependent because one read can be positive for several
states.

### Elongating Pol II count distribution

Reads are grouped by elongating count into 1, 2, 3, and 4-or-more categories.
For each category, the Wilson interval for the category fraction among matching
reads is converted to the count scale. The categories are a multinomial
distribution, so the per-bin intervals are marginal.

### Mean Pol II per read by cluster

For each dataset and cluster, FiberBrowser calculates the arithmetic mean of
the per-read elongating counts. A deterministic 1,000-resample read bootstrap
provides the 95% percentile interval. Reads are resampled within the displayed
dataset/cluster group.

This interval concerns read-to-read variation. A condition comparison requires
biological replicates and should not pool all reads from one sample as though
they were replicate observations.

### Transcription-state co-occurrence

The heatmap cells print raw numbers of reads positive for pairs of states. Color
is normalized to the largest cell within each dataset for visualization only.
For each of the three unique pairs among Pause, PIC, and Elongating,
the browser constructs the both/first-only/second-only/neither table and reports
a two-sided Fisher p-value and odds ratio. BH correction spans every pair across
all datasets displayed in the panel.

### Pol II center-of-mass view

The center-of-mass view displays individual reads as rows, ordered by the
position of their Pol II signal. The binary and optionally smoothed matrices
are transformations of those individual observations. Because the rows are raw
observations rather than an estimated mean, no error bars are appropriate.
Smoothing affects display and ordering, not statistical significance.

## Read Stats

### Summary and table

The Summary and Table tabs report observed per-read and aggregate quantities:
accessibility percentage, footprint counts and sizes, read length/aligned span,
mapping quality, strand, edit distance, and modification counts or percentages
where available. Means, medians, totals, and strand counts are descriptive
statistics. They currently have no confidence intervals.

For BAM data, read length and alignment fields come from the alignment record.
For compact BigBed reads, read length is estimated from the span of the loaded
intervals. These sources should not be silently mixed in a methods description.
The single-read CIGAR and footprint panels show observed calls and therefore
carry no inferential statistic.

### Read-level histograms

Accessibility percentage, read length, MAPQ, and modification percentage are
read-level metrics. A read contributes to one bin for a given metric. Each bin
shows its observed read count with a marginal 95% Wilson interval converted to
the count scale; the denominator is the number of reads with that metric.

### Footprint-size event histogram

The footprint-size histogram pools all footprint events found on the selected
reads. A read may contribute several events, so event counts are clustered
within reads. FiberBrowser deliberately does not draw a generic event-level
confidence interval, because treating all events as independent would be
pseudoreplication. A valid uncertainty analysis should resample whole reads and
recompute the histogram or use a hierarchical event-within-read model.

## Annotation analyses

### Annotation density profile

The profile shows the density of each active annotation type across binned
viewport positions for the first selected dataset. The endpoint currently
returns only the summed profile bins. It does not retain a read-, file-, or
annotation-level contribution matrix from which sampling uncertainty could be
estimated.

No confidence interval is shown. Resampling the returned genomic bins would be
invalid because neighboring bins are not independent observational units. For
formal comparison, define the sampling unit—typically biological replicate or
annotation file—and recompute a profile per unit upstream.

### Annotation-based filtering and clustering

Annotation filters deterministically include reads or regions according to
overlap with selected annotation types. Annotation-based clustering constructs
features from those configured overlaps and returns cluster assignments. These
are rule/algorithm outputs with no attached p-value or confidence interval.

Annotation file, type, overlap rule, selected peaks, clustering algorithm, and
seed should be retained for reproducibility.

## Co-accessibility

FiberBrowser divides the viewport into genomic bins and constructs a
read-by-bin matrix `X`. For a read that covers a bin, `X[r,b]` is the fraction
of covered base pairs matching the selected accessibility/footprint signal. A
missing value denotes a read that does not cover the bin.

For bins `i` and `j`, pairwise coverage `n_ij` is the number of reads covering
both bins. The raw co-accessibility value is

```text
raw(i,j) = sum_r X[r,i] * X[r,j] / n_ij,
```

where the sum uses reads covering both bins. Cells with pairwise coverage below
the selected minimum are masked. Available display normalizations are:

- **Raw:** the joint fractional-signal product above, with the diagonal hidden.
- **Marginal observed/expected:** raw value divided by the outer product of the
  diagonal marginal values.
- **Distance observed/expected:** raw value divided by the mean raw value at the
  same bin separation.
- **Correlation:** pairwise Pearson correlation between bin columns, subject to
  the same minimum pairwise coverage.

The matrix, arc view, heatmap strip, and virtual-4C profile are alternate views
of these descriptive values. Coverage is shown because low-coverage cells are
unstable, but no cellwise confidence interval or p-value is reported. Cells
share reads and genomic bins, producing strong dependence; testing every cell
independently would be misleading. Formal inference should use replicate- or
block-aware resampling/permutation and a predeclared set of contrasts.

## Peak detection

For read-derived sources, the peak scanner builds per-base numerator and
coverage arrays. The plotted signal is the numerator divided by read coverage
at each position and then smoothed with a moving-average kernel. The numerator
depends on the source: qualifying intervals for accessibility/TF/layer signals
or point counts for modification marks.

Strong, Medium, Weak, and Rare thresholds are applied sequentially to the
smoothed signal. Regions passing a stronger threshold are masked before the
next layer is detected. Candidate regions must satisfy the configured minimum
width; Rare regions also enforce the minimum-read setting. Auto thresholding in
the interface derives thresholds from nonzero signal percentiles.

Peak scores and threshold classes are algorithmic detection outputs. Thresholds
are not p-values, and the browser does not attach a false-discovery rate or
confidence interval to detected peaks. Manual peaks are user annotations and
likewise have no statistical test.

## Other quantitative and descriptive views

### Browser coverage and metaprofiles

The coverage histogram is the observed number of loaded reads covering each
position. Main-browser metaprofiles are aggregate signals from the available
read/profile pool and active quality filters. They currently have no confidence
bands. The browser-side profile-pool cap, when enabled, should be reported
because it can change these display profiles even though it does not change
backend analysis endpoints.

### Contact maps, arcs, and aggregate peak analysis

Contact-map views display matrices loaded from cooler-compatible data at the
selected resolution. Depending on the view, matrix values may be raw or
balanced contact intensities, distance-normalized observed/expected values, or
display-scaled transforms. Interaction arcs are filtered and ranked
transformations of matrix cells and can additionally apply accessibility
correction. Aggregate peak analysis aligns submatrices around selected peak
pairs and averages the available windows, optionally after expected-value
normalization.

These are descriptive transformations of the supplied contact map. The browser
does not provide cellwise confidence intervals, p-values, or replicate-aware
differential contact tests. Report the source matrix, resolution, balancing,
normalization, accessibility correction, thresholds, and selected peaks.

### Signal tracks and composite tracks

BigWig and other signal profiles reproduce or combine the loaded track values.
Composite tracks may transform or average those deterministic inputs, but the
browser does not infer an observation unit for a single supplied track. Load
replicates separately or calculate a replicate-aware summary upstream if
uncertainty is required.

### Sequence logos and motif tracks

Sequence logos depict the probabilities/information content encoded by a
supplied PWM or consensus. Motif tracks display thresholded reference-sequence
matches. Neither is a sample estimate from the displayed reads, so neither has
a sampling interval or p-value.

### Raw read, footprint, CIGAR, and circular views

Single-read canvases, footprint overlays, CIGAR diagrams, linked-read views, and
circular-genome links show observed records or deterministic coordinate
transformations. Error bars are not meaningful for an individual observation.
Counts displayed in these views are descriptive.

### Primer design, capture regions, track browsing, and Copilot

Primer Design uses Primer3/BLAST-derived design and specificity metrics;
Capture Regions and Track Browser manage selected coordinates/files; and
Copilot opens panels and points at the controls that run an analysis. These are analysis
workflows rather than inferential statistical panels. Their scores, warnings,
or action summaries should not be interpreted as p-values unless the underlying
external tool explicitly defines them as such.

### Python plugin charts

Plugins may return histograms, donuts, heatmaps, profiles, V-plots, scatter
plots, or dashboards. The host browser does not guess the plugin's observational
unit. Histogram bars and profile series can display confidence limits supplied
by the plugin, but the plugin is responsible for calculating and documenting
valid limits and tests.

## Reporting recommendations

For a reproducible figure or supplementary methods section, record at least:

1. FiberBrowser version or commit.
2. Dataset labels and source files.
3. Genome build, chromosome, and viewport coordinates.
4. Overlap/spanning mode and all active read, cluster, and quality filters.
5. Selected footprint/signal layer and any custom rule definitions.
6. Analysis sampling cap and seed, if used.
7. Plot-specific parameters such as size/position bins, profile window,
   smoothing, normalization, and thresholds.
8. Raw numerators, denominators, and biological replicate counts.
9. The test family used for BH correction.
10. A statement that browser intervals/tests are read-level unless a separate
    replicate-level analysis was performed.

Suggested language for a read-level cluster-rate comparison is:

> Cluster frequencies were calculated as the number of reads assigned to each
> cluster divided by all assigned reads in the corresponding dataset. Read-level
> 95% confidence intervals used the Wilson score method. Dataset pairs were
> compared for each cluster using two-sided Fisher exact tests on cluster versus
> non-cluster read counts; Benjamini-Hochberg correction was applied across all
> assigned cluster-by-dataset-pair tests, independent of chart visibility.
> These analyses quantify read-level
> sampling precision and were not treated as biological-replicate inference.

Suggested language for a footprint profile is:

> Footprint profiles were constructed by accumulating interval centers relative
> to the selected reference centers. Pointwise 95% confidence bands were
> calculated with 500 deterministic bootstrap resamples of complete reads,
> preserving all interval contributions from each resampled read. Bands describe
> read-level sampling variation and are not simultaneous or replicate-level
> confidence bands.

## Cases where no statistics are the correct choice

Absence of an error bar does not necessarily mean an analysis is incomplete.
FiberBrowser omits generic uncertainty when:

- the plot shows individual observations rather than an estimated summary;
- values are deterministic outputs from a supplied file or model;
- only aggregated bins remain and the original observation units are no longer
  available;
- events are nested within reads and an event-level interval would create
  pseudoreplication;
- cells share observations so strongly that independent cellwise tests would be
  misleading; or
- the plotted coordinates are derived visualization coordinates rather than
  measured quantities.

In these cases, the preferred extension is to preserve or provide the correct
observation-level contributions—ideally biological replicates—and perform a
predeclared, dependence-aware comparison upstream.

## Statistical references

- Wilson EB. Probable inference, the law of succession, and statistical
  inference. *Journal of the American Statistical Association*. 1927;
  22(158):209-212. doi:10.1080/01621459.1927.10502953.
- Fisher RA. *Statistical Methods for Research Workers*. Edinburgh: Oliver and
  Boyd; 1925.
- Benjamini Y, Hochberg Y. Controlling the false discovery rate: a practical and
  powerful approach to multiple testing. *Journal of the Royal Statistical
  Society, Series B*. 1995;57(1):289-300.
- Efron B, Tibshirani RJ. *An Introduction to the Bootstrap*. New York: Chapman
  & Hall/CRC; 1993.
