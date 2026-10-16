/**
 * integ-r4 Codex review of the merged features: regressions for the
 * cross-feature bugs it verified (store and utility level; the locus box ones
 * are in SmartSearchInput.search.test.tsx).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchJson = vi.fn();
vi.mock('../../api/sharedFetch', async (orig) => ({ ...(await orig<object>()), fetchJson: (...a: unknown[]) => fetchJson(...a) }));

import { useBrowserStore } from '../../stores/browserStore';
import { setRegionCatalogPersistence, useRegionCatalogStore } from '../../stores/regionCatalogStore';
import { addCategory, addEntries, emptyCatalog } from '../regionCatalog';
import { shownEntriesOf, stepRegion } from '../regionNavigation';
import { searchRegionCatalog } from '../search/regionProvider';
import { readNameProvider } from '../search/readProvider';
import { goToReads } from '../readLocate';
import {
  currentReadProjection, indexProjection, projectionForSave, projectionInputSignature, restoreSavedProjection,
} from '../projectionExport';
import type { RegionEntry } from '../../types/regions';

const panel = (id: string, extra: Record<string, unknown> = {}) => ({
  id, contentType: 'dataset', datasetId: id, stateKey: id, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...extra,
});

beforeEach(() => {
  fetchJson.mockReset();
  setRegionCatalogPersistence(() => false);
  useRegionCatalogStore.setState({ catalogs: {}, sync: {}, fingerprints: {}, scans: {}, active: null, recent: [] });
  useBrowserStore.setState({
    currentGenome: 'hg38', fastaPath: null, chrom: 'chr19', start: 1000, end: 2000,
    chroms: [{ name: 'chr19', size: 58_000_000 }], navigationMode: 'linked', selectedDatasets: new Set(),
    datasets: [{ id: 'human', label: 'human' }, { id: 'mouse', label: 'mouse' }],
    panels: [panel('human'), panel('mouse', { genome: 'mm10', viewportOverride: { chrom: 'chr7', start: 10, end: 500 } })],
    highlights: [], highlightDrawMode: false,
  } as never);
});

describe('a hidden amplicon list (closed dataset) under a user category', () => {
  function seed() {
    let c = emptyCatalog('hg38');
    const mine = addCategory(c, { name: 'Mine' }); c = mine.catalog;
    const amp = addCategory(c, { name: 'Amplicons · run1', source: 'auto', fingerprint: 'fp-closed', parent: mine.id }); c = amp.catalog;
    c = addEntries(c, mine.id, [{ chrom: 'chr19', start: 100, end: 200, label: 'kept', category: mine.id, source: 'saved' } as RegionEntry]).catalog;
    c = addEntries(c, amp.id, [{ chrom: 'chr19', start: 5000, end: 6000, label: 'hidden', category: amp.id, source: 'auto' } as RegionEntry]).catalog;
    useRegionCatalogStore.setState({ catalogs: { hg38: c } });
    return { c, mine: mine.id };
  }

  it('is left out of the category list, N / P and category search', () => {
    const { c, mine } = seed();
    expect(shownEntriesOf(c, mine, {}).map(e => e.label)).toEqual(['kept']);
    expect(shownEntriesOf(c, mine, { run1: 'fp-closed' }).map(e => e.label)).toEqual(['kept', 'hidden']);
    stepRegion(1, 'hg38');
    stepRegion(1, 'hg38');
    expect(useBrowserStore.getState().start).toBe(100);  // wrapped round the one shown region
    const category = searchRegionCatalog(c, 'mine').find(s => s.kind === 'category')!;
    expect(category.detail).toMatch(/^1 region/);
  });
});

describe("a panel's box looks for reads on its own reference only", () => {
  it('sends only that reference’s datasets, and moves the panel', async () => {
    fetchJson.mockResolvedValue({ scope: 'region', complete: true, not_found: [], found: [] });
    const name = 'm84046_240619_124816_s1/240062573/ccs';
    const [s] = readNameProvider.search(name, { source: 'panel-locus', signal: new AbortController().signal }) as never[] as Array<{ run: (c: unknown) => Promise<unknown> }>;
    const navigate = vi.fn();
    await s.run({ source: 'panel-locus', signal: new AbortController().signal, navigate, genome: 'mm10', viewport: { chrom: 'chr7', start: 10, end: 500 } });
    const body = JSON.parse(fetchJson.mock.calls[0][1].body);
    expect(body.dataset_ids).toEqual(['mouse']);
    // The main box (no navigation of its own) still looks everywhere.
    fetchJson.mockClear();
    await s.run({ source: 'locus', signal: new AbortController().signal });
    expect(JSON.parse(fetchJson.mock.calls[0][1].body).dataset_ids).toEqual(['human', 'mouse']);
  });

  it('says so when no dataset is on that reference', async () => {
    const res = await goToReads(['a/1/ccs'], { datasetIds: [] });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/No open dataset on this panel/);
    expect(fetchJson).not.toHaveBeenCalled();
  });
});

describe('Reset view and the Highlight group', () => {
  it('turns ruler highlighting off (a plain drag zooms again); highlights, being annotations, stay', () => {
    const s = useBrowserStore.getState();
    s.addHighlights([{ chrom: 'chr19', start: 1, end: 2, genome: 'hg38' }]);
    s.setHighlightDrawMode(true);
    useBrowserStore.setState({ clusterMethod: 'graph', clusterResolution: 2.5 } as never);
    useBrowserStore.getState().resetView();
    const after = useBrowserStore.getState();
    expect(after.highlightDrawMode).toBe(false);
    expect(after.highlights).toHaveLength(1);
    expect(after.clusterResolution).toBe(1);
  });
});

describe('the Projection map across a save', () => {
  const data = {
    method: 'tsne', n_reads: 2, read_ids: ['r1', 'r2'], dataset_ids: ['old', 'old'], coords_x: [1, 2], coords_y: [3, 4],
  } as never;
  const inputs = (refreshGeneration: number) => ({
    chrom: 'chr19', start: 1000, end: 2000, analysisSampleSeed: 's', subnucleosomalThreshold: 90, spanningOnly: true,
    clusterAssignments: { old: { r1: 0, r2: 1 } }, refreshGeneration,
  });

  it('is saved only while current, and comes back current after a restore bumps the refresh counter', () => {
    const before = inputs(3);
    const map = indexProjection(data, { chrom: 'chr19', start: 1000, end: 2000 }, projectionInputSignature(before));
    expect(projectionForSave({ ...before, readProjection: map })).toBe(map);
    expect(projectionForSave({ ...before, start: 1500, readProjection: map })).toBeNull();
    // Reopened: datasets get new ids and the page's refresh counter moves on.
    const after = { ...inputs(9), clusterAssignments: { new: { r1: 0, r2: 1 } } };
    expect(currentReadProjection(map, after)).toBeNull();
    const restored = restoreSavedProjection(JSON.parse(JSON.stringify(map)), { old: 'new' }, after)!;
    expect(currentReadProjection(restored, after)).toBe(restored);
    expect(restored.coords).toEqual({ new: { r1: [1, 3], r2: [2, 4] } });
    // Another region: not this map.
    expect(restoreSavedProjection(map, {}, { ...after, start: 5 })).toBeNull();
    expect(restoreSavedProjection('junk', {}, after)).toBeNull();
  });
});
