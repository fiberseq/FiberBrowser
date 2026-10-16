/**
 * Analysis preferences kept by the server on this computer (~/.fiberhmm/analysis_preferences.json, routers/
 * preferences.py): the pinned motifs per species and the custom motifs, and the per-key preferences plugin packs add
 * (registerAnalysisPreferenceMap: e.g. a ChIP-Atlas experiment choice per genome).
 * Browser storage is per origin, so the app on another port (8756, 8757) or a new build never saw them.
 *
 * On start the server's preferences are read; the first time on an origin, that origin's own stored values move
 * there (only where the server has none: nothing already kept is overwritten). They then replace the store's values
 * unless something (a session restored on start) already changed them. Changes in the store (the motif views, a
 * session opened) are written back per species / genome. localStorage stays a fallback: a public server, a tour tab
 * or an unreachable server keeps working from it.
 */
import { fetchJson } from '../api/sharedFetch';
import { useBrowserStore } from '../stores/browserStore';
import { loadPinnedMotifs, normalizePinnedMotifs, type PinnedMotifs } from './pinnedMotifs';
import { loadCustomMotifs, normalizeCustomMotifs, type CustomMotif } from './motifSettings';
import { isSandboxPage } from './sandbox';
import { isPublicServerPage } from './publicServerFlag';
import { PREVIEW_PREFERENCE_FIELD, previewChoiceStored, previewDefault, usePreviewStore } from './previewFeatures';

export const PREFERENCES_URL = '/api/preferences/analysis';
/** Set once this origin's own stored preferences have moved to the server. */
export const PREFERENCES_MOVED_KEY = 'fiberhmm_analysis_preferences_moved_v1';

export interface AnalysisPreferences {
  pinned_motifs: PinnedMotifs;
  custom_motifs?: CustomMotif[];
  /** The plugin packs' per-key preferences (registerAnalysisPreferenceMap). */
  [field: string]: unknown;
}

/** A preference that is a map kept per key (per genome, per species): merged key by key with the server's. */
export interface PreferenceMap {
  /** Its field in the server's file (a pack's PackAPI.preference_map). */
  field: string;
  /** Its browser-store key. */
  storeKey: string;
  normalize: (value: unknown) => Record<string, unknown>;
  /** This origin's stored copy (moved to the server the first time). */
  loadLocal: () => Record<string, unknown>;
}

const preferenceMaps: PreferenceMap[] = [{
  field: 'pinned_motifs', storeKey: 'pinnedMotifs',
  normalize: v => normalizePinnedMotifs(v), loadLocal: () => loadPinnedMotifs(),
}];

/**
 * A single value kept by the server (not a per-key map): Settings → Show preview features. Read once with the rest
 * (the server's value wins unless this page changed it meanwhile), then written whenever it changes.
 */
export interface PreferenceValue {
  field: string;
  /** What it is when nothing was chosen (never written for that alone). */
  defaultValue: unknown;
  /** Whether this page holds the user's own choice (written to a server that has none, even when it is the default). */
  chosen?: () => boolean;
  normalize: (value: unknown) => unknown;
  read: () => unknown;
  apply: (value: unknown) => void;
  subscribe: (listener: () => void) => () => void;
}

const preferenceValues: PreferenceValue[] = [{
  field: PREVIEW_PREFERENCE_FIELD,
  get defaultValue() { return previewDefault(); },
  chosen: () => previewChoiceStored(),
  normalize: v => (typeof v === 'boolean' ? v : undefined),
  read: () => usePreviewStore.getState().enabled,
  apply: v => usePreviewStore.getState().setEnabled(Boolean(v)),
  subscribe: listener => usePreviewStore.subscribe((s, prev) => { if (s.enabled !== prev.enabled) listener(); }),
}];
let valueUnsubscribes: (() => void)[] = [];

/** A plugin pack's per-key preference, kept by the server like the pinned motifs. */
export function registerAnalysisPreferenceMap(map: PreferenceMap): void {
  preferenceMaps.push(map);
}

