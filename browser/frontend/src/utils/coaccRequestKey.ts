import type { Gene } from '../types';

interface CoaccMatrixRequestKeyInput {
  chrom: string;
  start: number;
  end: number;
  datasetIds: string[];
  normalization: string;
  scaling: string;
  colormap: string;
  minCoverage: number;
  binSize: number;
  readIds?: string[];
  readIdsByDataset?: Record<string, string[]>;
  signalType: string;
  layer?: string | null;
  sampleSeed: string;
  maxSize: number;
  genes: Gene[];
  refreshKey: number;
  /** Quality filters and layer inference in effect (see useAnalysisSettingsKey). */
  analysisKey?: string;
}

function sortedValues(values: string[] | undefined): string[] | undefined {
  return values ? [...values].sort() : undefined;
}

function normalizeReadIdsByDataset(readIdsByDataset: Record<string, string[]> | undefined) {
  if (!readIdsByDataset) return undefined;
  return Object.entries(readIdsByDataset)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([datasetId, readIds]) => [datasetId, sortedValues(readIds)] as const);
}

function normalizeGenes(genes: Gene[], regionStart: number, regionEnd: number) {
  return genes
    .filter(gene => gene.end > regionStart && gene.start < regionEnd)
    .map(gene => [gene.id, gene.name ?? '', gene.chrom, gene.start, gene.end, gene.strand] as const)
    .sort((a, b) => `${a[2]}:${a[3]}:${a[4]}:${a[0]}`.localeCompare(`${b[2]}:${b[3]}:${b[4]}:${b[0]}`));
}

/**
 * Build a semantic request key for the co-accessibility matrix.
 *
 * React props such as read-scope records and arrays can be re-created with the
 * same values during parent rerenders. Keying the matrix effect on this stable
 * representation prevents duplicate requests and stale loading overlays.
 */
export function buildCoaccMatrixRequestKey(input: CoaccMatrixRequestKeyInput): string {
  return JSON.stringify({
    kind: 'fiberbrowser.coacc.matrix.v1',
    chrom: input.chrom,
    start: input.start,
    end: input.end,
    datasetIds: sortedValues(input.datasetIds) ?? [],
    normalization: input.normalization,
    scaling: input.scaling,
    colormap: input.colormap,
    minCoverage: input.minCoverage,
    binSize: input.binSize,
    readIds: sortedValues(input.readIds),
    readIdsByDataset: normalizeReadIdsByDataset(input.readIdsByDataset),
    signalType: input.signalType,
    layer: input.layer ?? null,
    sampleSeed: input.sampleSeed,
    maxSize: input.maxSize,
    genes: normalizeGenes(input.genes, input.start, input.end),
    refreshKey: input.refreshKey,
    analysisKey: input.analysisKey ?? '',
  });
}
