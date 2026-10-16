import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useUrlSync } from './useUrlSync';
import { useBrowserStore } from '../stores/browserStore';

describe('Copy Link', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  afterEach(() => {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    vi.restoreAllMocks();
  });

  it('falls back to select-and-copy when the Clipboard API is missing', () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    let hook: ReturnType<typeof useUrlSync> | null = null;
    function Host() {
      hook = useUrlSync();
      return null;
    }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(<Host />));
    expect(() => act(() => { hook!.handleCopyLink(); })).not.toThrow();
    expect(exec).toHaveBeenCalledWith('copy');
    expect(hook!.linkCopied).toBe(true);
    act(() => root.unmount());
  });

  it('copies the current view, even if the address bar is behind it', async () => {
    window.history.replaceState(null, '', '/?chr=chr1&start=1000&end=5000');
    let written = '';
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async (t: string) => { written = t; }) }, configurable: true,
    });
    let hook: ReturnType<typeof useUrlSync> | null = null;
    function Host() {
      hook = useUrlSync();
      return null;
    }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(<Host />));
    // Opened at the URL's locus, then moved within the first 500 ms: the URL
    // wasn't rewritten yet.
    act(() => { useBrowserStore.setState({ chrom: 'chr8', start: 127735434, end: 127742951 }); });
    expect(window.location.search).toContain('chr=chr1');
    await act(async () => { hook!.handleCopyLink(); });
    const params = new URL(written).searchParams;
    expect([params.get('chr'), params.get('start'), params.get('end'), params.get('shared')])
      .toEqual(['chr8', '127735434', '127742951', '1']);
    act(() => root.unmount());
  });
});
