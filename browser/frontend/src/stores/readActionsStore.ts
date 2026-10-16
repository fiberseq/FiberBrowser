/**
 * State of the read actions (fb-r4-clicks): reads highlighted after "go to
 * read by name" or "Highlight read in all panels", the reads the display
 * sample must keep (pins), reads hidden with "Exclude selected", and the
 * one-time hint about right-click / Shift / ⌘ clicks.
 *
 * Exclusions change which reads a panel shows (like "Keep only selected"), so
 * they are part of undo steps, sessions and the autosave (serializeExcludedReads /
 * applyExcludedReads, called by the history slice). The rest is about what the
 * user is looking at right now and is never saved.
 */
import { create } from 'zustand';

/** How long a read pulses after it is gone to (ms). */
export const READ_PULSE_MS = 4000;
/** Pins sent with read requests (the server keeps at most 50). */
export const MAX_PINNED_READS = 50;

export const READ_ACTIONS_HINT_KEY = 'fiberbrowser_read_actions_hint_v1';

export interface ReadHighlight {
  ids: Set<string>;
  /** Until when it pulses (epoch ms); null: a steady outline until cleared. */
  pulseUntil: number | null;
  /** Bring this read into view in the read stack (once per panel). */
  scrollTo: string | null;
  /** Panels (state keys) that already scrolled to it. */
  scrolled: Set<string>;
  /** Changes with every new highlight (restarts the pulse). */
  nonce: number;
}

interface ReadActionsState {
  highlight: ReadHighlight | null;
  /** Read ids every read request asks the server to keep in the display sample. */
  pinnedReadIds: string[];
  /** stateKey -> read ids hidden in that panel ("Exclude selected"). */
  excludedReadIds: Record<string, Set<string>>;
  /** The panel (state key) showing the click hint; null: none. */
  hintStateKey: string | null;
  /** A short confirmation over a panel ("Read name copied"). */
  notice: { stateKey: string; text: string; nonce: number } | null;
  /** Changes when another session or snapshot is opened (a running read search then stands down). */
  epoch: number;
  /** Forget everything (another session or a crash snapshot was opened). */
  reset: () => void;
  /** Pulse these reads (a read gone to by name) and keep them in the sample. */
  pulseReads: (ids: string[], options?: { scrollTo?: string | null }) => void;
  /** A steady outline on these reads in every panel ("Highlight read in all panels"). */
  highlightReads: (ids: string[]) => void;
  clearHighlight: () => void;
  markScrolled: (stateKey: string) => void;
  excludeReads: (stateKey: string, ids: Iterable<string>) => void;
  clearExcluded: (stateKey?: string) => void;
  showHint: (stateKey: string) => void;
  dismissHint: () => void;
  showNotice: (stateKey: string, text: string) => void;
  clearNotice: (nonce: number) => void;
}

let nonce = 0;

function pinsFor(ids: string[]): string[] {
  return [...new Set(ids)].slice(0, MAX_PINNED_READS);
}

export const useReadActionsStore = create<ReadActionsState>((set) => ({
  highlight: null,
  pinnedReadIds: [],
  excludedReadIds: {},
  hintStateKey: null,
  notice: null,
  epoch: 0,
  reset: () => set(state => ({
    highlight: null, pinnedReadIds: [], excludedReadIds: {}, hintStateKey: null, notice: null, epoch: state.epoch + 1,
  })),
  pulseReads: (ids, options) => set({
    highlight: {
      ids: new Set(ids),
      pulseUntil: Date.now() + READ_PULSE_MS,
      scrollTo: options?.scrollTo === undefined ? (ids[0] ?? null) : options.scrollTo,
      scrolled: new Set(),
      nonce: ++nonce,
    },
    pinnedReadIds: pinsFor(ids),
  }),
  highlightReads: (ids) => set(state => ({
    highlight: { ids: new Set(ids), pulseUntil: null, scrollTo: null, scrolled: new Set(), nonce: ++nonce },
    pinnedReadIds: pinsFor([...ids, ...state.pinnedReadIds]),
  })),
  clearHighlight: () => set({ highlight: null, pinnedReadIds: [] }),
  markScrolled: (stateKey) => set(state => {
    if (!state.highlight || state.highlight.scrolled.has(stateKey)) return {};
    const scrolled = new Set(state.highlight.scrolled);
    scrolled.add(stateKey);
    return { highlight: { ...state.highlight, scrolled } };
  }),
  excludeReads: (stateKey, ids) => set(state => {
    const next = new Set(state.excludedReadIds[stateKey] ?? []);
    for (const id of ids) next.add(id);
    return { excludedReadIds: { ...state.excludedReadIds, [stateKey]: next } };
  }),
  clearExcluded: (stateKey) => set(state => {
    if (stateKey === undefined) return { excludedReadIds: {} };
    const { [stateKey]: _gone, ...rest } = state.excludedReadIds;
    return { excludedReadIds: rest };
  }),
  showHint: (stateKey) => set({ hintStateKey: stateKey }),
  dismissHint: () => set({ hintStateKey: null }),
  showNotice: (stateKey, text) => set({ notice: { stateKey, text, nonce: ++nonce } }),
  clearNotice: (n) => set(state => (state.notice?.nonce === n ? { notice: null } : {})),
}));

/** Exclusions as snapshots and sessions keep them (state key -> read ids, sorted). */
export function serializeExcludedReads(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, ids] of Object.entries(useReadActionsStore.getState().excludedReadIds)) {
    if (ids && ids.size > 0) out[key] = [...ids].sort();
  }
  return out;
}

/**
 * Put back saved exclusions (an undo step, a reopened or imported session).
 * Absent (a step or session from before exclusions were saved): none.
 */
export function applyExcludedReads(saved: unknown): void {
  const next: Record<string, Set<string>> = {};
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    for (const [key, ids] of Object.entries(saved as Record<string, unknown>)) {
      const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
      if (list.length > 0) next[key] = new Set(list);
    }
  }
  const current = useReadActionsStore.getState().excludedReadIds;
  const same = Object.keys(next).length === Object.keys(current).length
    && Object.entries(next).every(([key, ids]) => {
      const have = current[key];
      return !!have && have.size === ids.size && [...ids].every(id => have.has(id));
    });
  // Unchanged: keep the same object (the panels' read requests don't rerun).
  if (!same) useReadActionsStore.setState({ excludedReadIds: next });
}

/** Whether the click hint was shown before (remembered in this browser). */
export function readActionsHintSeen(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(READ_ACTIONS_HINT_KEY) === '1';
  } catch {
    return true;  // storage blocked: don't nag on every click
  }
}

/** The first click on reads: show the hint once (remembered). */
export function maybeShowReadActionsHint(stateKey: string): void {
  if (readActionsHintSeen() || useReadActionsStore.getState().hintStateKey !== null) return;
  try { localStorage.setItem(READ_ACTIONS_HINT_KEY, '1'); } catch { /* shown this session only */ }
  useReadActionsStore.getState().showHint(stateKey);
}
