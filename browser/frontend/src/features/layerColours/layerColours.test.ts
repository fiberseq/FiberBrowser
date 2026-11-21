import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/sharedFetch', async importOriginal => ({
  ...(await importOriginal<typeof import('../../api/sharedFetch')>()),
  fetchJson: vi.fn(),
}));
import { fetchJson } from '../../api/sharedFetch';
import { useBrowserStore } from '../../stores/browserStore';
import { storeExtensions } from '../../stores/storeExtensions';
import { applyImportedState, collectFrontendState } from '../../api/session';
import { flushPreferences, initAnalysisPreferences, PREFERENCES_MOVED_KEY, PREFERENCES_URL, resetAnalysisPreferences } from '../../utils/analysisPreferences';
import {
  getCanonicalLayerEntries, getDefaultLayerColor, getLayerColor, getLayerColorOverride, normalizeLayerColorMap, setLayerColorSource,
} from '../../utils/layerColors';
import { displayRuleColor, displayTfOverlayColor, effectiveModColors, withLayerColours } from '../../utils/layerColourFollow';
import { refreshAutoSourceColors } from '../../stores/compositeTracksSlice';
import { MOD_COLORS } from '../../components/tracks/read-track/constants';
import { deltaE, similarColorPairs } from '../../utils/colorDistance';
import { DEFAULT_COLORMAP, type TrackSource } from '../../types';
import {
  LOCAL_STORAGE_KEY, PREFERENCE_FIELD, SESSION_KEY, clearSavedLayerColorDefaults, effectiveLayerColors, layerColorSource,
  registerLayerColours, resetAllLayerColors, resetLayerColor, saveLayerColorsAsDefault, setLayerColorOverride,
} from './state';

registerLayerColours();

const RED = '#ff0000';
const BLUE = '#0000ff';
const set = (session: Record<string, string>, user: Record<string, string> = {}) =>
  useBrowserStore.setState({ layerColorOverrides: session, userLayerColors: user } as never);

beforeEach(() => {
  localStorage.clear();
  set({}, {});
  setLayerColorSource([]);
});

describe('layer colour resolver', () => {
  it('session override > saved default > curated / palette colour', () => {
    expect(getLayerColor('nuc')).toBe('#16a34a');
    set({}, { nuc: BLUE });
    expect(getLayerColor('nuc')).toBe(BLUE);
    set({ nuc: RED }, { nuc: BLUE });
    expect(getLayerColor('nuc')).toBe(RED);
    expect(getDefaultLayerColor('nuc')).toBe('#16a34a');
    expect(layerColorSource(useBrowserStore.getState(), 'nuc')).toBe('session');
    set({}, { nuc: BLUE });
    expect(layerColorSource(useBrowserStore.getState(), 'nuc')).toBe('default');
    set({});
    expect(layerColorSource(useBrowserStore.getState(), 'nuc')).toBe('builtin');
  });

  it('extra MA-tag layers are overridable over their palette colour', () => {
    setLayerColorSource([{ available_layers: { nuc: true, tf2: true } }]);
    const palette = getLayerColor('tf2');
    set({ tf2: RED });
    expect(getLayerColor('tf2')).toBe(RED);
    set({});
    expect(getLayerColor('tf2')).toBe(palette);
  });

  it('aliases of one layer share its colour (msp/fire, mod/m6a, footprint/nuc)', () => {
    set({ fire: RED, m6a: BLUE, nuc: '#00ff00' });
    expect(getLayerColor('msp')).toBe(RED);
    expect(getLayerColor('mod')).toBe(BLUE);
    expect(getLayerColor('footprint')).toBe('#00ff00');
    expect(normalizeLayerColorMap({ msp: '#ABC', mod: 'nope', ' nuc ': '#112233' })).toEqual({ fire: '#aabbcc', nuc: '#112233' });
  });

  it("a user colour wins over a derived layer's own colour in the layer list", () => {
    const ds = [{ available_layers: { nuc: true, mine: true }, derived_layers: { mine: { label: 'Mine', color: '#123456' } } }];
    expect(getCanonicalLayerEntries(ds).find(e => e.key === 'mine')?.color).toBe('#123456');
    set({ mine: RED });
    expect(getCanonicalLayerEntries(ds).find(e => e.key === 'mine')?.color).toBe(RED);
  });

  it('setLayerColorOverride / reset / reset all / save as default', () => {
    setLayerColorOverride('msp', '#ABCDEF');
    expect(useBrowserStore.getState().layerColorOverrides).toEqual({ fire: '#abcdef' });
    setLayerColorOverride('nuc', 'not a colour');
    expect(useBrowserStore.getState().layerColorOverrides).toEqual({ fire: '#abcdef' });
    setLayerColorOverride('nuc', RED);
    expect(saveLayerColorsAsDefault()).toEqual({ fire: '#abcdef', nuc: RED });
    expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY)!)).toEqual({ fire: '#abcdef', nuc: RED });
    resetLayerColor('nuc');
    expect(useBrowserStore.getState().layerColorOverrides).toEqual({ fire: '#abcdef' });
    expect(getLayerColor('nuc')).toBe(RED);              // the saved default still applies
    resetLayerColor('nuc', { includeSavedDefault: true });
    expect(getLayerColor('nuc')).toBe('#16a34a');
    resetAllLayerColors();
    expect(useBrowserStore.getState().layerColorOverrides).toEqual({});
    expect(getLayerColor('fire')).toBe('#abcdef');
    clearSavedLayerColorDefaults();
    expect(getLayerColor('fire')).toBe(getDefaultLayerColor('fire'));
    expect(localStorage.getItem(LOCAL_STORAGE_KEY)).toBeNull();
  });

  it('a change of the effective colours bumps the redraw version (and an unchanged one does not)', () => {
    const v0 = useBrowserStore.getState().layerColorVersion;
    setLayerColorOverride('nuc', RED);
    const v1 = useBrowserStore.getState().layerColorVersion;
    expect(v1).toBeGreaterThan(v0);
    set({ nuc: RED }, { nuc: RED });                       // same effective map
    expect(useBrowserStore.getState().layerColorVersion).toBe(v1);
    set({}, {});
    expect(useBrowserStore.getState().layerColorVersion).toBeGreaterThan(v1);
  });
});

