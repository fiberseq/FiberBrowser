import type { BrowserState } from '../stores/browserStore';
import type { PanelConfig } from '../types';
import { qnameOfId, recordKey } from './recordKeys';

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
  destinations?: { stateKey: string; observations: string[]; panelId: string; scope?: string[] | null;
    /** 'qname': a linked source panel (P3) — its rows are the source BAM's records, named by QNAME. */
    keyBy?: 'qname' }[];
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

/** Whether a linked source panel (P3, `liftLink`) shows a graph observation's records on the haplotype's own
 * assembly (DESIGN_GRAPH_PRIMARY §4.2 "lifted path, source view": a destination of runs through its source rows,
 * which are the same records as the graph rows, named there by QNAME). */
export function linkedSourceShows(o: GraphRunObservation, p: PanelConfig): boolean {
  const link = (p as PanelConfig & { liftLink?: { datasetId: string; hap: string; hapLabel: string } }).liftLink;
  if (p.contentType !== 'dataset' || !link || o.kind !== 'graph' || o.dataset_id !== link.datasetId) return false;
  // A strand-split source panel (CT / GA) shows only that strand's records: never the other strand's observation.
  if (p.strand && o.strand && o.strand !== p.strand) return false;
  const hap = (o.hap ?? '').toUpperCase();
  return !hap || hap === (link.hapLabel ?? '').toUpperCase() || hap === (link.hap ?? '').toUpperCase();
}

/** The observations whose labels a linked source panel takes (Codex review, group H round 2): its own strand's when
 * the run split the path by strand, else the unsplit ones; an unsplit source panel takes the unsplit observation when
 * there is one (both strands' records are then in it), else every strand's. So one QNAME never takes another
 * strand's label. */
export function linkedSourceObservations<T extends GraphRunObservation>(observations: readonly T[], p: PanelConfig): T[] {
  const shown = observations.filter(o => linkedSourceShows(o, p));
  const want = (p.strand === 'CT' || p.strand === 'GA') ? p.strand : null;
  const exact = shown.filter(o => (o.strand ?? null) === want);
  return exact.length ? exact : shown;
}

/** The state keys a graph run's labels apply to now: its destinations, and any panel since opened on one of its
 * observations (a member popped out later, a new haplotype panel), so selection and focus sync reach them. */
export function graphRunStateKeys(run: ClusterMatchedRun, panels: readonly PanelConfig[], mainChrom?: string,
  live?: Readonly<Record<string, Readonly<Record<string, number>>>>): string[] {
  const keys = new Set((run.destinations ?? []).map(d => d.stateKey));
  const obs = run.graph?.observations ?? [];
  const contig = run.graph?.targetContig;
  for (const p of panels) {
    if (p.contentType !== 'dataset' || !p.datasetId) continue;
    // On the run's target contig (its own view, else the main view's).
    const chrom = p.viewportOverride?.chrom ?? mainChrom;
    // A linked source panel is on the haplotype's own assembly (another contig): it joins through its link.
    const source = linkedSourceObservations(obs, p);
    if (source.length) {
      const key = p.stateKey ?? p.datasetId;
      if (!keys.has(key) && !compatibleSourceLabels(run, live?.[key], source.map(o => o.id))) continue;
      keys.add(key);
      continue;
    }
    if (contig && chrom && chrom !== contig) continue;
    if (!obs.some(o => observationShownBy(o, p))) continue;
    const key = p.stateKey ?? p.datasetId;
    // A later panel joins only while its labels are this run's (review G5): an independently clustered panel of the
    // same path keeps its own clusters, selection and focus.
    if (!keys.has(key) && !compatibleLabels(run, live?.[key], p.datasetId)) continue;
    keys.add(key);
  }
  return [...keys];
}

/** A linked source panel's labels (by QNAME) agree with what the run gave those observations' records. */
export function compatibleSourceLabels(run: ClusterMatchedRun, labels: Readonly<Record<string, number>> | undefined, observations: string[]): boolean {
  if (!labels || !Object.keys(labels).length) return true;
  const want = sourceLabels(run, observations);
  return Object.entries(labels).every(([q, c]) => want[q] === c);
}

/** The run's labels for these observations keyed by QNAME, as a linked source panel names its records: a fitted
 * label over another record's "not a carrier" (-2), else the smallest id's (deterministic). */
export function sourceLabels(run: Pick<ClusterMatchedRun, 'assignments'>, observations: readonly string[],
  scope?: ReadonlySet<string> | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const oid of observations) {
    for (const [id, c] of Object.entries(run.assignments?.[oid] ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const q = qnameOfId(id);
      if (scope && !scope.has(q)) continue;
      const prev = out[q];
      if (prev === undefined || (prev < 0 && c >= 0)) out[q] = c;
    }
  }
  return out;
}

