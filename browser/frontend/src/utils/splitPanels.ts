/**
 * "Split into panels": one read panel per group (a feature pattern, an SV allele group, a plugin pack's grouping) of a
 * dataset, at the same
 * locus, navigating with the main view, so the subsets can be clustered on their own or co-clustered (Cluster with
 * several panels targeted clusters them in one space) and compared (per-panel metaprofiles, Clusters > Overview).
 *
 * "Group in this panel" (utils/featureClustering.ts) colours one panel's reads by the same groups; this opens panels.
 *
 * A split panel is an ordinary dataset panel with `readSubset` (types: ReadSubset): its own state key, a label and
 * colour in its header, and a membership rule (the run's grouping and the groups it shows). Its read names live in
 * stores/splitPanelStore.ts, resolved from the rule (again when a session reopens: the runs travel with the session);
 * a session also keeps the names, used (and said so) when a run is gone. SV allele groups belong to one view: those
 * panels keep their read names (a frozen rule).
 */
import { getFeatureStates } from '../api/features';
import { getClusterColor } from '../components/tracks/read-track/constants';
import { useBrowserStore } from '../stores/browserStore';
import { seedHistoryBaseline } from '../stores/historySlice';
import { useSplitPanelStore, type SplitSource } from '../stores/splitPanelStore';
import { generatePanelId } from '../stores/utils';
import { openSplitFrom } from '../stores/splitSources';
import { inComparisonGroup } from './panelNavigation';
import { splitClosing } from './panelExtensions';
import { sameChrom } from './chromAliases';
import { usePanelGenomeStore } from '../stores/panelGenomeStore';
import type { PanelConfig, ReadSubsetRule } from '../types';
import { featureNames, patternGroups, splitSourceForFeatures } from './featureClustering';
import type { FeatureRef } from '../stores/featureStore';

export { splitSourceForFeatures };

/** A split source a plugin pack adds (its groups from its own runs). */
export interface SplitSourceKind {
  kind: string;
  /** The groups, with their read names per dataset. */
  load: (source: SplitSource) => Promise<SplitGrouping>;
  /** The source a split panel's saved rule stands for (a reopened session), or null. */
  fromRule: (rule: ReadSubsetRule) => SplitSource | null;
  /** A rule's identity (the panels of one rule resolve together): its own fields, not the dataset or groups shown. */
  signature: (rule: ReadSubsetRule) => unknown;
  /** The split's name for its undo step and locus, when the grouping has no title. */
  title?: (rule: SplitGrouping['rule']) => string;
}

const sourceKinds = new Map<string, SplitSourceKind>();

export function registerSplitSourceKind(def: SplitSourceKind): void {
  sourceKinds.set(def.kind, def);
}

export function requestSplitForFeatures(features: FeatureRef[]): string | null {
  const source = splitSourceForFeatures(features);
  if (typeof source === 'string') return source;
  useSplitPanelStore.getState().request(source);
  return null;
}

export const MAX_SPLIT_PANELS = 8;
export const DEFAULT_SPLIT_TOP = 4;
export const BIN_COLOURS = { other: '#64748b', closed: '#9ca3af', na: '#cbd5e1' } as const;

export interface SplitGroup {
  key: string;
  label: string;
  count: number;
  colour: string;
  /** other: openings that fit no single variant ("other", V1+V3): they go in the Other bin. */
  kind: 'group' | 'other' | 'closed' | 'na';
  /** dataset -> read names */
  ids: Record<string, string[]>;
  /** Fields a panel of this group alone keeps on its rule (a plugin pack's: e.g. the insertions all its reads carry). */
  ruleExtras?: Partial<ReadSubsetRule>;
}

export interface SplitGrouping {
  /** A name the panels are prefixed with (a plugin pack's grouping of one element), "" otherwise. */
  title: string;
  /** Group names say it already ("N1 V2+ N2 V1−"); otherwise the title is prefixed. */
  rule: Omit<ReadSubsetRule, 'datasetId' | 'groupKeys'>;
  groups: SplitGroup[];
  /** The group labels name every variant already ("roo+ · hobo−"): panels are not prefixed with the title. */
  labelsComplete?: boolean;
  /** Where the groups were classified (a variant grouping's view), when the grouping knows it. */
  locus?: { chrom: string; start: number; end: number; label: string };
}

/** Read names per group key and dataset, from read -> group id per dataset. */
export function invert(byDataset: Record<string, Record<string, number>>, idToKey: Map<number, string>): Map<string, Record<string, string[]>> {
  const out = new Map<string, Record<string, string[]>>();
  for (const [ds, reads] of Object.entries(byDataset)) {
    for (const [name, id] of Object.entries(reads)) {
      const key = idToKey.get(id);
      if (key == null) continue;
      const ids = out.get(key) ?? {};
      (ids[ds] ??= []).push(name);
      out.set(key, ids);
    }
  }
  return out;
}

