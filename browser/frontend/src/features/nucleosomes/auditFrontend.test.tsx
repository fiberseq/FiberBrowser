/** Regressions for the frontend audit fixes (nucleosome panel, cluster views, charts). */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RegularityView, regularitySeries } from './RegularityView';
import { PatchGeometryView } from './PatchGeometryView';
import { nucGeometries, nucRegularity, submitNucJob } from './api';
import { useBrowserStore } from '../../stores/browserStore';
import { useReadActionsStore } from '../../stores/readActionsStore';
import { useNucGeoFocusStore } from '../../stores/nucGeoFocusStore';
import { resetAutoAnalyse } from './firstOpen';
import { holdNucRefresh, resetNucRefreshHolds, useNucJob } from './nucJob';
import { DEFAULT_REG_PARAMS, clusterViewNucSettings, requestRegParams, seriesIdentity, seriesView } from './regParams';
import { focusGeometry, refocusAfter } from './geoActions';
import { geoDatasetCounts, geoSetId, reconcileGeoSelection, registerGeometryFeatures } from './geoHub';
import { drawOverlayProfile } from '../../components/charts/OverlayProfileChart';
import { analyseClusterView, resetClusterAnalyse } from '../../components/controls/cluster-detail/clusterNuc';
import type { NucGeometryResult, NucGeometryRow, NucObservation } from './types';

vi.mock('./api', async original => ({ ...(await original<typeof import('./api')>()),
  nucRegularity: vi.fn(), nucGeometries: vi.fn(), submitNucJob: vi.fn(), getNucJob: vi.fn(), listNucJobs: vi.fn(async () => ({ jobs: [] })) }));