const runLabelIndex = new WeakMap<object, Map<string, Map<string, Set<number>>>>();

/** Whether a panel's labels agree with a graph run's, for its own dataset, for every record both label (none:
 * compatible). A record labelled on two paths (one placement on each) may carry a label per path: a panel agrees with
 * any of them (backfill review: the second path's label overwrote the first's). */
function compatibleLabels(run: ClusterMatchedRun, labels: Readonly<Record<string, number>> | undefined, datasetId: string): boolean {
  if (!labels) return true;
  let byDataset = runLabelIndex.get(run);
  if (!byDataset) {
    byDataset = new Map();
    const obs = new Map((run.graph?.observations ?? []).map(o => [o.id, o.dataset_id]));
    const add = (ds: string, id: string, c: number) => {
      const index = byDataset!.get(ds) ?? new Map<string, Set<number>>();
      const key = recordKey(id) ?? id;
      (index.get(key) ?? index.set(key, new Set()).get(key)!).add(c);
      byDataset!.set(ds, index);
    };
    // Every row the run labelled (its observations' results), then what its destinations show.
    for (const [oid, map] of Object.entries(run.assignments ?? {})) {
      const ds = obs.get(oid);
      if (!ds) continue;
      for (const [id, c] of Object.entries(map ?? {})) add(ds, id, c);
    }
    for (const d of run.destinations ?? []) {
      const ds = obs.get(d.observations[0]);
      if (!ds) continue;
      for (const [id, c] of Object.entries(run.panelAssignments?.[d.stateKey] ?? {})) add(ds, id, c);
    }
    runLabelIndex.set(run, byDataset);
  }
  const index = byDataset.get(datasetId) ?? new Map<string, Set<number>>();
  for (const [id, c] of Object.entries(labels)) {
    const want = index.get(recordKey(id) ?? id);
    if (!want || !want.has(c)) return false;
  }
  return true;
}

/** A saved comparison stops driving charts as soon as its displayed assignments change. */
export function currentMatchedRun(run: ClusterMatchedRun | null, live: BrowserState['clusterAssignments']) {
  if (!run || !Array.isArray(run.windows) || !run.assignments || !run.panelAssignments) return null;
  // A run that labelled nothing is never current (agy G7 review: it matched an empty workspace forever).
  if (!Object.values(run.panelAssignments).some(a => Object.keys(a ?? {}).length)) return null;
  return Object.entries(run.panelAssignments).every(([key, assignments]) => {
    const now = live[key];
    // A destination that received no labels matches an absent or empty map alike (a refinement drops empty maps).
    if (!Object.keys(assignments ?? {}).length) return !now || !Object.keys(now).length;
    return now && Object.keys(now).length === Object.keys(assignments).length && Object.entries(assignments).every(([id, c]) => now[id] === c);
  }) ? run : null;
}

/** Cluster picks and focus share the state keys of the current comparison. */
export function clusterSelectionKeys(state: Pick<BrowserState, 'clusterMatchedRun' | 'clusterAssignments'> & { panels?: PanelConfig[] }, key: string): string[] {
  const run = currentMatchedRun(state.clusterMatchedRun, state.clusterAssignments);
  if (run?.destinations) {
    const keys = graphRunStateKeys(run, state.panels ?? [], (state as { chrom?: string }).chrom, state.clusterAssignments);
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

/** Source pop-outs are chart destinations too. Their QNAME labels form a separate displayed column without
 * adding observations, refitting, or changing the persisted run/model. A source clustered independently stays out. */
export function withGraphSourceColumns(run: ClusterMatchedRun | null, panels: readonly PanelConfig[],
  live: BrowserState['clusterAssignments']): ClusterMatchedRun | null {
  if (!run?.graph) return run;
  const windows = [...run.windows];
  const assignments = { ...run.assignments };
  for (const p of panels) {
    if (p.collapsed || p.collapsedByGraphGroup || !p.liftLink) continue;
    const observations = linkedSourceObservations(run.graph.observations, p);
    if (!observations.length) continue;
    const stateKey = p.stateKey ?? p.datasetId ?? p.id;
    const labels = live[stateKey];
    if (!labels || !Object.keys(labels).length || !compatibleSourceLabels(run, labels, observations.map(o => o.id))) continue;
    const key = `source:${p.id}`;
    if (windows.some(w => w.key === key)) continue;
    windows.push({ key, stateKey, panelId: p.id, datasetId: p.datasetId ?? undefined, label: p.title || `${observations.map(o => o.label).join(' / ')} source`,
      genome: p.genome ?? null });
    assignments[key] = labels;
  }
  return windows.length === run.windows.length ? run : { ...run, windows, assignments };
}
