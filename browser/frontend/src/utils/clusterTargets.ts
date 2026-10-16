/**
 * What a Cluster run will do, said before it runs (usability audit Top 3, SV-1; round 3, R6/B5): what it clusters on
 * (clusterBasis: the selected peaks, the features' spans, a rule's regions, or Combinatorial on the features), the
 * panels it clusters, the panels it leaves out and why ("Reference: different coordinates from the peaks"), and a
 * refusal when the run would cluster something other than what the user targeted.
 *
 * One plan (clusterRunPlan) for the Cluster button's tooltip, the toolbar's "Panels" chip and picker, and the run
 * itself (components/Browser.tsx handleCluster branches on its basis and words its result line from it), with the
 * same rule the run applies (stores/clusterSlice.ts clusterReferenceScope: one reference per run), so they can't
 * disagree.
 */
import { extendClusterPlan } from './clusterRunExtensions';
import { clusterReferenceScope } from '../stores/clusterSlice';
import { getTargetDatasetIds } from '../stores/browserStore';
import type { BrowserState } from '../stores/browserStore';
import { panelGenomeLabel, usePanelGenomeStore } from '../stores/panelGenomeStore';
import { CLUSTER_RULE_MODE_PREFIX, type PanelConfig, type PeakMode, type MatchedRegionInfo } from '../types';
import { resolveClusterFeatureRuleName, resolveClusterRuleRegions } from './analysisRules';
import { featureNames, featurePeakRegions } from './featureClustering';
import { featureKindDef, featureKindWithActions, type FeatureRef } from '../stores/featureStore';
import { sameChrom } from './chromAliases';
import { getDatasetDisplayLabel } from './datasetLabels';
import { panelTraits } from './panelExtensions';
import { panelTitle } from './panelTitle';
import { useSplitPanelStore } from '../stores/splitPanelStore';
import { splitShowsAll } from './splitLocus';

export type ClusterPeak = { start: number; end: number; mode?: string; chrom?: string; genome?: string; match?: MatchedRegionInfo };

export type PlanState = Pick<BrowserState, 'panels' | 'datasets' | 'selectedDatasets' | 'chrom' | 'start' | 'end' | 'currentGenome'
  | 'filteredReadIds' | 'selectedPeaks' | 'peakModes' | 'clusterPeakMode' | 'clusterFeatureRules' | 'selectedGenes' | 'selectedFeatures'>
  & Partial<Pick<BrowserState, 'clusterAssignments' | 'selectedClusters' | 'clusterFocus' | 'clusterMethod'>>
  & { getAllPeaks: BrowserState['getAllPeaks'] };

/** One panel's window in a Cluster run (the request's viewport), with the panel it came from. */
export interface ClusterWindow {
  dataset_id: string; result_key: string; chrom: string; start: number; end: number;
  read_ids?: string[]; strand?: 'CT' | 'GA'; panel: PanelConfig;
}

/**
 * The windows a Cluster run sends: one per shown, targeted dataset panel (by state key), with the reads it clusters
 * (a cluster subset, a read filter, a split panel's own reads). Shared by the run (components/Browser.tsx) and the
 * plan (clusterTargetPlan), so both see the same panels and the same empty ones.
 */
