/**
 * "Split into panels": the read names each split panel shows (by its state key), resolved from the panel's membership
 * rule (utils/splitPanels.ts), and the split the dialog is asking about. Not in undo snapshots: the panels carry their
 * rule, and a session also keeps these names as the fallback when a run is gone.
 */
import { create } from 'zustand';
import { idSetHas, recordKey } from '../utils/recordKeys';
import type { FeatureRef } from './featureStore';

/** Split sources plugin packs add (utils/splitPanels.ts registerSplitSourceKind): a pack augments this interface
 * (`declare module`) with its sources, keyed by their kind. */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface PackSplitSources {}

export type SplitSource =
  | { kind: 'patterns'; features: FeatureRef[] }
  | { kind: 'frozen'; panelId: string; title: string }
  | PackSplitSources[keyof PackSplitSources];

export interface SplitReads {
  ids: Set<string>;
  /** ready: from the rule; frozen: the names saved with the session (the run is gone); error: nothing to show. */
  state: 'loading' | 'ready' | 'frozen' | 'error';
  message?: string;
}

/** A read name no read has: a split panel whose reads are not known yet shows none (an empty set would show all). */
export const NO_READS = '\u0000no-reads';

interface SplitPanelStore {
  reads: Record<string, SplitReads>;
  /** Bumped when a session is imported: a resolution still running belongs to the previous one. */
  generation: number;
  setReads: (stateKey: string, value: SplitReads) => void;
  dropReads: (stateKeys: string[]) => void;
  /** The dialog: what to split, from where. */
  pending: { source: SplitSource; panelIds?: string[] } | null;
  request: (source: SplitSource, panelIds?: string[]) => void;
  cancel: () => void;
}

export const useSplitPanelStore = create<SplitPanelStore>(set => ({
  reads: {},
  generation: 0,
  setReads: (stateKey, value) => set(s => ({ reads: { ...s.reads, [stateKey]: value } })),
  dropReads: keys => set(s => ({ reads: Object.fromEntries(Object.entries(s.reads).filter(([k]) => !keys.includes(k))) })),
  pending: null,
  request: (source, panelIds) => set({ pending: { source, panelIds } }),
  cancel: () => set({ pending: null }),
}));

/** The read filter a split panel applies: its reads (none while loading), within the panel's own read filter. */
export function splitReadFilter(subset: SplitReads | undefined, filter: Set<string> | null | undefined, rule?: { liftHap?: string }): Set<string> | null | undefined {
  if (rule?.liftHap) return filter;
  if (!subset) return filter;
  const ids = subset.state === 'loading' || subset.state === 'error' || subset.ids.size === 0 ? new Set([NO_READS]) : subset.ids;
  if (!filter) return ids;
  // A filter can name lifted rows by record key (per-record feature states): idSetHas matches those too.
  const both = new Set([...ids].filter(id => idSetHas(filter, [id], recordKey(id))));
  return both.size ? both : new Set([NO_READS]);
}
