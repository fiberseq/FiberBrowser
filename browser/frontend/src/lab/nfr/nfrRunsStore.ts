/** Completed Accessibility runs the read panels can draw (the NFR channel), by job id. Transient (not in sessions). */
import { create } from 'zustand';
import type { AccessibilityResult } from './api';

/** A completed Accessibility run the read panels can draw (its request says which datasets and region). */
export interface NfrRun {
  jobId: string;
  result: AccessibilityResult;
  datasetIds: string[];
  createdAt: number;
  /** The Find classes run whose footprint classes joined this run (its 'tf' elements), if any. */
  classJobId?: string | null;
}

interface NfrRunsStore {
  /** Completed Accessibility runs known to the read panels, by job id (the shown run is always among them). */
  nfrRuns: Record<string, NfrRun>;
  putNfrRun: (run: NfrRun) => void;
  dropNfrRuns: (keep?: (run: NfrRun) => boolean) => void;
  /** Bumped when runs should be looked up again (a run finished, a session was imported). */
  runsGeneration: number;
  bumpRuns: () => void;
}

export const useNfrRunsStore = create<NfrRunsStore>(set => ({
  nfrRuns: {},
  putNfrRun: run => set(state => (state.nfrRuns[run.jobId]?.result === run.result ? {} : { nfrRuns: { ...state.nfrRuns, [run.jobId]: run } })),
  dropNfrRuns: keep => set(state => ({ nfrRuns: keep ? Object.fromEntries(Object.entries(state.nfrRuns).filter(([, r]) => keep(r))) : {} })),
  runsGeneration: 0,
  bumpRuns: () => set(state => ({ runsGeneration: state.runsGeneration + 1 })),
}));
