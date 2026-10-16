import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { ViewToggles } from './ZoomControls';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('ViewToggles (owner, 6 Oct): Full-length stays on in Per panel mode', () => {
  let container: HTMLDivElement;
  afterEach(() => container?.remove());

  it('Per panel: Full-length works; Reverse and TSS± are off with the main navigation', () => {
    useBrowserStore.setState({ spanningOnly: false, isReversed: false, showRelativeCoords: false, selectedGenes: [] } as never);
    container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<ViewToggles navDisabled />));
    const [full, reverse, tss] = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(full.disabled).toBe(false);
    expect(reverse.disabled).toBe(true);
    expect(tss.disabled).toBe(true);
    act(() => full.click());
    expect(useBrowserStore.getState().spanningOnly).toBe(true);
    act(() => root.unmount());
  });

  it('linked navigation: Reverse works', () => {
    useBrowserStore.setState({ isReversed: false } as never);
    container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<ViewToggles />));
    const reverse = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1];
    expect(reverse.disabled).toBe(false);
    act(() => root.unmount());
  });
});
