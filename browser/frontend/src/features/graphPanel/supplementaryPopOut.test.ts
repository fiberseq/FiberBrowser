import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { drawnRowOwnership } from '../../stores/clusterSlice';
import { useGraphStatusStore } from './statusStore';
import { useGraphBindingsStore } from './bindingsStore';
import { commitGraphRun, graphClusterPlan, routedDestinationLabels } from './graphCluster';
import { popOut } from './hostMode';
import { drawnRowHapsOf, useGraphReadsStore } from './graphReadsStore';
import { useTrackFeedStore } from '../../stores/trackFeedStore';
import { recordKey } from '../../utils/recordKeys';
import type { GraphRead, GraphRegistration } from './types';
import type { PanelConfig } from '../../types';

/**
 * Stabilize 3, item 1 (stabilize 2, item 7): a supplementary record is drawn on its own record's path, so the graph run
 * labels it through that path's observation, while the lifted panels show its row on its primary record's haplotype.
 * A MAT supplementary of a PAT molecule was unlabelled in the PAT pop-out. The server now sends the primary's haplotype
 * (`ph`) with supplementary graph rows; the graph panel publishes those rows on it, and the run (a split host's
 * member) and the pop-out (a pooled host's new panel) route the label there. Record-level keys (no fold) and folded
 * molecules alike; never to a source view, which shows each record on its own contig.
 */
const REG: GraphRegistration = {
  id: 'pkg1', label: 'test', revisions: { package: 'p1', graph: 'g1', maps: 'm1' },
  bindings: [
    { key: 'ref', label: 'REF', role: 'reference', reference: 'ref_g', path: { contig: 'chr3', size: 200_000_000 } },
    { key: 'mat', label: 'MAT', role: 'haplotype', sample: 'S1', haplotype: 'MAT', path: { contig: 'S1#1#c1', size: 1000 } },
    { key: 'pat', label: 'PAT', role: 'haplotype', sample: 'S1', haplotype: 'PAT', path: { contig: 'S1#2#c1', size: 1000 } },
  ],
  maps: [{ source: 'mat', target: 'ref' }, { source: 'pat', target: 'ref' }],
};

/** A record's graph-row identity (no fold: its record names it; the graph's one piece is the primary placement). */
const rid = (q: string, rec: string) => `lift-cohort:v1 ${JSON.stringify([`ds1#0|${q}`, q, rec, 0, 'primary'])}`;
/** A folded row's identity (fold_molecule: no record, no row index). */
const fid = (q: string) => `lift-cohort:v1 ${JSON.stringify([`ds1#0|${q}`, q, null, null, 'primary'])}`;
const rk = (id: string) => recordKey(id)!;
// molS: a supplementary on MAT (the record "s") and its primary on PAT (the record "p").
const SUP = rid('molS', 's');
const PRIM = rid('molS', 'p');
const M1 = rid('m1', 'a');
const P1 = rid('p1', 'a');

const graphView = (members: { panelId: string; binding: string | null }[]) => ({
  schema: 2, role: 'host', registrationId: 'pkg1', packageRevision: 'p1', graphRevision: 'g1', mapRevision: 'm1',
  targetBinding: 'ref', targetReferenceId: 'ref_g', initiatingPanelId: null, initiatingReferenceId: null,
  selectedPathKeys: ['ref', 'mat', 'pat'], targetViewport: null, linkMode: 'independent',
  layoutSettings: { contextBp: 1000, laneHeight: 28 }, members, handoff: { pinnedLinear: false, shown: 'graph' },
});

/** A split host: the MAT panel shows the graph, the PAT panel is folded into it. */
function splitPanels(): PanelConfig[] {
  return [
    { id: 'hostM', stateKey: 'k-m', contentType: 'dataset', datasetId: 'ds1', viewMode: 'graph', collapsed: false, subTracks: [],
      linkGroup: null, liftHap: 'MAT', liftHaplotypeMode: 'split',
      graphView: graphView([{ panelId: 'hostM', binding: 'mat' }, { panelId: 'patM', binding: 'pat' }]) },
    { id: 'patM', stateKey: 'k-p', contentType: 'dataset', datasetId: 'ds1', collapsed: true, subTracks: [], linkGroup: null,
      liftHap: 'PAT', liftHaplotypeMode: 'split', graphMemberOf: 'hostM', collapsedByGraphGroup: 'hostM' },
  ] as PanelConfig[];
}

function pooledPanels(): PanelConfig[] {
  return [{ id: 'hostA', stateKey: 'k-a', contentType: 'dataset', datasetId: 'ds1', viewMode: 'graph', collapsed: false,
    subTracks: [], linkGroup: null, liftHaplotypeMode: 'pooled', graphView: graphView([{ panelId: 'hostA', binding: null }]) }] as PanelConfig[];
}

