import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import type { PanelConfig, SubTrackConfig } from '../../types';
import { useSubTrackDispatch, type PanelTrackLayout } from './SubTrackDispatch';
import { AXIS_HEIGHT } from './TrackContainerConstants';

vi.mock('./AxisTrack', () => ({ AxisTrack: () => <div data-testid="axis" /> }));
vi.mock('./GeneTrack', () => ({ GeneTrack: () => <div data-testid="gene" /> }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const tracks = [{ type: 'axis', visible: true }, { type: 'gene', visible: true }] as SubTrackConfig[];
const panel = { id: 'p2', datasetId: 'ds1', contentType: 'dataset', subTracks: tracks, collapsed: false, linkGroup: null, layoutRow: 0 } as unknown as PanelConfig;

let heights: number[] = [];
function Harness({ layout }: { layout?: PanelTrackLayout }) {
  const { renderSubTrack, calcFixedHeight } = useSubTrackDispatch({});
  heights.push(calcFixedHeight(panel, layout));
  return <div>{tracks.map((t, i) => renderSubTrack(t, i, panel, 800, 300, false, layout))}</div>;
}

describe('a panel whose ruler repeats the one above', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    heights = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({
      datasets: [{ id: 'ds1', label: 'napa_ddda', color: '#3b82f6' }], panels: [panel], clusterAssignments: {},
    } as never);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('draws no axis and reserves no height for it, without hiding the track in the panel', () => {
    act(() => root.render(<Harness />));
    expect(container.querySelector('[data-testid="axis"]')).not.toBeNull();
    const withAxis = heights.at(-1)!;
    act(() => root.render(<Harness layout={{ hideAxis: true }} />));
    expect(container.querySelector('[data-testid="axis"]')).toBeNull();
    expect(container.querySelector('[data-testid="gene"]')).not.toBeNull();
    expect(heights.at(-1)).toBe(withAxis - AXIS_HEIGHT);
    // Still visible in the panel's configuration (no "hidden tracks" strip).
    expect(panel.subTracks[0].visible).toBe(true);
  });
});