/** A pattern key with no member ("00."): a closed / none group. */
export const allZero = (key: string) => /^[0.]+$/.test(key) && key.includes('0');

/** The groups of a split source, with their read names per dataset. */
export async function loadSplitGrouping(source: SplitSource): Promise<SplitGrouping> {
  const plugin = sourceKinds.get(source.kind);
  if (plugin) return plugin.load(source);
  if (source.kind === 'patterns') {
    const states = await getFeatureStates(source.features);
    const input = patternGroups(states, source.features);
    const ids = invert(input.byDataset, new Map(input.groups.map(x => [x.id, x.key])));
    const locus = featuresLocus(source.features);
    return {
      title: '', rule: { kind: 'patterns', features: source.features },
      ...(locus ? { locus } : {}),
      groups: input.groups.map(x => ({
        key: x.key, label: x.label, count: x.count, colour: x.key === 'na' ? BIN_COLOURS.na : getClusterColor(x.id),
        kind: x.key === 'na' ? 'na' : allZero(x.key) ? 'closed' : 'group', ids: ids.get(x.key) ?? {},
      })),
    };
  }
  // The groups a panel shows now (an SV allele split): its read names, kept.
  if (source.kind !== 'frozen') throw new Error(`No split source of kind ${(source as { kind: string }).kind} in this build`);
  const s = useBrowserStore.getState();
  const panel = s.panels.find(p => p.id === source.panelId);
  const key = panel ? panel.stateKey ?? panel.datasetId ?? panel.id : '';
  const assignments = s.clusterAssignments[key] ?? {};
  const names = s.clusterGroupLabels[key] ?? {};
  const byId = new Map<number, string[]>();
  for (const [read, id] of Object.entries(assignments)) { const list = byId.get(id) ?? []; list.push(read); byId.set(id, list); }
  const ds = panel?.datasetId ?? '';
  return {
    title: source.title, rule: { kind: 'frozen' },
    groups: [...byId.entries()].sort((a, b) => a[0] - b[0]).map(([id, reads]) => {
      const label = names[id] ?? `Cluster ${id}`;
      return { key: String(id), label, count: reads.length, colour: getClusterColor(id),
        kind: /not informative/i.test(label) ? 'na' as const : 'group' as const, ids: { [ds]: reads } };
    }),
  };
}

// ---------------------------------------------------------------- the dialog's choices
export interface SplitRow {
  key: string;
  label: string;
  colour: string;
  kind: 'group' | 'other' | 'closed' | 'na';
  /** The grouping's groups it holds (one, or the bin's). */
  groupKeys: string[];
  count: number;
  checked: boolean;
}

/** The top `top` groups by reads, then the bins: other variants, closed / none, not informative. */
export function splitRows(grouping: SplitGrouping, top = DEFAULT_SPLIT_TOP): SplitRow[] {
  const candidates = grouping.groups.filter(g => g.kind === 'group').sort((a, b) => b.count - a.count);
  const shown = candidates.slice(0, Math.max(0, top));
  const rest = [...candidates.slice(Math.max(0, top)), ...grouping.groups.filter(g => g.kind === 'other')];
  const rows: SplitRow[] = shown.map(g => ({ key: g.key, label: g.label, colour: g.colour, kind: 'group', groupKeys: [g.key], count: g.count, checked: true }));
  const bin = (key: string, label: string, kind: SplitRow['kind'], groups: SplitGroup[], checked: boolean, colour: string) => {
    if (groups.length) rows.push({ key, label, colour, kind, groupKeys: groups.map(g => g.key), count: groups.reduce((n, g) => n + g.count, 0), checked });
  };
  bin('__other', rest.length === 1 ? rest[0].label : `Other variants (${rest.length})`, 'other', rest, rest.length > 0 && rows.length < MAX_SPLIT_PANELS,
    rest.length === 1 ? rest[0].colour : BIN_COLOURS.other);
  bin('__closed', grouping.groups.filter(g => g.kind === 'closed').length === 1 ? grouping.groups.find(g => g.kind === 'closed')!.label : 'Closed / none',
    'closed', grouping.groups.filter(g => g.kind === 'closed'), true, BIN_COLOURS.closed);
  bin('__na', 'Not informative', 'na', grouping.groups.filter(g => g.kind === 'na'), false, BIN_COLOURS.na);
  return rows;
}

