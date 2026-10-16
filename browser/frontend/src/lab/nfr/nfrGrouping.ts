/**
 * NFR read groups for the toolbar and the panel (one code path, so the two can't drift): the Accessibility panel's
 * "Group reads by variant" / "Split by combination pattern" buttons, and the main toolbar's Cluster (combinatorial)
 * and "Split into panels" on selected NFRs and variants (registered as a combinatorial planner and split sources).
 *
 * Which grouping a selection gets (planCombinatorial):
 * - one NFR, or exactly every variant of one NFR -> "Group reads by variant" (the NFR's configurations);
 * - 2-8 features that are all elements of one Accessibility run (its variants, its whole NFRs, the footprint classes
 *   joined to it) -> "Split by combination pattern" on those elements (the run's own eligibility);
 * - anything else (one variant, classes not joined to a run, features of different runs) -> core's per-read state
 *   patterns (utils/featureClustering.ts).
 */
import { getAccessibilityGroups, splitAccessibilityReads, type AccessibilityResult, type AccessibilitySplit } from './api';
import { useAccessibilityStore, type AppliedNfrGroups } from './accessibilityStore';
import { groupsToClusters, splitToGroups } from './accessibilityView';
import { useNfrRunsStore } from './nfrRunsStore';
import { MAX_COMBINED_FEATURES, registerCombinatorialPlanner, STALE } from '../../utils/featureClustering';
import { applyReadGroups } from '../../utils/readGroups';
import { allZero, invert, registerSplitSourceKind, type SplitGrouping } from '../../utils/splitPanels';
import { getClusterColor } from '../../components/tracks/read-track/constants';
import type { FeatureRef } from '../../stores/featureStore';
import type { SplitSource } from '../../stores/splitPanelStore';
import type { ReadSubsetRule } from '../../types';

// ---------------------------------------------------------------- the panel's two buttons
/** "Group reads by variant": one group per most likely configuration of the NFR (closed, V1, V1+V3, other). */
export async function groupReadsByNfrVariant(jobId: string, nfrId: string, stateKeyMap: Record<string, string[]>,
  stillCurrent: () => boolean = () => true): Promise<AppliedNfrGroups | null> {
  const g = await getAccessibilityGroups(jobId, nfrId);
  if (!stillCurrent()) return null;
  const grouping = applyReadGroups(groupsToClusters(g), stateKeyMap, `Group reads by NFR variant (${nfrId})`);
  const applied: AppliedNfrGroups = { kind: 'configurations', jobId, grouping, configurations: g };
  useAccessibilityStore.getState().pushApplied(applied);
  return applied;
}

/** The elements' spans, in the order of the pattern's bits (the split's own element order). */
export function elementSpans(result: AccessibilityResult | null, ids: string[]): { start: number; end: number }[] {
  return ids.map(id => (result?.elements ?? []).find(e => e.id === id)).filter(Boolean).map(e => ({ start: e!.start, end: e!.end }));
}

export function splitGroupingLabel(s: Pick<AccessibilitySplit, 'kind' | 'short'>): string {
  return s.kind === 'pair' ? `Group reads by ${s.short.join(' × ')}` : `Group reads by the pattern of ${s.short.join(', ')}`;
}

/** A pair split (an arc, a matrix cell) or "Split by combination pattern" (2-8 elements). */
export async function splitReadsByElements(jobId: string, body: { a: string; b: string } | { elements: string[] },
  result: AccessibilityResult | null, stateKeyMap: Record<string, string[]>,
  stillCurrent: () => boolean = () => true): Promise<AppliedNfrGroups | null> {
  const s: AccessibilitySplit = await splitAccessibilityReads(jobId, body);
  if (!stillCurrent()) return null;
  return applySplit(jobId, s, result, stateKeyMap);
}

/** Put a split already fetched (an inspected pair: "Group reads by this pair") into the read panels as groups; Clear
 * (Restore previous grouping) returns to the grouping before. */
export function applySplit(jobId: string, s: AccessibilitySplit, result: AccessibilityResult | null,
  stateKeyMap: Record<string, string[]>): AppliedNfrGroups {
  const ids = s.kind === 'pair' ? [s.a!, s.b!] : s.elements!;
  const grouping = applyReadGroups(splitToGroups(s, elementSpans(result, ids)), stateKeyMap, splitGroupingLabel(s));
  const applied: AppliedNfrGroups = { kind: s.kind, jobId, grouping, split: s };
  useAccessibilityStore.getState().pushApplied(applied);
  return applied;
}

