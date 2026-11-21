/**
 * Differential features: the settings model, the sides (datasets with replicates, clusters, read groups), the request
 * (features as state refs), calls / sorting / volcano coordinates / TSV, and the view: a planted result draws its up
 * and down calls, the table sorts, a point click moves the locus, the selection goes to the hub, and a stored result
 * draws without a request.
 */
import '../testSetup';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ fetchJson: vi.fn(), candidates: [] as unknown[] }));
vi.mock('../../api/sharedFetch', async importOriginal => ({ ...(await importOriginal<typeof import('../../api/sharedFetch')>()), fetchJson: api.fetchJson }));

import { useBrowserStore } from '../../stores/browserStore';
import { compareAvailable, describePlot, groupAvailable, newPlot, normalizeDiffSettings, normalizePlot, PLOT_COMPARE, PLOT_GROUP_BY, withType } from './plotModel';
import {
  callOf, diffRequestBody, diffSides, diffTsv, negLog10Q, Q_CAP, sortDiffRows, type DiffEntry, type DiffRow,
} from './differentialData';
import { nearestPoint } from './diffCharts';
import { DifferentialPlot } from './DifferentialPlot';
import { useWorkspaceStore } from './workspace';
import { setHubWorkspaceEnabled } from './hubWorkspaceFlag';
import { beforeEach as beforeEachFlag } from 'vitest';

// These tests exercise the full-window hub: the experimental flag on (hubWorkspaceFlag.test covers it off).
beforeEachFlag(() => { setHubWorkspaceEnabled(true, false); });

const row = (key: string, delta: number | null, q: number | null, extra: Partial<DiffRow> = {}): DiffRow => ({
  key, label: key, kind: 'peaks.peak', chrom: 'chrT', start: 1000, end: 1100, kA: 10, nA: 20, kB: 5, nB: 20, fracA: 0.5, fracB: 0.25,
  delta, deltaLo: delta == null ? null : delta - 0.1, deltaHi: delta == null ? null : delta + 0.1, log2or: delta == null ? null : delta * 4, log2orLo: null, log2orHi: null,
  p: q, q, strata: null, testable: q != null, reason: q == null ? 'too few evaluated reads in A' : null, ...extra,
});
const target = { chrom: 'chrT', start: 0, end: 5000, genome: null, panels: [{ key: 'p1', datasetId: 'd1', label: 'Early' }, { key: 'p2', datasetId: 'd2', label: 'Late' }, { key: 'p3', datasetId: 'd3', label: 'Late 2' }] };

describe('settings and availability', () => {
  it('normalizes every parameter with its default; only two-group Group by and no Compare', () => {
    expect(normalizeDiffSettings({ qMax: 5, densityBins: 99, test: 'x', features: 'classes', sideA: ['a', 3] })).toMatchObject({ qMax: 1, densityBins: 10, test: 'fisher', features: 'classes', sideA: ['a'] });
    expect(normalizePlot({ type: 'differential' }).diff).toEqual(normalizeDiffSettings({}));
    expect(PLOT_GROUP_BY.filter(g => groupAvailable(g, 'differential')).map(g => g.value)).toEqual(['dataset', 'cluster', 'classes', 'read-groups']);
    expect(PLOT_COMPARE.filter(c => compareAvailable(c, 'differential')).map(c => c.value)).toEqual(['off']);
    const p = withType(newPlot({ type: 'metaprofile', groupBy: 'none', compare: 'diff', where: 'features' }), 'differential');
    expect(p).toMatchObject({ type: 'differential', groupBy: 'dataset', compare: 'off', where: 'view' });
    expect(describePlot({ ...p, diff: { ...p.diff, densityMatch: true } })).toBe('Differential features · Peaks · current view · by dataset · density matched');
  });
});