/** The dataset panels a split starts from: the given ones, else one main-view panel per dataset of the grouping. */
export function splitSourcePanels(grouping: SplitGrouping, panelIds?: string[]): PanelConfig[] {
  const panels = useBrowserStore.getState().panels.filter(p => p.contentType === 'dataset' && p.datasetId && !p.readSubset);
  if (panelIds?.length) return panels.filter(p => panelIds.includes(p.id));
  const datasets = new Set(grouping.groups.flatMap(g => Object.keys(g.ids)));
  const out: PanelConfig[] = [];
  for (const ds of datasets) {
    const panel = panels.find(p => p.datasetId === ds && !p.viewportOverride && !p.collapsed) ?? panels.find(p => p.datasetId === ds);
    if (panel) out.push(panel);
  }
  return out;
}

export function splitPanelCount(rows: SplitRow[], sources: PanelConfig[]): number {
  return rows.filter(r => r.checked).length * sources.length;
}

/** The rule fields a row of one group keeps (its group's ruleExtras). */
function ruleExtrasOf(grouping: SplitGrouping, groupKeys: string[]): Partial<ReadSubsetRule> {
  if (groupKeys.length !== 1) return {};
  return grouping.groups.find(g => g.key === groupKeys[0])?.ruleExtras ?? {};
}

function idsFor(grouping: SplitGrouping, datasetId: string, groupKeys: string[]): string[] {
  return grouping.groups.filter(g => groupKeys.includes(g.key)).flatMap(g => g.ids[datasetId] ?? []);
}

const panelKey = (p: PanelConfig) => p.stateKey ?? p.datasetId ?? p.id;

/** Open the ticked rows as panels beside each source (one undo step). Returns the split set's id, or an error. */
export function openSplitPanels(grouping: SplitGrouping, rows: SplitRow[], sources: PanelConfig[],
  maxPanels = MAX_SPLIT_PANELS): { groupId: string } | { error: string } {
  const picked = rows.filter(r => r.checked);
  if (!picked.length || !sources.length) return { error: 'Tick at least one group, in a dataset shown in a panel.' };
  const total = picked.length * sources.length;
  if (total > maxPanels) {
    return { error: `That would open ${total} panels; at most ${maxPanels} at a time. Tick fewer groups (or put them in “Other”).` };
  }
  const groupId = `split-${Date.now().toString(36)}`;
  const made: PanelConfig[][] = [];
  const browser = useBrowserStore.getState();
  const reads: [string, string[]][] = [];
  for (const source of sources) {
    const ds = source.datasetId!;
    const list: PanelConfig[] = [];
    // Where the split is made (its reads are classified in this view) and what for: away from it the
    // panels say so (utils/splitLocus.ts).
    const view = source.viewportOverride ?? { chrom: browser.chrom, start: browser.start, end: browser.end };
    const svDef = grouping.rule.kind === 'frozen' ? browser.svSplits[panelKey(source)] : undefined;
    const locus = grouping.locus ?? {
      chrom: svDef?.chrom ?? view.chrom,
      start: Math.floor(svDef ? Math.min(svDef.viewStart, view.start) : view.start),
      end: Math.ceil(svDef ? Math.max(svDef.viewEnd, view.end) : view.end),
      label: svDef?.label ?? (grouping.title || featureTitle(grouping)),
    };
    picked.forEach((row, i) => {
      const ids = idsFor(grouping, ds, row.groupKeys);
      const id = generatePanelId();
      const stateKey = `${ds}:${groupId}:${i}`;
      const label = grouping.title && row.kind === 'group' && !grouping.labelsComplete ? `${grouping.title} · ${row.label}` : row.label;
      list.push({
        ...source,
        id, stateKey, collapsed: false, layoutColumn: undefined, heightFraction: undefined,
        subTracks: source.subTracks.map(t => ({ ...t })),
        // As a strand split's copy: out of the source's link and comparison groups (a comparison's copy keeps its locus).
        linkGroup: null,
        ...(inComparisonGroup(source) ? { ownLocus: true } : {}),
        regionLabel: undefined, contactRegionGroupId: undefined, contactRegionRole: undefined,
        genomeRegionGroupId: undefined, haplotypeGroup: undefined, haplotypeSide: undefined,
        collapsedByContactRegionGroup: undefined, collapsedByHaplotypeGroup: undefined,
        readSubset: {
          groupId, label, colour: row.colour, count: ids.length, sourcePanelId: source.id, locus,
          rule: { ...grouping.rule, datasetId: ds, groupKeys: row.groupKeys, ...(grouping.rule.kind === 'frozen' ? { readIds: ids } : {}),
            ...ruleExtrasOf(grouping, row.groupKeys) },
        },
        collapsedBySplitGroup: undefined,
      });
      reads.push([stateKey, ids]);
    });
    made.push(list);
  }
  const store = useBrowserStore.getState();
  seedHistoryBaseline(store, 'Before splitting into panels', 'layout');
  for (const [key, ids] of reads) useSplitPanelStore.getState().setReads(key, { ids: new Set(ids), state: 'ready' });
  useBrowserStore.setState(state => {
    let panels = [...state.panels];
    sources.forEach((source, i) => {
      const idx = panels.findIndex(p => p.id === source.id);
      if (idx < 0) return;
      // The source (every read) folds away while its split is open; closing the split shows it again.
      panels[idx] = { ...panels[idx], collapsed: true, collapsedBySplitGroup: groupId };
      panels = [...panels.slice(0, idx + 1), ...made[i], ...panels.slice(idx + 1)];
      // Side by side (as a strand split): every panel keeps the height to show its reads.
    });
    return {
      panels,
      ...(state.activeClusterTreeNodeId ? { activeClusterTreeNodeId: null } : {}),
      ...(state.dynamicClustering ? { dynamicClustering: false } : {}),
    };
  });
  const what = grouping.title || featureTitle(grouping);
  useBrowserStore.getState().pushSnapshot(`Split into panels${what ? ` by ${what}` : ''}`, { kind: 'layout' });
  return { groupId };
}

