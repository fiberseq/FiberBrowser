import { beforeEach, describe, expect, it } from 'vitest';
import { createTestStore } from '../stores/__tests__/helpers';
import { useBrowserStore } from '../stores/browserStore';
import { applyImportedState, collectFrontendState } from '../api/session';
import { DEFAULT_METAPROFILE_ID } from '../types/dataset';
import type { CompositeTrack } from '../types/dataset';
import { resolveProfileChannels } from './clusterViewChannels';
import { defaultMetaprofileToggles, layerToggleOn } from './defaultMetaprofile';

const DATASET = {
  id: 'ds1', label: 'DAF', path: '/tmp/daf.bam', color: '#111111', data_type: 'bam',
  available_layers: { nuc: true, tf: true, msp: true, m6a: true },
} as any;

type Store = ReturnType<typeof createTestStore>;

function defaultTrack(store: { getState: () => { compositeTracks: CompositeTrack[] } }): CompositeTrack {
  const track = store.getState().compositeTracks.find(c => c.id === DEFAULT_METAPROFILE_ID);
  if (!track) throw new Error('no default metaprofile');
  return track;
}

function visibleIds(store: Parameters<typeof defaultTrack>[0]): string[] {
  return defaultTrack(store).sources
    .filter(s => s.visible && s.ref.kind === 'metaprofile')
    .map(s => (s.ref.kind === 'metaprofile' ? s.ref.ruleId : ''))
    .sort();
}

function sourceId(store: Parameters<typeof defaultTrack>[0], ruleId: string): string {
  const source = defaultTrack(store).sources.find(s => s.ref.kind === 'metaprofile' && s.ref.ruleId === ruleId);
  if (!source) throw new Error(`no ${ruleId} source`);
  return source.id;
}

function clusterDefaultChannels(state: ReturnType<Store['getState']>): string[] {
  return resolveProfileChannels(null, defaultMetaprofileToggles(state)).sort();
}

let store: Store;

beforeEach(() => {
  localStorage.clear();
  store = createTestStore();
  store.setState({ datasets: [DATASET] });
  store.getState().initModTypeDefaults();
  store.getState().seedDefaultMetaprofile();
});

describe('layerToggleOn', () => {
  it('reads the Tracks checkbox with the shared aliases', () => {
    expect(layerToggleOn('fire', { msp: true })).toBe(true);
    expect(layerToggleOn('m6a', { mod: true })).toBe(true);
    expect(layerToggleOn('nuc', { footprint: true })).toBe(true);
    expect(layerToggleOn('nuc', { nuc: false, footprint: true })).toBe(false);
    expect(layerToggleOn('footprint', { nuc: true })).toBe(true);
    expect(layerToggleOn('pol2', { pol2: true })).toBe(true);
  });
});

describe('default metaprofile follows the active layers', () => {
  it('seeds following, showing the layers that are on', () => {
    expect(defaultTrack(store).followActiveLayers).toBe(true);
    expect(visibleIds(store)).toEqual(['nuc', 'tf']);
    expect(clusterDefaultChannels(store.getState())).toEqual(['nuc', 'tf']);
  });

  it('toggling a layer updates the track and the cluster panel Default channels', () => {
    store.getState().toggleModType('m6a' as any, true);
    expect(visibleIds(store)).toEqual(['m6a', 'nuc', 'tf']);
    expect(clusterDefaultChannels(store.getState())).toEqual(['m6a', 'nuc', 'tf']);

    store.getState().toggleModType('fire' as any, true);
    store.getState().toggleModType('tf' as any, false);
    expect(visibleIds(store)).toEqual(['fire', 'm6a', 'nuc']);
    expect(clusterDefaultChannels(store.getState())).toEqual(['fire', 'm6a', 'nuc']);
  });

  it('a manual edit switches to manual and survives a layer toggle', () => {
    store.getState().updateSource(DEFAULT_METAPROFILE_ID, sourceId(store, 'tf'), { visible: false });
    expect(defaultTrack(store).followActiveLayers).toBe(false);
    expect(visibleIds(store)).toEqual(['nuc']);

    store.getState().toggleModType('fire' as any, true);
    store.getState().toggleModType('tf' as any, true);
    expect(visibleIds(store)).toEqual(['nuc']);
    expect(clusterDefaultChannels(store.getState())).toEqual(['nuc']);
  });

  it('a colour edit keeps following', () => {
    store.getState().updateSource(DEFAULT_METAPROFILE_ID, sourceId(store, 'tf'), { color: '#123456' });
    expect(defaultTrack(store).followActiveLayers).toBe(true);
  });

  it('switching Follow active layers back on restores following', () => {
    store.getState().updateSource(DEFAULT_METAPROFILE_ID, sourceId(store, 'nuc'), { visible: false });
    store.getState().toggleModType('fire' as any, true);
    expect(visibleIds(store)).toEqual(['tf']);

    store.getState().updateComposite(DEFAULT_METAPROFILE_ID, { followActiveLayers: true });
    expect(visibleIds(store)).toEqual(['fire', 'nuc', 'tf']);
  });

  it('leaves rule-id sources alone, and the Default channel carries them', () => {
    store.getState().addSourceTo(DEFAULT_METAPROFILE_ID, { ref: { kind: 'metaprofile', ruleId: 'rule-abc' }, visible: true } as any);
    expect(defaultTrack(store).followActiveLayers).toBe(true);
    store.getState().toggleModType('tf' as any, false);
    expect(visibleIds(store)).toEqual(['nuc', 'rule-abc']);
    expect(clusterDefaultChannels(store.getState())).toEqual(['nuc', 'rule-abc']);
  });

  it('new datasets get it too', () => {
    store.getState().toggleModType('deam' as any, true);
    store.setState({ datasets: [DATASET, { ...DATASET, id: 'ds2', available_layers: { nuc: true, deam: true } }] });
    store.getState().seedDefaultMetaprofile();
    expect(visibleIds(store)).toEqual(['deam', 'nuc', 'tf']);
  });

  it('undo restores the layers and the track together', () => {
    store.getState().pushSnapshot('base', { kind: 'layout' });
    store.getState().toggleModType('fire' as any, true);
    store.getState().pushSnapshot('fire on', { kind: 'layout' });
    expect(visibleIds(store)).toContain('fire');
    store.getState().undo();
    expect(visibleIds(store)).toEqual(['nuc', 'tf']);
  });

  it('the cluster Default falls back to the active layers before seeding', () => {
    const fresh = createTestStore();
    fresh.setState({ datasets: [DATASET] });
    fresh.getState().initModTypeDefaults();
    fresh.getState().toggleModType('fire' as any, true);
    expect(clusterDefaultChannels(fresh.getState())).toEqual(['fire', 'nuc', 'tf']);
  });
});