export function clusterWindows(st: PlanState, datasetIds: string[]): ClusterWindow[] {
  const { chrom, start, end } = st;
  return st.panels.filter(panel => panel.contentType === 'dataset' && panel.datasetId && datasetIds.includes(panel.datasetId) && !panel.collapsed
    && (!st.selectedDatasets.size || st.selectedDatasets.has(panel.id))).map(panel => {
    const sk = panel.stateKey ?? panel.datasetId!;
    const viewport = panel.viewportOverride ?? { chrom, start, end };
    const assignments = st.clusterAssignments?.[sk];
    const selected = st.selectedClusters?.[sk], focus = st.clusterFocus?.[sk];
    const subset = selected?.size ? selected : focus?.size ? focus : null;
    // No filter is null; an applied filter that matched nothing is an empty set (that panel has nothing to cluster).
    const filter = st.filteredReadIds[sk];
    // Inside a cluster subset, only its reads that pass the filter.
    let ids = subset && assignments ? Object.keys(assignments).filter(id => subset.has(assignments[id]) && (!filter || filter.has(id)))
      : filter ? Array.from(filter) : undefined;
    // A split panel (Split into panels) clusters only its own reads; all targeted split panels cluster together.
    const split = panel.readSubset ? useSplitPanelStore.getState().reads[sk] : undefined;
    // (Away from its locus showing every read here, utils/splitLocus.ts: those reads.)
    // (A panel on a contig of its own, e.g. an insert-expanded Carriers panel, shows its own dataset: with no split
    // reads under its key it clusters as it is; restricting it to none left it nothing to cluster.)
    if (panel.readSubset && !(panelTraits(panel).ownContig && !split) && !splitShowsAll(panel.readSubset, viewport, panel)) {
      const own = split && (split.state === 'ready' || split.state === 'frozen') ? split.ids : new Set<string>();
      ids = ids ? ids.filter(id => own.has(id)) : Array.from(own);
    }
    return { dataset_id: panel.datasetId!, result_key: sk, ...viewport, read_ids: ids, ...(panel.strand ? { strand: panel.strand } : {}), panel };
  }).filter((view, index, all) => all.findIndex(other => other.result_key === view.result_key) === index);
}

/** What a Cluster run clusters on, decided as the run decides it (components/Browser.tsx handleCluster branches on it). */
export type ClusterBasisKind = 'ordered' | 'matched' | 'peaks' | 'feature-regions' | 'combinatorial' | 'rule' | 'none';

export interface ClusterBasis {
  kind: ClusterBasisKind;
  /** The regions sent to the run (the peaks, the features' spans, the rule's regions; Combinatorial: the features' spans). */
  regions: ClusterPeak[];
  /** The selected features on the main view's chromosome. */
  features: FeatureRef[];
  /** "1 selected peak", "C3, C7", "INS 9.2k, INS 5k", "4 regions of TF rule". */
  what: string;
  /** Selected features this run leaves aside, and why ("ticked SVs group reads only with Combinatorial"); null: none. */
  unused: string | null;
}

/** What a kind's features are called in a note ("SVs", "footprint classes"). */
function kindNoun(kind: string): string {
  const def = featureKindDef(kind);
  return def?.pluralName ?? def?.noun ?? `${kind} features`;
}
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const nounsOf = (features: FeatureRef[]) => listNames([...new Set(features.map(f => kindNoun(f.kind)))]);

/**
 * What a Cluster run clusters on (round 3, R6/B5: the tooltip named the ticked SVs while the run used the peak):
 * - an active cluster rule: its regions (selected features aside);
 * - Combinatorial with features selected: the reads grouped by their states at the features;
 * - features that are regions (footprint classes, plugin packs' region kinds): their spans;
 * - else the selected peaks (features that are not regions, ticked SVs, group the reads only with Combinatorial).
 */
