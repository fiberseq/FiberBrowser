# Indexed edge fetching

An overlapping pan or outward zoom can reuse a completed direct BAM cohort.
The server queries the BAM index only for newly exposed left and right ranges.
Alignments crossing either exposed range are decoded in the whole new view's
coordinate frame; alignments entirely within the overlap retain their cached
evidence. Identical physical records remain distinct through library identity,
record digest and occurrence number. Reads fetched through both edges appear
once. The extended cache is sorted by alignment start.

This path serves complete, unsampled, single-file linear BAM views with
compatible options and canonical footprint layers. Filters or source geometry
that cannot be projected exactly use a full load. Dataset generations protect
cache publication; failed or cancelled edge reads publish no partial cohort.
Circular headers are checked independently of the workspace's circular flags.
Views that lose all primary modification evidence reload when clipping could
enable the BAM loader's IUPAC or mismatch fallback; omitted raw evidence is not
reconstructed from cached annotations.

The API still returns a complete read payload. Indexed I/O and annotation
decoding are reduced only for reusable interior alignments. Long molecules
crossing the new edge are read again to obtain their newly visible evidence.
`server_timings` reports `direct_edge_load_ms`, `direct_edge_bases` and
`direct_reused_span_bases` when extension succeeds.

Regression checks compare full evidence and physical-record identities with
fresh full-window BAM loads for left, right and two-sided extensions, including
duplicate records, methylation, annotation qualities and parallel decoding.
