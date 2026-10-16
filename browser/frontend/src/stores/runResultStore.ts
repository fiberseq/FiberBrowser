/**
 * The outcome of the last run of each read operation (Cluster, Sort, Filter), shown beside the toolbar until the
 * next run of the same kind starts (usability audit Top 3): a refusal, a note about what was left out, or what was
 * done. Replaces the sticky global error banner for an operation's own outcome, which stayed up after a later
 * successful run.
 */
import { create } from 'zustand';

export type RunKind = 'cluster' | 'sort' | 'filter';
export type RunTone = 'error' | 'note' | 'done';

export interface RunResult {
  /** Refusals and no-op explanations stay visible with summaries off. */
  alwaysShow?: boolean;
  tone: RunTone;
  text: string;
  action?: { label: string; panel: string };
  /** Which run it belongs to (beginRun's number). */
  run: number;
  /**
   * When the run's result came (ms since the epoch): the line shows it with the run's number, so a rerun that gives
   * the same text visibly replaces the line (round 3, B5).
   */
  at: number;
  /**
   * The panels the run acted on (panel ids; absent: not tied to panels). Once none of them is open the line says
   * "(panel closed)" (round 2, N5: "Clustered 2,033 reads in Carriers." outlived both split panels).
   */
  panelIds?: string[];
}

/** What a run reports: its tone and text, and optionally the panels it acted on. */
export interface RunReport {
  /** Refusals and no-op explanations stay visible with summaries off. */
  alwaysShow?: boolean;
  tone: RunTone;
  text: string;
  action?: { label: string; panel: string };
  panelIds?: string[];
}

/** Settings › Read Display: a line for runs that went through, too (off: only refusals show). */
export const SHOW_RUN_SUMMARIES_KEY = 'fiberbrowser_show_run_summaries';
function storedShowSummaries(): boolean {
  try { return localStorage.getItem(SHOW_RUN_SUMMARIES_KEY) === 'true'; } catch { return false; }
}

interface RunResultState {
  results: Partial<Record<RunKind, RunResult>>;
  /**
   * Whether a run that went through gets a line ("Clustered 1,802 reads in …"). Off by default (owner): the reads
   * show what was done; refusals always show. Notes remain available in result details.
   */
  showSummaries: boolean;
  setShowSummaries: (on: boolean) => void;
  runs: Partial<Record<RunKind, number>>;
  /** A run starts: the previous run's result goes. Returns the run's number. */
  beginRun: (kind: RunKind) => number;
  /** The result of `run` (default: the current run); a stale run's result is dropped. Several notes of one run join. */
  setRunResult: (kind: RunKind, result: RunReport, run?: number) => void;
  clearRunResult: (kind: RunKind) => void;
}

const TONE_RANK: Record<RunTone, number> = { done: 0, note: 1, error: 2 };

export const useRunResultStore = create<RunResultState>((set, get) => ({
  results: {},
  showSummaries: storedShowSummaries(),
  setShowSummaries: (on) => {
    try { localStorage.setItem(SHOW_RUN_SUMMARIES_KEY, String(on)); } catch { /* this page only */ }
    set({ showSummaries: on });
  },
  runs: {},
  beginRun: (kind) => {
    const run = (get().runs[kind] ?? 0) + 1;
    set(s => ({ runs: { ...s.runs, [kind]: run }, results: { ...s.results, [kind]: undefined } }));
    return run;
  },
  setRunResult: (kind, result, run) => {
    const current = get().runs[kind] ?? 0;
    const at = run ?? current;
    if (at !== current) return;
    set(s => {
      const prev = s.results[kind];
      if (prev && prev.run === at && result.tone !== 'error') {
        // Another note of the same run: kept together, the stronger tone wins (and the panels of both).
        const tone = TONE_RANK[result.tone] > TONE_RANK[prev.tone] ? result.tone : prev.tone;
        const panelIds = prev.panelIds || result.panelIds ? [...new Set([...(prev.panelIds ?? []), ...(result.panelIds ?? [])])] : undefined;
        return { results: { ...s.results, [kind]: { tone, alwaysShow: prev.alwaysShow || result.alwaysShow, text: `${prev.text} ${result.text}`, action: result.action ?? prev.action, run: at, at: prev.at, ...(panelIds ? { panelIds } : {}) } } };
      }
      return { results: { ...s.results, [kind]: { ...result, run: at, at: Date.now() } } };
    });
  },
  clearRunResult: (kind) => set(s => ({ results: { ...s.results, [kind]: undefined } })),
}));

export const beginRun = (kind: RunKind) => useRunResultStore.getState().beginRun(kind);
export const setRunResult = (kind: RunKind, result: RunReport, run?: number) =>
  useRunResultStore.getState().setRunResult(kind, result, run);
export const useRunResult = (kind: RunKind) => useRunResultStore(s => s.results[kind]);

/** A result tied to panels none of which is open now (`openPanelIds`: the panels open now). */
export function runResultPanelsClosed(result: Pick<RunResult, 'panelIds'>, openPanelIds: ReadonlySet<string>): boolean {
  return Boolean(result.panelIds?.length) && !result.panelIds!.some(id => openPanelIds.has(id));
}
