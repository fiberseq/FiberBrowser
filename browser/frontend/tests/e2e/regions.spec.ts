/**
 * Regions and highlights (fb-r4-regions) on a dm6 DddB amplicon BAM:
 * the Regions panel lists the dataset's amplicons named after their nearest
 * genes; a rename is kept for that BAM after a reload; the locus box finds a
 * region by name; a highlight drawn on a ruler shows in two panels and in an
 * exported SVG.
 *
 * Needs a dm6 DddB amplicon BAM (FIBERBROWSER_TEST_DM6_BAM)
 * and dm6 in ~/.fiberhmm/genomes (never downloaded here).
 */
import { test, expect } from './fixtures/server';
import type { Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const DM6_AMP = process.env.FIBERBROWSER_TEST_DM6_BAM?.trim() || '';
const DM6_CACHED = existsSync(path.join(homedir(), '.fiberhmm', 'genomes', 'dm6.fa.fai'));
const SHOTS = process.env.FB_REGIONS_SHOTS?.trim();

test.use({ fixtureBam: DM6_AMP || undefined });

const store = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => new Function('s', `return (${f})(s)`)((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, name) });
}

async function open(page: Page, baseUrl: string) {
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    if (!window.sessionStorage.getItem('fb-e2e-kept')) {
      window.localStorage.clear();
      window.sessionStorage.setItem('fb-e2e-kept', '1');
    }
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(baseUrl);
  await page.waitForFunction(() => !!(window as any).__FIBERBROWSER_STORE__);
  await page.waitForLoadState('networkidle');
}

async function onDm6(page: Page, baseUrl: string) {
  const status = await (await page.request.get(`${baseUrl}/api/status`)).json();
  if (status.current_genome !== 'dm6') {
    const res = await (await page.request.post(`${baseUrl}/api/load_genome?genome_id=dm6`)).json();
    expect(res.success).toBe(true);
  }
}

async function openRegions(page: Page) {
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().openAnalysisPanel('circular-genome'));
  await expect(page.getByTestId('region-catalog')).toBeVisible();
}

const amplicons = (page: Page) => page.locator('[data-testid="region-category"][data-category-name^="Amplicons"]');
const entryLabels = (page: Page) => page.getByTestId('region-entry-label').allTextContents();

