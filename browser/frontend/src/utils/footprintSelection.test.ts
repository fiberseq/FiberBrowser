import { describe, expect, it } from 'vitest';
import { isSelectedFootprint } from './footprintSelection';
import { useBrowserStore } from '../stores/browserStore';
import type { SelectedFootprint } from '../types';

const selected: SelectedFootprint = {
  readId: 'r', datasetId: 'ds', intervalIndex: 0,
  relStart: 10, relEnd: 60, size: 50, absStart: 100, absEnd: 150, chrom: 'chr1', layer: null,
};

describe('footprint selection identity', () => {
  it('after panning, the same index names another footprint, which is not selected', () => {
    // View [190,280): the read's next footprint [200,250) is index 0 there too.
    expect(isSelectedFootprint(selected, { readId: 'r', datasetId: 'ds', chrom: 'chr1', absStart: 200, absEnd: 250 })).toBe(false);
    // The selected footprint itself, clipped at a window edge, still matches.
    expect(isSelectedFootprint(selected, { readId: 'r', datasetId: 'ds', chrom: 'chr1', absStart: 120, absEnd: 150 })).toBe(true);
    // Same bounds on an aliased chromosome name still match; another chromosome doesn't.
    expect(isSelectedFootprint(selected, { readId: 'r', datasetId: 'ds', chrom: '1', absStart: 100, absEnd: 150 })).toBe(true);
    expect(isSelectedFootprint(selected, { readId: 'r', datasetId: 'ds', chrom: 'chr2', absStart: 100, absEnd: 150 })).toBe(false);
  });

  it('Cmd-click toggles the same footprint off, and adds another with a reused index', () => {
    useBrowserStore.setState({ selectedFootprints: [selected] } as never);
    const other = { ...selected, absStart: 200, absEnd: 250, relStart: 10, relEnd: 60 };
    useBrowserStore.getState().selectFootprint(other, true);
    expect(useBrowserStore.getState().selectedFootprints).toHaveLength(2);
    useBrowserStore.getState().selectFootprint({ ...selected, intervalIndex: 3 }, true);
    expect(useBrowserStore.getState().selectedFootprints.map(f => f.absStart)).toEqual([200]);
  });
});