/** Where a feature pattern split's reads are classified: the features' span (one chromosome), not the view (the
 * features may be from an earlier run, elsewhere on the chromosome). */
function featuresLocus(features: FeatureRef[]): SplitGrouping['locus'] | undefined {
  if (!features.length || features.some(f => !f.chrom || f.start == null || f.end == null)) return undefined;
  const chrom = features[0].chrom!;
  if (features.some(f => !sameChrom(f.chrom!, chrom))) return undefined;
  return { chrom, start: Math.min(...features.map(f => f.start!)), end: Math.max(...features.map(f => f.end!)), label: featureNames(features) };
}

function featureTitle(grouping: SplitGrouping): string {
  if (grouping.rule.kind === 'patterns' && grouping.rule.features) return featureNames(grouping.rule.features);
  return sourceKinds.get(grouping.rule.kind)?.title?.(grouping.rule) ?? '';
}

/** Split sets being closed (a second click while the alt dataset is closed on the server does nothing). */
const closingSplits = new Set<string>();

/**
 * Close every panel of a split set and show its sources again (one undo step). Datasets a plugin pack built for its
 * panels (utils/panelExtensions.ts split hooks: an insert-expanded Carriers panel's alt dataset) go with them, in the
 * same step (Undo reopens both).
 */
export async function closeSplitPanels(groupId: string): Promise<void> {
  if (closingSplits.has(groupId)) return;
  const before = useBrowserStore.getState().panels.filter(p => p.readSubset?.groupId === groupId);
  if (!before.length) return;
  closingSplits.add(groupId);
  try {
    const closing = splitClosing(before);
    const released = closing ? await closing : { ids: [] as string[], closed: [] };
    // Closed on the server: out of the store too, whatever happened meanwhile (a panel still showing one is
    // rebuilt by its pack). Recorded only when this step took it out (not the reference toggle).
    const inStore = new Set(useBrowserStore.getState().datasets.map(d => d.id));
    const closed = released.closed.filter(d => inStore.has(d.id));
    const dropDatasets = () => {
      for (const id of released.ids) if (inStore.has(id)) useBrowserStore.getState().removeDataset(id);
      if (released.ids.length) void usePanelGenomeStore.getState().refresh();
    };
    const store = useBrowserStore.getState();
    const members = store.panels.filter(p => p.readSubset?.groupId === groupId);
    if (!members.length) { dropDatasets(); return; }  // gone meanwhile (Undo): nothing left to close
    seedHistoryBaseline(store, 'Before closing split panels', 'layout');
    dropDatasets();
    for (const p of members) useBrowserStore.getState().removePanel(p.id);
    // Its sources show again, unless another split still open came from one: that one stays folded (round 3, R16).
    useBrowserStore.setState(state => ({
      panels: state.panels.map(p => {
        if (p.collapsedBySplitGroup !== groupId) return p;
        const other = openSplitFrom(state.panels, p.id);
        if (other) return { ...p, collapsedBySplitGroup: other };
        const { collapsedBySplitGroup: _gone, ...rest } = p;
        return { ...rest, collapsed: false };
      }),
    }));
    useSplitPanelStore.getState().dropReads(members.map(panelKey));
    useBrowserStore.getState().pushSnapshot('Close split panels', { kind: 'layout', ...(closed.length ? { closedDatasets: closed } : {}) });
  } finally {
    closingSplits.delete(groupId);
  }
}