export function clusterBasis(st: PlanState): ClusterBasis {
  const allPeaks = st.getAllPeaks();
  const featurePeaks = allPeaks.filter(p => p.featureIndex !== undefined);
  const chosen = featurePeaks.length ? featurePeaks : allPeaks.filter(p => st.selectedPeaks.has(p.index));
  const selected = chosen.some(p => p.match?.correspondenceId) ? chosen.filter(p => !p.match || p.match.correspondenceId) : chosen;
  const ids = new Set(selected.filter(p => p.match).map(p => p.match!.groupId));
  if (ids.size) {
    const regions = allPeaks.filter(p => p.match && ids.has(p.match.groupId))
      .filter((p, i, all) => all.findIndex(q => q.match!.groupId === p.match!.groupId && q.match!.label === p.match!.label && q.match!.panelId === p.match!.panelId) === i).map(p => ({ ...p, mode: p.featureMode || st.peakModes[p.index] || 'accessibility' }));
    const partners = regions.filter(p => p.match?.correspondenceId);
    const privatePeaks = selected.filter(p => !p.match);
    for (const p of privatePeaks) {
      const members = partners.filter(m => (!p.memberPanelId || !m.match!.panelId || m.match!.panelId === p.memberPanelId) && sameChrom(m.chrom ?? st.chrom, p.chrom ?? st.chrom) && (m.genome ?? null) === (p.genome ?? null));
      const labels = new Set<string>();
      for (const member of members) {
        const m = member.match!;
        if (labels.has(m.label)) continue;
        labels.add(m.label);
        regions.push({ ...p, chrom: p.chrom ?? st.chrom, mode: p.featureMode || st.peakModes[p.index] || 'accessibility',
          match: { ...m, memberSpecific: true, groupId: `specific-${p.ruleId}-${p.index}-${p.start}-${p.end}`, length: p.end-p.start,
            blocks: [{ frame: [0, p.end-p.start], genomic: [p.start, p.end] }] } });
      }
    }
    const names = [...ids].map(id => regions.find(p => p.match?.groupId === id)?.match?.correspondenceId ?? id).map(id => ('peakRules' in st ? (st as BrowserState).peakRules.find(r => r.id === id)?.name : null) ?? id);
    const sourceNames = [...new Set(names)].join(' + ');
    const what = partners.length ? `${ids.size} shared feature${ids.size === 1 ? '' : 's'} from ${sourceNames}` : `matched regions ${sourceNames}`;
    return { kind: 'matched', regions, features: [], what: `${what} (${regions.length} ${partners.length ? 'member ' : ''}regions · ${[...new Set(regions.map(p => p.match!.length))].join(', ')} bp)`,
      unused: privatePeaks.length ? `${privatePeaks.length} member-specific features (no counterpart)` : null };
  }
  const mode = st.clusterPeakMode;
  const activeRuleId = typeof mode === 'string' && mode.startsWith(CLUSTER_RULE_MODE_PREFIX) ? mode.slice(CLUSTER_RULE_MODE_PREFIX.length) : null;
  const activeRule = activeRuleId ? st.clusterFeatureRules.find(rule => rule.id === activeRuleId) : null;
  const features = st.selectedFeatures.filter(f => !f.chrom || sameChrom(f.chrom, st.chrom));
  if (activeRule) {
    const regions = resolveClusterRuleRegions(activeRule, {
      allPeaks, selectedPeaks: st.selectedPeaks, peakModes: st.peakModes, mode: mode as PeakMode,
      chrom: st.chrom, viewportStart: st.start, viewportEnd: st.end, selectedGenes: st.selectedGenes,
    });
    return {
      kind: regions.length ? 'rule' : 'none', regions, features,
      what: `${plural(regions.length, 'region')} of ${resolveClusterFeatureRuleName(activeRule)}`,
      unused: features.length ? `the cluster rule sets the regions, not the ticked ${nounsOf(features)}` : null,
    };
  }
  // Selected features win over selected peaks: their spans, on their own layers. Features that are not regions to
  // cluster on (an SV ticked in Variants) leave the selected peaks to a region method; Combinatorial groups the reads
  // by the features themselves (clusterSelectedFeatures), so the peaks never count for it.
  const featureRegions = features.length ? featurePeakRegions(features) : [];
  if (features.length && st.clusterMethod === 'combinatorial') {
    return { kind: 'combinatorial', regions: featureRegions, features, what: featureNames(features), unused: null };
  }
  const notRegions = features.filter(f => !featurePeakRegions([f]).length);
  const unused = notRegions.length ? `ticked ${nounsOf(notRegions)} group reads only with Combinatorial` : null;
  if (featureRegions.length) {
    return { kind: 'feature-regions', regions: featureRegions, features, what: featureNames(features.filter(f => !notRegions.includes(f))), unused };
  }
  const peaks = Array.from(st.selectedPeaks)
    .map(idx => allPeaks.find(p => p.index === idx))
    .filter((p): p is typeof allPeaks[0] => p !== undefined)
    .map(p => ({
      start: p.start, end: p.end, mode: p.featureMode || st.peakModes[p.index] || 'accessibility',
      ...(p.chrom ? { chrom: p.chrom } : {}),
      ...(p.genome ? { genome: p.genome } : {}),
    }));
  return { kind: peaks.length ? 'peaks' : 'none', regions: peaks, features, what: plural(peaks.length, 'selected peak'), unused };
}

