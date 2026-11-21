/**
 * Alt-allele panels on the synthetic insertion fixture (tests/insertion_fixtures.py: a
 * 2 kb insertion carried by 24 reads in the CIGAR and 3 clipped at the breakpoint, 16
 * reference reads). "Show insert expanded (carriers only)" switches the dataset panel to
 * the insertion's alternate allele: only the confirmed carriers (the 24 with the insert in
 * their CIGAR; the clipped ones are putative evidence, left out of the default alternate
 * allele since the SV evidence tiers), on a contig with the insert
 * expanded, the axis reading out insert and reference positions; Cluster runs there;
 * the toggle goes back to exactly the reference view. The SV band opens a second
 * carriers panel the same way.
 */
import { test, expect, enablePreviews } from './fixtures/server';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = process.env.FIBERBROWSER_TEST_DIR
  ? path.resolve(process.env.FIBERBROWSER_TEST_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const VIEW = { chrom: 'chrT', start: 11_000, end: 19_000 };

test.use({
  fixtureBam: async ({}, use) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fiberbrowser-altallele-'));
    execFileSync(process.env.FIBERBROWSER_TEST_PYTHON?.trim() || 'python',
      [path.join(REPO_ROOT, 'tests', 'insertion_fixtures.py'), dir], { stdio: 'inherit' });
    await use(path.join(dir, 'insertion.bam'));
  },
});