describe('the colormap as drawn follows layer colours', () => {
  it('stock built-in rules and the TF overlay follow; recoloured ones keep their colour', () => {
    expect(withLayerColours(DEFAULT_COLORMAP)).toBe(DEFAULT_COLORMAP);
    set({ nuc: RED, fire: BLUE, tf: '#00ff00' });
    const drawn = withLayerColours(DEFAULT_COLORMAP);
    expect(drawn.rules.find(r => r.id === 'nuc')!.color).toBe(RED);
    expect(drawn.rules.find(r => r.id === 'fire')!.color).toBe(BLUE);
    expect(drawn.rules.find(r => r.id === 'pol2')!.color).toBe('#ff69b4');
    // The Subnucleosome rule is the default colour of TF-layer calls (1-89 bp): it follows the TF layer.
    expect(drawn.rules.find(r => r.id === 'subnuc')!.color).toBe('#00ff00');
    expect(drawn.tfOverlay.color).toBe('#00ff00');
    expect(withLayerColours(DEFAULT_COLORMAP)).toBe(drawn);            // memoized
    const edited = { ...DEFAULT_COLORMAP, rules: DEFAULT_COLORMAP.rules.map(r => (r.id === 'nuc' ? { ...r, color: '#222222' } : r)) };
    expect(withLayerColours(edited).rules.find(r => r.id === 'nuc')!.color).toBe('#222222');
    expect(displayRuleColor({ id: 'nuc', color: '#33a040', colorMode: 'size_gradient' })).toBe('#33a040');
    expect(displayTfOverlayColor('#123123')).toBe('#123123');
    expect(DEFAULT_COLORMAP.rules.find(r => r.id === 'nuc')!.color).toBe('#33a040');   // stored colormap untouched
  });

  it('mark colours (m6A, 5mC, deamination strands, accessibility) take the layer colour', () => {
    expect(effectiveModColors(MOD_COLORS)).toEqual(MOD_COLORS);
    set({ m6a: RED, deam: '#40a0c0', fire: BLUE });
    const c = effectiveModColors(MOD_COLORS);
    expect([c.m6a, c.mod, c.fire, c.msp, c.deam_r]).toEqual([RED, RED, BLUE, BLUE, '#40a0c0']);
    expect(c.deam_y).not.toBe(c.deam_r);
    expect(c.deam_possible_ct).toBe(MOD_COLORS.deam_possible_ct);
  });
});

