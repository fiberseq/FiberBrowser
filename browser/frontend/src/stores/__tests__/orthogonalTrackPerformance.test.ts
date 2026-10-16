import { beforeEach, describe, expect, it } from 'vitest';
import { createTestStore } from './helpers';
import type { OrthogonalTrack } from '../../types';

let store: ReturnType<typeof createTestStore>;

beforeEach(() => {
  localStorage.clear();
  store = createTestStore();
});

function valuesFor(trackIdx: number, iteration: number, bins: number): number[] {
  return Array.from({ length: bins }, (_, bin) => (trackIdx + 1) * ((bin + iteration) % 11));
}

function makeTracks(count: number, bins: number, changedIdx = -1, iteration = 0): OrthogonalTrack[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    label: `Track ${index}`,
    path: `/tracks/${index}.bw`,
    format: 'bigWig',
    renderMode: 'signal',
    values: valuesFor(index, index === changedIdx ? iteration : 0, bins),
  }));
}

describe('orthogonal track refresh benchmark', () => {
  it('keeps metadata references stable during large viewport data refreshes', () => {
    const trackCount = 96;
    const bins = 1400;
    store.getState().setOrthogonalTracks(makeTracks(trackCount, bins));
    const metadataRefs = store.getState().orthogonalTracks.slice();
    const unchangedDataRef = store.getState().orthogonalTrackData[10];

    const started = performance.now();
    for (let iteration = 1; iteration <= 16; iteration++) {
      store.getState().setOrthogonalTracks(makeTracks(trackCount, bins, 0, iteration));
    }
    const elapsedMs = performance.now() - started;

    expect(store.getState().orthogonalTracks).toHaveLength(trackCount);
    for (let i = 0; i < trackCount; i++) {
      expect(store.getState().orthogonalTracks[i]).toBe(metadataRefs[i]);
    }
    expect(store.getState().orthogonalTrackData[10]).toBe(unchangedDataRef);
    expect(store.getState().orthogonalTrackData[0].values).toEqual(valuesFor(0, 16, bins));

    // This is intentionally a broad guardrail, not a machine-specific target.
    // It catches accidental quadratic churn in the hot viewport refresh path.
    expect(elapsedMs).toBeLessThan(1000);
  });
});
