import '../testSetup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessibilityGroups, AccessibilityResult, AccessibilitySplit } from './api';
import type { FeatureStates } from '../../api/features';

const api = vi.hoisted(() => ({ groups: null as unknown, split: null as unknown, states: null as unknown, calls: [] as unknown[] }));
vi.mock('./api', async importOriginal => ({
  ...(await importOriginal<typeof import('./api')>()),
  getAccessibilityGroups: vi.fn(async (job: string, nfr: string) => { api.calls.push(['groups', job, nfr]); return api.groups; }),
  splitAccessibilityReads: vi.fn(async (job: string, body: unknown) => { api.calls.push(['split', job, body]); return api.split; }),
}));
vi.mock('../../api/features', () => ({
  getFeatureStates: vi.fn(async (features: unknown) => { api.calls.push(['states', features]); return api.states; }),
}));

import { useAccessibilityStore } from './accessibilityStore';
import { useBrowserStore } from '../../stores/browserStore';
import { useReadActionsStore } from '../../stores/readActionsStore';
import { featureKey, nextSelection, normalizeFeatureRefs, useFeatureStore, type FeatureRef } from '../../stores/featureStore';
import { nextSortRequest } from '../../utils/sortRequests';
import { serializeState } from '../../stores/historySlice';
import { keepSvSplitsInView } from '../../stores/svSlice';
import { buildClusterAssignmentRows } from '../../utils/clusterExport';
import {
  clusterSelectedFeatures, featurePeakRegions, filterBySelectedFeatures, orderByStates, patternGroups, sortBySelectedFeatures,
} from '../../utils/featureClustering';
import { groupReadsByNfrVariant, planCombinatorial, splitReadsByElements } from './nfrGrouping';
import { groupingIsCurrent, restoreReadGroups } from '../../utils/readGroups';

const v = (nfr: string, name: string, L: number, R: number) => ({
  id: `${nfr}:${name}`, nfr, name, start: L, end: R, L, R, Lsd: 5, Rsd: 5, width: R - L, depth: '', relation: 'full',
  prevalence: 0.3, strict: 0.25, ci: null, only: 0, with_ref: 0, gain_nats: 1, stability: 1, exp_reads: 10, robust: null, by_channel: {},
});
const RESULT = {
  region: { chrom: 'chr19', start: 1000, end: 5000 }, datasets: [{ dataset_id: 'ds1', chemistry: 'ddda', molecules: 6 }],
  parameters: {}, nfrs: [
    { id: 'N1', start: 1400, end: 1800, variants: [v('N1', 'V1', 1400, 1700), v('N1', 'V2', 1500, 1800)], status: 'ok', configurations: [], depth_states: [], reads: 6, callable: 6 },
    { id: 'N2', start: 3000, end: 3300, variants: [v('N2', 'V1', 3000, 3300)], status: 'ok', configurations: [], depth_states: [], reads: 6, callable: 6 },
  ],
  elements: [
    { id: 'N1:V1', kind: 'nfr', subtype: 'variant', nfr: 'N1', start: 1400, end: 1700, label: 'N1 V1 full', prevalence: .3, n: 6 },
    { id: 'N1:V2', kind: 'nfr', subtype: 'variant', nfr: 'N1', start: 1500, end: 1800, label: 'N1 V2 full', prevalence: .3, n: 6 },
    { id: 'N2:V1', kind: 'nfr', subtype: 'variant', nfr: 'N2', start: 3000, end: 3300, label: 'N2 V1 full', prevalence: .3, n: 6 },
    { id: 'class_007', class_id: 'class_007', kind: 'tf', subtype: 'class', start: 1600, end: 1630, label: 'class 007', prevalence: .2, n: 6 },
  ],
  pairs: [], combos: { elements: ['N2:V1', 'N1:V1', 'N1:V2'], labels: [], n: 6, n_spanning: 6, n_shared_excluded: 0, status: 'ok', patterns: [] },
} as unknown as AccessibilityResult;