describe('sessions', () => {
  const importFrontend = (frontend: Record<string, unknown>) => applyImportedState({
    datasets: [DATASET], overlays: [], has_fasta: false, frontend, viewport: { chrom: 'chr1', start: 1, end: 2 },
  });

  beforeEach(() => {
    useBrowserStore.setState({ datasets: [DATASET], compositeTracks: [] });
    useBrowserStore.getState().initModTypeDefaults();
    useBrowserStore.getState().seedDefaultMetaprofile();
  });

  it('round-trips follow and manual state, without enabledMetaProfiles', () => {
    const st = useBrowserStore.getState();
    st.toggleModType('fire' as any, true);
    const followed = collectFrontendState();
    expect('enabledMetaProfiles' in followed).toBe(false);

    st.updateSource(DEFAULT_METAPROFILE_ID, sourceId(useBrowserStore, 'nuc'), { visible: false });
    const manual = collectFrontendState();

    importFrontend(followed);
    expect(defaultTrack(useBrowserStore).followActiveLayers).toBe(true);
    expect(visibleIds(useBrowserStore)).toEqual(['fire', 'nuc', 'tf']);

    importFrontend(manual);
    expect(defaultTrack(useBrowserStore).followActiveLayers).toBe(false);
    expect(visibleIds(useBrowserStore)).toEqual(['fire', 'tf']);
    useBrowserStore.getState().toggleModType('m6a' as any, true);
    expect(visibleIds(useBrowserStore)).toEqual(['fire', 'tf']);
  });

  it('an old session with enabledMetaProfiles and no follow field loads following', () => {
    const saved = collectFrontendState() as any;
    const old = {
      ...saved,
      enabledModTypes: { ...saved.enabledModTypes, m6a: true, tf: false },
      enabledMetaProfiles: { nuc: true, tf: true, fire: true },
      compositeTracks: saved.compositeTracks.map((c: CompositeTrack) => {
        const { followActiveLayers: _f, ...rest } = c;
        return { ...rest, sources: rest.sources.map(s => ({ ...s, visible: true })) };
      }),
    };
    expect(() => importFrontend(old)).not.toThrow();
    const state = useBrowserStore.getState() as any;
    expect(state.enabledMetaProfiles).toBeUndefined();
    expect(defaultTrack(useBrowserStore).followActiveLayers).toBeUndefined();
    expect(visibleIds(useBrowserStore)).toEqual(['m6a', 'nuc']);
    expect(clusterDefaultChannels(useBrowserStore.getState())).toEqual(['m6a', 'nuc']);
  });
});

describe('audit follow-ups (3.0.7)', () => {
  it('a footprint source kept from a footprint-only dataset keeps following after a nuc dataset loads', () => {
    const s = createTestStore();
    const fp = { id: 'fp', label: 'FP', path: '/tmp/fp.bam', color: '#111111', data_type: 'bam', available_layers: { footprint: true, msp: true } } as any;
    s.setState({ datasets: [fp] });
    s.getState().initModTypeDefaults();
    s.getState().seedDefaultMetaprofile();
    s.setState({ datasets: [fp, DATASET] });
    s.getState().initModTypeDefaults();
    s.getState().seedDefaultMetaprofile();
    s.getState().toggleModType('footprint' as any, false);
    s.getState().toggleModType('nuc' as any, false);
    expect(visibleIds(s)).not.toContain('footprint');
    expect(defaultMetaprofileToggles(s.getState()).nuc).toBeUndefined();
  });

  it('switching Follow active layers back on restores a layer source removed by hand', () => {
    store.getState().toggleModType('m6a' as any, true);
    store.getState().removeSourceFrom(DEFAULT_METAPROFILE_ID, sourceId(store, 'm6a'));
    expect(defaultTrack(store).followActiveLayers).toBe(false);
    store.getState().updateComposite(DEFAULT_METAPROFILE_ID, { followActiveLayers: true });
    expect(visibleIds(store)).toEqual(['m6a', 'nuc', 'tf']);
  });
});

describe('re-check follow-ups (3.0.7)', () => {
  it('switching following back on keeps an extra same-layer source and its settings', () => {
    store.getState().addSourceTo(DEFAULT_METAPROFILE_ID, { ref: { kind: 'metaprofile', ruleId: 'tf' }, color: '#000000', visible: true, negate: false, scale: 0.5 });
    expect(defaultTrack(store).followActiveLayers).toBe(false);
    const before = defaultTrack(store).sources.length;
    store.getState().updateComposite(DEFAULT_METAPROFILE_ID, { followActiveLayers: true });
    expect(defaultTrack(store).sources.length).toBe(before);
    expect(defaultTrack(store).sources.some(s => s.scale === 0.5)).toBe(true);
  });
});