/**
 * The regions a Cluster run clusters on: selected features (their spans), else the active cluster rule's regions,
 * else the selected peaks (with the chromosome and reference of a peak scanned or drawn in a panel elsewhere).
 */
export function selectedClusterPeakRegions(st: PlanState): ClusterPeak[] {
  return clusterBasis(st).regions;
}

export interface ClusterTargetRow {
  panelId: string;
  /** The panel's whole title (its tooltip). */
  label: string;
  /** Its name as the header leads with it ("Carriers", "INS 9.2k+ · INS 5k+"): the summary and the picker's row. */
  short: string;
  /** What follows the name in the header ("INS 9.2 kb @ chr2L:9,467,039 · numb"), '' for none: the row's second line. */
  detail: string;
  /** The user targeted it (clicked its header or ticked it under Panels). */
  targeted: boolean;
  /** The run clusters it. */
  inRun: boolean;
  /** Why the run leaves it out (null: it's in the run, or simply not targeted). */
  reason: string | null;
  /** A shorter reason for the summary line ("different coordinates"). */
  shortReason: string | null;
}

export interface ClusterTargetPlan {
  advice?: { text: string; action?: { label: string; panel: string } };
  rows: ClusterTargetRow[];
  /** Panels were targeted on purpose (else: every panel the run can cluster). */
  explicit: boolean;
  /** Why Cluster won't run as things are (null: it can run). */
  refusal: string | null;
  /** What the run clusters on (the same decision the run makes). */
  basis: ClusterBasis;
  /** The panels it clusters: "Carriers", "Carriers and Reference", "all panels", "3 panels", "no panel". */
  where: string;
  /** What the run will do, in one line (round 3, R6): the Cluster button's tooltip, the picker, the result line. */
  headline: string;
  /** What it leaves out and why ("Reference left out: different coordinates", "ticked SVs group reads only with Combinatorial"). */
  notes: string[];
  /** headline · notes: "Cluster at 1 selected peak in Carriers · Reference left out: different coordinates". */
  summary: string;
  /**
   * The toolbar chip beside Cluster (round 2, N7: the long form wrapped the toolbar at 1440 px; round 3, R8: it names
   * what it chooses): "Panels: all" when the run takes every panel (one panel included), "Panels: Carriers · 1 left
   * out", "Panels: 2 panels", "Panels: none".
   */
  chip: string;
}

const isDatasetPanel = (p: PanelConfig) => p.contentType === 'dataset' && !!p.datasetId;
const keyOf = (p: PanelConfig) => p.stateKey ?? p.datasetId!;

/** The panel's name as its header shows it (utils/panelTitle.ts: the split group first, the dataset last). */
export function panelTargetLabel(st: Pick<BrowserState, 'datasets'>, panel: PanelConfig): { label: string; short: string; detail: string } {
  const ds = st.datasets.find(d => d.id === panel.datasetId);
  const base = ds ? getDatasetDisplayLabel(ds, panel.altAllele ? 96 : 40) : panel.datasetId ?? 'Panel';
  const source = panel.altAllele ? st.datasets.find(d => d.id === panel.altAllele!.cluster?.datasetId) : undefined;
  const title = panelTitle(panel, base, source ? getDatasetDisplayLabel(source) : undefined);
  return { label: title.full, short: title.primary, detail: title.secondary };
}

/** "Cluster at 1 selected peak in Carriers", "Group reads by their state at C3, C7 in all panels". */
export function clusterRunHeadline(plan: Pick<ClusterTargetPlan, 'basis' | 'where'>, runLabel = 'Cluster'): string {
  const { basis, where } = plan;
  if (basis.kind === 'none') return `${runLabel}: nothing to cluster on yet (select peaks${basis.unused ? '' : ' or features'})`;
  if (basis.kind === 'combinatorial') {
    // ('': a kind grouping its own way whose panel isn't known here.)
    return `Group reads by their state at ${basis.what}${!where || where === 'no panel' ? '' : ` in ${where}`}`;
  }
  // (No panel it can cluster: the refusal or the notes say why.)
  return where === 'no panel' ? `${runLabel} at ${basis.what}: no panel to cluster` : `${runLabel} at ${basis.what} in ${where}`;
}

