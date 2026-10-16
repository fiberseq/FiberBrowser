import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryStorage, SANDBOX_EXPIRED_EVENT, SANDBOX_HEADER, installSandbox, isSandboxPage, isWorkspacePage,
  resetSandboxForTests, sandboxId, withSandboxParam,
} from './sandbox';
import { tourRequestFromUrl, tourTabUrl } from './tourTab';

const ID = 'sb-abcdefghijklmnopqrstuvwx';

/** A window-like object with its own fetch/storage/etc., so patches stay out of jsdom's window. */
function fakeWindow() {
  const calls: { url: string; headers: Headers }[] = [];
  const opened: string[] = [];
  const beacons: string[] = [];
  const realLocal = new MemoryStorage();
  realLocal.setItem('fiberhmm_last_genome', 'mm10');
  const events = new EventTarget();
  let status = 200;
  let expiredHeader: string | null = null;
  const win = {
    location: new URL('http://localhost:8123/?sandbox=' + ID + '&tour=1'),
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, headers: new Headers(init?.headers) });
      return new Response('{}', { status, headers: expiredHeader ? { 'x-fiberbrowser-sandbox-expired': expiredHeader } : {} });
    }),
    open: vi.fn((url?: string | URL) => { opened.push(String(url)); return null; }),
    navigator: { sendBeacon: (url: string) => { beacons.push(url); return true; } },
    localStorage: realLocal,
    sessionStorage: new MemoryStorage(),
    indexedDB: { open: vi.fn() },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  } as Record<string, unknown>;
  return {
    win: win as unknown as Window,
    calls, opened, beacons, realLocal,
    respond(nextStatus: number, header: string | null) { status = nextStatus; expiredHeader = header; },
  };
}

describe('sandbox tabs', () => {
  beforeEach(() => resetSandboxForTests(null));
  afterEach(() => resetSandboxForTests(null));

  it('does nothing in a normal tab', async () => {
    const { win, calls, realLocal } = fakeWindow();
    expect(installSandbox(win)).toBeNull();
    expect(isSandboxPage()).toBe(false);
    await win.fetch('/api/datasets');
    expect(calls[0].headers.get(SANDBOX_HEADER)).toBeNull();
    expect(win.localStorage).toBe(realLocal);
    expect(withSandboxParam('/api/coacc/strip?chrom=chr1')).toBe('/api/coacc/strip?chrom=chr1');
  });

  it('refuses a malformed id', () => {
    const { win } = fakeWindow();
    expect(installSandbox(win, 'sb-short')).toBeNull();
    expect(isSandboxPage()).toBe(false);
  });

  it('names the sandbox on same-origin requests only', async () => {
    const { win, calls } = fakeWindow();
    expect(installSandbox(win, ID)).toBe(ID);
    await win.fetch('/api/datasets');
    await win.fetch('http://localhost:8123/api/status', { headers: { 'Content-Type': 'application/json' } });
    await win.fetch(new Request('http://localhost:8123/api/cluster', { method: 'POST' }));
    await win.fetch('https://api.github.com/repos/x/releases/latest');
    expect(calls.map(c => c.headers.get(SANDBOX_HEADER))).toEqual([ID, ID, ID, null]);
    expect(calls[1].headers.get('Content-Type')).toBe('application/json');
  });

  it('adds the parameter to image URLs, beacons and opened windows', () => {
    const { win, opened, beacons } = fakeWindow();
    installSandbox(win, ID);
    expect(withSandboxParam('/api/coacc/strip?chrom=chr1', win)).toBe(`/api/coacc/strip?chrom=chr1&sandbox=${ID}`);
    expect(withSandboxParam('https://genome.ucsc.edu/x.bb', win)).toBe('https://genome.ucsc.edu/x.bb');
    win.navigator.sendBeacon('/api/nl/log_session', '');
    win.open('/api/tracks/0/export', '_blank');
    expect(beacons).toEqual([`/api/nl/log_session?sandbox=${ID}`]);
    expect(opened).toEqual([`/api/tracks/0/export?sandbox=${ID}`]);
  });

  it("keeps the tab off the user's storage", () => {
    const { win, realLocal } = fakeWindow();
    installSandbox(win, ID);
    expect(win.localStorage).not.toBe(realLocal);
    expect(win.localStorage.getItem('fiberhmm_last_genome')).toBeNull();
    win.localStorage.setItem('fiberhmm_last_genome', 'hg38');
    win.sessionStorage.setItem('fiberhmm_reloading', '1');
    expect(realLocal.getItem('fiberhmm_last_genome')).toBe('mm10');
    expect(() => win.indexedDB.open('fiberhmm_history', 1)).toThrow();
    expect((win as unknown as { __FIBERHMM_PUBLIC__?: boolean }).__FIBERHMM_PUBLIC__).toBe(true);
  });

  it('says so when the sandbox has ended', async () => {
    const { win, respond } = fakeWindow();
    installSandbox(win, ID);
    const seen = vi.fn();
    win.addEventListener(SANDBOX_EXPIRED_EVENT, seen);
    respond(410, null);
    await win.fetch('/api/something-else-gone');
    expect(seen).not.toHaveBeenCalled();
    respond(410, '1');
    await win.fetch('/api/datasets');
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe('independent workspace tabs', () => {
  const WS = 'ws-abcdefghijklmnopqrstuvwx';
  beforeEach(() => resetSandboxForTests(null));
  afterEach(() => resetSandboxForTests(null));

  it('runs as its own session with the full (non-public) UI', async () => {
    const { win, calls, realLocal } = fakeWindow();
    expect(installSandbox(win, WS)).toBe(WS);
    expect(isWorkspacePage()).toBe(true);
    expect(isSandboxPage()).toBe(false);  // no tour banner or tour autostart
    await win.fetch('/api/datasets');
    expect(calls[0].headers.get(SANDBOX_HEADER)).toBe(WS);
    const flags = win as unknown as { __FIBERHMM_PUBLIC__?: boolean; __FIBERBROWSER_WORKSPACE__?: boolean };
    expect(flags.__FIBERHMM_PUBLIC__).toBeUndefined();
    expect(flags.__FIBERBROWSER_WORKSPACE__).toBe(true);
    expect(win.localStorage).not.toBe(realLocal);
    expect(withSandboxParam('/api/coacc/strip?chrom=chr1', win)).toBe(`/api/coacc/strip?chrom=chr1&sandbox=${WS}`);
  });

  it('reads its id from the workspace parameter of the address', async () => {
    const original = window.location.href;
    window.history.replaceState(null, '', `/?workspace=${WS}&locus=eve`);
    try {
      vi.resetModules();
      const fresh = await import('./sandbox');
      expect(fresh.sandboxId()).toBe(WS);
      expect(fresh.isWorkspacePage()).toBe(true);
      window.history.replaceState(null, '', '/?workspace=new');
      vi.resetModules();
      expect((await import('./sandbox')).sandboxId()).toBeNull();
    } finally {
      window.history.replaceState(null, '', original);
      vi.resetModules();
    }
  });
});

describe('tour tab URLs', () => {
  it('round-trips the tour request', () => {
    const url = tourTabUrl(ID, { stepId: 'clustering' });
    expect(url).toBe(`/?sandbox=${ID}&tour=1&step=clustering`);
    expect(tourRequestFromUrl(url.slice(1))).toEqual({ tour: true, stepId: 'clustering' });
    expect(tourRequestFromUrl(`?sandbox=${ID}`)).toEqual({ tour: false });
    expect(tourRequestFromUrl(tourTabUrl(ID).slice(1))).toEqual({ tour: true });
  });
});
