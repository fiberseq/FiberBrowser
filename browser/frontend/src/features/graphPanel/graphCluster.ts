/**
 * Cluster on graph columns (DESIGN_GRAPH_PRIMARY §3.4–3.5; graph primary G4/G5).
 *
 * When a graph host is drawing its graph, the toolbar's Cluster (every dataset panel in view, narrowed by "Applies
 * to") clusters on graph node columns at the selected peaks' target spans:
 *
 * - **Canonical observations.** The run's panels are grouped by (dataset, package path, strand, dataset revision):
 *   a lifted dataset's haplotype is one graph observation whichever panels show it — the host, a folded member, a
 *   popped-out member, a linear lifted panel elsewhere — and a native dataset on the target is one linear observation.
 *   Each observation is fitted once (`POST /api/graph/cluster`), with the union of its destinations' read scopes.
 * - **Destinations.** Every panel showing an observation receives its labels, intersected with its own read scope and
 *   keyed by record key (a lifted row's molecule, QNAME and record), so a graph row and the linear rows of the same
 *   record read the same label. Pop-outs add no observations: revealing or folding a member never changes the fit.
 * - **Stages.** Stage 1 on the shared features; carrier-only features (an insertion only some paths carry, a deleted
 *   stretch) refine each cluster's carriers into C<i>.<j> in one child tree node (`refineWithinCarriers`):
 *   non-carriers keep their stage-1 label.
 * - **The durable run** (`ClusterMatchedRun.graph`): regions, options, observations and destinations, the staged
 *   model as fitted with its settings snapshot and package revisions, saved in history and sessions. Dynamic
 *   assignment (`POST /api/graph/cluster/assign`) labels rows the fit did not (e.g. beyond the sample cap) with
 *   that model; the server refuses a changed geometry or snapshot ("settings or geometry changed: cluster again").
 */
import { useBrowserStore, getTargetDatasetIds } from '../../stores/browserStore';
import type { BrowserState } from '../../stores/browserStore';
import type { PanelConfig } from '../../types';
import { clusterWindows, type ClusterBasis, type ClusterTargetPlan, type PlanState } from '../../utils/clusterTargets';
import { registerClusterBasisRunner, registerClusterPlanTransform } from '../../utils/clusterRunExtensions';
import { currentMatchedRun, graphRunStateKeys, observationShownBy, type ClusterMatchedRun, type GraphRunObservation } from '../../utils/clusterMatchedRun';
import { sameChrom } from '../../utils/chromAliases';
import { getDatasetDisplayLabel } from '../../utils/datasetLabels';
import { idSetHas, qnameOfId, recordKey } from '../../utils/recordKeys';
import { seedHistoryBaseline } from '../../stores/historySlice';
import { useRunResultStore } from '../../stores/runResultStore';
import { sortStateStillCurrent } from '../../utils/sortScope';
import { NOT_CARRIER_CLUSTER_ID, UNASSIGNED_CLUSTER_ID } from '../../components/tracks/read-track/constants';
import { isHost, hostOf, membersOf } from './hostMode';
import { hostShowsGraph } from './hostHeader';
import { useGraphBindingsStore } from './bindingsStore';
import { useGraphStatusStore } from './statusStore';
import type { GraphRegistration, GraphRevisions } from './types';

export type GraphObservationSpec = GraphRunObservation;

export interface GraphDestination { stateKey: string; observations: string[]; panelId: string; scope: string[] | null }

export interface GraphClusterPlan {
  host: PanelConfig;
  registration: GraphRegistration;
  target: string;
  targetContig: string;
  regions: { start: number; end: number; mode: string }[];
  observations: GraphObservationSpec[];
  destinations: GraphDestination[];
  leftOut: { panelId: string; reason: string }[];
  offContig: number;
  refusal: string | null;
}

