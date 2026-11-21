import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { usePanelLauncherStore } from '../../stores/panelLauncherStore';
import { TrackContainer } from './TrackContainer';

// The panels' bodies stand in for read tracks: a remount gives a new element (and would reload the reads).
vi.mock('./SubTrackDispatch', () => ({
  useSubTrackDispatch: () => ({
    calcFixedHeight: () => 88,
    renderSubTrack: (track: { type: string }, _index: number, panel: { id: string }, _width: number, height: number) =>
      <div key={track.type} data-testid={`reads-${panel.id}`} data-height={height} />,
  }),
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const dataset = (id: string) => ({ id, contentType: 'dataset', datasetId: id, collapsed: false, subTracks: [{ type: 'reads', visible: true }] });

it('opening and closing a panel that makes the row scroll never remounts the dataset panels', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const width = 1100;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
    ({ width, height: 700, top: 0, left: 0, right: width, bottom: 700 } as DOMRect));
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  usePanelLauncherStore.setState({ mode: 'rail' });
  useBrowserStore.setState({
    datasets: [{ id: 'a', label: 'A', color: '#123456' }, { id: 'b', label: 'B', color: '#654321' }],
    panels: [dataset('a'), dataset('b')], chrom: 'chr1', start: 100, end: 500, peakRules: [], peaksByRule: {},
    selectedDatasets: new Set(), fullViewPanelId: null, exportInProgress: false,
  } as never);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<TrackContainer />));
    const scrolls = () => host.querySelector('[data-testid="panel-row-scroll"]') !== null;
    const readsA = host.querySelector('[data-testid="reads-a"]');
    const readsB = host.querySelector('[data-testid="reads-b"]');
    expect(readsA).not.toBeNull();
    expect(scrolls()).toBe(false);

    // Two side panels beside the reads: too wide for the row, which scrolls.
    const side = (id: string, contentType: string) => ({ id, contentType, datasetId: null, collapsed: false, subTracks: [], linkGroup: null, layoutRow: 0 });
    const docked = ['panel-cluster-detail', 'panel-read-stats'];
    act(() => useBrowserStore.setState(s => ({ panels: [...s.panels, side(docked[0], 'cluster-detail'), side(docked[1], 'read-stats')] } as never)));
    expect(scrolls()).toBe(true);
    expect(host.querySelector('[data-testid="reads-a"]')).toBe(readsA);
    expect(host.querySelector('[data-testid="reads-b"]')).toBe(readsB);

    // Closed again: the row fits and stops scrolling, the same panels stay.
    act(() => useBrowserStore.setState(s => ({ panels: s.panels.filter(p => !docked.includes(p.id)) } as never)));
    expect(scrolls()).toBe(false);
    expect(host.querySelector('[data-testid="panel-row-cue-band"]')).toBeNull();
    expect(host.querySelector('[data-testid="reads-a"]')).toBe(readsA);
    expect(host.querySelector('[data-testid="reads-b"]')).toBe(readsB);
  } finally {
    act(() => root.unmount()); host.remove();
  }
});
