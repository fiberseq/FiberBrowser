import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavigationModeToggle } from './NavigationModeToggle';
import { useBrowserStore } from '../../stores/browserStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('navigation toggle (fb-r3-nav)', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({ navigationMode: 'linked', navigationNotice: null });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("Linked's tooltip says the panels on each genome share one locus, and which one they go to", () => {
    act(() => root.render(<NavigationModeToggle />));
    const linked = container.querySelector<HTMLButtonElement>('[data-testid="nav-mode-linked"]')!;
    expect(linked.title).toMatch(/same genome share one locus/);
    expect(linked.title).toMatch(/where you last moved one of them \(else its first panel\)/);
  });

  it('says briefly when the mode was switched for you, then the note goes', () => {
    vi.useFakeTimers();
    act(() => root.render(<NavigationModeToggle />));
    expect(container.querySelector('[data-testid="navigation-mode-notice"]')).toBeNull();
    act(() => useBrowserStore.setState({ navigationMode: 'perPanel', navigationNotice: 'Switched to Per panel: …' }));
    const note = container.querySelector('[data-testid="navigation-mode-notice"]')!;
    expect(note.getAttribute('role')).toBe('status');
    expect(note.textContent).toContain('Switched to Per panel');
    act(() => { vi.advanceTimersByTime(9_000); });
    expect(container.querySelector('[data-testid="navigation-mode-notice"]')).toBeNull();
    // Switching by hand clears it.
    act(() => useBrowserStore.setState({ navigationNotice: 'x' }));
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="nav-mode-linked"]')!.click());
    expect(useBrowserStore.getState().navigationNotice).toBeNull();
  });
});
