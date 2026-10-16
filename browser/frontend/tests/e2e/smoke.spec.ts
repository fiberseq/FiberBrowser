/**
 * Smoke tests: the server starts, the UI loads, the API responds.
 * If any of these fail, something fundamental is broken.
 */
import { test, expect } from './fixtures/server';

test('server /api/status returns OK', async ({ server, request }) => {
  const res = await request.get(`${server.baseUrl}/api/status`);
  expect(res.ok()).toBeTruthy();
  const json = await res.json();
  expect(json).toHaveProperty('datasets');
});

test('UI loads without console errors', async ({ server, page }) => {
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  // Named separately: the start-up genome auto-load must not leave the sequence
  // track asking a reference without these bases (no FASTA, or another species').
  const failedSequence: string[] = [];
  page.on('response', res => {
    if (res.url().includes('/api/sequence') && res.status() >= 400) failedSequence.push(`${res.status()} ${res.url()}`);
  });
  await page.goto(server.baseUrl);
  // Wait for the app to mount — the sidebar or title should appear
  await page.waitForLoadState('networkidle');
  // Allow a brief tick for late-fired errors
  await page.waitForTimeout(500);
  // Filter out known noisy warnings (unmodified by us)
  const real = errors.filter(e =>
    !e.includes('ResizeObserver') &&
    !e.includes('favicon')
  );
  expect(failedSequence, 'sequence requests the reference cannot answer').toEqual([]);
  expect(real, `Console errors: ${real.join('\n')}`).toEqual([]);
});

test('/api/reads/compact returns reads with layers', async ({ server, request }) => {
  const chromsRes = await request.get(`${server.baseUrl}/api/chroms`);
  expect(chromsRes.ok()).toBeTruthy();
  const { chroms } = await chromsRes.json();
  expect(chroms.length).toBeGreaterThan(0);

  // Try the fixture's known region first (the demo BAM's reads are all on
  // chr19 near 47.5 Mb), then walk the chrom list's first 500 kb.
  const candidates = [
    ...(server.defaultRegion ? [server.defaultRegion] : []),
    ...chroms.slice(0, 20).map((c: { name: string }) => ({ chrom: c.name, start: 0, end: 500000 })),
  ];
  let dataFound = false;
  for (const region of candidates) {
    const res = await request.get(
      `${server.baseUrl}/api/reads/compact?chrom=${region.chrom}&start=${region.start}&end=${region.end}&dataset_id=primary`
    );
    if (!res.ok()) continue;
    const data = await res.json();
    expect(data).toHaveProperty('reads');
    expect(data).toHaveProperty('available_layers');
    if ((data.reads ?? []).length > 0) {
      dataFound = true;
      break;
    }
  }
  expect(dataFound, 'No chromosome in test BAM had reads in the scanned window').toBeTruthy();
});
