/**
 * Graph primary G4/G5 (DESIGN_GRAPH_PRIMARY §3.4–3.5): canonical observations from every panel in the run (the host,
 * folded and popped-out members, other panels of the same path, native panels on the target), pop-outs adding none,
 * permutation invariance, union scopes, fan-out under record keys within each destination's scope, refinement within
 * carriers as one child node, the durable run and its selection sync.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useGraphStatusStore } from './statusStore';
import { useGraphBindingsStore } from './bindingsStore';
import { popOut, setPanelViewMode } from './hostMode';
import { registerGraphPanel } from './register';
import { commitGraphRun, destinationAssignments, graphClusterPlan, graphRequestBody, stableId } from './graphCluster';
import { useGraphSettings } from './handoff';
import { clusterSelectionKeys } from '../../utils/clusterMatchedRun';
import { clusterRunPlan } from '../../utils/clusterTargets';
import { recordKey } from '../../utils/recordKeys';
import { clusterAssignmentForRead } from '../../components/tracks/read-track/readFilter';
import { runOutlines } from './runOutlines';
import { requestFilterParamFromSets } from '../../components/tracks/read-track/useReadTrackData';
import type { GraphBinding, GraphReadBinding, GraphRegistration } from './types';
import type { PanelConfig } from '../../types';

registerGraphPanel();

const binding = (key: string, contig: string, sample: string): GraphBinding => ({
  key, path: { sample, haplotype: '0', contig }, assembly: sample, reference: sample, size: 200_000_000, size_inferred: false,
  fragments: [{ origin: 0, end: 200_000_000, indexed: true }], uncovered: [],
});
const REG: GraphRegistration = {
  id: 'gp', label: 'pkg', producer: 'fiberbrowser-graph', build_target: 't',
  revisions: { package: 'p'.repeat(64), graph: 'g'.repeat(64), db: 'd'.repeat(64), maps: 'm'.repeat(64) },
  bindings: [binding('tgt', 'chr3', 'GRCh38'), binding('mat', 'chr3_MAT', 'S1'), binding('pat', 'chr3_PAT', 'S1')],
  maps: [{ target: 'tgt', source: 'pat' }, { target: 'tgt', source: 'mat' }],
};
const BOUND: GraphReadBinding = { dataset_id: 'd', label: 'lifted', kind: 'lifted', revision: 'r1',
  paths: { mat: 'chr3_MAT', pat: 'chr3_PAT' }, haps: { mat: 'MAT', pat: 'PAT' }, problems: [], libraries: 1 };
const NATIVE: GraphReadBinding = { dataset_id: 'n', label: 'native', kind: 'native', revision: 'r2', paths: { tgt: 'chr3' }, problems: [], libraries: 1 };

const panel = (id: string, extra: Partial<PanelConfig> = {}): PanelConfig => ({
  id, contentType: 'dataset', datasetId: 'd', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, stateKey: `k-${id}`, ...extra,
});
const PEAKS = [{ start: 128_655_000, end: 128_655_100, mode: 'accessibility' }, { start: 128_656_200, end: 128_656_300, mode: 'accessibility' }];

function seed(panels: PanelConfig[]) {
  useGraphStatusStore.setState({ status: { helper: { available: true }, registrations: [REG] } as never, error: null, loading: false });
  useGraphBindingsStore.setState({ byDataset: { d: [{ registration: REG, binding: BOUND }], n: [{ registration: REG, binding: NATIVE }] },
    problems: {}, key: `d,n||${useBrowserStore.getState().refreshGeneration ?? 0}|gp@${REG.revisions.package}`, covered: ['d', 'n'], loading: false });
  useBrowserStore.setState({ panels, chrom: 'chr3', start: 128_650_000, end: 128_660_000, currentGenome: 'GRCh38', datasets: [
    { id: 'd', label: 'lifted', data_type: 'bam_livelift', color: '#123456' } as never,
    { id: 'n', label: 'native', data_type: 'bam', color: '#654321' } as never],
    selectedDatasets: new Set(), clusterAssignments: {}, clusterOrder: {}, filteredReadIds: {}, selectedReadIds: {},
    selectedClusters: {}, clusterFocus: {}, clusterMatchedRun: null, clusterGroupLabels: {}, fullViewPanelId: null,
    activeClusterTreeNodeId: null, clusterTreeNodes: {} });
}
const split = () => [panel('mat', { liftHap: 'MAT', liftHaplotypeMode: 'split' }), panel('pat', { liftHap: 'PAT', liftHaplotypeMode: 'split' })];
const plan = () => graphClusterPlan(useBrowserStore.getState(), { kind: 'peaks', regions: PEAKS })!;
const body = () => JSON.stringify(graphRequestBody(useBrowserStore.getState(), plan()));
const aid = (q: string, rec = 'r:0', row = 0, placement = 'primary') => `lift-cohort:v1 ${JSON.stringify([`lib|${q}`, q, rec, row, placement])}`;

beforeEach(() => { localStorage.clear(); useGraphSettings.getState().set({ outBp: 50_000, inBp: 40_000, defaultLiftedView: 'graph' }); });

describe('G4: canonical observations', () => {
  it('one observation per (dataset, path); the host, its folded member and a native panel', () => {
    seed([...split(), panel('nat', { datasetId: 'n' })]);
    setPanelViewMode('mat', 'graph');
    const p = plan();
    expect(p.host.id).toBe('mat');
    expect(p.observations.map(o => [o.kind, o.binding ?? null, o.dataset_id])).toEqual(expect.arrayContaining([
      ['graph', 'mat', 'd'], ['graph', 'pat', 'd'], ['linear', null, 'n']]));
    expect(p.observations).toHaveLength(3);
    expect(p.destinations.map(d => d.stateKey).sort()).toEqual(['k-mat', 'k-nat', 'k-pat']);
    expect(p.regions).toEqual(PEAKS);
  });

  it('opening or folding a pop-out never changes the request (pop-outs add no observations)', () => {
    seed(split());
    setPanelViewMode('mat', 'graph');
    const before = body();
    popOut('mat', ['pat']);
    expect(useBrowserStore.getState().panels.find(p => p.id === 'pat')!.collapsed).toBe(false);
    expect(body()).toBe(before);
  });

  it('panel and lane order never change the request', () => {
    seed([...split(), panel('nat', { datasetId: 'n' })]);
    setPanelViewMode('mat', 'graph');
    const before = body();
    useBrowserStore.setState(s => ({ panels: [...s.panels].reverse() }));
    expect(body()).toBe(before);
  });

  it('a linear panel of the same path is a destination of the graph observation, and scopes are unioned', () => {
    seed([...split(), panel('mat2', { liftHap: 'MAT', stateKey: 'k-mat2' })]);
    setPanelViewMode('mat', 'graph');
    useBrowserStore.setState({ filteredReadIds: { 'k-mat': new Set(['q2', 'q1']), 'k-mat2': new Set(['q3']) } });
    const p = plan();
    const mat = p.observations.find(o => o.binding === 'mat')!;
    expect(p.observations.filter(o => o.binding === 'mat')).toHaveLength(1);
    expect(mat.read_ids).toEqual(['q1', 'q2', 'q3']);
    // A destination with every read: the observation takes every read (each row fitted once).
    useBrowserStore.setState({ filteredReadIds: { 'k-mat': new Set(['q1']) } });
    expect(plan().observations.find(o => o.binding === 'mat')!.read_ids).toBeUndefined();
    expect(plan().destinations.find(d => d.stateKey === 'k-mat')!.scope).toEqual(['q1']);
  });

  it('observation ids are stable hashes', () => {
    expect(stableId(['d', 'graph', 'mat'])).toBe(stableId(['d', 'graph', 'mat']));
    expect(stableId(['d', 'graph', 'mat'])).not.toBe(stableId(['d', 'graph', 'pat']));
  });

  it('the Cluster plan names the graph run while the host draws its graph, and is linear after the hand-off', () => {
    seed(split());
    setPanelViewMode('mat', 'graph');
    useBrowserStore.setState({ selectedPeaks: new Set([0]), getAllPeaks: () => [{ index: 0, start: 128_655_000, end: 128_655_100, chrom: 'chr3' }] } as never);
    const run = clusterRunPlan(useBrowserStore.getState());
    expect(run.basis.kind).toBe('graph');
    expect(run.headline).toContain('graph columns');
    expect(run.rows.find(r => r.panelId === 'mat')!.inRun).toBe(true);
    useBrowserStore.setState(s => ({ panels: s.panels.map(p => p.id === 'mat'
      ? { ...p, graphView: { ...p.graphView!, handoff: { shown: 'linear' } } } : p) }));
    expect(clusterRunPlan(useBrowserStore.getState()).basis.kind).toBe('peaks');
  });
});

describe('G4: fan-out and refinement', () => {
  it('destinations get their scope\'s rows keyed by record key; linear rows of the same record read them', () => {
    const results = { o1: { assignments: { [aid('q1')]: 0, [aid('q2')]: 1, [aid('q3')]: 2 } } };
    const all = destinationAssignments({ stateKey: 'k', observations: ['o1'], panelId: 'p', scope: null }, results);
    expect(Object.keys(all)).toEqual([aid('q1'), aid('q2'), aid('q3')].map(a => recordKey(a)!));
    const some = destinationAssignments({ stateKey: 'k', observations: ['o1'], panelId: 'p', scope: ['q2', aid('q3', 'r:0', 4, '17')] }, results);
    expect(some).toEqual({ [recordKey(aid('q2'))!]: 1, [recordKey(aid('q3'))!]: 2 });
    // A linear row (its chain placement, another row index) of the same record finds its label by record key.
    expect(clusterAssignmentForRead(all, { id: 'q2', analysis_id: aid('q2', 'r:0', 3, '212'), live_lift: {} })).toBe(1);
  });

  it('a lifted panel\'s cluster scope reaches the server as QNAMEs (identities hold commas; filter_ids is a CSV)', () => {
    const param = requestFilterParamFromSets(new Set([aid('q1'), recordKey(aid('q2'))!, 'native_3']));
    expect(param.split(',').sort()).toEqual(['native', 'q1', 'q2']);
  });

  it('stage 1, then one child node refined within carriers; non-carriers keep their labels; the run is durable', () => {
    seed([...split(), panel('nat', { datasetId: 'n' })]);
    setPanelViewMode('mat', 'graph');
    const p = plan();
    const id = (b: string | null) => p.observations.find(o => (o.binding ?? null) === b)!.id;
    const response = {
      results: {
        [id('mat')]: { assignments: { [aid('m1')]: 2, [aid('m2')]: 1 }, stage1: { [aid('m1')]: 0, [aid('m2')]: 1 } },
        [id('pat')]: { assignments: { [aid('p1')]: 3 }, stage1: { [aid('p1')]: 0 } },
        [id(null)]: { assignments: { n1: 0, n2: 1 }, stage1: { n1: 0, n2: 1 } },
      },
      label_ids: { '0': 0, '1': 1, '0.0': 2, '0.1': 3 }, names: { '2': 'C0.0', '3': 'C0.1' },
      stages: [{ stage: 1 }, { stage: 2, set: 0, parent: '0' }],
      columns: { shared: [{ kind: 'target', length: 100, samples: 10, label: 'r1' }],
        carrier_sets: [{ carriers: [id('mat'), id('pat')], features: [{ kind: 'insertion', length: 2353, samples: 236, label: 'Alu', nodes: ['n1'] }] }],
        left_out: {}, dropped: [], refinements: [] },
      window_separation_nmi: 0.1, matched: { lengths: [100], balanced: false, balanced_fit_reads: 0, fit_reads: 5 },
      settings: { method: 'combinatorial' }, revisions: REG.revisions, options: {}, timings: {},
    };
    commitGraphRun(useBrowserStore.getState(), p, response as never);
    const s = useBrowserStore.getState();
    const rk = (q: string) => recordKey(aid(q))!;
    expect(s.clusterAssignments['k-mat']).toEqual({ [rk('m1')]: 2, [rk('m2')]: 1 });
    expect(s.clusterAssignments['k-pat']).toEqual({ [rk('p1')]: 3 });
    expect(s.clusterAssignments['k-nat']).toEqual({ n1: 0, n2: 1 });
    // One child node of the stage-1 node: going back up restores stage 1.
    const child = s.clusterTreeNodes[s.activeClusterTreeNodeId!];
    expect(child.name).toBe('Refined within carriers');
    const parent = s.clusterTreeNodes[child.parentId!];
    expect(parent.assignments['k-mat']).toEqual({ [rk('m1')]: 0, [rk('m2')]: 1 });
    expect(s.clusterGroupLabels['k-mat']).toEqual({ 2: 'C0.0', 3: 'C0.1' });
    const run = s.clusterMatchedRun!;
    expect(run.graph).toMatchObject({ registrationId: 'gp', target: 'tgt', regions: PEAKS, labelIds: response.label_ids });
    expect(run.windows.map(w => w.key).sort()).toEqual(p.observations.map(o => o.id).sort());
    // Selection sync: every destination, and a panel opened later on one of the run's paths.
    expect(clusterSelectionKeys(s, 'k-mat').sort()).toEqual(['k-mat', 'k-nat', 'k-pat']);
    const later = { ...s, panels: [...s.panels, panel('pat2', { liftHap: 'PAT', stateKey: 'k-pat2' })] };
    expect(clusterSelectionKeys(later, 'k-pat')).toContain('k-pat2');
    // Undo: one step back to before the run.
    useBrowserStore.getState().undo();
    expect(useBrowserStore.getState().clusterMatchedRun).toBeNull();
  });

  it('outlines the run\'s regions on the host\'s target lane', () => {
    const run = { graph: { registrationId: 'gp', target: 'tgt', regions: [{ start: 100, end: 200, mode: 'accessibility' }], observations: [], columns: {} } } as never;
    const scene = { rows: [{ key: 'tgt', top: 20, height: 10, bandTop: 30, bandHeight: 40 }], occurrences: [],
      targetMap: [{ x0: 0, x1: 1000, t0: 0, t1: 1000, kind: 'seq' }] } as never;
    expect(runOutlines(run, scene, 'gp', 'tgt')).toEqual([{ x0: 100, x1: 200, y0: 20, y1: 70, kind: 'region' }]);
    expect(runOutlines(run, scene, 'other', 'tgt')).toEqual([]);
  });
});
