import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { FootprintReadFilters, FOOTPRINT_FILTER_SETTINGS } from './FootprintReadFilters';
import { useBrowserStore } from '../../../../stores/browserStore';
import { DEFAULT_MIN_FOOTPRINTS, MIN_FOOTPRINTS_ALL_READS } from '../../../../stores/uiSlice';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('Min footprints: "All reads, including uncalled"', () => {
  it('is the last choice of the Min footprints control and sets the -1 value', () => {
    useBrowserStore.setState({ minFootprints: 3, minFootprintsAuto: false } as any);
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      act(() => root.render(<FootprintReadFilters />));
      expect(container.querySelector('[data-testid="hide-uncalled-reads"]')).toBeNull();
      const control = container.querySelector('[data-setting-id="view.min-footprints"]')!;
      const choice = control.querySelector<HTMLLabelElement>('[data-testid="min-footprints-all-reads"]')!;
      // The last thing in the control.
      expect(control.lastElementChild).toBe(choice);
      expect(choice.textContent).toBe('All reads, including uncalled');
      expect(choice.title).toContain('hides reads without footprint calls at every value');
      const number = control.querySelector<HTMLInputElement>('input[type="number"]')!;
      const box = choice.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      expect(box.checked).toBe(false);
      act(() => box.click());
      expect(useBrowserStore.getState().minFootprints).toBe(MIN_FOOTPRINTS_ALL_READS);
      expect(box.checked).toBe(true);
      expect(number.disabled).toBe(true);
      expect(number.value).toBe('0');
      act(() => box.click());
      // Leaving it returns to the threshold in use before (uncalled reads hidden again).
      expect(useBrowserStore.getState().minFootprints).toBe(3);
      expect(number.disabled).toBe(false);
      expect(number.value).toBe('3');
      // From 0 ("every called read") and back.
      act(() => useBrowserStore.getState().setMinFootprints(0));
      act(() => box.click());
      expect(useBrowserStore.getState().minFootprints).toBe(MIN_FOOTPRINTS_ALL_READS);
      act(() => box.click());
      expect(useBrowserStore.getState().minFootprints).toBe(0);
    } finally {
      act(() => root.unmount());
      useBrowserStore.setState({ minFootprints: DEFAULT_MIN_FOOTPRINTS, minFootprintsAuto: true } as any);
    }
  });

  it('has no separate setting; Min footprints is found by the uncalled words', () => {
    expect((FOOTPRINT_FILTER_SETTINGS as Record<string, unknown>).hideUncalledReads).toBeUndefined();
    expect(FOOTPRINT_FILTER_SETTINGS.minFootprints.keywords).toContain('all reads, including uncalled');
    expect('hideUncalledReads' in useBrowserStore.getState()).toBe(false);
  });

  it('the automatic relax never turns it on (0 keeps uncalled reads hidden)', () => {
    useBrowserStore.setState({ minFootprints: DEFAULT_MIN_FOOTPRINTS, minFootprintsAuto: true, minFootprintsNotice: null } as any);
    expect(useBrowserStore.getState().relaxDefaultMinFootprints({ datasetId: 'ds', label: 'ds', hidden: 100 })).toBe(true);
    expect(useBrowserStore.getState().minFootprints).toBe(0);
    useBrowserStore.setState({ minFootprints: MIN_FOOTPRINTS_ALL_READS, minFootprintsAuto: true } as any);
    expect(useBrowserStore.getState().relaxDefaultMinFootprints({ datasetId: 'ds', label: 'ds', hidden: 100 })).toBe(false);
    useBrowserStore.setState({ minFootprints: DEFAULT_MIN_FOOTPRINTS, minFootprintsAuto: true, minFootprintsNotice: null } as any);
  });
});

describe('copilot set_min_footprints', () => {
  it('accepts the "All reads, including uncalled" choice by name or as -1', async () => {
    const { executeBrowserAction } = await import('../../../../actions/browserActions');
    for (const value of ['all', 'All reads, including uncalled', -1]) {
      useBrowserStore.setState({ minFootprints: 5 } as any);
      const message = await executeBrowserAction({ type: 'set_min_footprints', value } as any);
      expect(useBrowserStore.getState().minFootprints).toBe(MIN_FOOTPRINTS_ALL_READS);
      expect(String(message)).toContain('All reads, including uncalled');
    }
    await executeBrowserAction({ type: 'set_min_footprints', value: 0 } as any);
    expect(useBrowserStore.getState().minFootprints).toBe(0);
    useBrowserStore.setState({ minFootprints: DEFAULT_MIN_FOOTPRINTS, minFootprintsAuto: true } as any);
  });
});
