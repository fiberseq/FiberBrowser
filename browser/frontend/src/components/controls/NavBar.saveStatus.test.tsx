import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/session')>()),
  downloadSession: vi.fn(async () => 'fiberhmm_session_20261006_120000.json'),
}));

import { useBrowserStore } from '../../stores/browserStore';
import '../../plugins/builtinPanels';
import { NavBar } from './NavBar';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Usability round 3, R11: Save downloaded the session with only a 1.5-s button state; a polite status line names it.
describe('toolbar Save', () => {
  const initial = useBrowserStore.getState();
  afterEach(() => { useBrowserStore.setState(initial, true); vi.useRealTimers(); });

  it('says which file it downloaded, in a polite status line that goes after a while', async () => {
    useBrowserStore.setState({ publicMode: false } as never);
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const box = document.createElement('div');
    document.body.appendChild(box);
    const root = createRoot(box);
    await act(async () => root.render(<NavBar loading={false} scanning={false} clustering={false} />));
    const status = () => document.querySelector('[data-testid="save-session-status"]')!;
    expect(status().getAttribute('role')).toBe('status');
    expect(status().getAttribute('aria-live')).toBe('polite');
    expect(status().textContent).toBe('');
    await act(async () => (box.querySelector('[data-testid="save-session-button"]') as HTMLButtonElement).click());
    expect(status().textContent).toBe('Session downloaded: fiberhmm_session_20261006_120000.json');
    expect(status().className).toContain('fixed bottom-5 left-1/2');
    expect(status().className).not.toContain('top-full');
    expect(status().parentElement).toBe(document.body);
    await act(async () => { vi.advanceTimersByTime(5999); });
    expect(status().textContent).toContain('Session downloaded:');
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(status().textContent).toBe('');
    act(() => root.unmount());
    box.remove();
  });
});
