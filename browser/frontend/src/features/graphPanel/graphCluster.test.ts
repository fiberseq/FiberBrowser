/**
 * Graph primary G4/G5 (DESIGN_GRAPH_PRIMARY §3.4–3.5): canonical observations from every panel in the run (the host,
 * folded and popped-out members, other panels of the same path, native panels on the target), pop-outs adding none,
 * permutation invariance, union scopes, fan-out under record keys within each destination's scope, refinement within
 * carriers as one child node, the durable run and its selection sync.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useGraphStatusStore } from './statusStore';
import { useGraphBindingsStore } from './bindingsStore';
import { popOut, setPanelViewMode } from './hostMode';
import { registerGraphPanel } from './register';
import { assignWithGraphRun, commitGraphRun, destinationAssignments, graphClusterPlan, graphRequestBody, runGraphCluster, stableId } from './graphCluster';
import { deserializeSavedState, remapDatasetIds, serializeState } from '../../stores/historySlice';
import { useGraphSettings } from './handoff';
import { clusterSelectionKeys } from '../../utils/clusterMatchedRun';
import { clusterRunPlan, clusterWindows } from '../../utils/clusterTargets';
import { recordKey } from '../../utils/recordKeys';
import { branchScopesPanel } from '../../utils/readScopes';
import { clusterAssignmentForRead } from '../../components/tracks/read-track/readFilter';
import { addGraphRegion, runOutlines } from './runOutlines';
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
    activeClusterTreeNodeId: null, clusterTreeNodes: {}, clusterTreeRootIds: [], selectedPeaks: new Set(), peaksLocked: false } as never);
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
    const original = useBrowserStore.getState().getAllPeaks;
    useBrowserStore.setState({ selectedPeaks: new Set([0]), getAllPeaks: () => [{ index: 0, start: 128_655_000, end: 128_655_100, chrom: 'chr3' }] } as never);
    const run = clusterRunPlan(useBrowserStore.getState());
    expect(run.basis.kind).toBe('graph');
    expect(run.headline).toContain('graph columns');
    expect(run.rows.find(r => r.panelId === 'mat')!.inRun).toBe(true);
    useBrowserStore.setState(s => ({ panels: s.panels.map(p => p.id === 'mat'
      ? { ...p, graphView: { ...p.graphView!, handoff: { shown: 'linear' } } } : p) }));
    expect(clusterRunPlan(useBrowserStore.getState()).basis.kind).toBe('peaks');
    useBrowserStore.setState({ getAllPeaks: original, selectedPeaks: new Set() });
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

  it('a region drawn on the graph is a selected peak on the target, which the graph run clusters on', () => {
    seed(split());
    setPanelViewMode('mat', 'graph');
    addGraphRegion(128_657_300, 128_657_500, 'chr3');
    const s = useBrowserStore.getState();
    const peak = s.getAllPeaks().find(p => p.start === 128_657_300 && p.end === 128_657_500)!;
    expect(peak).toBeTruthy();
    expect(s.selectedPeaks.has(peak.index)).toBe(true);
    expect(clusterRunPlan(s).basis.kind).toBe('graph');
  });

  it('outlines the run\'s regions on the host\'s target lane', () => {
    const run = { graph: { registrationId: 'gp', target: 'tgt', regions: [{ start: 100, end: 200, mode: 'accessibility' }], observations: [], columns: {} } } as never;
    const scene = { rows: [{ key: 'tgt', top: 20, height: 10, bandTop: 30, bandHeight: 40 }], occurrences: [],
      targetMap: [{ x0: 0, x1: 1000, t0: 0, t1: 1000, kind: 'seq' }] } as never;
    expect(runOutlines(run, scene, 'gp', 'tgt')).toEqual([{ x0: 100, x1: 200, y0: 20, y1: 70, kind: 'region' }]);
    expect(runOutlines(run, scene, 'other', 'tgt')).toEqual([]);
  });
});


describe('G5: the durable run', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  function committed() {
    seed(split());
    setPanelViewMode('mat', 'graph');
    const p = plan();
    const id = (b: string) => p.observations.find(o => o.binding === b)!.id;
    commitGraphRun(useBrowserStore.getState(), p, {
      results: { [id('mat')]: { assignments: { [aid('m1')]: 0, [aid('m2')]: 1 } }, [id('pat')]: { assignments: { [aid('p1')]: 1 } } },
      label_ids: { '0': 0, '1': 1 }, names: {}, stages: [{ stage: 1, digest: 'x', model: { centroids: { 0: [0], 1: [1] } } }],
      columns: { shared: [], carrier_sets: [], left_out: {}, dropped: [], refinements: [] }, window_separation_nmi: null,
      matched: null, settings: { method: 'kmeans', k: 2 }, revisions: REG.revisions, options: {}, timings: {},
    } as never);
    return { p, id };
  }

  it('is saved with the session and restored with its colours and model', () => {
    committed();
    const saved = JSON.parse(JSON.stringify(serializeState(useBrowserStore.getState())));
    useBrowserStore.setState({ clusterMatchedRun: null, clusterAssignments: {} });
    useBrowserStore.setState(deserializeSavedState(saved));
    const s = useBrowserStore.getState();
    expect(s.clusterMatchedRun!.graph!.stages).toEqual([{ stage: 1, digest: 'x', model: { centroids: { 0: [0], 1: [1] } } }]);
    expect(s.clusterMatchedRun!.destinations!.map(d => d.stateKey).sort()).toEqual(['k-mat', 'k-pat']);
    expect(s.clusterAssignments['k-pat']).toEqual({ [recordKey(aid('p1'))!]: 1 });
  });

  it('dynamic assignment sends the stored model and adds only rows without a label', async () => {
    const { id } = committed();
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ results: {
        [id('mat')]: { assignments: { [aid('m1')]: 1, [aid('m2')]: 1, [aid('m3')]: 0 } },
        [id('pat')]: { assignments: { [aid('p1')]: 1 } } } }), { status: 200 });
    }));
    const added = await assignWithGraphRun(useBrowserStore.getState().clusterMatchedRun!);
    expect(added).toBe(1);
    expect(bodies[0].run.stages[0].digest).toBe('x');
    expect(bodies[0].run.revisions).toEqual(REG.revisions);
    const rk = (q: string) => recordKey(aid(q))!;
    // m1 keeps its label (0), never the reassigned 1; m3 is new.
    expect(useBrowserStore.getState().clusterAssignments['k-mat']).toEqual({ [rk('m1')]: 0, [rk('m2')]: 1, [rk('m3')]: 0 });
    // The run stays current (its displayed assignments are the live ones).
    expect(useBrowserStore.getState().clusterMatchedRun!.panelAssignments['k-mat']).toEqual(useBrowserStore.getState().clusterAssignments['k-mat']);
  });

  it('a pan asks for assignment with the same model; a refused model changes nothing', async () => {
    committed();
    // (The run's region selected and in view, as after a real run: a pan keeps the clusters, linear rules.)
    addGraphRegion(128_655_000, 128_655_100, 'chr3');
    vi.useFakeTimers();
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ status: 'error', error: { message: 'settings or geometry changed: cluster again' } }), { status: 409 });
    }));
    const before = JSON.stringify(useBrowserStore.getState().clusterAssignments);
    useBrowserStore.getState().setViewport('chr3', 128_651_000, 128_661_000);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toEqual(['/api/graph/cluster/assign']);
    expect(JSON.stringify(useBrowserStore.getState().clusterAssignments)).toBe(before);
  });
});


describe('review round 1 (G4/G5)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const response = (p: ReturnType<typeof plan>, labels: Record<string, Record<string, number>>) => ({
    results: Object.fromEntries(p.observations.map(o => [o.id, { assignments: labels[o.binding ?? 'linear'] ?? {} }])),
    label_ids: {}, names: {}, stages: [{ stage: 1 }], columns: { shared: [], carrier_sets: [], left_out: {}, dropped: [], refinements: [] },
    window_separation_nmi: null, matched: null, settings: {}, revisions: REG.revisions, options: {}, timings: {},
  }) as never;

  it('with the host targeted, popping out a member keeps it in the run', () => {
    seed(split());
    setPanelViewMode('mat', 'graph');
    useBrowserStore.setState({ selectedDatasets: new Set(['mat']) });
    const before = body();
    expect(JSON.parse(before).observations).toHaveLength(2);
    popOut('mat', ['pat']);
    expect(body()).toBe(before);
  });

  it('a graph subcluster labels the parent\'s linear rows of the same record, never Unassigned', () => {
    seed(split());
    setPanelViewMode('mat', 'graph');
    const linear = aid('m1', 'r:0', 2, '212');
    useBrowserStore.setState({ clusterAssignments: { 'k-mat': { [linear]: 0 } } });
    useBrowserStore.getState().captureActiveClusterTreeNode({ name: 'All reads' });
    useBrowserStore.setState({ selectedClusters: { 'k-mat': new Set([0]) } });
    const p = plan();
    commitGraphRun(useBrowserStore.getState(), p, response(p, { mat: { [aid('m1')]: 5 } }));
    const live = useBrowserStore.getState().clusterAssignments['k-mat'];
    expect(live[linear]).toBe(5);
    expect(clusterAssignmentForRead(live, { id: 'm1', analysis_id: linear, live_lift: {} })).toBe(5);
  });

  it('a response that lands after a move to another chromosome is refused', async () => {
    seed(split());
    setPanelViewMode('mat', 'graph');
    let release!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
    const run = runGraphCluster(useBrowserStore.getState(), { kind: 'peaks', regions: PEAKS } as never, () => {});
    useBrowserStore.setState({ chrom: 'chr5' });
    release(new Response(JSON.stringify({ results: {}, label_ids: {}, names: {}, stages: [], columns: { shared: [], carrier_sets: [], left_out: {}, dropped: [], refinements: [] } }), { status: 200 }));
    await expect(run).rejects.toThrow(/changed while clustering/);
    expect(useBrowserStore.getState().clusterMatchedRun).toBeNull();
  });

  it('dynamic assignment: only on the run\'s own branch, each destination in its own scope, later panels too', async () => {
    seed([...split(), panel('mat2', { liftHap: 'MAT', stateKey: 'k-mat2' })]);
    setPanelViewMode('mat', 'graph');
    useBrowserStore.setState({ filteredReadIds: { 'k-mat2': new Set(['m1']) } });
    const p = plan();
    commitGraphRun(useBrowserStore.getState(), p, response(p, { mat: { [aid('m1')]: 0 } }));
    const fetched: string[] = [];
    const mat = p.observations.find(o => o.binding === 'mat')!.id;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      fetched.push(url);
      return new Response(JSON.stringify({ results: { [mat]: { assignments: { [aid('m1')]: 0, [aid('m9')]: 1 } } } }), { status: 200 });
    }));
    // Another branch active: nothing is asked or written.
    const node = useBrowserStore.getState().activeClusterTreeNodeId;
    useBrowserStore.setState({ activeClusterTreeNodeId: 'other' });
    expect(await assignWithGraphRun(useBrowserStore.getState().clusterMatchedRun!)).toBe(0);
    expect(fetched).toEqual([]);
    useBrowserStore.setState({ activeClusterTreeNodeId: node });
    // A panel opened later on the MAT path (no filter) receives labels too; the narrow one only its own reads.
    useBrowserStore.setState(s => ({ panels: [...s.panels, panel('mat3', { liftHap: 'MAT', stateKey: 'k-mat3' })] }));
    await assignWithGraphRun(useBrowserStore.getState().clusterMatchedRun!);
    const s = useBrowserStore.getState();
    const rk = (q: string) => recordKey(aid(q))!;
    expect(s.clusterAssignments['k-mat2']).toEqual({ [rk('m1')]: 0 });
    expect(s.clusterAssignments['k-mat'][rk('m9')]).toBe(1);
    expect(s.clusterAssignments['k-mat3']).toEqual({ [rk('m1')]: 0, [rk('m9')]: 1 });
  });

  it('selection sync never reaches a linked source panel or another assembly\'s panel of the dataset', () => {
    seed(split());
    setPanelViewMode('mat', 'graph');
    const p = plan();
    commitGraphRun(useBrowserStore.getState(), p, response(p, { mat: { [aid('m1')]: 0 } }));
    const s = useBrowserStore.getState();
    const extra = { ...s, panels: [...s.panels, panel('src', { liftHap: 'MAT', stateKey: 'k-src', genome: 'hg002', liftLink: { sourcePanelId: 'mat' } as never }),
      panel('far', { liftHap: 'MAT', stateKey: 'k-far', viewportOverride: { chrom: 'chr9', start: 1, end: 2 } })] };
    const keys = clusterSelectionKeys(extra, 'k-mat');
    expect(keys).not.toContain('k-src');
    expect(keys).not.toContain('k-far');
  });

  it('dataset id remapping renames a graph run\'s observations', () => {
    seed(split());
    setPanelViewMode('mat', 'graph');
    const p = plan();
    commitGraphRun(useBrowserStore.getState(), p, response(p, { mat: { [aid('m1')]: 0 } }));
    const saved = remapDatasetIds(serializeState(useBrowserStore.getState()), { d: 'd2' });
    const run = (saved as any).clusterMatchedRun;
    expect(run.graph.observations.every((o: any) => o.dataset_id === 'd2')).toBe(true);
    expect(run.graph.observations.map((o: any) => o.id)).toEqual(p.observations.map(o => o.id));
  });
});


describe('review round 2 (G4/G5)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const response = (p: ReturnType<typeof plan>, labels: Record<string, Record<string, number>>) => ({
    results: Object.fromEntries(p.observations.map(o => [o.id, { assignments: labels[o.binding ?? 'linear'] ?? {} }])),
    label_ids: {}, names: {}, stages: [{ stage: 1 }], columns: { shared: [], carrier_sets: [], left_out: {}, dropped: [], refinements: [] },
    window_separation_nmi: null, matched: null, settings: {}, revisions: REG.revisions, options: {}, timings: {},
  }) as never;

  it('a response after a cohort change (settings saved: refresh generation) is refused', async () => {
    seed(split());
    setPanelViewMode('mat', 'graph');
    let release!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
    const run = runGraphCluster(useBrowserStore.getState(), { kind: 'peaks', regions: PEAKS } as never, () => {});
    useBrowserStore.setState(st => ({ refreshGeneration: (st.refreshGeneration ?? 0) + 1 }));
    release(new Response(JSON.stringify({ results: {} }), { status: 200 }));
    await expect(run).rejects.toThrow(/changed while clustering/);
  });

  it('a kept read (QNAME) inside a selected graph cluster (record keys) stays in the next run\'s scope', () => {
    seed(split());
    setPanelViewMode('mat', 'graph');
    const p = plan();
    commitGraphRun(useBrowserStore.getState(), p, response(p, { mat: { [aid('m1')]: 0, [aid('m2')]: 0 } }));
    useBrowserStore.setState({ filteredReadIds: { 'k-mat': new Set(['m1']) }, selectedClusters: { 'k-mat': new Set([0]) } });
    const w = clusterWindows(useBrowserStore.getState(), ['d']).find(x => x.result_key === 'k-mat')!;
    expect(w.read_ids).toEqual([recordKey(aid('m1'))]);
  });

  it('an independently clustered panel of the same path never joins the run\'s selection sync', () => {
    seed(split());
    setPanelViewMode('mat', 'graph');
    const p = plan();
    commitGraphRun(useBrowserStore.getState(), p, response(p, { mat: { [aid('m1')]: 0 } }));
    const s = useBrowserStore.getState();
    const later = { ...s, panels: [...s.panels, panel('own', { liftHap: 'MAT', stateKey: 'k-own' }), panel('same', { liftHap: 'MAT', stateKey: 'k-same' })],
      clusterAssignments: { ...s.clusterAssignments, 'k-own': { [aid('m1', 'r:0', 1, '17')]: 1 }, 'k-same': { [aid('m1', 'r:0', 1, '17')]: 0 } } };
    const keys = clusterSelectionKeys(later, 'k-mat');
    expect(keys).toContain('k-same');
    expect(keys).not.toContain('k-own');
  });
});


describe('review round 1 (agy G4)', () => {
  const refined = (p: ReturnType<typeof plan>) => {
    const id = (b: string) => p.observations.find(o => o.binding === b)!.id;
    return { results: { [id('mat')]: { assignments: { [aid('m1')]: 2, [aid('m2')]: 1 }, stage1: { [aid('m1')]: 0, [aid('m2')]: 1 } },
      [id('pat')]: { assignments: { [aid('p1')]: 0 }, stage1: { [aid('p1')]: 0 } } },
      label_ids: { '0': 0, '1': 1, '0.0': 2 }, names: { '2': 'C0.0' }, stages: [{ stage: 1 }, { stage: 2 }],
      columns: { shared: [], carrier_sets: [], left_out: {}, dropped: [], refinements: [] }, window_separation_nmi: null,
      matched: null, settings: {}, revisions: REG.revisions, options: {}, timings: {} } as never;
  };

  it('a refinement keeps every read shown, names its clusters across tree moves, and a re-run replaces it', () => {
    seed(split());
    setPanelViewMode('mat', 'graph');
    commitGraphRun(useBrowserStore.getState(), plan(), refined(plan()));
    let s = useBrowserStore.getState();
    const child = s.clusterTreeNodes[s.activeClusterTreeNodeId!];
    expect(child.refinement).toBe(true);
    expect(branchScopesPanel(child, 'k-mat')).toBe(false);
    s.applyClusterTreeNode(child.parentId!);
    useBrowserStore.getState().applyClusterTreeNode(child.id);
    expect(useBrowserStore.getState().clusterGroupLabels['k-mat']).toEqual({ 2: 'C0.0' });
    commitGraphRun(useBrowserStore.getState(), plan(), refined(plan()));
    s = useBrowserStore.getState();
    expect(Object.keys(s.clusterTreeNodes)).toHaveLength(2);
    expect(s.clusterTreeNodes[s.activeClusterTreeNodeId!].parentId).toBe(child.parentId);
  });

  it('a targeted pop-out targets its graph; panels off the target are left out; empty scopes are refused', () => {
    seed([...split(), panel('far', { liftHap: 'MAT', stateKey: 'k-far', viewportOverride: { chrom: 'chr9', start: 1, end: 100 } })]);
    setPanelViewMode('mat', 'graph');
    popOut('mat', ['pat']);
    useBrowserStore.setState({ selectedDatasets: new Set(['pat']) });
    expect(plan().observations.map(o => o.binding).sort()).toEqual(['mat', 'pat']);
    useBrowserStore.setState({ selectedDatasets: new Set() });
    expect(plan().destinations.map(d => d.stateKey)).not.toContain('k-far');
    expect(plan().leftOut.map(l => l.panelId)).toContain('far');
    useBrowserStore.setState({ filteredReadIds: { 'k-mat': new Set(), 'k-pat': new Set() } });
    expect(plan().refusal).toMatch(/nothing to cluster/);
  });
});

describe('review round 3 (Codex G5)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const response = (p: ReturnType<typeof plan>, labels: Record<string, Record<string, number>>) => ({
    results: Object.fromEntries(p.observations.map(o => [o.id, { assignments: labels[o.binding ?? 'linear'] ?? {} }])),
    label_ids: {}, names: {}, stages: [{ stage: 1 }], columns: { shared: [], carrier_sets: [], left_out: {}, dropped: [], refinements: [] },
    window_separation_nmi: null, matched: null, settings: {}, revisions: REG.revisions, options: {}, timings: {},
  }) as never;

  it('after a relabelling (a merge) the model is no longer used', async () => {
    seed(split());
    setPanelViewMode('mat', 'graph');
    const p = plan();
    commitGraphRun(useBrowserStore.getState(), p, response(p, { mat: { [aid('m1')]: 0, [aid('m2')]: 1 } }));
    const fetched: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { fetched.push(url); return new Response('{"results":{}}', { status: 200 }); }));
    const rk = (q: string) => recordKey(aid(q))!;
    useBrowserStore.getState().setClusterAssignments('k-mat', { [rk('m1')]: 0, [rk('m2')]: 0 });
    expect(await assignWithGraphRun(useBrowserStore.getState().clusterMatchedRun!)).toBe(0);
    expect(fetched).toEqual([]);
  });

  it('a later panel\'s labels are checked against its own dataset\'s labels only', () => {
    seed([...split(), panel('nat', { datasetId: 'n' })]);
    setPanelViewMode('mat', 'graph');
    const p = plan();
    commitGraphRun(useBrowserStore.getState(), p, response(p, { linear: { q1: 0 }, mat: { [aid('q1')]: 1 } }));
    const s = useBrowserStore.getState();
    const later = { ...s, panels: [...s.panels, panel('nat2', { datasetId: 'n', stateKey: 'k-nat2' })],
      clusterAssignments: { ...s.clusterAssignments, 'k-nat2': { q1: 1 } } };
    expect(clusterSelectionKeys(later, 'k-nat')).not.toContain('k-nat2');
  });
});


describe('final review (agy G5)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('labels assigned dynamically survive leaving the run\'s branch and coming back', async () => {
    seed(split());
    setPanelViewMode('mat', 'graph');
    const p = plan();
    const mat = p.observations.find(o => o.binding === 'mat')!.id;
    commitGraphRun(useBrowserStore.getState(), p, { results: { [mat]: { assignments: { [aid('m1')]: 0 }, stage1: { [aid('m1')]: 0 } } },
      label_ids: {}, names: {}, stages: [{ stage: 1 }], columns: { shared: [], carrier_sets: [], left_out: {}, dropped: [], refinements: [] },
      window_separation_nmi: null, matched: null, settings: {}, revisions: REG.revisions, options: {}, timings: {} } as never);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ results: { [mat]: { assignments: { [aid('m1')]: 0, [aid('m2')]: 1 } } } }), { status: 200 })));
    expect(await assignWithGraphRun(useBrowserStore.getState().clusterMatchedRun!)).toBe(1);
    const node = useBrowserStore.getState().activeClusterTreeNodeId!;
    expect(useBrowserStore.getState().clusterTreeNodes[node].assignments['k-mat'][recordKey(aid('m2'))!]).toBe(1);
  });
});
