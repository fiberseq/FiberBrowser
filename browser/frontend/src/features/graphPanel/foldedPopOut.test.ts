import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useGraphStatusStore } from './statusStore';
import { useGraphBindingsStore } from './bindingsStore';
import { commitGraphRun, graphClusterPlan } from './graphCluster';
import { popOut } from './hostMode';
import { clusterAssignmentForRead, clusteredReadIdSet } from '../../components/tracks/read-track/readFilter';
import { idSetHas, isMoleculeRecordKey, recordKey } from '../../utils/recordKeys';
import { applySvSplit } from '../../utils/svAlleleSplit';
import { useTrackFeedStore } from '../../stores/trackFeedStore';
import { useGraphReadsStore } from './graphReadsStore';
import { applyReadGroups } from '../../utils/readGroups';
import type { GraphRegistration } from './types';
import type { PanelConfig } from '../../types';

/**
 * Graph follow-ups item 5 (agy review, group B round 4, 2a): under fold_molecule one record key names a molecule's
 * records on both haplotypes. A lifted panel shows every row of a molecule on its primary record's haplotype, while a
 * graph run labels the molecule through the path whose row covered its regions (a supplementary on the other
 * haplotype). After a non-graph relabel on a pooled host, a pop-out split by the run's provenance gave the label to
 * the path's haplotype, so the panel that shows the molecule's rows had it hidden (or unlabelled). The rows the host
 * drew (their haplotype) now route a molecule-level record to that haplotype's pop-out too.
 */
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

/** A folded row's cohort identity (fold_molecule: no record, no row index), on a chain placement or the graph's. */
const fid = (q: string, placement = 'primary') => `lift-cohort:v1 ${JSON.stringify([`ds1#0|${q}`, q, null, null, placement])}`;
const rk = (id: string) => recordKey(id)!;

function host(): PanelConfig {
  return {
    id: 'hostA', stateKey: 'k-hostA', contentType: 'dataset', datasetId: 'ds1', viewMode: 'graph', collapsed: false,
    subTracks: [], linkGroup: null, liftHaplotypeMode: 'pooled',
    graphView: {
      schema: 2, role: 'host', registrationId: 'pkg1', packageRevision: 'p1', graphRevision: 'g1', mapRevision: 'm1',
      targetBinding: 'ref', targetReferenceId: 'ref_g', initiatingPanelId: null, initiatingReferenceId: null,
      selectedPathKeys: ['ref', 'mat', 'pat'], targetViewport: null, linkMode: 'independent',
      layoutSettings: { contextBp: 1000, laneHeight: 28 }, members: [{ panelId: 'hostA', binding: null }],
      handoff: { pinnedLinear: false, shown: 'graph' },
    },
  } as PanelConfig;
}

function setup() {
  useGraphStatusStore.setState({ status: { helper: { available: true }, registrations: [REG], errors: [], warnings: [] } as never, loading: false, error: null });
  useGraphBindingsStore.setState({ key: 'k', problems: {}, byDataset: { ds1: [{ registration: REG,
    binding: { kind: 'lifted', target: 'ref', paths: { mat: 'S1#1#c1', pat: 'S1#2#c1' }, haps: { mat: 'MAT', pat: 'PAT' }, revision: 'r1' } }] } } as never);
  useBrowserStore.setState({
    chrom: 'chr3', start: 128_650_000, end: 128_660_000, genomes: [{ id: 'ref_g', label: 'REF', active: true }] as never,
    datasets: [{ id: 'ds1', label: 'Synth1', live_lift: { settings: { fold_molecule: true } } }] as never,
    panels: [host()], selectedDatasets: new Set(), filteredReadIds: {}, selectedClusters: {}, clusterFocus: {},
    clusterAssignments: {}, clusterOrder: {}, clusterGroupLabels: {}, svSplits: {}, svCarrierEvidence: {},
    clusterMatchedRun: null, activeClusterTreeNodeId: null, clusterTreeNodes: {}, clusterTreeRootIds: [],
    clusterMethod: 'kmeans', clusterK: 2, clusterResolution: 1, subnucleosomalThreshold: 120, accessibilityThreshold: 30,
  } as never);
  useTrackFeedStore.setState({ byStateKey: {} });
  useGraphReadsStore.setState({ byPanel: {}, rowHaps: {} });
}