test.describe('regions and highlights on amplicon data', () => {
  test.skip(!DM6_AMP || !existsSync(DM6_AMP), 'needs the dm6 amplicon BAM (FIBERBROWSER_TEST_DM6_BAM)');
  test.skip(!DM6_CACHED, 'needs dm6 in ~/.fiberhmm/genomes (not downloaded by tests)');

  test('the amplicons are listed by nearest gene; a rename is kept after a reload; the locus box finds it', async ({ page, server }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await onDm6(page, server.baseUrl);
    await open(page, server.baseUrl);
    await openRegions(page);

    // One entry per amplicon, named after its gene, with its reads.
    await expect(amplicons(page)).toHaveCount(1, { timeout: 30_000 });
    await expect(amplicons(page).getByTestId('region-category-count')).toHaveText('3');
    expect(await entryLabels(page)).toEqual(['CG9500', 'numb', 'near Gdi (4.0 kb)']);
    await expect(page.getByTestId('region-entry').filter({ hasText: 'numb' })).toContainText('2,844');
    await shot(page, 'regions-amplicons-1600.png');

    // Rename one in place.
    const numb = page.getByTestId('region-entry').filter({ hasText: 'numb' });
    await numb.getByTestId('region-entry-go').dblclick();
    const input = page.getByTestId('region-edit-input');
    await input.fill('numb enhancer amplicon');
    await input.press('Enter');
    expect(await entryLabels(page)).toEqual(['CG9500', 'numb enhancer amplicon', 'near Gdi (4.0 kb)']);
    // Saved to the user's catalog for dm6 (debounced).
    await expect.poll(async () => {
      const res = await (await page.request.get(`${server.baseUrl}/api/regions/catalog?genome=dm6`)).json();
      return res.catalog.entries.map((e: any) => e.label);
    }, { timeout: 10_000 }).toContain('numb enhancer amplicon');

    // A reload (a new session of the app): the rename is still there.
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__FIBERBROWSER_STORE__);
    await page.waitForLoadState('networkidle');
    await openRegions(page);
    await expect(amplicons(page)).toHaveCount(1, { timeout: 30_000 });
    await expect.poll(() => entryLabels(page)).toEqual(['CG9500', 'numb enhancer amplicon', 'near Gdi (4.0 kb)']);

    // The locus box finds it by name.
    const box = page.getByTestId('location-search-input');
    await box.click();
    await box.fill('enhancer amp');
    const suggestion = page.getByTestId('search-suggestion').filter({ hasText: 'numb enhancer amplicon' });
    await expect(suggestion).toBeVisible();
    await shot(page, 'regions-locus-search-1600.png');
    await box.press('ArrowDown');
    await box.press('Enter');
    await expect.poll(() => store(page, s => [s.chrom, s.start < 9_464_006, s.end > 9_467_048])).toEqual(['chr2L', true, true]);
    // Next / previous step through the category.
    await page.getByTestId('region-next').click();
    await expect.poll(() => store(page, s => s.start < 9_485_680 && s.end > 9_487_224)).toBe(true);
    await expect(page.getByTestId('region-step-label')).toHaveText(/^3 \/ 3 in Amplicons/);
    await shot(page, 'regions-stepped-1600.png');

    // The genome map marks the regions; a click on a mark goes there.
    await page.evaluate(() => { const s = (window as any).__FIBERBROWSER_STORE__.getState(); if (!s.showGenomeOverview) s.toggleGenomeOverview(); });
    const map = page.getByTestId('genome-overview');
    await expect(map).toHaveAttribute('data-region-markers', '3');
    const at = await map.evaluate((canvas: HTMLCanvasElement) => {
      // The CG9500 amplicon's mark: LABEL_WIDTH 44, RIGHT_PAD 12 (GenomeOverview.tsx); chr2L is 23,513,712 bp.
      const r = canvas.getBoundingClientRect();
      const bar = canvas.clientWidth - 44 - 12;
      return { x: r.left + 44 + ((6_356_893 + 6_357_548) / 2 / 23_513_712) * bar * (r.width / canvas.clientWidth), y: r.top + 4 };
    });
    await page.mouse.click(at.x, at.y);
    await expect.poll(() => store(page, s => s.start < 6_356_893 && s.end > 6_357_548)).toBe(true);
    await shot(page, 'regions-genome-map-1600.png');
    expect(errors).toEqual([]);
  });

  test('a highlight drawn on a ruler shows in two panels and in an exported SVG', async ({ page, server }, info) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await onDm6(page, server.baseUrl);
    await open(page, server.baseUrl);
    await page.evaluate(() => {
      const s = (window as any).__FIBERBROWSER_STORE__.getState();
      s.setViewport('chr2L', 9_463_500, 9_467_500);
      const first = s.panels.find((p: any) => p.contentType === 'dataset');
      s.duplicatePanel(first.id);
    });
    await expect.poll(() => store(page, s => s.panels.filter((p: any) => p.contentType === 'dataset' && !p.collapsed).length)).toBe(2);
    await page.waitForLoadState('networkidle');
    // The move is one undo step of its own (recorded once the view settles), before the highlight.
    await expect.poll(() => store(page, s => s.getHistoryLabels().some((h: any) => h.label.startsWith('Navigate to chr2L:9,463,500')))).toBe(true);

    // Highlight on, a colour, then drag on the first panel's ruler.
    await page.getByTestId('highlight-run-button').click();
    await expect(page.getByTestId('highlight-run-button')).toHaveAttribute('aria-pressed', 'true');
    const toggle = page.getByTestId('toolbar-group-toggle-highlight');
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await page.getByTestId('highlight-color-rose').click();
    const ruler = page.getByTestId('axis-ruler').first();
    const box = (await ruler.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height / 2, { steps: 5 });
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    const highlights = await store(page, s => s.highlights.map((h: any) => ({ genome: h.genome, chrom: h.chrom, color: h.color, w: h.end - h.start })));
    expect(highlights).toHaveLength(1);
    expect(highlights[0]).toMatchObject({ genome: 'dm6', chrom: 'chr2L', color: '#fda4af' });
    expect(highlights[0].w).toBeGreaterThan(800);
    // The view did not zoom (the drag highlighted).
    expect(await store(page, s => [s.start, s.end])).toEqual([9_463_500, 9_467_500]);

    // In both panels.
    const panelsWithIt = await page.evaluate(() => new Set([...document.querySelectorAll('[data-highlight-id]')]
      .map(el => el.closest('[data-panel-id]')?.getAttribute('data-panel-id'))).size);
    expect(panelsWithIt).toBe(2);
    // Named in the list (an undoable rename).
    await page.getByTestId('highlight-list-button').click();
    await page.getByTestId('highlight-label-input').fill('numb promoter');
    await page.getByTestId('highlight-label-input').press('Enter');
    await expect.poll(() => store(page, s => s.highlights[0].label)).toBe('numb promoter');
    await page.keyboard.press('Escape');
    await page.getByTestId('highlight-run-button').click();
    await page.mouse.move(5, 500);
    await shot(page, 'highlight-two-panels-1600.png');
    await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().toggleDarkMode());
    await shot(page, 'highlight-two-panels-dark-1600.png');
    await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().toggleDarkMode());

    // Exported SVG: the wash over the tracks of both panels, and its name.
    const track = page.locator('[data-read-track-render-count]').first();
    await expect.poll(() => track.evaluate(el => el.getAttribute('data-read-track-loading') === 'false'), { timeout: 30_000 }).toBe(true);
    await page.getByTestId('export-screenshot-button').click();
    await page.getByRole('button', { name: 'SVG', exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export SVG', exact: true }).click();
    const file = info.outputPath('highlight.svg');
    await (await download).saveAs(file);
    const svg = readFileSync(file, 'utf8');
    const washes = [...svg.matchAll(/<path d="[^"]*" fill="#fda4af" fill-opacity="0\.35"\/>/g)];
    expect(washes.length).toBeGreaterThanOrEqual(2);
    expect(svg).toContain('>numb promoter</text>');

    // Clear on the Highlight group (owner, 1 Oct: not only in the List) clears them in one undo step.
    const clear = page.getByTestId('highlight-clear-button');
    await expect(clear).toBeEnabled();
    expect((await clear.boundingBox())!.height).toBeLessThanOrEqual(24);
    await clear.click();
    await expect.poll(() => store(page, s => s.highlights.length)).toBe(0);
    await expect(clear).toBeDisabled();
    await expect(clear).toHaveAttribute('title', 'No highlights to clear');
    await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().undo());
    await expect.poll(() => store(page, s => s.highlights.map((h: any) => h.label ?? null))).toEqual(['numb promoter']);

    // Undo takes the rename back on its own, then the highlight. (Steps recorded since,
    // e.g. the view settling after the export, are undone first: count only what changes.)
    const history = await store(page, s => s.getHistoryLabels().map((h: any) => `${h.isCurrent ? '*' : ''}${h.label}`));
    const seen: Array<Array<string | null>> = [];
    for (let i = 0; i < 8 && (await store(page, s => s.highlights.length)) > 0; i++) {
      await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().undo());
      const now = await store(page, s => s.highlights.map((h: any) => h.label ?? null));
      if (JSON.stringify(now) !== JSON.stringify(seen.at(-1) ?? ['numb promoter'])) seen.push(now);
    }
    expect(seen, history.join(' | ')).toEqual([[null], []]);
    expect(errors).toEqual([]);
  });
});
