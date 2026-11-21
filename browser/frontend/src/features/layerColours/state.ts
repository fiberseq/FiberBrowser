/**
 * User-set layer colours (Labels → Layer colours). Two maps, layer key → #rrggbb:
 *
 * - `layerColorOverrides`: the session's own colours. Saved with the session, undo steps and crash recovery (a
 *   browser-store extension, stores/storeExtensions.ts); a session saved without them opens with none.
 * - `userLayerColors`: the user's saved defaults ("Save as my default colours"), kept on this computer in
 *   ~/.fiberhmm/analysis_preferences.json (`layer_colors`, utils/analysisPreferences) with this origin's storage as
 *   the fallback. Never written into a session.
 *
 * The session's colour wins over the saved default; either wins over the curated / palette colour. utils/layerColors
 * getLayerColor reads the effective map through a getter, so every view resolves the same colour;
 * `layerColorVersion` changes whenever the effective map does, for canvases and memos that cache colours.
 */
import { registerStoreExtension } from '../../stores/storeExtensions';
import { useBrowserStore, type BrowserState } from '../../stores/browserStore';
import { registerAnalysisPreferenceMap } from '../../utils/analysisPreferences';
import { requestCanvasRedraw } from '../../utils/canvasUtils';
import {
  effectiveLayerColorOverrides, layerColorKey, normalizeLayerColorMap, normalizeLayerHex, setLayerColorOverrideSource,
} from '../../utils/layerColors';

export const SESSION_KEY = 'layerColorOverrides';
/** Its field in the server's analysis preferences (services/analysis_preferences.py). */
export const PREFERENCE_FIELD = 'layer_colors';
/** This origin's copy of the saved defaults (the fallback when the server keeps none). */
export const LOCAL_STORAGE_KEY = 'fiberbrowser_layer_colors_v1';

declare module '../../stores/browserStore' {
  interface BrowserState {
    /** The session's own layer colours (layer key → #rrggbb). */
    layerColorOverrides: Record<string, string>;
    /** The user's saved default layer colours (this computer; not part of a session). */
    userLayerColors: Record<string, string>;
    /** Changes whenever the effective layer colours do (redraw key for cached colours). */
    layerColorVersion: number;
  }
}

const EMPTY: Record<string, string> = Object.freeze({}) as Record<string, string>;

function loadLocalDefaults(): Record<string, string> {
  try {
    return normalizeLayerColorMap(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) ?? '{}'));
  } catch { return {}; }
}

function storeLocalDefaults(map: Record<string, string>): void {
  try {
    if (Object.keys(map).length) localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(map));
    else localStorage.removeItem(LOCAL_STORAGE_KEY);
  } catch { /* private mode */ }
}

let effectiveCache: { session: unknown; user: unknown; out: Record<string, string> } | null = null;

/** The effective overrides for a state (memoized on the two maps). */
export function effectiveLayerColors(state: Pick<BrowserState, 'layerColorOverrides' | 'userLayerColors'>): Record<string, string> {
  const session = state.layerColorOverrides ?? EMPTY;
  const user = state.userLayerColors ?? EMPTY;
  if (effectiveCache && effectiveCache.session === session && effectiveCache.user === user) return effectiveCache.out;
  const out = effectiveLayerColorOverrides(session, user);
  effectiveCache = { session, user, out };
  return out;
}

/** Where a layer's colour comes from: the session, the saved default, or the built-in colour. */
export function layerColorSource(state: Pick<BrowserState, 'layerColorOverrides' | 'userLayerColors'>, key: string): 'session' | 'default' | 'builtin' {
  const k = layerColorKey(key);
  if (state.layerColorOverrides?.[k]) return 'session';
  if (state.userLayerColors?.[k]) return 'default';
  return 'builtin';
}

const pushStep = (label: string, coalesceKey?: string) => {
  useBrowserStore.getState().pushSnapshot?.(label, { kind: 'labeling', coalesceKey, coalesceMs: 1200 });
};

/** Set (a colour) or clear (null) one layer's session colour. */
export function setLayerColorOverride(key: string, color: string | null): void {
  const k = layerColorKey(key);
  const s = useBrowserStore.getState();
  const current = s.layerColorOverrides ?? EMPTY;
  const value = color == null ? null : normalizeLayerHex(color);
  if (color != null && !value) return;
  if ((current[k] ?? null) === value) return;
  if ((s._historyStack?.length ?? 0) === 0) pushStep('Before layer colour change');
  const next = { ...current };
  if (value) next[k] = value; else delete next[k];
  useBrowserStore.setState({ layerColorOverrides: next } as Partial<BrowserState>);
  pushStep(value ? 'Change layer colour' : 'Reset layer colour', value ? `layer-colour:${k}` : undefined);
}