vi.mock('../../api/datasets', () => ({ getDatasets: vi.fn(async () => ({ datasets: [{ id: 'a', source_identity: 's2', regularity_identity: 'r2' }, { id: 'b', source_identity: 'sb', regularity_identity: 'rb2' }] })) }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const obs = (id: string, extra: Partial<NucObservation> = {}): NucObservation => ({ obsId: id, datasetId: id, panelId: `p-${id}`, stateKey: id,
  label: id, color: '#15803d', kind: 'linear', chrom: 'chr2R', start: 1000, end: 21000, ...extra });
const freshAt = (id: string) => ({ observations: [{ obsId: id, datasetId: id, molecules: 0, scored: 0, notComputed: 120 }], datasets: {}, updatedDatasets: [] }) as never;

describe('effective settings and request identity', () => {
  it('a panel that never edited its settings sends the complete defaults, the same request as one that did', () => {
    const none = requestRegParams(undefined);
    expect(none).toEqual({ ...DEFAULT_REG_PARAMS, mask_open_bp: null, thin_per_kb: null });
    expect(requestRegParams({ ...DEFAULT_REG_PARAMS })).toEqual(none);
    expect(requestRegParams({ ends: 'extend' }).ends).toBe('extend');
  });

  it('two equal-sized cohorts are different series; a cluster change keeps the view', () => {
    const a = [{ ...obs('a', { readIds: ['r1', 'r2'] }) }];
    const b = [{ ...obs('a', { readIds: ['r1', 'r3'] }) }];
    expect(seriesIdentity(a)).not.toBe(seriesIdentity(b));
    expect(seriesIdentity([{ ...a[0], strand: 'CT' as never }])).not.toBe(seriesIdentity(a));
    expect(seriesView(regularitySeries(a, { a: { r1: 0, r2: 1 } }))).toBe(seriesView(a));
  });

  it('the cluster views take the nucleosome panel\'s settings in full, else FiberHMM\'s defaults', () => {
    const s = clusterViewNucSettings([{ id: 'n1', contentType: 'nucleosomes', nucleosomes: { parameters: { x: 1 },
      regularity: { params: { ends: 'extend' }, cohort: 'spanning', autoAnalyse: 'off', patches: { params: { enter: 2.5 } } } } }]);
    expect(s).toMatchObject({ panelId: 'n1', cohort: 'spanning', autoAnalyse: 'off', analysis: { x: 1 } });
    expect(s.regularity).toEqual(requestRegParams({ ends: 'extend' }));
    expect(clusterViewNucSettings([]).regularity).toEqual(requestRegParams(undefined));
  });

  it('regularitySeries skips sentinel labels and matches record keys against read names', () => {
    const series = regularitySeries([obs('a', { readIds: ['q1', 'q2'] })], { a: { 'lift-record:v1 ["ds","q1","r"]': 0, q2: 1, q3: -2 } as never });
    expect(series.map(s => s.cluster)).toEqual([0, 1]);
    expect(series.some(s => s.label.includes('-1'))).toBe(false);
  });
});

describe('one read reload per settings change', () => {
  beforeEach(() => {
    resetNucRefreshHolds();
    useBrowserStore.setState({ datasets: [{ id: 'a', source_identity: 's1', regularity_identity: 'r1' }, { id: 'b', source_identity: 'sb', regularity_identity: 'rb' }] } as never);
  });
  it('the regularity and geometry answers refresh the datasets once, with the union of what they updated', async () => {
    const { getDatasets } = await import('../../api/datasets');
    vi.mocked(getDatasets).mockClear();
    const reg = holdNucRefresh(), geo = holdNucRefresh();
    await geo(['a']);
    expect(getDatasets).not.toHaveBeenCalled();
    await reg(['b']);
    await reg(['b']);          // released twice: counted once
    expect(getDatasets).toHaveBeenCalledTimes(1);
    expect(useBrowserStore.getState().datasets.map(d => d.regularity_identity)).toEqual(['r2', 'rb2']);
  });
  it('a lane switched on with the answers waits for the last one and lands with the refresh', async () => {
    const order: string[] = [];
    const reg = holdNucRefresh(), geo = holdNucRefresh();
    await reg(['a'], () => order.push('nucreg on'));
    expect(order).toEqual([]);
    await geo([], () => order.push('nucpatch on'));
    expect(order).toEqual(['nucreg on', 'nucpatch on']);
    expect(useBrowserStore.getState().datasets[0].regularity_identity).toBe('r2');
  });
  it('an aborted request releases without refreshing', async () => {
    const { getDatasets } = await import('../../api/datasets');
    vi.mocked(getDatasets).mockClear();
    await holdNucRefresh()();
    expect(getDatasets).not.toHaveBeenCalled();
  });
});

describe('RegularityView: requests and the automatic Analyse', () => {
  let container: HTMLDivElement, root: Root;
  const tick = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve(); await Promise.resolve(); }); };
  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    useBrowserStore.setState({ datasets: [{ id: 'a', label: 'A', data_type: 'bam' }, { id: 'b', label: 'B', data_type: 'bam' }], clusterAssignments: {} } as never);
    vi.mocked(nucRegularity).mockReset();
    vi.mocked(nucGeometries).mockReset();
    resetAutoAnalyse(); resetNucRefreshHolds();
    useNucJob.setState({ job: null, panelId: null, error: '' } as never);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); useNucJob.setState({ job: null, panelId: null } as never); });

  it('sends the complete settings it shows, never none', async () => {
    vi.mocked(nucRegularity).mockResolvedValue(freshAt('a'));
    await act(async () => { root.render(<RegularityView observations={[obs('a')]} settings={{ regularity: { autoAnalyse: 'off', patches: { open: false } } }}
      setSettings={vi.fn()} revision="0" includeDuplicates={false} panelId="r1" />); });
    await tick(700);
    expect(vi.mocked(nucRegularity).mock.calls[0][1]).toEqual(requestRegParams(undefined));
  });

  it("'first open': a pan while it runs never cancels it", async () => {
    vi.mocked(nucRegularity).mockResolvedValue(freshAt('b'));
    const cancel = vi.fn(async () => undefined);
    useNucJob.setState({ cancel } as never);
    const onAnalyse = vi.fn(async () => { useNucJob.setState({ job: { job_id: 'j1', status: 'running', datasets: ['b'], created_at: 0 } as never, panelId: 'r2' }); });
    const view = (start: number) => <RegularityView observations={[obs('b', { start, end: start + 20000 })]} settings={{ regularity: { patches: { open: false } } }}
      setSettings={vi.fn()} revision="0" includeDuplicates={false} onAnalyse={onAnalyse} panelId="r2" analysing={useNucJob.getState().job != null} />;
    await act(async () => { root.render(view(1000)); });
    await tick(700);
    expect(onAnalyse).toHaveBeenCalledTimes(1);
    await act(async () => { root.render(view(2000)); });      // a small pan
    await tick(700);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("'first open' is not used up while another Analyse runs: it starts when that one ends", async () => {
    vi.mocked(nucRegularity).mockResolvedValue(freshAt('b'));
    useNucJob.setState({ job: { job_id: 'other', status: 'running', datasets: ['x'], created_at: 0 } as never, panelId: 'elsewhere' });
    const onAnalyse = vi.fn();
    await act(async () => { root.render(<RegularityView observations={[obs('b')]} settings={{ regularity: { patches: { open: false } } }}
      setSettings={vi.fn()} revision="0" includeDuplicates={false} onAnalyse={onAnalyse} panelId="r3" />); });
    await tick(700);
    expect(onAnalyse).not.toHaveBeenCalled();
    // it says why it waits: one Analyse at a time (the header's button is disabled meanwhile)
    expect(container.querySelector('[data-testid="nuc-reg-needs-analyse"]')?.textContent).toContain('Another Analyse is running');
    await act(async () => { useNucJob.setState({ job: { job_id: 'other', status: 'complete', datasets: ['x'], created_at: 0 } as never }); });
    await tick(10);
    expect(onAnalyse).toHaveBeenCalledWith(['b']);
  });

  it('changing Auto-Analyse acts on the current view', async () => {
    vi.mocked(nucRegularity).mockResolvedValue(freshAt('b'));
    const onAnalyse = vi.fn();
    const view = (auto: 'off' | 'every') => <RegularityView observations={[obs('b')]} settings={{ regularity: { autoAnalyse: auto, patches: { open: false } } }}
      setSettings={vi.fn()} revision="0" includeDuplicates={false} onAnalyse={onAnalyse} panelId="r4" />;
    await act(async () => { root.render(view('off')); });
    await tick(1500);
    expect(onAnalyse).not.toHaveBeenCalled();
    await act(async () => { root.render(view('every')); });
    await tick(1100);
    expect(onAnalyse).toHaveBeenCalledWith(['b']);
    expect(vi.mocked(nucRegularity)).toHaveBeenCalledTimes(1);     // no new request for a mode change
  });

  it("switching to 'off' during the settle delay starts nothing", async () => {
    vi.mocked(nucRegularity).mockResolvedValue(freshAt('b'));
    const onAnalyse = vi.fn();
    const view = (auto: 'off' | 'every') => <RegularityView observations={[obs('b')]} settings={{ regularity: { autoAnalyse: auto, patches: { open: false } } }}
      setSettings={vi.fn()} revision="0" includeDuplicates={false} onAnalyse={onAnalyse} panelId="r5" />;
    await act(async () => { root.render(view('every')); });
    await tick(700);
    await act(async () => { root.render(view('off')); });
    await tick(2000);
    expect(onAnalyse).not.toHaveBeenCalled();
  });

  it('Along the region does not offer patch shares (no stored profile holds them)', async () => {
    vi.mocked(nucRegularity).mockResolvedValue({ observations: [{ obsId: 'a', datasetId: 'a', molecules: 3, scored: 3, track: { edges: [1000, 2000], mean: [1], n: [3] } }],
      datasets: {}, updatedDatasets: [] } as never);
    await act(async () => { root.render(<RegularityView observations={[obs('a')]} settings={{ regularity: { view: 'charts', trackChannel: 'nucpatch.share', patches: { open: false } } }}
      setSettings={vi.fn()} revision="0" includeDuplicates={false} panelId="r6" />); });
    await tick(700);
    const sel = container.querySelector<HTMLSelectElement>('[data-testid="nuc-reg-track-channel"]')!;
    expect([...sel.options].map(o => o.value)).not.toContain('nucpatch.share');
    expect(sel.value).toBe('nucreg.score');
  });

  it('the patch section never shows another view\'s geometries and surfaces a failed regularity request', async () => {
    const geo = (n: number) => ({ window: { chrom: 'chr2R', start: 1000, end: 21000 }, params: { patch: {}, geometry: {}, view: {} }, references: {}, errors: {},
      nMolecules: n, nPatches: 1, geometries: [], nested: [], profiles: { edges: [1000, 21000], share: {}, carriers: {}, none: [0] }, patchStats: {},
      assignments: {}, updatedDatasets: [] });
    vi.mocked(nucGeometries).mockResolvedValue(geo(7) as never);
    const series = (start: number) => regularitySeries([obs('a', { start, end: start + 20000 })], {});
    const render = (start: number, state: 'ready' | 'error' | 'loading' = 'ready') => <PatchGeometryView series={series(start)} settings={{ regularity: { patches: { open: true } } }}
      setSettings={vi.fn()} revision="0" includeDuplicates={false} panelId="g1" regularityState={state} regularityError="boom" />;
    await act(async () => { root.render(render(1000)); });
    await tick(600);
    expect(container.querySelector('[data-testid="nuc-patch-status"]')?.textContent).toContain('7 molecules');
    vi.mocked(nucGeometries).mockReturnValue(new Promise(() => {}) as never);
    await act(async () => { root.render(render(50000, 'loading')); });
    expect(container.querySelector('[data-testid="nuc-patch-status"]')).toBeNull();     // A's answer is not B's
    // B: not analysed, and the regularity request failed: its error, never an endless spinner
    vi.mocked(nucGeometries).mockResolvedValue({ ...geo(0), errors: { a: 'No regularity reference yet: run Analyse first' } } as never);
    await act(async () => { root.render(render(90000, 'error')); });
    await tick(600);
    expect(container.querySelector('[data-testid="nuc-patch-error"]')?.textContent).toContain('boom');
    expect(container.querySelector('[data-testid="nuc-patch-analysing"]')).toBeNull();
  });
});

