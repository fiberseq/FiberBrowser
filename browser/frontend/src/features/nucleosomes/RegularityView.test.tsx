import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RegularityView, regularitySeries } from './RegularityView';
import { nucRegularity } from './api';
import { useBrowserStore } from '../../stores/browserStore';
import { getClusterColor } from '../../components/tracks/read-track/constants';
import { buildNucRegRows, nucRegRampColor, nucRegScaleT, nucRegScoreAt, nucRegScoreFromByte, NUC_REG_FALLBACK_SCALE } from '../../utils/nucLayers';
import { drawNucRegLane, nucRegLaneGeometry } from '../../components/tracks/read-track/nucRegCanvas';
import type { NucObservation, NucRegularityResult } from './types';
import { resetAutoAnalyse } from './firstOpen';
import { useNucJob } from './nucJob';

vi.mock('./api', async original => ({ ...(await original<typeof import('./api')>()), nucRegularity: vi.fn() }));
vi.mock('./nucJob', async original => ({ ...(await original<typeof import('./nucJob')>()), refreshNucDatasets: vi.fn(async () => undefined) }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const enc = (s: number) => 1 + Math.round(Math.min(1, Math.max(0, (s + 2) / 10)) * 254);
const obs = (id: string, extra: Partial<NucObservation> = {}): NucObservation => ({ obsId: id, datasetId: id, panelId: `p-${id}`, stateKey: id,
  label: id, color: '#15803d', kind: 'linear', chrom: 'chr2R', start: 1000, end: 21000, ...extra });

describe('regularity layer helpers', () => {
  it('decodes bytes and maps the scale onto the ramp', () => {
    expect(nucRegScoreFromByte(0)).toBeNull();
    expect(nucRegScoreFromByte(enc(4))!).toBeCloseTo(4, 1);
    const scale = { zero: 3, top: 6 };
    expect(nucRegScaleT(2, scale)).toBe(0);
    expect(nucRegScaleT(4.5, scale)).toBeCloseTo(0.5);
    expect(nucRegScaleT(9, scale)).toBe(1);
    expect(nucRegRampColor(0)).toBe('rgb(247,244,220)');
    expect(nucRegRampColor(1)).toBe('rgb(36,34,90)');
  });

  it('interpolates between tile centres and never across a missing tile', () => {
    const rows = buildNucRegRows({ intervals: [[0, 250, 250], [250, 500, 250], [1000, 1250, 250]],
      qualities: [[enc(3), enc(5), enc(7)], [90, 90, 90]] })!;
    expect(rows.scale).toEqual(NUC_REG_FALLBACK_SCALE);
    expect(nucRegScoreAt(rows, 250)!).toBeCloseTo(4, 1);     // halfway between centres 125 and 375
    expect(nucRegScoreAt(rows, 50)!).toBeCloseTo(3, 1);      // flat in the outer half tile
    expect(nucRegScoreAt(rows, 700)).toBeNull();             // the gap (no score) is not bridged
    expect(nucRegScoreAt(rows, 1100)!).toBeCloseTo(7, 1);
  });

  it('draws the lane as narrow rects of graded colour over the top of the row', () => {
    const fills: Array<{ x: number; y: number; w: number; h: number; c: string }> = [];
    const ctx = { save() {}, restore() {}, globalAlpha: 1, fillStyle: '', fillRect(x: number, y: number, w: number, h: number) { fills.push({ x, y, w, h, c: String(this.fillStyle) }); } };
    const rows = buildNucRegRows({ intervals: [[0, 250, 250], [250, 500, 250], [500, 750, 250]], qualities: [[enc(3), enc(4.5), enc(6)], [90, 90, 90]],
      scale: { zero: 3, top: 6 } } as never)!;
    const n = drawNucRegLane(ctx as never, rows, { y: 10, bodyH: 10, linkedOffset: 0, regionWidth: 1000, toX: v => v / 2, full: false });
    expect(n).toBe(3);
    expect(fills.length).toBeGreaterThan(10);
    expect(new Set(fills.map(f => f.c)).size).toBeGreaterThan(5);          // graded, not three blocks
    expect(fills.every(f => f.y === 10 && f.h === nucRegLaneGeometry(10, 10, false)!.h)).toBe(true);
    expect(fills[0].c).toBe(nucRegRampColor(0));
    expect(nucRegLaneGeometry(0, 10, true)!.h).toBe(10);
  });
});

describe('regularitySeries', () => {
  it('splits observations by their panel’s clusters, coloured per cluster and dashed per dataset', () => {
    const series = regularitySeries([obs('a'), obs('b')], { a: { r1: 0, r2: 1, r3: 1 }, b: {} });
    expect(series.map(s => s.obsId)).toEqual(['a::c0', 'a::c1', 'b']);
    expect(series[1].readIds).toEqual(['r2', 'r3']);
    expect(series[1].seriesColor).toBe(getClusterColor(1));
    expect(series[0].dash).toBe('');
    expect(series[2].dash).not.toBe('');
    expect(series[2].seriesColor).toBe('#15803d');
  });

  it('keeps a filtered panel’s read subset inside each cluster', () => {
    const series = regularitySeries([obs('a', { readIds: ['r1', 'r2'] })], { a: { r1: 0, r2: 1, r3: 1 } });
    expect(series.map(s => s.readIds)).toEqual([['r1'], ['r2']]);
  });
});

const hist = (n: number) => ({ edges: Array.from({ length: n + 1 }, (_, i) => i), counts: Array.from({ length: n }, (_, i) => i % 5), n: 10 });
const result = (ids: string[]): NucRegularityResult => ({
  observations: ids.map((id, k) => ({ obsId: id, datasetId: 'a', molecules: 40 + k, scored: 40,
    scores: hist(8), periods: { values: [180, 186, 191], counts: [3, 5, 2], n: 10 }, track: { edges: [1000, 2000, 3000], mean: [3.5, 4.2], n: [4, 5] },
    scatter: { points: [[3.2, 50], [4.1, 70], [4.6, 80]], n: 3, spearman: 0.6 }, acf: { lags: [0, 50, 100], mean: [1, 0.1, 0.2], n: 3, maskBp: 300, thinPerKb: 25 },
    summary: { molecules: 40 + k, m6aPerKb: 63.4, footprintMedian: 151, mergedPct: 26.3, spacingMedian: 189.5, score: 3.87, scoreAboveRef: 0.86, repeatLength: 191 } })),
  datasets: { a: { params: {}, paramsDigest: 'x', reference: { median: 3.01, quantiles: {}, n_windows: 3000, n_molecules: 400, observed_p95: 5.7,
    observed_median: 3.9, hist: hist(8) }, scale: { zero: 3.01, top: 5.7, reference: true }, recomputed: 0, missing: 0 } },
  updatedDatasets: [],
});

describe('RegularityView', () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    useBrowserStore.setState({ datasets: [{ id: 'a', label: 'Early', data_type: 'bam' }], clusterAssignments: { a: { r1: 0, r2: 1 } } } as never);
    vi.mocked(nucRegularity).mockReset();
    resetAutoAnalyse();
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

  const freshAt = (id: string) => ({ observations: [{ obsId: id, datasetId: 'b', molecules: 0, scored: 0, notComputed: 120 }], datasets: {}, updatedDatasets: [] }) as never;
  const tick = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve(); await Promise.resolve(); }); };

  it('auto-Analyse off: nothing starts; an unanalysed view says so once and hands its datasets to the header\'s Analyse', async () => {
    vi.mocked(nucRegularity).mockResolvedValue(freshAt('b'));
    const onAnalyse = vi.fn(), onTodo = vi.fn();
    await act(async () => { root.render(<RegularityView observations={[obs('b')]} settings={{ regularity: { autoAnalyse: 'off', patches: { open: true } } }} setSettings={vi.fn()}
      revision="0" includeDuplicates={false} onAnalyse={onAnalyse} panelId="p1" settingsOpen onTodo={onTodo} />); });
    await tick(700);
    expect(onAnalyse).not.toHaveBeenCalled();
    // one status line (the patch section's), no second offer and no button in the body
    expect(container.querySelector('[data-testid="nuc-geo-needs-analyse"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="nuc-reg-needs-analyse"]')).toBeNull();
    expect(container.querySelector('[data-testid="nuc-geo-analysing"]')).toBeNull();
    expect(container.querySelectorAll('button').length ? [...container.querySelectorAll('button')].some(b => /Analyse this view/.test(b.textContent ?? '')) : false).toBe(false);
    expect(container.querySelector<HTMLSelectElement>('[data-testid="nuc-reg-auto"]')!.value).toBe('off');
    expect(onTodo).toHaveBeenLastCalledWith(['b']);
  });

  it('auto-Analyse first open (default): one Analyse on the first view only; panning then offers the button', async () => {
    vi.mocked(nucRegularity).mockResolvedValue(freshAt('b'));
    const onAnalyse = vi.fn();
    const view = (start: number) => <RegularityView observations={[obs('b', { start, end: start + 20000 })]} settings={{ regularity: { patches: { open: false } } }}
      setSettings={vi.fn()} revision="0" includeDuplicates={false} onAnalyse={onAnalyse} panelId="p2" />;
    await act(async () => { root.render(view(1000)); });
    await tick(700);
    expect(onAnalyse).toHaveBeenCalledTimes(1);
    await act(async () => { root.render(view(50000)); });       // a pan
    await tick(700);
    await tick(1500);
    expect(onAnalyse).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="nuc-reg-needs-analyse"]')).not.toBeNull();
  });

  it('auto-Analyse every view: waits for the view to settle and cancels the automatic Analyse of a view left', async () => {
    vi.mocked(nucRegularity).mockResolvedValue(freshAt('b'));
    const cancel = vi.fn(async () => undefined);
    const onAnalyse = vi.fn(async () => { useNucJob.setState({ job: { job_id: 'j1', status: 'running', datasets: ['b'], created_at: 0 } as never, panelId: 'p3' }); });
    useNucJob.setState({ job: null, panelId: null, cancel } as never);
    const view = (start: number) => <RegularityView observations={[obs('b', { start, end: start + 20000 })]} settings={{ regularity: { autoAnalyse: 'every', patches: { open: false } } }}
      setSettings={vi.fn()} revision="0" includeDuplicates={false} onAnalyse={onAnalyse} panelId="p3" />;
    await act(async () => { root.render(view(1000)); });
    await tick(700);
    expect(onAnalyse).not.toHaveBeenCalled();                  // answered at 0.6 s: not settled yet
    await tick(500);
    expect(onAnalyse).toHaveBeenCalledTimes(1);
    await act(async () => { root.render(view(60000)); });      // moved on while it runs
    expect(cancel).toHaveBeenCalledTimes(1);
    useNucJob.setState({ job: null, panelId: null } as never);
    await tick(700);
    await tick(500);
    expect(onAnalyse).toHaveBeenCalledTimes(2);
    useNucJob.setState({ job: null, panelId: null } as never);
  });

  it('a fresh view (no nucleosome calls) starts the Analyse once, shows Analysing, and every chart has the save control', async () => {
    const fresh = { observations: [{ obsId: 'b', datasetId: 'b', molecules: 0, scored: 0, notComputed: 120 }], datasets: {}, updatedDatasets: [] } as never;
    vi.mocked(nucRegularity).mockResolvedValue(fresh);
    const onAnalyse = vi.fn();
    const view = (analysing: boolean) => <RegularityView observations={[obs('b')]} settings={{ regularity: { patches: { open: false } } }} setSettings={vi.fn()}
      revision="0" includeDuplicates={false} onAnalyse={onAnalyse} analysing={analysing} />;
    await act(async () => { root.render(view(false)); });
    await act(async () => { vi.advanceTimersByTime(700); await Promise.resolve(); });
    expect(onAnalyse).toHaveBeenCalledWith(['b']);
    await act(async () => { root.render(view(true)); });
    expect(container.querySelector('[data-testid="nuc-reg-analysing"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="nuc-reg-empty"]')).toBeNull();
    // the same view again: never a second Analyse
    await act(async () => { root.render(view(false)); });
    await act(async () => { vi.advanceTimersByTime(700); await Promise.resolve(); });
    expect(onAnalyse).toHaveBeenCalledTimes(1);
    vi.mocked(nucRegularity).mockResolvedValue(result(['a::c0', 'a::c1']));
    await act(async () => { root.render(<RegularityView observations={[obs('a')]} settings={{ regularity: { view: 'charts' } }} setSettings={vi.fn()} revision="1" includeDuplicates={false} />); });
    await act(async () => { vi.advanceTimersByTime(700); await Promise.resolve(); });
    expect(container.querySelectorAll('[data-testid="nuc-reg-acf-chart"]').length).toBe(1);
    expect(container.querySelectorAll('[data-testid="chart-save"]').length).toBeGreaterThanOrEqual(5);
  });

  it('requests one series per cluster and draws the charts and the table', async () => {
    vi.mocked(nucRegularity).mockResolvedValue(result(['a::c0', 'a::c1']));
    const setSettings = vi.fn();
    await act(async () => { root.render(<RegularityView observations={[obs('a')]} settings={{ regularity: { view: 'charts' } }} setSettings={setSettings} revision="0" includeDuplicates={false} settingsOpen />); });
    await act(async () => { vi.advanceTimersByTime(700); await Promise.resolve(); });
    expect(nucRegularity).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(nucRegularity).mock.calls[0][0];
    expect(sent.map(o => [o.obsId, o.cluster])).toEqual([['a::c0', 0], ['a::c1', 1]]);
    expect(container.querySelectorAll('[data-testid="nuc-reg-row"]').length).toBe(2);
    for (const id of ['nuc-reg-scores-chart', 'nuc-reg-track-chart', 'nuc-reg-periods-chart', 'nuc-reg-scatter-chart', 'nuc-reg-acf-chart']) {
      expect(container.querySelector(`[data-testid="${id}"]`)?.tagName.toLowerCase()).toBe('svg');
    }
    expect(container.textContent).toContain('random packing median 3.01');
    expect(container.textContent).toContain('+0.86');
    expect(container.textContent).not.toMatch(/problem|error/i);
    // the cohort: overlapping by default (the scan's default), a select in the controls
    expect(vi.mocked(nucRegularity).mock.calls[0][2]).toBe('overlapping');
    const sel = container.querySelector('[data-testid="nuc-reg-cohort"]') as HTMLSelectElement;
    expect(sel.value).toBe('overlapping');
    await act(async () => { sel.value = 'spanning'; sel.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(setSettings).toHaveBeenCalledWith({ regularity: { view: 'charts', cohort: 'spanning', spanning: true } });
  });

  it('an older session’s spanning flag still selects the spanning cohort', async () => {
    vi.mocked(nucRegularity).mockResolvedValue(result(['a::c0', 'a::c1']));
    await act(async () => { root.render(<RegularityView observations={[obs('a')]} settings={{ regularity: { spanning: true } }} setSettings={vi.fn()} revision="0" includeDuplicates={false} />); });
    await act(async () => { vi.advanceTimersByTime(700); await Promise.resolve(); });
    expect(vi.mocked(nucRegularity).mock.calls[0][2]).toBe('spanning');
  });

  it('Along the region shows the regularity score, its period, or a layer metaprofile per cluster', async () => {
    const res = result(['a::c0', 'a::c1']);
    for (const o of res.observations) o.track = { ...o.track!, period: [182, 190] };
    vi.mocked(nucRegularity).mockResolvedValue(res);
    useBrowserStore.setState({ clusterProfiles: { a: { 0: { tf: [0.1, 0.2, 0.3, 0.4] }, 1: { tf: [0.4, 0.3, 0.2, 0.1] } } } } as never);
    const setSettings = vi.fn();
    const render = async (trackChannel?: string) => {
      await act(async () => { root.render(<RegularityView observations={[obs('a')]} settings={{ regularity: trackChannel ? { view: 'charts', trackChannel } : { view: 'charts' } }}
        setSettings={setSettings} revision="0" includeDuplicates={false} />); });
      await act(async () => { vi.advanceTimersByTime(700); await Promise.resolve(); });
    };
    await render();
    const select = container.querySelector('[data-testid="nuc-reg-track-channel"]') as HTMLSelectElement;
    expect(select.value).toBe('nucreg.score');
    expect([...select.options].map(o => o.value)).toEqual(expect.arrayContaining(['nucreg.score', 'nucreg.period']));
    const paths = () => [...container.querySelectorAll('[data-testid="nuc-reg-track-chart"] path')].map(p => p.getAttribute('d'));
    const scorePaths = paths();
    await act(async () => { select.value = 'nucreg.period'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(setSettings).toHaveBeenLastCalledWith({ regularity: { view: 'charts', trackChannel: 'nucreg.period' } });
    await render('nucreg.period');
    expect(container.textContent).toContain('repeat length (bp)');
    await render('tf');
    const tfPaths = paths();
    expect(tfPaths).toHaveLength(2);
    expect(tfPaths).not.toEqual(scorePaths);
    expect(container.textContent).toContain('TF (share)');
  });

  it('a parameter change is saved and sent as the layer’s parameters', async () => {
    vi.mocked(nucRegularity).mockResolvedValue(result(['a::c0', 'a::c1']));
    const setSettings = vi.fn();
    await act(async () => { root.render(<RegularityView observations={[obs('a')]} settings={{}} setSettings={setSettings} revision="0" includeDuplicates={false} settingsOpen />); });
    const select = container.querySelector('[data-testid="nuc-reg-signal"]') as HTMLSelectElement;
    await act(async () => { select.value = 'occupancy'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(setSettings).toHaveBeenCalledWith({ regularity: { params: expect.objectContaining({ signal: 'occupancy', mask_open_bp: null, thin_per_kb: null }) } });
    const params = setSettings.mock.calls[0][0].regularity.params;
    await act(async () => { root.render(<RegularityView observations={[obs('a')]} settings={{ regularity: { params } }} setSettings={setSettings} revision="0" includeDuplicates={false} />); });
    await act(async () => { vi.advanceTimersByTime(700); await Promise.resolve(); });
    const last = vi.mocked(nucRegularity).mock.calls.at(-1)!;
    expect(last[1]).toMatchObject({ signal: 'occupancy' });
  });
});
