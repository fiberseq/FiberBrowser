import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useGraphStatusStore } from './statusStore';
import { useGraphBindingsStore } from './bindingsStore';
import {
  assignWithGraphRun,
  commitGraphRun,
  graphClusterPlan,
} from './graphCluster';
import { popOut } from './hostMode';
import { seedSourceState } from './popOutKind';
import { clusteredReadIdSet } from '../../components/tracks/read-track/readFilter';
import { recordKey } from '../../utils/recordKeys';
import { applySvSplit } from '../../utils/svAlleleSplit';
import { remapDatasetIds, serializeState } from '../../stores/historySlice';
import type { GraphRegistration } from './types';
import type { PanelConfig } from '../../types';

const REG: GraphRegistration = {
  id: 'pkg1',
  label: 'test',
  revisions: { package: 'p1', graph: 'g1', maps: 'm1' },
  bindings: [
    { key: 'ref', label: 'REF', role: 'reference', reference: 'ref_g', path: { contig: 'chr3', size: 200_000_000 } },
    { key: 'mat', label: 'MAT', role: 'haplotype', sample: 'S1', haplotype: 'MAT', path: { contig: 'S1#1#c1', size: 1000 } },
    { key: 'pat', label: 'PAT', role: 'haplotype', sample: 'S1', haplotype: 'PAT', path: { contig: 'S1#2#c1', size: 1000 } },
  ],
  maps: [{ source: 'mat', target: 'ref' }, { source: 'pat', target: 'ref' }],
};

const aid = (ds: string, q: string, rec: string | null = `r_${q}`) =>
  `lift-cohort:v1 ${JSON.stringify([`${ds}|${q}`, q, rec, 0, 'primary'])}`;
const rk = (id: string) => recordKey(id)!;

function makeHostPanel(id: string, datasetId: string, stateKey?: string): PanelConfig {
  return {
    id,
    ...(stateKey ? { stateKey } : {}),
    contentType: 'dataset',
    datasetId,
    viewMode: 'graph',
    collapsed: false,
    subTracks: [],
    linkGroup: null,
    graphView: {
      schema: 2,
      role: 'host',
      registrationId: 'pkg1',
      packageRevision: 'p1',
      graphRevision: 'g1',
      mapRevision: 'm1',
      targetBinding: 'ref',
      targetReferenceId: 'ref_g',
      initiatingPanelId: null,
      initiatingReferenceId: null,
      selectedPathKeys: ['ref', 'mat', 'pat'],
      targetViewport: null,
      linkMode: 'independent',
      layoutSettings: { contextBp: 1000, laneHeight: 28 },
      members: [{ panelId: id, binding: null }],
      handoff: { pinnedLinear: false, shown: 'graph' },
    },
  } as PanelConfig;
}

function setupWorkspace(extraPanels: PanelConfig[] = [], hostStateKey?: string) {
  const host = makeHostPanel('hostA', 'ds1', hostStateKey ?? 'k-hostA');
  useGraphStatusStore.setState({
    status: { helper: { available: true }, registrations: [REG], errors: [], warnings: [] } as never,
    loading: false,
    error: null,
  });
  useGraphBindingsStore.setState({
    key: 'k',
    problems: {},
    byDataset: {
      ds1: [{
        registration: REG,
        binding: { kind: 'lifted', target: 'ref', paths: { mat: 'S1#1#c1', pat: 'S1#2#c1' }, haps: { mat: 'MAT', pat: 'PAT' }, revision: 'r1' },
      }],
      ds2: [{
        registration: REG,
        binding: { kind: 'lifted', target: 'ref', paths: { mat: 'S1#1#c1', pat: 'S1#2#c1' }, haps: { mat: 'MAT', pat: 'PAT' }, revision: 'r2' },
      }],
    },
  });
  useBrowserStore.setState({
    chrom: 'chr3',
    start: 128_650_000,
    end: 128_660_000,
    genomes: [{ id: 'ref_g', label: 'REF', active: true }] as never,
    datasets: [
      { id: 'ds1', label: 'Synth1', live_lift: { settings: {} }, source_assembly_dataset_id: 'src1' },
      { id: 'ds2', label: 'Synth2', live_lift: { settings: {} } },
      { id: 'dsLin', label: 'SynthLin' },
      { id: 'src1', label: 'Synth1Source', chroms: { 'S1#2#c1': 1000 } },
    ] as never,
    panels: [host, ...extraPanels],
    selectedDatasets: new Set(),
    filteredReadIds: {},
    selectedClusters: {},
    clusterFocus: {},
    clusterAssignments: {},
    clusterOrder: {},
    clusterGroupLabels: {},
    svSplits: {},
    svCarrierEvidence: {},
    clusterMatchedRun: null,
    activeClusterTreeNodeId: null,
    clusterTreeNodes: {},
    clusterTreeRootIds: [],
    clusterMethod: 'kmeans',
    clusterK: 2,
    clusterResolution: 1,
    subnucleosomalThreshold: 120,
    accessibilityThreshold: 30,
  } as never);
}