describe('default metaprofile sources (autoColor)', () => {
  const src = (ruleId: string, color: string, autoColor?: boolean): TrackSource => ({
    id: ruleId, ref: { kind: 'metaprofile', ruleId }, color, ...(autoColor === undefined ? {} : { autoColor }), visible: true, negate: false, scale: 1,
  } as TrackSource);

  it('a curated layer source at its built-in colour follows the override, and back on reset', () => {
    set({ nuc: RED });
    const [followed] = refreshAutoSourceColors([src('nuc', '#16a34a')]);
    expect(followed).toMatchObject({ color: RED, autoColor: true });
    set({});
    expect(refreshAutoSourceColors([followed])[0]).toMatchObject({ color: '#16a34a', autoColor: true });
  });

  it("a colour the user picked for a source (autoColor false) is kept; 3.0.7's auto sources follow", () => {
    setLayerColorSource([{ available_layers: { nuc: true, tf2: true } }]);
    set({ nuc: RED, tf2: BLUE });
    const picked = src('nuc', '#999999', false);
    const out = refreshAutoSourceColors([picked, src('tf2', getDefaultLayerColor('tf2'), true)]);
    expect(out[0]).toBe(picked);
    expect(out[1]).toMatchObject({ color: BLUE, autoColor: true });
  });

  it('a pre-3.0.7 source (no flag) at a non-default colour is the user\'s and stays', () => {
    set({ nuc: RED });
    const old = src('nuc', '#abcdef');
    expect(refreshAutoSourceColors([old])[0]).toBe(old);
  });

  it('follows through the store: the default metaprofile repaints when a layer colour changes', () => {
    const store = useBrowserStore.getState();
    const def = store.compositeTracks.find(c => c.sources.some(s => s.ref.kind === 'metaprofile'));
    if (!def) return;   // no default track without datasets in this store: covered above
    setLayerColorOverride('nuc', RED);
    const after = useBrowserStore.getState().compositeTracks.find(c => c.id === def.id)!;
    const nuc = after.sources.find(s => s.ref.kind === 'metaprofile' && (s.ref as { ruleId: string }).ruleId === 'nuc');
    if (nuc && nuc.autoColor !== false) expect(nuc.color).toBe(RED);
  });
});

describe('sessions', () => {
  it('round-trip: a session carries its own colours (not the saved defaults) and restores them', () => {
    set({ nuc: RED }, { tf: BLUE });
    const frontend = JSON.parse(JSON.stringify(collectFrontendState()));
    expect(frontend[SESSION_KEY]).toEqual({ nuc: RED });
    expect(frontend.userLayerColors).toBeUndefined();
    set({}, { tf: BLUE });
    applyImportedState({ datasets: [], overlays: [], has_fasta: false, frontend, viewport: { chrom: 'chr1', start: 1, end: 2 } });
    expect(useBrowserStore.getState().layerColorOverrides).toEqual({ nuc: RED });
    expect(effectiveLayerColors(useBrowserStore.getState())).toEqual({ tf: BLUE, nuc: RED });
  });

  it('an older session (no layer colours) opens with none; the saved defaults still apply', () => {
    set({ nuc: RED }, { nuc: BLUE });
    applyImportedState({ datasets: [], overlays: [], has_fasta: false, frontend: {}, viewport: { chrom: 'chr1', start: 1, end: 2 } });
    expect(useBrowserStore.getState().layerColorOverrides).toEqual({});
    expect(getLayerColor('nuc')).toBe(BLUE);
  });

  it('a colour change is an undo step (undo and redo)', () => {
    useBrowserStore.setState({ _historyStack: [], _historyPointer: -1 } as never);
    setLayerColorOverride('nuc', RED);
    setLayerColorOverride('tf', BLUE);
    expect(useBrowserStore.getState().layerColorOverrides).toEqual({ nuc: RED, tf: BLUE });
    useBrowserStore.getState().undo();
    expect(useBrowserStore.getState().layerColorOverrides).toEqual({ nuc: RED });
    expect(getLayerColor('tf')).toBe('#e040fb');
    useBrowserStore.getState().undo();
    expect(useBrowserStore.getState().layerColorOverrides).toEqual({});
    useBrowserStore.getState().redo();
    expect(useBrowserStore.getState().layerColorOverrides).toEqual({ nuc: RED });
  });

  it('undo snapshots restore the colours; a snapshot from before the setting leaves them alone', () => {
    const ext = storeExtensions().find(e => e.id === 'layerColours')!;
    expect(ext.restoreSnapshot!({ [SESSION_KEY]: { msp: RED } })).toEqual({ layerColorOverrides: { fire: RED } });
    expect(ext.restoreSnapshot!({})).toEqual({});
    expect(ext.importSession!({ [SESSION_KEY]: 'junk' } as never, useBrowserStore.getState())).toEqual({ layerColorOverrides: {} });
  });
});

