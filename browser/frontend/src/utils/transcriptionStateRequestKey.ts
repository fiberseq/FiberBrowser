import type { TranscriptionStateFilters } from '../types';

interface TranscriptionStateRequestKeyInput {
  chrom: string;
  start: number;
  end: number;
  spanning: boolean;
  datasetIds: string[];
  geneIds: string[];
  filters: TranscriptionStateFilters;
  sampleSeed: string;
  /** Settings that change the server's reads (see useAnalysisSettingsKey). */
  analysisSettingsKey?: string;
}

function sortedValues(values: string[]): string[] {
  return [...values].sort();
}

export function buildTranscriptionStateRequestKey(input: TranscriptionStateRequestKeyInput): string {
  return JSON.stringify({
    kind: 'fiberbrowser.transcription_state.v1',
    chrom: input.chrom,
    start: input.start,
    end: input.end,
    spanning: input.spanning,
    datasetIds: sortedValues(input.datasetIds),
    geneIds: sortedValues(input.geneIds),
    filters: input.filters,
    sampleSeed: input.sampleSeed,
    analysisSettings: input.analysisSettingsKey ?? null,
  });
}
