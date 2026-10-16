import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetchClusterProjection: vi.fn(),
  fetchClusterVPlot: vi.fn(),
}));
vi.mock('../../api/clustering', async (orig) => ({ ...(await orig<typeof import('../../api/clustering')>()), ...api }));

import { useBrowserStore } from '../../stores/browserStore';
import { useReadActionsStore } from '../../stores/readActionsStore';
import { ClusterDetailPanel } from './ClusterDetailPanel';
import type { PanelConfig } from '../../types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * fb-n5-projection: the read map is part of Clusters › Overview (not a Charts
 * sub-tab), and clicking it focuses clusters exactly as the cluster list
 * does: a click focuses the dot's cluster in every clustered panel, ⇧-click
 * adds one, the legend does the same from the keyboard, ⌘-click outlines the
 * read in every panel.
 */

// jsdom has no canvas: record where the dots are drawn (arc calls of radius 3).
const arcs = new Map<HTMLCanvasElement, Array<[number, number, number]>>();
function fakeContext(canvas: HTMLCanvasElement) {
  return new Proxy({} as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop === 'canvas') return canvas;
      if (prop === 'arc') return (x: number, y: number, r: number) => { arcs.get(canvas)!.push([x, y, r]); };
      if (prop === 'clearRect') return () => { arcs.set(canvas, []); };
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop in target) return target[prop];
      return () => undefined;
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
}
const dots = (canvas: HTMLCanvasElement) => (arcs.get(canvas) ?? []).filter(([, , r]) => r === 3);

const ds = (id: string) => ({ id, label: id, path: `/d/${id}.bam`, color: '#000', data_type: 'bam' });
const panel = (id: string, datasetId: string, over: Partial<PanelConfig> = {}) =>
  ({ id, contentType: 'dataset', datasetId, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...over }) as PanelConfig;
const projection = {
  coords_x: [0, 0.1, 5, 10], coords_y: [0, 0.2, 5, 10], read_ids: ['r1', 'r2', 'r3', 'r4'], dataset_ids: ['napa', 'napa', 'napa', 'napa'],
  labels_before: [0, 0, 1, 2], labels_after: null, cluster_centroids_before: {}, cluster_centroids_after: null, dissolved: [],
  method: 'tsne', variance_explained: null, feature_dim: 2, n_reads: 4,
  strands: ['CT', 'GA', '', ''], alignment_strands: ['+', '-', '+', '+'],
};

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* none */ }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    if (!arcs.has(this)) arcs.set(this, []);
    return fakeContext(this) as never;
  });
  api.fetchClusterProjection.mockReset().mockResolvedValue(projection);
  api.fetchClusterVPlot.mockReset().mockResolvedValue({ success: true, data: {} });
  useReadActionsStore.getState().reset();
  useBrowserStore.setState({
    chrom: 'chr19', start: 47_514_037, end: 47_518_985,
    navigationMode: 'linked', selectedDatasets: new Set(),
    datasets: [ds('napa')] as never,
    panels: [panel('p1', 'napa')],
    clusterAssignments: { napa: { r1: 0, r2: 0, r3: 1, r4: 2 } },
    clusterOrder: { napa: [0, 1, 2] },
    clusterFocus: {},
    selectedClusters: {},
    clusterMergeLog: null,
    clusterPeakRegions: [{ start: 47_515_000, end: 47_515_200, mode: 'accessibility' }],
  } as never);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

async function openMap() {
  positions = [];
  await act(async () => { root.render(<ClusterDetailPanel />); });
  await act(async () => { window.dispatchEvent(new CustomEvent('fiberbrowser:open-cluster-detail-tab', { detail: { tab: 'projection' } })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(600); });
  const el = host.querySelector('[data-testid="projection-map-canvas"]') as HTMLCanvasElement | null;
  if (el) positions = dots(el);
}

function canvas(): HTMLCanvasElement {
  const el = host.querySelector('[data-testid="projection-map-canvas"]') as HTMLCanvasElement | null;
  expect(el).not.toBeNull();
  return el!;
}

// Where each read's dot is: taken before any focus (focused dots are drawn last).
let positions: Array<[number, number, number]> = [];
async function clickDot(index: number, init: MouseEventInit = {}) {
  if (positions.length === 0) positions = dots(canvas());
  const [x, y] = positions[index];
  await act(async () => { canvas().dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y, ...init })); });
}

const focus = () => {
  const f = useBrowserStore.getState().clusterFocus.napa;
  return f ? [...f].sort() : null;
};

