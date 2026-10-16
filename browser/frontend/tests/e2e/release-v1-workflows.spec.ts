/**
 * 1.0 workflow guards: Quality group, the Footprints panel's size picker, saved
 * entries (filter refresh, auto names, undo), membership clustering, typed
 * "+ Add source", the history timeline, Labeling as its own panel, and
 * too-narrow panels.
 *
 * Pinned to the tracked NAPA demo BAM (chr19:47514000-47518000) whatever
 * FIBERBROWSER_TEST_BAM / FIBERBROWSER_TEST_DATA_DIR say: the saved-range tests
 * Cmd-click a spot on the read canvas (a few rows are tried) and need it to be a
 * nucleosome call. On other data the click can land on a short TF call (the
 * lab's rich DAF BAM gives a 19 bp `tf` footprint there), and "≥90 bp" on the
 * `tf` layer then correctly matches no reads. That, not a regression, was the
 * 2026-09-29 audit's "Filter reads not applied" failure.
 */
import { test, expect, panelButton } from './fixtures/server';
import { clickPanelAction } from './fixtures/panelActions';
import type { Page } from '@playwright/test';
import type { ServerFixture } from './fixtures/server';

async function openAt(page: Page, server: ServerFixture, width = 1600, height = 1000) {
  await page.setViewportSize({ width, height });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');
  const r = server.defaultRegion!;
  const input = page.getByTestId('location-search-input');
  const reads = page.waitForResponse(res => res.url().includes('/api/reads/compact'), { timeout: 45_000 }).catch(() => null);
  await input.fill(`${r.chrom}:${r.start}-${r.end}`);
  await page.getByTestId('location-search-submit').click();
  await reads;
  await page.waitForTimeout(1500);
}

const getState = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => { const s = (window as any).__FIBERBROWSER_STORE__.getState(); return new Function('s', `return (${f})(s)`)(s); }, fn.toString()) as Promise<T>;

/** Cmd-click a footprint and save the given quick range. */
async function saveRange(page: Page, quick: RegExp) {
  const block = page.getByTestId('footprint-size-block').first();
  await block.getByRole('button', { name: quick }).click();
  await block.getByRole('button', { name: 'Save', exact: true }).click();
}

async function selectFootprint(page: Page) {
  const canvas = page.locator('[data-copilot-track="reads"]').first();
  // A nucleosome call about 55% across and a fifth of the way down the reads.
  // Which read row is under one pixel depends on the panel's height (toolbar
  // and panel layout), so try a few rows around it; a click that misses (a gap)
  // or picks another layer is undone and the next row is tried. The canvas is
  // measured before each try: the first Cmd-click opens the Footprints panel
  // beside the reads, which narrows them (and a toolbar that wraps moves them down).
  for (const fy of [0.2, 0.22, 0.18, 0.24, 0.16, 0.26, 0.21, 0.19, 0.23, 0.17]) {
    const box = (await canvas.boundingBox())!;
    await page.keyboard.down('Meta');
    await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * fy);
    await page.keyboard.up('Meta');
    const layer = await expect.poll(() => getState(page, s => s.selectedFootprints[0]?.layer ?? null), { timeout: 3_000 })
      .not.toBeNull().then(() => getState(page, s => s.selectedFootprints[0]?.layer), () => null);
    if (layer === 'nuc') break;
    if (layer) await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().clearFootprintSelection());
  }
  await expect(page.getByTestId('footprint-size-block').first()).toBeVisible({ timeout: 30_000 });
  // The saved "≥ 90" range below only matches reads if the click picked a
  // nucleosome-layer call; fail here, clearly, if the fixture data changes.
  const picked = await getState(page, s => s.selectedFootprints[0] && { layer: s.selectedFootprints[0].layer, size: s.selectedFootprints[0].size });
  expect(picked, 'the Cmd-click should select a nucleosome call on the demo BAM').toMatchObject({ layer: 'nuc' });
}

test.use({ fixtureBam: 'demo' });