/** A stable short hash (FNV-1a, 52 bits) of a JSON value: observation ids that never depend on panel order. */
export function stableId(value: unknown): string {
  const text = JSON.stringify(value);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${(h2 & 0xfffff).toString(16).padStart(5, '0')}`;
}

/** Whether a host draws its graph now (shown, not handed off to linear). */
export function hostDrawsGraph(p: PanelConfig): boolean {
  return isHost(p) && !p.collapsed && hostShowsGraph(p) && Boolean(p.graphView?.registrationId && p.graphView?.targetBinding);
}

type Basis = Pick<ClusterBasis, 'kind' | 'regions'>;

/**
 * The graph run the Cluster button would start (null: no host drawing its graph is in the run, or the basis is not
 * regions on its target; the run is then linear as before).
 */
export function graphClusterPlan(st: PlanState, basis: Basis): GraphClusterPlan | null {
  // ('graph': the plan transform's own basis, as the runner receives it.)
  if (basis.kind !== 'peaks' && basis.kind !== 'feature-regions' && (basis.kind as string) !== 'graph') return null;
  const explicit = st.selectedDatasets.size > 0;
  const hosts = st.panels.filter(p => hostDrawsGraph(p) && (!explicit || st.selectedDatasets.has(p.id)
    || st.panels.some(m => m.graphMemberOf === p.id && st.selectedDatasets.has(m.id))));
  // The host whose package's target is the regions' contig (Codex review, group B: the first host in panel order
  // could be on another contig); among those, one that follows the main view, then panel order.
  const registrations = useGraphStatusStore.getState().status?.registrations ?? [];
  const contigOf = (h: PanelConfig) => registrations.find(r => r.id === h.graphView?.registrationId)?.bindings
    .find(b => b.key === h.graphView?.targetBinding)?.path.contig;
  const chroms = basis.regions.map(p => p.chrom ?? st.chrom);
  const eligible = hosts.filter(h => { const c = contigOf(h); return Boolean(c) && chroms.some(rc => sameChrom(rc, c!)); });
  const host = [...eligible].sort((a, b) => (a.viewportOverride ? 1 : 0) - (b.viewportOverride ? 1 : 0))[0] ?? hosts[0];
  if (!host) return null;
  const gv = host.graphView!;
  const registration = registrations.find(r => r.id === gv.registrationId);
  if (!registration) return null;
  const target = gv.targetBinding!;
  const targetContig = registration.bindings.find(b => b.key === target)?.path.contig;
  if (!targetContig) return null;
  const onTarget = basis.regions.filter(p => sameChrom(p.chrom ?? st.chrom, targetContig) && !p.genome);
  if (!onTarget.length) return null;
  const regions = onTarget.map(p => ({ start: p.start, end: p.end, mode: p.mode || 'accessibility' }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  // A targeted host targets every member, folded or popped out (review G4: revealing a member must keep it in the
  // run); clusterWindows alone inherits the host's selection only while a member is folded.
  let selected = st.selectedDatasets;
  if (explicit) {
    selected = new Set(st.selectedDatasets);
    // (A targeted member targets its graph too: the host and its members are one comparison.)
    for (const h of hosts) for (const m of membersOf(st.panels, h)) selected.add(m.panel.id);
  }
  const planState = selected === st.selectedDatasets ? st : { ...st, selectedDatasets: selected };
  const datasetIds = getTargetDatasetIds(selected, st.panels, st.datasets);
  const windows = clusterWindows(planState, datasetIds);
  const bindings = useGraphBindingsStore.getState().byDataset;
  const sources = new Set(registration.maps.filter(m => m.target === target).map(m => m.source));
  const observations = new Map<string, GraphObservationSpec & { scopes: (string[] | null)[] }>();
  const destinations: GraphDestination[] = [];
  const leftOut: { panelId: string; reason: string }[] = [];
  for (const w of windows) {
    const panel = w.panel;
    const ds = st.datasets.find(d => d.id === w.dataset_id);
    const name = ds ? getDatasetDisplayLabel(ds) : w.dataset_id;
    const bound = (bindings[w.dataset_id] ?? []).find(b => b.registration.id === registration.id)?.binding;
    const ids: string[] = [];
    const add = (spec: Omit<GraphObservationSpec, 'id'>) => {
      const id = `obs-${stableId([spec.dataset_id, spec.kind, spec.binding ?? null, spec.lift_hap ?? null, spec.strand ?? null,
        bound?.revision ?? null])}`;
      const have = observations.get(id);
      if (have) have.scopes.push(w.read_ids ?? null);
      else observations.set(id, { ...spec, id, scopes: [w.read_ids ?? null] });
      ids.push(id);
    };
    const onTarget = !panel.genome && !panel.altAllele && !panel.liftLink && sameChrom(w.chrom, targetContig);
    // A panel at another locus of the target (its own view, not over any region) is not in this run (agy review).
    if (onTarget && !regions.some(r => w.start < r.end && w.end > r.start)) {
      leftOut.push({ panelId: panel.id, reason: 'at another locus of the graph\'s target' });
      continue;
    }
    if (bound?.kind === 'lifted' && !onTarget) {
      leftOut.push({ panelId: panel.id, reason: 'not on the graph\'s target (another contig, assembly or allele view)' });
      continue;
    }
    if (bound?.kind === 'lifted') {
      const hap = (w.lift_hap ?? '').toUpperCase();
      const keys = Object.keys(bound.paths).filter(k => sources.has(k) && (!hap || (bound.haps?.[k] ?? '').toUpperCase() === hap)).sort();
      if (!keys.length) { leftOut.push({ panelId: panel.id, reason: 'its haplotype has no path compared with this graph\'s target' }); continue; }
      for (const k of keys) add({ dataset_id: w.dataset_id, kind: 'graph', binding: k, ...(bound.haps?.[k] ? { hap: bound.haps[k] } : {}),
        ...(w.strand ? { strand: w.strand } : {}),
        label: `${bound.haps?.[k] ?? k} · ${name}` });
    } else if (!panel.genome && sameChrom(w.chrom, targetContig) && !panel.altAllele && !panel.liftLink) {
      // A native dataset (or a lifted one no package binds) on the target: identity blocks on target-aliased columns.
      add({ dataset_id: w.dataset_id, kind: 'linear', chrom: targetContig, genome: null,
        ...(w.lift_hap ? { lift_hap: w.lift_hap } : {}), ...(w.strand ? { strand: w.strand } : {}),
        label: `${w.lift_hap ? `${w.lift_hap} · ` : ''}${name}` });
    } else {
      leftOut.push({ panelId: panel.id, reason: 'not on the graph\'s target or one of its paths' });
      continue;
    }
    destinations.push({ stateKey: w.result_key, observations: ids, panelId: panel.id, scope: w.read_ids ?? null });
  }
  const obs = [...observations.values()].map(({ scopes, ...o }) => {
    // The union of the destinations' id scopes (one fit per row); any destination with every read: every read.
    if (scopes.some(s => s === null)) return o;
    return { ...o, read_ids: [...new Set(scopes.flat() as string[])].sort() };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const refusal = !obs.length ? 'No panel in this run shows reads on the graph\'s target or paths.'
    : obs.every(o => o.read_ids && !o.read_ids.length) ? 'No reads pass the read filters, so there is nothing to cluster. Clear a filter to cluster.'
      : null;
  return { host, registration, target, targetContig, regions, observations: obs, destinations, leftOut,
    offContig: basis.regions.length - onTarget.length, refusal };
}

// ── Fan-out ──────────────────────────────────────────────────────────────────

/** A destination's labels: its observations' rows inside its own read scope, keyed by record key (lifted) or id. */
export function destinationAssignments(dest: GraphDestination, results: Record<string, { assignments?: Record<string, number> }>): Record<string, number> {
  const scope = dest.scope ? new Set(dest.scope) : null;
  const out: Record<string, number> = {};
  for (const oid of dest.observations) {
    for (const [id, label] of Object.entries(results[oid]?.assignments ?? {})) {
      const rk = recordKey(id);
      if (scope && !idSetHas(scope, [id, qnameOfId(id)], rk)) continue;
      // A record a fitted observation labelled keeps that label over another path's "not a carrier".
      if (label === NOT_CARRIER_CLUSTER_ID && (out[rk ?? id] ?? -1) >= 0) continue;
      out[rk ?? id] = label;
    }
  }
  return out;
}

// ── The run ──────────────────────────────────────────────────────────────────

interface GraphClusterResponse {
  results: Record<string, { assignments?: Record<string, number>; stage1?: Record<string, number>; left_out?: string;
    eligible_read_count?: number; peak_covering_read_count?: number; analysis_read_count?: number }>;
  label_ids: Record<string, number>;
  names: Record<string, string>;
  stages: unknown[];
  columns: { shared: { kind: string; length: number; samples: number; label: string }[];
    carrier_sets: { carriers: string[]; features: { kind: string; length: number; samples: number; label: string }[] }[];
    left_out: Record<string, string>; dropped: { kind: string; reason: string }[]; refinements: unknown[] };
  window_separation_nmi: number | null;
  matched: { lengths: number[]; balanced: boolean; balanced_fit_reads: number; fit_reads: number } | null;
  settings: Record<string, unknown>;
  revisions: GraphRevisions;
  options: Record<string, unknown>;
  timings: Record<string, number>;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body) });
  const text = await response.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!response.ok) throw new Error(json?.error?.message ?? json?.detail ?? (text.slice(0, 200) || response.statusText));
  return json as T;
}

const wire = (o: GraphObservationSpec) => {
  const { label: _label, hap: _hap, ...rest } = o;
  return rest;
};

/** What a run's commit checks has not changed since it started (review G4: a response must not land on another
 * locus, reference, dataset set or graph). */
function runIdentity(s: BrowserState, plan: Pick<GraphClusterPlan, 'host' | 'registration' | 'target'>): string {
  const host = s.panels.find(p => p.id === plan.host.id);
  // Datasets with their revisions and settings (a cohort change: refreshGeneration), and the registration as it is
  // registered now (a refreshed package under the same id).
  const bindings = useGraphBindingsStore.getState().byDataset;
  const reg = useGraphStatusStore.getState().status?.registrations.find(r => r.id === plan.registration.id);
  return JSON.stringify([s.chrom, s.currentGenome ?? null, s.refreshGeneration ?? 0,
    s.datasets.map(d => [d.id, bindings[d.id]?.map(b => b.binding.revision) ?? null, JSON.stringify(d)]).sort(),
    host ? hostDrawsGraph(host) : false, host?.graphView?.registrationId ?? null, host?.graphView?.targetBinding ?? null,
    reg?.revisions ?? null]);
}

export function graphRequestBody(s: BrowserState, plan: Pick<GraphClusterPlan, 'registration' | 'target' | 'regions' | 'observations'>) {
  return {
    registration_id: plan.registration.id, revisions: plan.registration.revisions, target: plan.target,
    regions: plan.regions, observations: plan.observations.map(wire),
    method: s.clusterMethod, k: s.clusterK, max_reads: s.analysisSampleCount ?? null, sample_seed: s.analysisSampleSeed,
    subnucleosomal_threshold: s.subnucleosomalThreshold, accessibility_threshold: s.accessibilityThreshold,
    cluster_feature_rules: s.clusterFeatureRules, resolution: s.clusterResolution, balance_windows: true,
    options: { carrier_features: 'refine', repeat_columns: 'exclude', coverage_rule: 'require_all' },
  };
}

export async function runGraphCluster(s: BrowserState, basis: ClusterBasis,
  report: (tone: 'error' | 'note' | 'done', text: string, panelIds?: string[]) => void): Promise<void> {
  const plan = graphClusterPlan(s, basis);
  if (!plan) throw new Error('No graph host is drawing its graph here: cluster again.');
  if (plan.refusal) throw new Error(plan.refusal);
  const runNumber = useRunResultStore.getState().runs.cluster;
  const identity = runIdentity(s, plan);
  const response = await post<GraphClusterResponse>('/api/graph/cluster', graphRequestBody(s, plan));
  const now = useBrowserStore.getState();
  if (runNumber !== useRunResultStore.getState().runs.cluster) return;
  if (runIdentity(now, plan) !== identity)
    throw new Error('The view, its datasets or the graph changed while clustering. Cluster again here.');
  if (plan.destinations.some(d => !sortStateStillCurrent(s, now, d.stateKey)) || now.activeClusterTreeNodeId !== s.activeClusterTreeNodeId)
    throw new Error('The filters, branch or clusters changed while clustering. Cluster again here.');
  commitGraphRun(s, plan, response);
  const total = Object.values(response.results).reduce((n, r) => n + Object.values(r.assignments ?? {}).filter(c => c !== NOT_CARRIER_CLUSTER_ID).length, 0);
  const notCarriers = Object.values(response.results).reduce((n, r) => n + Object.values(r.assignments ?? {}).filter(c => c === NOT_CARRIER_CLUSTER_ID).length, 0);
  const names = Object.keys(response.names ?? {}).length;
  const left = Object.keys(response.columns.left_out ?? {}).length + plan.leftOut.length;
  const shared = response.columns.shared.length;
  const text = total
    ? `Clustered ${total.toLocaleString()} reads of ${plan.observations.length} path${plan.observations.length === 1 ? '' : 's'} on graph columns (${shared} shared feature${shared === 1 ? '' : 's'}${names ? `, ${names} refined within carriers` : ''}).`
      + (notCarriers ? ` ${notCarriers.toLocaleString()} read${notCarriers === 1 ? '' : 's'} of paths without the regions' sequence shown as Not a carrier.` : '')
      + (left ? ` ${left} left out; see Cluster detail.` : '')
    : 'No reads covered the selected regions on every path. Check the regions and filters.';
  report(!total ? 'error' : left ? 'note' : 'done', text, plan.destinations.map(d => d.panelId));
}

