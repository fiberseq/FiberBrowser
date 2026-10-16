/**
 * Accessibility (preview) on the demo BAM, with FiberHMM's NFR-variant engine (fiberhmm-nfr, experimental):
 * Find variants on the NAPA view (main + secondary NFR) shows one list of NFR cards, stars the secondary NFR with
 * two variants ticked, opens it in place (statistics, Group in this panel), draws the co-accessibility arcs (in the
 * panel and over the reads) and the matrix, splits the reads by a pair from an arc (four groups) and from a matrix
 * cell, and opens the starred card (Starred filter) with all its variants side by side (the sequence, the motif map,
 * footprints, V-plots, phasing, prevalence, advanced plots) and its read controls, in the drawer and the side dock
 * at 1280 x 800 (the open card kept when the panel moves).
 *
 * FIBERBROWSER_TEST_FASTA (hg38) gives the motif and sequence views their reference.
 * Needs a FiberHMM with fiberhmm.inference.accessibility (exp/fh-nfr): set FIBERHMM_SOURCE_DIR / PYTHONPATH to it.
 * FIBERBROWSER_E2E_SHOTS=<dir> saves screenshots. FIBERBROWSER_E2E_NFR_CLASSES=1 also runs Find classes first
 * (slow) so variant x footprint-class arcs are drawn.
 */
import { test, expect, panelButton } from '../fixtures/server';
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

test.use({ fixtureBam: 'demo' });

const VIEW = { chrom: 'chr19', start: 47_514_500, end: 47_518_985 };
const SHOTS = process.env.FIBERBROWSER_E2E_SHOTS;
const HAS_FASTA = !!process.env.FIBERBROWSER_TEST_FASTA;
const WITH_CLASSES = process.env.FIBERBROWSER_E2E_NFR_CLASSES === '1';

const store = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => new Function('s', `return (${f})(s)`)((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;

async function openView(page: Page, baseUrl: string) {
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');
  await page.getByTestId('location-search-input').fill(`${VIEW.chrom}:${VIEW.start}-${VIEW.end}`);
  await page.getByTestId('location-search-submit').click();
  await expect.poll(() => store(page, s => `${s.start}-${s.end}`), { timeout: 20_000 }).toBe(`${VIEW.start}-${VIEW.end}`);
}

/** A screenshot in the light and the dark theme (FIBERBROWSER_E2E_SHOTS=<dir>). */
async function shot(page: Page, name: string, target?: { screenshot: (o: { path: string }) => Promise<unknown> },
  scrollTo?: { scrollIntoViewIfNeeded: () => Promise<void> }, tall = false) {
  if (!SHOTS) return;
  // A whole view or card in one image: the window is made taller for the shot (the layout is the 1280-px one).
  if (tall) await page.setViewportSize({ width: 1280, height: 1800 });
  if (scrollTo) await scrollTo.scrollIntoViewIfNeeded();
  for (const theme of ['light', 'dark'] as const) {
    const dark = await store(page, s => !!s.darkMode);
    if (dark !== (theme === 'dark')) await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().toggleDarkMode());
    await page.waitForTimeout(350);
    await (target ?? page).screenshot({ path: `${SHOTS}/${name}_${theme}.png` });
  }
  await page.evaluate(() => { const s = (window as any).__FIBERBROWSER_STORE__.getState(); if (s.darkMode) s.toggleDarkMode(); });
  if (tall) await page.setViewportSize({ width: 1280, height: 800 });
}

async function openPanel(page: Page) {
  // The rail tile (the default launcher) or the strip chip (FIBERBROWSER_TEST_PANEL_LAUNCHER=strip).
  await panelButton(page, 'accessibility').click();
  return page.getByTestId('accessibility-panel');
}

/**
 * The panel's scroll region: the nearest scrolling ancestor of the NFR list's content, its height,
 * and any height cap between the two (the panel body used to be a 400-px scroll box beside the reads).
 */
async function scrollRegion(page: Page) {
  return page.getByTestId('nfr-find').evaluate((el) => {
    const caps: string[] = [];
    for (let e = el.parentElement; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.maxHeight !== 'none') caps.push(cs.maxHeight);
      if (/(auto|scroll)/.test(cs.overflowY)) return { height: e.clientHeight, caps };
    }
    return { height: 0, caps };
  });
}

