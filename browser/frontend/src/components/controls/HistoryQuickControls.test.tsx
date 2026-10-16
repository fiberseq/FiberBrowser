import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { describeHistoryStep, describeStepLocus, panelLociChanged, undoRedoLabels } from '../../utils/historyLabels';
import { HistoryQuickControls } from './HistoryQuickControls';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// 2026-09-30 UI audit H6/L6: the Undo tooltip named the step before the one it undoes.
describe('Undo / Redo tooltips name the step they act on', () => {
  const initial = useBrowserStore.getState();
  afterEach(() => useBrowserStore.setState(initial, true));

  const stack = ['Navigate to chr19:47,514,000-47,518,000', 'Before sorting', 'Sort by occupancy@nuc', 'Close napa_ddda']
    .map(label => ({ label, timestamp: 0, state: {} }));

  it('Undo is the current step, Redo the next; checkpoints read as earlier changes', () => {
    expect(undoRedoLabels(stack, 3)).toEqual({ undo: 'Close napa_ddda', redo: null });
    expect(undoRedoLabels(stack, 2)).toEqual({ undo: 'Sort by occupancy@nuc', redo: 'Close napa_ddda' });
    expect(undoRedoLabels(stack, 1)).toEqual({ undo: 'earlier changes (before sorting)', redo: 'Sort by occupancy@nuc' });
    expect(undoRedoLabels(stack, 0)).toEqual({ undo: null, redo: 'earlier changes (before sorting)' });
    expect(describeHistoryStep({ label: 'Before closing napa_ddda' })).toBe('earlier changes (before closing napa_ddda)');
  });

  it('the toolbar buttons say so', () => {
    useBrowserStore.setState({ _historyStack: stack, _historyPointer: 2 } as never);
    const box = document.createElement('div');
    const root = createRoot(box);
    act(() => root.render(<HistoryQuickControls />));
    expect(box.querySelector('[data-testid="quick-undo-button"]')!.getAttribute('title')).toBe('Undo: Sort by occupancy@nuc (Cmd/Ctrl+Z)');
    expect(box.querySelector('[data-testid="quick-redo-button"]')!.getAttribute('title')).toBe('Redo: Close napa_ddda (Cmd/Ctrl+Shift+Z)');
    // The history list is a popover the global Escape leaves alone.
    act(() => (box.querySelector('[data-testid="history-timeline-button"]') as HTMLButtonElement).click());
    expect(box.querySelector('[data-testid="history-timeline"]')!.getAttribute('role')).toBe('dialog');
    act(() => root.unmount());
  });
});

// fb-n2-scope (audit L1): in Per panel mode the main locus is stale; a step that moved a
// dm6 panel named "chr19:47,514,037…" in the History list.
describe('History list: the locus of each step', () => {
  const initial = useBrowserStore.getState();
  afterEach(() => useBrowserStore.setState(initial, true));

  const MAIN = { chrom: 'chr19', start: 47_514_037, end: 47_519_435 };
  const human = { id: 'p1', contentType: 'dataset', datasetId: 'napa', viewportOverride: { chrom: 'chr19', start: 47_514_262, end: 47_519_210 }, navOwn: true };
  const flyAt = (start: number) => ({ id: 'p2', contentType: 'dataset', datasetId: 'flyamp', genome: 'dm6', viewportOverride: { chrom: 'chr2L', start, end: start + 855 }, navOwn: true });
  const step = (label: string, panels: unknown[]) => ({ label, timestamp: Date.now(), state: { ...MAIN, panels, navigationMode: 'perPanel' } });

  it("names the panel's own locus and reference, not the stale main locus", () => {
    const stack = [
      step('Each panel navigates', [human, flyAt(6_356_793)]),
      step('Panel to chr2L:6,400,000', [human, flyAt(6_400_000)]),
      step('Cluster K=3', [human, flyAt(6_400_000)]),
    ];
    expect(describeStepLocus(stack[1].state, stack[0].state)).toBe('dm6 chr2L:6,400,000-6,400,855');
    expect(panelLociChanged(stack[0].state, stack[1].state)).toBe(true);
    // A step that moved nothing: what the panels show (none follows the main locus).
    expect(describeStepLocus(stack[2].state, stack[1].state)).toBe('chr19:47,514,262-47,519,210 +1 more');
    // Linked, a panel following the main view: the main locus.
    expect(describeStepLocus({ ...MAIN, panels: [{ id: 'p1', contentType: 'dataset', datasetId: 'napa' }] })).toBe('chr19:47,514,037-47,519,435');

    // Panels hidden (a collapsed row, another panel maximized) are not named (Codex review).
    const linkedHuman = { id: 'p1', contentType: 'dataset', datasetId: 'napa', layoutRow: 1 };
    const fly = { ...flyAt(6_400_000), layoutRow: 0 };
    expect(describeStepLocus({ ...MAIN, panels: [linkedHuman, fly], collapsedRows: [1] })).toBe('dm6 chr2L:6,400,000-6,400,855');
    expect(describeStepLocus({ ...MAIN, panels: [linkedHuman, fly], fullViewPanelId: 'p2' })).toBe('dm6 chr2L:6,400,000-6,400,855');

    useBrowserStore.setState({ _historyStack: stack, _historyPointer: 2 } as never);
    const box = document.createElement('div');
    const root = createRoot(box);
    act(() => root.render(<HistoryQuickControls />));
    act(() => (box.querySelector('[data-testid="history-timeline-button"]') as HTMLButtonElement).click());
    const text = box.querySelector('[data-testid="history-timeline"]')!.textContent ?? '';
    expect(text).toContain('dm6 chr2L:6,400,000-6,400,855');
    expect(text).not.toContain('47,514,037');
    act(() => root.unmount());
  });
});
