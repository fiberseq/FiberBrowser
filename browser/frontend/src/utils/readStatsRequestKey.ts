interface ReadStatsRequestKeyInput {
  chrom: string;
  start: number;
  end: number;
  spanning: boolean;
  readIdsByDataset: Record<string, string[]>;
  sampleSeed?: string;
  /** Selections in panels at another locus, each with its region. */
  extraRegions?: Array<{ chrom: string; start: number; end: number; read_ids_by_dataset: Record<string, string[]> }>;
  /** Settings that change the server's reads (quality filters, layer inference, refresh generation). */
  analysisSettingsKey?: string;
}

function normalizeReadIdsByDataset(readIdsByDataset: Record<string, string[]>) {
  return Object.entries(readIdsByDataset)
    .filter(([, readIds]) => readIds.length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([datasetId, readIds]) => [datasetId, [...new Set(readIds)].sort()] as const);
}

/**
 * Stable semantic key for selected-read stats requests.
 *
 * The table sort/viewer order can change without changing the stats payload, so
 * read IDs are normalized as sets. This prevents duplicate backend calls while
 * still refetching when the scoped region, seed, or selected IDs change.
 */
export function buildReadStatsRequestKey(input: ReadStatsRequestKeyInput): string {
  return JSON.stringify({
    kind: 'fiberbrowser.read_stats.v1',
    chrom: input.chrom,
    start: input.start,
    end: input.end,
    spanning: input.spanning,
    readIdsByDataset: normalizeReadIdsByDataset(input.readIdsByDataset),
    sampleSeed: input.sampleSeed ?? null,
    analysisSettings: input.analysisSettingsKey ?? null,
    extraRegions: (input.extraRegions ?? [])
      .map(r => [r.chrom, r.start, r.end, normalizeReadIdsByDataset(r.read_ids_by_dataset)] as const)
      .filter(([, , , ids]) => ids.length > 0)
      .sort((a, b) => `${a[0]}:${a[1]}-${a[2]}`.localeCompare(`${b[0]}:${b[1]}-${b[2]}`)),
  });
}

/**
 * A fetched result only stands for the request it was fetched for: once the
 * selection or scope changes (or its refresh fails), the old stats must not be
 * shown or exported under the new request's settings.
 */
export function resultForRequest<T>(fetched: { key: string; data: T } | null, requestKey: string): T | null {
  return fetched && fetched.key === requestKey ? fetched.data : null;
}
