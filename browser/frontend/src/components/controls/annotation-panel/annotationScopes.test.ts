import { describe, expect, it } from 'vitest';
import type { PanelConfig } from '../../../types';
import { annotationRegionScopes } from './annotationScopes';

const panel = (id: string, datasetId: string, extra: Partial<PanelConfig> = {}) =>
  ({ id, datasetId, contentType: 'dataset', ...extra }) as PanelConfig;

describe('annotationRegionScopes', () => {
  it('filters an independent panel at its own locus, apart from the main view', () => {
    const panels = [
      panel('p1', 'a'),
      panel('p2', 'a', { stateKey: 'p2', viewportOverride: { chrom: 'chr2', start: 5, end: 50 } }),
      panel('p3', 'b'),
    ];
    const scopes = annotationRegionScopes(['a', 'p2', 'b'], { a: 'a', p2: 'a', b: 'b' }, panels,
      { chrom: 'chr1', start: 0, end: 100 });
    expect(scopes).toEqual([
      { chrom: 'chr1', start: 0, end: 100, datasetIds: ['a', 'b'], stateKeysByDataset: { a: ['a'], b: ['b'] } },
      { chrom: 'chr2', start: 5, end: 50, datasetIds: ['a'], stateKeysByDataset: { a: ['p2'] } },
    ]);
  });
});