test('Accessibility (preview): the panel body fills its frame and grows with the window', async ({ page, server }) => {
  test.setTimeout(120_000);
  await openView(page, server.baseUrl);
  await openPanel(page);
  await expect(page.getByTestId('nfr-find')).toBeVisible();
  const dock = page.locator('[data-testid="panel-dock-toggle-accessibility"]:visible').first();
  // Where it opened (beside the reads or in the drawer), then the other place if the window allows.
  for (let pass = 0; pass < 2; pass++) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(500);
    const small = await scrollRegion(page);
    expect(small.caps, 'no height cap inside the panel').toEqual([]);
    await page.setViewportSize({ width: 1728, height: 1080 });
    await page.waitForTimeout(500);
    const tall = await scrollRegion(page);
    expect(tall.caps).toEqual([]);
    expect(tall.height - small.height, `body grows with the window (${small.height} -> ${tall.height})`).toBeGreaterThan(200);
    expect(tall.height, 'body fills most of the window height').toBeGreaterThan(1080 * 0.6);
    if (pass === 1 || !(await dock.count())) break;
    await dock.click();
    await expect(page.getByTestId('nfr-find')).toBeVisible();
  }
  // Full view: the body fills the window too.
  await page.locator('[data-testid="analysis-panel-header-accessibility"] [aria-label="Expand to full view"]:visible').first().click();
  await page.waitForTimeout(400);
  const full = await scrollRegion(page);
  expect(full.caps).toEqual([]);
  expect(full.height).toBeGreaterThan(1080 * 0.6);
});