/** A graph run on the host: MAT's and PAT's rows fitted (PAT left out when it has none). */
function runGraph(mat: Record<string, number>, pat: Record<string, number>) {
  useBrowserStore.setState({ selectedDatasets: new Set(['hostA']) } as never);
  const plan = graphClusterPlan(useBrowserStore.getState() as never,
    { kind: 'peaks', regions: [{ start: 128_655_000, end: 128_655_200, mode: 'accessibility', chrom: 'chr3' }] })!;
  const obsM = plan.observations.find(o => o.binding === 'mat')!.id;
  const obsP = plan.observations.find(o => o.binding === 'pat')!.id;
  commitGraphRun(useBrowserStore.getState(), plan, {
    results: {
      [obsM]: { assignments: mat, stage1: mat },
      [obsP]: Object.keys(pat).length ? { assignments: pat, stage1: pat } : { assignments: {}, stage1: {}, left_out: 'left out' },
    },
    label_ids: { '0': 0, '1': 1 }, names: {}, stages: [{ stage: 1 }],
    columns: { regions: plan.regions, shared: [{ kind: 'target', region: 0, length: 200, label: 't', carriers: [obsM, obsP], samples: 20 }],
      carrier_sets: [], left_out: {}, dropped: [], refinements: [] },
    observations: [obsM, obsP], window_separation_nmi: null,
    matched: { lengths: [200], balanced: false, balanced_fit_reads: 2, fit_reads: 2 },
    settings: {}, revisions: REG.revisions, target: 'ref', options: {}, timings: {},
  } as never);
  useBrowserStore.setState({ selectedDatasets: new Set() } as never);
}

/** The host's drawn lifted rows (its read track's feed while it was linear): each row's haplotype is its molecule's
 * primary record's. */
function drawn(rows: { id: string; q: string; hap: 'MAT' | 'PAT' }[]) {
  useTrackFeedStore.setState({ byStateKey: { 'k-hostA': { datasetId: 'ds1', chrom: 'chr3', start: 128_650_000, end: 128_660_000,
    reads: rows.map(r => ({ id: r.q, analysis_id: r.id, live_lift: { hap: r.hap === 'MAT' ? 'S1#1' : 'S1#2', hap_label: r.hap } })) } as never } });
}

const popBoth = () => popOut('hostA', [], [{ binding: 'mat', hap: 'MAT' }, { binding: 'pat', hap: 'PAT' }]);