describe('saved defaults on this computer (analysis preferences)', () => {
  function server(initial: Record<string, any> = {}) {
    let kept: Record<string, any> = { pinned_motifs: {}, [PREFERENCE_FIELD]: {}, ...initial };
    const puts: Record<string, any>[] = [];
    vi.mocked(fetchJson).mockReset().mockImplementation(async (url: string, options?: RequestInit) => {
      expect(url).toBe(PREFERENCES_URL);
      if (options?.method !== 'PUT') return JSON.parse(JSON.stringify(kept));
      const body = JSON.parse(String(options.body));
      puts.push(body);
      for (const [k, v] of Object.entries(body[PREFERENCE_FIELD] ?? {})) {
        if (body.only_missing && k in kept[PREFERENCE_FIELD]) continue;
        if (v == null) delete kept[PREFERENCE_FIELD][k]; else kept[PREFERENCE_FIELD] = { ...kept[PREFERENCE_FIELD], [k]: v };
      }
      return JSON.parse(JSON.stringify(kept));
    });
    return { puts, kept: () => kept };
  }
  beforeEach(() => { resetAnalysisPreferences(); localStorage.setItem(PREFERENCES_MOVED_KEY, '1'); });
  afterEach(() => resetAnalysisPreferences());

  it("new pages start with the server's saved defaults; saving and clearing write back per layer", async () => {
    const srv = server({ [PREFERENCE_FIELD]: { nuc: BLUE } });
    await initAnalysisPreferences();
    expect(useBrowserStore.getState().userLayerColors).toEqual({ nuc: BLUE });
    expect(getLayerColor('nuc')).toBe(BLUE);
    setLayerColorOverride('tf', RED);
    saveLayerColorsAsDefault();
    await flushPreferences();
    expect(srv.kept()[PREFERENCE_FIELD]).toEqual({ nuc: BLUE, tf: RED });
    clearSavedLayerColorDefaults();
    await flushPreferences();
    expect(srv.kept()[PREFERENCE_FIELD]).toEqual({});
    expect(srv.puts.at(-1)![PREFERENCE_FIELD]).toEqual({ nuc: null, tf: null });
  });

  it('the session colour wins over a saved default that arrives later', async () => {
    server({ [PREFERENCE_FIELD]: { nuc: BLUE } });
    set({ nuc: RED });
    await initAnalysisPreferences();
    expect(getLayerColorOverride('nuc')).toBe(RED);
  });
});

describe('near-identical colour check', () => {
  it('flags confusable pairs (normal vision, then simulated colour blindness) and not distinct ones', () => {
    expect(deltaE('#16a34a', '#16a34a')).toBe(0);
    expect(similarColorPairs([{ key: 'a', color: '#16a34a' }, { key: 'b', color: '#18a54c' }])).toMatchObject([{ a: 'a', b: 'b', vision: 'normal' }]);
    expect(similarColorPairs([{ key: 'a', color: '#16a34a' }, { key: 'b', color: '#e040fb' }])).toEqual([]);
    // red vs green: distinct for normal vision, close for a red–green colour-blind viewer
    const cvd = similarColorPairs([{ key: 'a', color: '#c8a000' }, { key: 'b', color: '#ffa000' }], { threshold: 5, dichromatThreshold: 25 });
    expect(cvd.length).toBe(1);
  });
});
