import '../testSetup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessibilityGroups } from './api';

const api = vi.hoisted(() => ({ groups: null as unknown, fail: false, calls: 0, states: null as unknown }));
vi.mock('../../api/features', async importOriginal => ({
  ...(await importOriginal<typeof import('../../api/features')>()),
  getFeatureStates: vi.fn(async () => api.states),
}));
vi.mock('./api', async importOriginal => ({
  ...(await importOriginal<typeof import('./api')>()),
  getAccessibilityGroups: vi.fn(async () => { api.calls += 1; if (api.fail) throw new Error('Accessibility run not found'); return api.groups; }),
}));

import { useBrowserStore } from '../../stores/browserStore';
import { NO_READS, splitReadFilter, useSplitPanelStore } from '../../stores/splitPanelStore';
import { serializeState } from '../../stores/historySlice';
import {
  BIN_COLOURS, MAX_SPLIT_PANELS, closeSplitPanels, loadSplitGrouping, openSplitPanels, resolveSplitPanels, setSplitSessionFallback,
  splitRows, splitSessionReads, splitSourcePanels, type SplitGrouping,
} from '../../utils/splitPanels';
import { getClusterColor } from '../../components/tracks/read-track/constants';

const GROUPS: AccessibilityGroups = {
  job_id: 'job1', nfr: 'N5', variants: [{ name: 'V1', start: 0, end: 1 }, { name: 'V2', start: 0, end: 1 }, { name: 'V3', start: 0, end: 1 }],
  groups: [
    { id: 0, label: 'V1', display_label: 'V1', count: 3, pattern: [1, 0, 0] },
    { id: 1, label: 'V2', display_label: 'V2', count: 2, pattern: [0, 1, 0] },
    { id: 2, label: 'V3', display_label: 'V3', count: 1, pattern: [0, 0, 1] },
    { id: 3, label: 'closed', display_label: 'closed', count: 2, pattern: [0, 0, 0] },
    { id: 4, label: 'V1+V3', display_label: 'V1+V3', count: 1, pattern: [1, 0, 1] },
  ],
  by_dataset: { ind: { a: 0, b: 0, c: 0, d: 1, e: 1, f: 2, g: 3, h: 3, i: 4 } },
};

const SOURCE = { id: 'p1', contentType: 'dataset', datasetId: 'ind', subTracks: [{ type: 'reads', visible: true }], collapsed: false, linkGroup: null, layoutRow: 0 };
function reset() {
  api.groups = GROUPS; api.fail = false; api.calls = 0;
  useSplitPanelStore.setState({ reads: {}, pending: null });
  useBrowserStore.setState({
    datasets: [{ id: 'ind', label: 'ind' }], panels: [SOURCE], selectedDatasets: new Set(), activeClusterTreeNodeId: null, dynamicClustering: false,
    clusterAssignments: {}, clusterGroupLabels: {}, _historyStack: [], _historyPointer: -1,
  } as never);
}

async function grouping(): Promise<SplitGrouping> {
  return loadSplitGrouping({ kind: 'configurations', jobId: 'job1', nfrId: 'N5' });
}

