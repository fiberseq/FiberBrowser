import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { usePanelLauncherStore } from '../../stores/panelLauncherStore';
import { TrackContainer } from './TrackContainer';

// Every read body counts its mounts and records the size it was given (a changed size is a new read request).
const mounts: Record<string, number> = {};
function Reads({ id, width, height, hideAxis }: { id: string; width: number; height: number; hideAxis?: boolean }) {
  useEffect(() => { mounts[id] = (mounts[id] ?? 0) + 1; }, [id]);
  return <div data-testid={`reads-${id}`} data-size={`${width}x${height}`} data-hide-axis={hideAxis ? 'true' : 'false'} />;
}
vi.mock('./SubTrackDispatch', () => ({
  useSubTrackDispatch: () => ({
    calcFixedHeight: () => 88,
    renderSubTrack: (track: { type: string }, _i: number, panel: { id: string }, width: number, height: number, _first?: boolean,
      layout?: { hideAxis?: boolean }) =>
      <Reads key={track.type} id={panel.id} width={width} height={height} hideAxis={layout?.hideAxis} />,
  }),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('full view keeps every panel mounted with its size, and leaving it remounts nothing', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
  usePanelLauncherStore.setState({ mode: 'rail' });
  useBrowserStore.setState({ datasets: [{ id: 'a', label: 'A', color: '#123456' }, { id: 'b', label: 'B', color: '#654321' }],
    panels: ['a', 'b'].map(id => ({ id, contentType: 'dataset', datasetId: id, collapsed: false, subTracks: [{ type: 'reads', visible: true }] })),
    chrom: 'chr1', start: 100, end: 500, peakRules: [], peaksByRule: {},
    selectedDatasets: new Set(), fullViewPanelId: null, exportInProgress: false,
  } as never);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const size = (id: string) => host.querySelector(`[data-testid="reads-${id}"]`)?.getAttribute('data-size');
  try {
    act(() => root.render(<TrackContainer />));
    expect(mounts).toEqual({ a: 1, b: 1 });
    const before = { a: size('a'), b: size('b') };
    act(() => useBrowserStore.getState().setFullViewPanel('a'));
    // the other panel is still there, hidden and inert, with the size it had
    const b = host.querySelector<HTMLElement>('[data-panel-id="b"]')!;
    expect(b).not.toBeNull();
    expect(b.style.visibility).toBe('hidden');
    expect(b.hasAttribute('inert')).toBe(true);
    expect(size('b')).toBe(before.b);
    // the maximised one covers the panel area
    const a = host.querySelector<HTMLElement>('[data-panel-id="a"]')!;
    expect(a.style.position).toBe('absolute');
    expect(a.style.visibility).toBe('visible');
    expect(size('a')).not.toBe(before.a);
    act(() => useBrowserStore.getState().setFullViewPanel(null));
    expect(mounts).toEqual({ a: 1, b: 1 });
    expect({ a: size('a'), b: size('b') }).toEqual(before);
    expect(host.querySelector('[data-full-view-hidden]')).toBeNull();
  } finally {
    act(() => root.unmount()); host.remove();
  }
});

it('a side panel in the drawer, or a panel of a collapsed row, maximises in place too', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
  usePanelLauncherStore.setState({ mode: 'rail' });
  for (const k of Object.keys(mounts)) delete mounts[k];
  useBrowserStore.setState({ datasets: [{ id: 'a', label: 'A', color: '#123456' }, { id: 'c', label: 'C', color: '#345678' }],
    panels: [
      { id: 'a', contentType: 'dataset', datasetId: 'a', collapsed: false, subTracks: [{ type: 'reads', visible: true }] },
      { id: 'side', contentType: 'nucleosomes', collapsed: false, subTracks: [], dock: 'side', layoutRow: 0 },
      { id: 'c', contentType: 'dataset', datasetId: 'c', collapsed: false, subTracks: [{ type: 'reads', visible: true }], layoutRow: 1 },
    ],
    chrom: 'chr1', start: 100, end: 500, peakRules: [], peaksByRule: {}, collapsedRows: new Set([1]),
    selectedDatasets: new Set(), fullViewPanelId: null, exportInProgress: false,
  } as never);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<TrackContainer />));
    expect(host.querySelector('[data-testid="analysis-overlay"]')).not.toBeNull();      // the side panel is in the drawer
    act(() => useBrowserStore.getState().setFullViewPanel('side'));
    const side = host.querySelector<HTMLElement>('[data-analysis-panel-id="side"]')!;
    expect(side.style.position).toBe('absolute');
    expect(side.style.visibility).toBe('visible');
    expect(side.closest('[hidden]')).toBeNull();
    // nothing between it and the container may be its containing block
    const drawer = host.querySelector<HTMLElement>('[data-testid="analysis-overlay"]')!;
    expect(drawer.style.position).toBe('static');
    expect(drawer.style.transform === '' || drawer.style.transform === 'none').toBe(true);
    expect(drawer.style.filter).toBe('none');
    expect(host.querySelector('[data-panel-id="a"]')?.hasAttribute('inert')).toBe(true);
    act(() => useBrowserStore.getState().setFullViewPanel(null));
    expect(mounts.a).toBe(1);
    // a panel of a collapsed row: its row is laid out for full view, the panel maximised
    act(() => useBrowserStore.getState().setFullViewPanel('c'));
    const c = host.querySelector<HTMLElement>('[data-panel-id="c"]')!;
    expect(c).not.toBeNull();
    expect(c.style.position).toBe('absolute');
    act(() => useBrowserStore.getState().setFullViewPanel(null));
    expect(mounts.a).toBe(1);
  } finally {
    act(() => root.unmount()); host.remove();
  }
});