const GROUPS: AccessibilityGroups = {
  job_id: 'job1', nfr: 'N1', variants: [{ name: 'V1', start: 1400, end: 1700 }, { name: 'V2', start: 1500, end: 1800 }],
  groups: [
    { id: 0, label: 'V1', display_label: 'V1', count: 2, pattern: [1, 0] },
    { id: 1, label: 'V2', display_label: 'V2', count: 2, pattern: [0, 1] },
    { id: 2, label: 'closed', display_label: 'closed', count: 2, pattern: [0, 0] },
  ],
  by_dataset: { ds1: { r1: 0, r2: 0, r3: 1, r4: 1, r5: 2, r6: 2 } },
};
const SPLIT = {
  job_id: 'job1', kind: 'combination', elements: ['N2:V1', 'N1:V1', 'N1:V2'], short: ['N2 V1', 'N1 V1', 'N1 V2'],
  groups: [
    { id: 0, key: '110', label: 'N2 V1+ N1 V1+ N1 V2−', molecules: 3, count: 3, pattern: [1, 1, 0] },
    { id: 1, key: '001', label: 'N2 V1− N1 V1− N1 V2+', molecules: 2, count: 2, pattern: [0, 0, 1] },
    { id: 2, key: 'na', label: 'Not informative', molecules: 1, count: 1, pattern: null },
  ],
  by_dataset: { ds1: { r1: 0, r2: 0, r3: 0, r4: 1, r5: 1, r6: 2 } }, ambiguous_reads: {}, excluded: {}, excluded_text: {},
} as unknown as AccessibilitySplit;

const ref = (kind: FeatureRef['kind'], id: string, extra: Partial<FeatureRef> = {}): FeatureRef =>
  ({ kind, source: kind === 'fp-class' ? 'cls1' : 'job1', id, chrom: 'chr19', start: 1400, end: 1800, label: id.replace(':', ' '), ...extra });

const DATASET = { id: 'ds1', available_layers: { tf_rc: true } };
function reset() {
  api.calls = [];
  useBrowserStore.setState({
    datasets: [DATASET], panels: [{ id: 'p1', contentType: 'dataset', datasetId: 'ds1', subTracks: [] }], selectedDatasets: new Set(), chrom: 'chr19',
    clusterAssignments: {}, clusterOrder: {}, clusterFocus: {}, clusterPatterns: {}, clusterPeakRegions: [], clusterCentroids: {},
    clusterPeakWidths: [], dynamicClustering: false, svSplits: {}, clusterGroupLabels: {}, clusterTreeNodes: {}, activeClusterTreeNodeId: null,
    readSortOrder: {}, jupyterReadOrder: {}, selectedClusters: {}, filteredReadIds: {}, readFilterSources: {}, activeReadIds: {}, selectedFeatures: [], _historyStack: [], _historyPointer: -1,
  } as never);
  useAccessibilityStore.setState({ jobId: 'job1', result: RESULT, applied: [], generation: 0 });
  useFeatureStore.setState({ nfrRuns: { job1: { jobId: 'job1', result: RESULT, datasetIds: ['ds1'], createdAt: 1, classJobId: 'cls1' } }, hovered: null });
}

describe('feature selection', () => {
  beforeEach(reset);
  it('a click selects one feature; shift adds and removes; the key separates class datasets', () => {
    const a = ref('nfr-variant', 'N1:V1'), b = ref('nfr-variant', 'N1:V2');
    let sel = nextSelection([], a, false);
    expect(sel).toEqual([a]);
    sel = nextSelection(sel, b, true);
    expect(sel.map(f => f.id)).toEqual(['N1:V1', 'N1:V2']);
    expect(nextSelection(sel, a, true).map(f => f.id)).toEqual(['N1:V2']);
    expect(nextSelection(sel, b, false)).toEqual([b]);
    expect(featureKey(ref('fp-class', 'A', { datasetId: 'x' }))).not.toBe(featureKey(ref('fp-class', 'A', { datasetId: 'y' })));
    useBrowserStore.getState().selectFeature(a);
    useBrowserStore.getState().selectFeature(b, true);
    expect(useBrowserStore.getState().selectedFeatures.map(f => f.id)).toEqual(['N1:V1', 'N1:V2']);
  });

  it('is saved with the state (sessions, undo) and validated when read back', () => {
    useBrowserStore.getState().setSelectedFeatures([ref('nfr-variant', 'N1:V1'), ref('fp-class', 'A', { datasetId: 'ds1' })]);
    const saved = serializeState(useBrowserStore.getState() as never) as unknown as { selectedFeatures: FeatureRef[] };
    expect(saved.selectedFeatures.map(f => f.id)).toEqual(['N1:V1', 'A']);
    expect(normalizeFeatureRefs([...saved.selectedFeatures, { kind: 'fp-class', source: 's', id: 'B' }, { kind: 'peak', source: 's', id: 'x' }, null])
      .map(f => f.id)).toEqual(['N1:V1', 'A']);   // a class without its dataset and unknown kinds are dropped
  });
});