describe('Split into panels', () => {
  beforeEach(reset);

  it('rows: the top groups by reads ticked, then Other, Closed / none; colours are the variant colours', async () => {
    const rows = splitRows(await grouping(), 2);
    expect(rows.map(r => [r.label, r.count, r.checked])).toEqual([
      ['V1', 3, true], ['V2', 2, true], ['Other variants (2)', 2, true], ['closed', 2, true],
    ]);
    expect(rows[0].colour).toBe(getClusterColor(0));
    expect(rows[2].groupKeys).toEqual(['V3', 'V1+V3']);
    expect(rows[2].colour).toBe(BIN_COLOURS.other);
  });

  it('opens one named, coloured panel per ticked row beside its source, which folds away; one undo step; close-all', async () => {
    const g = await grouping();
    const rows = splitRows(g, 2).map(r => (r.label === 'closed' ? { ...r, checked: false } : r));
    const out = openSplitPanels(g, rows, splitSourcePanels(g));
    expect('groupId' in out).toBe(true);
    const s = useBrowserStore.getState();
    const split = s.panels.filter(p => p.readSubset);
    expect(s.panels.map(p => p.id)[0]).toBe('p1');
    expect(s.panels[0]).toMatchObject({ collapsed: true });
    expect(split.map(p => p.readSubset!.label)).toEqual(['N5 · V1', 'N5 · V2', 'Other variants (2)']);
    expect(split.map(p => p.readSubset!.count)).toEqual([3, 2, 2]);
    expect(split[0].readSubset!.colour).toBe(getClusterColor(0));
    expect(split.every(p => p.stateKey!.startsWith('ind:') && p.linkGroup === null && !p.viewportOverride)).toBe(true);
    // (a source in a comparison group: its copies leave the group, as a strand split's do)
    const reads = useSplitPanelStore.getState().reads;
    expect([...reads[split[2].stateKey!].ids].sort()).toEqual(['f', 'i']);
    expect(s._historyStack.at(-1)).toMatchObject({ label: 'Split into panels by N5', kind: 'layout' });
    closeSplitPanels(split[0].readSubset!.groupId);
    const after = useBrowserStore.getState();
    expect(after.panels.map(p => p.id)).toEqual(['p1']);
    expect(after.panels[0].collapsed).toBe(false);
  });

  it('refuses more than the cap with a reason', async () => {
    const g = await grouping();
    const rows = Array.from({ length: MAX_SPLIT_PANELS + 1 }, (_, i) => ({ ...splitRows(g, 1)[0], key: `k${i}` }));
    const out = openSplitPanels(g, rows, splitSourcePanels(g));
    expect(out).toMatchObject({ error: expect.stringMatching(/at most 8/) });
    expect(useBrowserStore.getState().panels).toHaveLength(1);
  });

  it('a split panel shows only its reads, and none while they load', () => {
    expect([...splitReadFilter({ ids: new Set(['a', 'b']), state: 'ready' }, null)!]).toEqual(['a', 'b']);
    expect([...splitReadFilter({ ids: new Set(['a', 'b']), state: 'ready' }, new Set(['b', 'z']))!]).toEqual(['b']);
    expect([...splitReadFilter({ ids: new Set(), state: 'loading' }, null)!]).toEqual([NO_READS]);
    expect(splitReadFilter(undefined, null)).toBeNull();
  });

  it('a session keeps the rule; reopened, the reads come from the rule, else from the names it kept (said so)', async () => {
    const g = await grouping();
    openSplitPanels(g, splitRows(g, 2).slice(0, 2), splitSourcePanels(g));
    const saved = serializeState(useBrowserStore.getState() as never) as unknown as { panels: { readSubset?: { rule: { kind: string; nfrId?: string; groupKeys: string[] } } }[] };
    const rules = saved.panels.filter(p => p.readSubset).map(p => p.readSubset!.rule);
    expect(rules).toEqual([
      expect.objectContaining({ kind: 'configurations', jobId: 'job1', nfrId: 'N5', datasetId: 'ind', groupKeys: ['V1'] }),
      expect.objectContaining({ groupKeys: ['V2'] }),
    ]);
    const names = splitSessionReads();
    // Reopened: the store is empty; the rule resolves (one request for both panels).
    useSplitPanelStore.setState({ reads: {} });
    api.calls = 0;
    await resolveSplitPanels();
    const keys = useBrowserStore.getState().panels.filter(p => p.readSubset).map(p => p.stateKey!);
    expect(api.calls).toBe(1);
    expect([...useSplitPanelStore.getState().reads[keys[1]].ids].sort()).toEqual(['d', 'e']);
    // The run is gone: the names saved with the session, marked as such.
    useSplitPanelStore.setState({ reads: {} });
    api.fail = true;
    setSplitSessionFallback(names);
    await resolveSplitPanels();
    expect(useSplitPanelStore.getState().reads[keys[0]]).toMatchObject({ state: 'frozen' });
    expect([...useSplitPanelStore.getState().reads[keys[0]].ids].sort()).toEqual(['a', 'b', 'c']);
    setSplitSessionFallback(null);
    useSplitPanelStore.setState({ reads: {} });
    await resolveSplitPanels();
    expect(useSplitPanelStore.getState().reads[keys[0]]).toMatchObject({ state: 'error' });
  });

  it('SV allele groups: their read names, kept with the panels', async () => {
    useBrowserStore.setState({ clusterAssignments: { ind: { r1: 0, r2: 1, r3: 0, r4: 2 } },
      clusterGroupLabels: { ind: { 0: 'Carriers', 1: 'Reference', 2: 'Not informative' } } } as never);
    const g = await loadSplitGrouping({ kind: 'frozen', panelId: 'p1', title: '9.2 kb insertion' });
    const rows = splitRows(g);
    expect(rows.map(r => [r.label, r.count, r.checked])).toEqual([['Carriers', 2, true], ['Reference', 1, true], ['Not informative', 1, false]]);
    openSplitPanels(g, rows, splitSourcePanels(g, ['p1']));
    const split = useBrowserStore.getState().panels.filter(p => p.readSubset);
    expect(split[0].readSubset!.rule).toMatchObject({ kind: 'frozen', readIds: ['r1', 'r3'] });
    expect(split[0].readSubset!.label).toBe('9.2 kb insertion · Carriers');
  });
});

