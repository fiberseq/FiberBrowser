/**
 * fb-n13, end to end on synthetic BAMs (alt-allele panels and the multi-SV split are Preview features: enabled here):
 * - an SV's right-click menu splits the reads straight into panels, and the Carriers open with the insert expanded
 *   (alt-allele panels); Cluster runs on that expanded Carriers panel; the rest of the split as in core
 *   (split-locus-library.spec.ts);
 * - two SVs selected at once split the reads by their combined genotype.
 */
import { test, expect, enablePreviews, panelButton } from './fixtures/server';
import type { Locator, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = process.env.FIBERBROWSER_TEST_DIR
  ? path.resolve(process.env.FIBERBROWSER_TEST_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const PYTHON = process.env.FIBERBROWSER_TEST_PYTHON?.trim() || 'python';
const VIEW = { chrom: 'chrSV', start: 8_000, end: 16_000 };
const INS_POS = 14_000;

const store = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => new Function('s', `return (${f})(s)`)((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;

async function groupControls(page: Page, id: string): Promise<Locator> {
  const controls = page.getByTestId(`toolbar-group-controls-${id}`);
  if (!(await controls.isVisible().catch(() => false))) {
    const toggle = page.getByTestId(`toolbar-group-toggle-${id}`).first();
    if (await toggle.isVisible().catch(() => false)) await toggle.click();
    else {
      await page.getByTestId('toolbar-groups-more').click();
      await page.getByTestId('toolbar-groups-more-menu').getByTestId(`toolbar-group-toggle-${id}`).click();
    }
  }
  await expect(controls.first()).toBeVisible();
  return controls.first();
}

async function open(page: Page, url: string) {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    if (!window.sessionStorage.getItem('fb-e2e-kept')) {
      window.localStorage.clear();
      window.sessionStorage.setItem('fb-e2e-kept', '1');
    }
  });
  // Insert-expanded Carriers and the multi-SV split are Preview features: on here.
  await enablePreviews(page);
  await page.goto(url);
  await page.waitForFunction(() => !!(window as any).__FIBERBROWSER_STORE__);
}

/** The rail's first-run hint covers the panel headers' right end. */
async function dismissCoach(page: Page) {
  const coach = page.getByTestId('panel-rail-coach-dismiss');
  if (await coach.isVisible().catch(() => false)) await coach.click();
}

test.describe('an SV split into panels: the Carriers with the insert expanded', () => {
  test.use({
    fixtureBam: async ({}, use) => {
      const bam = path.join(mkdtempSync(path.join(tmpdir(), 'fiberbrowser-n13-sv-')), 'sv_demo.bam');
      execFileSync(PYTHON, [path.join(REPO_ROOT, 'tests', 'make_sv_demo_bam.py'), bam], { stdio: 'inherit' });
      await use(bam);
    },
  });

  test('Variants › SVs after Split into panels: still lists the split insertion and its carriers', async ({ page, server }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    const firstReads = page.waitForResponse(r => r.url().includes('/api/reads/compact') && r.url().includes('chrSV') && r.ok());
    await open(page, `${server.baseUrl}/?chr=${VIEW.chrom}&start=${VIEW.start}&end=${VIEW.end}`);
    await firstReads;
    await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 30_000 }).toBe(0);
    await dismissCoach(page);

    await panelButton(page, 'variants').first().click();
    await page.locator('[data-analysis-tab="svs"]').first().click();
    const insertion = page.locator('[data-testid="variants-sv"][data-sv^="I:"]').first();
    await expect(insertion).toBeVisible({ timeout: 30_000 });
    const sv = await insertion.getAttribute('data-sv');
    const carriers = await insertion.getByTestId('variants-sv-carriers').textContent();
    await insertion.getByRole('button', { name: 'Split into panels…' }).click();
    const open_ = page.getByTestId('split-panels-open');
    await expect(open_).toBeEnabled({ timeout: 30_000 });
    await open_.click();
    // The Carriers open with the insert expanded (previews are on by default), beside the Reference reads.
    await expect.poll(() => store(page, s => s.panels.some((p: any) => p.readSubset && p.altAllele)), { timeout: 90_000 }).toBe(true);

    // The SVs tab lists the reads the split was made from: the insertion, with the same carriers, not "No SVs in view".
    const svs = page.getByTestId('variants-svs');
    await expect(svs.getByTestId('variants-svs-split-source')).toBeVisible({ timeout: 30_000 });
    await expect(svs.locator(`[data-testid="variants-sv"][data-sv="${sv}"]`)).toBeVisible({ timeout: 30_000 });
    await expect(svs.locator(`[data-testid="variants-sv"][data-sv="${sv}"]`).getByTestId('variants-sv-carriers')).toHaveText(carriers!);
    await expect(svs).not.toContainText('No SVs in view');
    // Whichever split panel is selected: the Reference panel, then the expanded Carriers.
    for (const which of ['ref', 'alt']) {
      await page.evaluate(w => {
        const st = (window as any).__FIBERBROWSER_STORE__;
        const p = st.getState().panels.find((x: any) => x.readSubset && (w === 'alt' ? x.altAllele : !x.altAllele));
        st.setState({ selectedDatasets: new Set([p.id]) });
      }, which);
      await expect(svs.locator(`[data-testid="variants-sv"][data-sv="${sv}"]`)).toBeVisible({ timeout: 30_000 });
      await expect(svs).not.toContainText('No SVs in view');
    }
    expect(errors).toEqual([]);
  });

  test('Split into panels from the SV row; banner off-locus; Go back; close; the Library reopens it', async ({ page, server }) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    const firstReads = page.waitForResponse(r => r.url().includes('/api/reads/compact') && r.url().includes('chrSV') && r.ok());
    await open(page, `${server.baseUrl}/?chr=${VIEW.chrom}&start=${VIEW.start}&end=${VIEW.end}`);
    await firstReads;
    await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 30_000 }).toBe(0);

    // 1. Right-click the insertion in the SV row: straight into panels.
    const svTrack = page.locator('canvas[data-testid^="sv-track-canvas-"]');
    await expect(svTrack).toHaveCount(1);
    const box = (await svTrack.boundingBox())!;
    const sidebar = Number(await page.locator('canvas[data-copilot-track="reads"]').first().getAttribute('data-track-sidebar')) || 0;
    const xAt = (pos: number) => box.x + sidebar + ((pos - VIEW.start) / (VIEW.end - VIEW.start)) * (box.width - sidebar);
    await page.mouse.click(xAt(INS_POS), box.y + box.height / 2, { button: 'right' });
    const menu = page.getByTestId('track-context-menu');
    await expect(menu.getByRole('menuitem', { name: 'Group in this panel by this SV' })).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Split into panels by this SV' }).click();
    const dialog = page.getByTestId('split-panels-dialog');
    await expect(dialog.getByTestId('split-panels-row').first()).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByTestId('split-panels-row').filter({ hasText: 'Carriers' })).toHaveCount(1);
    // Before it opens, the dialog says the Carriers open expanded, on their own coordinates, and what its counts are of.
    await expect(dialog.getByTestId('split-panels-row-note')).toHaveText('Carriers: expanded insertion, own coordinates');
    await expect(dialog.getByTestId('split-panels-sv-counts')).toContainText('informative reads');
    await expect(dialog.getByTestId('split-panels-intro')).toContainText('Preview shown behind');
    await dialog.getByTestId('split-panels-open').click();
    await expect.poll(() => store(page, s => s.panels.filter((p: any) => p.readSubset).length)).toBe(2);
    // The Carriers panel opens with the insert expanded.
    await expect.poll(() => store(page, s => s.panels.some((p: any) => p.readSubset && p.altAllele)), { timeout: 90_000 }).toBe(true);
    // The split panels' titles lead with their group; the expanded one says it is pinned to the insertion.
    await expect.poll(() => page.getByTestId('panel-header-title').allTextContents()).toEqual(expect.arrayContaining(['Carriers', 'Reference']));
    await expect(page.getByTestId('alt-allele-chip')).toContainText('Pinned to insertion');
    const alt = await store(page, s => {
      const p = s.panels.find((x: any) => x.readSubset && x.altAllele);
      return { id: p.id, key: p.stateKey, genome: p.genome, chrom: p.viewportOverride.chrom, lo: p.altAllele.layout.insert_start, hi: p.altAllele.layout.insert_end };
    });

    // 2. Cluster straight on the expanded Carriers panel (a peak inside the insert, on its own contig).
    await page.evaluate(a => {
      const s = (window as any).__FIBERBROWSER_STORE__.getState();
      s.addCustomPeak(a.lo + 20, a.hi - 20, a.chrom, a.genome);
      const peak = (window as any).__FIBERBROWSER_STORE__.getState().getAllPeaks().find((p: any) => p.isCustom && p.chrom === a.chrom);
      s.togglePeakSelection(peak.index);
      s.setClusterMethod('kmeans');
      (window as any).__FIBERBROWSER_STORE__.setState({ selectedDatasets: new Set([a.id]) });
    }, alt);
    await groupControls(page, 'cluster');
    await page.getByTestId('cluster-run-button').click();
    await expect.poll(() => store(page, s => Object.keys(s.clusterAssignments[(s.panels.find((p: any) => p.readSubset && p.altAllele) ?? {}).stateKey] ?? {}).length),
      { timeout: 90_000 }).toBeGreaterThan(0);
    await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.setState({ selectedDatasets: new Set() }));

    // 3. Away from the split's locus: the split panels say why they are empty.
    await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setViewport('chrSV', 24_000, 29_000));
    const banner = page.getByTestId('split-away-banner');
    await expect(banner.first()).toBeVisible({ timeout: 20_000 });
    // The expanded Carriers panel (on its own contig) says so too, pinned, with its way back to the reference.
    const pinned = page.locator('[data-testid="split-away-banner"][data-pinned="true"]');
    await expect(pinned).toHaveCount(1);
    await expect(pinned.getByTestId('split-away-text')).toContainText('Pinned to the insertion');
    await expect(pinned.getByTestId('split-away-reference')).toBeVisible();
    await expect(banner).toHaveCount(2);
    const unpinned = page.locator('[data-testid="split-away-banner"]:not([data-pinned])');
    await expect(unpinned.first().getByTestId('split-away-text')).toContainText('This split is for INS');
    await expect(banner.first().getByTestId('split-away-text')).toContainText('the reads here aren');
    // Go back from the pinned panel: the main view returns (the pinned panel stays on its contig).
    await pinned.getByTestId('split-away-go-back').click();
    await expect.poll(() => store(page, s => [s.chrom, s.start <= 14_000 && s.end >= 14_000])).toEqual(['chrSV', true]);
    await expect(banner).toHaveCount(0);
    // Show all reads here: labelled in the header, unfiltered (the pinned panel keeps saying where its split is).
    await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setViewport('chrSV', 24_000, 29_000));
    await expect(unpinned.first()).toBeVisible();
    await unpinned.first().getByTestId('split-away-show-all').click();
    await expect(page.getByTestId('split-panel-all-reads').first()).toBeVisible();
    await expect(unpinned).toHaveCount(0);
    await expect(pinned).toHaveCount(1);
    await page.evaluate(v => (window as any).__FIBERBROWSER_STORE__.getState().setViewport(v.chrom, v.start, v.end), VIEW);

    // 4. Close the split: the source shows again.
    await page.getByTestId('split-panel-close-all').first().click();
    await expect.poll(() => store(page, s => s.panels.filter((p: any) => p.readSubset).length), { timeout: 30_000 }).toBe(0);
    const source = await store(page, s => s.panels.find((p: any) => p.contentType === 'dataset' && p.datasetId));
    expect(source.collapsed).toBe(false);
    expect(source.collapsedBySplitGroup).toBeUndefined();

    // 5. Close the dataset, then Library > Open reopens it (a placeholder panel first).
    const bamPath = await store(page, s => s.datasets[0].path);
    await dismissCoach(page);
    await page.getByTestId(`panel-close-${source.id}`).click();
    await expect.poll(() => store(page, s => s.datasets.length)).toBe(0);
    expect((await page.request.post(`${server.baseUrl}/api/library/entries`, { data: { paths: [bamPath] } })).ok()).toBeTruthy();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-section', {
      detail: { sectionId: 'file', subsectionId: 'file.library' },
    })));
    await page.getByTestId('library-open-panel').click();
    const library = page.getByTestId('library-dialog');
    await library.getByTestId('library-row').filter({ hasText: 'sv_demo' }).click();
    const clicked = Date.now();
    await library.getByTestId('library-open').click();
    await expect(page.getByTestId('opening-panel').or(page.locator('[data-panel-id]').filter({ has: page.locator('canvas[data-copilot-track="reads"]') })).first())
      .toBeVisible({ timeout: 2_000 });
    expect(Date.now() - clicked).toBeLessThan(2_000);
    await expect.poll(() => store(page, s => s.datasets.length), { timeout: 30_000 }).toBe(1);
    await expect.poll(() => store(page, s => s.panels.some((p: any) => p.contentType === 'dataset' && p.datasetId && !p.collapsed))).toBe(true);
    await expect(page.getByTestId('opening-panel')).toHaveCount(0);

    // 6. Open again while it is open: the Library shows it (never a silent no-op).
    await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setPanelCollapsed(
      (window as any).__FIBERBROWSER_STORE__.getState().panels.find((p: any) => p.contentType === 'dataset' && p.datasetId).id, true));
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-section', {
      detail: { sectionId: 'file', subsectionId: 'file.library' },
    })));
    await page.getByTestId('library-open-panel').click();
    await library.getByTestId('library-row').filter({ hasText: 'sv_demo' }).click();
    await library.getByTestId('library-open').click();
    await expect.poll(() => store(page, s => s.panels.some((p: any) => p.contentType === 'dataset' && p.datasetId && !p.collapsed))).toBe(true);
    await expect.poll(() => store(page, s => s.datasets.length)).toBe(1);
    expect(errors).toEqual([]);
  });
});