function setup(panels: PanelConfig[], fold = false) {
  useGraphStatusStore.setState({ status: { helper: { available: true }, registrations: [REG], errors: [], warnings: [] } as never, loading: false, error: null });
  useGraphBindingsStore.setState({ key: 'k', problems: {}, byDataset: { ds1: [{ registration: REG,
    binding: { kind: 'lifted', target: 'ref', paths: { mat: 'S1#1#c1', pat: 'S1#2#c1' }, haps: { mat: 'MAT', pat: 'PAT' }, revision: 'r1' } }] } } as never);
  useBrowserStore.setState({
    chrom: 'chr3', start: 128_650_000, end: 128_660_000, genomes: [{ id: 'ref_g', label: 'REF', active: true }] as never,
    datasets: [{ id: 'ds1', label: 'Synth1', live_lift: { settings: { fold_molecule: fold }, haplotype_labels: { 'S1#1': 'MAT', 'S1#2': 'PAT' } } }] as never,
    panels, selectedDatasets: new Set(), filteredReadIds: {}, selectedClusters: {}, clusterFocus: {},
    clusterAssignments: {}, clusterOrder: {}, clusterGroupLabels: {}, svSplits: {}, svCarrierEvidence: {},
    clusterMatchedRun: null, activeClusterTreeNodeId: null, clusterTreeNodes: {}, clusterTreeRootIds: [],
    clusterMethod: 'kmeans', clusterK: 2, clusterResolution: 1, subnucleosomalThreshold: 120, accessibilityThreshold: 30,
  } as never);
  useTrackFeedStore.setState({ byStateKey: {} });
  useGraphReadsStore.setState({ byPanel: {}, rowHaps: {} });
}

/** A graph run on the host: each path's observation labels the rows on that path. */
function runGraph(hostId: string, mat: Record<string, number>, pat: Record<string, number>) {
  useBrowserStore.setState({ selectedDatasets: new Set([hostId]) } as never);
  const plan = graphClusterPlan(useBrowserStore.getState() as never,
    { kind: 'peaks', regions: [{ start: 128_655_000, end: 128_655_200, mode: 'accessibility', chrom: 'chr3' }] })!;
  const obsM = plan.observations.find(o => o.binding === 'mat')!.id;
  const obsP = plan.observations.find(o => o.binding === 'pat')!.id;
  commitGraphRun(useBrowserStore.getState(), plan, {
    results: { [obsM]: { assignments: mat, stage1: mat }, [obsP]: { assignments: pat, stage1: pat } },
    label_ids: { '0': 0, '1': 1 }, names: {}, stages: [{ stage: 1 }],
    columns: { regions: plan.regions, shared: [{ kind: 'target', region: 0, length: 200, label: 't', carriers: [obsM, obsP], samples: 20 }],
      carrier_sets: [], left_out: {}, dropped: [], refinements: [] },
    observations: [obsM, obsP], window_separation_nmi: null,
    matched: { lengths: [200], balanced: false, balanced_fit_reads: 2, fit_reads: 2 },
    settings: {}, revisions: REG.revisions, target: 'ref', options: {}, timings: {},
  } as never);
  useBrowserStore.setState({ selectedDatasets: new Set() } as never);
  return { plan, obsM, obsP };
}

/** The graph rows the host drew: molS's supplementary on the MAT path, with its primary's haplotype when known. */
function graphRows(ph: string | null, folded = false): GraphRead[] {
  const row = (q: string, id: string, b: string, hap: string, sup: boolean, extra: Partial<GraphRead> = {}) =>
    ({ k: `ds1|0|${q}|${id}`, d: 'ds1', lib: 0, q, rec: id, aid: id, rk: rk(id), hap, b, c: b, st: '+', sup, s: 0, e: 100,
      cov: [], ins: [], ...extra }) as GraphRead;
  const sup = folded ? fid('molS') : SUP;
  return [
    row('molS', sup, 'mat', 'MAT', true, ph ? { ph } : {}),
    row('m1', folded ? fid('m1') : M1, 'mat', 'MAT', false),
    row('p1', folded ? fid('p1') : P1, 'pat', 'PAT', false),
  ];
}