describe('a folded molecule after a non-graph relabel on a pooled host reaches the pop-out that shows its rows', () => {
  beforeEach(() => { vi.restoreAllMocks(); setup(); });

  it('the record key of a folded row names the molecule', () => {
    expect(isMoleculeRecordKey(fid('a', '271'))).toBe(true);
    expect(isMoleculeRecordKey(rk(fid('a')))).toBe(true);
    expect(isMoleculeRecordKey(`lift-cohort:v1 ${JSON.stringify(['ds1#0|a', 'a', 'r1', 0, 'primary'])}`)).toBe(false);
    expect(isMoleculeRecordKey('a')).toBe(false);
  });

  it('a linear clustering after the graph run: the molecule labelled through MAT shows labelled, not hidden, in the PAT pop-out', () => {
    // molA: a supplementary on MAT (the only row covering the regions; the run labelled it on MAT) and its primary on
    // PAT, so its lifted rows are PAT's.
    runGraph({ [fid('molA')]: 0, [fid('m1')]: 1 }, { [fid('p1')]: 0, [fid('p2')]: 1 });
    drawn([{ id: fid('molA', '271'), q: 'molA', hap: 'PAT' }, { id: fid('molA', '63'), q: 'molA', hap: 'PAT' },
      { id: fid('m1', '5'), q: 'm1', hap: 'MAT' }, { id: fid('p1', '63'), q: 'p1', hap: 'PAT' }, { id: fid('p2', '63'), q: 'p2', hap: 'PAT' }]);
    // Clustered in the host's linear view: the same records, other labels (keyed by the linear rows' identities).
    useBrowserStore.getState().setClusterAssignments('k-hostA', { [fid('molA', '271')]: 1, [fid('m1', '5')]: 0, [fid('p1', '63')]: 1, [fid('p2', '63')]: 0 });
    const [matId, patId] = popBoth();
    const st = useBrowserStore.getState();
    expect(st.clusterAssignments[patId]).toEqual({ [fid('molA', '271')]: 1, [fid('p1', '63')]: 1, [fid('p2', '63')]: 0 });
    // Its PAT rows pass the pop-out's clustered filter (by identity or record key); the labelled row is coloured.
    const rows = [{ id: 'molA', analysis_id: fid('molA', '63'), live_lift: {} }, { id: 'molA', analysis_id: fid('molA', '271'), live_lift: {} }];
    const scope = clusteredReadIdSet(st.clusterAssignments[patId])!;
    expect(rows.every(r => idSetHas(scope, [r.id, r.analysis_id], recordKey(r.analysis_id)))).toBe(true);
    expect(clusterAssignmentForRead(st.clusterAssignments[patId], rows[1])).toBe(1);
    // MAT keeps its own share (the molecule's MAT record is the run's there).
    expect(st.clusterAssignments[matId]).toEqual({ [fid('molA', '271')]: 1, [fid('m1', '5')]: 0 });
    // So does the tree node: a branch switch keeps it.
    const node = st.clusterTreeNodes[st.activeClusterTreeNodeId!];
    expect(node.assignments[patId]?.[fid('molA', '271')]).toBe(1);
  });

  it('agy B r4 2a: an SV split after a run that left PAT out labels the folded molecule in the PAT pop-out', () => {
    const molF = fid('molF');
    const m0 = `lift-cohort:v1 ${JSON.stringify(['ds1#0|m0', 'm0', 'r_m0', 0, 'primary'])}`;
    runGraph({ [molF]: 0, [m0]: 1 }, {});
    drawn([{ id: fid('molF', '63'), q: 'molF', hap: 'PAT' }, { id: m0, q: 'm0', hap: 'MAT' }]);
    applySvSplit('k-hostA', { datasetId: 'ds1', chrom: 'chr3', t: 'D', ref: 128_655_000, len: 500, end: 128_655_500, margin: 50,
      label: 'DEL 500bp', counts: [1, 1, 0], viewStart: 128_650_000, viewEnd: 128_660_000 } as never, { [rk(molF)]: 0, [rk(m0)]: 1 });
    const [matId, patId] = popBoth();
    const st = useBrowserStore.getState();
    expect(st.clusterAssignments[patId]).toEqual({ [rk(molF)]: 0 });
    expect(st.clusterAssignments[matId]).toEqual({ [rk(molF)]: 0, [rk(m0)]: 1 });
  });

  it('Codex lift1: an SV split on a subcluster node routes the folded molecule through the ancestor run\'s provenance', () => {
    runGraph({ [fid('molA')]: 0, [fid('m1')]: 1 }, { [fid('p1')]: 0 });
    const root = useBrowserStore.getState().activeClusterTreeNodeId!;
    const rootProv = JSON.stringify(useBrowserStore.getState().clusterTreeNodes[root].graphProvenance);
    useBrowserStore.getState().commitSubcluster({ 'k-hostA': { [fid('molA')]: 0, [fid('m1')]: 1, [fid('p1')]: 0 } }, { sourceClusterIds: [0, 1] });
    const child = useBrowserStore.getState().activeClusterTreeNodeId!;
    expect(child).not.toBe(root);
    drawn([{ id: fid('molA', '271'), q: 'molA', hap: 'PAT' }, { id: fid('p1', '63'), q: 'p1', hap: 'PAT' }]);
    applySvSplit('k-hostA', { datasetId: 'ds1', chrom: 'chr3', t: 'D', ref: 128_655_000, len: 500, end: 128_655_500, margin: 50,
      label: 'DEL 500bp', counts: [1, 2, 0], viewStart: 128_650_000, viewEnd: 128_660_000 } as never,
      { [rk(fid('molA'))]: 0, [rk(fid('m1'))]: 1, [rk(fid('p1'))]: 1 });
    const [matId, patId] = popBoth();
    const st = useBrowserStore.getState();
    expect(st.clusterAssignments[patId]).toEqual({ [rk(fid('molA'))]: 0, [rk(fid('p1'))]: 1 });
    expect(idSetHas(clusteredReadIdSet(st.clusterAssignments[patId])!, ['molA', fid('molA', '271')], rk(fid('molA')))).toBe(true);
    expect(st.clusterAssignments[matId]).toEqual({ [rk(fid('molA'))]: 0, [rk(fid('m1'))]: 1 });
    // The routing is stored on the subcluster node; the ancestor's snapshot is untouched, and the subcluster's labels
    // stay marked as another grouping's (not the run's).
    expect(JSON.stringify(st.clusterTreeNodes[root].graphProvenance)).toBe(rootProv);
    expect(st.clusterTreeNodes[child].graphLabelsReplaced?.['k-hostA']).toBe(true);
  });

  describe('agy whole-diff review: other relabel paths', () => {
    // molA labelled through MAT (its supplementary's row), its primary on PAT; p1 PAT's own.
    const run = () => runGraph({ [fid('molA')]: 0, [fid('m1')]: 1 }, { [fid('p1')]: 1 });
    const linearRows = () => drawn([{ id: fid('molA', '271'), q: 'molA', hap: 'PAT' }, { id: fid('m1', '5'), q: 'm1', hap: 'MAT' },
      { id: fid('p1', '63'), q: 'p1', hap: 'PAT' }]);
    const shown = (labels: Record<string, number> | undefined) => Boolean(labels
      && idSetHas(clusteredReadIdSet(labels)!, ['molA', fid('molA', '63')], rk(fid('molA'))));

    it('(a) an SV split while the host shows its graph: the graph panel\'s drawn rows route the folded molecule', () => {
      run();
      // No read track (the host shows its graph); the graph panel drew molA's primary row on PAT, its supplementary on MAT.
      useGraphReadsStore.getState().publishRowHaps('hostA', [{ rk: rk(fid('molA')), datasetId: 'ds1', hap: 'PAT' },
        { rk: rk(fid('m1')), datasetId: 'ds1', hap: 'MAT' }, { rk: rk(fid('p1')), datasetId: 'ds1', hap: 'PAT' }]);
      applySvSplit('k-hostA', { datasetId: 'ds1', chrom: 'chr3', t: 'D', ref: 128_655_000, len: 500, end: 128_655_500, margin: 50,
        label: 'DEL 500bp', counts: [1, 2, 0], viewStart: 128_650_000, viewEnd: 128_660_000 } as never,
        { [rk(fid('molA'))]: 0, [rk(fid('m1'))]: 1, [rk(fid('p1'))]: 1 });
      const [, patId] = popBoth();
      const labels = useBrowserStore.getState().clusterAssignments[patId];
      expect(labels).toEqual({ [rk(fid('molA'))]: 0, [rk(fid('p1'))]: 1 });
      expect(shown(labels)).toBe(true);
    });

    it('(b) a read grouping (written without updating the tree node) routes the folded molecule at pop-out', () => {
      run();
      linearRows();
      applyReadGroups({ byDataset: { ds1: { [fid('molA', '271')]: 1, [fid('m1', '5')]: 0, [fid('p1', '63')]: 1 } },
        order: [0, 1], patterns: {}, regions: [], labels: { 0: 'MAT', 1: 'PAT' } } as never, { ds1: ['k-hostA'] }, 'Group by haplotype');
      const [, patId] = popBoth();
      const labels = useBrowserStore.getState().clusterAssignments[patId];
      expect(labels).toEqual({ [fid('molA', '271')]: 1, [fid('p1', '63')]: 1 });
      expect(shown(labels)).toBe(true);
    });

    it('(c) a linear subcluster routes the folded molecule at pop-out, and on its tree node', () => {
      run();
      linearRows();
      useBrowserStore.getState().commitSubcluster({ 'k-hostA': { [fid('molA', '271')]: 0, [fid('p1', '63')]: 1 } }, { sourceClusterIds: [0, 1] });
      const child = useBrowserStore.getState().activeClusterTreeNodeId!;
      const [, patId] = popBoth();
      const st = useBrowserStore.getState();
      expect(st.clusterAssignments[patId]?.[fid('molA', '271')]).toBe(0);
      expect(shown(st.clusterAssignments[patId])).toBe(true);
      expect(st.clusterTreeNodes[child].assignments[patId]?.[fid('molA', '271')]).toBe(0);
    });
  });

  it('a molecule drawn only on MAT, or rows not drawn, keep the run\'s routing (PAT gets none of MAT\'s labels)', () => {
    runGraph({ [fid('molA')]: 0, [fid('m1')]: 1 }, {});
    drawn([{ id: fid('molA', '271'), q: 'molA', hap: 'MAT' }]);
    useBrowserStore.getState().setClusterAssignments('k-hostA', { [fid('molA', '271')]: 1, [fid('m1', '5')]: 0 });
    const [matId, patId] = popBoth();
    expect(useBrowserStore.getState().clusterAssignments[patId]).toBeUndefined();
    expect(useBrowserStore.getState().clusterAssignments[matId]).toEqual({ [fid('molA', '271')]: 1, [fid('m1', '5')]: 0 });
  });
});
