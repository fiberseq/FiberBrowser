import type { ProjectionMethod } from '../api/clustering';

interface ClusterVplotRequestKeyInput {
  chrom: string;
  start: number;
  end: number;
  sizeBin: number;
  posBin: number;
  sizeMin: number;
  sizeMax: number;
  logNorm: boolean;
  smooth: number;
  layer: string | null;
  normalize: 'per_cluster' | 'shared';
  /** Midpoint (traditional) or full-footprint V-plot. */
  mode?: 'midpoint' | 'span';
  rowNormalize?: boolean;
  sampleSeed: string;
  assignmentSignature?: string;
}

interface ClusterProjectionRequestKeyInput {
  chrom: string;
  start: number;
  end: number;
  datasetIds: string[];
  method: ProjectionMethod;
  spanning: boolean;
  simulateAutocull: boolean;
  minFraction: number;
  maxCosineSimilarity: number;
  /** "Merge by" of the merge preview (absent: cosine). */
  mergeStrategy?: string;
  mergeThreshold?: number;
  subnucleosomalThreshold: number;
  accessibilityThreshold: number;
  sampleSeed: string;
  assignmentSignature?: string;
}

interface ClusterEnrichmentRequestKeyInput {
  chrom: string;
  start: number;
  end: number;
  datasetIds: string[];
  /** Read layers the enrichment rules need (TF plus rule targets). */
  layers?: string[];
  /** Settings that change the server's reads (see useAnalysisSettingsKey). */
  analysisSettingsKey?: string;
}

function sortedValues(values: string[]): string[] {
  return [...values].sort();
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function buildClusterAssignmentSignature(
  assignmentsByDataset: Record<string, Record<string, number>>,
  datasetIds: string[],
): string {
  return sortedValues(datasetIds)
    .map(datasetId => {
      const assignments = assignmentsByDataset[datasetId] ?? {};
      const encoded = Object.entries(assignments)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([readId, cluster]) => `${readId}:${cluster}`)
        .join('|');
      return `${datasetId}:${Object.keys(assignments).length}:${hashString(encoded)}`;
    })
    .join(';');
}

export function buildClusterVplotRequestKey(input: ClusterVplotRequestKeyInput): string {
  return JSON.stringify({
    kind: 'fiberbrowser.cluster_detail.vplot.v1',
    chrom: input.chrom,
    start: input.start,
    end: input.end,
    sizeBin: input.sizeBin,
    posBin: input.posBin,
    sizeMin: input.sizeMin,
    sizeMax: input.sizeMax,
    logNorm: input.logNorm,
    smooth: input.smooth,
    layer: input.layer ?? null,
    normalize: input.normalize,
    mode: input.mode ?? 'midpoint',
    rowNormalize: input.rowNormalize ?? false,
    sampleSeed: input.sampleSeed,
    assignmentSignature: input.assignmentSignature ?? null,
  });
}

export function buildClusterProjectionRequestKey(input: ClusterProjectionRequestKeyInput): string {
  return JSON.stringify({
    kind: 'fiberbrowser.cluster_detail.projection.v1',
    chrom: input.chrom,
    start: input.start,
    end: input.end,
    datasetIds: sortedValues(input.datasetIds),
    method: input.method,
    spanning: input.spanning,
    simulateAutocull: input.simulateAutocull,
    minFraction: input.minFraction,
    maxCosineSimilarity: input.maxCosineSimilarity,
    mergeStrategy: input.mergeStrategy ?? 'cosine',
    mergeThreshold: input.mergeThreshold ?? null,
    subnucleosomalThreshold: input.subnucleosomalThreshold,
    accessibilityThreshold: input.accessibilityThreshold,
    sampleSeed: input.sampleSeed,
    assignmentSignature: input.assignmentSignature ?? null,
  });
}

export function buildClusterEnrichmentRequestKey(input: ClusterEnrichmentRequestKeyInput): string {
  return JSON.stringify({
    kind: 'fiberbrowser.cluster_detail.enrichment_reads.v1',
    chrom: input.chrom,
    start: input.start,
    end: input.end,
    datasetIds: sortedValues(input.datasetIds),
    layers: sortedValues(input.layers ?? []),
    analysisSettings: input.analysisSettingsKey ?? null,
  });
}