describe('cluster views never replace a running Analyse', () => {
  const series = regularitySeries([obs('a')], { a: { r1: 0, r2: 1 } });
  const settings = (auto: 'off' | 'first' | 'every' = 'every') => ({ ...clusterViewNucSettings([{ id: 'nuc1', contentType: 'nucleosomes',
    nucleosomes: { parameters: { lam: 2 }, regularity: { autoAnalyse: auto } } }]) });
  beforeEach(() => { resetClusterAnalyse(); vi.mocked(submitNucJob).mockReset(); useNucJob.getState().clear(); });
  afterEach(() => useNucJob.getState().clear());

  it('waits while a job runs (no submission), then analyses under the panel with its parameters', async () => {
    useNucJob.setState({ job: { job_id: 'panel', status: 'running', datasets: ['a'], created_at: 0 } as never, panelId: 'nuc1' });
    const waiting = await analyseClusterView(series, ['a'], 'v1', settings(), false, 'x');
    expect(waiting.status).toBe('analysing');
    expect(submitNucJob).not.toHaveBeenCalled();
    useNucJob.setState({ job: null } as never);
    vi.mocked(submitNucJob).mockResolvedValue({ job_id: 'c', status: 'complete', datasets: ['a'], created_at: 1, results: {} } as never);
    const started = await analyseClusterView(series, ['a'], 'v1', settings(), false, 'x');
    expect(started.status).toBe('analysing');
    expect(vi.mocked(submitNucJob).mock.calls[0][0]).toMatchObject({ datasets: ['a'], parameters: { lam: 2 } });
    expect(useNucJob.getState().panelId).toBe('nuc1');
    // the same view is never submitted twice
    expect((await analyseClusterView(series, ['a'], 'v1', settings(), false, 'x')).status).toBe('needs-analyse');
  });

  it("follows the panel's Auto-Analyse: 'off' offers, 'first' starts once per page", async () => {
    expect((await analyseClusterView(series, ['a'], 'v1', settings('off'), false, 'x')).status).toBe('needs-analyse');
    vi.mocked(submitNucJob).mockResolvedValue({ job_id: 'c', status: 'complete', datasets: ['a'], created_at: 1, results: {} } as never);
    await analyseClusterView(series, ['a'], 'v1', settings('first'), false, 'x');
    expect((await analyseClusterView(series, ['a'], 'v2', settings('first'), false, 'x')).status).toBe('needs-analyse');
    expect(submitNucJob).toHaveBeenCalledTimes(1);
  });

  it('a failed submission is an error, not a ready answer', async () => {
    vi.mocked(submitNucJob).mockRejectedValue(new Error('no'));
    expect((await analyseClusterView(series, ['a'], 'v9', settings(), false, 'x')).status).toBe('error');
  });
});

