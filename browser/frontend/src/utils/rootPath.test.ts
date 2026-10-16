import { afterEach, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER, installRootPath, resetRootPathForTests, rootPath, withRootPath } from './rootPath';
import { installSandbox, resetSandboxForTests, SANDBOX_HEADER } from './sandbox';

const ROOT = '/rnode/hpc-r1c2/8123';

function fakeWindow(opts: { root?: string; cookie?: string } = {}) {
  const calls: { url: string; method: string; headers: Headers }[] = [];
  const opened: string[] = [];
  const beacons: string[] = [];
  const win = {
    __FIBERBROWSER_ROOT__: opts.root,
    location: new URL(`${opts.root?.startsWith('/rnode') ? opts.root : ''}/?locus=chr1`, 'https://ondemand.example.edu'),
    document: { cookie: opts.cookie ?? '' },
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      calls.push({ url, method, headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)) });
      return new Response('{}');
    }),
    open: vi.fn((url?: string | URL) => { opened.push(String(url)); return null; }),
    navigator: { sendBeacon: (url: string) => { beacons.push(url); return true; } },
    localStorage: { getItem: () => null, setItem: () => undefined },
    addEventListener: () => undefined,
  } as Record<string, unknown>;
  return { win: win as unknown as Window, calls, opened, beacons };
}

describe('root path', () => {
  afterEach(() => { resetRootPathForTests(); resetSandboxForTests(null); });

  it('reads and validates the injected prefix', () => {
    expect(rootPath(fakeWindow({ root: ROOT + '/' }).win)).toBe(ROOT);
    expect(rootPath(fakeWindow().win)).toBe('');
    expect(rootPath(fakeWindow({ root: 'javascript:alert(1)' }).win)).toBe('');
    expect(rootPath(fakeWindow({ root: '//evil.example' }).win)).toBe('');
  });

  it('prefixes root-relative and same-origin URLs only, once', () => {
    const { win } = fakeWindow({ root: ROOT });
    expect(withRootPath('/api/datasets?x=1', win)).toBe(`${ROOT}/api/datasets?x=1`);
    expect(withRootPath(`${ROOT}/api/datasets`, win)).toBe(`${ROOT}/api/datasets`);
    expect(withRootPath('/?workspace=new', win)).toBe(`${ROOT}/?workspace=new`);
    expect(withRootPath('https://ondemand.example.edu/api/status', win)).toBe(`https://ondemand.example.edu${ROOT}/api/status`);
    expect(withRootPath('https://genome.ucsc.edu/x.bb', win)).toBe('https://genome.ucsc.edu/x.bb');
    expect(withRootPath('//cdn.example/x.js', win)).toBe('//cdn.example/x.js');
    expect(withRootPath('blob:https://ondemand.example.edu/123', win)).toBe('blob:https://ondemand.example.edu/123');
    expect(withRootPath('data:image/png;base64,AA', win)).toBe('data:image/png;base64,AA');
    expect(withRootPath('assets/x.js', win)).toBe('assets/x.js');
    // Served at the site root: nothing changes.
    expect(withRootPath('/api/datasets', fakeWindow().win)).toBe('/api/datasets');
  });

  it('routes fetch, beacons and opened windows through the prefix', async () => {
    const { win, calls, opened, beacons } = fakeWindow({ root: ROOT });
    installRootPath(win);
    await win.fetch('/api/datasets');
    await win.fetch(new Request('https://ondemand.example.edu/api/cluster', { method: 'POST' }));
    await win.fetch('https://genome.ucsc.edu/cgi-bin/hubApi');
    expect(calls.map(c => c.url)).toEqual([
      `${ROOT}/api/datasets`, `https://ondemand.example.edu${ROOT}/api/cluster`, 'https://genome.ucsc.edu/cgi-bin/hubApi']);
    win.open('/?workspace=new', '_blank');
    win.navigator.sendBeacon('/api/shutdown', '');
    expect(opened).toEqual([`${ROOT}/?workspace=new`]);
    expect(beacons).toEqual([`${ROOT}/api/shutdown`]);
  });

  it('sends the CSRF cookie as a header on same-origin state changes only', async () => {
    const { win, calls } = fakeWindow({ cookie: 'other=1; fiberbrowser_csrf=tok%3D123' });
    installRootPath(win);
    await win.fetch('/api/clear_cache', { method: 'POST' });
    await win.fetch('/api/datasets');
    await win.fetch('https://genome.ucsc.edu/x', { method: 'POST' });
    await win.fetch('/api/lab/sessions/x', { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    expect(calls.map(c => c.headers.get(CSRF_HEADER))).toEqual(['tok=123', null, null, 'tok=123']);
    expect(calls[3].headers.get('Content-Type')).toBe('application/json');
    expect(calls[0].url).toBe('/api/clear_cache');
  });

  it('works under the sandbox layer (tour tabs keep their header and get the prefix)', async () => {
    const { win, calls } = fakeWindow({ root: ROOT });
    installRootPath(win);
    installSandbox(win, 'ws-abcdefghijklmnopqrstuvwx');
    await win.fetch('/api/datasets');
    expect(calls[0].url).toBe(`${ROOT}/api/datasets`);
    expect(calls[0].headers.get(SANDBOX_HEADER)).toBe('ws-abcdefghijklmnopqrstuvwx');
  });

  it('prefixes image and link URLs set on elements', () => {
    (window as unknown as { __FIBERBROWSER_ROOT__?: string }).__FIBERBROWSER_ROOT__ = ROOT;
    try {
      installRootPath(window);
      const img = document.createElement('img');
      img.src = '/api/coacc/matrix/image?chrom=chr1';
      expect(img.getAttribute('src')).toBe(`${ROOT}/api/coacc/matrix/image?chrom=chr1`);
      const other = document.createElement('img');
      other.setAttribute('src', '/api/dafc/matrix/image');
      expect(other.getAttribute('src')).toBe(`${ROOT}/api/dafc/matrix/image`);
      const link = document.createElement('a');
      link.href = 'blob:http://localhost/abc';
      expect(link.getAttribute('href')).toBe('blob:http://localhost/abc');
      const svgUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      svgUse.setAttribute('href', '#icon');
      expect(svgUse.getAttribute('href')).toBe('#icon');
    } finally {
      delete (window as unknown as { __FIBERBROWSER_ROOT__?: string }).__FIBERBROWSER_ROOT__;
    }
  });
});
