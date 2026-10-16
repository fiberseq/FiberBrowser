import { describe, expect, it } from 'vitest';
import { mainViewStateKeys } from './mainViewPanels';
import type { PanelConfig } from '../types';

describe('mainViewStateKeys', () => {
  it('keeps panels showing the main view and leaves out a copy at another locus', () => {
    const panels = [
      { id: 'p1', contentType: 'dataset', datasetId: 'ds' },
      { id: 'p2', contentType: 'dataset', datasetId: 'ds', stateKey: 'copy-here', viewportOverride: { chrom: 'chr1', start: 0, end: 1000 } },
      { id: 'p3', contentType: 'dataset', datasetId: 'ds', stateKey: 'copy-away', viewportOverride: { chrom: 'chr2', start: 0, end: 1000 } },
      { id: 'p4', contentType: 'cluster-detail' },
    ] as unknown as PanelConfig[];
    expect(mainViewStateKeys({ panels, chrom: 'chr1', start: 0, end: 1000 })).toEqual(['ds', 'copy-here']);
  });
});