describe('which grouping a selection gets (combinatorial)', () => {
  beforeEach(reset);
  const runs = () => ({ job1: { result: RESULT, classJobId: 'cls1' } });
  it('an NFR, or every variant of one NFR: Group reads by variant', () => {
    expect(planCombinatorial([ref('nfr', 'N1')], runs())).toMatchObject({ kind: 'configurations', nfrId: 'N1' });
    expect(planCombinatorial([ref('nfr-variant', 'N1:V2'), ref('nfr-variant', 'N1:V1')], runs())).toMatchObject({ kind: 'configurations', nfrId: 'N1' });
  });
  it('elements of one run: its combination split, in the order the panel button uses', () => {
    const plan = planCombinatorial([ref('nfr-variant', 'N1:V1'), ref('nfr-variant', 'N1:V2'), ref('nfr-variant', 'N2:V1')], runs());
    expect(plan).toMatchObject({ kind: 'split', elements: ['N2:V1', 'N1:V1', 'N1:V2'] });   // result.combos.elements
    const mixed = planCombinatorial([ref('nfr-variant', 'N2:V1'), ref('fp-class', 'class_007', { datasetId: 'ds1' })], runs());
    expect(mixed).toMatchObject({ kind: 'split', elements: ['N2:V1', 'class_007'] });       // a class joined to the run
  });
  it('anything else: patterns of per-read states; too many: refused with a reason', () => {
    expect(planCombinatorial([ref('nfr-variant', 'N1:V1')], runs())).toEqual({ kind: 'patterns' });
    expect(planCombinatorial([ref('nfr-variant', 'N1:V1'), ref('fp-class', 'other', { datasetId: 'ds1' })], runs())).toEqual({ kind: 'patterns' });
    const many = Array.from({ length: 9 }, (_, i) => ref('fp-class', `c${i}`, { datasetId: 'ds1' }));
    expect(planCombinatorial(many, runs())).toMatchObject({ kind: 'refuse' });
    expect(planCombinatorial([], runs())).toMatchObject({ kind: 'refuse' });
  });
});

/** What the read panels hold after a grouping: assignments, order, patterns, names (and so colours: cluster ids). */
const snapshot = () => {
  const s = useBrowserStore.getState();
  return { a: s.clusterAssignments, o: s.clusterOrder, p: s.clusterPatterns, l: s.clusterGroupLabels, r: s.clusterPeakRegions };
};

