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
import { setPanelViewMode } from './hostMode';
import { registerGraphPanel } from './register';
import { assignWithGraphRun, commitGraphRun, destinationAssignments, graphClusterPlan, labelLinkedSource } from './graphCluster';
import { useGraphSettings } from './handoff';
import { graphRunStateKeys, linkedSourceObservations, sourceLabels } from '../../utils/clusterMatchedRun';
import { mirroredSelections } from './selectionSync';
import { popOutPaths, seedSourceState, setPopOutKind } from './popOutKind';
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
});