/** Path-specific parts in a sentence: "2,353 bp of insertion (9 parts, 236 samples)". */
function partsText(features: { kind: string; length: number; samples: number }[]): string {
  const kinds = [...new Set(features.map(f => (f.kind === 'deleted' ? 'deleted stretch' : f.kind)))];
  const bp = features.reduce((n, f) => n + f.length, 0);
  const samples = features.reduce((n, f) => n + f.samples, 0);
  return `${bp.toLocaleString()} bp of ${kinds.join(' and ')}${features.length > 1 ? ` (${features.length} parts, ${samples} samples)` : ` (${samples} samples)`}`;
}

/**
 * The run's refined names (C<parent>.<j>) on these panels, in the live labels and on the active cluster tree node, so
 * a branch switch and back keeps them (backfill review B10: the node held none for a subcluster run or for panels
 * labelled later).
 */
function mirrorGroupLabels(keys: readonly string[], names: Readonly<Record<number, string>>): void {
  useBrowserStore.setState(st => {
    const add = Object.fromEntries(keys.map(k => [k, { ...(st.clusterGroupLabels?.[k] ?? {}), ...names }]));
    const id = st.activeClusterTreeNodeId;
    const node = id ? st.clusterTreeNodes[id] : null;
    return {
      clusterGroupLabels: { ...st.clusterGroupLabels, ...add },
      ...(node && id ? { clusterTreeNodes: { ...st.clusterTreeNodes, [id]: { ...node,
        groupLabels: { ...(node.groupLabels ?? {}), ...Object.fromEntries(keys.map(k => [k, { ...(node.groupLabels?.[k] ?? {}), ...names }])) } } } } : {}),
    };
  });
}

