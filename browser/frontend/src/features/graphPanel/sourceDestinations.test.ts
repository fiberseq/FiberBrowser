/**
 * Source-view pop-outs are peers of the graph (DESIGN_GRAPH_PRIMARY §4.2 "lifted path, source view"; Codex review,
 * group H): a linked source panel (P3) on a lifted member's haplotype is a destination of graph runs through its
 * source rows — the same records as the graph rows, named there by QNAME — for label fan-out, dynamic assignment
 * and selection sync.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useGraphStatusStore } from './statusStore';
import { useGraphBindingsStore } from './bindingsStore';
import { popOut, setPanelViewMode } from './hostMode';
import { registerGraphPanel } from './register';
import { assignWithGraphRun, commitGraphRun, destinationAssignments, graphClusterPlan, labelLinkedSource } from './graphCluster';
import { useGraphSettings } from './handoff';
import { graphRunStateKeys, linkedSourceObservations, sourceLabels } from '../../utils/clusterMatchedRun';
import { mirroredSelections } from './selectionSync';
import { popOutPaths, seedSourceState, setPopOutKind } from './popOutKind';
import type { GraphBinding, GraphReadBinding, GraphRegistration } from './types';
import type { PanelConfig } from '../../types';
import { clusteredReadIdSet, filterReadsByReadIdSet } from '../../components/tracks/read-track/readFilter';
import { recordKey } from '../../utils/recordKeys';
import { deserializeSavedState, serializeState } from '../../stores/historySlice';

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

const panel = (id: string, extra: Partial<PanelConfig> = {}): PanelConfig => ({
  id, contentType: 'dataset', datasetId: 'd', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, stateKey: `k-${id}`, ...extra,
});
const source = (id: string, hap: '1' | '2', label: 'MAT' | 'PAT', extra: Partial<PanelConfig> = {}) => panel(id, { datasetId: 'src', genome: 'S1',
  viewportOverride: { chrom: `chr3_${label}`, start: 1000, end: 11_000 }, stateKey: `${id}~lift-source`,
  liftLink: { id: `l-${id}`, datasetId: 'd', liftPanelId: 'mat', hap, hapLabel: label, contig: `chr3_${label}`, flip: false, chain: null } as never, ...extra });
const PEAKS = [{ start: 128_655_000, end: 128_655_100, mode: 'accessibility' }];
const aid = (q: string, rec = 'r:0', row = 0) => `lift-cohort:v1 ${JSON.stringify([`lib|${q}`, q, rec, row, 'primary'])}`;

function seed(panels: PanelConfig[]) {
  useGraphStatusStore.setState({ status: { helper: { available: true }, registrations: [REG] } as never, error: null, loading: false });
  useGraphBindingsStore.setState({ byDataset: { d: [{ registration: REG, binding: BOUND }] },
    problems: {}, key: `d,src||${useBrowserStore.getState().refreshGeneration ?? 0}|gp@${REG.revisions.package}`, covered: ['d', 'src'], loading: false });
  useBrowserStore.setState({ panels, chrom: 'chr3', start: 128_650_000, end: 128_660_000, currentGenome: 'GRCh38', datasets: [
    { id: 'd', label: 'lifted', data_type: 'bam_livelift', color: '#123456' } as never,
    { id: 'src', label: 'source', data_type: 'bam', color: '#654321' } as never],
    selectedDatasets: new Set(), clusterAssignments: {}, clusterOrder: {}, filteredReadIds: {}, selectedReadIds: {},
    selectedClusters: {}, clusterFocus: {}, clusterMatchedRun: null, clusterGroupLabels: {}, fullViewPanelId: null,
    activeClusterTreeNodeId: null, clusterTreeNodes: {}, clusterTreeRootIds: [], selectedPeaks: new Set(), peaksLocked: false } as never);
}
const split = () => [panel('mat', { liftHap: 'MAT', liftHaplotypeMode: 'split' }), panel('pat', { liftHap: 'PAT', liftHaplotypeMode: 'split' })];
const plan = () => graphClusterPlan(useBrowserStore.getState(), { kind: 'peaks', regions: PEAKS })!;
const response = (results: Record<string, { assignments: Record<string, number> }>) => ({ results, label_ids: { '0': 0, '1': 1 }, names: {},
  stages: [{ stage: 1 }], columns: { shared: [], carrier_sets: [], left_out: {}, dropped: [], refinements: [] },
  window_separation_nmi: null, matched: null, settings: {}, revisions: REG.revisions, options: {}, timings: {} }) as never;

beforeEach(() => { localStorage.clear(); useGraphSettings.getState().set({ outBp: 50_000, inBp: 40_000, defaultLiftedView: 'graph' }); });

describe('a linked source panel is a destination of graph runs', () => {
  it('the planner makes it a QNAME destination of its haplotype\'s observation, adding no observation or scope', () => {
    seed([...split(), source('srcP', '2', 'PAT')]);
    setPanelViewMode('mat', 'graph');
    const p = plan();
    const pat = p.observations.find(o => o.binding === 'pat')!;
    expect(p.observations).toHaveLength(2);
    expect(p.leftOut.map(l => l.panelId)).not.toContain('srcP');
    expect(p.destinations.find(d => d.panelId === 'srcP')).toMatchObject({ stateKey: 'srcP~lift-source', observations: [pat.id], keyBy: 'qname' });
    // A filter on the source panel scopes its own labels, never the fit.
    useBrowserStore.setState({ filteredReadIds: { 'srcP~lift-source': new Set(['q1']) } });
    expect(plan().observations.find(o => o.binding === 'pat')!.read_ids).toBeUndefined();
  });

  it('labels fan out by QNAME within its scope; a fitted label wins over "not a carrier"', () => {
    const dest = { stateKey: 's', observations: ['o1', 'o2'], panelId: 'srcP', scope: ['q1', 'q2'], keyBy: 'qname' as const };
    expect(destinationAssignments(dest, { o1: { assignments: { [aid('q1')]: -2, [aid('q3')]: 1 } }, o2: { assignments: { [aid('q1', 'r:1')]: 0, [aid('q2')]: 1 } } }))
      .toEqual({ q1: 0, q2: 1 });
    expect(sourceLabels({ assignments: { o1: { [aid('q9')]: 3 } } }, ['o1'])).toEqual({ q9: 3 });
  });

  it('a run labels it; a source view opened later joins the run, takes its labels at once, and is reached by dynamic assignment', async () => {
    seed([...split(), source('srcP', '2', 'PAT')]);
    setPanelViewMode('mat', 'graph');
    const p = plan();
    const pat = p.observations.find(o => o.binding === 'pat')!.id;
    const mat = p.observations.find(o => o.binding === 'mat')!.id;
    commitGraphRun(useBrowserStore.getState(), p, response({ [pat]: { assignments: { [aid('q1')]: 0, [aid('q2')]: 1 } }, [mat]: { assignments: { [aid('m1')]: 1 } } }));
    expect(useBrowserStore.getState().clusterAssignments['srcP~lift-source']).toEqual({ q1: 0, q2: 1 });
    // A MAT source view opened after the run.
    useBrowserStore.setState(s => ({ panels: [...s.panels, source('srcM', '1', 'MAT')] }));
    const run = useBrowserStore.getState().clusterMatchedRun!;
    expect(graphRunStateKeys(run, useBrowserStore.getState().panels, 'chr3', useBrowserStore.getState().clusterAssignments)).toContain('srcM~lift-source');
    expect(labelLinkedSource('srcM')).toBe(1);
    expect(useBrowserStore.getState().clusterAssignments['srcM~lift-source']).toEqual({ m1: 1 });
    // Dynamic assignment labels its new rows by QNAME.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ results: { [mat]: { assignments: { [aid('m1')]: 1, [aid('m2')]: 0 } } } }), { status: 200 })));
    await assignWithGraphRun(useBrowserStore.getState().clusterMatchedRun!);
    vi.unstubAllGlobals();
    expect(useBrowserStore.getState().clusterAssignments['srcM~lift-source']).toEqual({ m1: 1, m2: 0 });
  });

  it('an independently clustered source panel does not join', () => {
    seed([...split()]);
    setPanelViewMode('mat', 'graph');
    const p = plan();
    const mat = p.observations.find(o => o.binding === 'mat')!.id;
    commitGraphRun(useBrowserStore.getState(), p, response({ [mat]: { assignments: { [aid('m1')]: 1 } } }));
    useBrowserStore.setState(s => ({ panels: [...s.panels, source('srcM', '1', 'MAT')], clusterAssignments: { ...s.clusterAssignments, 'srcM~lift-source': { m1: 5 } } }));
    const st = useBrowserStore.getState();
    expect(graphRunStateKeys(st.clusterMatchedRun!, st.panels, 'chr3', st.clusterAssignments)).not.toContain('srcM~lift-source');
    expect(labelLinkedSource('srcM')).toBe(0);
  });

  it('selection syncs between the graph\'s members and its linked source views, by QNAME', () => {
    seed([...split(), source('srcP', '2', 'PAT')]);
    setPanelViewMode('mat', 'graph');
    const panels = useBrowserStore.getState().panels;
    const fromSource = mirroredSelections(panels, 'srcP~lift-source', new Set(), new Set(['q1']), {});
    expect(fromSource.map(([k, add]) => [k, add])).toEqual(expect.arrayContaining([['k-mat', ['q1']], ['k-pat', ['q1']]]));
    const fromMember = mirroredSelections(panels, 'k-pat', new Set(), new Set([aid('q2')]), {});
    expect(fromMember.map(([k, add]) => [k, add])).toEqual(expect.arrayContaining([['srcP~lift-source', ['q2']]]));
  });

  it('a source-kind pop-out reveals the open source view with the run\'s labels, in one undo step', async () => {
    seed([...split(), source('srcP', '2', 'PAT', { collapsed: true })]);
    setPanelViewMode('mat', 'graph');
    const p = plan();
    const pat = p.observations.find(o => o.binding === 'pat')!.id;
    commitGraphRun(useBrowserStore.getState(), p, response({ [pat]: { assignments: { [aid('q1')]: 0 } } }));
    expect(useBrowserStore.getState().clusterAssignments['srcP~lift-source']).toBeUndefined();
    setPopOutKind('mat', 'source');
    const steps = useBrowserStore.getState()._historyStack?.length ?? 0;
    popOutPaths('mat', ['pat']);
    await new Promise(r => setTimeout(r, 0));
    const get = (id: string) => useBrowserStore.getState().panels.find(x => x.id === id)!;
    expect(get('srcP').collapsed).toBe(false);
    expect(useBrowserStore.getState().clusterAssignments['srcP~lift-source']).toEqual({ q1: 0 });
    expect(useBrowserStore.getState()._historyStack?.length).toBe(steps + 1);
    useBrowserStore.getState().undo();
    expect(get('srcP').collapsed).toBe(true);
  });

  it('round 2: revealing a source panel clustered on its own keeps its clusters and names, and it is not made a destination', async () => {
    seed([...split(), source('srcP', '2', 'PAT', { collapsed: true })]);
    useBrowserStore.setState({ clusterAssignments: { 'srcP~lift-source': { q1: 1 } }, clusterGroupLabels: { 'srcP~lift-source': { 1: 'mine' } } } as never);
    setPanelViewMode('mat', 'graph');
    const p = plan();
    const pat = p.observations.find(o => o.binding === 'pat')!.id;
    commitGraphRun(useBrowserStore.getState(), p, { ...(response({ [pat]: { assignments: { [aid('q1')]: 0, [aid('q2')]: 1 } } }) as object), names: { 1: 'C0.1' } } as never);
    expect(useBrowserStore.getState().clusterAssignments['srcP~lift-source']).toEqual({ q1: 1 });
    expect(labelLinkedSource('srcP')).toBe(0);
    setPopOutKind('mat', 'source');
    popOutPaths('mat', ['pat']);
    await new Promise(r => setTimeout(r, 0));
    const st = useBrowserStore.getState();
    expect(st.panels.find(x => x.id === 'srcP')!.collapsed).toBe(false);
    expect(st.clusterAssignments['srcP~lift-source']).toEqual({ q1: 1 });
    expect(st.clusterGroupLabels['srcP~lift-source']?.[1]).toBe('mine');
    expect((st.clusterMatchedRun?.destinations ?? []).some(d => d.stateKey === 'srcP~lift-source')).toBe(false);
  });

  it('round 2: a strand-split source panel takes only its own strand\'s observation, never the other strand\'s label', () => {
    seed([...split(), panel('patCT', { liftHap: 'PAT', strand: 'CT' }), panel('patGA', { liftHap: 'PAT', strand: 'GA' }),
      source('srcGA', '2', 'PAT', { strand: 'GA' }), source('srcCT', '2', 'PAT', { strand: 'CT' })]);
    setPanelViewMode('mat', 'graph');
    const p = plan();
    const ct = p.observations.find(o => o.binding === 'pat' && o.strand === 'CT')!;
    const ga = p.observations.find(o => o.binding === 'pat' && o.strand === 'GA')!;
    expect(ct && ga).toBeTruthy();
    expect(p.destinations.find(d => d.panelId === 'srcCT')!.observations).toEqual([ct.id]);
    expect(p.destinations.find(d => d.panelId === 'srcGA')!.observations).toEqual([ga.id]);
    commitGraphRun(useBrowserStore.getState(), p, response({ [ga.id]: { assignments: { [aid('q1', 'r:1')]: 1 } }, [ct.id]: { assignments: { [aid('q1', 'r:0')]: 0 } } }));
    expect(useBrowserStore.getState().clusterAssignments['srcCT~lift-source']).toEqual({ q1: 0 });
    expect(useBrowserStore.getState().clusterAssignments['srcGA~lift-source']).toEqual({ q1: 1 });
    // An unsplit source panel with only strand observations takes them all.
    expect(linkedSourceObservations([ct, ga] as never, source('x', '2', 'PAT')).length).toBe(2);
  });

  it('round 3: a pooled host\'s labels reach a source view only for its haplotype, by provenance, also after a merge', () => {
    seed([panel('pool', { liftHaplotypeMode: 'pooled' }), source('srcP', '2', 'PAT', { collapsed: true })]);
    setPanelViewMode('pool', 'graph');
    const p = plan();
    const mat = p.observations.find(o => o.binding === 'mat')!.id;
    const pat = p.observations.find(o => o.binding === 'pat')!.id;
    // One QNAME with a record on each haplotype; one MAT-only QNAME.
    commitGraphRun(useBrowserStore.getState(), p, response({ [mat]: { assignments: { [aid('q', 'm:0')]: 0, [aid('mOnly', 'm:1')]: 0 } },
      [pat]: { assignments: { [aid('q', 'p:0')]: 1 } } }));
    expect(useBrowserStore.getState().activeClusterTreeNodeId).toBeTruthy();
    // A merge relabels the host (the run is no longer the shown labels).
    useBrowserStore.setState(s => ({ clusterAssignments: { ...s.clusterAssignments, 'k-pool': { ...s.clusterAssignments['k-pool'], [aid('mOnly', 'm:1')]: 1 } } }));
    seedSourceState('pool', 'srcP');
    expect(useBrowserStore.getState().clusterAssignments['srcP~lift-source']).toEqual({ q: 1 });
  });

  it('round 3: with no provenance, a pooled host\'s labels give a source view none (never another haplotype\'s)', () => {
    seed([panel('pool', { liftHaplotypeMode: 'pooled' }), source('srcP', '2', 'PAT')]);
    useBrowserStore.setState({ clusterAssignments: { 'k-pool': { [aid('q', 'm:0')]: 0, [aid('q', 'p:0')]: 1 } } } as never);
    seedSourceState('pool', 'srcP');
    expect(useBrowserStore.getState().clusterAssignments['srcP~lift-source']).toBeUndefined();
  });

  it('round 3: the source view\'s clusters are on every tree node: switching to the root and back keeps labels, order, focus and names', () => {
    seed([...split(), source('srcP', '2', 'PAT')]);
    const node = (id: string, parentId: string | null, assignments: Record<string, number>, order: number[], focus: number[] | null, names?: Record<number, string>) => ({
      id, parentId, name: id, createdAt: 0, chrom: 'chr3', start: 128_650_000, end: 128_660_000, sourceClusterIds: [], clusterMethod: 'kmeans', clusterK: 2,
      subnucleosomalThreshold: 0, accessibilityThreshold: 0, peakRegions: [], selectedPeakIndices: [], peakModes: {}, patterns: {}, dynamicClustering: false,
      assignments: { 'k-pat': assignments }, order: { 'k-pat': order }, focus: { 'k-pat': focus }, ...(names ? { groupLabels: { 'k-pat': names } } : {}) });
    const rootLabels = { [aid('q1')]: 0, [aid('q2')]: 1 }, childLabels = { [aid('q1')]: 3, [aid('q2')]: 4 };
    useBrowserStore.setState({ clusterTreeNodes: { r: node('r', null, rootLabels, [0, 1], null), c: node('c', 'r', childLabels, [4, 3], [4], { 3: 'C3', 4: 'C4' }) },
      clusterTreeRootIds: ['r'], activeClusterTreeNodeId: 'c', clusterAssignments: { 'k-pat': childLabels }, clusterOrder: { 'k-pat': [4, 3] },
      clusterFocus: { 'k-pat': new Set([4]) }, clusterGroupLabels: { 'k-pat': { 3: 'C3', 4: 'C4' } } } as never);
    seedSourceState('pat', 'srcP');
    const key = 'srcP~lift-source';
    const shown = () => { const st = useBrowserStore.getState(); return { a: st.clusterAssignments[key], o: st.clusterOrder[key], f: st.clusterFocus[key] ? [...st.clusterFocus[key]!] : null, n: st.clusterGroupLabels[key] }; };
    expect(shown()).toEqual({ a: { q1: 3, q2: 4 }, o: [4, 3], f: [4], n: { 3: 'C3', 4: 'C4' } });
    useBrowserStore.getState().applyClusterTreeNode('r');
    expect(useBrowserStore.getState().clusterAssignments[key]).toEqual({ q1: 0, q2: 1 });
    useBrowserStore.getState().applyClusterTreeNode('c');
    expect(shown()).toEqual({ a: { q1: 3, q2: 4 }, o: [4, 3], f: [4], n: { 3: 'C3', 4: 'C4' } });
  });

  it('agy round 2: reopening a collapsed source view seeds it like a new one (read state, clusters on every node, order, focus, names)', async () => {
    seed([...split(), source('srcP', '2', 'PAT', { collapsed: true })]);
    setPanelViewMode('mat', 'graph');
    const node = (id: string, parentId: string | null, assignments: Record<string, number>, order: number[], focus: number[] | null, names?: Record<number, string>) => ({
      id, parentId, name: id, createdAt: 0, chrom: 'chr3', start: 128_650_000, end: 128_660_000, sourceClusterIds: [], clusterMethod: 'kmeans', clusterK: 2,
      subnucleosomalThreshold: 0, accessibilityThreshold: 0, peakRegions: [], selectedPeakIndices: [], peakModes: {}, patterns: {}, dynamicClustering: false,
      assignments: { 'k-pat': assignments }, order: { 'k-pat': order }, focus: { 'k-pat': focus }, ...(names ? { groupLabels: { 'k-pat': names } } : {}) });
    const rootLabels = { [aid('q1')]: 0, [aid('q2')]: 1 }, childLabels = { [aid('q1')]: 3, [aid('q2')]: 4 };
    useBrowserStore.setState({ clusterTreeNodes: { r: node('r', null, rootLabels, [0, 1], null), c: node('c', 'r', childLabels, [4, 3], [4], { 3: 'C3', 4: 'C4' }) },
      clusterTreeRootIds: ['r'], activeClusterTreeNodeId: 'c', clusterAssignments: { 'k-pat': childLabels }, clusterOrder: { 'k-pat': [4, 3] },
      clusterFocus: { 'k-pat': new Set([4]) }, clusterGroupLabels: { 'k-pat': { 3: 'C3', 4: 'C4' } },
      filteredReadIds: { 'k-pat': new Set([aid('q1'), aid('q2')]) }, selectedReadIds: { 'k-pat': new Set([aid('q1')]) } } as never);
    setPopOutKind('mat', 'source');
    popOutPaths('mat', ['pat']);
    await new Promise(r => setTimeout(r, 0));
    const key = 'srcP~lift-source';
    const st = useBrowserStore.getState();
    expect(st.panels.find(x => x.id === 'srcP')!.collapsed).toBe(false);
    expect([...st.filteredReadIds[key]!].sort()).toEqual(['q1', 'q2']);
    expect([...st.selectedReadIds[key]!]).toEqual(['q1']);
    expect(st.clusterAssignments[key]).toEqual({ q1: 3, q2: 4 });
    expect(st.clusterOrder[key]).toEqual([4, 3]);
    expect([...st.clusterFocus[key]!]).toEqual([4]);
    expect(st.clusterGroupLabels[key]).toEqual({ 3: 'C3', 4: 'C4' });
    useBrowserStore.getState().applyClusterTreeNode('r');
    expect(useBrowserStore.getState().clusterAssignments[key]).toEqual({ q1: 0, q2: 1 });
  });

  it('agy round 2: a source view takes the member\'s filter before the run labels it: filtered-out reads get no label, and its destination is scoped', async () => {
    seed([...split(), source('srcP', '2', 'PAT', { collapsed: true })]);
    setPanelViewMode('mat', 'graph');
    const p = plan();
    const pat = p.observations.find(o => o.binding === 'pat')!.id;
    commitGraphRun(useBrowserStore.getState(), p, response({ [pat]: { assignments: { [aid('q1')]: 0, [aid('q2')]: 1 } } }));
    useBrowserStore.setState(s => ({ filteredReadIds: { ...s.filteredReadIds, 'k-pat': new Set([aid('q1')]) } }));
    setPopOutKind('mat', 'source');
    popOutPaths('mat', ['pat']);
    await new Promise(r => setTimeout(r, 0));
    const st = useBrowserStore.getState();
    expect(st.clusterAssignments['srcP~lift-source']).toEqual({ q1: 0 });
    expect(st.clusterMatchedRun!.destinations!.find(d => d.stateKey === 'srcP~lift-source')!.scope).toEqual(['q1']);
  });

  it('post-merge A1 #2: reopening a source view clustered on its own keeps its order and focus when its label numbers equal the member\'s', async () => {
    seed([...split(), source('srcP', '2', 'PAT', { collapsed: true })]);
    const key = 'srcP~lift-source';
    const s = useBrowserStore.getState();
    // The same reads in the same numbered groups, but clustered on the source itself (no graph run gave them).
    s.setClusterAssignments(key, { q1: 0, q2: 1 });
    s.setClusterAssignments('k-pat', { [aid('q1')]: 0, [aid('q2')]: 1 });
    s.setClusterOrder(key, [1, 0]);
    s.setClusterOrder('k-pat', [0, 1]);
    s.setClusterFocus(key, new Set([1]));
    s.setClusterFocus('k-pat', new Set([0]));
    useBrowserStore.setState(x => ({ clusterGroupLabels: { ...x.clusterGroupLabels, [key]: { 1: 'mine' }, 'k-pat': { 0: 'theirs' } } }));
    setPanelViewMode('mat', 'graph');
    expect(useBrowserStore.getState().clusterMatchedRun).toBeNull();
    setPopOutKind('mat', 'source');
    popOutPaths('mat', ['pat']);
    await new Promise(r => setTimeout(r, 0));
    const st = useBrowserStore.getState();
    expect(st.panels.find(x => x.id === 'srcP')!.collapsed).toBe(false);
    expect(st.clusterAssignments[key]).toEqual({ q1: 0, q2: 1 });
    expect(st.clusterOrder[key]).toEqual([1, 0]);
    expect([...st.clusterFocus[key]!]).toEqual([1]);
    expect(st.clusterGroupLabels[key]).toEqual({ 1: 'mine' });
  });

  it('post-merge A1 #3: a reopened source view with its own filter takes no labels for the reads it filters out, so its own reads stay shown', async () => {
    seed([...split(), source('srcP', '2', 'PAT', { collapsed: true })]);
    const key = 'srcP~lift-source';
    useBrowserStore.setState({ filteredReadIds: { [key]: new Set(['q3']) } } as never);
    setPanelViewMode('mat', 'graph');
    const p = plan();
    const pat = p.observations.find(o => o.binding === 'pat')!.id;
    commitGraphRun(useBrowserStore.getState(), p, response({ [pat]: { assignments: { [aid('q1')]: 0, [aid('q2')]: 1 } } }));
    setPopOutKind('mat', 'source');
    popOutPaths('mat', ['pat']);
    await new Promise(r => setTimeout(r, 0));
    const st = useBrowserStore.getState();
    expect([...st.filteredReadIds[key]!]).toEqual(['q3']);
    expect(Object.keys(st.clusterAssignments[key] ?? {})).toEqual([]);
    const shown = filterReadsByReadIdSet(filterReadsByReadIdSet([{ id: 'q3' }], st.filteredReadIds[key]), clusteredReadIdSet(st.clusterAssignments[key] ?? {}));
    expect(shown).toEqual([{ id: 'q3' }]);
  });

  it('post-merge A1 #3: seeding scopes the live labels and every tree node\'s to the source\'s filter, and keeps focus only on groups it has', () => {
    seed([...split(), source('srcP', '2', 'PAT')]);
    const key = 'srcP~lift-source';
    const node = (id: string, parentId: string | null, assignments: Record<string, number>, order: number[], focus: number[] | null) => ({
      id, parentId, name: id, createdAt: 0, chrom: 'chr3', start: 128_650_000, end: 128_660_000, sourceClusterIds: [], clusterMethod: 'kmeans', clusterK: 2,
      subnucleosomalThreshold: 0, accessibilityThreshold: 0, peakRegions: [], selectedPeakIndices: [], peakModes: {}, patterns: {}, dynamicClustering: false,
      assignments: { 'k-pat': assignments }, order: { 'k-pat': order }, focus: { 'k-pat': focus } });
    const rootLabels = { [aid('q1')]: 0, [aid('q2')]: 1 }, childLabels = { [aid('q1')]: 3, [aid('q2')]: 4 };
    useBrowserStore.setState({ clusterTreeNodes: { r: node('r', null, rootLabels, [0, 1], [1]), c: node('c', 'r', childLabels, [4, 3], [4]) },
      clusterTreeRootIds: ['r'], activeClusterTreeNodeId: 'c', clusterAssignments: { 'k-pat': childLabels }, clusterOrder: { 'k-pat': [4, 3] },
      clusterFocus: { 'k-pat': new Set([4]) }, filteredReadIds: { [key]: new Set(['q1']) } } as never);
    seedSourceState('pat', 'srcP');
    const st = useBrowserStore.getState();
    expect(st.clusterAssignments[key]).toEqual({ q1: 3 });
    expect(st.clusterFocus[key] ?? null).toBeNull();
    expect(st.clusterTreeNodes.r.assignments[key]).toEqual({ q1: 0 });
    expect(st.clusterTreeNodes.r.focus[key] ?? null).toBeNull();
    useBrowserStore.getState().applyClusterTreeNode('r');
    expect(useBrowserStore.getState().clusterAssignments[key]).toEqual({ q1: 0 });
  });
  it('post-merge A2 #2: a source clustered on its own after a graph run labelled it keeps its order and focus on reopen, though its numbers equal the member\'s', async () => {
    seed([...split(), source('srcP', '2', 'PAT')]);
    setPanelViewMode('mat', 'graph');
    const p = plan();
    const pat = p.observations.find(o => o.binding === 'pat')!.id;
    commitGraphRun(useBrowserStore.getState(), p, response({ [pat]: { assignments: { [aid('q1')]: 0, [aid('q2')]: 1 } } }));
    const key = 'srcP~lift-source';
    const root = useBrowserStore.getState().activeClusterTreeNodeId!;
    expect(useBrowserStore.getState().clusterTreeNodes[root].graphProvenance?.[key]).toBeDefined();
    // An ordinary clustering of the source alone (as the Cluster button runs it) that happens to give the same groups.
    useBrowserStore.setState({ clusterMatchedRun: null });
    const s = useBrowserStore.getState();
    s.setClusterAssignments(key, { q1: 0, q2: 1 });
    s.syncActiveClusterTreeNode();
    s.setClusterOrder(key, [1, 0]);
    s.setClusterFocus(key, new Set([1]));
    s.setClusterOrder('k-pat', [0, 1]);
    s.setClusterFocus('k-pat', new Set([0]));
    // The run's record provenance stays; its labels are marked replaced on the source only.
    expect(useBrowserStore.getState().clusterTreeNodes[root].graphProvenance?.[key]).toBeDefined();
    expect(useBrowserStore.getState().clusterTreeNodes[root].graphLabelsReplaced).toEqual({ [key]: true });
    useBrowserStore.setState(x => ({ panels: x.panels.map(q => (q.id === 'srcP' ? { ...q, collapsed: true } : q)) }));
    setPopOutKind('mat', 'source');
    popOutPaths('mat', ['pat']);
    await new Promise(r => setTimeout(r, 0));
    const st = useBrowserStore.getState();
    expect(st.panels.find(x => x.id === 'srcP')!.collapsed).toBe(false);
    expect(st.clusterOrder[key]).toEqual([1, 0]);
    expect([...st.clusterFocus[key]!]).toEqual([1]);
    expect(st.clusterTreeNodes[root].focus[key]).toEqual([1]);
  });

  it('post-merge A2 #2: an ancestor node\'s graph provenance does not make a source\'s labels on a child node the run\'s', async () => {
    seed([...split(), source('srcP', '2', 'PAT', { collapsed: true })]);
    const key = 'srcP~lift-source';
    const node = (id: string, parentId: string | null, extra: Record<string, unknown>) => ({
      id, parentId, name: id, createdAt: 0, chrom: 'chr3', start: 128_650_000, end: 128_660_000, sourceClusterIds: [], clusterMethod: 'kmeans', clusterK: 2,
      subnucleosomalThreshold: 0, accessibilityThreshold: 0, peakRegions: [], selectedPeakIndices: [], peakModes: {}, patterns: {}, dynamicClustering: false,
      assignments: { 'k-pat': { [aid('q1')]: 0, [aid('q2')]: 1 }, [key]: { q1: 0, q2: 1 } }, order: { 'k-pat': [0, 1], [key]: [1, 0] },
      focus: { 'k-pat': [0], [key]: [1] }, ...extra });
    // The root was a graph run's; the child's source labels are a clustering of its own.
    useBrowserStore.setState({ clusterTreeNodes: { r: node('r', null, { graphProvenance: { [key]: { observations: [], owned: {} } } }), c: node('c', 'r', {}) },
      clusterTreeRootIds: ['r'], activeClusterTreeNodeId: 'c',
      clusterAssignments: { 'k-pat': { [aid('q1')]: 0, [aid('q2')]: 1 }, [key]: { q1: 0, q2: 1 } }, clusterOrder: { 'k-pat': [0, 1], [key]: [1, 0] },
      clusterFocus: { 'k-pat': new Set([0]), [key]: new Set([1]) } } as never);
    setPanelViewMode('mat', 'graph');
    setPopOutKind('mat', 'source');
    popOutPaths('mat', ['pat']);
    await new Promise(r => setTimeout(r, 0));
    const st = useBrowserStore.getState();
    expect(st.clusterOrder[key]).toEqual([1, 0]);
    expect([...st.clusterFocus[key]!]).toEqual([1]);
  });
  it.each(['direct', 'undo-redo', 'session'])('post-merge A3: a pooled host merged through the replacing setter keeps its record provenance, so a PAT pop-out takes no MAT labels (%s)', mode => {
    seed([panel('pool', { liftHaplotypeMode: 'pooled' })]);
    useBrowserStore.setState({ _historyStack: [], _historyPointer: -1, _historyPaused: false } as never);
    setPanelViewMode('pool', 'graph');
    const p = plan();
    const mat = p.observations.find(o => o.binding === 'mat')!.id;
    const m0 = aid('m0', 'm:0'), m1 = aid('m1', 'm:1');
    commitGraphRun(useBrowserStore.getState(), p, response({ [mat]: { assignments: { [m0]: 0, [m1]: 1 } } }));
    const root = useBrowserStore.getState().activeClusterTreeNodeId!;
    expect(useBrowserStore.getState().clusterTreeNodes[root].graphProvenance?.['k-pool']).toBeDefined();
    // "Merge similar clusters" writes its result with the replacing setter.
    useBrowserStore.getState().setClusterAssignments('k-pool', { [recordKey(m0)!]: 0, [recordKey(m1)!]: 0 });
    useBrowserStore.getState().setDynamicClustering(false);
    useBrowserStore.getState().pushSnapshot('Merge similar clusters');
    if (mode === 'undo-redo') {
      useBrowserStore.getState().undo();
      expect(useBrowserStore.getState().clusterTreeNodes[root].graphProvenance?.['k-pool']).toBeDefined();
      useBrowserStore.getState().redo();
      expect(useBrowserStore.getState().clusterAssignments['k-pool']).toEqual({ [recordKey(m0)!]: 0, [recordKey(m1)!]: 0 });
    }
    if (mode === 'session') useBrowserStore.setState(deserializeSavedState(JSON.parse(JSON.stringify(serializeState(useBrowserStore.getState())))));
    const [pat] = popOut('pool', [], [{ binding: 'pat', hap: 'PAT' }]);
    const st = useBrowserStore.getState();
    const patRows = [{ id: 'pat-visible', analysis_id: aid('pat-visible', 'p:0') }];
    const visible = (labels: Record<string, number> | undefined) => filterReadsByReadIdSet(patRows, clusteredReadIdSet(labels ?? {})).length;
    expect(st.clusterAssignments[pat]).toBeUndefined();
    expect(visible(st.clusterAssignments[pat])).toBe(1);
    expect(st.clusterTreeNodes[root].assignments[pat]).toBeUndefined();
    useBrowserStore.getState().applyClusterTreeNode(root);
    expect(visible(useBrowserStore.getState().clusterAssignments[pat])).toBe(1);
  });

  it('post-merge A3: a source view opened after a pooled host\'s labels were replaced takes its haplotype\'s replacement labels', () => {
    seed([panel('pool', { liftHaplotypeMode: 'pooled' })]);
    setPanelViewMode('pool', 'graph');
    const p = plan();
    const mat = p.observations.find(o => o.binding === 'mat')!.id, pat = p.observations.find(o => o.binding === 'pat')!.id;
    const m = aid('m', 'm:0'), q = aid('p', 'p:0');
    commitGraphRun(useBrowserStore.getState(), p, response({ [mat]: { assignments: { [m]: 0 } }, [pat]: { assignments: { [q]: 1 } } }));
    useBrowserStore.setState(s => ({ panels: [...s.panels, source('srcP', '2', 'PAT')], clusterMatchedRun: null }));
    useBrowserStore.getState().setClusterAssignments('k-pool', { [recordKey(m)!]: 1, [recordKey(q)!]: 0 });
    seedSourceState('pool', 'srcP');
    expect(useBrowserStore.getState().clusterAssignments['srcP~lift-source']).toEqual({ p: 0 });
  });

  it('post-merge A3: a graph run clears the replaced mark of the panels it labels', () => {
    seed([...split(), source('srcP', '2', 'PAT')]);
    setPanelViewMode('mat', 'graph');
    const p = plan();
    const pat = p.observations.find(o => o.binding === 'pat')!.id;
    commitGraphRun(useBrowserStore.getState(), p, response({ [pat]: { assignments: { [aid('q1')]: 0, [aid('q2')]: 1 } } }));
    const root = useBrowserStore.getState().activeClusterTreeNodeId!;
    useBrowserStore.setState({ clusterMatchedRun: null });
    useBrowserStore.getState().setClusterAssignments('srcP~lift-source', { q1: 0, q2: 1 });
    useBrowserStore.getState().syncActiveClusterTreeNode();
    expect(useBrowserStore.getState().clusterTreeNodes[root].graphLabelsReplaced).toEqual({ 'srcP~lift-source': true });
    commitGraphRun(useBrowserStore.getState(), plan(), response({ [pat]: { assignments: { [aid('q1')]: 1, [aid('q2')]: 0 } } }));
    expect(useBrowserStore.getState().clusterTreeNodes[root].graphLabelsReplaced).toBeUndefined();
  });
  it('agy post-merge A HIGH 3: a refined graph run keeps the order, focus, names and provenance of panels it does not label', () => {
    seed([...split(), source('srcP', '2', 'PAT')]);
    useBrowserStore.setState({ clusterAssignments: { 'k-other': { x1: 0, x2: 1 } }, clusterOrder: { 'k-other': [1, 0] },
      clusterFocus: { 'k-other': new Set([1]) }, clusterGroupLabels: { 'k-other': { 1: 'mine' } } } as never);
    setPanelViewMode('mat', 'graph');
    const p = plan();
    const pat = p.observations.find(o => o.binding === 'pat')!.id;
    commitGraphRun(useBrowserStore.getState(), p, { ...(response({ [pat]: { assignments: { [aid('q1')]: 0, [aid('q2')]: 2 } } }) as object),
      results: { [pat]: { assignments: { [aid('q1')]: 0, [aid('q2')]: 2 }, stage1: { [aid('q1')]: 0, [aid('q2')]: 0 } } }, names: { 2: 'C0.1' } } as never);
    const st = useBrowserStore.getState();
    const refined = st.clusterTreeNodes[st.activeClusterTreeNodeId!];
    expect(refined.refinement).toBe(true);
    expect(st.clusterAssignments['srcP~lift-source']).toEqual({ q1: 0, q2: 2 });
    expect(st.clusterOrder['k-other']).toEqual([1, 0]);
    expect([...st.clusterFocus['k-other']!]).toEqual([1]);
    expect(st.clusterGroupLabels['k-other']).toEqual({ 1: 'mine' });
    expect(refined.order['k-other']).toEqual([1, 0]);
    expect(refined.focus['k-other']).toEqual([1]);
    expect(refined.groupLabels?.['k-other']).toEqual({ 1: 'mine' });
    // Back to the stage-1 node and to the refinement again: the other panel's names come back with it.
    useBrowserStore.getState().applyClusterTreeNode(refined.parentId!);
    useBrowserStore.getState().applyClusterTreeNode(refined.id);
    expect(useBrowserStore.getState().clusterGroupLabels['k-other']).toEqual({ 1: 'mine' });
    expect(useBrowserStore.getState().clusterOrder['k-other']).toEqual([1, 0]);
  });

  it('agy post-merge A HIGH 3: a graph run that replaces a refinement keeps its marks of labels clustered on their own, so a reopened source keeps its order and focus', async () => {
    seed([...split(), source('srcP', '2', 'PAT')]);
    setPanelViewMode('mat', 'graph');
    const p = plan();
    const pat = p.observations.find(o => o.binding === 'pat')!.id;
    commitGraphRun(useBrowserStore.getState(), p, { ...(response({ [pat]: { assignments: { [aid('q1')]: 0, [aid('q2')]: 2 } } }) as object),
      results: { [pat]: { assignments: { [aid('q1')]: 0, [aid('q2')]: 2 }, stage1: { [aid('q1')]: 0, [aid('q2')]: 0 } } }, names: { 2: 'C0.1' } } as never);
    const key = 'srcP~lift-source';
    const refined = useBrowserStore.getState().activeClusterTreeNodeId!;
    // The source clustered on its own on the refinement (the same numbers), then folded away.
    const s = useBrowserStore.getState();
    s.setClusterAssignments(key, { q1: 0, q2: 2 });
    s.setClusterOrder(key, [2, 0]);
    // (Its own focus only: a focus set through the run's shared picks would make the next run a subcluster.)
    useBrowserStore.setState(x => ({ clusterFocus: { ...x.clusterFocus, [key]: new Set([0]) } }));
    expect(useBrowserStore.getState().clusterTreeNodes[refined].graphLabelsReplaced?.[key]).toBe(true);
    useBrowserStore.setState(x => ({ panels: x.panels.map(q => (q.id === 'srcP' ? { ...q, collapsed: true } : q)) }));
    // A one-stage run on the host replaces the refinement; the folded source is not one of its destinations.
    commitGraphRun(useBrowserStore.getState(), plan(), response({ [pat]: { assignments: { [aid('q1')]: 0, [aid('q2')]: 2 } } }));
    const st = useBrowserStore.getState();
    expect(st.clusterTreeNodes[refined]).toBeUndefined();
    expect(st.clusterTreeNodes[st.activeClusterTreeNodeId!].graphLabelsReplaced?.[key]).toBe(true);
    st.setClusterOrder('k-pat', [0, 2]);
    useBrowserStore.setState(x => ({ clusterFocus: { ...x.clusterFocus, 'k-pat': new Set([2]) } }));
    expect([...useBrowserStore.getState().clusterFocus[key]!]).toEqual([0]);
    setPopOutKind('mat', 'source');
    popOutPaths('mat', ['pat']);
    await new Promise(r => setTimeout(r, 0));
    const after = useBrowserStore.getState();
    expect(after.clusterOrder[key]).toEqual([2, 0]);
    expect([...after.clusterFocus[key]!]).toEqual([0]);
  });
  const reopen = async () => {
    useBrowserStore.setState(x => ({ panels: x.panels.map(q => (q.id === 'srcP' ? { ...q, collapsed: false } : q)) }));
    useBrowserStore.setState(x => ({ panels: x.panels.map(q => (q.id === 'srcP' ? { ...q, collapsed: true } : q)) }));
    setPopOutKind('mat', 'source');
    popOutPaths('mat', ['pat']);
    await new Promise(r => setTimeout(r, 0));
    return useBrowserStore.getState();
  };

  it('agy post-merge A HIGH 2: a source view folded away during a later graph run takes the member\'s new labels on reopen', async () => {
    seed([...split(), source('srcP', '2', 'PAT')]);
    setPanelViewMode('mat', 'graph');
    const pat = plan().observations.find(o => o.binding === 'pat')!.id;
    commitGraphRun(useBrowserStore.getState(), plan(), response({ [pat]: { assignments: { [aid('q1')]: 0, [aid('q2')]: 1 } } }));
    const key = 'srcP~lift-source';
    expect(useBrowserStore.getState().clusterAssignments[key]).toEqual({ q1: 0, q2: 1 });
    useBrowserStore.setState(x => ({ panels: x.panels.map(q => (q.id === 'srcP' ? { ...q, collapsed: true } : q)) }));
    commitGraphRun(useBrowserStore.getState(), plan(), response({ [pat]: { assignments: { [aid('q1')]: 1, [aid('q2')]: 0 } } }));
    expect(useBrowserStore.getState().clusterAssignments[key]).toEqual({ q1: 0, q2: 1 });
    const st = await reopen();
    expect(st.clusterAssignments[key]).toEqual({ q1: 1, q2: 0 });
  });

  it('agy post-merge A HIGH 2: a source view folded away during a graph subcluster takes the member\'s share, not only Unassigned', async () => {
    seed([...split(), source('srcP', '2', 'PAT')]);
    setPanelViewMode('mat', 'graph');
    const pat = plan().observations.find(o => o.binding === 'pat')!.id;
    commitGraphRun(useBrowserStore.getState(), plan(), response({ [pat]: { assignments: { [aid('q1')]: 0, [aid('q2')]: 1 } } }));
    const key = 'srcP~lift-source';
    useBrowserStore.setState(x => ({ panels: x.panels.map(q => (q.id === 'srcP' ? { ...q, collapsed: true } : q)), selectedClusters: { 'k-pat': new Set([0]) } }));
    commitGraphRun(useBrowserStore.getState(), plan(), response({ [pat]: { assignments: { [aid('q1')]: 0 } } }));
    expect(Object.values(useBrowserStore.getState().clusterAssignments[key] ?? {}).every(c => c === -1)).toBe(true);
    const st = await reopen();
    expect(st.clusterAssignments[key]?.q1).toBe(0);
  });

  it('agy post-merge A HIGH 2: a source view whose filter no read passes takes no labels on reopen', async () => {
    seed([...split(), source('srcP', '2', 'PAT', { collapsed: true })]);
    setPanelViewMode('mat', 'graph');
    const pat = plan().observations.find(o => o.binding === 'pat')!.id;
    commitGraphRun(useBrowserStore.getState(), plan(), response({ [pat]: { assignments: { [aid('q1')]: 0, [aid('q2')]: 1 } } }));
    useBrowserStore.setState({ filteredReadIds: { 'k-pat': new Set<string>() } } as never);
    const st = await reopen();
    expect(st.filteredReadIds['srcP~lift-source']?.size).toBe(0);
    expect(Object.keys(st.clusterAssignments['srcP~lift-source'] ?? {})).toEqual([]);
  });
  it('agy post-merge A HIGH 2: a source view that joined a run after it, folded away while the member\'s groups were merged, takes the merged labels on reopen', async () => {
    seed([...split()]);
    setPanelViewMode('mat', 'graph');
    const pat = plan().observations.find(o => o.binding === 'pat')!.id;
    commitGraphRun(useBrowserStore.getState(), plan(), response({ [pat]: { assignments: { [aid('q1')]: 0, [aid('q2')]: 1, [aid('q3')]: 2 } } }));
    const key = 'srcP~lift-source';
    useBrowserStore.setState(x => ({ panels: [...x.panels, source('srcP', '2', 'PAT')] }));
    expect(labelLinkedSource('srcP')).toBe(3);
    const root = useBrowserStore.getState().activeClusterTreeNodeId!;
    expect(useBrowserStore.getState().clusterTreeNodes[root].graphProvenance?.[key]).toBeDefined();
    useBrowserStore.setState(x => ({ panels: x.panels.map(q => (q.id === 'srcP' ? { ...q, collapsed: true } : q)) }));
    // The member's groups 1 and 2 merged (the replacing setter, as the cluster panel's merge writes it).
    useBrowserStore.getState().setClusterAssignments('k-pat', { [aid('q1')]: 0, [aid('q2')]: 1, [aid('q3')]: 1 });
    const st = await reopen();
    expect(st.clusterAssignments[key]).toEqual({ q1: 0, q2: 1, q3: 1 });
  });
  it('agy post-merge A HIGH 2: reopening a run-labelled source view the user then filtered keeps the labels of reads its filter hides', async () => {
    seed([...split(), source('srcP', '2', 'PAT')]);
    setPanelViewMode('mat', 'graph');
    const pat = plan().observations.find(o => o.binding === 'pat')!.id;
    commitGraphRun(useBrowserStore.getState(), plan(), response({ [pat]: { assignments: { [aid('q1')]: 0, [aid('q2')]: 1 } } }));
    const key = 'srcP~lift-source';
    expect(useBrowserStore.getState().clusterAssignments[key]).toEqual({ q1: 0, q2: 1 });
    useBrowserStore.setState(x => ({ filteredReadIds: { ...x.filteredReadIds, [key]: new Set(['q1']) } }));
    const st = await reopen();
    expect(st.clusterAssignments[key]).toEqual({ q1: 0, q2: 1 });
  });
});

