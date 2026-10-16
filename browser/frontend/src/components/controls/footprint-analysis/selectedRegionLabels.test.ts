import { describe, expect, it } from 'vitest';
import type { PanelConfig } from '../../../types';
import { selectedRegionLabels } from './selectedRegionLabels';

const panel = (id: string, datasetId: string, over: Partial<PanelConfig> = {}) =>
  ({ id, contentType: 'dataset', datasetId, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...over }) as PanelConfig;

/**
 * fb-n3-clusters (audit M4): the Footprints "regions selected" list put peaks
 * picked in the dm6 panel on the main view's chromosome (chr19:6,356,930-...).
 */
describe('Footprints selected-region list', () => {
  const ctx = {
    chrom: 'chr19', start: 47_514_262, end: 47_519_210,
    panels: [
      panel('ph', 'napa'),
      panel('pf', 'flyamp', { genome: 'dm6', viewportOverride: { chrom: 'chr2L', start: 6_356_793, end: 6_357_648 } }),
    ],
    referenceName: (key: string) => key,
  };

  it('peaks keep their own chromosome and reference', () => {
    expect(selectedRegionLabels([], [
      { absStart: 47_515_000, absEnd: 47_515_200, size: 200 },
      // Scanned on dm6 (its reference recorded) and drawn there (only its chromosome).
      { absStart: 6_356_930, absEnd: 6_357_166, size: 236, chrom: 'chr2L', genome: 'dm6' },
      { absStart: 6_357_191, absEnd: 6_357_572, size: 381, chrom: 'chr2L' },
    ], ctx)).toEqual([
      'chr19:47,515,000-47,515,200 (200bp)',
      'dm6 chr2L:6,356,930-6,357,166 (236bp)',
      'dm6 chr2L:6,357,191-6,357,572 (381bp)',
    ]);
  });

  it('footprints carry their panel\'s reference', () => {
    expect(selectedRegionLabels([
      { chrom: 'chr2L', absStart: 6_357_000, absEnd: 6_357_040, size: 40, datasetId: 'flyamp', stateKey: 'flyamp' },
      { chrom: 'chr19', absStart: 47_515_000, absEnd: 47_515_040, size: 40, datasetId: 'napa' },
    ], [], ctx)).toEqual(['dm6 chr2L:6,357,000-6,357,040 (40bp)', 'chr19:47,515,000-47,515,040 (40bp)']);
  });
});