function runGraphOn(panelId: string, matAssigns: Record<string, number>, patAssigns: Record<string, number>, ds = 'ds1') {
  const prevSel = useBrowserStore.getState().selectedDatasets;
  useBrowserStore.setState({ selectedDatasets: new Set([panelId]) } as never);
  const st = useBrowserStore.getState();
  const plan = graphClusterPlan(
    { ...st, panels: st.panels, datasets: st.datasets, selectedDatasets: st.selectedDatasets } as never,
    { kind: 'peaks', regions: [{ start: 128_655_000, end: 128_655_200, mode: 'accessibility', chrom: 'chr3' }] },
  )!;
  const obsM = plan.observations.find(o => o.dataset_id === ds && o.binding === 'mat')!.id;
  const obsP = plan.observations.find(o => o.dataset_id === ds && o.binding === 'pat')!.id;
  commitGraphRun(
    useBrowserStore.getState(),
    plan,
    {
      results: {
        [obsM]: { assignments: matAssigns, stage1: matAssigns },
        [obsP]: Object.keys(patAssigns).length
          ? { assignments: patAssigns, stage1: patAssigns, not_carrier: true, left_out: 'not a carrier' }
          : { assignments: {}, stage1: {}, left_out: 'left out' },
      },
      label_ids: { '0': 0, '1': 1 },
      names: {},
      stages: [{ stage: 1 }],
      columns: { regions: plan.regions, shared: [], carrier_sets: [{ carriers: [obsM], features: [{ kind: 'insertion', length: 200, samples: 8, label: 'ins' }] }], left_out: {}, dropped: [], refinements: [] },
      observations: [obsM, obsP],
      window_separation_nmi: null,
      matched: { lengths: [200], balanced: false, balanced_fit_reads: 2, fit_reads: 2 },
      settings: {},
      revisions: REG.revisions,
      target: 'ref',
      options: {},
      timings: {},
    } as never,
  );
  useBrowserStore.setState({ selectedDatasets: prevSel } as never);
  return { plan, obsM, obsP };
}


/**
 * Graph follow-ups, agy's review of the group B fix, round 4: a tree node's graph-run provenance is kept per panel
 * (another panel's run or re-sync of the node keeps it; a reopened session remaps it), the current run's is used when
 * the node has none, and labels no run owns are copied to a pop-out on every node as on the live map.
 */
