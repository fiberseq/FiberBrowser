/**
 * One short name per run, everywhere it is shown (usability round 2, Top 4): "Footprint run 2 · 6 Oct 14:02", its
 * order among the session's runs of that kind and when it started. The run's id goes in the tooltip (runTitle), never
 * in the visible text. Until the order is known (a run another panel names before the run list was read) the short
 * id form stands in ("Footprint run 7c90…").
 */
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { getConsensusJobs } from '../api/consensusWorkflow';
import { runLabel, runTitle, type RunKind } from './classIdentity';

export interface RunMeta { order: number; createdAt: number | null }
export interface ListedRun { job_id: string; created_at?: number | null }

interface RunNamesState {
  runs: Record<string, RunMeta>;
  /** A kind's whole run list from the server (in any order; never a partial list): each run's order is its place by
   * start time, from 1. */
  note: (kind: RunKind, jobs: ListedRun[]) => void;
}

const key = (kind: RunKind, id: string) => `${kind}:${id}`;

export const useRunNamesStore = create<RunNamesState>(set => ({
  runs: {},
  note: (kind, jobs) => set(s => {
    const sorted = [...jobs].sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
    const next = { ...s.runs };
    let changed = false;
    sorted.forEach((j, i) => {
      const k = key(kind, j.job_id), meta = { order: i + 1, createdAt: j.created_at ?? null };
      if (next[k]?.order !== meta.order || next[k]?.createdAt !== meta.createdAt) { next[k] = meta; changed = true; }
    });
    return changed ? { runs: next } : s;
  }),
}));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "6 Oct 14:02" (local time); epoch seconds or ms. */
export function runTime(t: number | null | undefined): string {
  if (t == null || !Number.isFinite(t)) return '';
  const d = new Date(t < 1e12 ? t * 1000 : t);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "Footprint run 2 · 6 Oct 14:02"; without its order, the short id ("Footprint run 7c90…"). */
export function runName(kind: RunKind, runId: string | null | undefined, meta?: RunMeta | null): string {
  if (!runId || !meta) return runLabel(kind, runId);
  const when = runTime(meta.createdAt);
  return `${runLabel(kind, null)} ${meta.order}${when ? ` · ${when}` : ''}`;
}

/** Where each kind's run list comes from (the lab pack adds its own kinds). */
const listers: Partial<Record<RunKind, () => Promise<ListedRun[]>>> = {
  footprint: () => getConsensusJobs().then(r => r.jobs),
};
export function registerRunLister(kind: RunKind, list: () => Promise<ListedRun[]>): void { listers[kind] = list; }

const inFlight = new Map<RunKind, { at: number; promise: Promise<void> }>();
/** Read a kind's run list (at most every few seconds while a run stays unknown). */
export function refreshRunNames(kind: RunKind, force = false): Promise<void> {
  const list = listers[kind];
  if (!list) return Promise.resolve();
  const last = inFlight.get(kind);
  if (last && !force && Date.now() - last.at < 4000) return last.promise;
  const promise = list().then(jobs => useRunNamesStore.getState().note(kind, jobs)).catch(() => { /* the short id stays */ });
  inFlight.set(kind, { at: Date.now(), promise });
  return promise;
}

/** How often, and how many times, a run still unknown is looked for again while it is shown. */
export const RUN_NAME_RETRY_MS = 5000;
export const RUN_NAME_RETRIES = 6;

/** A run's short name and its tooltip (the full id); reads the run list when the run is not known yet, and again a
 * few times (a run started elsewhere, or a list read just before it existed), then keeps the short id. */
export function useRunName(kind: RunKind, runId: string | null | undefined): { name: string; title: string; known: boolean } {
  const meta = useRunNamesStore(s => (runId ? s.runs[key(kind, runId)] : undefined));
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { setAttempt(0); }, [kind, runId]);
  useEffect(() => {
    if (!runId || meta) return;
    void refreshRunNames(kind);
    if (attempt >= RUN_NAME_RETRIES) return;
    const t = setTimeout(() => setAttempt(n => n + 1), RUN_NAME_RETRY_MS);
    return () => clearTimeout(t);
  }, [kind, runId, meta, attempt]);
  return { name: runName(kind, runId, meta), title: runTitle(kind, runId), known: !!meta };
}

/** For tests. */
export function resetRunNames(): void { inFlight.clear(); useRunNamesStore.setState({ runs: {} }); }