/** Write a graph run's labels to every destination, as one undo step, and record the durable run. */
export function commitGraphRun(s: BrowserState, plan: GraphClusterPlan, response: GraphClusterResponse): void {
  const now = useBrowserStore.getState();
  seedHistoryBaseline(now, 'Before clustering', 'clustering');
  const stage1Results = Object.fromEntries(Object.entries(response.results).map(([k, r]) => [k, { assignments: r.stage1 ?? r.assignments }]));
  const finalBy: Record<string, Record<string, number>> = {};
  const stage1By: Record<string, Record<string, number>> = {};
  for (const d of plan.destinations) {
    finalBy[d.stateKey] = { ...(finalBy[d.stateKey] ?? {}), ...destinationAssignments(d, response.results) };
    stage1By[d.stateKey] = { ...(stage1By[d.stateKey] ?? {}), ...destinationAssignments(d, stage1Results) };
  }
  const refined = Object.keys(response.names ?? {}).length > 0;
  const sourceClusterIds = [...new Set(plan.destinations.flatMap(d => [...(s.selectedClusters[d.stateKey]?.size
    ? s.selectedClusters[d.stateKey] : s.clusterFocus[d.stateKey] ?? [])]))].sort((a, b) => a - b);
  if (sourceClusterIds.length) {
    if (!now.activeClusterTreeNodeId) now.captureActiveClusterTreeNode({ name: 'All reads' });
    // The parent's rows by their own identities too (review G4): a linear run's analysis_id of a record the graph run
    // labelled takes that record's label, so commitSubcluster never shadows it with Unassigned.
    const withParentIds: Record<string, Record<string, number>> = {};
    for (const [key, labels] of Object.entries(finalBy)) {
      const out = { ...labels };
      for (const id of Object.keys(now.clusterAssignments[key] ?? {})) {
        const label = labels[recordKey(id) ?? id];
        if (label !== undefined) out[id] = label;
      }
      withParentIds[key] = out;
    }
    now.commitSubcluster(withParentIds, { sourceClusterIds, sourceLabel: `from ${sourceClusterIds.map(c => `C${c}`).join('+')}`,
      name: 'Subcluster on graph columns', readScope: Object.fromEntries(Object.keys(withParentIds).map(k => [k, Object.keys(withParentIds[k])])) });
  } else {
    // A run started on a refinement node replaces that refinement (its parent is the run's stage-1 node).
    const active = now.activeClusterTreeNodeId ? now.clusterTreeNodes[now.activeClusterTreeNodeId] : null;
    if (active?.refinement && active.parentId) {
      const old = active.id;
      useBrowserStore.setState({ activeClusterTreeNodeId: active.parentId });
      useBrowserStore.getState().deleteClusterTreeNode(old);
      useBrowserStore.setState({ activeClusterTreeNodeId: active.parentId });
    }
    for (const [key, value] of Object.entries(stage1By)) now.setClusterAssignments(key, value);
    if (now.activeClusterTreeNodeId) now.syncActiveClusterTreeNode(); else now.captureActiveClusterTreeNode({ name: 'All reads' });
    if (refined) {
      const changed: Record<string, Record<string, number>> = {};
      for (const [key, value] of Object.entries(finalBy)) {
        changed[key] = Object.fromEntries(Object.entries(value).filter(([id, c]) => stage1By[key]?.[id] !== c));
      }
      const names = Object.fromEntries(Object.entries(response.names ?? {}).map(([k, v]) => [Number(k), v]));
      useBrowserStore.getState().refineWithinCarriers(changed, { name: 'Refined within carriers',
        sourceLabel: 'carrier-only graph features', groupLabels: Object.fromEntries(Object.keys(finalBy).map(k => [k, names])) });
    }
  }
  const after = useBrowserStore.getState();
  after.setDynamicClustering(false);
  after.setClusterPatterns({}); after.setClusterCentroids({}, []); after.setClusterWindowPeaks(null); after.setClusterPeakRegions([]);
  const names = Object.fromEntries(Object.entries(response.names ?? {}).map(([k, v]) => [Number(k), v]));
  if (Object.keys(names).length) mirrorGroupLabels(Object.keys(finalBy), names);
  const live = useBrowserStore.getState().clusterAssignments;
  const obsLabel = new Map(plan.observations.map(o => [o.id, o]));
  const firstDest = (oid: string) => plan.destinations.find(d => d.observations.includes(oid));
  const assignments = Object.fromEntries(Object.entries(response.results).map(([k, r]) => [k, r.assignments ?? {}]));
  const run: ClusterMatchedRun = {
    groups: ['graph'],
    windows: plan.observations.map(o => ({ key: o.id, stateKey: firstDest(o.id)?.stateKey ?? o.id, panelId: firstDest(o.id)?.panelId ?? '',
      datasetId: o.dataset_id, label: obsLabel.get(o.id)!.label, genome: null })),
    assignments,
    panelAssignments: Object.fromEntries(Object.keys(finalBy).map(k => [k, live[k] ?? {}])),
    windowNmi: response.window_separation_nmi, referenceNmi: null,
    balancedFitReads: response.matched?.balanced_fit_reads ?? 0, lengths: response.matched?.lengths ?? [],
    graph: {
      schema: 1, registrationId: plan.registration.id, revisions: response.revisions, target: plan.target,
      hostPanelId: plan.host.id, regions: plan.regions, options: response.options, observations: plan.observations,
      stages: response.stages, labelIds: response.label_ids, settings: response.settings,
      columns: { shared: response.columns.shared, carrier_sets: response.columns.carrier_sets, dropped: response.columns.dropped,
        left_out: response.columns.left_out },
    },
    destinations: plan.destinations.map(d => ({ stateKey: d.stateKey, observations: d.observations, panelId: d.panelId, scope: d.scope })),
    names,
  };
  run.graph!.targetContig = plan.targetContig;
  const c = response.columns;
  const notCarrierObs = Object.entries(response.results).filter(([, r]) => (r as { not_carrier?: boolean }).not_carrier)
    .map(([oid, r]) => `${obsLabel.get(oid)?.label ?? oid} (${Object.keys(r.assignments ?? {}).length})`);
  // Observations the run left out on its own (a path carrying only a later carrier set's sequence, no covering
  // reads), besides the plan's (Codex review, group B).
  const resultLeftOut = Object.entries(response.results).filter(([oid, r]) => r.left_out && !(r as { not_carrier?: boolean }).not_carrier
    && !(oid in (c.left_out ?? {}))).map(([oid, r]) => `${obsLabel.get(oid)?.label ?? oid}: ${r.left_out}`);
  const leftOut = [...resultLeftOut, ...Object.entries(c.left_out ?? {}).map(([oid, why]) => `${obsLabel.get(oid)?.label ?? oid}: ${why}`),
    ...plan.leftOut.map(l => `${l.reason}`)];
  run.details = `Clustered on graph node columns at ${plan.regions.length} region${plan.regions.length === 1 ? '' : 's'} of ${plan.target}: `
    + `${c.shared.filter(f => f.kind === 'target').map(f => `target ${f.label} (${f.samples} samples)`).join('; ')}`
    + `${c.shared.some(f => f.kind !== 'target') ? `; ${partsText(c.shared.filter(f => f.kind !== 'target'))} every path carries` : ''}. `
    + (c.carrier_sets.length && !c.shared.length
      // No sequence every path shares: the first carrier set's carriers are fitted on it (stage 1); refinements of
      // later sets apply only to those carriers (Codex review, group B: details named every set as refined).
      ? `No sequence every path shares: fitted ${partsText(c.carrier_sets[0].features)} on its carriers (${c.carrier_sets[0].carriers.map(o => obsLabel.get(o)?.label ?? o).join(', ')}). `
        + (c.carrier_sets.length > 1 ? `Refined within those carriers on ${c.carrier_sets.slice(1).map(cs => partsText(cs.features)).join('; ')}. ` : '')
      : c.carrier_sets.length ? `Refined within carriers on ${c.carrier_sets.map(cs => `${partsText(cs.features)} (${cs.carriers.map(o => obsLabel.get(o)?.label ?? o).join(', ')})`).join('; ')}; non-carriers keep their labels. ` : '')
    + (c.dropped?.length ? `${c.dropped.length} small path-specific part${c.dropped.length === 1 ? '' : 's'} not used. ` : '')
    + (leftOut.length ? `Left out: ${leftOut.join('; ')}. ` : '')
    + (notCarrierObs.length ? `Not a carrier (shown, not fitted): ${notCarrierObs.join('; ')}. ` : '')
    + (plan.offContig ? `${plan.offContig} selected region${plan.offContig === 1 ? ' is' : 's are'} not on the graph's target and were not used. ` : '')
    + `Each path in the run is fitted once${resultLeftOut.length ? ' (the paths left out are not)' : ''}; pop-outs and other panels of the same path show the same labels.`;
  // The tree node its labels are (dynamic assignment applies only while it is the active node).
  run.treeNodeId = useBrowserStore.getState().activeClusterTreeNodeId ?? null;
  useBrowserStore.setState({ clusterMatchedRun: run });
  useBrowserStore.getState().pushSnapshot('Cluster on graph columns');
}

