import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const saved = vi.fn(async () => undefined);
vi.mock('./hooks/useAutoSave', async importOriginal => ({ ...(await importOriginal<typeof import('./hooks/useAutoSave')>()), autoSaveNow: () => saved() }));
import { ErrorBoundary } from './App';

function Stale(): never { throw new Error('Failed to fetch dynamically imported module: /assets/SomePanel-old.js'); }

// A panel's code from before a rebuild (the app rebuilt under an open window): the page is saved for crash recovery
// before the automatic reload, so a comparison frame or other unsaved work is offered back (owner, 6 Oct).
describe('stale chunk reload saves the page first', () => {
  it('saves, then reloads', async () => {
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, reload } });
    sessionStorage.clear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => { root.render(<ErrorBoundary><Stale /></ErrorBoundary>); });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(saved).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    Object.defineProperty(window, 'location', { configurable: true, value: original });
  });
});
