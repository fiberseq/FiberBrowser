/**
 * Datasets being opened (from the Library): each shows at once as a placeholder panel with its name and
 * what the open is doing ("Loading the reference dm6…", "Checking the file and reading its index…"),
 * until its real panel replaces it; an open that fails keeps its placeholder with the reason
 * (components/tracks/OpeningPanels.tsx). Not in sessions or undo.
 */
import { create } from 'zustand';

export interface OpeningDataset {
  /** The file's path (one placeholder per file). */
  key: string;
  label: string;
  stage: string;
  error?: string;
  startedAt: number;
}

interface OpeningStore {
  opening: OpeningDataset[];
  /** What to run again for a failed open (its Retry button). */
  retry: Record<string, () => void>;
  begin: (items: { key: string; label: string; stage: string }[], retry?: () => void) => void;
  stage: (keys: string[], stage: string) => void;
  fail: (key: string, error: string) => void;
  done: (key: string) => void;
  dismiss: (key: string) => void;
}

export const useOpeningStore = create<OpeningStore>(set => ({
  opening: [],
  retry: {},
  begin: (items, retry) => set(s => {
    const keys = new Set(items.map(i => i.key));
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return {
      opening: [...s.opening.filter(o => !keys.has(o.key)), ...items.map(i => ({ ...i, startedAt: now }))],
      retry: retry ? { ...s.retry, ...Object.fromEntries(items.map(i => [i.key, retry])) } : s.retry,
    };
  }),
  stage: (keys, stage) => set(s => ({ opening: s.opening.map(o => (keys.includes(o.key) && !o.error ? { ...o, stage } : o)) })),
  fail: (key, error) => set(s => ({ opening: s.opening.map(o => (o.key === key ? { ...o, error } : o)) })),
  done: key => set(s => {
    const { [key]: _gone, ...retry } = s.retry;
    return { opening: s.opening.filter(o => o.key !== key), retry };
  }),
  dismiss: key => set(s => {
    const { [key]: _gone, ...retry } = s.retry;
    return { opening: s.opening.filter(o => o.key !== key), retry };
  }),
}));
