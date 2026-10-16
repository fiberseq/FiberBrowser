/**
 * Browser-store state a plugin pack keeps (ARCHITECTURE.md): its slice is merged into the browser store when the pack
 * registers, and core saves and restores it with everything else, by these hooks:
 *
 * - `serialize` / `restoreSnapshot`: undo snapshots and crash recovery (stores/historySlice.ts) and the session's
 *   frontend state (the same serialized form);
 * - `importSettings` (before the session's view is applied) and `importSession` (after it: state that belongs to a
 *   session, reset for one without it), with `onSessionImport` for the pack's own transient stores;
 * - `persist`: written back to this computer's storage when it changes;
 * - `settingsHistory`: in-place edits recorded as undo steps (hooks/useSettingsHistory.ts).
 *
 * A session lists the keys each pack saved (`packs` in its frontend state, api/session.ts); a build without the pack
 * leaves those keys alone and says so.
 */
import { declareContribution } from '../plugins/packRegistry';
import type { BrowserState } from './browserStore';
import type { SnapshotKind } from './historySlice';
import type { PeakRule } from '../types';

type SetState = (partial: Partial<BrowserState> | ((state: BrowserState) => Partial<BrowserState>)) => void;

export interface SettingsHistoryWatch {
  key: string;
  kind: SnapshotKind;
  signature: (s: BrowserState) => unknown;
  label: (s: BrowserState) => string;
  /** The store field it reads (its change is what is watched). */
  slice: string;
}

export interface StoreExtension {
  id: string;
  /** Initial state and actions (a zustand slice), merged into the browser store at registration. */
  create: (set: SetState, get: () => BrowserState) => Record<string, unknown>;
  /** The keys it saves (snapshots, sessions, autosave). */
  keys: string[];
  serialize: (state: BrowserState) => Record<string, unknown>;
  /** From a snapshot or crash recovery: what to put back (keys left out are left alone). */
  restoreSnapshot?: (saved: Record<string, unknown>) => Record<string, unknown>;
  /** Session import, with the settings (before the view is applied). */
  importSettings?: (frontend: Record<string, unknown>) => Record<string, unknown>;
  /** Session import, after the view is applied: the session's own state, or the reset for a session without it. */
  importSession?: (frontend: Record<string, unknown> | undefined, state: BrowserState) => Record<string, unknown>;
  /** A session is being imported: the pack's transient stores belong to the previous one. */
  onSessionImport?: () => void;
  /** Keep associated state in the same transaction when a peak rule changes or is removed. */
  onPeakRuleChange?: (state: BrowserState, id: string, updates: Partial<PeakRule> | null) => Partial<BrowserState>;
  persist?: (state: BrowserState, previous: BrowserState) => void;
  settingsHistory?: SettingsHistoryWatch[];
}

const extensions: StoreExtension[] = [];
type StoreApi = { setState: (partial: Record<string, unknown>) => void; getState: () => BrowserState; subscribe: (fn: (s: BrowserState, p: BrowserState) => void) => () => void };
let storeApi: StoreApi | null = null;
const waiting: StoreExtension[] = [];

function attach(api: StoreApi, ext: StoreExtension) {
  const set: SetState = partial => api.setState((typeof partial === 'function' ? partial(api.getState()) : partial) as Record<string, unknown>);
  api.setState(ext.create(set, api.getState));
  if (ext.persist) api.subscribe((state, previous) => ext.persist!(state, previous));
}

/** Add a pack's state to the browser store (now, or as soon as the store exists). */
export function registerStoreExtension(ext: StoreExtension): void {
  extensions.push(ext);
  for (const key of ext.keys) declareContribution('stateKeys', key);
  if (storeApi) attach(storeApi, ext);
  else waiting.push(ext);
}

/** stores/browserStore.ts: the store, once created. */
export function connectStoreExtensions(api: StoreApi): void {
  storeApi = api;
  for (const ext of waiting.splice(0)) attach(api, ext);
}

export function storeExtensions(): readonly StoreExtension[] {
  return extensions;
}

/** Every extension's serialized state (merged into a snapshot or a session's frontend state). */
export function serializeExtensions(state: BrowserState): Record<string, unknown> {
  return Object.assign({}, ...extensions.map(ext => ext.serialize(state)));
}

/** What the extensions put back from a snapshot. */
export function restoreExtensions(saved: Record<string, unknown>): Record<string, unknown> {
  return Object.assign({}, ...extensions.map(ext => ext.restoreSnapshot?.(saved) ?? {}));
}

/** The keys the extensions save (autosave watches them). */
export function extensionKeys(): string[] {
  return extensions.flatMap(ext => ext.keys);
}