test('alt-allele panel: insert expanded, clustered, and back', async ({ page, server }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    localStorage.clear();
    sessionStorage.clear();
  });
  // A Preview feature: on for this spec (Settings → Show preview features).
  await enablePreviews(page);
  const firstReads = page.waitForResponse(r => r.url().includes('/api/reads/compact') && r.url().includes('chrT') && r.ok());
  await page.goto(`${server.baseUrl}/?chr=${VIEW.chrom}&start=${VIEW.start}&end=${VIEW.end}`);
  await firstReads;
  const reads = page.locator('canvas[data-copilot-track="reads"]');
  await expect(reads).toHaveCount(1);
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 30_000 }).toBe(0);

  const store = () => page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    const p = s.panels.find((x: any) => x.contentType === 'dataset');
    return { id: p.id, datasetId: p.datasetId, genome: p.genome ?? null, view: p.viewportOverride ?? null, alt: p.altAllele ?? null,
      stateKey: p.stateKey ?? null, label: s.datasets.find((d: any) => d.id === p.datasetId)?.label ?? null, main: [s.chrom, s.start, s.end] };
  });
  const before = await store();

  // The panel's menu: Show insert expanded (carriers only).
  const opened = page.waitForResponse(r => r.url().includes('/api/alt_allele/open') && r.ok());
  await page.getByTestId(`panel-actions-${before.id}`).click();
  await page.getByRole('menuitemcheckbox', { name: 'Show insert expanded (carriers only)' }).click();
  const reply = await (await opened).json();
  expect(reply.success).toBe(true);
  // Confirmed carriers only: the clipped reads are putative and stay out of the default alt allele.
  expect(reply.alt_allele.meta.carriers).toMatchObject({ total: 24, written: 24, cigar: 24, clip_start: 0, clip_end: 0, hard: 0 });
  await expect(page.getByTestId('alt-allele-chip')).toBeVisible();
  const alt = await store();
  expect(alt.datasetId).toBe(reply.dataset.id);
  expect(alt.genome).toBe(reply.genome_key);
  expect(alt.view.chrom).toBe(reply.layout.name);
  // The title says these are the carriers.
  await expect(page.getByTestId('panel-header-name')).toContainText('Carriers of +');
  // One header pill (round 3, R14a), its ⓘ: what the panel shows (a Preview feature), which carriers, the partial
  // ones and why, the contig ↔ reference mapping, and the way back.
  await expect(page.getByTestId('alt-allele-chip')).toHaveText('Pinned to insertionⓘ');
  await expect(page.locator('[data-testid^="dataset-header-"] [data-testid="preview-badge"]')).toHaveCount(0);
  await page.getByTestId('alt-allele-chip').click();
  const provenance = page.getByTestId('alt-allele-provenance');
  await expect(provenance).toContainText('24 carriers found at the site; 24 placed on the contig');
  await expect(provenance).toContainText('Hard-clipped (partial: their flank only, the clipped bases are not in the read): 0');
  await expect(provenance).toContainText(`Contig ${reply.layout.name}`);
  await expect(provenance).toContainText('Breakpoint: between chrT:15,000 and 15,001');
  await expect(provenance.getByTestId('preview-limitations')).toBeVisible();
  await expect(provenance.getByTestId('alt-allele-show-reference')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(provenance).toHaveCount(0);
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 30_000 }).toBe(0);
  // Only the carriers, the insert's bases on the contig.
  const altReads = await page.evaluate(async ([chrom, s, e, ds]) => {
    const q = new URLSearchParams({ chrom, start: String(s), end: String(e), dataset_id: ds, max_reads: '500', spanning: 'false' });
    return (await (await fetch(`/api/reads/compact?${q}`)).json()).reads.map((r: any) => r.id);
  }, [reply.layout.name, reply.layout.insert_start, reply.layout.insert_end, reply.dataset.id] as const);
  expect(altReads.length).toBe(24);  // the confirmed carriers, each with the whole insert
  expect(altReads.some((id: string) => id.startsWith('reference_'))).toBe(false);

  // Both readouts: hovering inside the insert says INS n / 2,000-ish; the flank says chrT:...
  const axis = page.getByTestId('axis-ruler').first();
  const ab = (await axis.boundingBox())!;
  const v = alt.view;
  const xOf = (a: number) => ab.x + ((a - v.start) / (v.end - v.start)) * ab.width;
  await page.mouse.move(xOf(reply.layout.insert_start + 500), ab.y + ab.height / 2);
  await expect(page.getByText(/^INS 4\d\d \/ 2,0\d\d · alt |^INS 5\d\d \/ 2,0\d\d · alt /)).toBeVisible();
  await page.mouse.move(xOf(reply.layout.insert_start - 1000), ab.y + ab.height / 2);
  await expect(page.getByText(/^chrT:1[34],\d{3} · alt /)).toBeVisible();

  // Cluster on the insert (what the Cluster button runs), on the alt contig's own reference.
  const clustered = await page.evaluate(async ([name, lo, hi, key, ds]) => {
    const q = new URLSearchParams({ chrom: name, start: String(lo), end: String(hi), spanning: 'false', panel_genome: key });
    const res = await (await fetch(`/api/cluster_all?${q}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peak_regions: [{ start: lo + 100, end: hi - 100 }], k: 2, method: 'kmeans', dataset_ids: [ds] }) })).json();
    return res.results[ds].cluster_counts;
  }, [reply.layout.name, reply.layout.insert_start, reply.layout.insert_end, reply.genome_key, reply.dataset.id] as const);
  expect(Object.values(clustered).reduce((a: number, b: any) => a + Number(b), 0)).toBeGreaterThanOrEqual(24);

  // Back to the reference (the pill's ⓘ → Show on reference): exactly what it showed.
  await page.getByTestId('alt-allele-chip').click();
  await page.getByTestId('alt-allele-show-reference').click();
  await expect(page.getByTestId('alt-allele-chip')).toHaveCount(0);
  const back = await store();
  expect([back.datasetId, back.genome, back.view, back.stateKey]).toEqual([before.datasetId, before.genome, before.view, before.stateKey]);

  // The SV track (its own row since fb-n11-tracks) opens a new carriers panel beside it.
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 30_000 }).toBe(0);
  const svTrack = page.locator('canvas[data-testid^="sv-track-canvas-"]').first();
  await expect(svTrack).toBeVisible({ timeout: 15_000 });
  const box = (await svTrack.boundingBox())!;
  const sidebar = Number(await reads.first().getAttribute('data-track-sidebar')) || 0;
  const xAt = (pos: number) => box.x + sidebar + ((pos - VIEW.start) / (VIEW.end - VIEW.start)) * (box.width - sidebar);
  await page.mouse.click(xAt(reply.layout.ref), box.y + box.height / 2, { button: 'right' });
  const menu = page.getByTestId('track-context-menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Open carriers with the insert expanded' }).click();
  await expect(page.getByTestId('alt-allele-chip')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('canvas[data-copilot-track="reads"]')).toHaveCount(2);
  expect(errors).toEqual([]);
});
