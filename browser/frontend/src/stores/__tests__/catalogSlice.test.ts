import { describe, it, expect, beforeEach } from 'vitest';
import { createTestStore } from './helpers';

let store: ReturnType<typeof createTestStore>;

beforeEach(() => {
  localStorage.clear();
  store = createTestStore();
});

describe('catalog backend track indices', () => {
  it('clears one or all transient backend track indices without dropping entries', () => {
    const a = store.getState().addCatalogEntry({
      source: 'local',
      kind: 'bigwig',
      label: 'A',
      path: '/tmp/a.bw',
      loaded: true,
      trackIndex: 2,
    });
    const b = store.getState().addCatalogEntry({
      source: 'local',
      kind: 'motif',
      label: 'Motif',
      path: 'motif://sequence/GAGA',
      loaded: true,
      trackIndex: 4,
    });

    store.getState().clearCatalogTrackIndex(a);

    expect(store.getState().catalog.find(entry => entry.id === a)?.trackIndex).toBeUndefined();
    expect(store.getState().catalog.find(entry => entry.id === b)?.trackIndex).toBe(4);

    store.getState().clearCatalogTrackIndices();

    expect(store.getState().catalog).toHaveLength(2);
    expect(store.getState().catalog.every(entry => entry.trackIndex === undefined)).toBe(true);
  });
});

describe('catalog history', () => {
  it('undoes deleting and relocating catalog sources', () => {
    const id = store.getState().addCatalogEntry({
      source: 'local',
      kind: 'bigwig',
      label: 'Signal',
      path: '/tmp/a.bw',
      loaded: true,
    });

    store.getState().removeCatalogEntry(id);
    expect(store.getState().catalog.map(entry => entry.id)).not.toContain(id);

    store.getState().undo();
    expect(store.getState().catalog.find(entry => entry.id === id)?.path).toBe('/tmp/a.bw');

    store.setState({ _lastRestoreTime: 0 });
    store.getState().relocateCatalogEntry(id, '/tmp/b.bw');
    expect(store.getState().catalog.find(entry => entry.id === id)?.path).toBe('/tmp/b.bw');

    store.getState().undo();
    expect(store.getState().catalog.find(entry => entry.id === id)?.path).toBe('/tmp/a.bw');
  });
});