const basisOfPeaks = (peaks: ClusterPeak[]): ClusterBasis => ({
  kind: peaks.length ? 'peaks' : 'none', regions: peaks, features: [], what: plural(peaks.length, 'selected peak'), unused: null,
});

export function defaultReferenceName(st: Pick<BrowserState, 'currentGenome'>) {
  return (genome: string | null) => (genome
    ? panelGenomeLabel(usePanelGenomeStore.getState().genomes[genome], genome)
    : (st.currentGenome || 'the main genome'));
}

function listNames(names: string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The plan of the Cluster run the current state would start: what it clusters on, and which panels. */
export function clusterRunPlan(st: PlanState, referenceName: (genome: string | null) => string = defaultReferenceName(st)): ClusterTargetPlan {
  const basis = clusterBasis(st);
  return extendClusterPlan(st, clusterTargetPlan(st, basis.regions, referenceName, basis));
}

/**
 * What a Cluster run on `peaks` would do with the panels on screen: which it clusters, which it leaves out (and why),
 * and whether it refuses. `referenceName` names a reference key (null: the main genome).
 */
export function clusterTargetPlan(
  st: PlanState,
  peaks: ClusterPeak[],
  referenceName: (genome: string | null) => string = defaultReferenceName(st),
  basis: ClusterBasis = basisOfPeaks(peaks),
): ClusterTargetPlan {
  const explicit = st.selectedDatasets.size > 0;
  const datasetIds = getTargetDatasetIds(st.selectedDatasets, st.panels, st.datasets);
  const shown = st.panels.filter(p => isDatasetPanel(p) && !p.collapsed);
  const candidates = shown.filter(p => datasetIds.includes(p.datasetId!) && (!explicit || st.selectedDatasets.has(p.id)));
  // The run's windows (one per state key), in the run's order of checks: the reference, then the empty ones.
  const windows = basis.kind === 'matched'
    ? clusterWindows({ ...st, selectedDatasets: new Set() }, st.datasets.map(d => d.id)) : clusterWindows(st, datasetIds);

  const rows: ClusterTargetRow[] = shown.map(p => ({
    ...panelTargetLabel(st, p), panelId: p.id, targeted: st.selectedDatasets.has(p.id), inRun: false, reason: null, shortReason: null,
  }));
  const row = (p: PanelConfig) => rows.find(r => r.panelId === p.id)!;
  const panelsOf = (key: string) => candidates.filter(c => keyOf(c) === key);
  const finish = (refusal: string | null, whereOverride?: string): ClusterTargetPlan => {
    const inRun = rows.filter(r => r.inRun);
    const out = rows.filter(r => r.reason);
    const everything = !explicit && out.length === 0 && inRun.length > 0 && inRun.length === rows.length;
    const where = whereOverride !== undefined ? whereOverride : inRun.length === 0 ? 'no panel'
      : everything && rows.length > 1 ? 'all panels'
        : inRun.length <= 2 ? listNames(inRun.map(r => r.short)) : `${inRun.length} panels`;
    const notes: string[] = [];
    if (out.length) {
      const reasons = [...new Set(out.map(r => r.shortReason ?? 'left out'))];
      notes.push(`${listNames(out.map(r => r.short))} left out: ${reasons.join('; ')}`);
    }
    if (basis.unused) notes.push(basis.unused);
    const headline = clusterRunHeadline({ basis, where });
    // The chip: what the picker chooses (panels), short enough for the toolbar's one row.
    const who = inRun.length === 0 ? 'none' : everything ? 'all' : inRun.length === 1 ? inRun[0].short : `${inRun.length} panels`;
    const chip = `Panels: ${who}${out.length ? ` · ${out.length} left out` : ''}`;
    return { rows, explicit, refusal, basis, where, headline, notes, summary: [headline, ...notes].join(' · '), chip };
  };

  // Combinatorial on a kind with a grouping of its own (SVs: their genotypes, in their dataset's panel): that panel, not
  // the targets (Codex review: the picker said a targeted panel "Will cluster" while the SVs grouped another).
  const own = basis.kind === 'combinatorial' ? featureKindWithActions(basis.features) : null;
  if (own) {
    const groupsId = own.actions.groupsPanel?.(basis.features);
    const groups = groupsId ? st.panels.find(p => p.id === groupsId) : undefined;
    for (const r of rows) {
      r.inRun = r.panelId === groupsId;
      if (groupsId && !r.inRun && r.targeted) Object.assign(r, { reason: `the ticked ${kindNoun(own.kind)} group the reads of their dataset's panel`, shortReason: `not where the ${kindNoun(own.kind)} group` });
    }
    const where = groups ? `${panelTargetLabel(st, groups).short}${groups.collapsed ? ' (folded away)' : ''}` : '';
    return finish(null, where);
  }
  if (windows.length === 0) {
    return finish(explicit ? 'The targeted panels are minimized or closed. Target a panel on screen (Panels ▾ beside Cluster), or clear the targets.' : null);
  }
  const markEmpty = (ws: ClusterWindow[]) => {
    const empty = ws.filter(w => w.read_ids?.length === 0);
    for (const w of empty) {
      for (const p of panelsOf(w.result_key)) {
        Object.assign(row(p), w.read_ids && st.filteredReadIds[w.result_key]?.size === 0
          ? { reason: 'no reads pass the read filter', shortReason: 'no reads pass the filter' }
          : { reason: 'no reads of its own to cluster here', shortReason: 'no reads' });
      }
    }
    return ws.filter(w => !empty.includes(w));
  };
  if (peaks.length === 0) {
    for (const w of markEmpty(windows)) for (const p of panelsOf(w.result_key)) row(p).inRun = true;
    return finish(null);
  }
  if (basis.kind === 'matched') {
    const mapped = matchedClusterWindows(windows, peaks);
    for (const w of windows) for (const p of panelsOf(w.result_key)) {
      if (mapped.windows.some(v => v.stateKey === w.result_key)) row(p).inRun = true;
      else Object.assign(row(p), { reason: 'no region of the selected group here', shortReason: 'no region here' });
    }
    const names = basis.what.split(' (')[0].replace('matched regions ', '');
    const refusal = mapped.refusal ? `${names} cover different panels or copies: select one group, or groups over the same panels.` : null;
    const plan = finish(refusal ?? (mapped.windows.length ? null : 'No panel contains a selected region. Show its whole region and try again.'));
    const n = rows.filter(r => r.inRun).length;
    plan.chip = `Panels: ${basis.what.split(' (')[0].replace('matched regions ', '')} · ${n} panels / ${mapped.windows.length} regions`;
    const fit = st.clusterMethod === 'kmeans' || st.clusterMethod === 'minibatch' ? 'balanced' : 'all eligible reads';
    plan.headline = `Cluster on ${basis.what} on ${new Set(mapped.windows.map(w => w.genome)).size} references, ${fit}`;
    plan.summary = [plan.headline, ...plan.notes].join(' · ');
    return plan;
  }
  const scope = clusterReferenceScope(st, windows, peaks, referenceName);
  if (!scope.ok) {
    if (!explicit) return finish(scope.message);
    // Targeted panels the selected peaks can't cluster: name them, and the way out.
    const targeted = rows.filter(r => r.targeted && candidates.some(c => c.id === r.panelId));
    for (const r of targeted) Object.assign(r, { reason: 'not on the selected peaks’ reference or coordinates', shortReason: 'different coordinates' });
    return finish(`Cluster can't include ${listNames(targeted.map(r => r.short))}: ${scope.message} `
      + 'Or untarget it under Panels ▾ beside Cluster.');
  }
  const peakRef = referenceName(scope.genome);
  const kept = markEmpty(scope.windows);
  if (kept.length === 0 && scope.windows.length > 0) {
    return finish('No reads pass the read filter, so there is nothing to cluster. Clear the filter to cluster every read.');
  }
  for (const w of kept) for (const p of panelsOf(w.result_key)) row(p).inRun = true;
  const keptPanels = candidates.filter(p => kept.some(w => w.result_key === keyOf(p)));
  const keptOwn = keptPanels.filter(p => panelTraits(p).ownContig);
  for (const w of scope.leftOut) {
    for (const p of panelsOf(w.result_key)) {
      const panelRef = referenceName(p.genome ?? null);
      Object.assign(row(p), panelTraits(p).ownContig
        ? { reason: `it has its own coordinates (insert expanded); the selected peaks are on ${peakRef}`, shortReason: 'different coordinates' }
        : keptOwn.length
          ? { reason: `different coordinates from ${listNames(keptOwn.map(o => row(o).short))} (insert expanded), where the selected peaks are`, shortReason: 'different coordinates' }
          : { reason: `it is on ${panelRef}; the selected peaks are on ${peakRef}`, shortReason: `on ${panelRef}` });
    }
  }
  // A selected peak inside an insert-expanded panel, for instance, leaves the reference panels out: fine when the
  // user didn't choose the panels (the summary says so), but a panel they targeted must not be dropped silently.
  // (A targeted panel with no reads to cluster is left out as the run always did: only the reference refuses.)
  const leftOutIds = new Set(scope.leftOut.flatMap(w => panelsOf(w.result_key).map(p => p.id)));
  const droppedTargets = rows.filter(r => r.targeted && leftOutIds.has(r.panelId));
  if (explicit && droppedTargets.length > 0) {
    const names = listNames(droppedTargets.map(r => r.short));
    return finish(`Cluster can't include ${names}: ${droppedTargets[0].reason}. `
      + `Untarget ${droppedTargets.length === 1 ? 'it' : 'them'} under Panels ▾ beside Cluster, or select peaks in ${droppedTargets.length === 1 ? 'it' : 'them'}.`);
  }
  if (!rows.some(r => r.inRun)) return finish('No panel on screen can be clustered with the selected peaks.');
  return finish(null);
}


export interface RegionClusterWindow extends ClusterWindow {
  stateKey: string;
  genome: string | null;
  region_label: string;
  blocks: { feature: number; frame: [number, number]; genomic: [number, number]; reverse: boolean }[];
}

/** Pair groups by panel and copy order, never by positional peak indices. */
export function matchedClusterWindows(windows: ClusterWindow[], regions: ClusterPeak[]): { windows: RegionClusterWindow[]; refusal: string | null } {
  const ids = [...new Set(regions.map(p => p.match!.groupId))];
  const byGroup = ids.map(id => windows.flatMap(w => regions.filter(p => p.match?.groupId === id
    && (!p.match?.panelId || p.match.panelId === w.panel.id || w.panel.regionPanelGroup?.regionLabel === p.match.label)
    && (!w.panel.regionPanelGroup || ((w.panel.regionPanelGroup.id === id || w.panel.regionPanelGroup.id === p.match?.correspondenceId) && w.panel.regionPanelGroup.regionLabel === p.match?.label))
    && sameChrom(p.chrom ?? '', w.chrom) && (p.genome ?? null) === (w.panel.genome ?? null)
    && p.start >= w.start && p.end <= w.end)
    .sort((a, b) => (a.match?.copy ?? '').localeCompare(b.match?.copy ?? '') || a.start - b.start)
    .map((p, copy) => ({ w, p, copy, key: `${w.result_key}:${copy}` }))));
  const shared = byGroup.filter((_, i) => !regions.find(p => p.match!.groupId === ids[i])?.match?.memberSpecific);
  if (shared.some(g => g.map(x => x.key).join('|') !== shared[0].map(x => x.key).join('|')))
    return { windows: [], refusal: 'The selected groups cover different panels or copies: select one group, or groups over the same panels.' };
  return { refusal: null, windows: (shared[0] ?? []).map(({ w, p, key }) => {
    const own = byGroup.map(g => g.find(x => x.key === key)?.p);
    const present = own.filter((p): p is ClusterPeak => !!p);
    return { ...w, stateKey: w.result_key, result_key: `${w.result_key}@${ids.join('+')}:${p.match!.label}`,
      start: Math.min(...present.map(p => p.start)), end: Math.max(...present.map(p => p.end)), genome: w.panel.genome ?? null,
      region_label: p.match!.label,
      blocks: own.flatMap((p, feature) => p?.match?.blocks.map(b => ({ ...b, feature, reverse: p.match!.reversed })) ?? []) };
  }) };
}
