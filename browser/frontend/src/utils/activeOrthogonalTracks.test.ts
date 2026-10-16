import { describe, expect, it } from 'vitest';
import { getActiveCatalogEntryIds, getActiveOrthogonalTrackIndices } from './activeOrthogonalTracks';
import type { TrackListEntry } from '../api/tracks';

const tracks: TrackListEntry[] = [
  { index: 0, label: 'Signal A', path: '/tracks/a.bw', render_mode: 'signal' },
  { index: 1, label: 'Signal B', path: '/tracks/b.bw', render_mode: 'signal' },
  { index: 2, label: 'Motifs', path: '/tracks/motifs.bb', render_mode: 'annotation', category: 'motif', format: 'bigBed' },
];

function state(overrides: Partial<Parameters<typeof getActiveOrthogonalTrackIndices>[0]> = {}) {
  return {
    panels: [],
    catalog: [],
    compositeTracks: [],
    activeColormap: { name: 'test', rules: [] },
    footprintGroups: [],
    ...overrides,
  } as Parameters<typeof getActiveOrthogonalTrackIndices>[0];
}

describe('getActiveOrthogonalTrackIndices', () => {
  it('does not hydrate catalog entries just because they exist', () => {
    const active = getActiveOrthogonalTrackIndices(state({
      catalog: [{ id: 'a', source: 'local', kind: 'bigwig', label: 'Signal A', path: '/tracks/a.bw', loaded: true, trackIndex: 0 }],
    }), tracks);

    expect([...active]).toEqual([]);
  });

  it('hydrates visible composite sources', () => {
    const browserState = state({
      catalog: [{ id: 'a', source: 'local', kind: 'bigwig', label: 'Signal A', path: '/tracks/a.bw', loaded: true, trackIndex: 0 }],
      compositeTracks: [{
        id: 'c1',
        label: 'Signal A',
        kind: 'signal',
        sources: [{ id: 's1', ref: { kind: 'bigwig', catalogEntryId: 'a' }, color: '#2563eb', visible: true, negate: false, scale: 1 }],
        scaleMode: 'auto',
        logScale: false,
        visible: true,
        groupAutoscaleSelected: false,
        showAxes: true,
      }],
      panels: [{
        id: 'p1',
        contentType: 'dataset',
        datasetId: 'd1',
        subTracks: [{ type: 'composite-c1', visible: true }],
        collapsed: false,
        linkGroup: null,
        layoutRow: 0,
      }],
    });
    const active = getActiveOrthogonalTrackIndices(browserState, tracks);

    expect([...active]).toEqual([0]);
    expect([...getActiveCatalogEntryIds(browserState)]).toEqual(['a']);
  });

  it('does not hydrate hidden composite sources', () => {
    const browserState = state({
      catalog: [{ id: 'motif', source: 'local', kind: 'motif', label: 'Motifs', path: '/tracks/motifs.bb', loaded: true, trackIndex: 2 }],
      compositeTracks: [{
        id: 'c1',
        label: 'Motifs',
        kind: 'annotation',
        sources: [{ id: 's1', ref: { kind: 'bigbed', catalogEntryId: 'motif' }, color: '#2563eb', visible: true, negate: false, scale: 1 }],
        scaleMode: 'auto',
        logScale: false,
        visible: true,
        groupAutoscaleSelected: false,
        showAxes: true,
      }],
      panels: [{
        id: 'p1',
        contentType: 'dataset',
        datasetId: 'd1',
        subTracks: [{ type: 'composite-c1', visible: false }],
        collapsed: false,
        linkGroup: null,
        layoutRow: 0,
      }],
    });

    expect([...getActiveOrthogonalTrackIndices(browserState, tracks)]).toEqual([]);
    expect([...getActiveCatalogEntryIds(browserState)]).toEqual([]);
  });

  it('hydrates motif tracks only when enabled rules need motif context', () => {
    const active = getActiveOrthogonalTrackIndices(state({
      activeColormap: {
        name: 'test',
        rules: [{
          id: 'motif-rule',
          name: 'Motif rule',
          color: '#000000',
          sizeMin: 0,
          sizeMax: null,
          targetLayers: [],
          conditions: [{ target: 'motif' }],
          enabled: true,
        }],
      },
    }), tracks);

    expect([...active]).toEqual([2]);
  });

  it('leaves a motif the user unloaded off, even with a motif rule enabled', () => {
    const motifRule = {
      name: 'test',
      rules: [{
        id: 'motif-rule', name: 'Motif rule', color: '#000000', sizeMin: 0, sizeMax: null,
        targetLayers: [], conditions: [{ target: 'motif' }], enabled: true,
      }],
    };
    const ids = (loaded: boolean) => [...getActiveCatalogEntryIds(state({
      activeColormap: motifRule as never,
      catalog: [{ id: 'm', source: 'local', kind: 'motif', label: 'Motifs', path: '/tracks/motifs.bb', loaded }],
    }))];
    expect(ids(true)).toEqual(['m']);
    expect(ids(false)).toEqual([]);
  });

  it('ignores stale restored track indices that are not in the backend track list', () => {
    const active = getActiveOrthogonalTrackIndices(state({
      catalog: [{ id: 'a', source: 'local', kind: 'bigwig', label: 'Signal A', path: '/tracks/a.bw', loaded: true, trackIndex: 99 }],
      compositeTracks: [{
        id: 'c1',
        label: 'Signal A',
        kind: 'signal',
        sources: [{ id: 's1', ref: { kind: 'bigwig', catalogEntryId: 'a' }, color: '#2563eb', visible: true, negate: false, scale: 1 }],
        scaleMode: 'auto',
        logScale: false,
        visible: true,
        groupAutoscaleSelected: false,
        showAxes: true,
      }],
      panels: [{
        id: 'p1',
        contentType: 'dataset',
        datasetId: 'd1',
        subTracks: [{ type: 'composite-c1', visible: true }],
        collapsed: false,
        linkGroup: null,
        layoutRow: 0,
      }],
    }), tracks.filter(track => track.index !== 0));

    expect([...active]).toEqual([]);
  });

  it('falls back to the first matching path when catalog trackIndex is missing', () => {
    const duplicateTracks: TrackListEntry[] = [
      { index: 10, label: 'First', path: '/tracks/dup.bw', render_mode: 'signal' },
      { index: 11, label: 'Second', path: '/tracks/dup.bw', render_mode: 'signal' },
    ];
    const active = getActiveOrthogonalTrackIndices(state({
      catalog: [{ id: 'dup', source: 'local', kind: 'bigwig', label: 'Duplicate', path: '/tracks/dup.bw', loaded: true }],
      compositeTracks: [{
        id: 'c1',
        label: 'Duplicate',
        kind: 'signal',
        sources: [{ id: 's1', ref: { kind: 'bigwig', catalogEntryId: 'dup' }, color: '#2563eb', visible: true, negate: false, scale: 1 }],
        scaleMode: 'auto',
        logScale: false,
        visible: true,
        groupAutoscaleSelected: false,
        showAxes: true,
      }],
      panels: [{
        id: 'p1',
        contentType: 'dataset',
        datasetId: 'd1',
        subTracks: [{ type: 'composite-c1', visible: true }],
        collapsed: false,
        linkGroup: null,
        layoutRow: 0,
      }],
    }), duplicateTracks);

    expect([...active]).toEqual([10]);
  });

  it('resolves large carts without repeated track-list scans', () => {
    const bigTrackList: TrackListEntry[] = Array.from({ length: 2000 }, (_, index) => ({
      index,
      label: `Track ${index}`,
      path: `/tracks/${index}.bw`,
      render_mode: 'signal',
    }));
    const catalog = bigTrackList.map(track => ({
      id: `entry-${track.index}`,
      source: 'local' as const,
      kind: 'bigwig' as const,
      label: track.label,
      path: track.path,
      loaded: true,
    }));
    const sources = catalog.slice(500, 620).map(entry => ({
      id: `source-${entry.id}`,
      ref: { kind: 'bigwig' as const, catalogEntryId: entry.id },
      color: '#2563eb',
      visible: true,
      negate: false,
      scale: 1,
    }));
    const browserState = state({
      catalog,
      compositeTracks: [{
        id: 'big-composite',
        label: 'Big composite',
        kind: 'signal',
        sources,
        scaleMode: 'auto',
        logScale: false,
        visible: true,
        groupAutoscaleSelected: false,
        showAxes: true,
      }],
      panels: [{
        id: 'p1',
        contentType: 'dataset',
        datasetId: 'd1',
        subTracks: [{ type: 'composite-big-composite', visible: true }],
        collapsed: false,
        linkGroup: null,
        layoutRow: 0,
      }],
    });

    const started = performance.now();
    const active = getActiveOrthogonalTrackIndices(browserState, bigTrackList);
    const elapsedMs = performance.now() - started;

    expect(active.size).toBe(120);
    expect(active.has(500)).toBe(true);
    expect(active.has(619)).toBe(true);
    expect(elapsedMs).toBeLessThan(100);
  });
});
