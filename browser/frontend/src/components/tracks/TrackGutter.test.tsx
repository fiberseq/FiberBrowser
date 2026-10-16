import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import type { PanelConfig, SubTrackConfig } from '../../types';
import { useSubTrackDispatch } from './SubTrackDispatch';
import { SIDEBAR_WIDTH } from './read-track/constants';
import { TRACK_BACKGROUND } from './TrackContainerConstants';

// The tracks themselves draw on canvas; here only the row around them matters.
vi.mock('./AxisTrack', () => ({ AxisTrack: ({ width }: { width: number }) => <div data-testid="axis" style={{ width }} /> }));
vi.mock('./GeneTrack', () => ({ GeneTrack: ({ width }: { width: number }) => <div data-testid="gene" style={{ width }} /> }));
vi.mock('./SequenceTrack', () => ({ SequenceTrack: ({ width }: { width: number }) => <div data-testid="sequence" style={{ width }} /> }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const tracks: SubTrackConfig[] = [
  { type: 'axis', visible: true },
  { type: 'gene', visible: true },
  { type: 'sequence', visible: true },
] as SubTrackConfig[];
const panel = { id: 'p1', datasetId: 'ds1', contentType: 'dataset', subTracks: tracks, collapsed: false, linkGroup: null, layoutRow: 0 } as unknown as PanelConfig;

function Harness() {
  const { renderSubTrack } = useSubTrackDispatch({});
  return <div>{tracks.map((t, i) => renderSubTrack(t, i, panel, 800, 300, true))}</div>;
}

function rgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

describe('the cluster sidebar column beside fixed tracks', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (clustered: boolean, darkMode: boolean) => {
    useBrowserStore.setState({
      datasets: [{ id: 'ds1', label: 'napa_ddda', color: '#3b82f6' }],
      panels: [panel],
      clusterAssignments: clustered ? { ds1: { r1: 1, r2: 2 } } : {},
      hasFasta: true, chrom: 'chr19', start: 0, end: 1000, darkMode,
    } as never);
    act(() => root.render(<Harness />));
  };

  it('is filled with each track\'s own ground in dark mode, not left for the page to show through', () => {
    render(true, true);
    const gutters = [...container.querySelectorAll<HTMLElement>('[data-track-gutter]')];
    expect(gutters.map(g => g.dataset.trackGutter)).toEqual(['axis', 'gene', 'sequence']);
    for (const g of gutters) {
      expect(g.style.paddingLeft).toBe(`${SIDEBAR_WIDTH}px`);
      expect(g.style.marginLeft).toBe('');
    }
    expect(gutters[0].style.background).toBe(rgb(TRACK_BACKGROUND.axis));
    expect(gutters[1].style.background).toBe(rgb(TRACK_BACKGROUND.gene));
    // The sequence strip stays light too: one canvas ground per theme (audit M29; it was #1a1a1a).
    expect(gutters[2].style.background).toBe(rgb(TRACK_BACKGROUND.sequence));
    // The track itself keeps its width to the right of the column.
    expect(container.querySelector<HTMLElement>('[data-testid="axis"]')!.style.width).toBe(`${800 - SIDEBAR_WIDTH}px`);
  });

  it('takes the light ground in light mode', () => {
    render(true, false);
    const seq = container.querySelector<HTMLElement>('[data-track-gutter="sequence"]')!;
    expect(seq.style.background).toBe(rgb(TRACK_BACKGROUND.sequence));
  });

  it('is absent without clusters', () => {
    render(false, true);
    expect(container.querySelectorAll('[data-track-gutter]').length).toBe(0);
    expect(container.querySelector<HTMLElement>('[data-testid="axis"]')!.style.width).toBe('800px');
  });
});