describe('pop-out provenance across panels and sessions (agy round 4)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("another panel's clustering re-syncs the node and keeps the host's provenance", () => {
    const lin = { id: 'linB', stateKey: 'k-linB', contentType: 'dataset', datasetId: 'dsLin', collapsed: false,
      subTracks: [], linkGroup: null } as PanelConfig;
    setupWorkspace([lin]);
    const m0 = aid('ds1', 'm0');
    const m1 = aid('ds1', 'm1');
    runGraphOn('hostA', { [m0]: 0, [m1]: 1 }, {});
    const rootId = useBrowserStore.getState().activeClusterTreeNodeId!;
    useBrowserStore.getState().setClusterAssignments('k-linB', { lin_r1: 0, lin_r2: 1 });
    useBrowserStore.getState().syncActiveClusterTreeNode();
    expect(useBrowserStore.getState().clusterTreeNodes[rootId].graphProvenance?.['k-hostA']).toBeDefined();
    const [matId, patId] = popOut('hostA', [], [{ binding: 'mat', hap: 'MAT' }, { binding: 'pat', hap: 'PAT' }]);
    const st = useBrowserStore.getState();
    expect(st.clusterAssignments[patId]).toBeUndefined();
    expect(st.clusterAssignments[matId]).toEqual({ [rk(m0)]: 0, [rk(m1)]: 1 });
    expect(st.clusterTreeNodes[rootId].assignments[matId]).toEqual({ [rk(m0)]: 0, [rk(m1)]: 1 });
  });

  it("a second graph host's run on the same node keeps the first host's provenance", () => {
    setupWorkspace([makeHostPanel('hostB', 'ds2', 'k-hostB')]);
    const m0 = aid('ds1', 'm0');
    const m1 = aid('ds1', 'm1');
    runGraphOn('hostA', { [m0]: 0, [m1]: 1 }, {}, 'ds1');
    runGraphOn('hostB', { [aid('ds2', 'b0')]: 0 }, {}, 'ds2');
    const rootId = useBrowserStore.getState().activeClusterTreeNodeId!;
    expect(Object.keys(useBrowserStore.getState().clusterTreeNodes[rootId].graphProvenance ?? {}).sort()).toEqual(['k-hostA', 'k-hostB']);
    const [patId] = popOut('hostA', [], [{ binding: 'pat', hap: 'PAT' }]);
    expect(useBrowserStore.getState().clusterAssignments[patId]).toBeUndefined();
  });

  it('a reopened session remaps the provenance with the dataset ids', () => {
    setupWorkspace();
    useBrowserStore.setState(s => ({ panels: s.panels.map(p => (p.id === 'hostA' ? { ...p, stateKey: undefined } : p)) }));
    runGraphOn('hostA', { [aid('ds1', 'm0')]: 0 }, {});
    const remapped = remapDatasetIds(serializeState(useBrowserStore.getState()), { ds1: 'ds1_reopened' });
    const node = remapped.clusterTreeNodes[remapped.activeClusterTreeNodeId!];
    expect(node.assignments['ds1_reopened']).toBeDefined();
    expect(Object.keys(node.graphProvenance ?? {})).toEqual(['ds1_reopened']);
    expect(node.graphProvenance!['ds1_reopened'].observations.every(o => o.dataset_id === 'ds1_reopened')).toBe(true);
  });

  it('labels no graph run owns are copied to the pop-out on the node too, so a branch switch keeps them', () => {
    setupWorkspace();
    const m0 = aid('ds1', 'm0');
    const mNew = aid('ds1', 'mNew');
    runGraphOn('hostA', { [m0]: 0 }, {});
    const rootId = useBrowserStore.getState().activeClusterTreeNodeId!;
    applySvSplit('k-hostA', { datasetId: 'ds1', chrom: 'chr3', t: 'D', ref: 128_655_000, len: 500, end: 128_655_500, margin: 50,
      label: 'DEL 500bp', counts: [1, 1, 0], viewStart: 128_650_000, viewEnd: 128_660_000 } as never, { [rk(m0)]: 0, [rk(mNew)]: 1 });
    const [matId] = popOut('hostA', [], [{ binding: 'mat', hap: 'MAT' }]);
    expect(useBrowserStore.getState().clusterAssignments[matId]).toEqual({ [rk(m0)]: 0, [rk(mNew)]: 1 });
    expect(useBrowserStore.getState().clusterTreeNodes[rootId].assignments[matId]).toEqual({ [rk(m0)]: 0, [rk(mNew)]: 1 });
    useBrowserStore.getState().applyClusterTreeNode(rootId);
    expect(useBrowserStore.getState().clusterAssignments[matId]).toEqual({ [rk(m0)]: 0, [rk(mNew)]: 1 });
  });
});
