/**
 * A `--public` server with the demo catalog (deploy/demo/catalog.json), as an
 * anonymous visitor sees it: the page runs under the public server's
 * Content-Security-Policy with no violations, the catalog dataset loads and
 * its reads draw, the Tracks panel offers motifs only (no files, uploads, URLs
 * or track hubs), and the server refuses what a visitor must not do.
 *
 * Spawns its own server (`--public --catalog`), not the BAM fixture's.
 */
import { startServer, stopServer, pickRandomPort, testPorts } from './fixtures/server';
import path from 'path';
import { fileURLToPath } from 'url';
import { test as base, expect } from './fixtures/nativeDialogs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.FIBERBROWSER_TEST_DIR
  ? path.resolve(process.env.FIBERBROWSER_TEST_DIR)
  : path.resolve(__dirname, '../../../..');
const DEMO_CATALOG = path.join(REPO_ROOT, 'deploy', 'demo', 'catalog.json');
const LOCUS = 'chr19:47515640-47517640';

const test = base.extend<{}, { publicServer: { baseUrl: string } }>({
  publicServer: [async ({}, use) => {
    const proc = await startServer(null, await pickRandomPort(), { public: true, extraArgs: ['--catalog', DEMO_CATALOG] });
    try { await use({ baseUrl: proc.baseUrl }); }
    finally { await stopServer(proc); }
  }, { scope: 'worker' }],
});

test.describe('public server', () => {
  test('a visitor browses the catalog under the CSP, with no host-only controls', async ({ page, publicServer }) => {
    test.setTimeout(120_000);
    const violations: string[] = [];
    const pageErrors: string[] = [];
    const refused: string[] = [];
    page.on('console', message => {
      if (/Content Security Policy|Refused to (load|execute|apply|connect)/i.test(message.text())) violations.push(message.text());
    });
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.pathname.startsWith('/api/') && response.status() >= 400) {
        refused.push(`${response.status()} ${response.request().method()} ${url.pathname}`);
      }
    });
    await page.addInitScript(() => {
      (window as unknown as { __FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD?: boolean }).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
      document.addEventListener('securitypolicyviolation', event => {
        console.error(`Content Security Policy violation: ${event.violatedDirective} ${event.blockedURI}`);
      });
    });

    const first = await page.goto(publicServer.baseUrl);
    const csp = first?.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).toContain("frame-ancestors 'none'");
    await expect(page.locator('[data-testid="panel-rail"], [data-testid="analysis-strip"]')).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => (window as unknown as { __FIBERHMM_PUBLIC__?: boolean }).__FIBERHMM_PUBLIC__)).toBe(true);

    // Load the catalog's dataset (as the sidebar's catalog section does) and open the locus.
    const loaded = await page.evaluate(async () => (await (await fetch('/api/catalog/load?group_index=0', { method: 'POST' })).json()));
    expect(loaded.success).toBe(true);
    const reads = page.waitForResponse(r => r.url().includes('/api/reads/compact') && r.status() === 200, { timeout: 60_000 });
    await page.goto(`${publicServer.baseUrl}/?locus=${LOCUS}`);
    await reads;
    await expect.poll(async () => page.locator('[data-read-track-state-key]').evaluateAll(els =>
      els.reduce((n, el) => n + Number(el.getAttribute('data-read-track-render-count') ?? 0), 0)), { timeout: 60_000 })
      .toBeGreaterThan(0);

    // The Tracks panel: motifs and combined tracks, nothing that names a file or URL.
    await page.locator('[data-testid="panel-rail-track-browser"], [data-testid="analysis-strip-button-track-browser"]').click();
    const box = page.getByTestId('add-track-box');
    await expect(box).toBeVisible();
    await expect(box.getByRole('button', { name: 'Browse files…' })).toHaveCount(0);
    await expect(box.getByRole('button', { name: 'Upload…' })).toHaveCount(0);
    await expect(box.getByRole('button', { name: 'Browse hubs…' })).toHaveCount(0);
    await expect(box.getByLabel('Add a track')).toHaveAttribute('placeholder', /motif/i);
    await box.getByLabel('Add a track').fill('CACGTG');
    await expect(page.getByRole('option', { name: /Add sequence motif/ })).toBeVisible();

    expect(violations, violations.join('\n')).toEqual([]);
    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
    // The page asks for nothing a public server refuses (no host files, no external search).
    expect(refused.filter(r => !r.startsWith('429')), refused.join('\n')).toEqual([]);
  });

  test('the server refuses what an anonymous visitor must not do', async ({ request, publicServer }) => {
    const base = publicServer.baseUrl;
    for (const docs of ['/docs', '/redoc', '/openapi.json']) {
      expect((await request.get(`${base}${docs}`)).status(), docs).toBe(404);
    }
    const health = await request.get(`${base}/api/health`);
    expect(health.status()).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });
    const upload = await request.post(`${base}/api/files/upload`, {
      multipart: { file: { name: 'x.bam', mimeType: 'application/octet-stream', buffer: Buffer.from('BAM\u0001') } },
    });
    expect([403, 415]).toContain(upload.status());
    const addTrack = await request.post(`${base}/api/add_track?path=${encodeURIComponent('https://www.encodeproject.org/x.bigWig')}`);
    expect(addTrack.status()).toBe(403);
    expect((await request.get(`${base}/api/ucsc/search?genome=hg38&q=ctcf`)).status()).toBe(403);
    expect((await request.get(`${base}/api/files/list?path=/`)).status()).toBe(403);
    const hashed = await request.get(`${base}/`);
    const script = /src="(\/assets\/index-[^"]+\.js)"/.exec(await hashed.text())?.[1];
    expect(script).toBeTruthy();
    expect((await request.get(`${base}${script}`)).headers()['cache-control']).toContain('immutable');
  });
});

base('a busy port keeps its server alive and the new fixture follows its own port', async () => {
  const first = await startServer(null, await pickRandomPort());
  try {
    const second = await startServer(null, first.port);
    try {
      expect(second.port).not.toBe(first.port);
      expect(testPorts()).toContain(second.port);
      expect(first.exitCode).toBeNull();
      expect(first.signalCode).toBeNull();
      const launch = async (url: string) => (await (await fetch(`${url}/api/session/launch`)).json()).boot_id;
      expect(await launch(first.baseUrl)).not.toBe(await launch(second.baseUrl));
      expect((await fetch(`${first.baseUrl}/api/health`)).ok).toBe(true);
    } finally { await stopServer(second); }
  } finally { await stopServer(first); }
});