// ── Dynamic assignment with the durable model (G5) ─────────────────────────────

/** Label rows of the run's observations that have no label yet, with the run's model (never refitting). Existing
 * labels never change. Returns the number of rows labelled, or an error message. */
export async function assignWithGraphRun(run: ClusterMatchedRun, signal?: AbortSignal): Promise<number | string> {
  const g = run.graph;
  if (!g || !run.destinations) return 0;
  const current = () => {
    const st = useBrowserStore.getState();
    // The run's labels are still the shown ones (a merge, dissolve or any relabelling ends the model's use).
    return st.clusterMatchedRun === run && (st.activeClusterTreeNodeId ?? null) === (run.treeNodeId ?? null)
      && currentMatchedRun(run, st.clusterAssignments) === run;
  };
  // Only the run's own tree node (review G5): another branch's labels never take this model's.
  if (!current()) return 0;
  let response: { results: Record<string, { assignments?: Record<string, number> }> };
  try {
    response = await post('/api/graph/cluster/assign', {
      registration_id: g.registrationId, revisions: g.revisions, target: g.target, regions: g.regions,
      observations: g.observations.map(wire), options: g.options,
      run: { stages: g.stages, label_ids: g.labelIds, settings: g.settings, revisions: g.revisions } });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (signal?.aborted || !current()) return 0;
  const st = useBrowserStore.getState();
  // Each destination within its own scope; a panel opened since on one of the run's observations (a member popped
  // out later, a new haplotype panel) within its own read filter.
  const known = new Set(run.destinations.map(d => d.stateKey));
  const later = graphRunStateKeys(run, st.panels, st.chrom, st.clusterAssignments).filter(k => !known.has(k)).flatMap(stateKey => {
    const p = st.panels.find(q => (q.stateKey ?? q.datasetId) === stateKey);
    const obs = p ? g.observations.filter(o => observationShownBy(o, p)).map(o => o.id) : [];
    const filter = st.filteredReadIds[stateKey];
    return obs.length ? [{ stateKey, observations: obs, panelId: p!.id, scope: filter ? [...filter] : null }] : [];
  });
  let added = 0;
  const touched: string[] = [];
  for (const d of [...run.destinations, ...later]) {
    const labels = destinationAssignments({ ...d, scope: d.scope ?? null }, response.results);
    const live = st.clusterAssignments[d.stateKey] ?? {};
    const fresh = Object.fromEntries(Object.entries(labels).filter(([id, c]) => live[id] === undefined && c !== UNASSIGNED_CLUSTER_ID));
    if (!Object.keys(fresh).length) continue;
    added += Object.keys(fresh).length;
    touched.push(d.stateKey);
    // (svSplit: keep the run's C<parent>.<j> names, which an ordinary write would drop. Mirrored into the run's
    // tree node, which is the active one: its labels are model-assigned on fixed regions, not a viewport projection,
    // so leaving the branch and coming back keeps them.)
    st.setClusterAssignments(d.stateKey, fresh, { mirror: true, merge: true, svSplit: true });
  }
  if (added && run.names && Object.keys(run.names).length) mirrorGroupLabels(touched, run.names);
  // Panels joined since the run (a pop-out carrying its host's labels) are kept on the run's tree node too, with the
  // refined names, even when no row needed a label (Codex review, group F: a branch switch lost them).
  const joined = later.map(d => d.stateKey).filter(k => Object.keys(useBrowserStore.getState().clusterAssignments[k] ?? {}).length);
  if (joined.length) {
    if (run.names && Object.keys(run.names).length) mirrorGroupLabels(joined, run.names);
    useBrowserStore.setState(cur => {
      const id = cur.activeClusterTreeNodeId;
      const node = id ? cur.clusterTreeNodes[id] : null;
      if (!node || !id) return {};
      const assignments = { ...(node.assignments ?? {}) };
      for (const k of joined) if (!assignments[k]) assignments[k] = { ...cur.clusterAssignments[k] };
      return { clusterTreeNodes: { ...cur.clusterTreeNodes, [id]: { ...node, assignments } } };
    });
  }
  if (added) {
    const now = useBrowserStore.getState();
    useBrowserStore.setState({ clusterMatchedRun: { ...run, panelAssignments: { ...run.panelAssignments,
      ...Object.fromEntries([...run.destinations.map(d => d.stateKey), ...touched].map(k => [k, now.clusterAssignments[k] ?? {}])) } } });
  }
  return added;
}

// ── Registration ─────────────────────────────────────────────────────────────

function transformPlan(st: PlanState, plan: ClusterTargetPlan): ClusterTargetPlan {
  const g = graphClusterPlan(st, plan.basis);
  if (!g) return plan;
  const inRun = new Set(g.destinations.map(d => d.panelId));
  const outIds = new Map(g.leftOut.map(l => [l.panelId, l.reason]));
  const rows = plan.rows.map(r => {
    const panel = st.panels.find(p => p.id === r.panelId);
    const viaHost = panel && hostOf(st.panels, panel)?.id === g.host.id;
    if (inRun.has(r.panelId) || (viaHost && !outIds.has(r.panelId))) return { ...r, inRun: true, reason: null, shortReason: null };
    if (outIds.has(r.panelId)) return { ...r, inRun: false, reason: outIds.get(r.panelId)!, shortReason: 'not on the graph' };
    return r;
  });
  const n = g.observations.length;
  const inRunCount = rows.filter(r => r.inRun).length;
  const what = `${g.regions.length} region${g.regions.length === 1 ? '' : 's'} on graph columns`;
  const headline = `Cluster at ${what} · ${n} path${n === 1 ? '' : 's'} fitted once`;
  const notes = [...plan.notes.filter(x => !x.includes('left out')),
    ...(g.leftOut.length ? [`${g.leftOut.length} panel${g.leftOut.length === 1 ? '' : 's'} left out: not on the graph`] : []),
    ...(g.offContig ? [`${g.offContig} region${g.offContig === 1 ? '' : 's'} not on the graph's target`] : [])];
  return { ...plan, rows, refusal: g.refusal, basis: { ...plan.basis, kind: 'graph' as ClusterBasis['kind'], what },
    headline, notes, summary: [headline, ...notes].join(' · '),
    // "1 panel" / "3 panels" (it once read "Panels: 1 panels").
    chip: `${inRunCount} panel${inRunCount === 1 ? '' : 's'} · ${n} path${n === 1 ? '' : 's'}${g.leftOut.length ? ` · ${g.leftOut.length} left out` : ''}` };
}

let registered = false;

export function registerGraphClustering(): void {
  if (registered) return;
  registered = true;
  registerClusterPlanTransform(transformPlan);
  registerClusterBasisRunner('graph', runGraphCluster);
  startGraphDynamicAssignment();
}

/** After a pan or a change of the analysis sample, rows of the current graph run's observations that have no label
 * yet are assigned with its model (debounced; one request in flight). */
function startGraphDynamicAssignment(): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  useBrowserStore.subscribe((s, prev) => {
    const run = s.clusterMatchedRun;
    if (!run?.graph) return;
    const moved = s.start !== prev.start || s.end !== prev.end || s.chrom !== prev.chrom
      || s.analysisSampleCount !== prev.analysisSampleCount;
    if (!moved) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      controller?.abort();
      controller = new AbortController();
      const st = useBrowserStore.getState();
      const now = st.clusterMatchedRun;
      if (now?.graph && (st.activeClusterTreeNodeId ?? null) === (now.treeNodeId ?? null)) void assignWithGraphRun(now, controller.signal);
    }, 400);
  });
}
