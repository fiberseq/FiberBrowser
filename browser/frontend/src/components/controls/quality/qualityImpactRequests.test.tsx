import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { resetSharedRequests } from '../../../api/sharedRequest';
import { ToolbarSummaryShown } from '../ToolbarGroups';
import { QUALITY_IMPACT_SETTLE_MS, QualitySummary, useQualityImpact } from './QualityQuickControls';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const FIRE = { layer: 'fire', qualityName: 'aq', minValue: 230, enabled: true };

function Counter() {
  const { impact } = useQualityImpact();
  return <span data-testid="impact">{impact ? impact.filters.length : '-'}</span>;
}

// Navigation must not stampede /api/quality/impact: the count waits for the
// view to settle, one request serves every control, a view left behind aborts
// its request, a view counted before asks nothing, and a summary folded away asks nothing.
describe('quality impact requests', () => {
  let container: HTMLDivElement;
  let root: Root;
  let calls: { body: any; signal?: AbortSignal | null }[];

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    resetSharedRequests();
    calls = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body ?? '{}')), signal: init?.signal });
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        setTimeout(() => resolve(new Response(JSON.stringify({ success: true, filters: [{ layer: 'fire' }], available: {} }), { status: 200 })), 1000);
      });
    }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({
      chrom: 'chr1', start: 1000, end: 2000, maxRegionForReads: 1_000_000, refreshGeneration: 0, readTrackStatus: {},
      datasets: [{ id: 'ds1', available_layers: { fire: true } }],
      activeColormap: { ...useBrowserStore.getState().activeColormap, qualityFilters: [FIRE] },
    } as any);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetSharedRequests();
  });

  const pan = (start: number) => act(() => { useBrowserStore.setState({ start, end: start + 1000 } as any); });

  it('panning asks nothing until the view settles, then once for the settled view', async () => {
    await act(async () => { root.render(<><Counter /><Counter /></>); });
    for (let i = 1; i <= 5; i++) {
      pan(1000 + i * 100);
      await act(async () => { vi.advanceTimersByTime(QUALITY_IMPACT_SETTLE_MS - 50); });
    }
    expect(calls).toHaveLength(0);
    await act(async () => { vi.advanceTimersByTime(100); });
    // Two mounted controls, one request.
    expect(calls).toHaveLength(1);
    expect(calls[0].body.start).toBe(1500);
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(container.querySelectorAll('[data-testid="impact"]')[0].textContent).toBe('1');
  });

  it('a view left while counting aborts its request, and its answer is never shown', async () => {
    await act(async () => { root.render(<Counter />); });
    await act(async () => { vi.advanceTimersByTime(QUALITY_IMPACT_SETTLE_MS); });
    expect(calls).toHaveLength(1);
    pan(5000);
    expect(calls[0].signal?.aborted).toBe(true);
    expect(container.textContent).toBe('-');
    await act(async () => { vi.advanceTimersByTime(QUALITY_IMPACT_SETTLE_MS + 1000); });
    expect(calls).toHaveLength(2);
    expect(calls[1].body.start).toBe(5000);
    expect(container.textContent).toBe('1');
  });

  it('going back to a counted view sends nothing', async () => {
    await act(async () => { root.render(<Counter />); });
    await act(async () => { vi.advanceTimersByTime(QUALITY_IMPACT_SETTLE_MS + 1000); });
    pan(5000);
    await act(async () => { vi.advanceTimersByTime(QUALITY_IMPACT_SETTLE_MS + 1000); });
    expect(calls).toHaveLength(2);
    pan(1000);
    await act(async () => { vi.advanceTimersByTime(QUALITY_IMPACT_SETTLE_MS + 1000); });
    expect(calls).toHaveLength(2);
    expect(container.textContent).toBe('1');
  });

  it('waits for the view\'s reads to arrive', async () => {
    const status = (loading: boolean) => ({ ds1: { datasetId: 'ds1', chrom: 'chr1', start: 1000, end: 2000, loading, stale: false } });
    act(() => { useBrowserStore.setState({ readTrackStatus: status(true) } as any); });
    await act(async () => { root.render(<Counter />); });
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(calls).toHaveLength(0);
    act(() => { useBrowserStore.setState({ readTrackStatus: status(false) } as any); });
    await act(async () => { vi.advanceTimersByTime(QUALITY_IMPACT_SETTLE_MS); });
    expect(calls).toHaveLength(1);
  });

  it('a data refresh is a new question (its revision goes to the server)', async () => {
    await act(async () => { root.render(<Counter />); });
    await act(async () => { vi.advanceTimersByTime(QUALITY_IMPACT_SETTLE_MS + 1000); });
    act(() => { useBrowserStore.setState({ refreshGeneration: 1 } as any); });
    await act(async () => { vi.advanceTimersByTime(QUALITY_IMPACT_SETTLE_MS + 1000); });
    expect(calls).toHaveLength(2);
    expect(calls[1].body.revision).toMatch(/^1\|/);
  });

  it('the toolbar summary asks nothing while it is folded away (outside a shown group it does)', async () => {
    await act(async () => { root.render(<ToolbarSummaryShown value={false}><QualitySummary /></ToolbarSummaryShown>); });
    await act(async () => { vi.advanceTimersByTime(QUALITY_IMPACT_SETTLE_MS + 1000); });
    expect(calls).toHaveLength(0);
    await act(async () => { root.render(<ToolbarSummaryShown value><QualitySummary /></ToolbarSummaryShown>); });
    await act(async () => { vi.advanceTimersByTime(QUALITY_IMPACT_SETTLE_MS); });
    expect(calls).toHaveLength(1);
  });
});
