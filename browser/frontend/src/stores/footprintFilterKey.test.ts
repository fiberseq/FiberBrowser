import { beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from './browserStore';

const source = { target: 'footprint-cooccurrence', label: 'Footprint Analysis' } as const;

describe('footprint filters survive saved-definition edits correctly', () => {
  beforeEach(() => {
    useBrowserStore.setState({ footprintGroups: [], footprintFilterKey: null, filteredReadIds: {}, readFilterSources: {} } as any);
  });

  it('keeps a state filter when a definition is added', () => {
    const store = useBrowserStore.getState();
    store.setFilteredReadIds('ds', new Set(['r1']), source as any);
    store.setFootprintFilterKey('state:ds:F1');
    store.setFootprintGroups([{ id: 'g', name: 'Class 2', color: '#000', sizeMin: 0, sizeMax: null, overlapFraction: 0, enabled: true, sourceIndex: -1 } as any]);
    const next = useBrowserStore.getState();
    expect(next.footprintFilterKey).toBe('state:ds:F1');
    expect(next.filteredReadIds.ds).toEqual(new Set(['r1']));
  });

  it('leaves co-occupancy cell filters to the panel (a recolor must not clear them)', () => {
    const store = useBrowserStore.getState();
    store.setFilteredReadIds('ds', new Set(['r1']), source as any);
    store.setFootprintFilterKey('ds:0:both');
    store.setFootprintGroups([]);
    expect(useBrowserStore.getState().footprintFilterKey).toBe('ds:0:both');
  });

  it('drops a saved-entry filter when its matching rule changes, but not on recolor', () => {
    const group = { id: 'g', name: 'TF', color: '#000', sizeMin: 10, sizeMax: 30, overlapFraction: 0, enabled: true, sourceIndex: -1 } as any;
    const store = useBrowserStore.getState();
    store.setFootprintGroups([group]);
    store.setFilteredReadIds('ds', new Set(['r1']), source as any);
    store.setFootprintFilterKey('cart:g');
    store.updateFootprintGroup('g', { color: '#fff' });
    expect(useBrowserStore.getState().footprintFilterKey).toBe('cart:g');
    store.updateFootprintGroup('g', { sizeMin: 80 });
    expect(useBrowserStore.getState().footprintFilterKey).toBeNull();
    expect(useBrowserStore.getState().filteredReadIds.ds).toBeNull();
    // ...and asks the Footprints panel to re-apply it with the new reads.
    expect(useBrowserStore.getState().footprintRefilterId).toBe('g');
    // An explicit filter change (e.g. clearing it from the read track) cancels that.
    store.setFootprintFilterKey(null);
    expect(useBrowserStore.getState().footprintRefilterId).toBeNull();
  });

  it('Clear all removes a saved-entry filter and its reads', () => {
    const store = useBrowserStore.getState();
    store.setFootprintGroups([{ id: 'g', name: 'TF', color: '#000', sizeMin: 0, sizeMax: null, overlapFraction: 0, enabled: true, sourceIndex: -1 } as any]);
    store.setFilteredReadIds('ds', new Set(['r1']), source as any);
    store.setFootprintFilterKey('cart:g');
    store.clearFootprintGroups();
    expect(useBrowserStore.getState().footprintFilterKey).toBeNull();
    expect(useBrowserStore.getState().filteredReadIds.ds).toBeNull();
  });

  it('drops a saved-entry filter when that entry is removed', () => {
    const store = useBrowserStore.getState();
    store.setFilteredReadIds('ds', new Set(['r1']), source as any);
    store.setFootprintFilterKey('cart:gone');
    store.setFootprintGroups([]);
    expect(useBrowserStore.getState().footprintFilterKey).toBeNull();
    expect(useBrowserStore.getState().filteredReadIds.ds).toBeNull();
    expect(useBrowserStore.getState().footprintRefilterId).toBeNull();
  });

  it('an automatic name follows the size range until the user renames the entry', () => {
    const store = useBrowserStore.getState();
    store.setFootprintGroups([{ id: 'n', name: '125–184 bp @ fp1', color: '#000', sizeMin: 125, sizeMax: 184, overlapFraction: 0, enabled: true, sourceIndex: 0 } as any]);
    store.updateFootprintGroup('n', { sizeMin: 160 });
    expect(useBrowserStore.getState().footprintGroups[0].name).toBe('160–184 bp @ fp1');
    store.updateFootprintGroup('n', { sizeMax: null });
    expect(useBrowserStore.getState().footprintGroups[0].name).toBe('≥160 bp @ fp1');
    store.updateFootprintGroup('n', { name: 'Nucleosome' });
    store.updateFootprintGroup('n', { sizeMin: 140 });
    expect(useBrowserStore.getState().footprintGroups[0].name).toBe('Nucleosome');
  });

  describe('saved recaller classes (cart:saved:<S-id>)', () => {
    const info = { id: 'S1', family: 'class_001', className: 'Class 1', runLabel: 'run 1', start: 100, end: 120, channels: [], stats: {}, picked: ['ds::CT'] };
    const saved = { id: 'g1', name: 'S1 · Class 1 · ds CT', color: '#000000', sizeMin: 0, sizeMax: null, enabled: true, sourceIndex: -1,
      consensusJobId: 'j', consensusStateId: 'class_001', sourceDatasetId: 'ds', consensusStrand: 'CT', consensusTier: 'core', savedClass: info } as any;
    const other = { ...saved, id: 'g2', name: 'S2 · Class 1 · ds CT', consensusTier: 'core+edge', savedClass: { ...info, id: 'S2' } } as any;
    const applied = () => {
      const store = useBrowserStore.getState();
      store.setFootprintGroups([saved, other]);
      store.setFilteredReadIds('ds', new Set(['r1']), source as any);
      store.setFootprintFilterKey('cart:saved:S1');
      return store;
    };

    it('keeps the filter through a recolor, a rename and edits to another saved class (audit)', () => {
      const store = applied();
      store.setFootprintGroups([{ ...saved, color: '#ff0000' }, other]);
      store.setFootprintGroups([{ ...saved, color: '#ff0000', name: 'renamed' }, { ...other, consensusTier: 'core+edge+loose' }]);
      expect(useBrowserStore.getState().footprintFilterKey).toBe('cart:saved:S1');
      expect(useBrowserStore.getState().filteredReadIds.ds).toEqual(new Set(['r1']));
    });

    it('clears it when what the class counts changes or the class is removed', () => {
      let store = applied();
      store.setFootprintGroups([{ ...saved, consensusTier: 'core+edge' }, other]);
      expect(useBrowserStore.getState().footprintFilterKey).toBeNull();
      expect(useBrowserStore.getState().filteredReadIds.ds).toBeNull();
      store = applied();
      store.setFootprintGroups([{ ...saved, savedClass: { ...info, picked: ['ds::CT', 'ds::GA'] } }, other]);
      expect(useBrowserStore.getState().footprintFilterKey).toBeNull();
      store = applied();
      store.setFootprintGroups([other]);
      expect(useBrowserStore.getState().footprintFilterKey).toBeNull();
    });
  });
});

