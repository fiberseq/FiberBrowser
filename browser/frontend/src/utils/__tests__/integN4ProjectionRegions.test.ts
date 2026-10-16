/**
 * fb-n4-integ (Codex integ 5 and 7).
 *
 * 5. A Projection map drawn for a panel at its own locus (or on another
 *    assembly) is checked against that panel's view, not the stale main
 *    locus, so the cluster-assignment export and the autosave keep it.
 * 7. Regions act on the panel the user is working in (panelScope's active
 *    panel, as search and the cluster charts), and never target a panel that
 *    isn't on screen (a collapsed row).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { setRegionCatalogPersistence, useRegionCatalogStore } from '../../stores/regionCatalogStore';
import { activePanelView } from '../panelScope';
import { currentReadProjection, indexProjection, projectionForSave, projectionInputSignature, restoreSavedProjection } from '../projectionExport';
import { regionTarget, targetGenome, viewOnGenome } from '../regionNavigation';

const panel = (id: string, extra: Record<string, unknown> = {}) => ({
  id, contentType: 'dataset', datasetId: id, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...extra,
});

describe('5. a panel\'s Projection map is checked against that panel\'s view', () => {
  const data = {
    method: 'tsne', n_reads: 2, read_ids: ['r1', 'r2'], dataset_ids: ['napa', 'napa'], coords_x: [1, 2], coords_y: [3, 4],
  } as never;
  const OWN = { chrom: 'chr19', start: 47_514_262, end: 47_519_210 };
  const state = (own = OWN, genome?: string) => ({
    // The main locus is stale (Per panel).
    chrom: 'chr19', start: 47_514_037, end: 47_518_985, currentGenome: 'hg38', fastaPath: null,
    analysisSampleSeed: 's', subnucleosomalThreshold: 90, spanningOnly: false, refreshGeneration: 3,
    clusterAssignments: { napa: { r1: 0, r2: 1 } },
    panels: [panel('napa', { viewportOverride: { ...own }, ...(genome ? { genome } : {}) })],
  });
  const drawn = (genome: string | null = null) => {
    const s = state(OWN, genome ?? undefined);
    const signature = projectionInputSignature({ ...s, ...OWN, genome });
    return indexProjection(data, { ...OWN, panelId: 'napa', genome }, signature);
  };

  it('is current while the panel shows the view it was drawn for (the export and autosave keep it)', () => {
    const map = drawn();
    expect(currentReadProjection(map, state())).toBe(map);
    expect(projectionForSave({ ...state(), readProjection: map })).toBe(map);
  });

  it('is dropped once that panel moves, or is on another reference', () => {
    const map = drawn();
    expect(currentReadProjection(map, state({ chrom: 'chr19', start: 1, end: 900 }))).toBeNull();
    expect(currentReadProjection(map, state(OWN, 'hs1'))).toBeNull();
    expect(currentReadProjection(map, { ...state(), panels: [] })).toBeNull();
  });

  it('a map on another assembly: its reference is part of its signature', () => {
    const map = drawn('dm6');
    expect(currentReadProjection(map, state(OWN, 'dm6'))).toBe(map);
    expect(map.signature).not.toBe(drawn(null).signature);
  });

  it('comes back with a reopened session (signed again for the panel\'s view)', () => {
    const map = drawn();
    const restored = restoreSavedProjection(JSON.parse(JSON.stringify(map)), {}, { ...state(), refreshGeneration: 9 });
    expect(restored).not.toBeNull();
    expect(currentReadProjection(restored, { ...state(), refreshGeneration: 9 })).toBe(restored);
  });

  it('a main-view map is checked against the main view, as before', () => {
    const main = { chrom: 'chr19', start: 47_514_037, end: 47_518_985 };
    const s = { ...state(), panels: [panel('napa')] };
    const map = indexProjection(data, main, projectionInputSignature(s));
    expect(currentReadProjection(map, s)).toBe(map);
    expect(currentReadProjection(map, { ...s, start: 1 })).toBeNull();
  });
});

describe('7. Regions act on the active panel', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, catalog: { categories: [], entries: [] } }) }) as Response));
    setRegionCatalogPersistence(() => false);
    useRegionCatalogStore.setState({ catalogs: {}, sync: {}, fingerprints: {}, scans: {}, active: null, recent: [] });
    useBrowserStore.setState({
      currentGenome: 'hg38', fastaPath: null, chrom: 'chr19', start: 1000, end: 2000,
      chroms: [{ name: 'chr19', size: 58_000_000 }], navigationMode: 'perPanel', selectedDatasets: new Set(),
      lastMovedPanels: {}, collapsedRows: new Set(), fullViewPanelId: null,
      panels: [
        panel('human', { viewportOverride: { chrom: 'chr19', start: 1000, end: 2000 }, navOwn: true }),
        panel('fly', { genome: 'dm6', viewportOverride: { chrom: 'chr2L', start: 10, end: 500 } }),
      ],
      highlights: [], bookmarks: [], navigatorRegions: [],
    } as never);
  });

  it('hg38 panel first, dm6 moved last, nothing selected: Regions use dm6, as search does', () => {
    useBrowserStore.getState().navigatePanel('fly', 'chr2L', 5_000, 6_000);
    expect(activePanelView(useBrowserStore.getState()).genomeKey).toBe('dm6');
    expect(targetGenome()).toBe('dm6');
    expect(regionTarget('dm6')).toEqual({ kind: 'panel', panelId: 'fly' });
    expect(viewOnGenome('dm6')).toEqual({ chrom: 'chr2L', start: 5_000, end: 6_000, panelGenome: 'dm6' });
  });

  it('of two hg38 panels, the one moved last (not the first) is the target', () => {
    useBrowserStore.setState({
      panels: [
        panel('h1', { viewportOverride: { chrom: 'chr19', start: 1000, end: 2000 }, navOwn: true }),
        panel('h2', { viewportOverride: { chrom: 'chr19', start: 1000, end: 2000 }, navOwn: true }),
      ],
    } as never);
    useBrowserStore.getState().navigatePanel('h2', 'chr19', 50_000, 60_000);
    expect(regionTarget('hg38')).toEqual({ kind: 'panel', panelId: 'h2' });
    expect(viewOnGenome('hg38')).toEqual({ chrom: 'chr19', start: 50_000, end: 60_000, panelGenome: null });
  });

  it('a panel in a collapsed row is never a target', () => {
    useBrowserStore.setState({
      panels: [
        panel('human', { viewportOverride: { chrom: 'chr19', start: 1000, end: 2000 }, navOwn: true }),
        panel('fly', { genome: 'dm6', layoutRow: 1, viewportOverride: { chrom: 'chr2L', start: 10, end: 500 } }),
      ],
      collapsedRows: new Set([1]),
      selectedDatasets: new Set(['fly']),
    } as never);
    expect(regionTarget('dm6')).toBeNull();
    expect(viewOnGenome('dm6')).toBeNull();
    expect(targetGenome()).toBe('hg38');
  });
});
