import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { useEphemeralStore } from '../stores/ephemeralStore';
import { ExportPanel } from '../components/ExportPanel';
import { KeyboardShortcutsModal } from '../components/controls/KeyboardShortcutsModal';
import { openOverlayState, useKeyboardShortcuts } from './useKeyboardShortcuts';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function renderShortcuts() {
  function Host() { useKeyboardShortcuts(); return null; }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(<Host />));
  return { unmount: () => act(() => root.unmount()) };
}

const press = (key: string, extra: KeyboardEventInit = {}) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...extra }));

describe('keyboard shortcuts', () => {
  const initial = useBrowserStore.getState();
  afterEach(() => { useBrowserStore.setState(initial, true); });

  it('arrow keys in a dropdown pick an option instead of zooming', () => {
    const zoomOut = vi.fn();
    useBrowserStore.setState({ zoomOut } as never);
    const { unmount } = renderShortcuts();
    const select = document.createElement('select');
    document.body.appendChild(select);
    select.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(zoomOut).not.toHaveBeenCalled();
    press('ArrowDown');
    expect(zoomOut).toHaveBeenCalledTimes(1);
    select.remove();
    unmount();
  });

  it('Cmd+Shift+Z redoes (Shift makes the key "Z")', () => {
    const redo = vi.fn();
    const undo = vi.fn();
    useBrowserStore.setState({ redo, undo } as never);
    const { unmount } = renderShortcuts();
    press('Z', { metaKey: true, shiftKey: true });
    expect(redo).toHaveBeenCalledTimes(1);
    expect(undo).not.toHaveBeenCalled();
    unmount();
  });

  it('a number key focuses each panel\'s own clustering, copies included', () => {
    const base = { id: 'p1', contentType: 'dataset', datasetId: 'ds', subTracks: [] };
    useBrowserStore.setState({
      datasets: [{ id: 'ds' }],
      panels: [base, { ...base, id: 'p2', stateKey: 'p2' }],
      selectedDatasets: new Set<string>(),
      clusterAssignments: { ds: { a: 0 }, p2: { a: 1, b: 0 } },
      clusterFocus: {},
    } as never);
    const { unmount } = renderShortcuts();
    press('1');
    const focus = useBrowserStore.getState().clusterFocus;
    expect([...(focus.ds ?? [])]).toEqual([0]);
    expect([...(focus.p2 ?? [])]).toEqual([0]);
    unmount();
  });

  it('a number key over two panels is one undo step, and one Undo clears both (stabilize 3, item 2)', () => {
    const base = { id: 'p1', contentType: 'dataset', datasetId: 'ds', subTracks: [] };
    useBrowserStore.setState({
      datasets: [{ id: 'ds' }],
      panels: [base, { ...base, id: 'p2', stateKey: 'p2' }],
      selectedDatasets: new Set<string>(),
      clusterAssignments: { ds: { a: 0 }, p2: { a: 1, b: 0 } },
      clusterFocus: {},
      _historyStack: [], _historyPointer: -1, _lastRestoreTime: 0,
    } as never);
    useBrowserStore.getState().pushSnapshot('Cluster kmeans k=2', { kind: 'clustering' });
    const { unmount } = renderShortcuts();
    try {
      press('1');
      const s = useBrowserStore.getState();
      expect(s._historyStack.map(x => x.label)).toEqual(['Cluster kmeans k=2', 'Set cluster focus']);
      s.undo();
      const after = useBrowserStore.getState().clusterFocus;
      expect(after.ds ?? null).toBeNull();
      expect(after.p2 ?? null).toBeNull();
    } finally {
      unmount();
    }
  });

  // --- Escape and dialogs (2026-09-30 UI audit H1, Codex "Export dialog keyboard input") ---

  /** A clustering built on 2 selected peaks, with cluster 1 focused. */
  function clusteredState(focused: boolean) {
    useBrowserStore.setState({
      datasets: [{ id: 'ds' }],
      panels: [{ id: 'p1', contentType: 'dataset', datasetId: 'ds', subTracks: [] }],
      selectedPeaks: new Set([0, 1]),
      clusterAssignments: { ds: { r1: 0, r2: 1 } },
      clusterFocus: focused ? { ds: new Set([1]) } : {},
      filteredReadIds: {},
      _historyStack: [],
      _historyPointer: -1,
    } as never);
    useBrowserStore.getState().pushSnapshot('Cluster kmeans k=2', { kind: 'clustering' });
  }
  const historyLabels = () => useBrowserStore.getState()._historyStack.map(s => s.label);

  it('Escape that closes a menu leaves the clustering, selection and history alone', () => {
    clusteredState(true);
    const { unmount } = renderShortcuts();
    // A menu that closes itself on Escape, as the History and More menus do
    // (document listener, runs before the window one; real keys re-render first).
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.appendChild(menu);
    const closeMenu = (e: KeyboardEvent) => { if (e.key === 'Escape') menu.remove(); };
    document.addEventListener('keydown', closeMenu);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.removeEventListener('keydown', closeMenu);
    const s = useBrowserStore.getState();
    expect(menu.isConnected).toBe(false);
    expect([...(s.clusterFocus.ds ?? [])]).toEqual([1]);
    expect(s.selectedPeaks.size).toBe(2);
    expect(Object.keys(s.clusterAssignments.ds)).toHaveLength(2);
    expect(historyLabels()).toEqual(['Cluster kmeans k=2']);
    unmount();
  });

  it('Escape with nothing open clears the focus first, as one step, and never the clustering', () => {
    clusteredState(true);
    const { unmount } = renderShortcuts();
    press('Escape');
    let s = useBrowserStore.getState();
    expect(s.clusterFocus).toEqual({});
    expect(s.selectedPeaks.size).toBe(2);
    expect(historyLabels()).toEqual(['Cluster kmeans k=2', 'Clear cluster focus']);
    // Again: nothing focused, and the selection carries a clustering: nothing changes, no step.
    press('Escape');
    press('Escape');
    s = useBrowserStore.getState();
    expect(s.selectedPeaks.size).toBe(2);
    expect(Object.keys(s.clusterAssignments.ds)).toHaveLength(2);
    expect(historyLabels()).toEqual(['Cluster kmeans k=2', 'Clear cluster focus']);
    unmount();
  });

  it('Escape clears a peak selection nothing is built on, as one undoable step', () => {
    useBrowserStore.setState({
      selectedPeaks: new Set([3]), clusterAssignments: {}, clusterFocus: {}, filteredReadIds: {},
      clusterTreeRootIds: [], _historyStack: [], _historyPointer: -1,
    } as never);
    useBrowserStore.getState().pushSnapshot('Navigate to chr1:1-100', { kind: 'navigation' });
    const { unmount } = renderShortcuts();
    press('Escape');
    expect(useBrowserStore.getState().selectedPeaks.size).toBe(0);
    expect(historyLabels()).toEqual(['Navigate to chr1:1-100', 'Clear peak selection']);
    press('Escape');
    expect(historyLabels()).toEqual(['Navigate to chr1:1-100', 'Clear peak selection']);
    unmount();
  });

  it('0 with nothing focused adds no history step', () => {
    useBrowserStore.setState({ clusterFocus: {}, _historyStack: [], _historyPointer: -1 } as never);
    const { unmount } = renderShortcuts();
    press('0');
    press('0');
    expect(historyLabels()).toEqual([]);
    unmount();
  });

  it('keys a menu or field already handled (defaultPrevented) are ignored', () => {
    const zoomOut = vi.fn();
    useBrowserStore.setState({ zoomOut } as never);
    const { unmount } = renderShortcuts();
    const handled = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    handled.preventDefault();
    window.dispatchEvent(handled);
    expect(zoomOut).not.toHaveBeenCalled();
    unmount();
  });

  it('with the Export dialog open, keys do not reach the browser behind it', () => {
    const zoomOut = vi.fn();
    const clearPeakSelection = vi.fn();
    const clearClusterFocus = vi.fn();
    const undo = vi.fn();
    useBrowserStore.setState({ zoomOut, clearPeakSelection, clearClusterFocus, undo, selectedPeaks: new Set([1]), clusterFocus: { ds: new Set([0]) } } as never);
    function Host() { useKeyboardShortcuts(); return <ExportPanel onClose={() => {}} />; }
    const box = document.createElement('div');
    document.body.appendChild(box);
    const root = createRoot(box);
    act(() => root.render(<Host />));
    const button = box.querySelector('[aria-label="Close export dialog"]')!;
    act(() => {
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
    });
    expect(zoomOut).not.toHaveBeenCalled();
    expect(clearPeakSelection).not.toHaveBeenCalled();
    expect(clearClusterFocus).not.toHaveBeenCalled();
    expect(undo).not.toHaveBeenCalled();
    act(() => root.unmount());
    box.remove();
  });

  it('a caller-declared modal (modalOpen) suspends the shortcuts', () => {
    const zoomIn = vi.fn();
    useBrowserStore.setState({ zoomIn } as never);
    function Host({ open }: { open: boolean }) { useKeyboardShortcuts({ modalOpen: open }); return null; }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(<Host open />));
    press('ArrowUp');
    expect(zoomIn).not.toHaveBeenCalled();
    act(() => root.render(<Host open={false} />));
    press('ArrowUp');
    expect(zoomIn).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('the Keyboard Shortcuts modal is a dialog; Escape and ? close it and nothing else', () => {
    const clearClusterFocus = vi.fn();
    const zoomOut = vi.fn();
    useBrowserStore.setState({ clearClusterFocus, zoomOut, clusterFocus: { ds: new Set([0]) } } as never);
    const onClose = vi.fn();
    function Host() { useKeyboardShortcuts(); return <KeyboardShortcutsModal open onClose={onClose} />; }
    const box = document.createElement('div');
    document.body.appendChild(box);
    const root = createRoot(box);
    act(() => root.render(<Host />));
    const dialog = box.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-labelledby')).toBe('keyboard-shortcuts-title');
    act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true })); });
    act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(clearClusterFocus).not.toHaveBeenCalled();
    expect(zoomOut).not.toHaveBeenCalled();
    act(() => root.unmount());
    box.remove();
  });
});

