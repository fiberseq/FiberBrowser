import type { BrowserState } from '../stores/browserStore';

export interface ClusterMatchedRun {
  groups: string[];
  windows: { key: string; stateKey: string; panelId: string; datasetId?: string; label: string; genome: string | null }[];
  assignments: Record<string, Record<string, number>>;
  panelAssignments: Record<string, Record<string, number>>;
  windowNmi: number | null;
  referenceNmi: number | null;
  balancedFitReads: number;
  lengths: number[];
  details?: string;
}

/** A saved comparison stops driving charts as soon as its displayed assignments change. */
export function currentMatchedRun(run: ClusterMatchedRun | null, live: BrowserState['clusterAssignments']) {
  if (!run || !Array.isArray(run.windows) || !run.assignments || !run.panelAssignments) return null;
  return Object.entries(run.panelAssignments).every(([key, assignments]) => {
    const now = live[key];
    return now && Object.keys(now).length === Object.keys(assignments).length && Object.entries(assignments).every(([id, c]) => now[id] === c);
  }) ? run : null;
}

/** Cluster picks and focus share the state keys of the current comparison. */
export function clusterSelectionKeys(state: Pick<BrowserState, 'clusterMatchedRun' | 'clusterAssignments'>, key: string): string[] {
  const run = currentMatchedRun(state.clusterMatchedRun, state.clusterAssignments);
  return run?.windows.some(w => w.stateKey === key)
    ? [...new Set(run.windows.map(w => w.stateKey))] : [key];
}

/** Window columns include every copy, with the same denominators as ordinary composition charts. */
export function matchedRunCounts(run: ClusterMatchedRun) {
  const ids = [...new Set(Object.values(run.assignments).flatMap(a => Object.values(a)))].sort((a, b) => a - b);
  return ids.map(cluster => {
    const counts = run.windows.map(w => Object.values(run.assignments[w.key] ?? {}).filter(c => c === cluster).length);
    return { cluster, counts, totalCount: counts.reduce((a, b) => a + b, 0) };
  });
}
