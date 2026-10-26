/**
 * Graph mode follow-ups (DESIGN_GRAPH_PRIMARY v2.2 §3.2, §4.1, §4.2, §5.1, §5.2, §5.4, §7.3, §7.4): pop out a chosen
 * subset, the one-time "View as graph" offer, the hand-off notices, sort by first carried column, the per-host
 * pop-out kind, and the single-haplotype label.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useGraphStatusStore } from './statusStore';
import { useGraphBindingsStore } from './bindingsStore';
import { setPanelViewMode } from './hostMode';
import { useGraphSettings } from './handoff';
import { registerGraphPanel } from './register';
import { memberLabel, singleHapPathName } from './labels';
import type { GraphBinding, GraphReadBinding, GraphRegistration } from './types';
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