describe('toolbar Cluster (combinatorial) == the panel buttons', () => {
  beforeEach(reset);
  it('Group reads by variant: the same groups, names and colours (cluster ids)', async () => {
    api.groups = GROUPS;
    await groupReadsByNfrVariant('job1', 'N1', { ds1: ['ds1'] });     // the panel's button
    const panel = snapshot();
    reset();
    api.groups = GROUPS;
    useBrowserStore.setState({ clusterMethod: 'combinatorial' } as never);
    useBrowserStore.getState().setSelectedFeatures([ref('nfr', 'N1')]);
    expect(await clusterSelectedFeatures()).toBeNull();
    expect(snapshot()).toEqual(panel);
    expect(panel.l.ds1).toEqual({ 0: 'V1', 1: 'V2', 2: 'closed' });
    expect(useAccessibilityStore.getState().applied.at(-1)?.kind).toBe('configurations');   // the panel's bar shows it (Clear)
  });

  it('Split by combination pattern: the same groups and names, mixed with a joined class too', async () => {
    api.split = SPLIT;
    await splitReadsByElements('job1', { elements: RESULT.combos!.elements }, RESULT, { ds1: ['ds1'] });
    const panel = snapshot();
    reset();
    api.split = SPLIT;
    useBrowserStore.getState().setSelectedFeatures(['N1:V2', 'N2:V1', 'N1:V1'].map(id => ref('nfr-variant', id)));
    expect(await clusterSelectedFeatures()).toBeNull();
    expect(api.calls).toEqual([['split', 'job1', { elements: ['N2:V1', 'N1:V1', 'N1:V2'] }]]);
    expect(snapshot()).toEqual(panel);
    expect(panel.l.ds1[0]).toBe('N2 V1+ N1 V1+ N1 V2−');
    // A TSV of the groups has the group column.
    const rows = buildClusterAssignmentRows({
      clusterAssignments: useBrowserStore.getState().clusterAssignments, clusterGroupLabels: useBrowserStore.getState().clusterGroupLabels,
    });
    expect(rows.find(r => r.read_id === 'r6')?.group).toBe('Not informative');
    expect(rows.find(r => r.read_id === 'r1')?.group).toBe('N2 V1+ N1 V1+ N1 V2−');
  });

  it('patterns of per-read states (classes, single variants): grouped by size, unevaluated reads not informative', async () => {
    api.states = {
      features: [
        { kind: 'nfr-variant', source: 'job1', id: 'N1:V1', dataset_id: null, datasets: ['ds1'], label: 'N1 V1', span: [1400, 1700], members: {}, evaluated: {} },
        { kind: 'fp-class', source: 'cls9', id: 'A', dataset_id: 'ds1', datasets: ['ds1'], label: 'A', span: null, members: {}, evaluated: {} },
      ],
      by_dataset: { ds1: { r1: '11', r2: '11', r3: '10', r4: '0.', r5: '01', r6: '11' } },
    } satisfies FeatureStates;
    useBrowserStore.getState().setSelectedFeatures([ref('nfr-variant', 'N1:V1'), ref('fp-class', 'A', { source: 'cls9', datasetId: 'ds1', label: 'Class 3' })]);
    expect(await clusterSelectedFeatures()).toBeNull();
    const s = useBrowserStore.getState();
    // Ties by pattern ('01' before '10'), as the combination split orders them.
    expect(s.clusterAssignments.ds1).toEqual({ r1: 0, r2: 0, r6: 0, r5: 1, r3: 2, r4: 3 });
    expect(s.clusterGroupLabels.ds1).toEqual({ 0: 'N1 V1+ C3+', 1: 'N1 V1− C3+', 2: 'N1 V1+ C3−', 3: 'Not informative' });
    expect(s.clusterPatterns).toEqual({ 0: [1, 1], 1: [0, 1], 2: [1, 0] });
    expect(s._historyStack.at(-1)).toMatchObject({ kind: 'clustering' });
  });

  it('Clear and undo bring the previous grouping back with its names; a pan that keeps the groups keeps the names', async () => {
    api.groups = GROUPS;
    useBrowserStore.setState({ clusterAssignments: { ds1: { r1: 3 } }, clusterOrder: { ds1: [3] } } as never);
    useBrowserStore.getState().pushSnapshot('Cluster reads', { kind: 'clustering' });
    const applied = await groupReadsByNfrVariant('job1', 'N1', { ds1: ['ds1'] });
    // keepSvSplitsInView: names stay while the groups stay, and go with them.
    const state = useBrowserStore.getState();
    expect(keepSvSplitsInView(state, {}, 'chr19', 0, 10).clusterGroupLabels).toBeUndefined();
    expect(keepSvSplitsInView(state, { clusterAssignments: {} }, 'chr19', 0, 10).clusterGroupLabels).toEqual({});
    restoreReadGroups(applied!.grouping);
    expect(useBrowserStore.getState().clusterAssignments.ds1).toEqual({ r1: 3 });
    expect(useBrowserStore.getState().clusterGroupLabels.ds1).toBeUndefined();
    useBrowserStore.getState().undo();
    expect(groupingIsCurrent(applied!.grouping)).toBe(true);
    expect(useBrowserStore.getState().clusterGroupLabels.ds1).toEqual({ 0: 'V1', 1: 'V2', 2: 'closed' });
  });
});