test.describe('two SVs at once', () => {
  test.use({
    fixtureBam: async ({}, use) => {
      const bam = path.join(mkdtempSync(path.join(tmpdir(), 'fiberbrowser-n13-sv2-')), 'sv_demo.bam');
      execFileSync(PYTHON, [path.join(REPO_ROOT, 'tests', 'make_sv_demo_bam.py'), bam], { stdio: 'inherit' });
      await use(bam);
    },
  });

  test('shift-click two SVs, then split the reads by their combined genotype', async ({ page, server }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    const firstReads = page.waitForResponse(r => r.url().includes('/api/reads/compact') && r.url().includes('chrSV') && r.ok());
    await open(page, `${server.baseUrl}/?chr=${VIEW.chrom}&start=6000&end=18000`);
    await firstReads;
    await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 30_000 }).toBe(0);
    await dismissCoach(page);

    // Variants › SVs: the list doesn't move when the first SV is ticked (audit Top 7 / bug 5), and the row's name ticks it.
    await panelButton(page, 'variants').first().click();
    await page.locator('[data-analysis-tab="svs"]').first().click();
    const svRows = page.getByTestId('variants-sv');
    await expect.poll(() => svRows.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    await expect(page.locator('[data-testid="variants-sv-combo"][data-selected="0"]')).toBeVisible();
    const before = (await svRows.nth(1).boundingBox())!.y;
    await svRows.nth(0).getByTestId('variants-sv-name').click();
    await expect(page.locator('[data-testid="variants-sv-combo"][data-selected="1"]')).toBeVisible();
    expect(Math.abs((await svRows.nth(1).boundingBox())!.y - before)).toBeLessThan(1);
    await svRows.nth(0).getByTestId('variants-sv-name').click();
    await expect(page.locator('[data-testid="variants-sv-combo"][data-selected="0"]')).toBeVisible();
    await expect.poll(() => store(page, s => s.selectedFeatures.length)).toBe(0);
    await page.evaluate(() => {
      const s = (window as any).__FIBERBROWSER_STORE__.getState();
      s.closeAnalysisPanel(s.panels.find((p: any) => p.contentType === 'variants').id);
    });

    // The SV row from the keyboard (SV-10): focus it, an arrow to the first SV, Shift+Enter selects it.
    const svRow = page.locator('[data-testid^="sv-track-"][role="group"]').first();
    await svRow.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('sv-cluster-tooltip')).toBeVisible();
    await page.keyboard.press('Shift+Enter');
    await expect.poll(() => store(page, s => s.selectedFeatures.length)).toBe(1);
    await page.keyboard.press('Shift+Enter');
    await expect.poll(() => store(page, s => s.selectedFeatures.length)).toBe(0);
    await page.keyboard.press('Escape');

    const svTrack = page.locator('canvas[data-testid^="sv-track-canvas-"]');
    const box = (await svTrack.boundingBox())!;
    const sidebar = Number(await page.locator('canvas[data-copilot-track="reads"]').first().getAttribute('data-track-sidebar')) || 0;
    const xAt = (pos: number) => box.x + sidebar + ((pos - 6_000) / 12_000) * (box.width - sidebar);
    await svTrack.click({ position: { x: xAt(10_750) - box.x, y: box.height / 2 }, modifiers: ['Shift'] });
    await svTrack.click({ position: { x: xAt(INS_POS) - box.x, y: box.height / 2 }, modifiers: ['Shift'] });
    await expect.poll(() => store(page, s => s.selectedFeatures.map((f: any) => f.kind + ':' + f.id.split(':')[0]))).toEqual(['sv:D', 'sv:I']);
    // The main toolbar's Cluster group shows them (the feature chip).
    const clusterGroup = await groupControls(page, 'cluster');
    const chip = clusterGroup.getByTestId('feature-selection-chip');
    await expect(chip).toBeVisible();
    await expect(chip.getByTestId('feature-selection-names')).toContainText('DEL 1.5k, INS 400');
    await expect(chip.getByTestId('feature-sv-group')).toBeVisible();

    // Group in this panel: the genotypes as the panel's named groups.
    await chip.getByTestId('feature-sv-group').click();
    await expect.poll(() => store(page, s => Object.values(Object.values(s.clusterGroupLabels)[0] ?? {}) as string[]), { timeout: 30_000 })
      .toEqual(expect.arrayContaining(['DEL 1.5k+ · INS 400+', 'DEL 1.5k+ · INS 400\u2212', 'DEL 1.5k\u2212 · INS 400+', 'DEL 1.5k\u2212 · INS 400\u2212']));

    // Split into panels: the combinations' dialog (top 4 ticked), panels named by genotype and reads.
    await chip.getByTestId('feature-split-panels').click();
    const dialog = page.getByTestId('variant-split-dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByTestId('variant-split-note')).toBeVisible();
    await expect(dialog.locator('[data-testid="variant-split-row"][data-kind="group"]')).toHaveCount(4);
    await dialog.getByTestId('variant-split-open').click();
    await expect.poll(() => store(page, s => s.panels.filter((p: any) => p.readSubset).map((p: any) => p.readSubset.label).sort())).toEqual(
      ['DEL 1.5k+ · INS 400+ (5)', 'DEL 1.5k+ · INS 400\u2212 (5)', 'DEL 1.5k\u2212 · INS 400+ (4)', 'DEL 1.5k\u2212 · INS 400\u2212 (4)']);
    // Several SVs: the panels stay on the reference; one whose reads all carry the insertion offers to expand it.
    expect(await store(page, s => s.panels.some((p: any) => p.altAllele))).toBe(false);
    // Two panels offer it (round 2, N3): as a whole pill when it fits, never an empty one; always in "…".
    const offering = page.locator('[data-header-pills]');
    await expect(offering).toHaveCount(2);
    for (const pill of await page.getByTestId('split-panel-expand-insert').all()) {
      await expect(pill).toContainText('Expand INS 400');
      expect(await pill.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
    const offeringPanel = page.locator('[data-panel-id]').filter({ has: page.locator('[data-header-pills]') }).first();
    await offeringPanel.locator('[data-testid^="panel-actions-"]').first().click();
    await expect(page.getByTestId('split-panel-expand-insert-item')).toHaveText('Expand INS 400 (this panel’s reads)');
    await page.keyboard.press('Escape');
    // Titles lead with the genotype (Top 1).
    await expect.poll(() => page.getByTestId('panel-header-title').allTextContents()).toEqual(expect.arrayContaining(['DEL 1.5k+ · INS 400+']));
    // Closing the split takes the SVs' feature chip with it (SV-9).
    await page.getByTestId('split-panel-close-all').first().click();
    await expect.poll(() => store(page, s => s.panels.filter((p: any) => p.readSubset).length), { timeout: 30_000 }).toBe(0);
    await expect.poll(() => store(page, s => s.selectedFeatures.length)).toBe(0);
    expect(errors).toEqual([]);
  });
});

