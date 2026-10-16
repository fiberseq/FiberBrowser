import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchApiResponse = vi.fn();
vi.mock('../../../../api/sharedFetch', () => ({ fetchApiResponse: (...args: unknown[]) => fetchApiResponse(...args) }));
vi.mock('./LabSessionShelf', () => ({ LabSessionShelf: () => null }));

import { SessionPersistenceControls } from './SessionPersistenceControls';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('New Independent Workspace', () => {
  let container: HTMLDivElement;
  let root: Root;
  let opened: Array<string | URL | undefined>;
  let tab: { location: { href: string }; close: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    opened = [];
    tab = { location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockImplementation(((url?: string | URL) => {
      opened.push(url);
      return tab as unknown as Window;
    }) as typeof window.open);
    fetchApiResponse.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (window as any).__FIBERBROWSER_LAB__;
    vi.restoreAllMocks();
  });

  const click = async () => {
    await act(async () => {
      (container.querySelector('[data-testid="new-workspace"]') as HTMLButtonElement).click();
    });
  };

  it('opens /?workspace=new on a personal server', async () => {
    act(() => root.render(<SessionPersistenceControls setError={vi.fn()} />));
    await click();
    expect(opened).toEqual(['/?workspace=new']);
    expect(fetchApiResponse).not.toHaveBeenCalled();
  });

  it('starts it with a POST on a lab server (a page load never creates one there)', async () => {
    (window as any).__FIBERBROWSER_LAB__ = { user: 'alice', role: 'member', auth: 'accounts', anonymous: false, jobs: false };
    fetchApiResponse.mockResolvedValue(new Response(JSON.stringify({ success: true, id: 'ws-x', url: '/?workspace=ws-abcdefghijklmnop' }),
      { status: 200 }));
    act(() => root.render(<SessionPersistenceControls setError={vi.fn()} />));
    await click();
    expect(fetchApiResponse).toHaveBeenCalledWith('/api/workspaces', { method: 'POST' });
    expect(opened).toEqual(['']);
    expect(tab.location.href).toContain('/?workspace=ws-abcdefghijklmnop');
  });

  it('closes the blank tab and reports a refusal', async () => {
    (window as any).__FIBERBROWSER_LAB__ = { user: 'alice', role: 'member', auth: 'accounts', anonymous: false, jobs: false };
    fetchApiResponse.mockResolvedValue(new Response(JSON.stringify({ detail: 'This server already has 8 workspaces open.' }),
      { status: 503 }));
    const setError = vi.fn();
    act(() => root.render(<SessionPersistenceControls setError={setError} />));
    await click();
    expect(tab.close).toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith('This server already has 8 workspaces open.');
  });
});