const storeValue = (state: unknown, key: string) => ((state as Record<string, unknown>)[key] ?? {}) as Record<string, unknown>;

let ready: Promise<void> = Promise.resolve();
let started = false;
/** Whether writes go to the server (false: a public server, a tour tab, or no answer). */
let serverBacked = false;
let applying = false;
let unsubscribe: (() => void) | null = null;
let pending: Record<string, unknown> = {};
let timer: ReturnType<typeof setTimeout> | null = null;
/** One write at a time (a later one never lands before an earlier one); failures are retried. */
let writing: Promise<void> | null = null;
let failures = 0;
const RETRY_MS = [2000, 10000, 30000];

const put = (body: Record<string, unknown>) =>
  fetchJson<AnalysisPreferences>(PREFERENCES_URL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function moved(): boolean {
  try { return localStorage.getItem(PREFERENCES_MOVED_KEY) === '1'; } catch { return true; }
}
function markMoved() {
  try { localStorage.setItem(PREFERENCES_MOVED_KEY, '1'); } catch { /* private mode */ }
}

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** ``newer`` over ``older``: per genome / species for the maps, whole for the custom list. */
function mergePatch(older: Record<string, unknown>, newer: Record<string, unknown>): Record<string, unknown> {
  const out = { ...older };
  for (const [k, v] of Object.entries(newer)) out[k] = isMap(v) && isMap(out[k]) ? { ...(out[k] as object), ...v } : v;
  return out;
}

/** Queue a change for the server (merged per key, sent shortly after the last change). */
function queue(patch: Record<string, unknown>) {
  if (!serverBacked) return;
  pending = mergePatch(pending, patch);
  schedule(250);
}

function schedule(ms: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void flushPreferences(); }, ms);
}

/** Send what is queued: one PUT at a time; edits made meanwhile go in the next one. A failed write goes back under
 * any newer edit and is tried again (2 s, 10 s, 30 s, then with the next change). */
export async function flushPreferences(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  for (;;) {
    if (writing) { await writing; continue; }
    if (!Object.keys(pending).length || !serverBacked) return;
    const body = pending;
    pending = {};
    let failed = false;
    const mine: Promise<void> = put(body).then(() => { failures = 0; }, () => { failed = true; pending = mergePatch(body, pending); });
    writing = mine;
    await mine;
    if (writing === mine) writing = null;
    if (failed) {
      if (failures < RETRY_MS.length) schedule(RETRY_MS[failures]);
      failures += 1;
      return;
    }
  }
}

/** Per-key changes between two maps ({key: value | null}: null removed). */
export function mapChanges<T>(before: Record<string, T>, after: Record<string, T>): Record<string, T | null> {
  const out: Record<string, T | null> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!(k in after)) out[k] = null;
    else if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out[k] = after[k];
  }
  return out;
}

/** Per-species changes between two pinned maps ({species: list | null}). */
export function pinnedChanges(before: PinnedMotifs, after: PinnedMotifs): Record<string, string[] | null> {
  return mapChanges(before, after);
}

/** A map with per-key changes applied (null: removed). */
function applyChanges<T>(base: Record<string, T>, changes: Record<string, T | null>): Record<string, T> {
  const out = { ...base };
  for (const [k, v] of Object.entries(changes)) { if (v == null) delete out[k]; else out[k] = v; }
  return out;
}

function subscribeValues() {
  for (const off of valueUnsubscribes) off();
  valueUnsubscribes = preferenceValues.map(pref => pref.subscribe(() => {
    if (!applying) queue({ [pref.field]: pref.read() });
  }));
}