describe('charts', () => {
  const recorder = () => {
    const ys: number[] = [];
    const ctx = new Proxy({ measureText: () => ({ width: 10 }), lineTo: (_x: number, y: number) => ys.push(y), moveTo: (_x: number, y: number) => ys.push(y) } as Record<string, unknown>,
      { get: (t, k) => (k in t ? t[k as string] : () => {}), set: () => true });
    return { ctx: ctx as unknown as CanvasRenderingContext2D, ys };
  };
  it('a negative regularity profile is drawn inside the chart (signed domain), gaps stay gaps', () => {
    const { ctx, ys } = recorder();
    drawOverlayProfile(ctx, 300, 70, [{ data: [-1, -1, NaN, -0.5], color: '#000', label: 'c0' }], false, false, undefined, 'score', false, undefined);
    expect(ys.length).toBeGreaterThan(0);
    expect(ys.every(y => Number.isFinite(y) && y >= 0 && y <= 70)).toBe(true);
  });
});

describe('geometry focus, selection and shares across analyses', () => {
  const row = (id: string, gid: string, start: number, extra: Partial<NucGeometryRow> = {}): NucGeometryRow => ({ id, kind: 'high', number: 1, rootNumber: undefined as never,
    geometryId: gid, start, end: start + 1000, width: 1000, openLeft: false, openRight: false, molecules: 5, patches: 5, startMad: 0, endMad: 0, score: 1, period: 190,
    parent: null, parentIndex: null, children: [], perObservation: {}, densityMatched: {}, ...extra } as NucGeometryRow);
  const res = (G: NucGeometryRow[], carried: Record<string, number[]>): NucGeometryResult => ({ window: { chrom: 'c', start: 0, end: 10000 },
    params: { patch: {}, geometry: { tol_bp: 0 }, view: {} }, references: {}, errors: {}, nMolecules: 3, nPatches: 3, geometries: G, nested: [],
    profiles: { edges: [], share: {}, carriers: {}, none: [] }, patchStats: {}, assignments: { a: { group: {}, carried, partial: {} } }, updatedDatasets: [] } as never);
  beforeEach(() => { useNucGeoFocusStore.getState().clear(); useReadActionsStore.getState().reset(); });

  it('a renumbered analysis moves the focus to the same geometry and highlights its carriers again', () => {
    const before = res([row('G1', 'x', 1000), row('G2', 'y', 5000)], { q1: [1], q2: [2] });
    focusGeometry(before, 0);
    expect([...useNucGeoFocusStore.getState().focused]).toEqual(['high:1']);
    const after = res([row('G1', 'z', 300), row('G2', 'x', 1000)], { q3: [1], q1: [2] });
    refocusAfter(before, after);
    expect([...useNucGeoFocusStore.getState().focused]).toEqual(['high:2']);
    expect([...useReadActionsStore.getState().highlight!.ids]).toEqual(['q1']);
    // highlighted only in the dataset carrying it
    expect(Object.keys(useReadActionsStore.getState().highlight!.scopedRows ?? {})).toEqual(['a']);
    // gone: focus and highlight cleared
    refocusAfter(after, res([row('G1', 'w', 7000)], {}));
    expect(useNucGeoFocusStore.getState().focused.size).toBe(0);
    expect(useReadActionsStore.getState().highlight).toBeNull();
  });

  it('toolbar selections follow a new run of the panel (its request) or are dropped', () => {
    registerGeometryFeatures();
    const G1 = [row('G1', 'x', 1000)];
    const run = (G: NucGeometryRow[], request: unknown) => ({ panelId: 'p', request: request as never, result: res(G, {}), datasets: ['a'],
      seriesDataset: { o: 'a' }, origin: null, updatedAt: 0 });
    const first = run(G1, { v: 1 });
    useBrowserStore.setState({ selectedFeatures: [{ kind: 'nuc-geometry', source: geoSetId('p'), id: 'geometry:1000-2000', start: 1000, end: 2000,
      hubHit: { stateSpec: { kind: 'nuc-geometry', geometryId: 'x', request: first.request } } as never }], panels: [], datasets: [] } as never);
    reconcileGeoSelection(run([row('G1', 'x', 1000)], { v: 2 }));
    const sel = useBrowserStore.getState().selectedFeatures;
    expect(sel).toHaveLength(1);
    expect((sel[0].hubHit!.stateSpec as { request: unknown }).request).toEqual({ v: 2 });
    // a new run over other series with the same settings (a cluster run) leaves the selection as it is
    const kept = useBrowserStore.getState().selectedFeatures;
    reconcileGeoSelection(run([row('G1', 'x', 1000)], { v: 2, observations: [{ obsId: 'o::c0' }] }));
    expect(useBrowserStore.getState().selectedFeatures).toBe(kept);
    reconcileGeoSelection(run([row('G1', 'other', 6000)], { v: 3 }));
    expect(useBrowserStore.getState().selectedFeatures).toHaveLength(0);
  });

  it('per-dataset shares count each molecule once across overlapping panels', () => {
    const g = row('G1', 'x', 1000, { perObservation: { p1: { molecules: 100, full: 10 }, p2: { molecules: 10, full: 10 } } as never,
      perDataset: { a: { molecules: 100, full: 10, partial: 0, callable: 100 } } });
    expect(geoDatasetCounts(g, { p1: 'a', p2: 'a' })).toEqual({ a: { full: 10, molecules: 100, callable: 100 } });
    // an older answer without perDataset still sums its series
    expect(geoDatasetCounts({ ...g, perDataset: undefined }, { p1: 'a', p2: 'a' })).toEqual({ a: { full: 20, molecules: 110, callable: 0 } });
  });
});