it('an export in full view keeps every panel mounted (hidden ones out of the figure); a maximised lower stacked panel keeps its ruler', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
  usePanelLauncherStore.setState({ mode: 'rail' });
  for (const k of Object.keys(mounts)) delete mounts[k];
  // two dataset panels stacked in one column at the same region: the lower one's ruler repeats the upper's
  useBrowserStore.setState({ datasets: [{ id: 'a', label: 'A', color: '#123456' }, { id: 'b', label: 'B', color: '#654321' }],
    panels: ['a', 'b'].map(id => ({ id, contentType: 'dataset', datasetId: id, collapsed: false,
      subTracks: [{ type: 'axis', visible: true }, { type: 'reads', visible: true }], layoutPosition: 'column', layoutColumn: 0, layoutRow: 0 })),
    chrom: 'chr1', start: 100, end: 500, peakRules: [], peaksByRule: {}, collapsedRows: new Set(),
    selectedDatasets: new Set(), fullViewPanelId: null, exportInProgress: false,
  } as never);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<TrackContainer />));
    const lowerHidesBefore = host.querySelector('[data-testid="reads-b"]')?.getAttribute('data-hide-axis');
    expect(lowerHidesBefore).toBe('true');   // stacked: its ruler repeats the upper panel's
    act(() => useBrowserStore.getState().setFullViewPanel('b'));
    expect(host.querySelector('[data-testid="reads-b"]')?.getAttribute('data-hide-axis')).toBe('false');
    const mountsBefore = { ...mounts };
    act(() => useBrowserStore.setState({ exportInProgress: true } as never));
    expect(mounts).toEqual(mountsBefore);
    expect(host.querySelector('[data-panel-id="a"]')?.hasAttribute('data-full-view-hidden')).toBe(true);
    act(() => useBrowserStore.setState({ exportInProgress: false } as never));
    act(() => useBrowserStore.getState().setFullViewPanel(null));
    expect(mounts).toEqual(mountsBefore);
    expect(host.querySelector('[data-testid="reads-b"]')?.getAttribute('data-hide-axis')).toBe(lowerHidesBefore);
  } finally {
    act(() => root.unmount()); host.remove();
  }
});
