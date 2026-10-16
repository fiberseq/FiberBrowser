import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { useSettingsHistory } from './useSettingsHistory';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Host() { useSettingsHistory(); return null; }

describe('useSettingsHistory', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('makes a quality change undoable (recorded by the colormap slice)', () => {
    useBrowserStore.setState({ _historyStack: [], _historyPointer: -1, _lastRestoreTime: 0 } as any);
    const before = useBrowserStore.getState().activeColormap.qualityFilters;
    act(() => {
      useBrowserStore.getState().setQualityFilters([...before, { layer: 'tf_sr', qualityName: 'q0', minValue: 150, enabled: true }]);
    });
    act(() => { useBrowserStore.getState().undo(); });
    expect(useBrowserStore.getState().activeColormap.qualityFilters).toEqual(before);
  });

  it('makes a saved-entry edit undoable as one step', () => {
    vi.useFakeTimers();
    const group = { id: 'g1', name: '35–80 bp @ fp1', color: '#000', sizeMin: 35, sizeMax: 80, overlapFraction: 0, enabled: true, sourceIndex: 0 } as any;
    useBrowserStore.getState().setFootprintGroups([group]);
    useBrowserStore.setState({ _historyStack: [], _historyPointer: -1, _lastRestoreTime: 0 } as any);
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => root.render(<Host />));
    act(() => {
      useBrowserStore.getState().updateFootprintGroup('g1', { sizeMin: 40 });
      useBrowserStore.getState().updateFootprintGroup('g1', { sizeMin: 45 }); // same burst
      vi.advanceTimersByTime(900);
    });
    expect(useBrowserStore.getState()._historyStack.map(s => s.label)).toEqual(['Before saved footprints', 'Saved footprints']);
    act(() => { useBrowserStore.getState().undo(); });
    expect(useBrowserStore.getState().footprintGroups[0].sizeMin).toBe(35);
    act(() => root.unmount());
  });
});
