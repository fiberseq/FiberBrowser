import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { WelcomeLibraryButton } from './WelcomeLoadFileButton';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Owner, 1 Oct: the welcome screen offers the Library beside "Load a file".
describe('Welcome screen: Open from Library', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    useBrowserStore.setState({ publicMode: false } as never);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useBrowserStore.setState({ publicMode: false } as never);
  });

  it('opens the Library window', async () => {
    const opened: unknown[] = [];
    const onOpen = (e: Event) => opened.push((e as CustomEvent).detail);
    window.addEventListener('fiberbrowser:open-library', onOpen);
    try {
      await act(async () => root.render(<WelcomeLibraryButton />));
      const tile = container.querySelector<HTMLButtonElement>('[data-testid="welcome-library-cta"]')!;
      expect(tile).not.toBeNull();
      expect(tile.textContent).toContain('Open from Library');
      await act(async () => tile.click());
      expect(opened).toHaveLength(1);
    } finally {
      window.removeEventListener('fiberbrowser:open-library', onOpen);
    }
  });

  it('is not offered on a public server', async () => {
    useBrowserStore.setState({ publicMode: true } as never);
    await act(async () => root.render(<WelcomeLibraryButton />));
    expect(container.querySelector('[data-testid="welcome-library-cta"]')).toBeNull();
  });
});
