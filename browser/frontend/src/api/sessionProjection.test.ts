import { describe, expect, it } from 'vitest';
import { applyImportedState, collectFrontendState } from './session';
import { useBrowserStore } from '../stores/browserStore';
import { currentReadProjection, projectionInputSignature } from '../utils/projectionExport';

/** fb-r3-tsne: the kept t-SNE map travels with the session and doesn't leak into another. */
describe('session: the Projection map', () => {
  const map = {
    method: 'tsne', chrom: '2R', start: 1000, end: 2000, signature: 'sig',
    params: { random_state: 42 }, coords: { ds1: { r1: [1, 2] as [number, number] } },
  };

  it('exports and restores the kept map and the graph resolution', () => {
    useBrowserStore.setState({ chrom: '2R', start: 1000, end: 2000, clusterResolution: 2.5 } as any);
    // A map of the current inputs (integ-r4: only such a map is saved).
    const current = { ...map, signature: projectionInputSignature(useBrowserStore.getState()) };
    useBrowserStore.setState({ readProjection: current } as any);
    const saved = collectFrontendState();
    expect(saved.readProjection).toEqual(current);
    useBrowserStore.setState({ readProjection: null, clusterResolution: 1 } as any);
    applyImportedState({
      datasets: [{ id: 'ds1', label: 'ds1', path: '/a.bam' }] as any, overlays: [], has_fasta: false,
      frontend: saved, viewport: { chrom: '2R', start: 1000, end: 2000 },
    });
    const restored = useBrowserStore.getState();
    expect(restored.readProjection).toMatchObject({ method: 'tsne', coords: map.coords, params: map.params });
    // Still the map of the restored inputs, though the import bumped the refresh counter (Codex review, integ-r4):
    // the cluster TSV keeps its x/y columns.
    expect(currentReadProjection(restored.readProjection, restored)).not.toBeNull();
    expect(restored.clusterResolution).toBe(2.5);
  });

  it('a map that no longer matches its inputs is not saved (integ-r4)', () => {
    useBrowserStore.setState({ chrom: '2R', start: 1000, end: 2000, readProjection: map } as any);
    expect(collectFrontendState().readProjection).toBeUndefined();
  });

  it("drops the previous session's map when the imported one has none", () => {
    useBrowserStore.setState({ chrom: '2R', start: 1000, end: 2000, readProjection: map } as any);
    applyImportedState({
      datasets: [{ id: 'ds1', label: 'ds1', path: '/b.bam' }] as any, overlays: [], has_fasta: false,
      viewport: { chrom: '2R', start: 1000, end: 2000 },
    });
    expect(useBrowserStore.getState().readProjection).toBeNull();
  });
});
