/**
 * Headless pooled loci against the browser, same pool and seed: a BED tiled over the demo BAM opened as a meta-locus
 * in the browser (⌘K), then
 * - the headless figure (POST /api/render with meta_locus) draws exactly the reads the tab fetched for its working set,
 *   and every read the tab draws is among them;
 * - the headless Quantify (POST /api/meta_locus/quantify, the card's Python twin) gives the card's TSV rows for the
 *   same window and measures.
 */
import { test, expect } from './fixtures/server';
import type { Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';

test.use({ fixtureBam: 'demo' });

const store = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => new Function('s', `return (${f})(s)`)((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;

function demoBed(path: string, region: { chrom: string; start: number; end: number }): void {
  const lines: string[] = [];
  for (let i = 0, x = region.start + 600; x < region.end - 600; i++, x += 250) {
    lines.push(`${region.chrom}\t${x}\t${x + 1}\tsite${i}\t0\t${i % 2 ? '-' : '+'}`);
  }
  writeFileSync(path, `${lines.join('\n')}\n`);
}

const body = (tsv: string) => tsv.split('\n').filter(line => line && !line.startsWith('#'));

/** Largest absolute difference of two curves (Infinity when their lengths differ or one is missing). */
const maxDiff = (a: number[] | undefined, b: number[] | undefined) =>
  !a || !b || a.length !== b.length || !a.length ? Infinity : Math.max(...a.map((x, i) => Math.abs(x - b[i])));

test('a headless meta-locus figure and Quantify equal the browser for the same pool and seed', async ({ server, page }, info) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    localStorage.clear();
    sessionStorage.clear();
    sessionStorage.setItem('fiberhmm_welcome_dismissed', '1');
  });
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');
  await expect.poll(() => store(page, s => s.datasets.length), { timeout: 30_000 }).toBeGreaterThan(0);
  const bed = info.outputPath('pool_sites.bed');
  demoBed(bed, server.defaultRegion!);

  // Every read the tab fetches on the meta contig, by dataset (the working set it shows).
  const fetched = new Map<string, string[]>();
  page.on('response', async r => {
    const url = decodeURIComponent(r.url());
    if (!url.includes('/api/reads/compact') || !url.includes('chrom=meta:') || !r.ok()) return;
    try {
      const j = await r.json();
      const ds = new URL(r.url()).searchParams.get('dataset_id') ?? j.dataset_id;
      if (ds && Array.isArray(j.reads)) fetched.set(ds, j.reads.map((x: { id: string }) => x.id));
    } catch { /* not JSON */ }
  });

  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('command-palette-input').fill('meta-locus');
  await page.locator('[role="option"][data-palette-item="cmd:open-meta-locus"]').click();
  await expect(page.getByTestId('meta-locus-dialog')).toBeVisible();
  await page.getByTestId('meta-locus-bed').fill(bed);
  await page.getByTestId('meta-locus-flank').fill('1500');
  await page.getByTestId('meta-locus-count').fill('300');
  await page.getByTestId('meta-locus-open').click();
  await expect.poll(() => store(page, s => String(s.chrom)), { timeout: 60_000 }).toMatch(/^meta:/);
  await expect(page.getByTestId('meta-locus-progress')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId('location-search-input')).toHaveValue('pool_sites · TSS ± 1.5 kb');
  const datasetId = await store(page, s => s.datasets[0].id as string);
  await expect.poll(() => fetched.get(datasetId)?.length ?? 0, { timeout: 60_000 }).toBe(300);
  const chrom = await store(page, s => s.chrom as string);
  const drawn = await store(page, s => [...(s.activeReadIds?.[s.panels.find((p: any) => p.datasetId === s.datasets[0].id)?.stateKey ?? s.datasets[0].id] ?? [])] as string[]);

  // The headless figure of the same pool and seed (the open tab's view is not changed by it).
  const spec = { bed, anchor: 'start', flank_bp: 1500, seed: 1, count: 300 };
  const fig = await page.request.post(`${server.baseUrl}/api/render`, {
    data: { engine: 'headless', format: 'svg', manifest: true, manifest_read_ids: true, source: 'auto', meta_locus: spec },
  });
  expect(fig.ok(), await fig.text()).toBe(true);
  const manifest = (await fig.json()).manifest;
  const panel = manifest.panels.find((p: { dataset_id: string }) => p.dataset_id === datasetId);
  expect([...panel.read_ids].sort()).toEqual([...fetched.get(datasetId)!].sort());
  expect(drawn.length).toBeGreaterThan(0);
  expect(drawn.filter(id => !panel.read_ids.includes(id))).toEqual([]);
  expect(manifest.meta_locus.seed).toBe(1);
  expect(await store(page, s => s.chrom as string)).toBe(chrom);

  // Quantify a window: the card's TSV and the headless twin's, same window, measures and seed.
  await page.evaluate(c => {
    const st = (window as any).__FIBERBROWSER_STORE__.getState();
    st.setQuantWindow({ chrom: c, from: -200, to: 50, relative: true });
    st.updateQuantSpec({ measures: ['layer:nuc', 'layer:tf'] });
  }, chrom);
  await page.getByTestId('quant-track-open').first().click();
  const host = page.getByTestId('quant-host-card');
  await expect(host).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
  const download = page.waitForEvent('download');
  await host.getByTestId('quant-tsv').click();
  const browserTsv = readFileSync((await (await download).path())!, 'utf8');
  const headless = await page.request.post(`${server.baseUrl}/api/meta_locus/quantify`, {
    data: { meta_locus: spec, window: [-200, 50], spec: { measures: ['layer:nuc', 'layer:tf'] } },
  });
  expect(headless.ok(), await headless.text()).toBe(true);
  const twin = await headless.json();
  writeFileSync(info.outputPath('browser.tsv'), browserTsv);
  writeFileSync(info.outputPath('headless.tsv'), twin.tsv);
  expect(body(browserTsv).length).toBe(3);
  expect(body(twin.tsv)).toEqual(body(browserTsv));
  expect(twin.read_source).toBe('fetch');

  // The metaprofile export equals the curves the tab draws: unclustered, the server's metaprofile (datasetProfiles).
  const profileOf = async () => (await (await page.request.post(`${server.baseUrl}/api/meta_locus/profile`, {
    data: { meta_locus: spec, channels: ['nuc', 'tf'] },
  })).json());
  await expect.poll(async () => {
    const prof = await profileOf();
    const drawn = await store(page, s => s.datasetProfiles?.[s.datasets[0].id]?.layers ?? null);
    const g = prof.groups?.[`dataset:${datasetId}`];
    return g && drawn ? Math.max(maxDiff(g.channels.nuc, drawn.nuc), maxDiff(g.channels.tf, drawn.tf)) : Infinity;
  }, { timeout: 60_000, intervals: [1000, 2000] }).toBeLessThan(1e-9);

  // Clustered in the browser: the card reads the panels' profile pools in curve units; the headless call reads the
  // tab's clusters from its live view and must give the same rows.
  await page.evaluate(() => {
    const st = (window as any).__FIBERBROWSER_STORE__.getState();
    st.addCustomPeak(1150, 1450);
    st.addCustomPeak(1550, 1850);
  });
  await expect.poll(() => store(page, s => s.getAllPeaks().length), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => {
    const st = (window as any).__FIBERBROWSER_STORE__.getState();
    st.replacePeakSelection(st.getAllPeaks().slice(-2).map((p: { index: number }) => p.index));
    st.setClusterMethod('kmeans');
  });
  const clustered = page.waitForResponse(r => r.url().includes('/api/cluster_all'), { timeout: 60_000 });
  await page.getByTestId('cluster-run-button').click();
  expect((await clustered).ok()).toBe(true);
  await expect.poll(() => store(page, s => Object.values(s.clusterAssignments).reduce((n: number, a: any) => n + Object.keys(a || {}).length, 0)), { timeout: 60_000 }).toBeGreaterThan(0);
  await expect(host).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
  await expect(host.getByTestId('quant-measures')).toContainText('curve units', { timeout: 60_000 });
  let last = { browser: '', headless: '' };
  await expect.poll(async () => {
    const dl = page.waitForEvent('download');
    await host.getByTestId('quant-tsv').click();
    const b = readFileSync((await (await dl).path())!, 'utf8');
    const h = await (await page.request.post(`${server.baseUrl}/api/meta_locus/quantify`, {
      data: { meta_locus: spec, window: [-200, 50], spec: { measures: ['layer:nuc', 'layer:tf'] } },
    })).json();
    last = { browser: b, headless: h.tsv ?? JSON.stringify(h) };
    return h.read_source === 'panel' && body(b).length > 3 && JSON.stringify(body(b)) === JSON.stringify(body(h.tsv));
  }, { timeout: 60_000, intervals: [1000, 2000, 3000] }).toBe(true);
  writeFileSync(info.outputPath('browser_clusters.tsv'), last.browser);
  writeFileSync(info.outputPath('headless_clusters.tsv'), last.headless);

  // Clustered: the tab computes its curves from its profile reads (datasetProfiles, and clusterProfiles per cluster);
  // the export must give the same per dataset and per cluster.
  let worst = { dataset: Infinity, clusters: Infinity, n: 0 };
  await expect.poll(async () => {
    const prof = await profileOf();
    const drawn = await store(page, s => {
      const key = s.panels.find((p: any) => p.datasetId === s.datasets[0].id)?.stateKey ?? s.datasets[0].id;
      return { dataset: s.datasetProfiles?.[key]?.layers ?? null, clusters: s.clusterProfiles?.[key] ?? null };
    });
    if (!drawn.dataset || !drawn.clusters || !prof.groups) return false;
    const g = prof.groups[`dataset:${datasetId}`];
    const ds = g ? Math.max(maxDiff(g.channels.nuc, drawn.dataset.nuc), maxDiff(g.channels.tf, drawn.dataset.tf)) : Infinity;
    const ids = Object.keys(drawn.clusters);
    const cl = Math.max(...ids.map(c => {
      const h = prof.groups[`cluster:${c}`];
      return h ? Math.max(maxDiff(h.channels.nuc, drawn.clusters[c].nuc), maxDiff(h.channels.tf, drawn.clusters[c].tf)) : Infinity;
    }));
    worst = { dataset: ds, clusters: cl, n: ids.length };
    return g?.source === 'profile reads' && ids.length > 1 && ds < 1e-9 && cl < 1e-9;
  }, { timeout: 60_000, intervals: [1000, 2000, 3000] }).toBe(true);
  writeFileSync(info.outputPath('profile_parity.json'), JSON.stringify(worst));
});