test.describe('1.0 workflows', () => {

  test('Quality group: default summary, edges control, Edit filters opens Labeling', async ({ server, page }) => {
    await openAt(page, server);
    await expect(page.getByTestId('toolbar-group-quality')).toContainText('FIRE default');
    await page.getByTestId('toolbar-group-toggle-quality').click();
    await expect(page.getByTestId('quality-controls-toolbar')).toBeVisible();
    await page.getByRole('button', { name: 'Soft' }).click();
    expect(await getState(page, s => s.activeColormap.edgeAmbiguity.mode)).toBe('soft');
    await page.getByRole('button', { name: 'Edit filters…' }).click();
    await expect(page.locator('[data-panel-content-type="colormap"]')).toBeVisible();
    // Labeling left the Rules panel.
    await panelButton(page, 'cluster-features').click();
    await expect(page.locator('[data-panel-content-type="cluster-features"] [data-analysis-tab="labeling"]')).toHaveCount(0);
  });

  test('saved size range: auto name follows edits, filter refreshes, edit is undoable', async ({ server, page }) => {
    await openAt(page, server);
    await selectFootprint(page);
    await saveRange(page, /≥ 90/);
    await page.getByRole('button', { name: /^Saved \(1\)/ }).click();
    await page.waitForTimeout(4000); // co-occupancy result
    await page.getByRole('button', { name: 'Filter reads' }).first().click();
    await expect.poll(() => getState(page, s => s.footprintFilterKey)).toMatch(/^cart:/);
    const before = await getState(page, s => Object.values(s.filteredReadIds).map((v: any) => v?.size ?? 0)[0]);

    await page.getByText(/≥90 bp @ fp1/).first().click();
    await page.getByText('Advanced: matching rule').first().click();
    await page.getByTitle('Min size (bp)').first().fill('160');
    await expect(page.getByText(/≥160 bp @ fp1/).first()).toBeVisible();
    // The filter is re-applied with the new definition, not dropped.
    await expect.poll(() => getState(page, s => s.footprintFilterKey), { timeout: 20_000 }).toMatch(/^cart:/);
    await expect.poll(() => getState(page, s => Object.values(s.filteredReadIds).map((v: any) => v?.size ?? 0)[0]), { timeout: 20_000 })
      .not.toBe(before);

    await page.waitForTimeout(1200); // undo step settles
    await page.keyboard.press('Meta+z');
    await expect.poll(() => getState(page, s => s.footprintGroups[0]?.sizeMin)).toBe(90);
  });

  test('Footprints panel clusters reads by which saved footprints they carry', async ({ server, page }) => {
    await openAt(page, server);
    await selectFootprint(page);
    await saveRange(page, /≥ 90/);
    await saveRange(page, /35–80/);
    await page.getByRole('button', { name: /^Co-occupancy/ }).click();
    // Two saved footprints: both ticked under "Cluster by", and the button says so.
    const picks = page.getByTestId('coocc-cluster-pick');
    await expect(picks).toHaveCount(2);
    await expect(picks.nth(0)).toHaveAttribute('aria-checked', 'true');
    await expect(picks.nth(1)).toHaveAttribute('aria-checked', 'true');
    const cluster = page.getByRole('button', { name: 'Cluster reads by 2 footprints' });
    await expect(cluster).toBeEnabled({ timeout: 30_000 });
    await cluster.click();
    await expect(page.getByTestId('membership-cluster-legend')).toBeVisible();
    const assigned = await getState(page, s => Object.values(s.clusterAssignments).reduce((n: number, a: any) => n + Object.keys(a || {}).length, 0));
    expect(assigned).toBeGreaterThan(0);
    // Untick one: clustering by the other alone gives at most two patterns (with / without),
    // and the choice is remembered for this locus.
    await picks.nth(1).click();
    await expect(picks.nth(1)).toHaveAttribute('aria-checked', 'false');
    await page.getByRole('button', { name: 'Cluster reads by 1 footprint', exact: true }).click();
    await expect.poll(() => page.getByTestId('membership-cluster-legend').locator(':scope > div').count()).toBeLessThanOrEqual(2);
    expect(await getState(page, s => s.cooccClusterSelections.at(-1)?.groupIds.length)).toBe(1);
  });

  test('closing a dataset is undoable: Undo reopens it from its file, Redo closes it again', async ({ server, page }) => {
    await openAt(page, server);
    const ids = () => getState(page, s => s.datasets.map((d: any) => d.id).join(','));
    const before = await ids();
    expect(before).not.toBe('');
    await clickPanelAction(page, 'panel-close');
    await expect.poll(ids).toBe('');
    await page.keyboard.press('Meta+z');
    await expect.poll(ids, { timeout: 30_000 }).toBe(before);
    await expect(page.locator('[data-copilot-track="reads"]').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('nav-status')).toHaveCount(0, { timeout: 30_000 });
    await page.keyboard.press('Meta+Shift+z');
    await expect.poll(ids, { timeout: 30_000 }).toBe('');
  });

  test('+ Add source takes a typed motif sequence into the same track', async ({ server, page }) => {
    await openAt(page, server);
    await panelButton(page, 'track-browser').click();
    await page.getByRole('button', { name: '+ Combined track' }).click();
    const count = () => getState(page, s => s.compositeTracks.length);
    const tracksBefore = await count();
    await page.getByRole('button', { name: '+ Add source' }).last().click();
    await page.getByLabel('Add a source').fill('CACGTG');
    await page.getByRole('option', { name: /Add sequence motif/ }).click();
    await expect.poll(() => getState(page, s => s.compositeTracks.at(-1)?.sources.length)).toBe(1);
    expect(await count()).toBe(tracksBefore); // no separate motif track
  });

  test('history timeline opens from Undo/Redo; Copilot panel has no timeline tab', async ({ server, page }) => {
    await openAt(page, server);
    await page.getByTestId('history-timeline-button').click();
    await expect(page.getByTestId('history-timeline')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('history-timeline')).toHaveCount(0);
    await panelButton(page, 'history').click();
    await expect(page.locator('[data-panel-content-type="history"]')).not.toContainText('Timeline');
  });

  test('in a narrow window side panels stay beside the reads at a usable width and the row scrolls', async ({ server, page }) => {
    await openAt(page, server, 1100, 700);
    for (const id of ['dataset-layout', 'primer-design', 'history']) {
      await panelButton(page, id).click();
    }
    // Usability round 1 (docking policy): three side panels and the reads don't fit at 1100 px, and nothing goes to
    // a drawer by itself: each keeps a usable width and the row scrolls sideways; the last opened is scrolled into view.
    await expect(page.getByTestId('analysis-overlay')).toHaveCount(0);
    const scroller = page.getByTestId('panel-row-scroll');
    await expect(scroller).toHaveCount(1);
    await expect(page.locator('[data-panel-content-type="history"]')).toBeInViewport();
    for (const id of ['dataset-layout', 'primer-design', 'history']) {
      const box = (await page.locator(`[data-panel-content-type="${id}"]`).boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(320);
    }
    await expect(page.getByTestId('panel-too-narrow')).toHaveCount(0);
    // A strip chip of a panel out of view scrolls it into view (it doesn't close it).
    await scroller.evaluate(el => { el.scrollLeft = el.scrollWidth; });
    await page.waitForTimeout(300);
    await panelButton(page, 'dataset-layout').click();
    await expect(page.locator('[data-panel-content-type="dataset-layout"]')).toBeInViewport({ ratio: 0.9 });
    // The reads keep their minimum beside the side panels.
    const reads = (await page.locator('[data-copilot-track="reads"]').first().boundingBox())!;
    expect(reads.width).toBeGreaterThanOrEqual(330);
  });

  test('a panel pinned to the side slides over the reads in a wide window, and reopens pinned', async ({ server, page }) => {
    await openAt(page, server, 1600, 900);
    await panelButton(page, 'history').click();
    const readsWidth = async () => (await page.locator('[data-copilot-track="reads"]').first().boundingBox())!.width;
    // Docked beside the reads: the reads share the row.
    expect(await readsWidth()).toBeLessThan(1200);
    await expect(page.getByTestId('analysis-overlay')).toHaveCount(0);
    await page.getByTestId('panel-dock-toggle-history').click();
    const overlay = page.getByTestId('analysis-overlay');
    await expect(overlay.locator('[data-panel-content-type="history"]')).toBeVisible();
    // Pinned: the reads take the whole width under the drawer.
    await expect.poll(readsWidth).toBeGreaterThan(1400);
    // Closed and reopened, it comes back pinned; Undo docks it beside the reads again.
    await panelButton(page, 'history').click();
    await expect(page.locator('[data-panel-content-type="history"]')).toHaveCount(0);
    await panelButton(page, 'history').click();
    await expect(overlay.locator('[data-panel-content-type="history"]')).toBeVisible();
    await page.getByTestId('panel-dock-toggle-history').click();
    await expect(page.getByTestId('analysis-overlay')).toHaveCount(0);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await expect(page.getByTestId('analysis-overlay').locator('[data-panel-content-type="history"]')).toBeVisible();
  });

  // --- 2026-09-30 UI audit: Escape, undo labels, theme, dialogs (H1, H6, M27, L6; Codex keyboard) ---

  /** Two peaks picked and the reads clustered on them. */
  async function clusterOnTwoPeaks(page: Page) {
    await expect.poll(() => getState(page, s => s.getAllPeaks().length), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().replacePeakSelection([0, 1]));
    await page.getByTestId('cluster-run-button').click();
    await expect.poll(() => getState(page, s => Object.values(s.clusterAssignments).reduce((n: number, a: any) => n + Object.keys(a || {}).length, 0)), { timeout: 45_000 })
      .toBeGreaterThan(0);
    await page.waitForTimeout(1600); // the clustering's history step settles
  }
  const clusterState = (page: Page) => getState(page, s => ({
    peaks: s.selectedPeaks.size,
    assigned: Object.values(s.clusterAssignments).reduce((n: number, a: any) => n + Object.keys(a || {}).length, 0),
    steps: s._historyStack.length,
  }));

  test('Escape closes the open menu or dialog only: the clustering, peak selection and history stay', async ({ server, page }) => {
    await openAt(page, server);
    await clusterOnTwoPeaks(page);
    const before = await clusterState(page);

    await page.getByTestId('history-timeline-button').click();
    await expect(page.getByTestId('history-timeline')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('history-timeline')).toHaveCount(0);
    expect(await clusterState(page)).toEqual(before);

    await page.getByTestId('toolbar-more-button').click();
    await expect(page.getByTestId('toolbar-more-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('toolbar-more-menu')).toHaveCount(0);
    expect(await clusterState(page)).toEqual(before);

    await page.keyboard.press('?');
    await expect(page.getByTestId('keyboard-shortcuts-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('keyboard-shortcuts-dialog')).toHaveCount(0);

    expect(await clusterState(page)).toEqual(before);
    // Nothing is focused and the selection carries the clustering: a bare Escape changes nothing either.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    expect(await clusterState(page)).toEqual(before);
  });

  test('Undo names the step it undoes; Sort is a step; dark mode is not part of undo', async ({ server, page }) => {
    await openAt(page, server);
    const undoTitle = () => page.getByTestId('quick-undo-button').getAttribute('title');
    const viewport = () => getState(page, s => `${s.chrom}:${s.start}-${s.end}`);

    await page.getByTestId('zoom-out-button').click();
    const zoomed = await viewport();
    // Readable coordinates, as the location box writes them.
    await expect.poll(undoTitle, { timeout: 10_000 }).toMatch(/^Undo: Navigate to chr19:\d{2},\d{3},\d{3}-\d{2},\d{3},\d{3} /);

    // Dark mode on (the rail's moon button); not an undo step.
    await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);

    // Sort is recorded once its result arrives (Undo pressed before that undoes the step before it).
    const sorted = page.waitForResponse(r => r.url().includes('/api/sort_reads') && r.ok(), { timeout: 45_000 });
    await page.getByTestId('sort-run-button').click();
    await sorted;
    await expect.poll(undoTitle, { timeout: 10_000 }).toMatch(/^Undo: Sort by /);
    expect(await getState(page, s => Object.values(s.readSortOrder).some((o: any) => (o?.length ?? 0) > 0))).toBe(true);

    await page.getByTestId('quick-undo-button').click();
    await expect.poll(() => getState(page, s => Object.values(s.readSortOrder).some((o: any) => (o?.length ?? 0) > 0))).toBe(false);
    await expect(page.getByTestId('quick-redo-button')).toHaveAttribute('title', /^Redo: Sort by /);
    expect(await viewport()).toBe(zoomed);
    expect(await getState(page, s => s.darkMode)).toBe(true);
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  });

  test('with Export open, keys do not change the view behind it; Escape closes it', async ({ server, page }) => {
    await openAt(page, server);
    const viewport = () => getState(page, s => `${s.chrom}:${s.start}-${s.end}`);
    const before = await viewport();
    await page.getByTestId('export-screenshot-button').click();
    const close = page.getByRole('button', { name: 'Close export dialog' });
    await expect(close).toBeVisible();
    await close.focus();
    const sidebar = await getState(page, s => s.sidebarOpen);
    for (const key of ['ArrowDown', 'ArrowUp', 'ArrowLeft', '-', 'r', 'Meta+b', 'Control+b']) await page.keyboard.press(key);
    await page.waitForTimeout(800);
    expect(await viewport()).toBe(before);
    expect(await getState(page, s => s.sidebarOpen)).toBe(sidebar);
    // Escape closes Export (and only that).
    await page.keyboard.press('Escape');
    await expect(close).toHaveCount(0);
    expect(await viewport()).toBe(before);
    await page.keyboard.press('ArrowDown');
    await expect.poll(viewport).not.toBe(before);
  });
});