function subscribe() {
  subscribeValues();
  unsubscribe?.();
  unsubscribe = useBrowserStore.subscribe((state, previous) => {
    if (applying) return;
    const patch: Record<string, unknown> = {};
    for (const map of preferenceMaps) {
      const now = storeValue(state, map.storeKey), before = storeValue(previous, map.storeKey);
      if (now === before) continue;
      const c = mapChanges(before, now);
      if (Object.keys(c).length) patch[map.field] = c;
    }
    if (state.customMotifs !== previous.customMotifs) patch.custom_motifs = state.customMotifs;
    if (Object.keys(patch).length) queue(patch);
  });
}

/**
 * Read the server's preferences (moving this origin's stored ones there the first time) and follow the store. Once
 * per page; later calls return the same promise. A store value changed since the page loaded is kept (and written).
 */
export function initAnalysisPreferences(): Promise<void> {
  if (started) return ready;
  started = true;
  if (isSandboxPage() || isPublicServerPage()) return ready;
  const initial = useBrowserStore.getState();
  const boot = { maps: preferenceMaps.map(m => storeValue(initial, m.storeKey)), custom: initial.customMotifs,
    values: preferenceValues.map(v => v.read()) };
  ready = (async () => {
    let prefs: AnalysisPreferences;
    try {
      prefs = await fetchJson<AnalysisPreferences>(PREFERENCES_URL);
      serverBacked = true;
      if (!moved()) {
        const local = { maps: preferenceMaps.map(m => m.loadLocal()), custom: loadCustomMotifs() };
        if (local.maps.some(m => Object.keys(m).length) || local.custom.length) {
          prefs = await put({
            only_missing: true,
            ...Object.fromEntries(preferenceMaps.map((m, i) => [m.field, local.maps[i]])),
            ...(local.custom.length ? { custom_motifs: local.custom } : {}),
          });
        }
        markMoved();
      }
    } catch {
      serverBacked = false;          // a public server, a tour tab, an older server: localStorage only
      return;
    }
    // Changes made while the answer was on its way (a session restored on start, an edit) are kept: applied over the
    // server's values per key, and written back; nothing else the server keeps is touched.
    const s = useBrowserStore.getState();
    const patch: Record<string, unknown> = {};
    const later: Record<string, unknown> = {};
    preferenceMaps.forEach((map, i) => {
      const edits = mapChanges(boot.maps[i], storeValue(s, map.storeKey));
      patch[map.storeKey] = map.normalize(applyChanges(map.normalize(prefs[map.field]), edits));
      if (Object.keys(edits).length) later[map.field] = edits;
    });
    if (s.customMotifs !== boot.custom) later.custom_motifs = s.customMotifs;
    else if (prefs.custom_motifs) patch.customMotifs = normalizeCustomMotifs(prefs.custom_motifs);
    // Single values: the server's, unless this page changed it meanwhile (the server has none yet: this page's own,
    // unless that is the default).
    const values: [PreferenceValue, unknown][] = [];
    preferenceValues.forEach((pref, i) => {
      const kept = pref.normalize(prefs[pref.field]);
      if (pref.read() !== boot.values[i] || (kept === undefined && (pref.read() !== pref.defaultValue || pref.chosen?.()))) later[pref.field] = pref.read();
      else if (kept !== undefined) values.push([pref, kept]);
    });
    applying = true;
    try {
      useBrowserStore.setState(patch as never);
      for (const [pref, value] of values) pref.apply(value);
    } finally { applying = false; }
    subscribe();
    if (Object.keys(later).length) queue(later);
  })();
  return ready;
}

/** Resolves once the server's preferences are in the store (or there are none to wait for). */
export function analysisPreferencesReady(): Promise<void> {
  return ready;
}

/** Tests: forget the started state. */
export function resetAnalysisPreferences(): void {
  unsubscribe?.();
  unsubscribe = null;
  for (const off of valueUnsubscribes) off();
  valueUnsubscribes = [];
  started = false;
  serverBacked = false;
  applying = false;
  pending = {};
  if (timer) clearTimeout(timer);
  timer = null;
  writing = null;
  failures = 0;
  ready = Promise.resolve();
}
