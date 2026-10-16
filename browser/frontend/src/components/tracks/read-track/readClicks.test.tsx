import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { useEphemeralStore } from '../../../stores/ephemeralStore';
import { READ_ACTIONS_HINT_KEY, useReadActionsStore } from '../../../stores/readActionsStore';
import type { ChromInfo } from '../../../types';
import type { CompactRead } from './types';
import { isFootprintClick, useReadTrackMouse } from './useReadTrackMouse';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * fb-r4-clicks: no click modes. A plain click/drag on reads pans; Shift+click
 * selects a read (Read Stats), Cmd/Ctrl+click a footprint (Footprints);
 * right-click opens the read menu and never pans.
 */
const READS: CompactRead[] = [
  { id: 'r0', intervals: [[0, 400, -400], [400, 547, 147], [547, 1000, -453]] },
  { id: 'r1', intervals: [[0, 1000, -1000]] },
];

type Handlers = ReturnType<typeof useReadTrackMouse>;
let handlers: Handlers | null = null;
const onViewportChange = vi.fn();

function Harness() {
  handlers = useReadTrackMouse({
    displayReads: READS, width: 1000, height: 200, sidebarWidth: 0, regionWidth: 1000, start: 0, end: 1000,
    chrom: 'chr1', datasetId: 'ds1', stateKey: 'ds1', hasCluster: false, myClusterAssignments: {}, myClusterOrder: [],
    myClusterFocus: null, mySelectedClusters: null, hasClusterFocus: false, isPanning: false, isReversed: false,
    fillReadHeight: false, storeReadRowHeight: 20, readScrollOffset: 0, readSeparatorMode: 'off',
    readSeparatorMinHeight: 0, readSeparatorWidth: 0, showReadTooltip: false, showCoverageHistogram: false,
    onViewportChange,
  });
  return null;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const canvas = document.createElement('canvas');
Object.defineProperty(canvas, 'clientWidth', { value: 1000 });
Object.defineProperty(canvas, 'clientHeight', { value: 200 });
canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 200, right: 1000, bottom: 200, x: 0, y: 0, toJSON: () => ({}) });

const mouse = (extra: Record<string, unknown>) => ({
  button: 0, clientX: 470, clientY: 10, currentTarget: canvas, shiftKey: false, metaKey: false, ctrlKey: false,
  preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra,
}) as never;

const selectFootprint = vi.fn();
const openAnalysisPanel = vi.fn();
beforeEach(() => {
  try { localStorage.removeItem(READ_ACTIONS_HINT_KEY); } catch { /* */ }
  useReadActionsStore.setState({ hintStateKey: null });
  useBrowserStore.setState({
    chroms: [{ name: 'chr1', size: 1_000_000 } as ChromInfo],
    selectedReadIds: {}, selectFootprint, openAnalysisPanel, enabledModTypes: {} as never,
  } as never);
  selectFootprint.mockClear();
  openAnalysisPanel.mockClear();
  onViewportChange.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Harness />));
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  handlers = null;
});

describe('clicks on reads', () => {
  it('a plain click selects nothing and opens nothing (it pans)', () => {
    act(() => handlers!.handleClick(mouse({})));
    expect(useBrowserStore.getState().selectedReadIds.ds1).toBeUndefined();
    expect(selectFootprint).not.toHaveBeenCalled();
    expect(openAnalysisPanel).not.toHaveBeenCalled();
    // ...and a drag pans.
    act(() => handlers!.handleMouseDown(mouse({ clientX: 500 })));
    act(() => { document.dispatchEvent(new MouseEvent('mouseup', { clientX: 300, clientY: 10 })); });
    expect(onViewportChange).toHaveBeenCalledWith(200, 1200);
  });

  it('Shift+click selects the read and opens Read Stats', () => {
    act(() => handlers!.handleClick(mouse({ shiftKey: true, clientY: 30 })));
    expect([...useBrowserStore.getState().selectedReadIds.ds1]).toEqual(['r1']);
    expect(openAnalysisPanel).toHaveBeenCalledWith('read-stats');
  });

  it('Cmd/Ctrl+click selects the footprint and opens Footprints', () => {
    act(() => handlers!.handleClick(mouse({ metaKey: true, ctrlKey: true })));
    expect(selectFootprint).toHaveBeenCalledTimes(1);
    expect(selectFootprint.mock.calls[0][0]).toMatchObject({ readId: 'r0', absStart: 400, absEnd: 547 });
    expect(openAnalysisPanel).toHaveBeenCalledWith('footprint-analysis');
  });

  it('on a Mac only Cmd selects a footprint: Ctrl+click is the right-click', () => {
    expect(isFootprintClick({ metaKey: true, ctrlKey: false }, true)).toBe(true);
    expect(isFootprintClick({ metaKey: false, ctrlKey: true }, true)).toBe(false);
    expect(isFootprintClick({ metaKey: false, ctrlKey: true }, false)).toBe(true);
  });

  it('right-click opens the menu for the read and footprint under the pointer, and never pans', () => {
    const e = mouse({ button: 2 });
    act(() => handlers!.handleMouseDown(e));  // the right button never starts a drag
    expect(useEphemeralStore.getState().isPanning).toBe(false);
    act(() => handlers!.handleContextMenu(e));
    expect((e as any).preventDefault).toHaveBeenCalled();
    const target = handlers!.contextTarget!;
    expect(target.read?.id).toBe('r0');
    expect(target.footprint?.interval).toEqual([400, 547, 147]);
    expect(target.genomePos).toBe(470);
    act(() => { document.dispatchEvent(new MouseEvent('mouseup', { clientX: 100, clientY: 10 })); });
    expect(onViewportChange).not.toHaveBeenCalled();
    act(() => handlers!.closeContextMenu());
    expect(handlers!.contextTarget).toBeNull();
  });

  it('Shift+F10 (or the menu key) on the focused reads opens the menu for the first read in view', () => {
    const e = { key: 'F10', shiftKey: true, currentTarget: canvas, preventDefault: vi.fn(), stopPropagation: vi.fn() } as never;
    act(() => handlers!.handleKeyDown(e));
    expect((e as any).preventDefault).toHaveBeenCalled();
    expect(handlers!.contextTarget?.read?.id).toBe('r0');
    act(() => handlers!.closeContextMenu());
    act(() => handlers!.handleKeyDown({ key: 'a', shiftKey: false, currentTarget: canvas, preventDefault: vi.fn(), stopPropagation: vi.fn() } as never));
    expect(handlers!.contextTarget).toBeNull();
  });

  it('the first click on reads shows the click hint once (remembered)', () => {
    act(() => handlers!.handleMouseDown(mouse({})));
    act(() => { document.dispatchEvent(new MouseEvent('mouseup', { clientX: 470, clientY: 10 })); });
    expect(useReadActionsStore.getState().hintStateKey).toBe('ds1');
    expect(localStorage.getItem(READ_ACTIONS_HINT_KEY)).toBe('1');
    act(() => useReadActionsStore.getState().dismissHint());
    act(() => handlers!.handleMouseDown(mouse({})));
    act(() => { document.dispatchEvent(new MouseEvent('mouseup', { clientX: 470, clientY: 10 })); });
    expect(useReadActionsStore.getState().hintStateKey).toBeNull();
  });
});