describe('sides', () => {
  const plot = newPlot({ type: 'differential' });
  it('datasets: first vs second by default; several per side (replicates); a dataset is on one side only', () => {
    const s = diffSides(plot, target, null, null, {});
    expect([s.A?.datasets, s.B?.datasets, s.multi]).toEqual([['d1'], ['d2'], true]);
    const r = diffSides({ ...plot, diff: { ...plot.diff, sideA: ['d1', 'd3'], sideB: ['d2', 'd3'] } }, target, null, null, {});
    expect([r.A?.datasets, r.B?.datasets, r.A?.label]).toEqual([['d1', 'd3'], ['d2'], 'Early + Late 2']);
    expect(diffSides(plot, { ...target, panels: target.panels.slice(0, 1) }, null, null, {}).blocker).toMatch(/two datasets/);
  });
  it('clusters: the reads of two clusters (from the assignments); read groups: their members', () => {
    const clusters = { ...target, panels: target.panels.slice(0, 1), rounds: [], visible: [{ cluster: 0, color: '#f00' }, { cluster: 1, color: '#00f' }], assignmentSignature: 'sig' } as never;
    const s = diffSides({ ...plot, groupBy: 'cluster', compareAB: ['p1|1', 'p1|0'] }, target, clusters, null, { p1: { r1: 0, r2: 1, r3: 1 } });
    expect([s.A?.reads, s.B?.reads, s.signature]).toEqual([{ d1: ['r2', 'r3'] }, { d1: ['r1'] }, 'sig']);
    // A target without clusters yet (the followed target switches a moment later) is a blocker, not a crash.
    expect(diffSides({ ...plot, groupBy: 'cluster' }, target, target as never, null, {}).blocker).toMatch(/needs a clustering/);
    const groups = [{ id: 'g1', title: 'Allele 1', color: '#000', members: { d1: new Set(['a']) } }, { id: 'g2', title: 'Allele 2', color: '#111', members: { d1: new Set(['b', 'c']) } }];
    const g = diffSides({ ...plot, groupBy: 'read-groups' }, target, null, groups, {}, 'gs');
    expect([g.A?.label, g.B?.reads]).toEqual(['Allele 1', { d1: ['b', 'c'] }]);
  });
  it('the request sends each feature as state refs with its sides and settings', () => {
    const hit = { setId: 'browser:peaks:r1', hitId: 'peak:1', typeId: 'peaks.peak', chrom: 'chrT', start: 10, end: 90, anchor: 50, hasStates: true, stateSpec: { kind: 'open' }, datasets: ['d1', 'd2'], label: 'Strong' };
    const s = diffSides(plot, target, null, null, {});
    const body = diffRequestBody([hit as never], s.A!, s.B!, { ...plot.diff, densityMatch: true, replicateAware: true });
    expect(body.features[0]).toMatchObject({ key: 'browser:peaks:r1|peak:1', chrom: 'chrT', start: 10, end: 90, refs: [{ source: 'browser:peaks:r1', id: 'peak:1', hub_hit: expect.objectContaining({ hitId: 'peak:1' }) }] });
    expect(body).toMatchObject({ groups: { A: { datasets: ['d1'] }, B: { datasets: ['d2'] } }, density_match: true, replicate_aware: true, test: 'fisher', min_reads: 5 });
  });
});

describe('calls, volcano and table helpers', () => {
  it('calls up / down past both thresholds, untested without q', () => {
    expect([callOf(row('a', 0.3, 0.001), 0.05, 0.1), callOf(row('b', -0.3, 0.001), 0.05, 0.1), callOf(row('c', 0.05, 0.001), 0.05, 0.1), callOf(row('d', 0.3, 0.2), 0.05, 0.1), callOf(row('e', null, null), 0.05, 0.1)])
      .toEqual(['up', 'down', 'ns', 'ns', 'untested']);
  });
  it('caps q = 0 on the volcano, flagged', () => {
    expect(negLog10Q(0)).toEqual({ y: Q_CAP, capped: true });
    expect(negLog10Q(0.01)?.y).toBeCloseTo(2);
    expect(negLog10Q(null)).toBeNull();
  });
  it('sorts by any column, missing values last either way', () => {
    const rows = [row('a', 0.1, 0.02), row('b', -0.4, 0.001), row('c', null, null), row('d', 0.3, 0.5)];
    expect(sortDiffRows(rows, 'q', 'asc').map(r => r.key)).toEqual(['b', 'a', 'd', 'c']);
    expect(sortDiffRows(rows, 'delta', 'desc').map(r => r.key)).toEqual(['d', 'a', 'b', 'c']);
    expect(sortDiffRows(rows, 'feature', 'desc').map(r => r.key)).toEqual(['d', 'c', 'b', 'a']);
  });
  it('TSV: one row per feature with the call and intervals', () => {
    const e: DiffEntry = { key: 'k', locus: { chrom: 'chrT', start: 0, end: 10, genome: null }, rows: [row('a', 0.3, 0.001)], groups: { A: { label: 'Early', datasets: ['d1'] }, B: { label: 'Late', datasets: ['d2'] } }, test: 'fisher', density: null };
    const lines = diffTsv(e, 0.05, 0.1).split('\n');
    expect(lines[0]).toMatch(/A = Early/);
    expect(lines[1].split('\t')).toContain('frac_A(Early)');
    expect(lines[2].split('\t').slice(-2)).toEqual(['up', '']);
  });
  it('picks the nearest point within the radius', () => {
    const pts = [{ key: 'a', x: 10, y: 10, call: 'up' as const }, { key: 'b', x: 30, y: 10, call: 'ns' as const }];
    expect(nearestPoint(pts, 12, 11)?.key).toBe('a');
    expect(nearestPoint(pts, 20, 30)).toBeNull();
  });
});

