import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import type { PanelConfig, SubTrackConfig } from '../../types';
import type { ReadTrackStatus } from '../../stores/uiSlice';
import { useSubTrackDispatch } from './SubTrackDispatch';
import { META_HEIGHT } from './TrackContainerConstants';

vi.mock('./MetaTrack', () => ({ MetaTrack: () => <div data-testid="meta" /> }));
vi.mock('./GeneTrack', () => ({ GeneTrack: () => <div data-testid="gene" /> }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const tracks = [{ type: 'meta', visible: true }, { type: 'gene', visible: true }] as SubTrackConfig[];
const panel = { id: 'p1', datasetId: 'ds1', contentType: 'dataset', subTracks: tracks, collapsed: false, linkGroup: null, layoutRow: 0 } as unknown as PanelConfig;
const status = (over: Partial<ReadTrackStatus>): ReadTrackStatus => ({
  datasetId: 'ds1', chrom: 'chr1', start: 0, end: 1000, loading: false, fetchFailed: false, warning: null, zoomedOut: false,
  stale: false, displayed: 0, working: 0, inScope: 0, overlapping: 0, spanning: 0, strand: null, ...over,
} as ReadTrackStatus);

let heights: number[] = [];
function Harness() {
  const { renderSubTrack, calcFixedHeight } = useSubTrackDispatch({});
  heights.push(calcFixedHeight(panel));
  return <div>{tracks.map((t, i) => renderSubTrack(t, i, panel, 800, 300, false))}</div>;
}

// Audit M23: a panel without reads still drew its metaprofile row (an empty band; a dark
// one in dark mode) between the peaks and the empty-state card.
describe('a dataset panel with no reads in its view', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    heights = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({
      datasets: [{ id: 'ds1', label: 'napa_ddda', color: '#3b82f6' }], panels: [panel], clusterAssignments: {}, readTrackStatus: {},
    } as never);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('drops the metaprofile row once its reads have settled at none, and keeps that while the next view loads', () => {
    act(() => root.render(<Harness />));
    expect(container.querySelector('[data-testid="meta"]')).not.toBeNull();
    const full = heights.at(-1)!;
    act(() => useBrowserStore.setState({ readTrackStatus: { ds1: status({}) } } as never));
    expect(container.querySelector('[data-testid="meta"]')).toBeNull();
    expect(heights.at(-1)).toBe(full - META_HEIGHT);
    // Loading the next view: no jump back and forth.
    act(() => useBrowserStore.setState({ readTrackStatus: { ds1: status({ loading: true }) } } as never));
    expect(container.querySelector('[data-testid="meta"]')).toBeNull();
    // Reads there: the row comes back.
    act(() => useBrowserStore.setState({ readTrackStatus: { ds1: status({ displayed: 40, inScope: 40 }) } } as never));
    expect(container.querySelector('[data-testid="meta"]')).not.toBeNull();
    expect(heights.at(-1)).toBe(full);
  });

  it('keeps the row when reads are there but filtered out (the profile still says something)', () => {
    act(() => useBrowserStore.setState({ readTrackStatus: { ds1: status({ displayed: 0, inScope: 120 }) } } as never));
    act(() => root.render(<Harness />));
    expect(container.querySelector('[data-testid="meta"]')).not.toBeNull();
  });
});
