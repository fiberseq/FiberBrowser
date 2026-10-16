import { test, expect } from './fixtures/server';

test('performance modes change the live browser and server and survive reload', async ({ server, page, request }) => {
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
  });
  await page.goto(server.baseUrl);
  await page.waitForFunction(() => (window as any).__FIBERBROWSER_STORE__?.getState().datasets.length);
  await page.getByTestId('settings-rail-view').click();
  const mode = page.getByTestId('performance-mode');
  await expect(mode).toBeVisible();
  await mode.selectOption('low');
  await expect(page.getByTestId('performance-mode-description')).toContainText('1× canvases');
  await expect.poll(async () => (await (await request.get(`${server.baseUrl}/api/app/performance`)).json()).effective).toBe('low');
  const low = await (await request.get(`${server.baseUrl}/api/app/performance`)).json();
  expect(low.max_working_reads).toBe(2000);
  expect(low.margin_fraction).toBe(0);
  expect(low.readers.limit).toBe(32);
  expect(low.readers.open).toBeLessThanOrEqual(low.readers.limit);
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().allReadsDisplayCap)).toBe(1000);
  await page.reload();
  if (!await mode.isVisible()) await page.getByTestId('settings-rail-view').click();
  await expect.poll(async () => (await (await request.get(`${server.baseUrl}/api/app/performance`)).json()).mode).toBe('low');
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__?.getState().allReadsDisplayCap)).toBe(1000);
  await expect(mode).toBeVisible();
  await mode.selectOption('high');
  await expect.poll(async () => (await (await request.get(`${server.baseUrl}/api/app/performance`)).json()).effective).toBe('high');
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().allReadsDisplayCap)).toBe(2000);
  // A machine preference changed in another workspace is picked up on return.
  await request.post(`${server.baseUrl}/api/app/performance`, { data: { mode: 'low' } });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(mode).toHaveValue('low');
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().allReadsDisplayCap)).toBe(1000);
  await mode.selectOption('standard');
  await expect.poll(async () => (await (await request.get(`${server.baseUrl}/api/app/performance`)).json()).effective).toBe('standard');
  const standard = await (await request.get(`${server.baseUrl}/api/app/performance`)).json();
  expect(standard.readers.limit).toBe(128);
  expect(standard.readers.open).toBeLessThanOrEqual(standard.readers.limit);
});

for (const mode of ['low', 'standard', 'high', 'auto']) {
  test(`${mode} paints before automatic scans and prefetch`, async ({ server, page, request }) => {
    await request.post(`${server.baseUrl}/api/app/performance`, { data: { mode, persist: false } });
    await page.addInitScript(() => {
      (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
      (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    });
    let release = () => {};
    const visible = new Promise<void>(resolve => { release = resolve; });
    const requests: string[] = [];
    const speculativePaints: Promise<number>[] = [];
    page.on('request', r => {
      requests.push(r.url());
      if (r.url().includes('prefetch=true') || r.url().includes('/api/reads/regions')) {
        speculativePaints.push(page.evaluate(() => performance.getEntriesByName('read-view-painted').length));
      }
    });
    await page.route('**/api/reads/compact*', async route => {
      if (!new URL(route.request().url()).searchParams.has('prefetch')) await visible;
      await route.continue();
    });
    const region = server.defaultRegion!;
    await page.goto(`${server.baseUrl}/?chr=${region.chrom}&start=${region.start}&end=${region.end}`);
    try {
      await expect.poll(() => requests.filter(url => url.includes('/api/reads/compact')).length).toBeGreaterThan(0);
      await page.waitForTimeout(1000);
      expect(requests.filter(url => url.includes('prefetch=true') || url.includes('/api/reads/regions') || url.includes('/api/scan_peaks'))).toEqual([]);
      const foreground = requests.filter(url => url.includes('/api/reads/compact'));
      expect(new Set(foreground.map(url => new URL(url).searchParams.get('refresh_generation'))).size).toBe(1);
      expect(requests.filter(url => new URL(url).pathname === '/api/status')
        .every(url => new URL(url).searchParams.get('initial_position') === 'false')).toBe(true);
    } finally { release(); }
    await expect.poll(() => page.evaluate(() => performance.getEntriesByName('read-view-painted').length)).toBe(1);
    await expect.poll(() => requests.some(url => url.includes('/api/reads/regions')), { timeout: 30000 }).toBe(true);
    if (mode === 'low') expect(requests.some(url => url.includes('prefetch=true'))).toBe(false);
    else await expect.poll(() => requests.some(url => url.includes('prefetch=true')), { timeout: 30000 }).toBe(true);
    expect(await Promise.all(speculativePaints)).not.toContain(0);
  });
}
