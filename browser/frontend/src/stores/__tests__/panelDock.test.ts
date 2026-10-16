import { beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../browserStore';
import '../../plugins/builtinPanels';

const panel = () => useBrowserStore.getState().panels.find(p => p.contentType === 'footprint-analysis');

describe('pin an analysis panel to the side', () => {
  beforeEach(() => {
    localStorage.clear();
    useBrowserStore.setState({ panels: [], _historyStack: [], _historyPointer: -1 } as never);
  });

  it('pins and docks again, as undoable steps', () => {
    useBrowserStore.getState().openAnalysisPanel('footprint-analysis');
    useBrowserStore.getState().setPanelDock(panel()!.id, 'side');
    expect(panel()!.dock).toBe('side');
    expect(useBrowserStore.getState()._historyStack.at(-1)!.label).toMatch(/^Pin Footprints to the side/);
    useBrowserStore.getState().undo();
    expect(panel()!.dock).toBeUndefined();
    useBrowserStore.getState().redo();
    expect(panel()!.dock).toBe('side');
    // Docked beside the reads again: the pin is lifted, at the comfortable widths (round 3, B1: no tight 'beside').
    useBrowserStore.getState().setPanelDock(panel()!.id, 'beside');
    expect(panel()!.dock).toBeUndefined();
    expect(useBrowserStore.getState()._historyStack.at(-1)!.label).toMatch(/^Dock Footprints beside the reads/);
  });

  it('docked beside the reads, closed and reopened: it opens automatic (no tight dock, no pin)', () => {
    useBrowserStore.getState().openAnalysisPanel('footprint-analysis');
    useBrowserStore.getState().setPanelDock(panel()!.id, 'side');
    useBrowserStore.getState().setPanelDock(panel()!.id, 'beside');
    useBrowserStore.getState().closeAnalysisPanel(panel()!.id);
    useBrowserStore.getState().openAnalysisPanel('footprint-analysis');
    expect(panel()!.dock).toBeUndefined();
  });

  it('remembers the choice per panel type: closed and reopened, it opens where it was', () => {
    useBrowserStore.getState().openAnalysisPanel('footprint-analysis');
    useBrowserStore.getState().setPanelDock(panel()!.id, 'side');
    useBrowserStore.getState().closeAnalysisPanel(panel()!.id);
    useBrowserStore.getState().openAnalysisPanel('footprint-analysis');
    expect(panel()!.dock).toBe('side');
    // Other panel types are not affected.
    useBrowserStore.getState().openAnalysisPanel('cluster-detail');
    expect(useBrowserStore.getState().panels.find(p => p.contentType === 'cluster-detail')!.dock).toBeUndefined();
  });

  it('dataset panels cannot be pinned', () => {
    useBrowserStore.setState({ panels: [{ id: 'd', contentType: 'dataset', datasetId: 'a', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 }] } as never);
    useBrowserStore.getState().setPanelDock('d', 'side');
    expect(useBrowserStore.getState().panels[0].dock).toBeUndefined();
  });

  it('pinning a panel stacked under another takes it out of that column', () => {
    useBrowserStore.setState({ panels: [
      { id: 'd', contentType: 'dataset', datasetId: 'a', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, layoutColumn: 0 },
      { id: 'c', contentType: 'cluster-detail', datasetId: null, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, layoutColumn: 0 },
    ] } as never);
    useBrowserStore.getState().setPanelDock('c', 'side');
    const c = useBrowserStore.getState().panels.find(p => p.id === 'c')!;
    expect(c.dock).toBe('side');
    expect(c.layoutColumn).toBeUndefined();
    expect(useBrowserStore.getState().panels.find(p => p.id === 'd')!.layoutColumn).toBe(0);
  });
});

// A side panel dragged out of the drawer onto the row (owner: "dragging a window from the sliding panel onto the main
// set of panels fails"): it leaves the drawer at the drop, as "Dock beside the reads" does; dropped on the drawer, a
// panel of the row goes into it.
describe('dockPanelAt: a drop moves a side panel out of the drawer (or into it)', () => {
  const ids = () => useBrowserStore.getState().panels.map(p => `${p.contentType}${p.dock === 'side' ? ':side' : ''}`);
  beforeEach(() => {
    localStorage.clear();
    useBrowserStore.setState({
      _historyStack: [], _historyPointer: -1,
      panels: [
        { id: 'd', contentType: 'dataset', datasetId: 'ds', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, widthFraction: 0.4 },
        { id: 'a', contentType: 'cluster-detail', datasetId: null, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 },
        { id: 'f', contentType: 'footprint-analysis', datasetId: null, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, dock: 'side', layoutColumn: 3 },
        { id: 'c', contentType: 'co-accessibility', datasetId: null, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 },
      ],
    } as never);
  });

  it('out of the drawer, before the panel it was dropped on; one undo step; the other panels untouched', () => {
    const before = useBrowserStore.getState().panels;
    useBrowserStore.getState().dockPanelAt('f', 0, 'a', 'beside');
    expect(ids()).toEqual(['dataset', 'footprint-analysis', 'cluster-detail', 'co-accessibility']);
    const after = useBrowserStore.getState().panels;
    expect(after.find(p => p.id === 'f')).not.toHaveProperty('dock');
    expect(after.find(p => p.id === 'f')).not.toHaveProperty('layoutColumn');      // a column of its own
    // the other panels are the same objects: their widths (widthFraction) and places are kept
    for (const id of ['d', 'a', 'c']) expect(after.find(p => p.id === id)).toBe(before.find(p => p.id === id));
    expect(useBrowserStore.getState()._historyStack.at(-1)!.label).toMatch(/^Dock Footprints beside the reads/);
    useBrowserStore.getState().undo();
    expect(ids()).toEqual(['dataset', 'cluster-detail', 'footprint-analysis:side', 'co-accessibility']);
  });

  it('at the row\'s end (no panel after the drop)', () => {
    useBrowserStore.getState().dockPanelAt('f', 0, null, 'beside');
    expect(ids()).toEqual(['dataset', 'cluster-detail', 'co-accessibility', 'footprint-analysis']);
  });

  it('a panel of the row dropped on the drawer is pinned there', () => {
    useBrowserStore.getState().dockPanelAt('c', 0, null, 'side');
    expect(ids()).toEqual(['dataset', 'cluster-detail', 'footprint-analysis:side', 'co-accessibility:side']);
    expect(useBrowserStore.getState()._historyStack.at(-1)!.label).toMatch(/to the side$/);
  });

  it('never a dataset panel', () => {
    useBrowserStore.getState().dockPanelAt('d', 0, null, 'side');
    expect(ids()[0]).toBe('dataset');
    expect(useBrowserStore.getState()._historyStack).toHaveLength(0);
  });
});

describe('dockPanelAt with a place: a new row or under a panel, the move and the dock one undo step', () => {
  beforeEach(() => {
    localStorage.clear();
    useBrowserStore.setState({
      _historyStack: [], _historyPointer: -1, collapsedRows: new Set(),
      panels: [
        { id: 'd', contentType: 'dataset', datasetId: 'ds', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 },
        { id: 'a', contentType: 'cluster-detail', datasetId: null, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 },
        { id: 'f', contentType: 'footprint-analysis', datasetId: null, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, dock: 'side' },
      ],
    } as never);
  });
  const f = () => useBrowserStore.getState().panels.find(p => p.id === 'f')!;
  it('on a new row: docked there; one undo puts it back pinned on its row', () => {
    useBrowserStore.getState().dockPanelAt('f', 0, null, 'beside', { newRowAfter: 0 });
    expect(f()).toMatchObject({ layoutRow: 1 });
    expect(f()).not.toHaveProperty('dock');
    useBrowserStore.getState().undo();
    expect(f()).toMatchObject({ layoutRow: 0, dock: 'side' });
  });
  it('under another panel: stacked in its column, docked; one undo restores it', () => {
    useBrowserStore.getState().dockPanelAt('f', 0, null, 'beside', { stackBelow: 'a' });
    expect(f().layoutColumn).toBe(useBrowserStore.getState().panels.find(p => p.id === 'a')!.layoutColumn);
    expect(f()).not.toHaveProperty('dock');
    useBrowserStore.getState().undo();
    expect(f()).toMatchObject({ dock: 'side' });
    expect(f().layoutColumn).toBeUndefined();
  });
});
