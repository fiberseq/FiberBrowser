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
import { popOutKindOf, popOutPaths, popOutPlan, seedSourceState, setPopOutKind } from './popOutKind';
import { duringSessionRestore, SESSION_RESTORED_EVENT } from '../../utils/sessionRestore';
import { useReadActionsStore } from '../../stores/readActionsStore';
import { offerRestoredSplitSessions } from '../liveLift/register';
import { openLinkedSourceView } from '../liveLift/linking/liftLink';
import { migratePanelAliases } from '../../plugins/registry';
import { graphBindingFor } from './bindingsStore';
import { useGraphSettings } from './handoff';
import { registerGraphPanel } from './register';
import { memberLabel, singleHapPathName } from './labels';
import type { GraphBinding, GraphOccurrence, GraphRead, GraphReadBinding, GraphRegistration, GraphTopology } from './types';
import { createElement, act } from 'react';
import { featureText, notDrawnInLinear } from './linearNotices';
import { acceptGraphOffer, dismissGraphOffer, graphOfferPanel, offerGraphView, useGraphOffers, withdrawGraphOffer } from './graphOffer';
import { autoSplitNewLiftedDatasets, offerRestoredSplitSessions } from '../liveLift/register';
import { notePendingGraphOpen, settlePendingGraphOpens } from './openAsGraph';
import { CROSSFADE_MS, fadeIn, panelBodyParts } from './crossfade';
import { createRoot } from 'react-dom/client';
import { PopOutPicker, pickedPopOut, usePopOutPicker } from './PopOutPicker';
import { canonicalWalk, compareColumnKeys, firstCarriedColumn, firstCarriedColumns } from './columnOrder';
import repeatVisit from './__fixtures__/gateC/repeat_visit.topology.json';
import invSplit from './__fixtures__/gateD/inv_split.topology.json';
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
      .toEqual({ reveal: ['nat'], make: [], sources: [{ liftPanelId: 'mat', hap: 'PAT', fromPanelId: 'pat' }] });
    expect(popOutPlan(s.panels, s.datasets, host, ['pat'], [{ binding: 'x', hap: 'X' }], 'both'))
      .toEqual({ reveal: ['pat'], make: [{ binding: 'x', hap: 'X' }], sources: [{ liftPanelId: 'mat', hap: 'PAT', fromPanelId: 'pat' }, { liftPanelId: 'mat', hap: 'X', fromPanelId: 'mat' }] });
  });

  it('source: popping out a path opens its source view and leaves the member folded', async () => {
    seed(split());
    setPanelViewMode('mat', 'graph');
    setPopOutKind('mat', 'source');
    vi.mocked(openLinkedSourceView).mockClear();
    popOutPaths('mat', ['pat']);
    await new Promise(r => setTimeout(r, 0));
    expect(openLinkedSourceView).toHaveBeenCalledWith('mat', 'PAT', {});
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

describe('item 6: the hand-off crossfade (150 ms, reduced motion respected)', () => {
  const media = (reduce: boolean) => vi.spyOn(window, 'matchMedia').mockImplementation(q => ({ matches: reduce && q.includes('reduce'), media: q } as MediaQueryList));
  afterEach(() => vi.restoreAllMocks());

  it('fades the new body in over 150 ms; nothing moves with reduced motion', () => {
    if (!window.matchMedia) (window as { matchMedia?: unknown }).matchMedia = () => ({ matches: false });
    const el = document.createElement('div');
    const animate = vi.fn();
    (el as unknown as { animate: unknown }).animate = animate;
    media(false);
    expect(fadeIn([el, null])).toBe(1);
    expect(animate).toHaveBeenCalledWith([{ opacity: 0 }, { opacity: 1 }], expect.objectContaining({ duration: CROSSFADE_MS }));
    expect(CROSSFADE_MS).toBe(150);
    media(true);
    expect(fadeIn([el])).toBe(0);
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it('the linear body is the panel\'s children after the header notices', () => {
    const panelEl = document.createElement('div');
    panelEl.dataset.panelId = 'h';
    panelEl.innerHTML = '<div id="bar"></div><div id="notices"><span id="handoff"></span></div><div id="t1"></div><div id="t2"></div>';
    expect(panelBodyParts(panelEl.querySelector('#handoff')).map(e => e.id)).toEqual(['t1', 't2']);
    expect(panelBodyParts(null)).toEqual([]);
  });
});

describe('item 2: the one-time "View as graph" offer (restored split sessions, late bindings)', () => {
  beforeEach(() => useGraphOffers.setState({ offered: {}, done: {} }));
  const offers = () => useGraphOffers.getState();

  it('a restored split session is left as saved and offered once on its first split panel', () => {
    seed(split());
    useBrowserStore.setState(s => ({ datasets: s.datasets.map(d => (d.id === 'd' ? { ...d, live_lift: { haplotypes: ['1', '2'], haplotype_labels: { 1: 'MAT', 2: 'PAT' } } } as never : d)) }));
    const before = JSON.stringify(useBrowserStore.getState().panels);
    autoSplitNewLiftedDatasets(new Set());
    expect(JSON.stringify(useBrowserStore.getState().panels)).toBe(before);
    expect(graphOfferPanel(useBrowserStore.getState().panels, 'd', offers())).toBe('mat');
    // Used: the panel views its graph, and the offer is gone for good.
    expect(acceptGraphOffer('mat', 'd')).toBeNull();
    expect(isHostPanel('mat')).toBe(true);
    expect(offers().done.d).toBe(true);
    offerGraphView('d');
    expect(graphOfferPanel(useBrowserStore.getState().panels, 'd', offers())).toBeNull();
  });

  it('a split session opened later in the page (datasets already seen) is offered after the restore settles', () => {
    seed(split());
    useBrowserStore.setState(s => ({ datasets: s.datasets.map(d => (d.id === 'd' ? { ...d, live_lift: { haplotypes: ['1', '2'], haplotype_labels: { 1: 'MAT', 2: 'PAT' } } } as never : d)) }));
    const before = JSON.stringify(useBrowserStore.getState().panels);
    offerRestoredSplitSessions();
    expect(JSON.stringify(useBrowserStore.getState().panels)).toBe(before);
    expect(graphOfferPanel(useBrowserStore.getState().panels, 'd', offers())).toBe('mat');
    // Already a graph: nothing offered.
    useGraphOffers.setState({ offered: {}, done: {} });
    expect(acceptGraphOffer('mat', 'd')).toBeNull();
    useGraphOffers.setState({ offered: {}, done: {} });
    offerRestoredSplitSessions();
    expect(offers().offered.d).toBeUndefined();
  });

  it('an offer used or dismissed on an earlier layout does not suppress the offer of a split session restored later', () => {
    seed(split());
    useBrowserStore.setState(s => ({ datasets: s.datasets.map(d => (d.id === 'd' ? { ...d, live_lift: { haplotypes: ['1', '2'], haplotype_labels: { 1: 'MAT', 2: 'PAT' } } } as never : d)) }));
    offerGraphView('d');
    dismissGraphOffer('d');
    offerGraphView('d');
    expect(graphOfferPanel(useBrowserStore.getState().panels, 'd', offers())).toBeNull();
    offerRestoredSplitSessions();
    expect(graphOfferPanel(useBrowserStore.getState().panels, 'd', offers())).toBe('mat');
    // Withdrawn (viewed as a graph another way) is not "dismissed": nothing remembered.
    withdrawGraphOffer('d');
    expect(offers().offered.d).toBeUndefined();
    expect(offers().done.d).toBeUndefined();
  });

  it('a binding that arrives after the user acted on the split panels offers it instead of rearranging them', () => {
    seed(split());
    useGraphBindingsStore.setState({ loading: true });
    notePendingGraphOpen('d');
    useBrowserStore.setState(s => ({ panels: s.panels.map(p => (p.id === 'pat' ? { ...p, title: 'renamed' } : p)) }));
    useGraphBindingsStore.setState({ loading: false });
    settlePendingGraphOpens();
    expect(get('mat').viewMode).toBeUndefined();
    expect(graphOfferPanel(useBrowserStore.getState().panels, 'd', offers())).toBe('mat');
    // Dismissed: not shown again this session, even when offered again.
    dismissGraphOffer('d');
    offerGraphView('d');
    expect(graphOfferPanel(useBrowserStore.getState().panels, 'd', offers())).toBeNull();
  });

  it('no offer on a dataset already in a graph, or never offered; a hidden first panel passes it to the next', () => {
    seed(split());
    expect(graphOfferPanel(useBrowserStore.getState().panels, 'd', offers())).toBeNull();
    offerGraphView('d');
    const hidden = useBrowserStore.getState().panels.map(p => (p.id === 'mat' ? { ...p, collapsed: true } : p));
    expect(graphOfferPanel(hidden, 'd', offers())).toBe('pat');
    setPanelViewMode('mat', 'graph');
    expect(graphOfferPanel(useBrowserStore.getState().panels, 'd', offers())).toBeNull();
  });
});

function isHostPanel(id: string) { return get(id).graphView?.role === 'host' && get(id).viewMode === 'graph'; }

describe('item 3: what a host drawn linear cannot show (§7.4)', () => {
  const run = (hostPanelId: string, columns: unknown) => ({ graph: { hostPanelId, columns } }) as never;
  const ins = (label: string, length = 312) => ({ kind: 'insertion', length, samples: 2, label });

  it('lists the run\'s insertions (carrier-only or shared off the target), never target or deleted stretches', () => {
    const r = run('mat', { shared: [{ kind: 'target', length: 900, samples: 3, label: 'T1' }, ins('I0', 40)],
      carrier_sets: [{ carriers: ['o1'], features: [ins('I1'), { kind: 'deleted', length: 50, samples: 1, label: 'D1' }] },
        { carriers: ['o2'], features: [ins('I1')] }] });
    expect(notDrawnInLinear(r, 'mat').map(f => f.label)).toEqual(['I0', 'I1']);
    expect(featureText(ins('I1', 1200))).toBe('insertion I1 (1,200 bp)');
    expect(featureText(ins('237 bp at 128,657,389–128,657,390', 237))).toBe('insertion 237 bp at 128,657,389–128,657,390');
  });

  it('nothing for another host\'s run, a linear run, or a run on target columns only', () => {
    expect(notDrawnInLinear(run('pat', { carrier_sets: [{ carriers: [], features: [ins('I1')] }] }), 'mat')).toEqual([]);
    expect(notDrawnInLinear({} as never, 'mat')).toEqual([]);
    expect(notDrawnInLinear(null, 'mat')).toEqual([]);
    expect(notDrawnInLinear(run('mat', { shared: [{ kind: 'target', length: 900, samples: 3, label: 'T1' }] }), 'mat')).toEqual([]);
  });
});

describe('group H review 1: position order not left to right on screen never wastes rows', () => {
  const M: BandMember = { panelId: 'mat', stateKey: 'k-mat', datasetId: 'd', liftHap: 'MAT', binding: 'mat', label: 'MAT', color: '#111' };
  const mol = (q: string, x0: number, x1: number): PlacedMolecule => ({ read: { k: `d|0|${q}|r`, d: 'd', lib: 0, q, rec: 'r', b: 'mat', c: '', st: '+',
    sup: false, s: 0, e: 1, cov: [], ins: [], hap: 'MAT' } as GraphRead, lane: 'mat', visits: [], body: [], calls: [], m6a: [], density: [], ins: [],
    holes: [], connectors: [], extent: [x0, x1], unplacedBp: 0 });

  it('40 disjoint reads in right-to-left canonical order (a mirrored panel) pack into one row, none hidden', () => {
    const mols = Array.from({ length: 40 }, (_, i) => mol(`r${i}`, 1000 - i * 20, 1000 - i * 20 + 10));
    const rank = new Map(mols.map((m, i) => [m.read.k, [i, 0, 0, 0] as const]));
    const lane = packMemberBands(mols, [M], {}, 20, 'position', 3, undefined, m => rank.get(m.read.k))!.get('mat')!;
    expect(lane.rows.length).toBe(1);
    expect(lane.hidden).toBe(0);
    // Row priority follows the canonical order.
    expect(lane.rows[0][0].read.q).toBe('r0');
  });

  it('overlaps still take new rows; a read fits a gap between two others, with the gap respected', () => {
    const lane = packMemberBands([mol('a', 0, 10), mol('b', 40, 50), mol('c', 14, 36), mol('d', 12, 38), mol('e', 5, 45)], [M], {}, 10, 'position', 3,
      undefined, m => [['a', 'b', 'c', 'd', 'e'].indexOf(m.read.q), 0, 0, 0])!.get('mat')!;
    expect(lane.rows.map(r => r.map(m => m.read.q))).toEqual([['a', 'b', 'c'], ['d'], ['e']]);
  });
});

describe('group H review 3: revealing an open source view is its own undo step', () => {
  it('a collapsed linked source panel is revealed undoably; Undo hides it and keeps the pop-out kind', async () => {
    const src = panel('src', { datasetId: 'nsrc', collapsed: true,
      liftLink: { id: 'l', datasetId: 'd', liftPanelId: 'mat', hap: '2', hapLabel: 'PAT', contig: 'chr3_PAT', flip: false, chain: null } as never });
    seed([...split(), src]);
    setPanelViewMode('mat', 'graph');
    setPopOutKind('mat', 'source');
    const steps = useBrowserStore.getState()._historyStack?.length ?? 0;
    vi.mocked(openLinkedSourceView).mockClear();
    popOutPaths('mat', ['pat']);
    await new Promise(r => setTimeout(r, 0));
    expect(openLinkedSourceView).toHaveBeenCalledWith('mat', 'PAT');
    expect(get('src').collapsed).toBe(false);
    expect(useBrowserStore.getState()._historyStack?.length).toBe(steps + 1);
    useBrowserStore.getState().undo();
    expect(get('src').collapsed).toBe(true);
    expect(popOutKindOf(get('mat'))).toBe('source');
  });
});

describe('group H agy review 1: canonical order on minus-parity carriers and repeated nodes', () => {
  const occ = (id: string, node: string, start: number, end: number, reverse = false): GraphOccurrence => ({
    id, node, handle: `${node}${reverse ? '-' : '+'}`, reverse, fragment: 'f', path_span: { start, end }, clip: { start: 0, end: end - start } });
  const rd = (k: string, b: string, s0: number, e0: number) => ({ k, b, s: s0, e: e0, cov: [[s0, e0, 0, 1]] as [number, number, number, number][] });

  it('a minus-parity carrier is walked in the target frame: its insertion ranks between its flanks', () => {
    // Target nL → nM → nR; the carrier walks the reverse complement: nR- → nIns → nM- → nL-.
    const topo = { target: 'tgt', interval: { start: 0, end: 300 }, nodes: [], edges: [], summaries: [], target_queries: [], direct_matches: [],
      complete: true, correspondence_complete: true, timings: {},
      paths: [{ binding: 'tgt', windows: [], coverage: [], plan: null, complete: true, occurrences: [occ('t0', 'nL', 0, 100), occ('t1', 'nM', 100, 200), occ('t2', 'nR', 200, 300)] },
        { binding: 'm', windows: [], coverage: [], plan: null, complete: true,
          occurrences: [occ('m0', 'nR', 0, 100, true), occ('m1', 'nIns', 100, 150), occ('m2', 'nM', 150, 250, true), occ('m3', 'nL', 250, 350, true)] }] } as unknown as GraphTopology;
    const cols = firstCarriedColumns([rd('ins', 'm', 100, 150), rd('right', 'm', 0, 100), rd('mid', 'm', 150, 250)], topo, ['tgt', 'm']);
    expect(cols.get('ins')![0]).toBe(1);
    expect(compareColumnKeys(cols.get('mid'), cols.get('ins'))).toBeLessThan(0);
    expect(compareColumnKeys(cols.get('ins'), cols.get('right'))).toBeLessThan(0);
    // Within nR (target forward, carrier reversed): its first canonical column is the node's start.
    expect(cols.get('right')).toEqual([2, 0, 0, 0]);
  });

  it('a node the target walks twice ranks per visit: the insertion after its second copy comes after the node between', () => {
    const topo = (repeatVisit as { topology: unknown }).topology as GraphTopology;
    const cols = firstCarriedColumns([rd('mid', 'mat', 1100, 1400), rd('ins', 'mat', 1800, 1890), rd('copy2', 'mat', 1600, 1700)], topo, ['ref', 'mat', 'pat']);
    expect(cols.get('mid')).toEqual([2, 0, 0, 100]);
    expect(cols.get('copy2')![0]).toBe(3);
    expect(compareColumnKeys(cols.get('mid'), cols.get('ins'))).toBeLessThan(0);
    expect(compareColumnKeys(cols.get('copy2'), cols.get('ins'))).toBeLessThan(0);
  });

  it('an extra copy the target walks once never runs the frame backwards', () => {
    const topo = { target: 'tgt', interval: { start: 0, end: 300 }, nodes: [], edges: [], summaries: [], target_queries: [], direct_matches: [],
      complete: true, correspondence_complete: true, timings: {},
      paths: [{ binding: 'tgt', windows: [], coverage: [], plan: null, complete: true, occurrences: [occ('t0', 'a', 0, 100), occ('t1', 'b', 100, 200), occ('t2', 'c', 200, 300)] },
        { binding: 'm', windows: [], coverage: [], plan: null, complete: true,
          occurrences: [occ('m0', 'a', 0, 100), occ('m1', 'b', 100, 200), occ('m2', 'a', 200, 300), occ('m3', 'x', 300, 350), occ('m4', 'c', 350, 450)] }] } as unknown as GraphTopology;
    const cols = firstCarriedColumns([rd('b', 'm', 120, 180), rd('dup', 'm', 210, 290), rd('x', 'm', 300, 350), rd('c', 'm', 360, 440)], topo, ['tgt', 'm']);
    expect(compareColumnKeys(cols.get('b'), cols.get('dup'))).toBeLessThan(0);
    expect(compareColumnKeys(cols.get('dup'), cols.get('x'))).toBeLessThan(0);
    expect(compareColumnKeys(cols.get('x'), cols.get('c'))).toBeLessThan(0);
  });
});

describe('group H agy review 2: a saved linear single-haplotype session is restored as saved', () => {
  beforeEach(() => useGraphOffers.setState({ offered: {}, done: {} }));
  const oneHapDataset = () => useBrowserStore.setState(s => ({ datasets: s.datasets.map(d => (d.id === 's'
    ? { ...d, live_lift: { haplotypes: ['1'], haplotype_labels: { 1: 'A' } } } as never : d)) }));

  it('a single-haplotype panel saved linear stays linear and is offered "View as graph"', async () => {
    seed([panel('only', { datasetId: 's', liftHaplotypeMode: 'split', viewMode: 'linear' })]);
    oneHapDataset();
    autoSplitNewLiftedDatasets(new Set());
    await new Promise(r => setTimeout(r, 0));
    settlePendingGraphOpens();
    expect(get('only').viewMode).toBe('linear');
    expect(graphOfferPanel(useBrowserStore.getState().panels, 's', useGraphOffers.getState())).toBe('only');
    // A later restore of the same layout offers it again.
    useGraphOffers.setState({ offered: {}, done: { s: true } });
    offerRestoredSplitSessions();
    expect(graphOfferPanel(useBrowserStore.getState().panels, 's', useGraphOffers.getState())).toBe('only');
  });

  it('anything arriving while a session restores is a restored layout, never opened as a graph', async () => {
    seed([panel('only', { datasetId: 's', liftHaplotypeMode: 'split' })]);
    oneHapDataset();
    await duringSessionRestore(async () => { autoSplitNewLiftedDatasets(new Set()); return { restored: true }; });
    await new Promise(r => setTimeout(r, 0));
    settlePendingGraphOpens();
    expect(get('only').viewMode).toBeUndefined();
  });
});

describe('group H agy review 4: the offer views this panel only; the restored event only after a real restore', () => {
  beforeEach(() => useGraphOffers.setState({ offered: {}, done: {} }));

  it('accepting the offer never folds other selected panels and is one undo step', () => {
    seed([...split(), panel('nat', { datasetId: 'n' })]);
    useBrowserStore.setState({ selectedDatasets: new Set(['mat', 'nat']) } as never);
    offerGraphView('d');
    useBrowserStore.getState().pushSnapshot?.('start', { kind: 'layout' });
    expect(acceptGraphOffer('mat', 'd')).toBeNull();
    expect(get('nat').graphMemberOf).toBeUndefined();
    expect(get('pat').graphMemberOf).toBe('mat');
    useBrowserStore.getState().undo();
    expect(get('mat').viewMode).toBeUndefined();
  });

  it('fires once when the outermost restore really restored; never for a cancelled or failed one', async () => {
    const seen = vi.fn();
    window.addEventListener(SESSION_RESTORED_EVENT, seen);
    await duringSessionRestore(async () => ({ restored: false }));
    await duringSessionRestore(async () => ({ success: false }));
    await expect(duringSessionRestore(async () => { throw new Error('no'); })).rejects.toThrow();
    expect(seen).not.toHaveBeenCalled();
    await duringSessionRestore(async () => duringSessionRestore(async () => ({ success: true })).then(() => ({ restored: true })));
    expect(seen).toHaveBeenCalledTimes(1);
    window.removeEventListener(SESSION_RESTORED_EVENT, seen);
  });
});

describe('group H agy review 3: source pop-outs start with their member\'s state, beside the host, at its view', () => {
  const aidOf = (q: string) => `lift-cohort:v1 ${JSON.stringify([`d#0|${q}`, q, `${q}:r`, 0, 'primary'])}`;

  it('a new source view takes the member\'s filter, selection, exclusions, labels, order, focus and names by QNAME', () => {
    seed([...split(), panel('src', { datasetId: 'n', stateKey: 'src~lift-source',
      liftLink: { id: 'l', datasetId: 'd', liftPanelId: 'mat', hap: '2', hapLabel: 'PAT', contig: 'chr3_PAT', flip: false, chain: null } as never })]);
    useBrowserStore.setState({ filteredReadIds: { 'k-pat': new Set([aidOf('q1'), 'q2']) }, selectedReadIds: { 'k-pat': new Set([aidOf('q1')]) },
      clusterAssignments: { 'k-pat': { [aidOf('q1')]: 0, [aidOf('q2')]: 1 } }, clusterOrder: { 'k-pat': [1, 0] }, clusterFocus: { 'k-pat': new Set([1]) },
      clusterGroupLabels: { 'k-pat': { 1: 'C1' } } } as never);
    useReadActionsStore.getState().excludeReads('k-pat', [aidOf('q3')]);
    seedSourceState('pat', 'src');
    const st = useBrowserStore.getState();
    expect([...st.filteredReadIds['src~lift-source']!].sort()).toEqual(['q1', 'q2']);
    expect([...st.selectedReadIds['src~lift-source']!]).toEqual(['q1']);
    expect(st.clusterAssignments['src~lift-source']).toEqual({ q1: 0, q2: 1 });
    expect(st.clusterOrder['src~lift-source']).toEqual([1, 0]);
    expect([...st.clusterFocus['src~lift-source']!]).toEqual([1]);
    expect(st.clusterGroupLabels['src~lift-source']).toEqual({ 1: 'C1' });
    expect([...useReadActionsStore.getState().excludedReadIds['src~lift-source']!]).toEqual(['q3']);
  });

  it('a joined dataset\'s source view opens beside the host; a host with its own view maps that view', async () => {
    seed([...split(), panel('only', { datasetId: 's' })]);
    setPanelViewMode('mat', 'graph');
    const { joinGraph } = await import('./hostMode');
    joinGraph('mat', ['only']);
    expect(get('only').graphMemberOf).toBe('mat');
    setPopOutKind('mat', 'source');
    useBrowserStore.setState(s => ({ panels: s.panels.map(p => (p.id === 'mat' ? { ...p, viewportOverride: { chrom: 'chr3', start: 100, end: 900 } } : p)) }));
    vi.mocked(openLinkedSourceView).mockClear();
    popOutPaths('mat', ['only']);
    await new Promise(r => setTimeout(r, 0));
    expect(openLinkedSourceView).toHaveBeenCalledWith('only', null, { view: { chrom: 'chr3', start: 100, end: 900 }, besidePanelId: 'mat' });
  });
});

describe('group H Codex round 3, 1: an inverted run keeps its target ranks (not extra copies)', () => {
  const topoOf = (j: unknown) => ((j as { topology?: unknown }).topology ?? j) as GraphTopology;
  const rd = (k: string, s0: number, e0: number) => ({ k, b: 'mat', s: s0, e: e0, cov: [[s0, e0, 0, 1]] as [number, number, number, number][] });
  const mol = (r: ReturnType<typeof rd>): PlacedMolecule => ({ read: { ...r, d: 'd', lib: 0, q: r.k, rec: 'r', c: '', st: '+', sup: false, ins: [], hap: 'MAT' } as GraphRead,
    lane: 'mat', visits: [], body: [], calls: [], m6a: [], density: [], ins: [], holes: [], connectors: [], extent: [0, 100], unplacedBp: 0 });

  it('inv_split: MAT walks 4-, 3-, 2- against the target\'s 2, 3, 4; each keeps its target rank and orientation', () => {
    for (const withMatches of [true, false]) {
      const base = topoOf(invSplit);
      const topo = withMatches ? base : { ...base, direct_matches: [], direct_match_index: undefined } as GraphTopology;
      const walk = canonicalWalk(topo, ['ref', 'mat', 'pat']);
      const mat = walk.occurrences.get('mat')!;
      expect(mat.map(o => walk.visits.get(o.id)!.rank[0])).toEqual([0, 3, 2, 1, 4]);
      expect(mat.every(o => walk.visits.get(o.id)!.reverse === false)).toBe(true);
      // The read reaching node 2 (upstream on the target) ranks first and keeps the one row.
      const reads = [rd('down', 1030, 1220), rd('up', 1200, 1320)];
      const cols = firstCarriedColumns(reads, topo, ['ref', 'mat', 'pat']);
      expect(cols.get('up')).toEqual([1, 0, 0, 10]);
      // (It ends 10 bp into node 2, which MAT walks reversed: its first canonical column there is offset 110.)
      expect(cols.get('down')).toEqual([1, 0, 0, 110]);
      const M: BandMember = { panelId: 'mat', stateKey: 'k-mat', datasetId: 'd', liftHap: 'MAT', binding: 'mat', label: 'MAT', color: '#111' };
      const lane = packMemberBands(reads.map(mol), [M], {}, 1, 'position', 3, undefined, m => cols.get(m.read.k))!.get('mat')!;
      expect(lane.rows[0].map(m => m.read.k)).toEqual(['up']);
      expect(lane.hidden).toBe(1);
    }
  });
});