// Codex integration review (fb24, M3): an inactive side-panel drawer tab stays mounted,
// hidden by CSS class only; a dialog inside it (Find subclasses) still counted as open,
// so Escape no longer cleared the cluster focus or the peak selection.
describe('keyboard panning after a typed navigation (3.0.0 release, ui-controls :139)', () => {
  const initial = useBrowserStore.getState();
  afterEach(() => { useBrowserStore.setState(initial, true); useEphemeralStore.getState().setPanOffset(0); });

  it('a pan offset left by the previous view does not hold back the next arrow key', () => {
    useBrowserStore.setState({
      chrom: 'chr19', start: 1000, end: 11000, navigationMode: 'linked', isReversed: false,
      chroms: [{ name: 'chr19', size: 58_617_616 }],
      panels: [{ id: 'p', contentType: 'dataset', datasetId: 'ds', subTracks: [{ type: 'reads', visible: true }] }],
    } as never);
    useEphemeralStore.getState().setPanOffset(0);
    const { unmount } = renderShortcuts();
    const view = () => { const s = useBrowserStore.getState(); return [s.start, s.end]; };
    press('ArrowRight');
    expect(view()).toEqual([3500, 13500]);
    // No reads drawn: nothing consumes the offset, and a second key at once waits for the redraw (as before).
    expect(useEphemeralStore.getState().panOffset).not.toBe(0);
    press('ArrowRight');
    expect(view()).toEqual([3500, 13500]);
    // A typed locus moves the view: the old offset belongs to the view before it.
    useBrowserStore.getState().setViewport('chr19', 1000, 11000);
    press('ArrowRight');
    expect(view()).toEqual([3500, 13500]);
    unmount();
  });
});

