import { describe, expect, it } from 'vitest';
import { analysisSettingsKey } from './useAnalysisSettingsKey';
import { buildTranscriptionStateRequestKey } from '../utils/transcriptionStateRequestKey';
import { buildClusterEnrichmentRequestKey } from '../utils/clusterDetailRequestKey';

describe('analysis settings key (round 12)', () => {
  const off = [{ layer: 'tf', qualityName: 'tq', minValue: 0, enabled: true }];
  const on = [{ layer: 'tf', qualityName: 'tq', minValue: 20, enabled: true }];

  it('changes with an active quality cutoff, the refresh generation and layer inference', () => {
    const base = analysisSettingsKey(0, true, 90, off);
    expect(analysisSettingsKey(0, true, 90, on)).not.toBe(base);
    expect(analysisSettingsKey(1, true, 90, off)).not.toBe(base);
    expect(analysisSettingsKey(0, false, 90, off)).not.toBe(base);
    // A disabled or zero cutoff filters nothing: same key.
    expect(analysisSettingsKey(0, true, 90, [{ ...on[0], enabled: false }])).toBe(base);
  });

  it('is part of the transcription and enrichment request keys', () => {
    const t = (analysisSettingsKey?: string) => buildTranscriptionStateRequestKey({
      chrom: 'chr1', start: 0, end: 100, spanning: true, datasetIds: ['a'], geneIds: ['g'],
      filters: { pause: true, pic: true, elongating: 1, elongating_max: null }, sampleSeed: 's', analysisSettingsKey,
    });
    expect(t(analysisSettingsKey(0, true, 90, off))).not.toBe(t(analysisSettingsKey(0, true, 90, on)));
    const e = (analysisSettingsKey?: string) => buildClusterEnrichmentRequestKey({
      chrom: 'chr1', start: 0, end: 100, datasetIds: ['a'], layers: ['tf'], analysisSettingsKey,
    });
    expect(e(analysisSettingsKey(0, true, 90, off))).not.toBe(e(analysisSettingsKey(0, true, 90, on)));
  });
});