describe('toolbar Sort and Filter on features; non-combinatorial Cluster regions', () => {
  beforeEach(reset);
  const STATES: FeatureStates = {
    features: [
      { kind: 'nfr-variant', source: 'job1', id: 'N1:V1', dataset_id: null, datasets: ['ds1'], label: 'N1 V1', span: null, members: {}, evaluated: {} },
      { kind: 'nfr-variant', source: 'job1', id: 'N2:V1', dataset_id: null, datasets: ['ds1'], label: 'N2 V1', span: null, members: {}, evaluated: {} },
    ],
    by_dataset: { ds1: { a: '00', b: '11', c: '10', d: '..', e: '01' } },
  };
  it('signal filters invalidate a pending feature sort', async () => {
    api.states = STATES;
    useBrowserStore.getState().setSelectedFeatures([ref('nfr-variant', 'N1:V1')]);
    const pending = sortBySelectedFeatures();
    useBrowserStore.getState().setSignalFilters({ requireDetectable: true });
    expect(await pending).toContain('not applied');
    expect(useBrowserStore.getState().readSortOrder).toEqual({});
  });

  it('a newer metric sort supersedes a pending feature sort', async () => {
    api.states = STATES;
    useBrowserStore.getState().setSelectedFeatures([ref('nfr-variant', 'N1:V1'), ref('nfr-variant', 'N2:V1')]);
    const pending = sortBySelectedFeatures();
    nextSortRequest();
    useBrowserStore.getState().setReadSortOrder('ds1', ['d', 'a', 'e', 'c', 'b']);
    expect(await pending).toContain('not applied');
    expect(useBrowserStore.getState().readSortOrder.ds1).toEqual(['d', 'a', 'e', 'c', 'b']);
  });

  it('sort: members of more features first, then by pattern; an undo step', async () => {
    expect(orderByStates(STATES.by_dataset.ds1)).toEqual(['b', 'c', 'e', 'a', 'd']);
    api.states = STATES;
    useBrowserStore.getState().setSelectedFeatures([ref('nfr-variant', 'N1:V1'), ref('nfr-variant', 'N2:V1')]);
    expect(await sortBySelectedFeatures()).toBeNull();
    expect(useBrowserStore.getState().readSortOrder.ds1).toEqual(['b', 'c', 'e', 'a', 'd']);
    expect(useBrowserStore.getState().sortSelection).toBe('features');
  });
  it('feature sort leaves a collapsed source alone and intersects cluster selection with the filter', async () => {
    api.states = STATES;
    const panel = useBrowserStore.getState().panels[0];
    useBrowserStore.setState({
      panels: [{ ...panel, collapsed: true }, { ...panel, id: 'copy', stateKey: 'copy' }],
      selectedClusters: { copy: new Set([1]) },
      clusterAssignments: { copy: { a: 1, b: 1, c: 1, d: 0, e: 0 } },
      filteredReadIds: { copy: new Set(['a', 'b', 'e']) },
      readSortOrder: { ds1: ['d', 'a'], copy: ['a', 'e', 'b', 'd', 'c'] },
      selectedFeatures: [ref('nfr-variant', 'N1:V1')],
    });
    expect(await sortBySelectedFeatures()).toBeNull();
    expect(useBrowserStore.getState().readSortOrder).toEqual({ ds1: ['d', 'a'], copy: ['b', 'e', 'a', 'd', 'c'] });
  });

  it('feature sort refuses a moved independent panel while applying to its unchanged peer', async () => {
    api.states = STATES;
    const panel = useBrowserStore.getState().panels[0];
    useBrowserStore.setState({ panels: [panel, { ...panel, id: 'copy', stateKey: 'copy' }],
      selectedClusters: {}, selectedFeatures: [ref('nfr-variant', 'N1:V1')] });
    const pending = sortBySelectedFeatures();
    useBrowserStore.setState(s => ({ panels: s.panels.map(p => p.id === 'copy'
      ? { ...p, viewportOverride: { chrom: 'chr19', start: 100000, end: 101000 } } : p) }));
    expect(await pending).toContain('not applied there');
    expect(useBrowserStore.getState().readSortOrder.ds1).toEqual(['b', 'c', 'e', 'a', 'd']);
    expect(useBrowserStore.getState().readSortOrder.copy).toBeUndefined();
  });

  it('filter: in every / any / no selected feature', async () => {
    api.states = STATES;
    useBrowserStore.setState({ activeReadIds: { ds1: ['a', 'b', 'outside'] } } as never);
    useBrowserStore.getState().setSelectedFeatures([ref('nfr-variant', 'N1:V1'), ref('nfr-variant', 'N2:V1')]);
    await filterBySelectedFeatures('all');
    expect([...useBrowserStore.getState().filteredReadIds.ds1!]).toEqual(['b']);
    await filterBySelectedFeatures('any');
    expect([...useBrowserStore.getState().filteredReadIds.ds1!].sort()).toEqual(['b', 'c', 'e']);
    expect(useBrowserStore.getState().readFilterSources.ds1?.label).toMatch(/^Features > in any selected feature/);
    // In no selected feature: the members are hidden as excluded reads (every other read stays, loaded or not).
    await filterBySelectedFeatures('none');
    expect([...useReadActionsStore.getState().excludedReadIds.ds1!].sort()).toEqual(['b', 'c', 'e']);
  });
  it('non-combinatorial Cluster: spans on their layers (accessibility; the TF class layer)', () => {
    expect(featurePeakRegions([ref('nfr-variant', 'N1:V1', { start: 1400.5, end: 1700 }), ref('fp-class', 'A', { datasetId: 'ds1', start: 1600, end: 1630.5 })]))
      .toEqual([{ start: 1400, end: 1700, mode: 'accessibility' }, { start: 1600, end: 1631, mode: 'tf_rc' }]);
  });
  it('patternGroups on its own: a class applies only to its dataset', () => {
    const out = patternGroups({
      features: [{ kind: 'fp-class', source: 'c', id: 'A', dataset_id: 'ds1', datasets: ['ds1'], label: 'A', span: null, members: {}, evaluated: {} }],
      by_dataset: { ds1: { r1: '1', r2: '0' }, ds2: { q: '1' } },
    }, [ref('fp-class', 'A', { datasetId: 'ds1', label: 'Class 1' })]);
    expect(out.byDataset).toEqual({ ds1: { r1: 1, r2: 0 } });
    expect(out.groups.map(g => g.label)).toEqual(['C1−', 'C1+']);
  });
});

