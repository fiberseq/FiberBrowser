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
  /** The target binding's contig (the reference a linear panel of the run's observations is on). */
  targetContig?: string;
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
  destinations?: { stateKey: string; observations: string[]; panelId: string; scope?: string[] | null }[];
  /** Names of refined clusters (C<parent>.<j>). */
  names?: Record<number, string>;
  /** A graph run: the cluster tree node its labels are (dynamic assignment applies only while it is active). */
  treeNodeId?: string | null;
}

/** Whether a panel shows an observation's rows: its dataset, haplotype and strand, on the main reference (not a
 * linked source panel, an alternative allele, another assembly). */
export function observationShownBy(o: GraphRunObservation, p: PanelConfig): boolean {
  if (p.contentType !== 'dataset' || p.datasetId !== o.dataset_id || p.genome || p.liftLink || p.altAllele) return false;
  if ((o.strand ?? null) !== (p.strand ?? null)) return false;
  const hap = (p.liftHap ?? p.readSubset?.rule.liftHap ?? '').toUpperCase();
  return o.kind === 'linear' ? (o.lift_hap ?? '').toUpperCase() === hap : !hap || (o.hap ?? '').toUpperCase() === hap;
}

/** The state keys a graph run's labels apply to now: its destinations, and any panel since opened on one of its
 * observations (a member popped out later, a new haplotype panel), so selection and focus sync reach them. */
export function graphRunStateKeys(run: ClusterMatchedRun, panels: readonly PanelConfig[], mainChrom?: string): string[] {
  const keys = new Set((run.destinations ?? []).map(d => d.stateKey));
  const obs = run.graph?.observations ?? [];
  const contig = run.graph?.targetContig;
  for (const p of panels) {
    if (p.contentType !== 'dataset' || !p.datasetId) continue;
    // On the run's target contig (its own view, else the main view's).
    const chrom = p.viewportOverride?.chrom ?? mainChrom;
    if (contig && chrom && chrom !== contig) continue;
    if (obs.some(o => observationShownBy(o, p))) keys.add(p.stateKey ?? p.datasetId);
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
    const keys = graphRunStateKeys(run, state.panels ?? [], (state as { chrom?: string }).chrom);
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
