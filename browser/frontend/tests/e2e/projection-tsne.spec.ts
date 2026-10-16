/**
 * t-SNE as a first-class read projection (fb-r3-tsne): Clusters > Projection
 * opens on t-SNE, its Export downloads the per-read table with the map's
 * parameters, Sort "By projection (t-SNE)" orders the reads along the map,
 * and the Neighbourhoods (t-SNE graph) cluster method runs.
 *
 * Pinned to the tracked NAPA demo BAM (chr19:47514000-47518000).
 */
import { readFileSync } from 'fs';
import { test, expect, panelButton } from './fixtures/server';
import type { Page } from '@playwright/test';
import type { ServerFixture } from './fixtures/server';

test.use({ fixtureBam: 'demo' });

async function openAt(page: Page, server: ServerFixture) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');
  const r = server.defaultRegion!;
  const reads = page.waitForResponse(res => res.url().includes('/api/reads/compact'), { timeout: 45_000 }).catch(() => null);
  await page.getByTestId('location-search-input').fill(`${r.chrom}:${r.start}-${r.end}`);
  await page.getByTestId('location-search-submit').click();
  await reads;
  await page.waitForTimeout(1500);
}

const getState = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => { const s = (window as any).__FIBERBROWSER_STORE__.getState(); return new Function('s', `return (${f})(s)`)(s); }, fn.toString()) as Promise<T>;

const assignedCount = (page: Page) => getState(page, s => Object.values(s.clusterAssignments)
  .reduce((n: number, a: any) => n + Object.keys(a || {}).length, 0));

async function clusterOnPeaks(page: Page, method: string) {
  await expect.poll(() => getState(page, s => s.getAllPeaks().length), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  await page.evaluate(m => {
    const st = (window as any).__FIBERBROWSER_STORE__.getState();
    st.replacePeakSelection([0, 1]);
    st.setClusterMethod(m);
  }, method);
  const done = page.waitForResponse(res => res.url().includes('/api/cluster_all'), { timeout: 60_000 });
  await page.getByTestId('cluster-run-button').click();
  await done;
  await expect.poll(() => assignedCount(page), { timeout: 45_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(1200); // the clustering's history step settles
}

async function openProjection(page: Page) {
  await panelButton(page, 'cluster-detail').click();
  const panel = page.locator('[data-panel-content-type="cluster-detail"]');
  await panel.locator('[data-analysis-tab="projection"]').first().click({ force: true });
  return panel;
}

test('Projection opens on t-SNE and Export downloads the per-read table', async ({ server, page }) => {
  test.setTimeout(180_000);
  await openAt(page, server);
  await clusterOnPeaks(page, 'kmeans');

  const projection = page.waitForResponse(res => res.url().includes('/api/cluster_projection'), { timeout: 90_000 });
  const panel = await openProjection(page);
  const request = (await projection).request();
  expect(JSON.parse(request.postData() || '{}').method).toBe('tsne');

  const summary = panel.getByTestId('projection-summary');
  await expect(summary).toContainText('t-SNE', { timeout: 90_000 });
  await expect(summary).toContainText('perplexity');
  await expect(summary).toContainText('seed');

  // The help says what the map does and doesn't show.
  await panel.getByRole('button', { name: /Reading the map/ }).click();
  await expect(panel.getByTestId('projection-help')).toContainText('not meaningful');

  const download = page.waitForEvent('download');
  await panel.getByTestId('projection-export').click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^tsne_reads_chr19_\d+-\d+\.tsv$/);
  const text = readFileSync(await file.path(), 'utf8');
  const lines = text.split('\n').filter(Boolean);
  expect(lines[0]).toBe('# fiberbrowser_export: read_projection');
  expect(lines).toContain('# method: tsne');
  expect(lines.some(l => /^# random_state: \d+$/.test(l))).toBe(true);
  expect(lines.some(l => /^# perplexity: \d/.test(l))).toBe(true);
  expect(lines.some(l => /^# feature_digest: [0-9a-f]{16}$/.test(l))).toBe(true);
  const body = lines.filter(l => !l.startsWith('#'));
  expect(body[0].split('\t')).toEqual(['read_name', 'dataset', 'strand', 'alignment_strand', 'cluster', 'tsne_x', 'tsne_y', 'embedded']);
  const assigned = await assignedCount(page);
  expect(body.length - 1).toBe(assigned);
  // DAF reads carry their strand.
  expect(body.slice(1).some(l => /\t(CT|GA)\t/.test(l))).toBe(true);
});

test('Sort by projection orders reads along the map; the neighbourhood-graph method clusters', async ({ server, page }) => {
  test.setTimeout(180_000);
  await openAt(page, server);
  await clusterOnPeaks(page, 'graph');
  const clusters = await getState(page, s => {
    const maps = Object.values(s.clusterAssignments) as Array<Record<string, number>>;
    return new Set(maps.flatMap(m => Object.values(m))).size;
  });
  expect(clusters).toBeGreaterThan(1);

  // Sort: By projection (t-SNE).
  const before = await getState(page, s => JSON.stringify(s.readSortOrder));
  const sorted = page.waitForResponse(res => res.url().includes('/api/sort_reads'), { timeout: 90_000 });
  await page.evaluate(() => {
    const select = Array.from(document.querySelectorAll('select'))
      .find(el => Array.from(el.options).some(o => o.value === 'projection'));
    if (!select) {
      // The Sort group is folded: open it.
      (document.querySelector('[data-testid="toolbar-group-toggle-sort"]') as HTMLElement | null)?.click();
    }
  });
  const select = page.locator('select').filter({ has: page.locator('option[value="projection"]') }).first();
  await expect(select).toBeVisible({ timeout: 10_000 });
  await select.selectOption('projection');
  await page.getByTestId('sort-run-button').click();
  const response = await sorted;
  expect(JSON.parse(response.request().postData() || '{}').sort_by).toBe('projection');
  const payload = await response.json();
  expect(payload.projection_params?.method).toBe('tsne');
  await expect.poll(() => getState(page, s => JSON.stringify(s.readSortOrder)), { timeout: 10_000 }).not.toBe(before);
  // Reads of one cluster are contiguous in the order.
  const contiguous = await getState(page, s => {
    return Object.entries(s.readSortOrder as Record<string, string[]>).every(([key, order]) => {
      const a = s.clusterAssignments[key] || {};
      const seq = order.filter(id => id in a).map(id => a[id]);
      const seen = new Set<number>();
      for (let i = 0; i < seq.length; i++) {
        if (i > 0 && seq[i] !== seq[i - 1] && seen.has(seq[i])) return false;
        seen.add(seq[i]);
      }
      return true;
    });
  });
  expect(contiguous).toBe(true);
});