describe('Split panels across a session import', () => {
  beforeEach(reset);
  it('an answer for the previous session is dropped; the new session resolves its own', async () => {
    const g = await grouping();
    openSplitPanels(g, splitRows(g, 2).slice(0, 1), splitSourcePanels(g));
    const key = useBrowserStore.getState().panels.find(p => p.readSubset)!.stateKey!;
    useSplitPanelStore.setState({ reads: {} });
    let release!: () => void;
    api.groups = new Promise(r => { release = () => r(GROUPS); });
    const first = resolveSplitPanels();
    useSplitPanelStore.setState(s => ({ reads: {}, generation: s.generation + 1 }));   // a session import
    api.groups = GROUPS;
    await resolveSplitPanels();                                                        // not blocked by the old request
    expect(useSplitPanelStore.getState().reads[key]).toMatchObject({ state: 'ready' });
    useSplitPanelStore.setState({ reads: {} });
    release();
    await first;
    expect(useSplitPanelStore.getState().reads[key]).toBeUndefined();               // the old answer wrote nothing
  });
});

describe('Split panels leave the source\'s groups', () => {
  beforeEach(reset);
  it('copies of a haplotype-comparison panel are not in the comparison', async () => {
    useBrowserStore.setState({ panels: [{ ...SOURCE, haplotypeGroup: 'hap-1', haplotypeSide: 1, linkGroup: 'link-1', viewportOverride: { chrom: 'chr2', start: 0, end: 10 } }] } as never);
    const g = await grouping();
    openSplitPanels(g, splitRows(g, 1).slice(0, 1), splitSourcePanels(g, ['p1']));
    const copy = useBrowserStore.getState().panels.find(p => p.readSubset)!;
    expect(copy).toMatchObject({ linkGroup: null, ownLocus: true, viewportOverride: { chrom: 'chr2' } });
    expect(copy.haplotypeGroup).toBeUndefined();
  });
});

describe('Split into panels from an NFR card (integ/fb37)', () => {
  beforeEach(reset);

  it('the panels remember the run\'s region as their locus, not the view; closing them one by one shows the source', async () => {
    useBrowserStore.setState({ chrom: 'chr3L', start: 15_040_000, end: 15_041_000 } as never);
    const result = { region: { chrom: 'chr3L', start: 15_037_533, end: 15_052_280 } } as never;
    const g = await loadSplitGrouping({ kind: 'configurations', jobId: 'job1', nfrId: 'N5', result });
    expect(g.locus).toEqual({ chrom: 'chr3L', start: 15_037_533, end: 15_052_280, label: 'N5' });
    const rows = splitRows(g, 2).map(r => ({ ...r, checked: r.label === 'V1' || r.label === 'V2' }));
    openSplitPanels(g, rows, [SOURCE as never]);
    const made = useBrowserStore.getState().panels.filter(p => p.readSubset);
    expect(made.map(p => p.readSubset!.locus)).toEqual([g.locus, g.locus]);
    expect(useBrowserStore.getState().panels.find(p => p.id === 'p1')!.collapsed).toBe(true);
    useBrowserStore.getState().removePanel(made[0].id);
    expect(useBrowserStore.getState().panels.find(p => p.id === 'p1')!.collapsed).toBe(true);   // one is left
    useBrowserStore.getState().removePanel(made[1].id);
    const source = useBrowserStore.getState().panels.find(p => p.id === 'p1')!;
    expect(source.collapsed).toBe(false);
    expect(source.collapsedBySplitGroup).toBeUndefined();
  });

  it('a feature pattern split takes the features\' span as its locus (a starred NFR of an earlier run, elsewhere)', async () => {
    const features = [{ kind: 'nfr-variant' as const, source: 'old', id: 'N5:V2', chrom: 'chr3L', start: 15_044_994, end: 15_045_593, label: 'N5 V2' }];
    api.states = { features: [{ datasets: [] }], by_dataset: { ind: { a: '1', b: '0' } } };
    const g = await loadSplitGrouping({ kind: 'patterns', features });
    expect(g.locus).toEqual({ chrom: 'chr3L', start: 15_044_994, end: 15_045_593, label: expect.stringContaining('N5') });
  });
});
