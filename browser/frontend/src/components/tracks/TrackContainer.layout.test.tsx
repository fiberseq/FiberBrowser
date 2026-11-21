import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { usePanelLauncherStore } from '../../stores/panelLauncherStore';
import { registerDatasetBody } from './datasetBodyExtensions';
import { TrackContainer } from './TrackContainer';

vi.mock('./SubTrackDispatch', () => ({
  useSubTrackDispatch: () => ({
    calcFixedHeight: () => 88, // 28 px header and 60 px of fixed tracks.
    renderSubTrack: (track: { type: string }, _index: number, panel: { id: string }, _width: number, height: number) =>
      <div key={track.type} data-testid={`reads-${panel.id}`} data-height={height} />,
  }),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('rail layout gives split panels and graph hosts a bounded body below their own headers', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1000, height: 600, top: 0, left: 0, right: 1000, bottom: 600 } as DOMRect);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
  registerDatasetBody({ id: 'layout-test-graph', shows: p => p.id === 'graph-host',
    component: ({ height }) => <div data-testid="graph-body" data-height={height} /> });
  usePanelLauncherStore.setState({ mode: 'rail' });
  useBrowserStore.setState({ datasets: [{ id: 'd', label: 'Sample', color: '#123456' }],
    panels: [
      { id: 'split', stateKey: 'd:split', contentType: 'dataset', datasetId: 'd', collapsed: false, subTracks: [{ type: 'reads', visible: true }],
        viewportOverride: { chrom: 'chr2', start: 100, end: 500 } },
      { id: 'graph-host', contentType: 'dataset', datasetId: 'd', collapsed: false, subTracks: [] },
    ], chrom: 'chr1', start: 100, end: 500, peakRules: [], peaksByRule: {},
    selectedDatasets: new Set(), fullViewPanelId: null, exportInProgress: false,
  } as never);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<TrackContainer />));
    for (const id of ['split', 'graph-host']) {
      const panel = host.querySelector<HTMLElement>(`[data-panel-id="${id}"]`)!;
      expect(panel).not.toBeNull();
      const body = panel.querySelector('[data-panel-body]')!;
      expect(body.contains(panel.querySelector('[data-panel-header]'))).toBe(false);
      expect(panel.style.overflow).toBe('hidden');
    }
    expect(host.querySelector('[data-testid="reads-split"]')?.getAttribute('data-height')).toBe('340');
    expect(host.querySelector('[data-testid="graph-body"]')?.getAttribute('data-height')).toBe('400');
  } finally {
    act(() => root.unmount()); host.remove();
  }
});
