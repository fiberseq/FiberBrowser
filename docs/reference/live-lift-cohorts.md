# Live-lift clustering cohorts

With live lift enabled, native BAMs and live-lift MAT/PAT panels can share a
clustering model. The default panels remain split by haplotype; pooled panels
use the same cohort. Cluster colours and filters identify lifted rows by
`analysis_id`; `id` remains the original read name for display and locate.

Preparation runs inside working-set construction, before spanning, ID,
strand, footprint-count and read-cap filters. Broad caches retain unfiltered
lifted rows. Display and analysis working sets have separate cache identities.
All advanced settings participate in the lift identity and sessions.

The default analysis keeps every record and excludes alternative placements,
independently of whether supplementary or alternative rows are displayed.
`cohort_supplementaries` also accepts `follow_display` and `primary_only`;
`cohort_alternatives=include` permits hidden alternatives in analyses.
`fold_orientation_rows` combines a record's rows, and `fold_molecule` combines
its records, per placement. Display rows remain separate and share the folded
cohort row's cluster colour. Primary records, primary chains, then the lowest
target coordinate win overlapping molecular placements. Call IDs remain local
to their records; split parts count once, including after crops and quality
filters. Quality tracks stay aligned when rows fold.

Features use continuous projected body spans. Connectors, synthetic target
holes and expanded insertion payloads contribute no accessible intervals.
Legacy MSPs are inferred within individual continuous segments. Coverage
requirements and metaprofile denominators use the same body spans.

## Shared molecules

Advanced Live-lift settings expose a provenance group per source BAM and per
open native BAM. Blank labels keep libraries separate. Equal read names do
not establish sharing. A molecule is identified by provenance group plus
QNAME. Every joint fit reports `joint_cohort.shared_molecules`, pair counts,
resolved `policy`, `removed_rows` and final row count. These counts refer to
the eligible cohorts supplied to the fit, after coverage and cap filters.

Both copies are kept by default. `joint_dedup=by_molecule` applies only when
all participating datasets with shared provenance groups request it,
including datasets with no eligible rows. Winners are deterministic: native,
then dataset ID, then analysis ID. Deduplication occurs once after collecting
all windows and before extracting features. Distinct alternative or record
rows can make the number of removed rows exceed the shared-molecule count.

Native declarations use `POST /api/lift/provenance/{dataset_id}` with
`molecule_groups: [[bam_path, group], ...]` and `joint_dedup`. Lifted datasets
also accept these through their existing settings endpoint. Declarations are
saved and relinked with sessions; native source identities include them.

## Supported analysis routes

`cluster_all`, `cluster_matched_views`, `cluster_projection`,
`assign_to_clusters`, `auto_cull_clusters` and `dissolve_cluster` accept lifted
cohorts through the service capability matrix. Cluster and dynamic windows,
and matched panels, accept `lift_hap`; it combines with explicit read scopes.
Grouping source `lift_hap` reads configuration only. Pooled in-panel grouping
derives assignments from loaded rows and follows subsequent loads.

Results include cohort policy/count metadata. Its `scope` distinguishes the
broad loaded cohort from viewport `overlapping_rows`, `used_rows`, and the
final result's `analysis_read_count`. Clustering counts refer to cohort rows;
several display rows can represent one folded row.

Other analyses remain refused, including standalone metaprofiles, peak scans,
co-accessibility, read statistics, figures, consensus, exports and dataset
merging. The shared geometry helpers are ready for later expansion; native
columnar clustering remains restricted to native BAM datasets.