describe('review fixes', () => {
  beforeEach(reset);
  it('a dataset of the run that is not targeted keeps its clusters', async () => {
    api.groups = { ...GROUPS, by_dataset: { ds1: GROUPS.by_dataset.ds1, ds2: { q1: 0 } } };
    useBrowserStore.setState({ clusterAssignments: { ds2: { q1: 7 } } } as never);
    await groupReadsByNfrVariant('job1', 'N1', { ds1: ['ds1'] });
    expect(useBrowserStore.getState().clusterAssignments.ds2).toEqual({ q1: 7 });
    expect(useBrowserStore.getState().clusterAssignments.ds1).toEqual(GROUPS.by_dataset.ds1);
  });
  it('an answer after navigation or undo is not applied', async () => {
    let release!: () => void;
    api.groups = new Promise(r => { release = () => r(GROUPS); });
    useBrowserStore.getState().setSelectedFeatures([ref('nfr', 'N1')]);
    const pending = clusterSelectedFeatures();
    useBrowserStore.setState({ start: 1234 } as never);
    release();
    expect(await pending).toMatch(/not applied/);
    expect(useBrowserStore.getState().clusterAssignments).toEqual({});
  });
  it('the only variant of an NFR is its configurations, as the panel button', () => {
    const one = { ...RESULT, nfrs: [RESULT.nfrs[1]] } as AccessibilityResult;
    expect(planCombinatorial([ref('nfr-variant', 'N2:V1')], { job1: { result: one } })).toMatchObject({ kind: 'configurations', nfrId: 'N2' });
  });
});