// ---------------------------------------------------------------- which grouping a selection gets
export type CombinatorialPlan =
  | { kind: 'configurations'; jobId: string; nfrId: string; result: AccessibilityResult }
  | { kind: 'split'; jobId: string; elements: string[]; result: AccessibilityResult }
  | { kind: 'patterns' }
  | { kind: 'refuse'; reason: string };

interface RunInfo { result: AccessibilityResult; classJobId?: string | null }

/** The run element a feature is, or null. */
export function elementOf(f: FeatureRef, run: RunInfo, jobId: string): string | null {
  const elements = run.result.elements ?? [];
  if (f.kind === 'nfr-variant') return f.source === jobId && elements.some(e => e.id === f.id) ? f.id : null;
  if (f.kind === 'nfr') return f.source === jobId && elements.some(e => e.id === `${f.id}:open`) ? `${f.id}:open` : null;
  // A footprint class joined to the run: its Find classes run, its dataset among the run's.
  if (!run.classJobId || f.source !== run.classJobId) return null;
  if (f.datasetId && !run.result.datasets.some(d => d.dataset_id === f.datasetId)) return null;
  return elements.find(e => e.kind === 'tf' && (e.class_id ?? e.id) === f.id)?.id ?? null;
}

export function planCombinatorial(features: FeatureRef[], runs: Record<string, RunInfo>): CombinatorialPlan {
  if (!features.length) return { kind: 'refuse', reason: 'Select NFRs, NFR variants or footprint classes first (shift-click them in the channels above the reads).' };
  if (features.length > MAX_COMBINED_FEATURES) {
    return { kind: 'refuse', reason: `Choose up to ${MAX_COMBINED_FEATURES} features for a combinatorial clustering (${features.length} are selected): every pattern of them is a group.` };
  }
  const nfrKinds = features.filter(f => f.kind !== 'fp-class');
  const sources = new Set(nfrKinds.map(f => f.source));
  // One NFR, or every variant of one NFR and nothing else: its configurations.
  if (nfrKinds.length === features.length && sources.size === 1) {
    const jobId = nfrKinds[0].source;
    const run = runs[jobId];
    if (run) {
      if (features.length === 1 && features[0].kind === 'nfr') {
        const nfr = run.result.nfrs.find(n => n.id === features[0].id);
        if (nfr?.variants.length) return { kind: 'configurations', jobId, nfrId: nfr.id, result: run.result };
      }
      if (features.every(f => f.kind === 'nfr-variant')) {
        const nfrIds = new Set(features.map(f => f.id.split(':')[0]));
        const nfr = nfrIds.size === 1 ? run.result.nfrs.find(n => n.id === [...nfrIds][0]) : null;
        if (nfr && nfr.variants.length >= 1 && nfr.variants.length === features.length
          && nfr.variants.every(v => features.some(f => f.id === v.id))) {
          return { kind: 'configurations', jobId, nfrId: nfr.id, result: run.result };
        }
      }
    }
  }
  // Elements of one run: the run's combination split.
  if (features.length >= 2) {
    for (const [jobId, run] of Object.entries(runs)) {
      const ids = features.map(f => elementOf(f, run, jobId));
      if (ids.some(id => !id) || new Set(ids).size !== ids.length) continue;
      const combo = run.result.combos?.elements ?? [];
      // The panel's button splits by the run's own element order; the same set gets that order (the same groups).
      const order = combo.length === ids.length && ids.every(id => combo.includes(id!))
        ? combo : (run.result.elements ?? []).map(e => e.id).filter(id => ids.includes(id));
      return { kind: 'split', jobId, elements: order, result: run.result };
    }
  }
  return { kind: 'patterns' };
}


export function runsForPlan(): Record<string, RunInfo> {
  const out: Record<string, RunInfo> = {};
  for (const [jobId, run] of Object.entries(useNfrRunsStore.getState().nfrRuns)) out[jobId] = { result: run.result, classJobId: run.classJobId };
  const shown = useAccessibilityStore.getState();
  if (shown.jobId && shown.result && !out[shown.jobId]) out[shown.jobId] = { result: shown.result };
  return out;
}

