/**
 * What an analysis panel showed, kept after it closes (audit VAR-7 / bug 3): closing the insertion lens or Variants
 * (or the split panels around them) and opening it again shows the last insertion, its Identify result, the last
 * scan and selection, instead of "Open an insertion first". Closing a panel is not clearing its analysis: each panel
 * has a Clear for that (forgetPanelMemory).
 *
 * Kept for this page only (not in sessions: a session file carries the open panels' own state). A remembered state is
 * offered again only while the same data is open: its dataset (by id and files) and reference, as when it was kept
 * (a dataset id reused for other files, or another session's, never gets it).
 */
import { useBrowserStore } from '../stores/browserStore';
import type { PanelConfig } from '../types';

type Fields = Partial<Record<keyof PanelConfig, unknown>>;
type State = ReturnType<typeof useBrowserStore.getState>;

/** What a kept state is about: its dataset's id, files and the reference ('' when it names no open dataset). */
export function datasetIdentity(datasetId: string | undefined | null, state: Pick<State, 'datasets' | 'fastaPath'>): string {
  const d = datasetId ? state.datasets.find(x => x.id === datasetId) : undefined;
  return d ? JSON.stringify([d.id, d.paths ?? d.path ?? '', state.fastaPath ?? '']) : '';
}

interface Memory {
  /** The PanelConfig fields kept, by panel content type. */
  fields: (keyof PanelConfig)[];
  /** Whether a panel's fields are worth keeping (an insertion is open, a scan was made…). */
  worth: (panel: PanelConfig) => boolean;
  /** The data the fields are about (datasetIdentity of their dataset). */
  identity: (fields: Fields, state: State) => string;
  kept: Fields | null;
  keptIdentity: string;
}

const memories = new Map<string, Memory>();
let unsubscribe: (() => void) | null = null;

function capture(state: State): void {
  for (const [type, memory] of memories) {
    const panel = state.panels.find(p => p.contentType === type);
    if (!panel || !memory.worth(panel)) continue;
    const kept: Fields = {};
    for (const field of memory.fields) if (panel[field] !== undefined) kept[field] = panel[field];
    memory.kept = kept;
    memory.keptIdentity = memory.identity(kept, state);
  }
}

/** Keep these fields of the panel of this content type whenever they are worth it (the latest, until forgotten). */
export function rememberPanelFields(contentType: string, fields: (keyof PanelConfig)[], worth: (panel: PanelConfig) => boolean,
  identity: (fields: Fields, state: State) => string): void {
  const before = memories.get(contentType);
  memories.set(contentType, { fields, worth, identity, kept: before?.kept ?? null, keptIdentity: before?.keptIdentity ?? '' });
  if (unsubscribe) return;
  let last = useBrowserStore.getState().panels;
  capture(useBrowserStore.getState());
  unsubscribe = useBrowserStore.subscribe(s => {
    if (s.panels === last) return;
    last = s.panels;
    capture(s);
  });
}

/** The fields kept for a content type (null: nothing, or forgotten). */
export function rememberedPanelFields(contentType: string): Fields | null {
  return memories.get(contentType)?.kept ?? null;
}

/** "Clear": forget what this panel showed (the next open starts empty). */
export function forgetPanelMemory(contentType: string): void {
  const memory = memories.get(contentType);
  if (memory) memory.kept = null;
}

/**
 * Put the kept fields back on the open panel of this content type, when it is empty (its first field unset) and the
 * same data is open (the identity it was kept with). Returns whether it did.
 */
export function restorePanelFields(contentType: string): boolean {
  const kept = rememberedPanelFields(contentType);
  const memory = memories.get(contentType);
  const state = useBrowserStore.getState();
  if (!kept || !memory || !memory.keptIdentity || memory.identity(kept, state) !== memory.keptIdentity) return false;
  const panel = state.panels.find(p => p.contentType === contentType);
  const fields = memories.get(contentType)!.fields;
  // Only into an empty panel (its first field unset), never over what it shows; other fields only where unset.
  if (!panel || panel[fields[0]] !== undefined) return false;
  const missing = Object.fromEntries(Object.entries(kept).filter(([f]) => panel[f as keyof PanelConfig] === undefined));
  useBrowserStore.setState(s => ({ panels: s.panels.map(p => (p.id === panel.id ? { ...p, ...missing } : p)) }));
  return true;
}

/** Test helper. */
export function resetPanelMemory(): void {
  for (const memory of memories.values()) { memory.kept = null; memory.keptIdentity = ''; }
}
