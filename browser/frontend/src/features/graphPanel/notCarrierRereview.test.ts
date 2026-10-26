/**
 * Graph follow-ups, agy's review of the group B fix ("not a carrier", -2), frontend parts:
 * - dynamic assignment's model label replaces a -2 the fit gave a record (a carrier molecule the fit sampled out);
 * - popping a haplotype out of a pooled host keeps only that haplotype's labels, so another haplotype's labels never
 *   scope its reads (its unlabelled reads stay shown).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useGraphStatusStore } from './statusStore';
import { useGraphBindingsStore } from './bindingsStore';
import { popOut, setPanelViewMode } from './hostMode';
import { registerGraphPanel } from './register';
import { assignWithGraphRun, commitGraphRun, graphClusterPlan } from './graphCluster';
import { recordKey } from '../../utils/recordKeys';
import { clusteredReadIdSet } from '../../components/tracks/read-track/readFilter';

registerGraphPanel();

const binding = (key: string, contig: string, sample: string) => ({
  key, path: { sample, haplotype: '0', contig }, assembly: sample, reference: sample, size: 200_000_000, size_inferred: false,
  fragments: [{ origin: 0, end: 200_000_000, indexed: true }], uncovered: [],
});
const REG = {
  id: 'gp', label: 'pkg', producer: 'fiberbrowser-graph', build_target: 't',
  revisions: { package: 'p'.repeat(64), graph: 'g'.repeat(64), db: 'd'.repeat(64), maps: 'm'.repeat(64) },
  bindings: [binding('tgt', 'chr3', 'GRCh38'), binding('mat', 'chr3_MAT', 'S1'), binding('pat', 'chr3_PAT', 'S1')],
  maps: [{ target: 'tgt', source: 'pat' }, { target: 'tgt', source: 'mat' }],
};
const BOUND = {
  dataset_id: 'd', label: 'lifted', kind: 'lifted', revision: 'r1',
  paths: { mat: 'chr3_MAT', pat: 'chr3_PAT' }, haps: { mat: 'MAT', pat: 'PAT' }, problems: [], libraries: 1,
};

function setup() {
  useGraphStatusStore.setState({ status: { helper: { available: true }, registrations: [REG] } as never, error: null, loading: false });
  useGraphBindingsStore.setState({
    byDataset: { d: [{ registration: REG, binding: BOUND }] } as never,
    problems: {}, key: `d||0|gp@${REG.revisions.package}`, covered: ['d'], loading: false,
  } as never);
  useBrowserStore.setState({
    panels: [{ id: 'host', contentType: 'dataset', datasetId: 'd', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0,
      stateKey: 'k-host' }],
    chrom: 'chr3', start: 128_650_000, end: 128_660_000, currentGenome: 'GRCh38',
    datasets: [{ id: 'd', label: 'lifted', data_type: 'bam_livelift', color: '#123456' } as never],
    selectedDatasets: new Set(), clusterAssignments: {}, clusterOrder: {}, filteredReadIds: {}, selectedReadIds: {},
    selectedClusters: {}, clusterFocus: {}, clusterMatchedRun: null, clusterGroupLabels: {}, fullViewPanelId: null,
    activeClusterTreeNodeId: null, clusterTreeNodes: {}, clusterTreeRootIds: [], selectedPeaks: new Set(), peaksLocked: false,
  } as never);
  setPanelViewMode('host', 'graph');
  const plan = graphClusterPlan(useBrowserStore.getState(), {
    kind: 'peaks', regions: [{ start: 128_651_029, end: 128_651_050, mode: 'accessibility' }],
  } as never)!;
  const obsM = plan.observations.find(o => o.binding === 'mat')!.id;
  const obsP = plan.observations.find(o => o.binding === 'pat')!.id;
  return { plan, obsM, obsP };
}

function commit(plan: ReturnType<typeof setup>['plan'], obsM: string, obsP: string, mat: Record<string, number>,
  pat: Record<string, number>, refined?: { stage1: Record<string, number> }) {
  commitGraphRun(useBrowserStore.getState(), plan, {
    results: {
      [obsM]: { assignments: mat, stage1: refined?.stage1 ?? mat, cluster_counts: { 0: 1 } },
      [obsP]: { assignments: pat, stage1: pat, not_carrier: true, left_out: "not a carrier of the regions' sequence (it lacks it)" },
    },
    label_ids: refined ? { '0': 0, '1': 1, '0.0': 2 } : { '0': 0 }, names: refined ? { '2': 'C0.0' } : {},
    stages: refined ? [{ stage: 1 }, { stage: 2, set: 0, parent: '0' }] : [{ stage: 1 }],
    columns: { regions: plan.regions, shared: [{ kind: 'target', region: 0, length: 21, label: 'x', carriers: [obsM], samples: 3 }],
      carrier_sets: refined ? [{ carriers: [obsM], features: [{ kind: 'insertion', length: 50, samples: 5, label: 'ins' }] }] : [],
      left_out: { [obsP]: 'no columns' }, dropped: [] },
    observations: [obsM, obsP], window_separation_nmi: null, matched: null, settings: {}, revisions: REG.revisions,
    target: 'tgt', options: {},
  } as never);
}

describe('not a carrier: frontend follow-ups', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('a model label replaces a -2 the fit gave a record; other labels never change', async () => {
    const { plan, obsM, obsP } = setup();
    const aidA = 'lift-cohort:v1 ["d|molA","molA",null,0,"primary"]';
    const aidB = 'lift-cohort:v1 ["d|molB","molB",null,0,"primary"]';
    commit(plan, obsM, obsP, { [aidB]: 0 }, { [aidA]: -2 });
    const rkA = recordKey(aidA)!;
    expect(useBrowserStore.getState().clusterAssignments['k-host'][rkA]).toBe(-2);
    const payload = { results: { [obsM]: { assignments: { [aidB]: 1, [aidA]: 0 } }, [obsP]: { assignments: {} } } };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload),
      json: async () => payload })));
    const added = await assignWithGraphRun(useBrowserStore.getState().clusterMatchedRun!);
    expect(added).toBe(1);
    const live = useBrowserStore.getState().clusterAssignments['k-host'];
    expect(live[rkA]).toBe(0);
    expect(live[recordKey(aidB)!]).toBe(0);   // an existing label never changes
  });

  it('a haplotype popped out of a pooled host keeps only its own labels', () => {
    const { plan, obsM, obsP } = setup();
    const aidM = 'lift-cohort:v1 ["d|m1","m1","rm1",0,"primary"]';
    const aidP = 'lift-cohort:v1 ["d|p1","p1","rp1",0,"primary"]';
    commit(plan, obsM, obsP, { [aidM]: 0 }, { [aidP]: -2 });
    const [patId] = popOut('host', [], [{ binding: 'pat', hap: 'PAT' }]);
    const pat = useBrowserStore.getState().clusterAssignments[patId];
    expect(pat).toEqual({ [recordKey(aidP)!]: -2 });
    // All "not a carrier": no read scope, so the haplotype's unlabelled reads stay shown.
    expect(clusteredReadIdSet(pat)).toBeNull();
    // The host keeps both.
    expect(Object.keys(useBrowserStore.getState().clusterAssignments['k-host']).length).toBe(2);
  });

  const stub = (payload: unknown) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200,
    text: async () => JSON.stringify(payload), json: async () => payload })));
  const aid = (q: string) => `lift-cohort:v1 ["d|${q}","${q}","r${q}",0,"primary"]`;

  it('pop-outs after dynamic assignment keep every row their own path labelled, and no other (round 2)', async () => {
    const { plan, obsM, obsP } = setup();
    // m1 and p1 fitted (max_reads); m2, p2 assigned later; molA upgraded from -2 on PAT to 0 on MAT.
    const molA = 'lift-cohort:v1 ["d|molA","molA",null,0,"primary"]';
    commit(plan, obsM, obsP, { [aid('m1')]: 0 }, { [aid('p1')]: -2, [molA]: -2 });
    stub({ results: { [obsM]: { assignments: { [aid('m1')]: 0, [aid('m2')]: 0, [molA]: 0 } },
      [obsP]: { assignments: { [aid('p1')]: -2, [aid('p2')]: -2 } } } });
    expect(await assignWithGraphRun(useBrowserStore.getState().clusterMatchedRun!)).toBe(3);
    const run = useBrowserStore.getState().clusterMatchedRun!;
    expect(Object.keys(run.assignments[obsM]).sort()).toEqual([aid('m1'), aid('m2'), molA].sort());
    expect(run.assignments[obsP]).toEqual({ [aid('p1')]: -2, [aid('p2')]: -2 });   // molA is no longer -2 anywhere
    const [matId, patId] = popOut('host', [], [{ binding: 'mat', hap: 'MAT' }, { binding: 'pat', hap: 'PAT' }]);
    const st = useBrowserStore.getState();
    const rk = (id: string) => recordKey(id)!;
    expect(st.clusterAssignments[matId]).toEqual({ [rk(aid('m1'))]: 0, [rk(aid('m2'))]: 0, [rk(molA)]: 0 });
    expect(st.clusterAssignments[patId]).toEqual({ [rk(aid('p1'))]: -2, [rk(aid('p2'))]: -2 });
    expect(clusteredReadIdSet(st.clusterAssignments[patId])).toBeNull();
  });

  it('a pop-out from the run\'s stage-1 node keeps only its own labels, and every node keeps them across switches', () => {
    const { plan, obsM, obsP } = setup();
    commit(plan, obsM, obsP, { [aid('m1')]: 2, [aid('m2')]: 1 }, { [aid('p1')]: -2 }, { stage1: { [aid('m1')]: 0, [aid('m2')]: 1 } });
    const refinedId = useBrowserStore.getState().activeClusterTreeNodeId!;
    const stage1Id = useBrowserStore.getState().clusterTreeNodes[refinedId].parentId!;
    const rk = (id: string) => recordKey(id)!;
    useBrowserStore.getState().applyClusterTreeNode(stage1Id);
    const [patId] = popOut('host', [], [{ binding: 'pat', hap: 'PAT' }]);
    expect(useBrowserStore.getState().clusterAssignments[patId]).toEqual({ [rk(aid('p1'))]: -2 });
    expect(clusteredReadIdSet(useBrowserStore.getState().clusterAssignments[patId])).toBeNull();
    const [matId] = popOut('host', [], [{ binding: 'mat', hap: 'MAT' }]);
    expect(useBrowserStore.getState().clusterAssignments[matId]).toEqual({ [rk(aid('m1'))]: 0, [rk(aid('m2'))]: 1 });
    // Switching to the refinement and back keeps both pop-outs' labels (each node's own).
    useBrowserStore.getState().applyClusterTreeNode(refinedId);
    expect(useBrowserStore.getState().clusterAssignments[matId]).toEqual({ [rk(aid('m1'))]: 2, [rk(aid('m2'))]: 1 });
    expect(useBrowserStore.getState().clusterAssignments[patId]).toEqual({ [rk(aid('p1'))]: -2 });
    useBrowserStore.getState().applyClusterTreeNode(stage1Id);
    expect(useBrowserStore.getState().clusterAssignments[patId]).toEqual({ [rk(aid('p1'))]: -2 });
    expect(useBrowserStore.getState().clusterAssignments[matId]).toEqual({ [rk(aid('m1'))]: 0, [rk(aid('m2'))]: 1 });
  });
});
