import React, { act, useRef } from 'react';
import { useNativeWheel } from '../../../hooks/useNativeWheel';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { PanelDisplayContext } from '../../../hooks/usePanelDisplayStore';
import { WHEEL_SETTLE_MS } from '../../../hooks/useWheelZoom';
import { useReadTrackMouse } from './useReadTrackMouse';
import { LinearWheelSurface } from '../LinearWheelSurface';
import type { PanelConfig } from '../../../types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const initial = useBrowserStore.getState();
const panel = (id: string, own = false): PanelConfig => ({ id, contentType: 'dataset', datasetId: id,
  subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0,
  ...(own ? { viewportOverride: { chrom: 'chr1', start: 10000, end: 20000 } } : {}),
});
let host: HTMLDivElement;
let root: Root;
let zoomPath: ReturnType<typeof vi.spyOn>;

function Reads({ id, count = 100 }: { id: string; count?: number }) {
  const s = useBrowserStore();
  const view = s.panels.find(p => p.id === id)?.viewportOverride ?? s;
  const handlers = useReadTrackMouse({ displayReads: Array.from({ length: count }, (_, i) => ({ id: `r${i}`, intervals: [] })) as never,
    width: 1000, height: 200, sidebarWidth: 100, regionWidth: view.end - view.start,
    chrom: view.chrom, start: view.start, end: view.end, datasetId: id, stateKey: id,
    hasCluster: false, myClusterAssignments: {}, myClusterOrder: [], myClusterFocus: null, mySelectedClusters: null,
    hasClusterFocus: false, isPanning: false, isReversed: s.isReversed, fillReadHeight: s.fillReadHeight,
    storeReadRowHeight: s.readRowHeight, readScrollOffset: s.readScrollOffsets[id] ?? 0,
    readSeparatorMode: 'off', readSeparatorMinHeight: 3, readSeparatorWidth: 1,
    showReadTooltip: false, showCoverageHistogram: false,
  });
  const ref = useRef<HTMLCanvasElement>(null);
  useNativeWheel(ref, handlers.handleWheel);
  return <canvas ref={ref} data-testid={id} width={1000} height={200} />;
}
function render(count = 100, own = false) {
  useBrowserStore.setState({ panels: [panel('a', own), panel('b', own)] });
  act(() => root.render(<>{['a', 'b'].map(id => <div key={id} data-panel-id={id}>
    <PanelDisplayContext.Provider value={id}><Reads id={id} count={id === 'a' ? count : count * 2} /></PanelDisplayContext.Provider>
  </div>)}</>));
}
function wheel(id: string, options: WheelEventInit) {
  const event = new WheelEvent('wheel', { clientX: 325, deltaY: -20, bubbles: true, cancelable: true, ...options });
  act(() => host.querySelector(`[data-testid="${id}"]`)!.dispatchEvent(event));
  if (options.ctrlKey || options.metaKey || options.shiftKey) expect(event.defaultPrevented).toBe(true);
}
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1000, height: 200 } as DOMRect);
  useBrowserStore.setState({ chrom: 'chr1', start: 10000, end: 20000, chroms: [{ name: 'chr1', size: 1000000 }],
    readRowHeight: 5, fillReadHeight: false, readScrollOffsets: {}, navigationMode: 'linked', isReversed: false,
    datasets: [], _historyStack: [], _historyPointer: -1, _lastRestoreTime: 0, _historyPaused: false });
  zoomPath = vi.spyOn(useBrowserStore.getState(), 'setViewport');
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks();
  useBrowserStore.setState(initial, true);
});

