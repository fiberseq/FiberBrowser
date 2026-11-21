/**
 * The insertion lens on an explicitly synthetic Fiber-seq BAM
 * (tests/insertion_fixtures.py: a 2 kb insertion carried by 24 reads in the
 * CIGAR and by 3 reads clipped at the breakpoint, one of them hard-clipped,
 * 16 reference reads), generated per test into a temp dir. Opens the lens
 * from the SV band's insertion and checks the default confirmed + putative
 * cohort. The competing short insertion makes the three clips ambiguous:
 * they enter the drawn/split cohort only after explicitly opting in.
 */
import { test, expect, panelButton } from './fixtures/server';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = process.env.FIBERBROWSER_TEST_DIR
  ? path.resolve(process.env.FIBERBROWSER_TEST_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SITE = 15_000;
const VIEW = { chrom: 'chrT', start: 11_000, end: 19_000 };

test.use({
  fixtureBam: async ({}, use) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fiberbrowser-insertion-'));
    execFileSync(process.env.FIBERBROWSER_TEST_PYTHON?.trim() || 'python',
      [path.join(REPO_ROOT, 'tests', 'insertion_fixtures.py'), dir], { stdio: 'inherit' });
    await use(path.join(dir, 'insertion.bam'));
  },
});

test('insertion lens: clipped carriers, and the split groups the same reads', async ({ page, server }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    localStorage.clear();
    sessionStorage.clear();
  });
  const firstReads = page.waitForResponse(r => r.url().includes('/api/reads/compact') && r.url().includes('chrT') && r.ok());
  await page.goto(`${server.baseUrl}/?chr=${VIEW.chrom}&start=${VIEW.start}&end=${VIEW.end}`);
  const payload = await (await firstReads).json();
  const data = payload.datasets ? Object.values(payload.datasets)[0] as any : payload;
  // The summary's informative denominator is confirmed + reference. Clips
  // compatible with both insertion lengths remain a separate ambiguous tier.
  const ins = data.sv_summary.clusters.find((c: any) => c.t === 'I' && c.len > 1500);
  expect(ins).toMatchObject({ support: 24, clip_support: 0, confirmed: 24,
    putative: 0, conflicting: 0, ambiguous: 3, informative: 40 });

  const reads = page.locator('canvas[data-copilot-track="reads"]');
  await expect(reads).toHaveCount(1);
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 30_000 }).toBe(0);
  const svTrack = page.locator('canvas[data-testid^="sv-track-canvas-"]');
  await expect(svTrack).toHaveCount(1, { timeout: 15_000 });
  const box = (await svTrack.boundingBox())!;
  const sidebar = Number(await reads.getAttribute('data-track-sidebar')) || 0;
  const xAt = (pos: number) => box.x + sidebar + ((pos - VIEW.start) / (VIEW.end - VIEW.start)) * (box.width - sidebar);

  // The SV track's insertion: its menu opens the lens on it.
  await page.mouse.move(xAt(ins.ref), box.y + box.height / 2);
  await expect(page.getByTestId('sv-cluster-tooltip')).toContainText('24 confirmed of 40 informative');
  await expect(page.getByTestId('sv-cluster-tooltip')).toContainText('3 ambiguous');
  await page.mouse.click(xAt(ins.ref), box.y + box.height / 2, { button: 'right' });
  const menu = page.getByTestId('track-context-menu');
  await expect(menu).toBeVisible();
  const lensResponse = page.waitForResponse(r => r.url().includes('/api/insertions/lens') && r.ok());
  await menu.getByRole('menuitem', { name: 'Open this insertion in the lens' }).click();
  const lensReply = await lensResponse;
  const lens = await lensReply.json();
  // Opened on the band's cluster: the same insertion "Split by this SV" takes.
  expect(new URL(lensReply.url()).searchParams.get('length')).toBe(String(ins.len));
  expect(lens.cluster).toMatchObject({ carriers: 24, confirmed: 24, putative: 0,
    conflicting: 0, ambiguous: 3, evidence_total: 27, cigar: 24, clipped: 3, hard: 1, reference: 16 });
  const summary = page.getByTestId('insertion-lens-summary');
  // Labelled fields, each with its scope (VAR-12): carriers of the informative reads at the site.
  await expect(summary).toContainText('all reads at the site');
  await expect(page.getByTestId('insertion-lens-carriers-count')).toHaveText('24 of 40 informative (60%)');
  await expect(summary).toContainText('0 putative · 0 conflicting · 3 ambiguous');
  await expect(page.getByTestId('insertion-lens-clipped')).toContainText('24 in the alignment, 3 clipped, 1 hard-clipped');
  await expect(page.getByTestId('insertion-lens-reference-count')).toHaveText('16');
  await expect(page.getByTestId('insertion-lens-carriers')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /^Include putative/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /^Include conflicting/ })).not.toBeChecked();
  const includeAmbiguous = page.getByRole('checkbox', { name: 'Include ambiguous', exact: true });
  await expect(includeAmbiguous).not.toBeChecked();

  // The raw lens payload retains all tiers for inspection; only the selected
  // evidence policy enters the default split, matching the drawn cohort.
  const split = page.waitForResponse(r => r.url().endsWith('/api/sv/split') && r.request().method() === 'POST');
  await page.getByTestId('insertion-lens-split').click();
  const splitReply = await split;
  expect(splitReply.request().postDataJSON()).toMatchObject({ include_putative: true, include_conflicting: false, include_ambiguous: false });
  const splitJson = await splitReply.json();
  expect(splitJson.counts).toEqual([24, 16, 5]);
  const selectedCarriers = lens.carriers.filter((c: any) => ['confirmed', 'putative'].includes(c.evidence_level));
  expect(Object.entries(splitJson.assignments).filter(([, g]) => g === 0).map(([n]) => n).sort())
    .toEqual(selectedCarriers.map((c: any) => c.id).sort());
  const ambiguous = lens.carriers.filter((c: any) => c.evidence_level === 'ambiguous');
  expect(ambiguous).toHaveLength(3);
  expect(ambiguous.every((c: any) => splitJson.assignments[c.id] === 2)).toBe(true);
  await expect(page.getByTestId('insertion-lens')).toContainText('24 carriers, 16 reference');

  // Explicitly include ambiguous clips before inspecting their rows. Changing
  // the display/split policy never promotes them into the confirmed count.
  await includeAmbiguous.check();
  await expect(page.getByTestId('insertion-lens-carriers-count')).toHaveText('24 of 40 informative (60%)');

  // Hover a clipped carrier's row (they follow the 24 whole inserts): the readout says what it is.
  const carriers = page.getByTestId('insertion-lens-carriers');
  const cb = (await carriers.boundingBox())!;
  const rowPitch = cb.height / lens.carriers.length;
  const hardRow = lens.carriers.findIndex((c: any) => c.hard);
  await page.mouse.move(cb.x + cb.width * 0.3, cb.y + rowPitch * (hardRow + 0.5));
  await expect(page.getByTestId('insertion-lens-readout')).toContainText('the inserted bases are not in this record');

  // Opting in makes all 27 evidence rows carriers of the split.
  const inclusiveSplit = page.waitForResponse(r => r.url().endsWith('/api/sv/split') && r.request().method() === 'POST');
  await page.getByTestId('insertion-lens-split').click();
  const inclusiveReply = await inclusiveSplit;
  expect(inclusiveReply.request().postDataJSON().include_ambiguous).toBe(true);
  const inclusiveJson = await inclusiveReply.json();
  expect(inclusiveJson.counts).toEqual([27, 16, 2]);
  const splitCarriers = Object.entries(inclusiveJson.assignments).filter(([, g]) => g === 0).map(([n]) => n).sort();
  expect(splitCarriers).toEqual(lens.carriers.map((c: any) => c.id).sort());
  await expect(page.getByTestId('insertion-lens')).toContainText('27 carriers, 16 reference');

  // Closing the lens is not clearing it (VAR-7): opened again, the same insertion; Clear empties it.
  await page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    s.closeAnalysisPanel(s.panels.find((p: any) => p.contentType === 'insertion-lens').id);
  });
  await expect(page.getByTestId('insertion-lens')).toHaveCount(0);
  await panelButton(page, 'insertion-lens').first().click();
  await expect(page.getByTestId('insertion-lens-restored')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('insertion-lens-carriers-count')).toHaveText('24 of 40 informative (60%)');
  await expect(includeAmbiguous).toBeChecked();
  await page.getByTestId('insertion-lens-clear').click();
  await expect(page.getByTestId('insertion-lens')).toContainText('Open an insertion to see the chromatin inside it');
  expect(errors).toEqual([]);
});