test('Accessibility (preview): Find variants lists NAPA variants, groups reads and draws arcs', async ({ page, server }) => {
  test.setTimeout(WITH_CLASSES ? 1_200_000 : 900_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await openView(page, server.baseUrl);

  if (WITH_CLASSES) {
    await panelButton(page, 'footprint-analysis').click();
    const card = page.getByTestId('consensus-tools');
    await card.getByTestId('run-lattice-consensus').click();
    await expect(card.getByText(/classes/i).first()).toBeVisible({ timeout: 600_000 });
    await expect.poll(async () => (await page.request.get(`${server.baseUrl}/api/footprint/consensus/jobs`)).json()
      .then((j: any) => j.jobs.some((x: any) => x.status === 'complete')), { timeout: 600_000, intervals: [3000] }).toBe(true);
  }

  const panel = await openPanel(page);
  await expect(page.getByTestId('analysis-panel-header-accessibility')).toContainText('NFRs');
  await expect(page.getByTestId('nfr-preview-note')).toHaveCount(0);
  await expect(panel.getByTestId('nfr-preview-badge')).toHaveCount(0);
  await expect(panel.getByTestId('nfr-region-line')).toHaveText('Analyses: chr19:47,514,500–47,518,985 · 4,485 bp · this view');
  // Raw opening percentage, beside Stringency: at 15% the view's rarer openings (found at the 10% default) are left out, so the
  // secondary NFR keeps the prototype's bounds.
  const rarest = panel.getByTestId('nfr-min-fraction');
  await expect(rarest).toBeEnabled({ timeout: 20_000 });
  await expect(panel.getByTestId('nfr-rarest')).toContainText('10% default');
  await rarest.fill('0.15');
  await expect(panel.getByTestId('nfr-rarest')).toContainText('15%');
  await panel.getByTestId('nfr-find').click();
  await expect(panel.getByTestId('nfr-progress')).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByTestId('nfr-card').first()).toBeVisible({ timeout: 360_000 });
  await expect(panel.getByTestId('nfr-detection-line')).toContainText(/NFRs open in ≥ 15% of reads · background [\d.]+% · fold and q are informative, not gates/);
  await expect(panel.getByTestId('nfr-card-detection').first()).toContainText(/open in \d+% of reads · background/);

  // The NFRs are detected from the reads (main, a small one between, secondary); the secondary one has the
  // prototype's three variants (left, full and right registers).
  const cards = panel.getByTestId('nfr-card');
  await expect.poll(() => cards.count()).toBeGreaterThanOrEqual(2);
  const secondary = cards.last();
  await expect(secondary.getByTestId('nfr-variant-row')).toHaveCount(3);
  await expect(secondary).toContainText('alternative-left');
  await expect(secondary).toContainText('alternative-right');
  await expect(secondary).toContainText(/reads callable/);
  await expect(cards.nth(0).getByTestId('nfr-variant-row').first()).toBeVisible();
  // One list (no Discover / Saved tabs): each card shows its variants (stacked bars, one prevalence each, a mini
  // profile) and opens in place. Saved region in the region picker is a separate control.
  await expect(panel.getByRole('button', { name: /^Saved(?: \(\d+\))?$/ })).toHaveCount(0);
  await expect(panel.getByTestId('nfr-region-region')).toHaveText('Saved region');
  await expect(secondary.getByTestId('nfr-lanes')).toBeVisible();
  await expect.poll(() => secondary.getByTestId('nfr-mini-profile').count(), { timeout: 20_000 }).toBe(3);
  await expect(secondary.getByTestId('nfr-card-body')).toHaveCount(0);
  await shot(page, 'discover_overview', panel);

  // Untick the middle variant and star the secondary NFR: one starred entry, two variants ticked.
  await secondary.getByTestId('nfr-variant-check-input').nth(1).uncheck();
  await secondary.getByTestId('nfr-card-star').click();
  await expect(secondary).toHaveAttribute('data-starred', 'true');
  await expect(panel.getByRole('button', { name: /^Starred \(1\)/ })).toBeVisible();

  // Open it in place: the statistics, and Group in this panel (cluster assignments for the demo dataset).
  await secondary.getByTestId('nfr-card-open').click();
  await secondary.getByTestId('nfr-details-toggle').click();
  await expect(secondary.getByTestId('nfr-details')).toContainText('by prediction strength');
  // the card's terms explained (usability round 1): a legend with focusable help, the card's name kept in view
  await expect(panel.getByTestId('nfr-legend')).toContainText('callable reads');
  await expect(secondary.getByTestId('nfr-card-head')).toHaveAttribute('data-sticky', 'true');
  // the read actions are one "Reads ▾" menu
  await secondary.getByTestId('nfr-reads-menu').click();
  await secondary.getByTestId('nfr-saved-group').click();
  await expect(panel.getByTestId('nfr-group-legend')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => store(page, s => Object.keys(Object.values(s.clusterAssignments)[0] ?? {}).length), { timeout: 20_000 }).toBeGreaterThan(1000);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/nfr_reads_grouped.png` });
  await panel.getByTestId('nfr-groups-clear').click();
  await expect(panel.getByTestId('nfr-groups-bar')).toHaveCount(0);
  await secondary.getByTestId('nfr-card-open').click();

  // NFR pairs: arcs in the panel, the matrix, and the arcs on the NFR channel over the reads.
  await panel.getByRole('button', { name: /^NFR pairs/ }).click();
  await expect(panel.getByTestId('nfr-arcs')).toBeVisible();
  // The defaults cull to the strongest pairs (q <= 0.05, |log2 OR| >= 1, top 20); widen them for the rest of the tour.
  await expect(panel.getByTestId('nfr-pair-counts')).toContainText('significant');
  const culled = await panel.getByTestId('nfr-arc').count();
  expect(culled).toBeLessThanOrEqual(20);
  await panel.getByTestId('nfr-min-effect').fill('0');
  await panel.getByTestId('nfr-top-n').selectOption('0');
  await panel.getByTestId('nfr-q').fill('4');                                       // q <= 0.2
  // Each NFR with several variants is one element, folded: its arcs go to it, and the pairs between its own variants
  // wait for it to unfold (the chips say how many). Unfold them all: here, in the matrix and on the NFR track alike.
  await expect(panel.locator('[data-testid="nfr-element"][data-folded="true"]').first()).toBeVisible();
  await expect.poll(() => panel.getByTestId('nfr-inner-pairs').count()).toBeGreaterThan(0);
  const foldAll = panel.getByTestId('nfr-fold-all');
  if (await foldAll.count()) await foldAll.click(); else await panel.getByTestId('nfr-fold-chip').first().click();
  await expect(panel.locator('[data-testid="nfr-element"][data-folded="true"]')).toHaveCount(0);
  await expect.poll(() => panel.getByTestId('nfr-arc').count()).toBeGreaterThan(0);
  expect(await panel.getByTestId('nfr-arc').count()).toBeGreaterThanOrEqual(culled);
  // select one element (click it: only its connections), then all again; the expanded view
  const firstPair = (await panel.getByTestId('nfr-arc').first().getAttribute('data-pair'))!.split('|')[0];
  await panel.locator(`[data-testid="nfr-element"][data-element="${firstPair}"]`).dispatchEvent('click');
  await expect(panel.getByTestId('nfr-pair-counts')).toContainText('focus');
  await expect.poll(() => panel.getByTestId('nfr-arc').evaluateAll((els, id) => els.every(e => (e as HTMLElement).dataset.pair!.split('|').includes(id)), firstPair)).toBe(true);
  await panel.getByTestId('nfr-focus').selectOption('');
  await panel.getByTestId('nfr-arcs-expand').click();
  await expect(page.getByTestId('nfr-arcs-expanded')).toBeVisible();
  await shot(page, 'arcs_expanded', page.getByRole('dialog'));
  await page.keyboard.press('Escape');
  await expect(panel.getByTestId('nfr-element').first()).toBeVisible();
  if (WITH_CLASSES) await expect(panel.getByTestId('nfr-class-join')).toContainText('molecules joined');
  await panel.getByTestId('nfr-arc').first().hover({ force: true });
  if (SHOTS) await panel.screenshot({ path: `${SHOTS}/nfr_panel_arcs.png` });

  // Click an arc: it inspects the pair (its 2x2 groups and statistics), the read panels as they were; then
  // "Group reads by this pair" puts the four groups plus the not-informative ones into the read panels.
  const arc = panel.getByTestId('nfr-arc').first();
  const pair = await arc.getAttribute('data-pair');
  const before = await store(page, s => JSON.stringify(s.clusterAssignments));
  await arc.dispatchEvent('click');
  const card = panel.getByTestId('nfr-pair-detail');
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toHaveAttribute('data-mode', 'inspect');
  await expect(card.getByTestId('nfr-split-group')).toHaveCount(4);
  await expect(card.getByTestId('nfr-split-effect')).toContainText('Adjusted log₂ OR');
  expect(await store(page, s => JSON.stringify(s.clusterAssignments))).toBe(before);
  await card.getByTestId('nfr-split-group-reads').click();
  await expect(card).toHaveAttribute('data-mode', 'grouped');
  // the read panel says what its colours are (a legend chip in its header)
  await expect(page.getByTestId('nfr-groups-chip').first()).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('nfr-groups-chip').first().click();
  await expect(page.getByTestId('nfr-groups-legend')).toContainText('Not informative');
  await page.keyboard.press('Escape');
  const ids = await store(page, s => [...new Set(Object.values(Object.values(s.clusterAssignments)[0] ?? {}))].sort());
  expect(ids.length).toBeGreaterThanOrEqual(4);
  expect(ids.every(i => [0, 1, 2, 3, 4].includes(i as number))).toBe(true);
  await expect(panel.locator(`[data-testid="nfr-arc"][data-pair="${pair}"]`)).toHaveAttribute('data-selected', 'true');
  await shot(page, 'arc_drilldown_card', card, undefined, true);
  await shot(page, 'arc_drilldown_reads', undefined, card.getByTestId('nfr-split-2x2'));

  // The matrix: click a tested pair's cell.
  await panel.getByRole('button', { name: 'Matrix', exact: true }).click();
  await expect(panel.getByTestId('nfr-matrix')).toBeVisible();
  await expect.poll(() => panel.getByTestId('nfr-matrix-cell').count()).toBeGreaterThan(0);
  if (SHOTS) await panel.screenshot({ path: `${SHOTS}/nfr_panel_matrix.png` });
  const cells = panel.locator('[data-testid="nfr-matrix-cell"][data-pair]');
  const cell = cells.nth(Math.max(0, (await cells.count()) - 1));
  const cellPair = (await cell.getAttribute('data-pair'))!;
  await cell.click();
  await expect(card).toContainText(cellPair.split('|')[0].replace(':', ' ').replace(/^class_/, 'C'), { timeout: 60_000 });
  await expect(card.getByTestId('nfr-split-group')).toHaveCount(4);
  await expect(card).toHaveAttribute('data-mode', 'inspect');
  await shot(page, 'matrix_drilldown', panel, panel.getByTestId('nfr-matrix'));
  await shot(page, 'matrix_drilldown_card', card, undefined, true);
  // Restore previous grouping (the arc's groups came off the read panels)
  await panel.getByTestId('nfr-groups-clear').click();
  expect(await store(page, s => JSON.stringify(s.clusterAssignments))).toBe(before);
  await card.getByTestId('nfr-split-close').click();
  // a pair row is the keyboard path: Enter inspects it
  await panel.getByRole('button', { name: 'Arcs', exact: true }).click();
  const row = panel.getByTestId('nfr-pair-row').first();
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(card).toHaveAttribute('data-mode', 'inspect', { timeout: 60_000 });
  await card.getByTestId('nfr-split-close').click();
  await panel.getByRole('button', { name: 'Arcs', exact: true }).click();
  // The arcs are drawn on the NFR track over the reads (on by default), with the same fold state; select there: an
  // element, then its partner, inspects the pair in the panel.
  await panel.getByTestId('nfr-show-arcs').check();
  const channel = page.locator('[data-testid^="nfr-feature-track-"]').first();
  await expect(channel.getByTestId('nfr-arc-track')).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => channel.getByTestId('nfr-arc').count()).toBeGreaterThan(0);
  await expect(channel.locator('[data-testid="nfr-feature-folded"]')).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/nfr_arcs_over_reads${WITH_CLASSES ? '_with_classes' : ''}.png` });
  const [ta, tb] = (await channel.getByTestId('nfr-arc').first().getAttribute('data-pair'))!.split('|');
  const onTrack = (id: string) => channel.locator(`[data-testid="nfr-feature-variant"][data-variant="${id}"], [data-testid="nfr-feature-class"][data-element="${id}"]`);
  await onTrack(ta).dispatchEvent('click');
  await onTrack(tb).dispatchEvent('click');
  await expect(card).toHaveAttribute('data-mode', 'inspect', { timeout: 60_000 });
  await expect(panel.locator(`[data-testid="nfr-arc"][data-pair="${ta}|${tb}"]`)).toHaveAttribute('data-selected', 'true');
  await card.getByTestId('nfr-split-close').click();
  await panel.getByTestId('nfr-focus').selectOption('');

  // Position correlation: the view's position x position matrix (Co-accessibility's), and A − B of two datasets
  // (one dataset here: it says so).
  await panel.getByRole('button', { name: 'Position correlation', exact: true }).click();
  await expect(panel.getByTestId('nfr-position-correlation')).toBeVisible();
  await expect(panel.getByTestId('coacc-matrix')).toBeVisible({ timeout: 60_000 });
  await panel.getByRole('button', { name: 'A − B', exact: true }).click();
  await expect(panel.getByTestId('coacc-diff-refused')).toContainText('Open two datasets');
  await shot(page, 'position_correlation', panel);
  await panel.getByRole('button', { name: 'NFR elements', exact: true }).click();
  await expect(panel.getByTestId('nfr-coaccess')).toBeVisible();

  // Export: the engine's files (end of the list).
  await panel.getByTestId('nfr-show-arcs').uncheck();
  await panel.getByRole('button', { name: /^NFRs/ }).click();
  const href = await panel.getByTestId('nfr-export-link').getAttribute('href');
  const tsv = await page.request.get(new URL(href!, server.baseUrl).toString());
  expect(tsv.status()).toBe(200);
  expect((await tsv.text()).split('\n')[0]).toContain('prevalence_strict\tprevalence_em');

  // Split again so the saved variant's prevalence has read groups to compare.
  await panel.getByRole('button', { name: /^NFR pairs/ }).click();
  await panel.getByTestId('nfr-arc').first().dispatchEvent('click');
  await expect(card.getByTestId('nfr-split-group')).toHaveCount(4, { timeout: 60_000 });
  await card.getByTestId('nfr-split-group-reads').click();
  await expect(card).toHaveAttribute('data-mode', 'grouped');

  // Starred: the same card (the two ticked variants); tick the rest, so its views show every variant side by side.
  await panel.getByRole('button', { name: /^NFRs/ }).click();
  await panel.getByRole('button', { name: /^Starred \(1\)/ }).click();
  const entry = panel.locator('[data-testid="nfr-card"][data-starred="true"]');
  await expect(panel.getByTestId('nfr-card')).toHaveCount(1);
  await entry.getByTestId('nfr-card-open').click();
  await expect(entry.getByTestId('nfr-card-open')).toHaveAttribute('aria-expanded', 'true');
  const toggles = entry.getByTestId('nfr-variant-check-input');
  const nVariants = await toggles.count();
  expect(nVariants).toBeGreaterThanOrEqual(2);
  await expect(toggles.and(panel.locator(':checked'))).toHaveCount(2);
  for (let i = 0; i < nVariants; i++) await toggles.nth(i).check();
  const variantNames = await entry.getByTestId('nfr-variant-row').evaluateAll(els => els.map(e => (e as HTMLElement).dataset.variant!.split(':')[1]));
  await expect(entry).toHaveAttribute('data-variants', variantNames.join(','));
  const inspect = entry.getByTestId('nfr-saved-inspect');
  await expect(inspect).toBeVisible();
  // The sequence: copied (and the FASTA, with coordinates in its header).
  if (HAS_FASTA) {
    await entry.getByTestId('nfr-seq-copy').click();
    await expect(entry.getByTestId('nfr-seq-notice')).toHaveText(/^Copied N\d+ \([\d,]+ bp, chr19:[\d,]+-[\d,]+\)$/, { timeout: 30_000 });
    const download = page.waitForEvent('download');
    await entry.getByTestId('nfr-seq-fasta').click();
    const fasta = readFileSync((await (await download).path())!, 'utf8');
    expect(fasta.split('\n')[0]).toMatch(/^>N\d+ chr19:\d+-\d+ NFR window$/);
    expect(fasta.split('\n')[1]).toMatch(/^[ACGTN]{60}$/);
  }
  // The read controls of the open card (the Reads menu): group, split by combination pattern, select as features.
  const reads = async (id: string) => { await entry.getByTestId('nfr-reads-menu').click(); await entry.getByTestId(id).click(); };
  await reads('nfr-saved-group');
  await expect(panel.getByTestId('nfr-groups-bar')).toBeVisible({ timeout: 30_000 });
  await expect(entry.getByTestId('nfr-reads-state')).toHaveText('Grouped by variant');
  await reads('nfr-saved-split-patterns');
  await expect(panel.getByTestId('nfr-groups-bar')).toContainText('pattern', { timeout: 30_000 });
  await panel.getByTestId('nfr-groups-clear').click();
  await reads('nfr-saved-select-features');
  await expect.poll(() => store(page, s => s.selectedFeatures.length)).toBe(nVariants);
  await reads('nfr-saved-select-features');
  await expect.poll(() => store(page, s => s.selectedFeatures.length)).toBe(0);
  if (HAS_FASTA) {
    // Motifs: one figure (the variants' spans, the pinned factors' sites, coverage per site and variant), one summary
    // table; no enrichment / NFR size / profile tabs, no q columns outside Details.
    await expect(inspect.getByTestId('nfr-motif-summary')).toBeVisible({ timeout: 180_000 });
    await expect(inspect.getByTestId('nfr-motif-tab-enrichment')).toHaveCount(0);
    await expect(inspect.getByTestId('nfr-motif-tab-sizes')).toHaveCount(0);
    await expect(inspect.getByTestId('nfr-motif-table')).toBeVisible();
    const header = await inspect.getByTestId('nfr-motif-table').locator('th').allTextContents();
    for (const v of variantNames) expect(header).toContain(v);                       // a column per variant
    // every family on request; a search puts the matching families on the map
    await inspect.getByTestId('nfr-motif-show-all').click();
    const unpinned = inspect.locator('[data-testid="nfr-motif-row"][data-pinned="0"]').first();
    await expect(unpinned).toBeVisible();
    const family = (await unpinned.getAttribute('data-motif'))!;
    await inspect.getByTestId('nfr-motif-search').fill(family);
    await expect(inspect.getByTestId('nfr-motif-map-wrap')).toHaveAttribute('data-families', new RegExp(family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), { timeout: 60_000 });
    await expect(inspect.getByTestId('nfr-motif-map')).toBeVisible();
    await shot(page, 'saved_motif_map_search', inspect, undefined, true);
    // a motif with no site here: one message with the way out (Relax threshold, one step looser everywhere)
    await inspect.getByTestId('nfr-motif-search').fill('zzznomotif');
    await expect(inspect.getByTestId('nfr-motif-zero')).toContainText('zzznomotif: no site at p ≤');
    await expect(inspect.getByTestId('nfr-motif-notice')).toHaveCount(0);
    await expect(inspect.getByTestId('nfr-motif-map-empty')).toHaveCount(0);
    await inspect.getByTestId('nfr-motif-relax').click();
    await expect(inspect.getByTestId('nfr-motif-threshold')).toContainText('p ≤ 0.001');
    await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setMotifPValue(1e-4));
    await inspect.getByTestId('nfr-motif-search').fill('');
    // the one test per site, behind Details
    await inspect.getByTestId('nfr-motif-details').locator('summary').click();
    await expect(inspect.getByTestId('nfr-cover-test-head')).toHaveText('Coverage differs (q)');
    // ChIP-Atlas: choose experiments by cell type class; the count follows (the experiment list is on disk in the
    // scratch HOME when the run provides it; otherwise the panel offers the download)
    await inspect.getByTestId('nfr-chipatlas-disclosure').locator('summary').click();
    const chip = inspect.getByTestId('nfr-chipatlas');
    await expect(chip.getByTestId('nfr-chipatlas-filter').or(chip.getByTestId('nfr-chipatlas-metadata'))).toBeVisible({ timeout: 120_000 });
    if (await chip.getByTestId('nfr-chipatlas-filter').count()) {
      await expect(chip.getByTestId('nfr-chipatlas-count')).toHaveText(/ match$/, { timeout: 30_000 });
      const before = await chip.getByTestId('nfr-chipatlas-count').textContent();
      const firstClass = await chip.getByTestId('nfr-chipatlas-class').locator('option').nth(1).getAttribute('value');
      await chip.getByTestId('nfr-chipatlas-class').selectOption(firstClass!);
      await expect.poll(() => chip.getByTestId('nfr-chipatlas-count').textContent(), { timeout: 30_000 }).toMatch(/ match$/);
      await expect.poll(() => chip.getByTestId('nfr-chipatlas-count').textContent(), { timeout: 30_000 }).not.toBe(before);
      await expect(chip.getByTestId('nfr-chipatlas-start')).toBeEnabled();
      await shot(page, 'saved_chipatlas_filter', chip);
      await chip.getByTestId('nfr-chipatlas-all').click();
    }
  }
  await shot(page, 'saved_motifs', inspect, undefined, true);
  // Footprints: the classes, or Run Find classes for this window when there are none
  await inspect.getByRole('button', { name: 'Footprints' }).click();
  await expect(inspect.getByTestId('nfr-classes-view')).toBeVisible();
  await expect(inspect.getByTestId('nfr-class-row').first().or(inspect.getByTestId('nfr-run-classes'))).toBeVisible({ timeout: 60_000 });
  if (!WITH_CLASSES) await expect(inspect.getByTestId('nfr-run-classes')).toHaveText('Run Find classes for this window');
  await shot(page, 'saved_footprints', inspect, undefined, true);
  await inspect.getByRole('button', { name: 'Advanced' }).click();
  await expect(inspect.getByTestId('nfr-width-plot')).toBeVisible({ timeout: 60_000 });
  await expect(inspect.getByTestId('nfr-edge-plot')).toHaveCount(0);
  await expect(inspect.getByTestId('nfr-boundary-plot')).toBeVisible();
  if (HAS_FASTA) await expect(inspect.getByTestId('nfr-seq-features')).toBeVisible({ timeout: 60_000 });
  await shot(page, 'saved_advanced', inspect, undefined, true);
  await inspect.getByRole('button', { name: 'V-plots' }).click();
  await expect(inspect.getByTestId('nfr-vplot')).toHaveCount(nVariants + 1, { timeout: 60_000 });   // all openings + one per variant
  await expect(inspect.getByTestId('nfr-vplot-kind-coverage')).toHaveAttribute('aria-selected', 'true');   // the default
  await expect(inspect.getByTestId('nfr-vplot-size-max')).toHaveValue('1000');
  await shot(page, 'saved_vplots', inspect, undefined, true);
  // maximised: left / right step through the panel's V-plots, the name shown
  await inspect.getByTestId('nfr-vplot').first().dblclick();
  const viewer = page.getByTestId('nfr-vplot-viewer');
  await expect(viewer.getByTestId('nfr-vplot-viewer-name')).toContainText('All openings');
  await page.keyboard.press('ArrowRight');
  await expect(viewer.getByTestId('nfr-vplot-viewer-name')).toContainText(variantNames[0]);
  await shot(page, 'saved_vplot_viewer', viewer);
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await inspect.getByRole('button', { name: 'Phasing' }).click();
  await expect(inspect.getByTestId('nfr-phasing-boundary')).toBeVisible({ timeout: 60_000 });
  await shot(page, 'saved_phasing', inspect, undefined, true);
  await inspect.getByRole('button', { name: 'Prevalence' }).click();
  await expect(inspect.getByTestId('nfr-prevalence-plot')).toBeVisible({ timeout: 60_000 });
  await shot(page, 'saved_prevalence', inspect, undefined, true);

  // Find classes from the card: the shared job status (stage, elapsed time, Cancel), then Co-accessibility says the
  // classes were found after this run and offers to re-run (never "no classes" while classes exist).
  if (!WITH_CLASSES) {
    await inspect.getByRole('button', { name: 'Footprints' }).click();
    await expect(inspect.getByTestId('nfr-find-classes-status-hint')).toHaveText('Usually several minutes for a view this size.');
    await inspect.getByTestId('nfr-run-classes').click();
    const status = inspect.getByTestId('nfr-find-classes-status');
    await expect(status).toHaveAttribute('data-state', /queued|running/, { timeout: 30_000 });
    await expect(inspect.getByTestId('nfr-find-classes-status-cancel')).toBeVisible();
    await expect(inspect.getByTestId('nfr-find-classes-status-elapsed')).toContainText('elapsed');
    await shot(page, 'saved_find_classes_status', inspect, undefined, true);
    await expect(inspect.getByTestId('nfr-class-row').first().or(inspect.getByTestId('nfr-class-reason').filter({ hasText: 'No footprint class in this NFR.' })))
      .toBeVisible({ timeout: 900_000 });
    await panel.getByRole('button', { name: /^NFR pairs/ }).click();
    const join = panel.getByTestId('nfr-class-join');
    await expect(join).toHaveAttribute('data-state', 'after-run', { timeout: 30_000 });
    await expect(join).toContainText('found after this run');
    await expect(join).not.toContainText('no classes');
    await shot(page, 'coaccess_rerun_prompt', panel);
    await panel.getByTestId('nfr-class-rerun').click();
    await expect(panel.getByTestId('nfr-progress')).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByTestId('nfr-class-join')).toContainText('molecules joined', { timeout: 600_000 });
    await panel.getByRole('button', { name: /^NFRs/ }).click();
  }

  // The other layout (drawer <-> beside the reads) at 1280 x 800.
  const dock = page.locator('[data-testid="panel-dock-toggle-accessibility"]:visible').first();
  if (await dock.count()) {
    await dock.click();
    await page.waitForTimeout(800);
    const moved = page.getByTestId('accessibility-panel');
    // moved, the panel keeps its filter and the open card
    const kept = moved.locator('[data-testid="nfr-card"][data-starred="true"]');
    await expect(kept.getByTestId('nfr-card-open')).toHaveAttribute('aria-expanded', 'true');
    await kept.getByRole('button', { name: 'Prevalence' }).click();
    await expect(moved.getByTestId('nfr-prevalence-plot')).toBeVisible({ timeout: 60_000 });
    await shot(page, 'dock_saved_prevalence', undefined, moved.getByTestId('nfr-prevalence-plot'));
    await moved.getByRole('button', { name: 'All', exact: true }).click();
    await shot(page, 'dock_discover_overview');
  }
  expect(errors).toEqual([]);
});