// ---------------------------------------------------------------- the toolbar and "Split into panels"
type NfrSplitSource = Extract<SplitSource, { kind: 'configurations' | 'split' }>;

/** The NFR planner: an NFR's configurations or a run's combination split for the selections that are those. */
export function registerNfrGrouping(): void {
  registerCombinatorialPlanner({
    cluster: (features, keyMap, current) => {
      const plan = planCombinatorial(features, runsForPlan());
      if (plan.kind === 'refuse') return Promise.resolve(plan.reason);
      if (plan.kind === 'configurations') return groupReadsByNfrVariant(plan.jobId, plan.nfrId, keyMap, current).then(a => (a ? null : STALE));
      if (plan.kind === 'split') return splitReadsByElements(plan.jobId, { elements: plan.elements }, plan.result, keyMap, current).then(a => (a ? null : STALE));
      return undefined;
    },
    splitSource: (features: FeatureRef[]) => {
      const plan = planCombinatorial(features, runsForPlan());
      if (plan.kind === 'configurations') return { kind: 'configurations', jobId: plan.jobId, nfrId: plan.nfrId, result: plan.result };
      if (plan.kind === 'split') return { kind: 'split', jobId: plan.jobId, elements: plan.elements, result: plan.result };
      return undefined;
    },
  });
  registerSplitSourceKind({
    kind: 'configurations',
    load: source => loadConfigurations(source as Extract<NfrSplitSource, { kind: 'configurations' }>),
    fromRule: (rule: ReadSubsetRule) => (rule.jobId && rule.nfrId ? { kind: 'configurations', jobId: rule.jobId, nfrId: rule.nfrId } : null),
    signature: rule => [rule.jobId ?? '', rule.nfrId ?? ''],
  });
  registerSplitSourceKind({
    kind: 'split',
    load: source => loadElementSplit(source as Extract<NfrSplitSource, { kind: 'split' }>),
    fromRule: (rule: ReadSubsetRule) => (rule.jobId && rule.elements?.length ? { kind: 'split', jobId: rule.jobId, elements: rule.elements } : null),
    signature: rule => [rule.jobId ?? '', rule.elements ?? []],
    title: rule => (rule.elements ? rule.elements.join(', ').replace(/:/g, ' ') : ''),
  });
}

async function loadConfigurations(source: Extract<NfrSplitSource, { kind: 'configurations' }>): Promise<SplitGrouping> {
  const g = await getAccessibilityGroups(source.jobId, source.nfrId);
  const ids = invert(g.by_dataset, new Map(g.groups.map(x => [x.id, x.label])));
  return {
    title: source.nfrId, rule: { kind: 'configurations', jobId: source.jobId, nfrId: source.nfrId },
    // The run's region (where its reads were classified), not whatever view the card was clicked in.
    ...(source.result?.region ? { locus: { ...source.result.region, label: source.nfrId } } : {}),
    groups: g.groups.map(x => ({
      key: x.label, label: x.display_label || x.label, count: x.count, colour: getClusterColor(x.id),
      kind: x.label === 'closed' ? 'closed' : /^V\d+$/.test(x.label) ? 'group' : 'other', ids: ids.get(x.label) ?? {},
    })),
  };
}

async function loadElementSplit(source: Extract<NfrSplitSource, { kind: 'split' }>): Promise<SplitGrouping> {
  const s = await splitAccessibilityReads(source.jobId, { elements: source.elements });
  const ids = invert(s.by_dataset, new Map(s.groups.map(x => [x.id, x.key])));
  return {
    title: '', rule: { kind: 'split', jobId: source.jobId, elements: source.elements },
    ...(source.result?.region ? { locus: { ...source.result.region, label: source.elements.join(', ').replace(/:/g, ' ') } } : {}),
    groups: s.groups.map(x => ({
      key: x.key, label: x.label, count: x.count, colour: getClusterColor(x.id),
      kind: x.key === 'na' ? 'na' : allZero(x.key) ? 'closed' : 'group', ids: ids.get(x.key) ?? {},
    })),
  };
}

