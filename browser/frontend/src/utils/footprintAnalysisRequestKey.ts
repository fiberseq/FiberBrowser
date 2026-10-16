import type { SelectedFootprintAPI } from '../api/footprints';

interface FootprintAnalysisRequestKeyInput {
  chrom: string;
  start: number;
  end: number;
  spanning: boolean;
  footprints: SelectedFootprintAPI[];
  datasetIds: string[];
  readScopeKey: string;
  layer: string | null;
  maxReads?: number | null;
  sampleSeed: string;
}

function sortedValues(values: string[]): string[] {
  return [...values].sort();
}

function encodeFootprints(footprints: SelectedFootprintAPI[]) {
  return footprints.map(fp => [
    fp.datasetId,
    fp.readId,
    fp.absStart,
    fp.absEnd,
    fp.size,
  ] as const);
}

export function buildFootprintAnalysisRequestKey(input: FootprintAnalysisRequestKeyInput): string {
  return JSON.stringify({
    kind: 'fiberbrowser.footprint_analysis.selection.v1',
    chrom: input.chrom,
    start: input.start,
    end: input.end,
    spanning: input.spanning,
    footprints: encodeFootprints(input.footprints),
    datasetIds: sortedValues(input.datasetIds),
    readScopeKey: input.readScopeKey,
    layer: input.layer ?? null,
    maxReads: input.maxReads ?? null,
    sampleSeed: input.sampleSeed,
  });
}