/**
 * Reset a layer to its default: drops the session's colour, and with `includeSavedDefault` the saved default too
 * (so the built-in colour shows).
 */
export function resetLayerColor(key: string, { includeSavedDefault = false } = {}): void {
  const k = layerColorKey(key);
  setLayerColorOverride(k, null);
  if (includeSavedDefault && useBrowserStore.getState().userLayerColors?.[k]) setUserLayerColor(k, null);
}

/** Reset every layer colour (the session's; with `includeSavedDefaults`, the saved defaults too). */
export function resetAllLayerColors({ includeSavedDefaults = false } = {}): void {
  const s = useBrowserStore.getState();
  if (Object.keys(s.layerColorOverrides ?? {}).length) {
    if ((s._historyStack?.length ?? 0) === 0) pushStep('Before layer colour change');
    useBrowserStore.setState({ layerColorOverrides: {} } as Partial<BrowserState>);
    pushStep('Reset layer colours');
  }
  if (includeSavedDefaults && Object.keys(s.userLayerColors ?? {}).length) {
    useBrowserStore.setState({ userLayerColors: {} } as Partial<BrowserState>);
  }
}

/** Set or clear one saved default colour. */
export function setUserLayerColor(key: string, color: string | null): void {
  const k = layerColorKey(key);
  const current = useBrowserStore.getState().userLayerColors ?? EMPTY;
  const value = color == null ? null : normalizeLayerHex(color);
  if (color != null && !value) return;
  const next = { ...current };
  if (value) next[k] = value; else delete next[k];
  useBrowserStore.setState({ userLayerColors: next } as Partial<BrowserState>);
}

/**
 * "Save as my default colours": the colours shown now (saved defaults with this session's over them) become the
 * saved defaults; new sessions start with them.
 */
export function saveLayerColorsAsDefault(): Record<string, string> {
  const s = useBrowserStore.getState();
  const next = { ...effectiveLayerColors(s) };
  useBrowserStore.setState({ userLayerColors: next } as Partial<BrowserState>);
  return next;
}

/** Forget every saved default colour. */
export function clearSavedLayerColorDefaults(): void {
  useBrowserStore.setState({ userLayerColors: {} } as Partial<BrowserState>);
}

/** Subscribe-friendly: the effective overrides (re-renders when they change). */
export function useEffectiveLayerColors(): Record<string, string> {
  return useBrowserStore(effectiveLayerColors);
}

/** The redraw key for consumers that cache layer colours. */
export function useLayerColorVersion(): number {
  return useBrowserStore(s => s.layerColorVersion ?? 0);
}

let registered = false;

export function registerLayerColours(): void {
  if (registered) return;
  registered = true;
  registerStoreExtension({
    id: 'layerColours',
    keys: [SESSION_KEY],
    create: () => ({ layerColorOverrides: {}, userLayerColors: loadLocalDefaults(), layerColorVersion: 0 }),
    serialize: s => ({ [SESSION_KEY]: { ...(s.layerColorOverrides ?? {}) } }),
    // An undo step or crash recovery from before this setting existed leaves the colours alone.
    restoreSnapshot: saved => (SESSION_KEY in saved ? { layerColorOverrides: normalizeLayerColorMap(saved[SESSION_KEY]) } : {}),
    // A session's own colours, or none for a session saved without them (the saved defaults still apply).
    importSession: frontend => ({ layerColorOverrides: normalizeLayerColorMap(frontend?.[SESSION_KEY]) }),
    persist: (state, previous) => {
      if (state.userLayerColors !== previous.userLayerColors) storeLocalDefaults(state.userLayerColors ?? {});
      if (state.layerColorOverrides === previous.layerColorOverrides && state.userLayerColors === previous.userLayerColors) return;
      const before = effectiveLayerColorOverrides(previous.layerColorOverrides, previous.userLayerColors);
      if (JSON.stringify(effectiveLayerColors(state)) !== JSON.stringify(before)) {
        useBrowserStore.setState({ layerColorVersion: (state.layerColorVersion ?? 0) + 1 } as Partial<BrowserState>);
        // Canvases that cache colours (graph panel, cart tracks, lens strips) draw again.
        requestCanvasRedraw();
      }
    },
  });
  setLayerColorOverrideSource(() => effectiveLayerColors(useBrowserStore.getState()));
  registerAnalysisPreferenceMap({
    field: PREFERENCE_FIELD,
    storeKey: 'userLayerColors',
    normalize: v => normalizeLayerColorMap(v),
    loadLocal: () => loadLocalDefaults(),
  });
}
