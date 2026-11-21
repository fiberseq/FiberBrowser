import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyPatchLabels, patchLabelsFor, resetPatchLabels, syncPatchLabels, useNucPatchLabels } from './nucPatchLabels';
import { nucPatchRows } from './nucLayers';
import { fetchApiResponse } from '../api/sharedFetch';
import { readRegionGeneration } from '../api/loadedReadRegion';

// A live row's nucpatch layer: score, period, flags, geometry, root, patch index (1-based); `lk` = file tag:record,
// `pg` = the patch generation of its patches.
const layer = (lk: string | undefined, geo: number[], root: number[], pg: string | undefined = 'P1') => ({
  intervals: [[0, 100], [200, 300]] as [number, number][],
  qualities: [[200, 200], [90, 90], [0, 0], geo, root, [1, 2]],
  ...(lk ? { lk } : {}), ...(pg ? { pg } : {}),
});

describe('nucpatch geometry label overlay', () => {
  afterEach(() => { resetPatchLabels(); vi.unstubAllGlobals(); });

  it('uses the row\'s own bytes until labels of the same patch generation are loaded for its dataset, then the overlay', () => {
    const row = layer('f1:abc:0', [3, 0], [3, 0]);
    expect(nucPatchRows(row, 'ds')!.map(p => [p.geometry, p.root])).toEqual([[3, 3], [0, 0]]);
    // a relabel: the second patch is now in geometry 2 (folded into 1), the first in none
    applyPatchLabels({ ds: { identity: 'x', files: ['f1'], labels: { 'f1:abc:0': [[1, 2, 1]] }, pg: 'P1' } });
    expect(nucPatchRows(row, 'ds')!.map(p => [p.geometry, p.root])).toEqual([[0, 0], [2, 1]]);
    // a record of a loaded file absent from the labels: no geometry
    expect(nucPatchRows(layer('f1:zzz:0', [5, 5], [5, 5]), 'ds')!.map(p => p.root)).toEqual([0, 0]);
    // another file, or a row without a key (a scan's patches): its own bytes
    expect(nucPatchRows(layer('f9:abc:0', [4, 0], [4, 0]), 'ds')!.map(p => p.root)).toEqual([4, 0]);
    expect(nucPatchRows(layer(undefined, [4, 0], [4, 0]), 'ds')!.map(p => p.root)).toEqual([4, 0]);
    expect(patchLabelsFor('f1:abc:0', 'P1', 'ds')?.get(1)).toEqual([2, 1]);
  });

  it('applies labels only to rows of the same patch generation (rows called under other settings keep their own bytes)', () => {
    applyPatchLabels({ ds: { identity: 'x', files: ['f1'], labels: { 'f1:abc:0': [[1, 2, 1]] }, pg: 'NEW' } });
    // rows still loaded from before a setting change: other patches, never relabelled by ordinal index
    expect(nucPatchRows(layer('f1:abc:0', [3, 0], [3, 0], 'OLD'), 'ds')!.map(p => p.root)).toEqual([3, 0]);
    // rows from an older server (no pg) or labels without one: own bytes
    expect(nucPatchRows(layer('f1:abc:0', [3, 0], [3, 0], undefined), 'ds')!.map(p => p.root)).toEqual([3, 0]);
    applyPatchLabels({ e: { identity: 'y', files: ['f1'], labels: { 'f1:abc:0': [[1, 2, 1]] } } });
    expect(nucPatchRows(layer('f1:abc:0', [3, 0], [3, 0], 'NEW'), 'e')!.map(p => p.root)).toEqual([3, 0]);
    // the rows rebuilt with the new patches: the overlay applies
    expect(nucPatchRows(layer('f1:abc:0', [3, 0], [3, 0], 'NEW'), 'ds')!.map(p => p.root)).toEqual([0, 1]);
    // per file tag
    applyPatchLabels({ ds: { identity: 'x', files: ['f1', 'f2'], labels: { 'f2:abc:0': [[0, 4, 4]] }, pg: { f1: 'A', f2: 'B' } } });
    expect(nucPatchRows(layer('f2:abc:0', [0, 0], [0, 0], 'B'), 'ds')!.map(p => p.root)).toEqual([4, 0]);
    expect(nucPatchRows(layer('f2:abc:0', [0, 0], [0, 0], 'A'), 'ds')!.map(p => p.root)).toEqual([0, 0]);
  });

  it('labels a row from its own dataset\'s entry; a removed dataset\'s labels are dropped', async () => {
    applyPatchLabels({ A: { identity: 'a1', files: ['f1'], labels: { 'f1:abc:0': [[0, 7, 7]] }, pg: 'P1' } });
    applyPatchLabels({ B: { identity: 'b1', files: ['f1'], labels: { 'f1:abc:0': [[0, 2, 2]] }, pg: 'P1' } });
    expect(nucPatchRows(layer('f1:abc:0', [0, 0], [0, 0]), 'A')![0].root).toBe(7);
    expect(nucPatchRows(layer('f1:abc:0', [0, 0], [0, 0]), 'B')![0].root).toBe(2);
    // dataset A removed (B opens the same BAM): only B's labels remain, and they are B's
    await syncPatchLabels([{ id: 'B', patch_labels_identity: 'b1' }], vi.fn());
    expect(Object.keys(useNucPatchLabels.getState().byDataset)).toEqual(['B']);
    expect(patchLabelsFor('f1:abc:0', 'P1')?.get(0)).toEqual([2, 2]);
    expect(patchLabelsFor('f1:abc:0', 'P1', 'A')).toBeUndefined();
  });

  it('a return to the identity already held drops the answer of the request for another one', async () => {
    applyPatchLabels({ a: { identity: 'A', files: ['f'], labels: {}, pg: 'P' } });
    let resolveB!: (v: { datasets: Record<string, { identity: string; files: string[]; labels: Record<string, number[][]> }> }) => void;
    const fetcher = vi.fn(() => new Promise<{ datasets: Record<string, { identity: string; files: string[]; labels: Record<string, number[][]> }> }>(r => { resolveB = r; }));
    const toB = syncPatchLabels([{ id: 'a', patch_labels_identity: 'B' }], fetcher);
    await syncPatchLabels([{ id: 'a', patch_labels_identity: 'A' }], fetcher);   // back to A before B's answer
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolveB({ datasets: { a: { identity: 'B', files: ['f'], labels: { 'f:x:0': [[0, 9, 9]] } } } });
    await toB;
    expect(useNucPatchLabels.getState().byDataset.a.identity).toBe('A');
  });

  it('an answer for a dataset removed meanwhile is dropped', async () => {
    let resolve!: (v: { datasets: Record<string, { identity: string; files: string[]; labels: Record<string, number[][]> }> }) => void;
    const pendingSync = syncPatchLabels([{ id: 'a', patch_labels_identity: 'A' }], () => new Promise(r => { resolve = r; }));
    await syncPatchLabels([], vi.fn());
    resolve({ datasets: { a: { identity: 'A', files: ['f'], labels: {} } } });
    await pendingSync;
    expect(useNucPatchLabels.getState().byDataset.a).toBeUndefined();
  });

  it('fetches only datasets whose label identity moved, and never a dataset never labelled', async () => {
    const fetcher = vi.fn(async (ids: string[]) => ({ datasets: Object.fromEntries(ids.map(id => [id,
      { identity: id === 'a' ? 'i1' : 'j1', files: [id], labels: {} }])) }));
    await syncPatchLabels([{ id: 'a', patch_labels_identity: 'i1' }, { id: 'b', patch_labels_identity: '' },
      { id: 'c' }], fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toEqual(['a']);
    const v = useNucPatchLabels.getState().version;
    await syncPatchLabels([{ id: 'a', patch_labels_identity: 'i1' }], fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    // labels dropped ('' after having some): asked again, and the overlay moves
    await syncPatchLabels([{ id: 'a', patch_labels_identity: '' }], async () => ({ datasets: { a: { identity: '', files: ['a'], labels: {} } } }));
    expect(useNucPatchLabels.getState().version).toBeGreaterThan(v);
    expect(useNucPatchLabels.getState().byDataset.a.identity).toBe('');
  });

  it('nucleosome panel requests keep the read responses held (their identity is in the read URLs)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response));
    const g = readRegionGeneration();
    for (const path of ['/api/nuc/regularity', '/api/nuc/geometries', '/api/nuc/patch_labels']) {
      await fetchApiResponse(path, { method: 'POST', body: '{}' });
    }
    expect(readRegionGeneration()).toBe(g);
    await fetchApiResponse('/api/nuc/jobs', { method: 'POST', body: '{}' });       // an Analyse still clears them
    expect(readRegionGeneration()).toBe(g + 1);
  });
});