describe('Clusters › Overview read map', () => {
  it('is in Overview (Profiles | Map), not a Charts sub-tab', async () => {
    await openMap();
    expect(api.fetchClusterProjection).toHaveBeenCalledTimes(1);
    const mode = host.querySelector('[data-testid="cluster-overview-mode"]')!;
    expect(mode.textContent).toContain('Profiles');
    expect(mode.textContent).toContain('Map');
    expect(host.querySelector('[data-testid="projection-map"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="projection-summary"]')?.textContent).toContain('t-SNE');

    // Charts: Profiles, Composition, V-Plot (no Projection).
    const charts = [...host.querySelectorAll('button')].find(b => b.textContent === 'Charts')!;
    await act(async () => { charts.click(); });
    expect([...host.querySelectorAll('button')].some(b => b.textContent === 'Projection')).toBe(false);
    expect(host.querySelector('[data-testid="projection-map"]')).toBeNull();
  });

  it('a click on a dot focuses its cluster; ⇧-click adds; a second click clears', async () => {
    await openMap();
    expect(dots(canvas())).toHaveLength(4);
    const steps = () => useBrowserStore.getState()._historyStack.length;
    const before = steps();
    await clickDot(2);
    expect(focus()).toEqual([1]);
    // One undo step per click (not one per panel plus one).
    expect(steps() - before).toBeLessThanOrEqual(2); // a baseline, then the step
    const afterFirst = steps();
    expect(host.querySelector('[data-testid="projection-focus-status"]')?.textContent).toContain('C1 focused');
    await clickDot(3, { shiftKey: true });
    expect(focus()).toEqual([1, 2]);
    expect(steps()).toBe(afterFirst + 1);
    // (A restore may redraw the map: settle before clicking again.)
    await act(async () => { useBrowserStore.getState().undo(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(focus()).toEqual([1]);
    await act(async () => { useBrowserStore.getState().redo(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(focus()).toEqual([1, 2]);
    await clickDot(0);
    expect(focus()).toEqual([0]);
    await clickDot(1); // the same cluster again: show all
    expect(focus()).toBeNull();
    // The focus is the store's (read panel, charts, undo): one step per click.
    expect(useBrowserStore.getState()._historyStack.some(s => s.label === 'Focus C1')).toBe(true);
  });

  it('the legend focuses clusters from the keyboard; ⌘-click shows the read', async () => {
    await openMap();
    const legend = (c: number) => host.querySelector(`[data-testid="projection-legend-${c}"]`) as HTMLButtonElement;
    await act(async () => { legend(2).click(); });
    expect(focus()).toEqual([2]);
    expect(legend(2).getAttribute('aria-pressed')).toBe('true');
    await act(async () => { legend(0).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })); });
    expect(focus()).toEqual([0, 2]);

    await clickDot(1, { metaKey: true });
    expect([...(useReadActionsStore.getState().highlight?.ids ?? [])]).toEqual(['r2']);
    // The picked read can be shown again from a button (keyboard).
    useReadActionsStore.getState().clearHighlight();
    const show = host.querySelector('[data-testid="projection-show-read"]') as HTMLButtonElement;
    await act(async () => { show.click(); });
    expect([...(useReadActionsStore.getState().highlight?.ids ?? [])]).toEqual(['r2']);
  });

  it('hovering a dot names the read, its cluster, dataset and strand', async () => {
    await openMap();
    const [x, y] = dots(canvas())[0];
    await act(async () => { canvas().dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y })); });
    const tip = host.querySelector('[data-testid="projection-map-tooltip"]');
    expect(tip?.textContent).toContain('r1');
    expect(tip?.textContent).toContain('C0');
    expect(tip?.textContent).toContain('napa');
    expect(tip?.textContent).toContain('CT strand');
  });

  it('the keyboard steps across the dots and Enter focuses the cluster', async () => {
    await openMap();
    const el = canvas();
    expect(el.tabIndex).toBe(0);
    await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    expect(host.querySelector('[data-testid="projection-map-tooltip"]')).not.toBeNull();
    await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(focus()).not.toBeNull();
    expect(host.querySelector('[data-testid="projection-picked-read"]')).not.toBeNull();
  });

  it('Unmerge / Merge again from the map switch the clustering the panels show', async () => {
    useBrowserStore.setState({ selectedClusters: { napa: new Set([1, 2]) } } as never);
    useBrowserStore.getState().mergeSelectedClusters(['napa']);
    await openMap();
    const chip = () => host.querySelector('[data-testid="cluster-merge-chip"]');
    expect(chip()?.textContent).toContain('Merged: 3 → 2 clusters');
    await act(async () => { (host.querySelector('[data-testid="cluster-merge-toggle"]') as HTMLButtonElement).click(); });
    expect(useBrowserStore.getState().clusterAssignments.napa).toEqual({ r1: 0, r2: 0, r3: 1, r4: 2 });
    expect(chip()?.getAttribute('data-merge-state')).toBe('original');
    await act(async () => { (host.querySelector('[data-testid="cluster-merge-toggle"]') as HTMLButtonElement).click(); });
    expect(new Set(Object.values(useBrowserStore.getState().clusterAssignments.napa))).toEqual(new Set([0, 1]));
    expect(chip()?.getAttribute('data-merge-state')).toBe('merged');
  });
});
