/**
 * Opening a session link, end to end, on a server with its access token:
 *
 * - a page on another site (127.0.0.1, the "portal") links to
 *   http://localhost:<port>/?session=<its session.json>; the click arrives
 *   without the SameSite=Strict token cookie, lands on /open, which only
 *   stores the link and goes on to /?open_link=<id>;
 * - the signed-in browser asks first (the document is on a local-network
 *   address), then shows "Open 2 tracks from 127.0.0.1?" and loads nothing
 *   until Open; pre-signed URLs never reach the page;
 * - a browser without the token gets the access page, and a used link can't
 *   be replayed.
 *
 * Files: tests/make_link_fixture.py (data + session.json), tests/link_fixtures.py
 * (a range-capable file server that enforces ?sig=).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pickRandomPort, startServer, stopServer } from './fixtures/server';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.FIBERBROWSER_TEST_DIR ? path.resolve(process.env.FIBERBROWSER_TEST_DIR) : path.resolve(HERE, '../../../..');
const PYTHON = process.env.FIBERBROWSER_TEST_PYTHON?.trim() || 'python';
const TOKEN = 'e2e-session-link-token-0123456789abcdef';

async function waitFor(check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await check()) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('timed out');
}

let files: ChildProcess | null = null;
let fiberbrowser: ChildProcess | null = null;
let fbBase = '';
let filesBase = '';
let dataDir = '';

test.beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-links-'));
  const made = spawnSync(PYTHON, [path.join(REPO_ROOT, 'tests', 'make_link_fixture.py'), dataDir], { encoding: 'utf-8' });
  if (made.status !== 0) throw new Error(`make_link_fixture.py failed: ${made.stderr}`);

  const portFile = path.join(dataDir, 'port');
  files = spawn(PYTHON, [path.join(REPO_ROOT, 'tests', 'link_fixtures.py'), dataDir, path.join(dataDir, 'config.json'),
    path.join(dataDir, 'hits.txt'), portFile], { stdio: 'ignore' });
  await waitFor(async () => existsSync(portFile) && readFileSync(portFile, 'utf-8').trim() !== '');
  filesBase = `http://127.0.0.1:${readFileSync(portFile, 'utf-8').trim()}`;

  const started = await startServer(null, await pickRandomPort(), { token: TOKEN });
  fiberbrowser = started;
  fbBase = started.baseUrl;

  // The "portal": a page on another site with an ordinary link to FiberBrowser.
  const link = `${fbBase}/?session=${encodeURIComponent(`${filesBase}/session.json`)}`;
  writeFileSync(path.join(dataDir, 'portal.html'),
    `<!doctype html><html><body><a id="open" href="${link.replace(/&/g, '&amp;')}">Open in FiberBrowser</a></body></html>`);
});

test.afterAll(async () => {
  if (fiberbrowser) await stopServer(fiberbrowser);
  if (files) await stopServer(files);
});

const api = (p: string) => fetch(`${fbBase}${p}`, { headers: { 'X-FiberBrowser-Token': TOKEN } }).then(r => r.json());

test('a link from another site is confirmed before anything loads, once', async ({ browser }) => {
  const owner = await browser.newContext();
  await owner.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
  });
  const page = await owner.newPage();
  // The owner opened FiberBrowser with its access link earlier (cookie set).
  await page.goto(`${fbBase}/?token=${TOKEN}`);
  await page.waitForLoadState('networkidle');
  expect((await api('/api/datasets')).datasets).toHaveLength(0);

  // Click the link on the other site's page.
  await page.goto(`${filesBase}/portal.html`);
  await page.click('#open');
  const dialog = page.getByTestId('session-link-dialog');
  await expect(dialog).toBeVisible();
  // The link left the address bar (it may carry a pre-signed URL).
  await expect.poll(() => {
    const params = new URL(page.url()).searchParams;
    return ['session', 'open_link', 'token'].filter(k => params.has(k));
  }).toEqual([]);
  // An http address on the local network: asked before it is even fetched.
  await expect(page.getByTestId('session-link-question')).toContainText('Review a link from 127.0.0.1');
  const hitsBefore = readFileSync(path.join(dataDir, 'hits.txt'), 'utf-8');
  expect(hitsBefore).not.toContain('session.json');
  await page.getByTestId('session-link-fetch').click();

  await expect(page.getByTestId('session-link-question')).toHaveText('Open 2 tracks from 127.0.0.1?');
  await expect(page.getByTestId('session-link-source')).toContainText('session at 127.0.0.1');
  await expect(page.getByTestId('session-link-track')).toHaveCount(2);
  await expect(dialog).toContainText('Demo reads');
  await expect(dialog).toContainText('signed link');
  expect(await page.content()).not.toContain('BAMSIG');
  // Previewing never touches the track files, and nothing is loaded yet.
  const hitsPreview = readFileSync(path.join(dataDir, 'hits.txt'), 'utf-8');
  expect(hitsPreview).not.toMatch(/s1\.bam|cov\.bw/);
  expect((await api('/api/datasets')).datasets).toHaveLength(0);

  await page.getByTestId('session-link-open').click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  const datasets = (await api('/api/datasets')).datasets;
  expect(datasets.map((d: any) => d.label)).toEqual(['Demo reads']);
  expect(datasets[0].path).toBe(`${filesBase}/s1.bam`);
  const tracks = (await api('/api/tracks')).tracks;
  expect(tracks.map((t: any) => t.path)).toEqual([`${filesBase}/cov.bw`]);
  const state = await page.evaluate(() => JSON.stringify(localStorage));
  expect(state).not.toContain('SIG');
  expect(await page.content()).not.toContain('BWSIG');
  // The track is in the cart with the link's colour; the dataset has its colour too.
  const shown = await page.evaluate(() => {
    const store = (window as any).__FIBERBROWSER_STORE__.getState();
    return {
      composites: store.compositeTracks.map((c: any) => [c.label, c.sources[0]?.color]),
      datasetColor: store.datasets[0]?.color,
    };
  });
  // The link's locus, not the server's default start position.
  await expect.poll(() => page.evaluate(() => {
    const store = (window as any).__FIBERBROWSER_STORE__.getState();
    return `${store.chrom}:${store.start}-${store.end}`;
  })).toBe('chr19:47514000-47518000');
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => {
    const store = (window as any).__FIBERBROWSER_STORE__.getState();
    return `${store.chrom}:${store.start}-${store.end}`;
  })).toBe('chr19:47514000-47518000');
  expect(shown.composites).toContainEqual(['Demo coverage', '#1f77b4']);
  expect(shown.datasetColor).toBe('#d62728');

  // The same link id can't be used again.
  const html = await (await fetch(`${fbBase}/open?session=${encodeURIComponent(`${filesBase}/session.json`)}`)).text();
  const id = /open_link=([A-Za-z0-9_-]+)/.exec(html)![1];
  await page.goto(`${fbBase}/?open_link=${id}`);
  await expect(page.getByTestId('session-link-question')).toContainText('Review a link');
  await page.getByTestId('session-link-fetch').click();
  await page.getByTestId('session-link-cancel').click();
  await page.goto(`${fbBase}/?open_link=${id}`);
  await expect(page.getByTestId('session-link-error')).toContainText('expired or was already opened');
  expect((await api('/api/datasets')).datasets).toHaveLength(1);
  await owner.close();
});

test('a browser without the access token gets the access page, not the data', async ({ browser }) => {
  const stranger = await browser.newContext();
  const page = await stranger.newPage();
  const before = (await api('/api/datasets')).datasets.length;
  await page.goto(`${filesBase}/portal.html`);
  await page.click('#open');
  await expect(page.getByText('Open FiberBrowser with its access link')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('open_link')).toBeTruthy();
  expect((await api('/api/datasets')).datasets.length).toBe(before);
  await stranger.close();
});