describe('the view', () => {
  let container: HTMLDivElement;
  let root: Root;
  const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const flush = async (ms = 200) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
  const hits = [0, 1, 2].map(i => ({ setId: 'browser:peaks:r1', hitId: `peak:${i}`, typeId: 'peaks.peak', chrom: 'chrT', start: 1000 * i, end: 1000 * i + 100, anchor: 1000 * i + 50,
    hasStates: true, stateSpec: { kind: 'open' }, datasets: ['d1', 'd2'], label: `P${i}` }));
  const rows = [row('browser:peaks:r1|peak:0', 0.4, 1e-6, { start: 0, end: 100 }), row('browser:peaks:r1|peak:1', -0.35, 1e-4, { start: 1000, end: 1100 }), row('browser:peaks:r1|peak:2', 0.02, 0.8, { start: 2000, end: 2100 })];

  beforeEach(() => {
    vi.useFakeTimers();
    api.fetchJson.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({ featureHub: { ...useBrowserStore.getState().featureHub, selected: hits } } as never);
    useWorkspaceStore.setState({ view: 'plots' });
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

  const plot = { ...newPlot({ type: 'differential' }), diff: { ...normalizeDiffSettings({}), features: 'hub-selection' as const } };

  it('draws a planted result: calls counted, table sortable, a point/locus click moves, selection to the hub', async () => {
    api.fetchJson.mockResolvedValue({ success: true, rows, groups: { A: { label: 'Early', datasets: ['d1'] }, B: { label: 'Late', datasets: ['d2'] } }, test: 'fisher', density: null });
    const onLocus = vi.fn();
    const onResult = vi.fn();
    act(() => { root.render(<DifferentialPlot plot={plot} target={target} clusters={null} pending={false} width={700} settingsKey="[1]" onChange={() => {}} onLocus={onLocus} onResult={onResult} />); });
    await flush();
    const view = q('plots-diff-plot')!;
    expect(view.getAttribute('data-state')).toBe('current');
    expect([view.getAttribute('data-features'), view.getAttribute('data-tested'), view.getAttribute('data-up'), view.getAttribute('data-down')]).toEqual(['3', '3', '1', '1']);
    const body = JSON.parse(api.fetchJson.mock.calls[0][1].body);
    expect(body.features.map((f: { key: string }) => f.key)).toEqual(rows.map(r => r.key));
    expect(onResult).toHaveBeenCalledTimes(1);
    const keys = () => [...container.querySelectorAll('[data-testid="plots-diff-row"]')].map(r => r.getAttribute('data-call'));
    expect(keys()).toEqual(['up', 'down', 'ns']);  // by q
    act(() => { (q('plots-diff-sort-delta') as HTMLButtonElement).click(); });
    expect(keys()).toEqual(['up', 'ns', 'down']);
    act(() => { (container.querySelectorAll('[data-testid="plots-diff-goto"]')[0] as HTMLButtonElement).click(); });
    expect(onLocus).toHaveBeenCalledWith('chrT', 0, 100);
    act(() => { (q('plots-diff-select-called') as HTMLButtonElement).click(); });
    act(() => { (q('plots-diff-to-hub') as HTMLButtonElement).click(); });
    await flush(10);
    expect(useBrowserStore.getState().featureHub.selected.map((h: { hitId: string }) => h.hitId)).toEqual(['peak:0', 'peak:1']);
    expect(useWorkspaceStore.getState().view).toBe('hub');
  });

  it('a stored result (Gallery) draws without a request', async () => {
    const s = { ...newPlot({ type: 'differential' }), diff: plot.diff };
    api.fetchJson.mockImplementation(() => new Promise(() => {}));
    act(() => { root.render(<DifferentialPlot plot={s} target={target} clusters={null} pending={false} width={700} settingsKey="[1]" onChange={() => {}} onLocus={() => {}} />); });
    await flush();
    expect(api.fetchJson).toHaveBeenCalledTimes(1);
    // The request key the hook wants, from a first render; a seed with that key answers it.
    const { diffRequestKey, diffSides: sidesOf, diffCandidates } = await import('./differentialData');
    const feats = diffCandidates('hub-selection', target, 500);
    const want = diffRequestKey(s, target, feats, sidesOf(s, target, null, null, {}), '[1]');
    api.fetchJson.mockReset();
    act(() => { root.unmount(); });
    root = createRoot(container);
    // Recorded under an older refresh generation: still answers the request.
    const old = JSON.stringify({ ...JSON.parse(want), settingsKey: JSON.stringify([0]) });
    const seed: DiffEntry = { key: old, locus: { chrom: 'chrT', start: 0, end: 5000, genome: null }, rows, groups: { A: { label: 'Early', datasets: ['d1'] }, B: { label: 'Late', datasets: ['d2'] } }, test: 'fisher', density: null, seeded: true };
    act(() => { root.render(<DifferentialPlot plot={s} target={target} clusters={null} pending={false} width={700} settingsKey="[1]" seed={seed} onChange={() => {}} onLocus={() => {}} />); });
    await flush();
    expect(api.fetchJson).not.toHaveBeenCalled();
    expect(q('plots-diff-plot')!.getAttribute('data-seeded')).toBe('true');
    expect(container.querySelectorAll('[data-testid="plots-diff-row"]')).toHaveLength(3);
  });
});

describe('default sides', () => {
  it('pick the first two datasets that share no reads (two halves, not a dataset and its half)', async () => {
    const { disjointPair } = await import('./differentialData');
    const reads = { d1: ['a', 'b', 'c', 'd'], d2: ['a', 'b'], d3: ['c', 'd'] };
    expect(disjointPair(['d1', 'd2', 'd3'], reads)).toEqual(['d2', 'd3']);
    expect(disjointPair(['d1', 'd2'], reads)).toBeNull();
    const s = diffSides(newPlot({ type: 'differential' }), target, null, null, {}, '', reads);
    expect([s.A?.datasets, s.B?.datasets]).toEqual([['d2'], ['d3']]);
    // Unknown reads: the first two; chosen sides win over the default.
    expect(diffSides(newPlot({ type: 'differential' }), target, null, null, {}, '', {}).A?.datasets).toEqual(['d1']);
    const chosen = newPlot({ type: 'differential' });
    expect(diffSides({ ...chosen, diff: { ...chosen.diff, sideA: ['d1'], sideB: ['d2'] } }, target, null, null, {}, '', reads).B?.datasets).toEqual(['d2']);
  });
});

describe('behind the hub flag', () => {
  it('flag off: nothing is computed and the plot says it waits for the Feature hub', async () => {
    setHubWorkspaceEnabled(false, false);
    vi.useFakeTimers();
    api.fetchJson.mockReset();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => { root.render(<DifferentialPlot plot={newPlot({ type: 'differential' })} target={target} clusters={null} pending={false} width={700} settingsKey="[1]" onChange={() => {}} onLocus={() => {}} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(container.querySelector('[data-testid="plots-diff-waiting"]')?.textContent).toContain('waits for the Feature hub');
    expect(api.fetchJson).not.toHaveBeenCalled();
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    setHubWorkspaceEnabled(true, false);
  });
});

describe('no features', () => {
  it('each empty kind offers the step that makes its features, as a button (no "run X first" text)', async () => {
    vi.useFakeTimers();
    api.fetchJson.mockReset();
    useBrowserStore.setState({ peakRules: [], peaksByRule: {} } as never);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const want: Record<string, string[]> = { peaks: ['peaks'], classes: ['classes'], geometries: ['geometries'], all: ['peaks', 'classes', 'geometries'] };
    for (const [features, kinds] of Object.entries(want)) {
      const plot = { ...newPlot({ type: 'differential' }), diff: { ...normalizeDiffSettings({}), features: features as never } };
      act(() => { root.render(<DifferentialPlot plot={plot} target={target} clusters={null} pending={false} width={700} settingsKey="[1]" onChange={() => {}} onLocus={() => {}} />); });
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      const empty = container.querySelector('[data-testid="plots-diff-empty"]')!;
      expect(empty.textContent, features).not.toMatch(/first/);
      expect([...empty.querySelectorAll('[data-testid^="plots-prereq-run-"]')].map(b => b.getAttribute('data-testid')!.replace('plots-prereq-run-', '')), features).toEqual(kinds);
    }
    // Compare by cluster without a clustering: Cluster reads.
    act(() => { root.render(<DifferentialPlot plot={{ ...newPlot({ type: 'differential' }), groupBy: 'cluster' }} target={target} clusters={null} pending={false} width={700} settingsKey="[1]" onChange={() => {}} onLocus={() => {}} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(container.querySelector('[data-testid="plots-diff-blocker"] [data-testid="plots-prereq-run-cluster"]')).not.toBeNull();
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('says there are no peaks, with a Scan button', async () => {
    vi.useFakeTimers();
    api.fetchJson.mockReset();
    useBrowserStore.setState({ peakRules: [], peaksByRule: {} } as never);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => { root.render(<DifferentialPlot plot={newPlot({ type: 'differential' })} target={target} clusters={null} pending={false} width={700} settingsKey="[1]" onChange={() => {}} onLocus={() => {}} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    const empty = container.querySelector('[data-testid="plots-diff-empty"]')!;
    expect(empty.textContent).toContain('No peaks in this view');
    expect(container.querySelector('[data-testid="plots-diff-scan"]')).not.toBeNull();
    expect(api.fetchJson).not.toHaveBeenCalled();
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });
});
