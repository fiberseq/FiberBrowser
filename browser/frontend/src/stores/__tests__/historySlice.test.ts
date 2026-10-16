import { describe, expect, it } from 'vitest';
import { createTestStore } from './helpers';

describe('seedHistoryBaseline', () => {
  it('keeps the checkpoint when the action result is pushed right after it', async () => {
    const { useBrowserStore } = await import('../browserStore');
    const { seedHistoryBaseline } = await import('../historySlice');
    const store = useBrowserStore;
    store.getState().clearHistory?.();
    store.getState().pushSnapshot('Navigate', { kind: 'navigation' });
    store.setState({ selectedPeaks: new Set([1, 2]) } as any);
    seedHistoryBaseline(store.getState(), 'Before sorting', 'sorting');
    store.getState().pushSnapshot('Sort by accessibility', { kind: 'sorting' });
    const labels = store.getState()._historyStack.map(s => s.label);
    expect(labels.slice(-2)).toEqual(['Before sorting', 'Sort by accessibility']);
  });
});

describe('snapshots keep TSS-relative coordinates and cluster selections', () => {
  it('restores relativeGene and selectedClusters (Sets)', () => {
    const store = createTestStore();
    const gene = { id: 'g', name: 'G', chrom: 'chr1', start: 100, end: 900, strand: '-' };
    store.setState({ relativeGene: gene as never, selectedClusters: { ds: new Set([1, 3]) } });
    store.getState().pushSnapshot('Before', { kind: 'layout' });
    store.setState({ relativeGene: null, selectedClusters: {} });
    const index = store.getState()._historyStack.findIndex(s => s.label === 'Before');
    store.getState().restoreSnapshot(index, { restoreViewport: true });
    expect(store.getState().relativeGene).toEqual(gene);
    expect(store.getState().selectedClusters.ds).toEqual(new Set([1, 3]));
  });
});

describe('theme and UI size are not undo steps (2026-09-30 UI audit M27)', () => {
  it('Undo of a zoom keeps dark mode (state and page) and the UI size', () => {
    const store = createTestStore();
    document.documentElement.classList.remove('dark');
    store.setState({ darkMode: false, uiScale: 1, start: 100, end: 200 } as never);
    store.getState().pushSnapshot('Navigate to chr1:100-200', { kind: 'navigation' });
    // Switch to dark mode and a larger UI (as the rail button does: store + page).
    store.setState({ darkMode: true, uiScale: 1.25 } as never);
    document.documentElement.classList.add('dark');
    store.setState({ start: 50, end: 250 } as never);
    store.getState().pushSnapshot('Navigate to chr1:50-250', { kind: 'navigation' });
    store.getState().undo();
    expect(store.getState().start).toBe(100);
    expect(store.getState().darkMode).toBe(true);
    expect(store.getState().uiScale).toBe(1.25);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    store.getState().redo();
    expect(store.getState().darkMode).toBe(true);
    document.documentElement.classList.remove('dark');
  });

  it('a theme change alone does not make a "Before …" checkpoint', async () => {
    const { seedHistoryBaseline } = await import('../historySlice');
    const store = createTestStore();
    store.getState().pushSnapshot('Navigate', { kind: 'navigation' });
    store.setState({ darkMode: !store.getState().darkMode, uiScale: 1.5 } as never);
    seedHistoryBaseline(store.getState(), 'Before sorting', 'sorting');
    expect(store.getState()._historyStack.map(s => s.label)).toEqual(['Navigate']);
  });

  it('sessions still save the theme and UI size', async () => {
    const { serializeState } = await import('../historySlice');
    const store = createTestStore();
    store.setState({ darkMode: true, uiScale: 1.25 } as never);
    expect(serializeState(store.getState())).toMatchObject({ darkMode: true, uiScale: 1.25 });
  });
});

describe('peaks re-scanned after a step are part of it (audit M8)', () => {
  it('one Undo per panel step: no "Before …" checkpoint of the re-scanned peaks alone', () => {
    const store = createTestStore();
    const s = () => store.getState();
    s().setViewport('chr19', 47_514_000, 47_518_000);
    const a = s().addPanel('a');
    const b = s().addPanel('b');
    s().setNavigationMode('perPanel');
    const rule = s().peakRules[0].id;
    s().navigatePanel(a, 'chr19', 47_600_000, 47_604_000);
    // The auto-scan of the new view.
    s().setPeaksByRule(rule, [{ start: 47_601_000, end: 47_601_400, index: 0, chrom: 'chr19' } as never]);
    const stepsBefore = s()._historyStack.length;
    s().matchPanelsToPanel(a);
    expect(s()._historyStack.length).toBe(stepsBefore + 1);
    expect(s()._historyStack.map(x => x.label).some(l => /^Before match/.test(l))).toBe(false);
    expect(s().panels.find(p => p.id === b)?.viewportOverride?.start).toBe(47_600_000);
    // One Undo goes back to the step before Match, with its re-scanned peaks.
    s().undo();
    expect(s()._historyStack[s()._historyPointer].label).toMatch(/^Panel to chr19:47,600,000/);
    expect(s().panels.find(p => p.id === b)?.viewportOverride?.start).toBe(47_514_000);
    expect(s().peaksByRule[rule]?.map(p => p.start)).toEqual([47_601_000]);
    // Redo brings Match back.
    s().redo();
    expect(s().panels.find(p => p.id === b)?.viewportOverride?.start).toBe(47_600_000);
  });

  it('a change the user made (a peak selection) still gets its checkpoint', async () => {
    const { seedHistoryBaseline } = await import('../historySlice');
    const store = createTestStore();
    const s = () => store.getState();
    const rule = s().peakRules[0].id;
    s().pushSnapshot('Navigate', { kind: 'navigation' });
    s().setPeaksByRule(rule, [{ start: 10, end: 20, index: 0 } as never]);
    store.setState({ selectedPeaks: new Set([0]) } as never);
    seedHistoryBaseline(s(), 'Before sorting', 'sorting');
    expect(s()._historyStack.map(x => x.label)).toEqual(['Navigate', 'Before sorting']);
  });

  it('a peak the user drew (the custom rule) is not folded away (Codex review)', async () => {
    const { seedHistoryBaseline } = await import('../historySlice');
    const store = createTestStore();
    const s = () => store.getState();
    const custom = s().peakRules.find(r => r.source === 'custom');
    expect(custom).toBeTruthy();
    s().pushSnapshot('Navigate', { kind: 'navigation' });
    s().setPeaksByRule(custom!.id, [{ start: 10, end: 20, index: 0 } as never]);
    seedHistoryBaseline(s(), 'Before highlight', 'labeling');
    expect(s()._historyStack.map(x => x.label)).toEqual(['Navigate', 'Before highlight']);
    expect((s()._historyStack[0].state.peaksByRule as Record<string, unknown[]>)[custom!.id]).toBeUndefined();
  });
});