describe('menus and dialogs that are mounted but not on show', () => {
  const initial = useBrowserStore.getState();
  afterEach(() => { useBrowserStore.setState(initial, true); document.body.innerHTML = ''; });

  /** A dialog the browser does not draw (display: none above it), as checkVisibility reports it. */
  function undrawnDialog(): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'hidden';
    wrapper.setAttribute('data-drawer-hidden', 'true');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    (dialog as any).checkVisibility = () => false;
    wrapper.appendChild(dialog);
    document.body.appendChild(wrapper);
    return dialog;
  }

  it('do not count as open: hidden by CSS, by the hidden attribute, or inert', () => {
    undrawnDialog();
    expect(openOverlayState()).toEqual({ modal: false, overlay: false });
    for (const attr of ['hidden', 'inert']) {
      const box = document.createElement('div');
      box.setAttribute(attr, '');
      box.innerHTML = '<div role="menu"></div>';
      document.body.appendChild(box);
      expect(openOverlayState(), attr).toEqual({ modal: false, overlay: false });
    }
    // One that is drawn still counts.
    const shown = document.createElement('div');
    shown.setAttribute('role', 'dialog');
    (shown as any).checkVisibility = () => true;
    document.body.appendChild(shown);
    expect(openOverlayState().overlay).toBe(true);
  });

  it('Escape still clears the cluster focus with such a dialog mounted', () => {
    undrawnDialog();
    const clearClusterFocus = vi.fn();
    useBrowserStore.setState({ clearClusterFocus, clusterFocus: { ds: new Set([0]) } } as never);
    const { unmount } = renderShortcuts();
    press('Escape');
    expect(clearClusterFocus).toHaveBeenCalledTimes(1);
    unmount();
  });
});
