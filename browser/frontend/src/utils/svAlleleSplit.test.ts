import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { keepSvSplitsInView, normalizeClusterGroupLabels, normalizeSvSplits } from '../stores/svSlice';
import { getClusterLabel } from '../components/tracks/read-track/constants';
import { SESSION_POST_VIEWPORT_KEYS } from '../api/session';
import { PER_PANEL_STATE_KEYS } from '../stores/panelSlice';
import { refreshSvSplit, splitBySv, splitIntoPanelsBySv } from './svAlleleSplit';
import { useSplitPanelStore } from '../stores/splitPanelStore';
import { loadSplitGrouping, openSplitPanels, splitRows } from './splitPanels';

const TARGET = { stateKey: 'ds', datasetId: 'ds', chrom: 'chrSV', viewStart: 8_000, viewEnd: 16_000 };
const SV = { t: 'D' as const, ref: 10_000, len: 1503 };

function mockSplit(assignments: Record<string, number>) {
  const counts = [0, 0, 0];
  for (const g of Object.values(assignments)) counts[g] += 1;
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({
    assignments, counts, label: 'x', margin: 100, body: init?.body,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Split by SV allele', () => {
  let initial: ReturnType<typeof useBrowserStore.getState>;
  beforeEach(() => {
    initial = useBrowserStore.getState();
    useBrowserStore.setState({ chrom: 'chrSV', start: 8_000, end: 16_000 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useBrowserStore.setState(initial, true);
  });

  it('puts carriers / reference / not informative in the cluster machinery, with names', async () => {
    const fetchMock = mockSplit({ c1: 0, c2: 0, r1: 1, n1: 2 });
    const def = await splitBySv(TARGET, SV);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/sv/split');
    expect(body).toMatchObject({ dataset_id: 'ds', chrom: 'chrSV', start: 8000, end: 16000, t: 'D', ref: 10_000, len: 1503 });
    const s = useBrowserStore.getState();
    expect(s.clusterAssignments.ds).toEqual({ c1: 0, c2: 0, r1: 1, n1: 2 });
    expect(s.clusterOrder.ds).toEqual([0, 1, 2]);
    expect(s.dynamicClustering).toBe(false);
    expect(s.svSplits.ds.label).toBe('DEL 1.5 kb @ chrSV:10,001');
    expect(def.counts).toEqual([2, 1, 1]);
    // Group names reach every cluster label (tooltips, Overview, charts).
    expect(getClusterLabel(0, true)).toBe('Carriers');
    expect(getClusterLabel(1)).toBe('Reference');
    expect(getClusterLabel(2, true)).toBe('Not informative');
    // One undo step.
    expect(s._historyStack?.at(-1)?.label ?? '').toContain('Split by SV allele');
  });

  it('survives pan/zoom while the locus is in view; reads of the new view join their groups', async () => {
    mockSplit({ c1: 0, r1: 1 });
    await splitBySv(TARGET, SV);
    useBrowserStore.getState().setViewport('chrSV', 9_000, 17_000);
    let s = useBrowserStore.getState();
    expect(s.clusterAssignments.ds).toEqual({ c1: 0, r1: 1 });
    expect(s.svSplits.ds).toBeTruthy();
    mockSplit({ c1: 0, r1: 1, r2: 1, n9: 2 });
    await refreshSvSplit({ ...TARGET, viewStart: 9_000, viewEnd: 17_000 }, s.svSplits.ds);
    s = useBrowserStore.getState();
    expect(s.clusterAssignments.ds).toEqual({ c1: 0, r1: 1, r2: 1, n9: 2 });
    expect(s.svSplits.ds.counts).toEqual([1, 2, 1]);
    expect(s.svSplits.ds.viewStart).toBe(9_000);
    // The locus leaves the view: the split and its groups go.
    useBrowserStore.getState().setViewport('chrSV', 20_000, 28_000);
    s = useBrowserStore.getState();
    expect(s.svSplits.ds).toBeUndefined();
    expect(s.clusterAssignments.ds).toBeUndefined();
    expect(getClusterLabel(0)).toBe('Cluster 0');
  });

  it('another grouping replaces the split and its names', async () => {
    mockSplit({ c1: 0, r1: 1 });
    await splitBySv(TARGET, SV);
    useBrowserStore.getState().setClusterAssignments('ds', { c1: 3, r1: 4 });
    const s = useBrowserStore.getState();
    expect(s.svSplits.ds).toBeUndefined();
    expect(s.clusterGroupLabels.ds).toBeUndefined();
    expect(getClusterLabel(0)).toBe('Cluster 0');
  });

  it('keepSvSplitsInView keeps only splits whose locus overlaps the view', () => {
    const def = { datasetId: 'a', chrom: 'chrSV', t: 'D' as const, ref: 10_000, len: 1500, end: 11_500, margin: 100, label: '', counts: [1, 1, 1] as [number, number, number], viewStart: 0, viewEnd: 1 };
    const state = {
      svSplits: { a: def, b: { ...def, datasetId: 'b', chrom: 'chr2' } },
      clusterGroupLabels: { a: { 0: 'Carriers' }, b: { 0: 'Carriers' } },
      clusterAssignments: { a: { r: 0 }, b: { s: 0 }, c: { t: 5 } },
      clusterOrder: { a: [0, 1, 2], b: [0, 1, 2], c: [5] },
    } as never;
    const out = keepSvSplitsInView(state, { clusterAssignments: {}, clusterOrder: {} }, 'chrSV', 11_000, 12_000);
    expect(Object.keys(out.svSplits ?? {})).toEqual(['a']);
    expect(out.clusterAssignments).toEqual({ a: { r: 0 } });
    const gone = keepSvSplitsInView(state, { clusterAssignments: {} }, 'chrSV', 12_000, 13_000);
    expect(gone.svSplits).toEqual({});
    // A path that keeps clusterings still drops the groups of a split whose locus left.
    const kept = keepSvSplitsInView(state, {}, 'chrSV', 12_000, 13_000);
    expect(kept.clusterAssignments).toEqual({ c: { t: 5 } });
    expect(kept.clusterOrder).toEqual({ c: [5] });
  });

  it('is saved with sessions and per panel, and restored validated', () => {
    expect(SESSION_POST_VIEWPORT_KEYS).toContain('svSplits');
    expect(SESSION_POST_VIEWPORT_KEYS).toContain('clusterGroupLabels');
    expect(PER_PANEL_STATE_KEYS).toContain('svSplits');
    expect(normalizeSvSplits({ a: { chrom: 'c', t: 'D', ref: 5, len: 10 }, bad: { t: 'X' } })).toEqual({
      a: expect.objectContaining({ chrom: 'c', t: 'D', ref: 5, len: 10, end: 15, margin: 100 }),
    });
    expect(normalizeClusterGroupLabels({ a: { 0: 'Carriers', x: 'no', 1: 5 } })).toEqual({ a: { 0: 'Carriers' } });
  });
});

describe('SV allele groups in exports', () => {
  it('name each read\'s group in the cluster assignments TSV', async () => {
    const { formatClusterAssignmentsTsv } = await import('./clusterExport');
    const tsv = formatClusterAssignmentsTsv({
      clusterAssignments: { ds: { c1: 0, r1: 1, n1: 2 } },
      clusterOrder: { ds: [0, 1, 2] },
      clusterGroupLabels: { ds: { 0: 'Carriers', 1: 'Reference', 2: 'Not informative' } },
      provenance: { sv_allele_split: { ds: 'DEL 1.5 kb @ chrSV:10,001 (margin 100 bp)' } },
    });
    const lines = tsv.trim().split('\n');
    expect(lines).toContain('# sv_allele_split: {"ds":"DEL 1.5 kb @ chrSV:10,001 (margin 100 bp)"}');
    expect(lines).toContain('read_id\tdataset\tcluster\tgroup\tviewer_order');
    expect(lines).toContain('c1\tds\t0\tCarriers\t1');
    expect(lines).toContain('n1\tds\t2\tNot informative\t3');
  });
});

describe('review fixes (fb-n9-sv)', () => {
  let initial: ReturnType<typeof useBrowserStore.getState>;
  beforeEach(() => { initial = useBrowserStore.getState(); useBrowserStore.setState({ chrom: 'chrSV', start: 8_000, end: 16_000 }); });
  afterEach(() => { vi.unstubAllGlobals(); useBrowserStore.setState(initial, true); });

  it('group names never rename another panel\'s ordinary clusters', async () => {
    mockSplit({ c1: 0, r1: 1 });
    await splitBySv(TARGET, SV);
    expect(getClusterLabel(0, true)).toBe('Carriers');
    useBrowserStore.getState().setClusterAssignments('other', { x: 0, y: 1 });
    expect(getClusterLabel(0, true)).toBe('C0');
    expect(useBrowserStore.getState().svSplits.ds).toBeTruthy();
  });

  it('Clear SV split clears this panel only', async () => {
    const { clearSvSplit } = await import('./svAlleleSplit');
    mockSplit({ c1: 0, r1: 1 });
    await splitBySv(TARGET, SV);
    useBrowserStore.getState().setClusterAssignments('other', { x: 3 });
    clearSvSplit('ds');
    const s = useBrowserStore.getState();
    expect(s.svSplits.ds).toBeUndefined();
    expect(Object.keys(s.clusterAssignments.ds ?? {})).toHaveLength(0);
    expect(s.clusterAssignments.other).toEqual({ x: 3 });
  });

  it('classifies duplicates when the panel shows them', async () => {
    const fetchMock = mockSplit({ c1: 0 });
    useBrowserStore.setState({ showDuplicateReads: true });
    const def = await splitBySv(TARGET, SV);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).include_duplicates).toBe(true);
    expect(def.includeDuplicates).toBe(true);
  });
});

describe('current split counts and historical assignments', () => {
  let initial: ReturnType<typeof useBrowserStore.getState>;
  beforeEach(() => {
    initial = useBrowserStore.getState();
    useBrowserStore.setState({ chrom: 'chrSV', start: 8000, end: 16000, showDuplicateReads: true });
  });
  afterEach(() => { vi.unstubAllGlobals(); useBrowserStore.setState(initial, true); });

  it('carries evidence labels and memberships through the panel preview and opened panels', async () => {
    const savedSplitState = useSplitPanelStore.getState();
    const source = { id: 'source', contentType: 'dataset' as const, datasetId: 'ds', subTracks: [], collapsed: false };
    useBrowserStore.setState({ panels: [source] });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      assignments: { confirmed: 0, putative: 0, reference: 1, conflicting: 2, ambiguous: 2 },
      counts: [2, 1, 2], margin: 100,
      evidence_counts: { confirmed: 1, putative: 1, conflicting: 1, ambiguous: 1 },
      evidence_levels: { confirmed: 'confirmed', putative: 'putative', conflicting: 'conflicting', ambiguous: 'ambiguous' },
    }))));
    try {
      await splitIntoPanelsBySv(TARGET, SV, source.id);
      const pending = useSplitPanelStore.getState().pending!;
      const grouping = await loadSplitGrouping(pending.source);
      const rows = splitRows(grouping);
      expect(rows.filter(r => r.checked).map(r => [r.label, r.count])).toEqual([
        ['Confirmed (1) + putative (1)', 2], ['Reference', 1],
      ]);
      expect(rows.find(r => r.kind === 'na')).toMatchObject({ count: 2, checked: false });
      expect(openSplitPanels(grouping, rows, [source])).toHaveProperty('groupId');
      const panels = useBrowserStore.getState().panels.filter(p => p.readSubset);
      expect(panels).toHaveLength(2);
      const carriers = panels.find(p => p.readSubset!.rule.groupKeys.includes('0'))!;
      expect(carriers.readSubset).toMatchObject({ count: 2, rule: {
        readIds: ['confirmed', 'putative'], svEvidenceLevels: { confirmed: 'confirmed', putative: 'putative' },
      } });
      expect(carriers.readSubset!.label).toContain('Confirmed (1) + putative (1)');
      expect(useBrowserStore.getState().panels.find(p => p.id === source.id)?.collapsed).toBe(true);
    } finally { useSplitPanelStore.setState(savedSplitState, true); }
  });

  it('sends and retains the evidence policy and labels split panels with evidence counts', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ assignments: { c: 0, p: 0, a: 2 },
      counts: [2, 0, 1], margin: 100, evidence_counts: { confirmed: 1, putative: 1, ambiguous: 1 } })));
    vi.stubGlobal('fetch', fetchMock);
    const def = await splitBySv({ ...TARGET, includePutative: true }, SV);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).include_putative).toBe(true);
    expect(def.includePutative).toBe(true);
    expect(useBrowserStore.getState().clusterGroupLabels.ds[0]).toBe('Confirmed (1) + putative (1)');
    expect(def.evidenceCounts).toEqual({ confirmed: 1, putative: 1, ambiguous: 1 });
  });

  it('defaults new splits to putative while legacy and explicit saved choices survive refresh', async () => {
    const fetchMock = mockSplit({ c: 0 });
    const fresh = await splitBySv(TARGET, SV);
    expect(fresh.includePutative).toBe(true);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ include_putative: true, include_ambiguous: false });
    for (const saved of [undefined, false, true]) {
      const legacy = normalizeSvSplits({ ds: { ...fresh, includePutative: saved, includeAmbiguous: true } }).ds;
      useBrowserStore.getState().setSvSplit('ds', legacy);
      await refreshSvSplit(TARGET, legacy);
      const body = JSON.parse(String(fetchMock.mock.lastCall?.[1]?.body));
      expect(body.include_putative).toBe(saved === true);
      expect(body.include_ambiguous).toBe(true);
    }
  });

  it('preserves saved conflict choices and thresholds, including policies predating this filter', async () => {
    const fetchMock = mockSplit({ c: 0 });
    useBrowserStore.getState().setSvConflictOptions({ max_distance: 5000 });
    const fresh = await splitBySv({ ...TARGET, includeConflicting: true }, SV);
    expect(fresh).toMatchObject({ includePutative: true, includeConflicting: true, conflictOptions: { enabled: true, max_distance: 5000 } });
    useBrowserStore.getState().setSvConflictOptions({ max_distance: 9999 });
    const saved = normalizeSvSplits({ ds: fresh }).ds;
    useBrowserStore.getState().setSvSplit('ds', saved);
    await refreshSvSplit(TARGET, saved);
    expect(JSON.parse(String(fetchMock.mock.lastCall?.[1]?.body))).toMatchObject({
      include_conflicting: true, conflict_options: { max_distance: 5000 },
    });
    const legacy = normalizeSvSplits({ ds: { ...fresh, conflictOptions: undefined, includeConflicting: undefined } }).ds;
    useBrowserStore.getState().setSvSplit('ds', legacy);
    await refreshSvSplit(TARGET, legacy);
    expect(JSON.parse(String(fetchMock.mock.lastCall?.[1]?.body))).toMatchObject({
      include_putative: true, include_conflicting: false, conflict_options: { enabled: false },
    });
  });

  it('retries an initial split when its duplicate setting changes while waiting', async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
      .mockResolvedValue(new Response(JSON.stringify({ assignments: { current: 0 }, counts: [1, 0, 0], margin: 100 })));
    vi.stubGlobal('fetch', fetchMock);
    const pending = splitBySv(TARGET, SV);
    useBrowserStore.setState({ showDuplicateReads: false });
    finish(new Response(JSON.stringify({ assignments: { stale: 0 }, counts: [9, 0, 0], margin: 100 })));
    expect(await pending).toMatchObject({ includeDuplicates: false, counts: [1, 0, 0] });
    expect(fetchMock.mock.calls.map(call => JSON.parse(call[1].body).include_duplicates)).toEqual([true, false]);
    expect(useBrowserStore.getState().clusterAssignments.ds).toEqual({ current: 0 });
  });

  it('rejects an initial split superseded by another target', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
      .mockResolvedValue(new Response(JSON.stringify({ assignments: { current: 0 }, counts: [1, 0, 0], margin: 100 }))));
    const pending = splitBySv(TARGET, SV);
    const rejected = expect(pending).rejects.toThrow('superseded');
    await splitBySv(TARGET, { ...SV, ref: 11000 });
    finish(new Response(JSON.stringify({ assignments: { stale: 0 }, counts: [9, 0, 0], margin: 100 })));
    await rejected;
    expect(useBrowserStore.getState().svSplits.ds.ref).toBe(11000);
  });

  it('retains departed/duplicate assignments while counting only the new response', async () => {
    mockSplit({ carrier: 0, departed: 0, duplicate: 1 });
    await splitBySv(TARGET, SV);
    useBrowserStore.setState({ showDuplicateReads: false });
    mockSplit({ carrier: 0, current: 1 });
    const def = useBrowserStore.getState().svSplits.ds;
    await refreshSvSplit({ ...TARGET, viewStart: 9000, viewEnd: 17000 }, def);
    const s = useBrowserStore.getState();
    expect(s.clusterAssignments.ds).toEqual({ carrier: 0, departed: 0, duplicate: 1, current: 1 });
    expect(s.svSplits.ds).toMatchObject({ counts: [1, 1, 0], includeDuplicates: false, viewStart: 9000 });
  });

  it('ignores a refresh whose duplicate setting changes while waiting', async () => {
    mockSplit({ carrier: 0 });
    await splitBySv(TARGET, SV);
    const def = useBrowserStore.getState().svSplits.ds;
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const pending = refreshSvSplit(TARGET, def);
    useBrowserStore.setState({ showDuplicateReads: false });
    finish(new Response(JSON.stringify({ assignments: { stale: 0 }, counts: [1, 0, 0], margin: 100 })));
    await pending;
    expect(useBrowserStore.getState().svSplits.ds).toBe(def);
    expect(useBrowserStore.getState().clusterAssignments.ds).toEqual({ carrier: 0 });
  });

  it('ignores an aborted refresh even if its response still resolves', async () => {
    mockSplit({ carrier: 0 });
    await splitBySv(TARGET, SV);
    const def = useBrowserStore.getState().svSplits.ds;
    const controller = new AbortController();
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const pending = refreshSvSplit(TARGET, def, controller.signal);
    controller.abort();
    finish(new Response(JSON.stringify({ assignments: { stale: 0 }, counts: [1, 0, 0], margin: 100 })));
    await pending;
    expect(useBrowserStore.getState().svSplits.ds).toBe(def);
  });
});