describe('a supplementary drawn on the other haplotype\'s path (stabilize 3, item 1)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('the graph panel publishes a supplementary on its primary\'s haplotype, and no other non-folded row', () => {
    expect(drawnRowHapsOf(graphRows('PAT'))).toEqual([{ rk: rk(SUP), datasetId: 'ds1', hap: 'PAT' }]);
    // Primary unknown: nothing to route.
    expect(drawnRowHapsOf(graphRows(null))).toEqual([]);
    // Folded: the supplementary (molecule key) on its primary's haplotype, folded primary rows on their path's.
    expect(drawnRowHapsOf(graphRows('PAT', true)).map(r => [r.rk, r.hap])).toEqual([
      [rk(fid('molS')), 'PAT'], [rk(fid('m1')), 'MAT'], [rk(fid('p1')), 'PAT']]);
  });

  it('split host: the PAT member takes the label the MAT path gave the supplementary, so its pop-out shows it labelled', () => {
    setup(splitPanels());
    useGraphReadsStore.getState().publishRowHaps('hostM', drawnRowHapsOf(graphRows('PAT')));
    runGraph('hostM', { [SUP]: 0, [M1]: 1 }, { [PRIM]: 1, [P1]: 0 });
    const st = useBrowserStore.getState();
    expect(st.clusterAssignments['k-p']).toEqual({ [rk(SUP)]: 0, [rk(PRIM)]: 1, [rk(P1)]: 0 });
    // The host keeps the run's own labels of its path.
    expect(st.clusterAssignments['k-m']).toEqual({ [rk(SUP)]: 0, [rk(M1)]: 1 });
    // Popped out, the PAT panel keeps it.
    popOut('hostM', ['patM']);
    expect(useBrowserStore.getState().panels.find(p => p.id === 'patM')?.collapsed).toBe(false);
    expect(useBrowserStore.getState().clusterAssignments['k-p']?.[rk(SUP)]).toBe(0);
  });

  it('split host: without the primary\'s haplotype, or with another path\'s "not a carrier", nothing is routed', () => {
    setup(splitPanels());
    useGraphReadsStore.getState().publishRowHaps('hostM', drawnRowHapsOf(graphRows(null)));
    runGraph('hostM', { [SUP]: 0, [M1]: 1 }, { [P1]: 0 });
    expect(useBrowserStore.getState().clusterAssignments['k-p']).toEqual({ [rk(P1)]: 0 });
    setup(splitPanels());
    useGraphReadsStore.getState().publishRowHaps('hostM', drawnRowHapsOf(graphRows('PAT')));
    runGraph('hostM', { [SUP]: -2, [M1]: 1 }, { [P1]: 0 });
    expect(useBrowserStore.getState().clusterAssignments['k-p']).toEqual({ [rk(P1)]: 0 });
  });

  it('split host, folded molecules: a molecule labelled only through its MAT supplementary reaches the PAT member', () => {
    setup(splitPanels(), true);
    useGraphReadsStore.getState().publishRowHaps('hostM', drawnRowHapsOf(graphRows('PAT', true)));
    runGraph('hostM', { [fid('molS')]: 0, [fid('m1')]: 1 }, { [fid('p1')]: 0 });
    expect(useBrowserStore.getState().clusterAssignments['k-p']).toEqual({ [rk(fid('molS'))]: 0, [rk(fid('p1'))]: 0 });
  });

  it('pooled host: the new PAT panel takes the supplementary\'s label', () => {
    setup(pooledPanels());
    useGraphReadsStore.getState().publishRowHaps('hostA', drawnRowHapsOf(graphRows('PAT')));
    runGraph('hostA', { [SUP]: 0, [M1]: 1 }, { [PRIM]: 1, [P1]: 0 });
    const [, patId] = popOut('hostA', [], [{ binding: 'mat', hap: 'MAT' }, { binding: 'pat', hap: 'PAT' }]);
    const st = useBrowserStore.getState();
    expect(st.clusterAssignments[patId]).toEqual({ [rk(SUP)]: 0, [rk(PRIM)]: 1, [rk(P1)]: 0 });
    // And on the tree node, so a branch switch keeps it.
    expect(st.clusterTreeNodes[st.activeClusterTreeNodeId!].assignments[patId]?.[rk(SUP)]).toBe(0);
  });

  it('a source view takes no record routed by a drawn row: it shows each record on its own contig', () => {
    const obs = [{ id: 'oM', dataset_id: 'ds1', kind: 'graph', binding: 'mat', hap: 'MAT' },
      { id: 'oP', dataset_id: 'ds1', kind: 'graph', binding: 'pat', hap: 'PAT' }] as never[];
    const runs = [{ observations: obs, owned: { oM: [rk(SUP)], oP: [rk(PRIM)] } }];
    const rows = [{ rk: rk(SUP), datasetId: 'ds1', haps: ['PAT'] }];
    const labels = { [rk(SUP)]: 0, [rk(PRIM)]: 1 };
    expect(drawnRowOwnership(runs as never, labels, rows)).toBeNull();
    expect(drawnRowOwnership(runs as never, labels, rows, { records: true })?.owned).toEqual({ oP: [rk(SUP)] });
    expect(routedDestinationLabels({ stateKey: 'src', observations: ['oP'], panelId: 'src', scope: null, keyBy: 'qname' },
      obs, { oM: { assignments: { [SUP]: 0 } } }, rows)).toEqual({});
  });
});