// ---------------------------------------------------------------- resolving a panel's reads from its rule
/** Read names a session kept for its split panels (the fallback when a rule's run is gone). */
let sessionFallback: Record<string, string[]> = {};
export function setSplitSessionFallback(value: unknown): void {
  sessionFallback = {};
  if (!value || typeof value !== 'object') return;
  for (const [key, ids] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(ids)) sessionFallback[key] = ids.filter((id): id is string => typeof id === 'string');
  }
}

/** The names to save with a session: every resolved split panel's. */
export function splitSessionReads(): Record<string, string[]> {
  const panels = useBrowserStore.getState().panels.filter(p => p.readSubset && !p.readSubset.rule.liftHap);
  const reads = useSplitPanelStore.getState().reads;
  const out: Record<string, string[]> = {};
  for (const p of panels) {
    const r = reads[panelKey(p)];
    if (r && (r.state === 'ready' || r.state === 'frozen')) out[panelKey(p)] = [...r.ids];
  }
  return out;
}

/** A rule's identity (panels of one rule resolve together): not which dataset and groups it shows. */
function ruleSignature(rule: ReadSubsetRule): string {
  const plugin = sourceKinds.get(rule.kind);
  return JSON.stringify([rule.kind, plugin ? plugin.signature(rule) : '',
    (rule.features ?? []).map(f => [f.kind, f.source, f.id, f.datasetId ?? ''])]);
}

function sourceOf(rule: ReadSubsetRule): SplitSource | null {
  const plugin = sourceKinds.get(rule.kind);
  if (plugin) return plugin.fromRule(rule);
  if (rule.kind === 'patterns' && rule.features?.length) return { kind: 'patterns', features: rule.features };
  return null;
}

const inFlight = new Set<string>();

/** Resolve every split panel whose reads are not known yet (one request per rule and session). */
export async function resolveSplitPanels(): Promise<void> {
  const generation = useSplitPanelStore.getState().generation;
  const panels = useBrowserStore.getState().panels.filter(p => p.readSubset && !p.readSubset.rule.liftHap);
  const store = useSplitPanelStore.getState();
  const todo = panels.filter(p => !store.reads[panelKey(p)]);
  const signatures = new Map<string, ReadSubsetRule>();
  for (const p of todo) {
    const rule = p.readSubset!.rule;
    if (rule.kind === 'frozen') {
      store.setReads(panelKey(p), { ids: new Set(rule.readIds ?? []), state: 'ready' });
      continue;
    }
    const sig = `${generation}|${ruleSignature(rule)}`;
    if (inFlight.has(sig)) continue;
    signatures.set(sig, rule);
  }
  // The panels of a rule when its answer arrives (the current ones: a panel added or restored meanwhile too).
  const panelsOf = (sig: string) => useBrowserStore.getState().panels
    .filter(p => p.readSubset && p.readSubset.rule.kind !== 'frozen' && `${generation}|${ruleSignature(p.readSubset.rule)}` === sig);
  await Promise.all([...signatures.entries()].map(async ([sig, rule]) => {
    inFlight.add(sig);
    for (const p of panelsOf(sig)) if (!useSplitPanelStore.getState().reads[panelKey(p)]) useSplitPanelStore.getState().setReads(panelKey(p), { ids: new Set(), state: 'loading' });
    let grouping: SplitGrouping | null = null;
    let failure = '';
    try {
      const source = sourceOf(rule);
      if (!source) throw new Error('This split panel has no rule to find its reads');
      grouping = await loadSplitGrouping(source);
    } catch (e) {
      failure = String((e as Error).message ?? e);
    } finally {
      inFlight.delete(sig);
    }
    // Another session meanwhile: its panels resolve on their own.
    if (useSplitPanelStore.getState().generation !== generation) return;
    for (const p of panelsOf(sig)) {
      const r = p.readSubset!.rule;
      if (grouping) {
        useSplitPanelStore.getState().setReads(panelKey(p), { ids: new Set(idsFor(grouping, r.datasetId, r.groupKeys)), state: 'ready' });
        continue;
      }
      const kept = sessionFallback[panelKey(p)];
      useSplitPanelStore.getState().setReads(panelKey(p), kept
        ? { ids: new Set(kept), state: 'frozen', message: 'The run this split came from is not in this session: these are the read names saved with it.' }
        : { ids: new Set(), state: 'error', message: `Its run is not in this session (${failure}). Rerun it, then split again.` });
    }
  }));
}
