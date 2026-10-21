/**
 * Graph primary, thin first delivery (DESIGN_GRAPH_PRIMARY v2.2: G1 host mode and members, G3 read tools, G6 default
 * view and hand-off): a dataset panel toggles linear ⇄ graph in place, its members fold and pop out with their state,
 * lifecycle rules, schema 2 and its migration, sub-bands with each member's own state through record keys, and the
 * zoom hand-off with hysteresis.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useGraphStatusStore } from './statusStore';
import { useGraphBindingsStore } from './bindingsStore';
import { convertStandalone, enterGraph, foldIn, isHost, joinCandidates, joinGraph, leaveGraph, membersOf, popOut, poppable,
  removeFromGraph, setPanelViewMode } from './hostMode';
import { applyShown, decideShown, startHandoffController, setPinnedLinear, useGraphSettings, HANDOFF_SETTLE_MS } from './handoff';
import { restoreOrphanGraphMembers, withoutGraphMembership } from '../../stores/graphMembership';
import { migratePanelAliases } from '../../plugins/registry';
import { registerGraphPanel } from './register';
import { clusterWindows } from '../../utils/clusterTargets';
import { notePendingGraphOpen } from './openAsGraph';
import { clusterOf, packMemberBands, routeRead, type BandMember } from './memberBands';
import type { PlacedMolecule } from './readGeometry';
import type { GraphBinding, GraphRead, GraphReadBinding, GraphRegistration } from './types';
import type { PanelConfig } from '../../types';

registerGraphPanel();

const binding = (key: string, contig: string, sample: string, hap: number): GraphBinding => ({
  key, path: { sample, haplotype: hap, contig } as GraphBinding['path'], assembly: sample, reference: sample === 'GRCh38' ? 'GRCh38' : sample,
  size: 200_000_000, size_inferred: false, fragments: [{ origin: 0, end: 200_000_000, indexed: true }], uncovered: [],
});
const REG: GraphRegistration = {
  id: 'gp', label: 'pkg', producer: 'fiberbrowser-graph', build_target: 't',
  revisions: { package: 'p'.repeat(64), graph: 'g'.repeat(64), db: 'd'.repeat(64), maps: 'm'.repeat(64) },
  bindings: [binding('tgt', 'chr3', 'GRCh38', 0), binding('mat', 'chr3_MAT', 'S1', 1), binding('pat', 'chr3_PAT', 'S1', 2)],
  maps: [{ target: 'tgt', source: 'pat' }, { target: 'tgt', source: 'mat' }],
};
const BOUND: GraphReadBinding = { dataset_id: 'd', label: 'lifted', kind: 'lifted', revision: 'r1',
  paths: { mat: 'chr3_MAT', pat: 'chr3_PAT' }, haps: { mat: 'MAT', pat: 'PAT' }, problems: [], libraries: 1 };
const NATIVE: GraphReadBinding = { dataset_id: 'n', label: 'native', kind: 'native', revision: 'r2', paths: { tgt: 'chr3' }, problems: [], libraries: 1 };

const panel = (id: string, extra: Partial<PanelConfig> = {}): PanelConfig => ({
  id, contentType: 'dataset', datasetId: 'd', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, stateKey: `k-${id}`, ...extra,
});

function seed(panels: PanelConfig[], view = { chrom: 'chr3', start: 128_650_000, end: 128_660_000 }) {
  useGraphStatusStore.setState({ status: { helper: { available: true }, registrations: [REG] } as never, error: null, loading: false });
  // The key the registration's own refresh computes for these datasets, so it never re-reads them from a server.
  useGraphBindingsStore.setState({ byDataset: { d: [{ registration: REG, binding: BOUND }], n: [{ registration: REG, binding: NATIVE }] },
    problems: {}, key: `d,n||gp@${REG.revisions.package}`, covered: ['d', 'n'], loading: false });
  useBrowserStore.setState({ panels, ...view, currentGenome: 'GRCh38', datasets: [
    { id: 'd', label: 'lifted', data_type: 'bam_livelift', color: '#123456' } as never,
    { id: 'n', label: 'native', data_type: 'bam', color: '#654321' } as never],
    clusterAssignments: {}, clusterOrder: {}, filteredReadIds: {}, selectedReadIds: {}, fullViewPanelId: null });
}
const get = (id: string) => useBrowserStore.getState().panels.find(p => p.id === id)!;
const split = () => [panel('mat', { liftHap: 'MAT', liftHaplotypeMode: 'split' }), panel('pat', { liftHap: 'PAT', liftHaplotypeMode: 'split' })];

beforeEach(() => { localStorage.clear(); useGraphSettings.getState().set({ outBp: 50_000, inBp: 40_000, defaultLiftedView: 'graph' }); });
afterEach(() => vi.useRealTimers());

describe('G1: a dataset panel toggles linear ⇄ graph in place', () => {
  it('keeps id, stateKey and position; its haplotype sibling joins folded with its state', () => {
    seed([panel('other', { datasetId: 'n' }), ...split()]);
    useBrowserStore.setState({ clusterAssignments: { 'k-pat': { a: 1 }, 'k-mat': { b: 2 } } });
    expect(setPanelViewMode('mat', 'graph')).toBeNull();
    const panels = useBrowserStore.getState().panels;
    expect(panels.map(p => p.id)).toEqual(['other', 'mat', 'pat']);
    expect(get('mat')).toMatchObject({ viewMode: 'graph', stateKey: 'k-mat', liftHap: 'MAT' });
    expect(get('mat').graphView).toMatchObject({ schema: 2, role: 'host', targetBinding: 'tgt', members: [{ panelId: 'mat', binding: 'mat' }, { panelId: 'pat', binding: 'pat' }] });
    expect(get('mat').graphView!.selectedPathKeys.slice(0, 3)).toEqual(['tgt', 'pat', 'mat']);
    expect(get('pat')).toMatchObject({ collapsed: true, collapsedByGraphGroup: 'mat', graphMemberOf: 'mat', stateKey: 'k-pat' });
    expect(useBrowserStore.getState().clusterAssignments).toEqual({ 'k-pat': { a: 1 }, 'k-mat': { b: 2 } });
    expect(get('other').graphMemberOf).toBeUndefined();
  });

  it('is one undo step', () => {
    seed(split());
    useBrowserStore.getState().pushSnapshot?.('start', { kind: 'layout' });
    setPanelViewMode('mat', 'graph');
    useBrowserStore.getState().undo();
    expect(get('mat').viewMode).toBeUndefined();
    expect(get('pat').collapsed).toBe(false);
    useBrowserStore.getState().redo();
    expect(get('mat')).toMatchObject({ viewMode: 'graph', graphView: { role: 'host' } });
    expect(get('pat')).toMatchObject({ collapsed: true, collapsedByGraphGroup: 'mat', graphMemberOf: 'mat' });
  });

  it('split → graph → linear → graph: members revealed side by side, then folded again; independent clusters intact', () => {
    seed(split());
    useBrowserStore.setState({ clusterAssignments: { 'k-pat': { a: 1 }, 'k-mat': { a: 3 } } });
    setPanelViewMode('mat', 'graph');
    setPanelViewMode('mat', 'linear');
    expect(get('mat').viewMode).toBe('linear');
    expect(get('pat')).toMatchObject({ collapsed: false, graphHandoff: 'mat', graphMemberOf: 'mat' });
    setPanelViewMode('mat', 'graph');
    expect(get('pat')).toMatchObject({ collapsed: true, collapsedByGraphGroup: 'mat' });
    expect(useBrowserStore.getState().clusterAssignments).toEqual({ 'k-pat': { a: 1 }, 'k-mat': { a: 3 } });
  });

  it('a dataset no package binds is refused with the reason', () => {
    seed([panel('x', { datasetId: 'zzz' })]);
    expect(setPanelViewMode('x', 'graph')).toMatch(/No registered graph package binds/);
    expect(get('x').viewMode).toBeUndefined();
  });

  it('pop out and fold in reveal and hide the member, never copying or resetting it', () => {
    seed(split());
    useBrowserStore.setState({ clusterAssignments: { 'k-pat': { a: 1 } }, selectedReadIds: { 'k-pat': new Set(['q1']) } });
    setPanelViewMode('mat', 'graph');
    expect(poppable(useBrowserStore.getState().panels, get('mat')).folded.map(p => p.id)).toEqual(['pat']);
    popOut('mat', ['pat']);
    expect(get('pat')).toMatchObject({ collapsed: false, graphMemberOf: 'mat' });
    expect(get('pat').collapsedByGraphGroup).toBeUndefined();
    foldIn('mat', ['pat']);
    expect(get('pat')).toMatchObject({ collapsed: true, collapsedByGraphGroup: 'mat' });
    expect(useBrowserStore.getState().clusterAssignments['k-pat']).toEqual({ a: 1 });
    expect([...useBrowserStore.getState().selectedReadIds['k-pat']]).toEqual(['q1']);
  });

  it('a pooled host pops a haplotype out as a new panel with a copy of its state (copyPanelState)', () => {
    seed([panel('pool', { liftHaplotypeMode: 'pooled' })]);
    useBrowserStore.setState({ clusterAssignments: { 'k-pool': { a: 2 } } });
    setPanelViewMode('pool', 'graph');
    const { missing } = poppable(useBrowserStore.getState().panels, get('pool'));
    expect(missing.map(m => m.hap).sort()).toEqual(['MAT', 'PAT']);
    const [made] = popOut('pool', [], missing.filter(m => m.hap === 'PAT'));
    expect(get(made)).toMatchObject({ liftHap: 'PAT', graphMemberOf: 'pool', collapsed: false, stateKey: made });
    expect(useBrowserStore.getState().clusterAssignments[made]).toEqual({ a: 2 });
    expect(membersOf(useBrowserStore.getState().panels, get('pool')).map(m => [m.panel.id, m.member.binding])).toEqual([['pool', null], [made, 'pat']]);
  });

  it('joins and removes another dataset panel bound to a shown path', () => {
    seed([...split(), panel('nat', { datasetId: 'n' })]);
    setPanelViewMode('mat', 'graph');
    expect(joinCandidates(useBrowserStore.getState().panels, get('mat')).map(c => [c.panel.id, c.binding])).toEqual([['nat', 'tgt']]);
    joinGraph('mat', ['nat']);
    expect(get('nat')).toMatchObject({ collapsed: true, collapsedByGraphGroup: 'mat', graphMemberOf: 'mat' });
    removeFromGraph('nat');
    expect(get('nat').collapsed).toBe(false);
    expect(get('nat').graphMemberOf).toBeUndefined();
    expect(get('mat').graphView!.members!.map(m => m.panelId)).toEqual(['mat', 'pat']);
  });
});

describe('G1: lifecycle rules (§4.4)', () => {
  beforeEach(() => { seed(split()); setPanelViewMode('mat', 'graph'); });

  it('duplicate copies neither membership nor the host role', () => {
    const copy = useBrowserStore.getState().duplicatePanel('mat');
    expect(get(copy).viewMode).toBeUndefined();
    expect(get(copy).graphView).toBeUndefined();
    const memberCopy = useBrowserStore.getState().duplicatePanel('pat');
    expect(get(memberCopy).graphMemberOf).toBeUndefined();
    expect(get(memberCopy).collapsedByGraphGroup).toBeUndefined();
    expect(withoutGraphMembership(get('pat')).graphMemberOf).toBeUndefined();
  });

  it('a manual reveal clears the fold, keeps the membership', () => {
    useBrowserStore.getState().setPanelCollapsed('pat', false);
    expect(get('pat').collapsedByGraphGroup).toBeUndefined();
    expect(get('pat').graphMemberOf).toBe('mat');
  });

  it('closing the host reveals its members with their state (D8); closing a member drops it from the list', () => {
    useBrowserStore.getState().removePanel('mat');
    expect(get('pat')).toMatchObject({ collapsed: false });
    expect(get('pat').graphMemberOf).toBeUndefined();
    seed(split());
    setPanelViewMode('mat', 'graph');
    useBrowserStore.getState().removePanel('pat');
    expect(restoreOrphanGraphMembers(useBrowserStore.getState().panels).find(p => p.id === 'mat')!.graphView!.members!.map(m => m.panelId)).toEqual(['mat']);
  });

  it('schema 1 states migrate to standalone; schema 2 hosts restore as they were', () => {
    const old = { id: 'g', contentType: 'graph-view', graphView: { schema: 1, selectedPathKeys: [], linkMode: 'independent' } };
    expect((migratePanelAliases([old] as never)[0] as unknown as PanelConfig).graphView).toMatchObject({ schema: 2, role: 'standalone' });
    const host = get('mat');
    expect(migratePanelAliases([host] as never)[0]).toEqual(host);
  });

  it('a standalone graph view converts into a dataset panel\'s graph mode', () => {
    seed([panel('solo', { liftHap: 'MAT' }), { id: 'gv', contentType: 'graph-view', datasetId: null, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0,
      graphView: { schema: 2, role: 'standalone', registrationId: 'gp', packageRevision: REG.revisions.package, graphRevision: REG.revisions.graph,
        mapRevision: REG.revisions.maps, targetBinding: 'tgt', targetReferenceId: 'GRCh38', initiatingPanelId: null, initiatingReferenceId: null,
        selectedPathKeys: ['tgt', 'mat'], targetViewport: { contig: 'chr3', start: 128_651_000, end: 128_655_000 }, linkMode: 'independent',
        layoutSettings: { contextBp: 500, laneHeight: 28 } } } as PanelConfig]);
    expect(convertStandalone('gv', 'solo')).toBeNull();
    expect(useBrowserStore.getState().panels.map(p => p.id)).toEqual(['solo']);
    expect(get('solo').graphView).toMatchObject({ role: 'host', selectedPathKeys: ['tgt', 'mat'], layoutSettings: { contextBp: 500 } });
    expect(useBrowserStore.getState().start).toBe(128_651_000);
  });

  it('review fixes: no join across views or into another host; copies at a site carry no membership; exclusions copy', async () => {
    const { copyPanelAtSite } = await import('../../utils/panelCopies');
    useBrowserStore.setState(s => ({ panels: [...s.panels, panel('far', { datasetId: 'n', viewportOverride: { chrom: 'chr3', start: 600_000, end: 610_000 } }),
      panel('near', { datasetId: 'n' })] }));
    expect(joinCandidates(useBrowserStore.getState().panels, get('mat')).map(c => c.panel.id)).toEqual(['near']);
    const copy = copyPanelAtSite(get('pat'), 'c1', { chrom: 'chr3', start: 0, end: 10 });
    expect(copy.graphMemberOf).toBeUndefined();
    expect(copyPanelAtSite(get('mat'), 'c2', { chrom: 'chr3', start: 0, end: 10 }).viewMode).toBeUndefined();
  });

  it('a host viewed linear is never another host\'s member', () => {
    seed([...split(), panel('pool2', { datasetId: 'n' })]);
    setPanelViewMode('mat', 'graph');
    setPanelViewMode('pool2', 'graph');
    setPanelViewMode('mat', 'linear');
    expect(joinCandidates(useBrowserStore.getState().panels, get('pool2')).map(c => c.panel.id)).not.toContain('mat');
  });

  it('a Cluster run includes folded members through their shown host', () => {
    const st = useBrowserStore.getState();
    const windows = clusterWindows(st as never, ['d']);
    expect(windows.map(w => [w.result_key, w.lift_hap])).toEqual([['k-mat', 'MAT'], ['k-pat', 'PAT']]);
  });
});

describe('G6: zoom hand-off (§7)', () => {
  it('decides with hysteresis: out above 50 kb, back at 40 kb, linear when pinned or off the target', () => {
    const o = { outBp: 50_000, inBp: 40_000, followable: true };
    expect(decideShown('graph', 50_000, o)).toBe('graph');
    expect(decideShown('graph', 50_001, o)).toBe('linear');
    expect(decideShown('linear', 45_000, o)).toBe('linear');
    expect(decideShown('linear', 40_000, o)).toBe('graph');
    expect(decideShown('graph', 10_000, { ...o, pinnedLinear: true })).toBe('linear');
    expect(decideShown('graph', 10_000, { ...o, followable: false })).toBe('linear');
  });

  it('opens linear when already wider than the hand-off, with members side by side', () => {
    seed(split(), { chrom: 'chr3', start: 128_600_000, end: 128_700_000 });
    setPanelViewMode('mat', 'graph');
    expect(get('mat').graphView!.handoff!.shown).toBe('linear');
    expect(get('pat')).toMatchObject({ collapsed: false, graphHandoff: 'mat' });
  });

  it('settles once per gesture (300 ms), reveals members going out and folds them coming back', () => {
    vi.useFakeTimers();
    startHandoffController();
    seed(split());
    setPanelViewMode('mat', 'graph');
    const view = (w: number) => useBrowserStore.setState({ start: 128_650_000, end: 128_650_000 + w });
    view(60_000);
    view(48_000);   // within the same gesture: back under 50 kb, nothing changes
    vi.advanceTimersByTime(HANDOFF_SETTLE_MS + 10);
    expect(get('mat').graphView!.handoff!.shown).toBe('graph');
    view(80_000);
    vi.advanceTimersByTime(HANDOFF_SETTLE_MS - 50);
    expect(get('mat').graphView!.handoff!.shown).toBe('graph');
    vi.advanceTimersByTime(100);
    expect(get('mat').graphView!.handoff!.shown).toBe('linear');
    expect(get('pat')).toMatchObject({ collapsed: false, graphHandoff: 'mat' });
    expect(get('mat').viewMode).toBe('graph');   // intent kept
    view(45_000);
    vi.advanceTimersByTime(HANDOFF_SETTLE_MS + 10);
    expect(get('mat').graphView!.handoff!.shown).toBe('linear');   // no flapping inside the band
    view(30_000);
    vi.advanceTimersByTime(HANDOFF_SETTLE_MS + 10);
    expect(get('mat').graphView!.handoff!.shown).toBe('graph');
    expect(get('pat')).toMatchObject({ collapsed: true, collapsedByGraphGroup: 'mat' });
    setPinnedLinear('mat', true);
    expect(get('mat').graphView!.handoff!.shown).toBe('linear');
    setPinnedLinear('mat', false);
    expect(get('mat').graphView!.handoff!.shown).toBe('graph');
  });

  it('an own-view host reveals its members at its view, site-locked', () => {
    seed(split().map(p => ({ ...p, viewportOverride: { chrom: 'chr3', start: 250_000, end: 260_000 } })));
    setPanelViewMode('mat', 'graph');
    const panels = applyShown(useBrowserStore.getState().panels.map(p => (p.id === 'mat' ? { ...p, viewportOverride: { chrom: 'chr3', start: 250_000, end: 310_000 } } : p)), 'mat', 'linear');
    expect(panels.find(p => p.id === 'pat')).toMatchObject({ collapsed: false, siteLocked: true, viewportOverride: { start: 250_000, end: 310_000 } });
    expect(panels.find(p => p.id === 'mat')!.siteLocked).toBe(true);
  });

  it('a member revealed by hand during the hand-off stays revealed on return', () => {
    seed(split());
    setPanelViewMode('mat', 'graph');
    let panels = applyShown(useBrowserStore.getState().panels, 'mat', 'linear');
    panels = panels.map(p => (p.id === 'pat' ? withoutGraphMembership({ ...p, graphMemberOf: 'mat' }) : p)).map(p => (p.id === 'pat' ? { ...p, graphMemberOf: 'mat' } : p));
    panels = applyShown(panels, 'mat', 'graph');
    expect(panels.find(p => p.id === 'pat')!.collapsed).toBe(false);
  });

  it('a new lifted dataset with a package opens as a graph; without one it stays split', async () => {
    seed(split());
    notePendingGraphOpen('d');
    await new Promise(r => setTimeout(r, 0));
    expect(isHost(get('mat'))).toBe(true);
    expect(get('pat').collapsedByGraphGroup).toBe('mat');
    seed(split().map(p => ({ ...p, datasetId: 'zzz' })));
    useBrowserStore.setState(s => ({ datasets: [...s.datasets, { id: 'zzz', label: 'z', data_type: 'bam_livelift' } as never] }));
    useGraphBindingsStore.setState({ covered: ['d', 'n', 'zzz'], key: `d,n,zzz||gp@${REG.revisions.package}` });
    notePendingGraphOpen('zzz');
    await new Promise(r => setTimeout(r, 0));
    expect(get('mat').viewMode).toBeUndefined();
  });
});

describe('G3: sub-bands read each member\'s own state through record keys', () => {
  const aid = (q: string, row = 0, placement = 'primary') => `lift-cohort:v1 ${JSON.stringify([`d#0|${q}`, q, `${q}:r`, row, placement])}`;
  const rk = (q: string) => `lift-record:v1 ${JSON.stringify([`d#0|${q}`, q, `${q}:r`])}`;
  const read = (q: string, hap: 'MAT' | 'PAT', x0: number, len = 50): PlacedMolecule => ({
    read: { k: `d|0|${q}|r`, d: 'd', lib: 0, q, rec: 'r', b: hap === 'MAT' ? 'mat' : 'pat', c: '', st: '+', sup: false, s: x0, e: x0 + len,
      cov: [], ins: [], aid: aid(q), rk: rk(q), hap } as GraphRead,
    lane: hap === 'MAT' ? 'mat' : 'pat', visits: [], body: [{ x0, x1: x0 + len, s0: x0, s1: x0 + len, occ: 'o', dir: 1 }], calls: [], m6a: [],
    density: [], ins: [], holes: [], connectors: [], extent: [x0, x0 + len], unplacedBp: 0,
  });
  const M: BandMember = { panelId: 'mat', stateKey: 'k-mat', datasetId: 'd', liftHap: 'MAT', binding: 'mat', label: 'MAT', color: '#111' };
  const P: BandMember = { panelId: 'pat', stateKey: 'k-pat', datasetId: 'd', liftHap: 'PAT', binding: 'pat', label: 'PAT', color: '#111' };
  const mols = [read('a', 'MAT', 0), read('b', 'MAT', 10), read('c', 'MAT', 100), read('d', 'PAT', 0)];

  it('routes rows to members by dataset, haplotype and path', () => {
    expect(routeRead(mols[0].read, M)).toBe(true);
    expect(routeRead(mols[0].read, P)).toBe(false);
    expect(routeRead(mols[3].read, { ...P, binding: null })).toBe(true);
  });

  it('labels from a linear run (another row index, another placement) by record key, primary placement first', () => {
    const assignments = { [aid('a', 1)]: 2, [aid('b', 0, 'alt:1')]: 4, [aid('b', 2)]: 1 };
    expect(clusterOf(mols[0].read, assignments)).toBe(2);
    expect(clusterOf(mols[1].read, assignments)).toBe(1);
    expect(clusterOf(mols[2].read, assignments)).toBeUndefined();
  });

  it('applies exclusions, id filters, focus, clusters and sort per member', () => {
    const lanes = packMemberBands(mols, [M, P], {
      mat: { assignments: { [aid('a', 1)]: 2, [aid('c', 1)]: 1 }, clusterOrder: [1, 2], excluded: new Set(['b']) },
      pat: { filter: new Set([rk('d')]) },
    }, 40);
    const mat = lanes.get('mat')!;
    expect(mat.groups.map(g => [g.memberId, g.order, g.rowCount])).toEqual([['mat', 'cluster', 2]]);
    expect(mat.rows.map(r => r.map(m => m.read.q))).toEqual([['c'], ['a']]);
    expect(mat.rowCluster).toEqual([1, 2]);
    expect(lanes.get('pat')!.rows.map(r => r.map(m => m.read.q))).toEqual([['d']]);
    const focused = packMemberBands(mols, [M], { mat: { assignments: { [aid('a')]: 2, [aid('c')]: 1 }, focus: new Set([2]) } }, 40);
    expect(focused.get('mat')!.rows.flat().map(m => m.read.q)).toEqual(['a']);
    const sorted = packMemberBands(mols, [M], { mat: { sort: ['c', aid('b', 3), 'a'] } }, 40);
    expect(sorted.get('mat')!.rows.map(r => r[0].read.q)).toEqual(['c', 'b', 'a']);
    expect(sorted.get('mat')!.groups[0].order).toBe('sort');
    // Unclustered, unsorted: by first drawn base (first fit), or longest first.
    const plain = packMemberBands(mols, [M], {}, 40);
    expect(plain.get('mat')!.rows.map(r => r.map(m => m.read.q))).toEqual([['a', 'c'], ['b']]);
    expect(plain.get('mat')!.rowCluster).toEqual([null, null]);
  });

  it('review fixes: unassigned focus, clusters before the sort, branch scope', () => {
    const un = packMemberBands(mols, [M], { mat: { assignments: { [aid('a')]: -1, [aid('b')]: 1 }, focus: new Set([-1]) } }, 40);
    expect(un.get('mat')!.rows.flat().map(m => m.read.q)).toEqual(['a']);
    // Linear order: clusters first, the sort within each cluster.
    const both = packMemberBands(mols, [M], { mat: { assignments: { [aid('a')]: 2, [aid('b')]: 1, [aid('c')]: 1 }, clusterOrder: [1, 2], sort: ['a', 'c', 'b'] } }, 40);
    expect(both.get('mat')!.rows.map(r => r[0].read.q)).toEqual(['c', 'b', 'a']);
    const branch = packMemberBands(mols, [M], { mat: { assignments: { [aid('a', 1)]: 0 }, branchScope: new Set([aid('a', 1)]) } }, 40);
    expect(branch.get('mat')!.rows.flat().map(m => m.read.q)).toEqual(['a']);
  });

  it('two members of one dataset with different filters each draw the row under their own rules', () => {
    const copy: BandMember = { ...M, panelId: 'mat2', stateKey: 'k-mat2', label: 'MAT copy' };
    const lanes = packMemberBands(mols, [M, copy], { mat2: { filter: new Set(['a']) } }, 40);
    expect(lanes.get('mat')!.groups.map(g => [g.memberId, g.reads])).toEqual([['mat', 3], ['mat2', 1]]);
    expect(lanes.get('mat')!.rowMember).toEqual(['mat', 'mat', 'mat2']);
  });
});

it('graph primary leaves panels without a host alone', () => {
  seed(split());
  expect(enterGraph(useBrowserStore.getState().panels, 'nope', { registration: REG, binding: BOUND }, { chrom: 'chr3', start: 0, end: 10 })).toBeNull();
  expect(leaveGraph(useBrowserStore.getState().panels, 'mat').find(p => p.id === 'pat')).toEqual(get('pat'));
});