describe('linear read wheel navigation', () => {
  it.each(['metaKey', 'ctrlKey'])('%s-wheel zooms the genomic window around the pointer, even without reads', async modifier => {
    render(0);
    wheel('a', { [modifier]: true });
    await advance(20);
    expect((host.querySelector('[data-testid="a"]') as HTMLCanvasElement).style.transform).toContain('scaleX');
    expect((host.querySelector('[data-testid="b"]') as HTMLCanvasElement).style.transform).toContain('scaleX');
    expect(zoomPath).not.toHaveBeenCalled();
    await advance(WHEEL_SETTLE_MS);
    expect(zoomPath).toHaveBeenCalledTimes(1);
    const s = useBrowserStore.getState();
    expect(s.end - s.start).toBeLessThan(10000);
    // x=325, gutter=100: 25% of the genomic drawing is under the pointer.
    expect(s.start + 0.25 * (s.end - s.start)).toBeCloseTo(12500, 0);
    expect(s.readRowHeight).toBe(5);
  });

  it('one burst commits once and creates one undo step; a later burst is separate', async () => {
    render();
    for (let i = 0; i < 12; i++) { wheel('a', { ctrlKey: true, deltaY: -0.25 }); await advance(10); }
    expect(zoomPath).not.toHaveBeenCalled();
    await advance(WHEEL_SETTLE_MS);
    expect(zoomPath).toHaveBeenCalledTimes(1);
    const s = useBrowserStore.getState();
    expect(s.end - s.start).toBeCloseTo(10000 * Math.exp(-3 * 0.002), 0);
    expect(s._historyStack).toHaveLength(2); // before + after
    wheel('a', { ctrlKey: true }); await advance(WHEEL_SETTLE_MS);
    expect(useBrowserStore.getState()._historyStack).toHaveLength(3);
    act(() => useBrowserStore.getState().undo());
    expect(useBrowserStore.getState().start).toBe(s.start);
    expect(useBrowserStore.getState().end).toBe(s.end);
  });

  it.each([{ deltaY: -10 }, { deltaY: 0, deltaX: -10 }])('Shift-wheel shares smooth height across panels (%j)', async delta => {
    render();
    wheel('b', { shiftKey: true, ...delta }); await advance(20);
    expect(useBrowserStore.getState().readRowHeight).toBeCloseTo(5 * Math.exp(0.02));
    // A gesture on the other panel starts at the shared height, rather than its own old layout.
    wheel('a', { shiftKey: true, ...delta }); await advance(20);
    expect(useBrowserStore.getState().readRowHeight).toBeCloseTo(5 * Math.exp(0.04));
    expect(zoomPath).not.toHaveBeenCalled();
    expect(useBrowserStore.getState().fillReadHeight).toBe(false);
  });

  it('small Shift-wheel deltas accumulate within one frame and start at the rendered fit height', async () => {
    render();
    act(() => useBrowserStore.setState({ readRowHeight: 'auto', fillReadHeight: true }));
    for (let i = 0; i < 20; i++) wheel('a', { shiftKey: true, deltaY: -0.1 });
    await advance(20);
    expect(useBrowserStore.getState().readRowHeight).toBeCloseTo(2 * Math.exp(0.004));
  });

  it('plain wheel scrolls rows without zooming', async () => {
    render(); wheel('a', { deltaY: 50 }); await advance(500);
    expect(useBrowserStore.getState().readScrollOffsets.a).toBe(50);
    expect(zoomPath).not.toHaveBeenCalled();
    expect(useBrowserStore.getState().readRowHeight).toBe(5);
  });

  it('uses the panel navigation path for an independent panel', async () => {
    render(100, true);
    wheel('b', { ctrlKey: true }); await advance(WHEEL_SETTLE_MS);
    expect(useBrowserStore.getState().panels[1].viewportOverride!.end - useBrowserStore.getState().panels[1].viewportOverride!.start).toBeLessThan(10000);
    expect(useBrowserStore.getState().panels[0].viewportOverride).toEqual({ chrom: 'chr1', start: 10000, end: 20000 });
    expect(zoomPath).not.toHaveBeenCalled();
    expect(useBrowserStore.getState()._historyStack).toHaveLength(2);
    wheel('b', { ctrlKey: true }); await advance(WHEEL_SETTLE_MS);
    expect(useBrowserStore.getState()._historyStack).toHaveLength(3);
  });

  it('mirrors the pointer anchor in a reversed panel', async () => {
    render(); act(() => useBrowserStore.setState({ isReversed: true }));
    wheel('a', { ctrlKey: true }); await advance(WHEEL_SETTLE_MS);
    const s = useBrowserStore.getState();
    expect(s.start + 0.75 * (s.end - s.start)).toBeCloseTo(17500, 0);
  });

  it('cancels pending navigation and clears previews on unmount', async () => {
    render(); wheel('a', { ctrlKey: true }); await advance(20);
    const canvas = host.querySelector('canvas')!;
    act(() => root.render(null)); await advance(500);
    expect(canvas.style.transform).toBe('');
    expect(zoomPath).not.toHaveBeenCalled();
  });

  it('cancels a stale burst when another navigation changes the view', async () => {
    render(); wheel('a', { ctrlKey: true }); await advance(20);
    act(() => useBrowserStore.getState().setViewport('chr1', 30000, 40000));
    await advance(500);
    expect(zoomPath).toHaveBeenCalledTimes(1);
    expect(useBrowserStore.getState().start).toBe(30000);
  });
});

it('axis and other linear tracks use anchored wheel zoom through the same navigation path', async () => {
  act(() => root.render(<LinearWheelSurface view={{ chrom: 'chr1', start: 10000, end: 20000 }} width={1000}>
    <canvas data-testid="axis" width={1000} />
  </LinearWheelSurface>));
  wheel('axis', { ctrlKey: true, clientX: 250 }); await advance(WHEEL_SETTLE_MS);
  expect(zoomPath).toHaveBeenCalledTimes(1);
  const s = useBrowserStore.getState();
  expect(s.start + 0.25 * (s.end - s.start)).toBeCloseTo(12500, 0);
});
