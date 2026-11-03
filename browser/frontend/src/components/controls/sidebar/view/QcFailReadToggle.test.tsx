import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { QcFailReadToggle } from './FootprintReadFilters';
import { useBrowserStore } from '../../../../stores/browserStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('QC-fail read toggle', () => {
  it('defaults off and refreshes read requests when toggled', () => {
    expect(useBrowserStore.getState().showQcFailReads).toBe(false);
    const generation = useBrowserStore.getState().refreshGeneration;
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      act(() => root.render(<QcFailReadToggle />));
      const toggle = container.querySelector<HTMLInputElement>('input')!;
      expect(container.textContent).toContain('Show QC-fail reads (incl. FiberHMM chimeras)');
      expect(toggle.checked).toBe(false);
      act(() => toggle.click());
      expect(useBrowserStore.getState().showQcFailReads).toBe(true);
      expect(useBrowserStore.getState().refreshGeneration).toBe(generation + 1);
      act(() => toggle.click());
      expect(useBrowserStore.getState().showQcFailReads).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });
});
