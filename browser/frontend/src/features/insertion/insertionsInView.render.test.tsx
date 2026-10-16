import '../testSetup';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { resetSharedRequests } from '../../api/sharedRequest';
import { INSERTIONS_SETTLE_MS, InsertionLensPanel } from './InsertionLensPanel';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// "Insertions in view" follows the view without stampeding the server: asked
// once the view settles, a view left behind aborts its request, a listed view
// is not asked again, and nothing is asked while the Lens tab is shown.
describe('insertions in view requests', () => {
  let container: HTMLDivElement;
  let root: Root;
  let calls: { url: URL; signal?: AbortSignal | null }[];

  beforeEach(() => {
    vi.useFakeTimers();
    resetSharedRequests();
    calls = [];
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url: new URL(url, 'http://x'), signal: init?.signal });
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        setTimeout(() => resolve(new Response(JSON.stringify({ success: true, clusters: [] }), { status: 200 })), 1000);
      });
    }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({
      chrom: 'chr1', start: 10_000, end: 20_000,
      datasets: [{ id: 'bam1', data_type: 'bam' }], readTrackStatus: {},
      signalFilters: {},
    } as any);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetSharedRequests();
  });

  const clusterCalls = () => calls.filter(c => c.url.pathname === '/api/insertions/clusters');
  const pan = (start: number) => act(() => { useBrowserStore.setState({ start, end: start + 10_000 } as any); });
  const openList = async () => {
    const tab = container.querySelector<HTMLButtonElement>('[data-analysis-tab="insertions"]')!;
    await act(async () => { tab.click(); });
  };

  it('asks nothing on the Lens tab, and once per settled view on the list', async () => {
    await act(async () => { root.render(<InsertionLensPanel />); });
    pan(11_000);
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(clusterCalls()).toHaveLength(0);

    await openList();
    for (let i = 1; i <= 5; i++) {
      pan(11_000 + i * 500);
      await act(async () => { vi.advanceTimersByTime(INSERTIONS_SETTLE_MS - 50); });
    }
    expect(clusterCalls()).toHaveLength(0);
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(clusterCalls()).toHaveLength(1);
    expect(clusterCalls()[0].url.searchParams.get('start')).toBe('13500');
  });

  it('a view left while listing aborts its request; going back asks nothing', async () => {
    await act(async () => { root.render(<InsertionLensPanel />); });
    await openList();
    await act(async () => { vi.advanceTimersByTime(INSERTIONS_SETTLE_MS); });
    expect(clusterCalls()).toHaveLength(1);
    pan(50_000);
    expect(clusterCalls()[0].signal?.aborted).toBe(true);
    await act(async () => { vi.advanceTimersByTime(INSERTIONS_SETTLE_MS + 1000); });
    expect(clusterCalls()).toHaveLength(2);
    pan(60_000);
    await act(async () => { vi.advanceTimersByTime(INSERTIONS_SETTLE_MS + 1000); });
    pan(50_000);
    await act(async () => { vi.advanceTimersByTime(INSERTIONS_SETTLE_MS + 1000); });
    expect(clusterCalls()).toHaveLength(3);
    expect(container.textContent).not.toContain('Could not list');
  });

  it('refetches the open lens when the signal cohort changes', async () => {
    useBrowserStore.setState({ panels: [{ id: 'lens', contentType: 'insertion-lens',
      insertionLens: { datasetId: 'bam1', chrom: 'chr1', pos: 12000, lenMin: 20, flank: 500 } }] } as any);
    // Keep both requests pending; changing the filter must invalidate the first.
    await act(async () => { root.render(<InsertionLensPanel />); });
    const lensCalls = () => calls.filter(c => c.url.pathname === '/api/insertions/lens');
    expect(lensCalls()).toHaveLength(1);
    await act(async () => { useBrowserStore.getState().setSignalFilters({ hideBackground: true }); });
    expect(lensCalls()).toHaveLength(2);
    expect(JSON.parse(lensCalls()[1].url.searchParams.get('signal_filters')!)).toMatchObject({ hideBackground: true });
  });
});