describe('graph and linear reads share the regularity identity rule', () => {
  it('a regularity compute moves the reads identity only when they carry nucreg or nucpatch', async () => {
    const { readRowsIdentity } = await import('../../components/tracks/read-track/useReadTrackData');
    const before = { id: 'a', source_identity: 's', regularity_identity: 'r1' }, after = { ...before, regularity_identity: 'r2' };
    expect(JSON.stringify(readRowsIdentity(before, false))).toBe(JSON.stringify(readRowsIdentity(after, false)));
    expect(JSON.stringify(readRowsIdentity(before, true))).not.toBe(JSON.stringify(readRowsIdentity(after, true)));
  });
});

describe('a Cluster refinement and output refreshes', () => {
  it('a dataset refresh of server outputs is not a change of intent; a settings change is', async () => {
    const { sameDatasetIntent } = await import('../../utils/progressiveAnalysis');
    const a = [{ id: 'a', label: 'A', source_identity: 's1', regularity_identity: 'r1', available_layers: { nuc: true } }] as never;
    const refreshed = [{ id: 'a', label: 'A', source_identity: 's2', regularity_identity: 'r2', available_layers: { nuc: true, nucreg: true } }] as never;
    expect(sameDatasetIntent(a, refreshed)).toBe(true);
    expect(sameDatasetIntent(a, [{ id: 'a', label: 'B', source_identity: 's1', regularity_identity: 'r1' }] as never)).toBe(false);
  });
});
