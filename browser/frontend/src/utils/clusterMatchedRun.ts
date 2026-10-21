import type { BrowserState } from '../stores/browserStore';
import type { PanelConfig } from '../types';

/** A graph run's observation (features/graphPanel/graphCluster.ts): one (dataset, package path) fitted once. */
export interface GraphRunObservation {
  id: string;
  dataset_id: string;
  kind: 'graph' | 'linear';
  binding?: string;
  /** A graph observation's haplotype label (MAT, PAT, a strain's haplotype). */
  hap?: string;
  chrom?: string;
  genome?: string | null;
  lift_hap?: string;
  strand?: 'CT' | 'GA';
  read_ids?: string[];
  label: string;
}

/** The durable graph run (DESIGN_GRAPH_PRIMARY §3.5): what was clustered and the model as fitted. */
export interface GraphRunDefinition {
  schema: 1;
  registrationId: string;
  revisions: { package: string; graph: string; db: string; maps: string };
  target: string;
  hostPanelId: string;
  regions: { start: number; end: number; mode: string }[];
  options: Record<string, unknown>;
  observations: GraphRunObservation[];
  /** The staged model as fitted (server shapes): stage 1, then each refinement with its carrier set and parent. */
  stages: unknown[];
  labelIds: Record<string, number>;
  settings: Record<string, unknown>;
  columns?: unknown;
}

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
  /** A graph run: its definition and model; `windows` are then its observations (one column each in the charts). */
  graph?: GraphRunDefinition;
  /** A graph run's destinations: every panel that received an observation's labels (pop-outs add none). */
  destinations?: { stateKey: string; observations: string[]; panelId: string }[];
  /** Names of refined clusters (C<parent>.<j>). */
  names?: Record<number, string>;
}

/** The state keys a graph run's labels apply to now: its destinations, and any panel since opened on one of its
 * observations (a member popped out later, a new haplotype panel), so selection and focus sync reach them. */
export function graphRunStateKeys(run: ClusterMatchedRun, panels: readonly PanelConfig[]): string[] {
  const keys = new Set((run.destinations ?? []).map(d => d.stateKey));
  const obs = run.graph?.observations ?? [];
  for (const p of panels) {
    if (p.contentType !== 'dataset' || !p.datasetId) continue;
    const hap = (p.liftHap ?? p.readSubset?.rule.liftHap ?? '').toUpperCase();
    if (obs.some(o => o.dataset_id === p.datasetId && (o.strand ?? null) === (p.strand ?? null)
      && (o.kind === 'linear' ? (o.lift_hap ?? '').toUpperCase() === hap : !hap || (o.hap ?? '').toUpperCase() === hap))) {
      keys.add(p.stateKey ?? p.datasetId);
    }
  }
  return [...keys];
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
export function clusterSelectionKeys(state: Pick<BrowserState, 'clusterMatchedRun' | 'clusterAssignments'> & { panels?: PanelConfig[] }, key: string): string[] {
  const run = currentMatchedRun(state.clusterMatchedRun, state.clusterAssignments);
  if (run?.destinations) {
    const keys = graphRunStateKeys(run, state.panels ?? []);
    return keys.includes(key) ? keys : [key];
  }
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
