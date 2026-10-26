/**
 * Graph mode follow-ups (DESIGN_GRAPH_PRIMARY v2.2 §3.2, §4.1, §4.2, §5.1, §5.2, §5.4, §7.3, §7.4): pop out a chosen
 * subset, the one-time "View as graph" offer, the hand-off notices, sort by first carried column, the per-host
 * pop-out kind, and the single-haplotype label.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../liveLift/linking/liftLink', async importOriginal => ({
  ...(await importOriginal<typeof import('../liveLift/linking/liftLink')>()),
  openLinkedSourceView: vi.fn(async () => null),
}));
import { useBrowserStore } from '../../stores/browserStore';
import { useGraphStatusStore } from './statusStore';
import { useGraphBindingsStore } from './bindingsStore';
import { enterGraph, poppable, setPanelViewMode } from './hostMode';
import { popOutKindOf, popOutPaths, popOutPlan, setPopOutKind } from './popOutKind';
import { openLinkedSourceView } from '../liveLift/linking/liftLink';
import { migratePanelAliases } from '../../plugins/registry';
import { graphBindingFor } from './bindingsStore';
import { useGraphSettings } from './handoff';
import { registerGraphPanel } from './register';
import { memberLabel, singleHapPathName } from './labels';
import type { GraphBinding, GraphOccurrence, GraphRead, GraphReadBinding, GraphRegistration, GraphTopology } from './types';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { PopOutPicker, pickedPopOut, usePopOutPicker } from './PopOutPicker';
import { canonicalWalk, firstCarriedColumn, firstCarriedColumns } from './columnOrder';
import { packMemberBands, type BandMember } from './memberBands';
import type { PlacedMolecule } from './readGeometry';
import type { PanelConfig } from '../../types';

registerGraphPanel();

const binding = (key: string, contig: string, sample: string, hap: number): GraphBinding => ({
  key, path: { sample, haplotype: hap, contig } as GraphBinding['path'], assembly: sample, reference: sample === 'GRCh38' ? 'GRCh38' : sample,
  size: 200_000_000, size_inferred: false, fragments: [{ origin: 0, end: 200_000_000, indexed: true }], uncovered: [],
});
const REG: GraphRegistration = {
  id: 'gp', label: 'pkg', producer: 'fiberbrowser-graph', build_target: 't',
  revisions: { package: 'p'.repeat(64), graph: 'g'.repeat(64), db: 'd'.repeat(64), maps: 'm'.repeat(64) },
  bindings: [binding('tgt', 'chr3', 'GRCh38', 0), binding('mat', 'chr3_MAT', 'S1', 1), binding('pat', 'chr3_PAT', 'S1', 2),
    binding('one', 'chr3_A', 'STRAIN', 1)],
  maps: [{ target: 'tgt', source: 'pat' }, { target: 'tgt', source: 'mat' }, { target: 'tgt', source: 'one' }],
};
const BOUND: GraphReadBinding = { dataset_id: 'd', label: 'lifted', kind: 'lifted', revision: 'r1',
  paths: { mat: 'chr3_MAT', pat: 'chr3_PAT' }, haps: { mat: 'MAT', pat: 'PAT' }, problems: [], libraries: 1 };
const ONE: GraphReadBinding = { dataset_id: 's', label: 'strain', kind: 'lifted', revision: 'r3',
  paths: { one: 'chr3_A' }, haps: { one: 'A' }, problems: [], libraries: 1 };
const NATIVE: GraphReadBinding = { dataset_id: 'n', label: 'native', kind: 'native', revision: 'r2', paths: { tgt: 'chr3' }, problems: [], libraries: 1 };

const panel = (id: string, extra: Partial<PanelConfig> = {}): PanelConfig => ({
  id, contentType: 'dataset', datasetId: 'd', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, stateKey: `k-${id}`, ...extra,
});

function seed(panels: PanelConfig[], view = { chrom: 'chr3', start: 128_650_000, end: 128_660_000 }) {
  useGraphStatusStore.setState({ status: { helper: { available: true }, registrations: [REG] } as never, error: null, loading: false });
  useGraphBindingsStore.setState({ byDataset: { d: [{ registration: REG, binding: BOUND }], n: [{ registration: REG, binding: NATIVE }],
    s: [{ registration: REG, binding: ONE }] },
  problems: {}, key: `d,n,s||${useBrowserStore.getState().refreshGeneration ?? 0}|gp@${REG.revisions.package}`, covered: ['d', 'n', 's'], loading: false });
  useBrowserStore.setState({ panels, ...view, currentGenome: 'GRCh38', datasets: [
    { id: 'd', label: 'lifted', data_type: 'bam_livelift', color: '#123456' } as never,
    { id: 's', label: 'strain dataset', data_type: 'bam_livelift', color: '#345678' } as never,
    { id: 'n', label: 'native', data_type: 'bam', color: '#654321' } as never],
  clusterAssignments: {}, clusterOrder: {}, filteredReadIds: {}, selectedReadIds: {}, readSortOrder: {}, fullViewPanelId: null });
}
const get = (id: string) => useBrowserStore.getState().panels.find(p => p.id === id)!;
const split = () => [panel('mat', { liftHap: 'MAT', liftHaplotypeMode: 'split' }), panel('pat', { liftHap: 'PAT', liftHaplotypeMode: 'split' })];

beforeEach(() => { localStorage.clear(); useGraphSettings.getState().set({ outBp: 50_000, inBp: 40_000, defaultLiftedView: 'graph' }); });
afterEach(() => vi.useRealTimers());

describe('item 7: a single-haplotype member is labelled by its PanSN path name', () => {
  it('one haplotype: SAMPLE#hap; split members keep MAT / PAT; native and multi-haplotype pooled: the dataset label', () => {
    seed([panel('only', { datasetId: 's' }), ...split(), panel('nat', { datasetId: 'n' }), panel('pool')]);
    const st = useGraphBindingsStore.getState().byDataset;
    expect(singleHapPathName(st.s[0], null, 'tgt')).toBe('STRAIN#1');
    expect(singleHapPathName(st.s[0], 'A', 'tgt')).toBeNull();
    expect(singleHapPathName(st.d[0], null, 'tgt')).toBeNull();
    expect(singleHapPathName(st.n[0], null, 'tgt')).toBeNull();
    expect(memberLabel(get('only'), 'strain dataset', 'tgt')).toBe('STRAIN#1');
    expect(memberLabel(get('mat'), 'lifted', 'tgt')).toBe('MAT');
    expect(memberLabel(get('nat'), 'native', 'tgt')).toBe('native');
    expect(memberLabel(get('pool'), 'lifted', 'tgt')).toBe('lifted');
    // A title the user gave wins.
    expect(memberLabel({ ...get('only'), title: 'mine' }, 'strain dataset', 'tgt')).toBe('mine');
  });

  it('a single-haplotype host views its graph on its one panel', () => {
    seed([panel('only', { datasetId: 's', liftHaplotypeMode: 'split' })]);
    expect(setPanelViewMode('only', 'graph')).toBeNull();
    expect(get('only').graphView?.role).toBe('host');
    expect(memberLabel(get('only'), 'strain dataset', get('only').graphView!.targetBinding)).toBe('STRAIN#1');
  });
});

describe('item 5: the per-host pop-out kind (lifted, source, both; D7)', () => {
  it('absent is lifted (an older session restores as before); the setting is saved with the host and undoable', () => {
    seed(split());
    setPanelViewMode('mat', 'graph');
    expect(get('mat').graphView!.popOutKind).toBeUndefined();
    expect(popOutKindOf(get('mat'))).toBe('lifted');
    expect(popOutKindOf({ ...get('mat'), graphView: { ...get('mat').graphView!, popOutKind: 'bogus' as never } })).toBe('lifted');
    useBrowserStore.getState().pushSnapshot?.('start', { kind: 'layout' });
    setPopOutKind('mat', 'both');
    expect(get('mat').graphView!.popOutKind).toBe('both');
    // Restored with the session (migration leaves a schema 2 host as it is).
    expect((migratePanelAliases([get('mat')] as never)[0] as unknown as PanelConfig).graphView!.popOutKind).toBe('both');
    // Kept when the host views its graph again (hostGraphView).
    const again = enterGraph(useBrowserStore.getState().panels, 'mat', graphBindingFor('d')!, { chrom: 'chr3', start: 128_650_000, end: 128_660_000, reference: 'GRCh38' })!;
    expect(again.find(p => p.id === 'mat')!.graphView!.popOutKind).toBe('both');
    useBrowserStore.getState().undo();
    expect(popOutKindOf(get('mat'))).toBe('lifted');
  });

  it('plans: lifted reveals; source opens the linked source view (host for its own dataset); both does both; native always reveals', () => {
    seed([...split(), panel('nat', { datasetId: 'n' })]);
    setPanelViewMode('mat', 'graph');
    const s = useBrowserStore.getState();
    const host = get('mat');
    expect(popOutPlan(s.panels, s.datasets, host, ['pat', 'nat'], [], 'lifted')).toEqual({ reveal: ['pat', 'nat'], make: [], sources: [] });
    expect(popOutPlan(s.panels, s.datasets, host, ['pat', 'nat'], [], 'source'))
      .toEqual({ reveal: ['nat'], make: [], sources: [{ liftPanelId: 'mat', hap: 'PAT' }] });
    expect(popOutPlan(s.panels, s.datasets, host, ['pat'], [{ binding: 'x', hap: 'X' }], 'both'))
      .toEqual({ reveal: ['pat'], make: [{ binding: 'x', hap: 'X' }], sources: [{ liftPanelId: 'mat', hap: 'PAT' }, { liftPanelId: 'mat', hap: 'X' }] });
  });

  it('source: popping out a path opens its source view and leaves the member folded', async () => {
    seed(split());
    setPanelViewMode('mat', 'graph');
    setPopOutKind('mat', 'source');
    vi.mocked(openLinkedSourceView).mockClear();
    popOutPaths('mat', ['pat']);
    await new Promise(r => setTimeout(r, 0));
    expect(openLinkedSourceView).toHaveBeenCalledWith('mat', 'PAT');
    expect(get('pat').collapsedByGraphGroup).toBe('mat');
    setPopOutKind('mat', 'both');
    popOutPaths('mat', poppable(useBrowserStore.getState().panels, get('mat')).folded.map(p => p.id));
    await new Promise(r => setTimeout(r, 0));
    expect(get('pat').collapsedByGraphGroup).toBeUndefined();
    expect(openLinkedSourceView).toHaveBeenCalledTimes(2);
  });
});

describe('item 4: sort by position orders rows by their first carried graph column', () => {
  const occ = (id: string, node: string, start: number, end: number, reverse = false, clip?: [number, number]): GraphOccurrence => ({
    id, fragment: 'f', node, handle: `${node}${reverse ? '-' : '+'}`, reverse, path_span: { start, end },
    clip: { start: clip?.[0] ?? 0, end: clip?.[1] ?? end - start } });
  // Target: n1+, n2- (inverted against MAT), n3+. MAT: n1+, an insertion n9, n2+, n3+.
  const TOPO = { target: 'tgt', interval: { start: 0, end: 30 }, nodes: [], edges: [], direct_matches: [], target_queries: [], summaries: [],
    complete: true, correspondence_complete: true, timings: {},
    paths: [
      { binding: 'mat', windows: [], coverage: [], plan: null, complete: true,
        occurrences: [occ('m3', 'n3', 25, 35), occ('m1', 'n1', 0, 10), occ('m9', 'n9', 10, 15), occ('m2', 'n2', 15, 25)] },
      { binding: 'tgt', windows: [], coverage: [], plan: null, complete: true,
        occurrences: [occ('t1', 'n1', 0, 10), occ('t2', 'n2', 10, 20, true), occ('t3', 'n3', 20, 30)] },
    ] } as unknown as GraphTopology;
  const rd = (q: string, cov: [number, number][]): GraphRead => ({ k: `d|0|${q}|r`, d: 'd', lib: 0, q, rec: 'r', b: 'mat', c: '', st: '+',
    sup: false, s: cov[0][0], e: cov[cov.length - 1][1], cov: cov.map(([a, b]) => [a, b, 0, 1]), ins: [], hap: 'MAT' } as GraphRead);

  it('ranks nodes along the target walk; an off-target node follows the last target node before it on its carrier', () => {
    const walk = canonicalWalk(TOPO, ['tgt', 'mat']);
    expect(walk.nodes.get('n1')!.rank).toEqual([0, 0, 0]);
    expect(walk.nodes.get('n2')).toEqual({ rank: [1, 0, 0], reverse: true });
    expect(walk.nodes.get('n9')!.rank).toEqual([0, 1, 1]);
  });

  it('the first carried column: insertion after n1, offsets along the canonical orientation, only inside the clip', () => {
    const walk = canonicalWalk(TOPO);
    expect(firstCarriedColumn(rd('ins', [[12, 30]]), walk)).toEqual([0, 1, 1, 2]);
    // MAT walks n2 forward, the target reversed: the canonical first column of [17, 25) is node-forward 9 → offset 0.
    expect(firstCarriedColumn(rd('late', [[17, 30]]), walk)).toEqual([1, 0, 0, 0]);
    expect(firstCarriedColumn(rd('early', [[15, 20]]), walk)).toEqual([1, 0, 0, 5]);
    // Outside every clip: nothing carried.
    const clipped = { ...TOPO, paths: TOPO.paths.map(p => ({ ...p, occurrences: p.occurrences.map(o => ({ ...o, clip: { start: 0, end: 0 } })) })) };
    expect(firstCarriedColumn(rd('x', [[0, 30]]), canonicalWalk(clipped as GraphTopology))).toBeNull();
  });

  it('a sub-band sorted by position follows the columns, not the pixels (mirrored, or a first visit not drawn)', () => {
    const reads = [rd('a', [[17, 30]]), rd('b', [[15, 20]]), rd('c', [[12, 30]]), rd('d', [[2, 8]])];
    // Pixels the other way round (a mirrored panel): d drawn rightmost, c leftmost. All overlap, so one row each.
    const xs: Record<string, number> = { a: 20, b: 10, c: 0, d: 30 };
    const mols: PlacedMolecule[] = reads.map(r => ({ read: r, lane: 'mat', visits: [], body: [], calls: [], m6a: [], density: [], ins: [],
      holes: [], connectors: [], extent: [xs[r.q], 100], unplacedBp: 0 }));
    const M: BandMember = { panelId: 'mat', stateKey: 'k-mat', datasetId: 'd', liftHap: 'MAT', binding: 'mat', label: 'MAT', color: '#111' };
    const cols = firstCarriedColumns(reads, TOPO);
    const order = (lanes: ReturnType<typeof packMemberBands>) => lanes.get('mat')!.rows.map(r => r[0].read.q);
    expect(order(packMemberBands(mols, [M], {}, 10, 'position', 3, undefined, m => cols.get(m.read.k)))).toEqual(['d', 'c', 'a', 'b']);
    // Without columns (the linear rule, unchanged): by first drawn x.
    expect(order(packMemberBands(mols, [M], {}, 10, 'position'))).toEqual(['c', 'b', 'a', 'd']);
    // Longest first ignores columns.
    expect(order(packMemberBands(mols, [M], {}, 10, 'length', 3, undefined, m => cols.get(m.read.k)))).toEqual(['c', 'b', 'a', 'd']);
  });
});

describe('item 1: Pop out paths… (a chosen subset, one undo step)', () => {
  it('pickedPopOut keeps only the checked members and new haplotypes', () => {
    const folded = [panel('a'), panel('b'), panel('c')];
    const missing = [{ binding: 'mat', hap: 'MAT' }, { binding: 'pat', hap: 'PAT' }];
    expect(pickedPopOut(folded, missing, new Set(['m:c', 'm:a', 'b:pat']))).toEqual({ ids: ['a', 'c'], missing: [{ binding: 'pat', hap: 'PAT' }] });
    expect(pickedPopOut(folded, missing, new Set())).toEqual({ ids: [], missing: [] });
  });

  it('the checklist pops out exactly the checked paths, as one undo step', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    seed([panel('pool', { liftHaplotypeMode: 'pooled' }), panel('nat', { datasetId: 'n' })]);
    setPanelViewMode('pool', 'graph');
    const { joinGraph } = await import('./hostMode');
    joinGraph('pool', ['nat']);
    const before = useBrowserStore.getState().panels.length;
    const { folded, missing } = poppable(useBrowserStore.getState().panels, get('pool'));
    expect(folded.map(p => p.id)).toEqual(['nat']);
    expect(missing.map(m => m.hap).sort()).toEqual(['MAT', 'PAT']);
    usePopOutPicker.getState().open('pool');
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(createElement(PopOutPicker, { hostId: 'pool', folded, missing, labelOf: (p: PanelConfig) => p.id })); });
    const picks = [...el.querySelectorAll<HTMLInputElement>('[data-testid="graph-pop-out-pick"]')];
    expect(picks.map(i => i.dataset.member ?? i.dataset.binding)).toEqual(['nat', 'mat', 'pat']);
    const confirm = el.querySelector<HTMLButtonElement>('[data-testid="graph-pop-out-confirm"]')!;
    expect(confirm.disabled).toBe(true);
    useBrowserStore.getState().pushSnapshot?.('start', { kind: 'layout' });
    const steps = useBrowserStore.getState()._historyStack?.length ?? 0;
    await act(async () => { picks[0].click(); picks[2].click(); });
    await act(async () => { confirm.click(); });
    expect(usePopOutPicker.getState().hostId).toBeNull();
    const panels = useBrowserStore.getState().panels;
    expect(panels.length).toBe(before + 1);
    expect(panels.filter(p => p.liftHap).map(p => p.liftHap)).toEqual(['PAT']);
    expect(get('nat').collapsedByGraphGroup).toBeUndefined();
    expect(useBrowserStore.getState()._historyStack?.length).toBe(steps + 1);
    useBrowserStore.getState().undo();
    expect(useBrowserStore.getState().panels.length).toBe(before);
    expect(get('nat').collapsedByGraphGroup).toBe('pool');
    act(() => root.unmount());
  });
});