describe('Split by SV is one undo step (stabilize 2, item 1)', () => {
  let initial: ReturnType<typeof useBrowserStore.getState>;
  beforeEach(() => {
    initial = useBrowserStore.getState();
    useBrowserStore.setState({ chrom: 'chrSV', start: 8_000, end: 16_000, _historyStack: [], _historyPointer: -1, _lastRestoreTime: 0 });
    // A grouping of the panel before the split, recorded as its own step.
    useBrowserStore.getState().setClusterAssignments('ds', { a: 4, b: 5 });
    useBrowserStore.getState().pushSnapshot('Cluster reads', { kind: 'clustering' });
  });
  afterEach(() => { vi.unstubAllGlobals(); useBrowserStore.setState(initial, true); });

  it('records one step, and one Undo brings back the grouping before it', async () => {
    const before = useBrowserStore.getState()._historyStack.length;
    mockSplit({ a: 0, b: 1 });
    await splitBySv(TARGET, SV);
    let s = useBrowserStore.getState();
    expect(s._historyStack.slice(before).map(x => x.label)).toEqual(['Split by SV allele: DEL 1.5 kb @ chrSV:10,001']);
    s.undo();
    s = useBrowserStore.getState();
    expect(s.svSplits.ds).toBeUndefined();
    expect(s.clusterAssignments.ds).toEqual({ a: 4, b: 5 });
  });

  it('the first split after history was cleared can be undone (Codex stabilize-2 review, round 1)', async () => {
    useBrowserStore.getState().clearHistory();
    mockSplit({ a: 0, b: 1 });
    await splitBySv(TARGET, SV);
    let s = useBrowserStore.getState();
    expect(s.canUndo()).toBe(true);
    s.undo();
    s = useBrowserStore.getState();
    expect(s.svSplits.ds).toBeUndefined();
    expect(s.clusterAssignments.ds).toEqual({ a: 4, b: 5 });
    // And Clear SV split right after a cleared history.
    s.redo();
    useBrowserStore.getState().clearHistory();
    const { clearSvSplit } = await import('./svAlleleSplit');
    clearSvSplit('ds');
    s = useBrowserStore.getState();
    expect(s.canUndo()).toBe(true);
    s.undo();
    expect(useBrowserStore.getState().svSplits.ds).toBeTruthy();
  });

  it('Clear SV split is one step too', async () => {
    const { clearSvSplit } = await import('./svAlleleSplit');
    mockSplit({ a: 0, b: 1 });
    await splitBySv(TARGET, SV);
    // Not coalesced with the split by time: a later click.
    useBrowserStore.setState(s => ({ _historyStack: s._historyStack.map(x => ({ ...x, timestamp: x.timestamp - 10_000 })) }));
    const before = useBrowserStore.getState()._historyStack.length;
    clearSvSplit('ds');
    let s = useBrowserStore.getState();
    expect(s._historyStack.slice(before).map(x => x.label)).toEqual(['Clear SV split']);
    s.undo();
    s = useBrowserStore.getState();
    expect(s.svSplits.ds).toBeTruthy();
    expect(s.clusterAssignments.ds).toEqual({ a: 0, b: 1 });
  });
});
