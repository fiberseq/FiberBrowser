/**
 * Features (NFR variants, footprint classes) in the read view, on the demo BAM with FiberHMM's NFR engine:
 * Find variants -> the NFR channel above the reads -> shift-select the variants of one NFR -> Cluster (combinatorial)
 * gives exactly the groups of the NFR card's "Group in this panel" -> Sort and Filter by membership -> Split into panels
 * (a panel per variant, the right read counts) -> co-cluster the split panels -> the same from the starred, open card
 * (kept open when the split panels close), and a click in the channel opens that NFR's card at the variant from the
 * Starred filter or NFR pairs. FIBERBROWSER_E2E_FEATURE_CLASSES=1 also
 * runs Find classes (slow) and does the same with footprint classes from the class channel.
 *
 * Needs a FiberHMM with fiberhmm.inference.accessibility on PYTHONPATH. FIBERBROWSER_E2E_SHOTS=<dir> saves screenshots.
 */
import { test, expect, panelButton } from '../fixtures/server';
import type { Locator, Page } from '@playwright/test';

test.use({ fixtureBam: 'demo' });

const VIEW = { chrom: 'chr19', start: 47_514_500, end: 47_518_985 };
const SHOTS = process.env.FIBERBROWSER_E2E_SHOTS;
const WITH_CLASSES = process.env.FIBERBROWSER_E2E_FEATURE_CLASSES === '1';

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

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const theme of ['light', 'dark'] as const) {
    const dark = await store(page, s => !!s.darkMode);
    if (dark !== (theme === 'dark')) await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().toggleDarkMode());
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${SHOTS}/${name}_${theme}.png` });
  }
  await page.evaluate(() => { const s = (window as any).__FIBERBROWSER_STORE__.getState(); if (s.darkMode) s.toggleDarkMode(); });
}

/** A toolbar group's controls (opening the group when it is folded). */
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

/** What the read panels hold: assignments, order, patterns and group names (cluster ids give the colours). */
const grouping = (page: Page) => store(page, s => JSON.stringify({ a: s.clusterAssignments, o: s.clusterOrder, p: s.clusterPatterns, l: s.clusterGroupLabels }));

test('Features: the NFR channel, Cluster / Sort / Filter on selected variants, Split into panels', async ({ page, server }) => {
  test.setTimeout(WITH_CLASSES ? 1_500_000 : 900_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await openView(page, server.baseUrl);

  if (WITH_CLASSES) {
    await panelButton(page, 'footprint-analysis').click();
    await page.getByTestId('consensus-tools').getByTestId('run-lattice-consensus').click();
    await expect.poll(async () => (await page.request.get(`${server.baseUrl}/api/footprint/consensus/jobs`)).json()
      .then((j: any) => j.jobs.some((x: any) => x.status === 'complete')), { timeout: 900_000, intervals: [3000] }).toBe(true);
    // One analysis panel at a time beside the reads (two share a drawer over them): the class channel stays.
    await page.evaluate(() => {
      const s = (window as any).__FIBERBROWSER_STORE__.getState();
      for (const p of s.panels.filter((x: any) => x.contentType === 'footprint-analysis')) s.closeAnalysisPanel(p.id);
    });
  }

  // Find variants; the channel appears above the reads with every variant of the run.
  await panelButton(page, 'accessibility').click();
  const panel = page.getByTestId('accessibility-panel');
  await panel.getByTestId('nfr-find').click();
  await expect(panel.getByTestId('nfr-card').first()).toBeVisible({ timeout: 360_000 });
  const channel = page.locator('[data-testid^="nfr-feature-track-"]').first();
  await expect(channel).toBeVisible({ timeout: 30_000 });
  const cardVariants = await panel.getByTestId('nfr-variant-row').count();
  // NFRs with several variants start folded to one bar (one fold state with the NFR pairs tab): show them all
  if (await channel.getByTestId('nfr-feature-fold-all').count()) await channel.getByTestId('nfr-feature-fold-all').click();
  await expect.poll(() => channel.getByTestId('nfr-feature-variant').count()).toBe(cardVariants);

  // The NFR with the fewest variants (two or more): shift-select its variants in the channel.
  const cards = panel.getByTestId('nfr-card');
  let target = -1, fewest = 99;
  for (let i = 0; i < await cards.count(); i++) {
    const n = await cards.nth(i).getByTestId('nfr-variant-row').count();
    if (n >= 2 && n < fewest) { fewest = n; target = i; }
  }
  expect(target).toBeGreaterThanOrEqual(0);
  const card = cards.nth(target);
  const nfrId = (await card.getAttribute('data-nfr'))!;
  const variantIds = await card.getByTestId('nfr-variant-row').evaluateAll(rows => rows.map(r => (r as HTMLElement).dataset.variant!));
  // Hover a bar: its row in the panel is highlighted; a row's hover highlights the bar.
  await channel.locator(`[data-variant="${variantIds[0]}"]`).hover();
  await expect(card.locator(`[data-variant="${variantIds[0]}"]`)).toHaveAttribute('data-feature-hovered', 'true');
  for (const id of variantIds) await channel.locator(`[data-testid="nfr-feature-variant"][data-variant="${id}"]`).click({ modifiers: ['Shift'] });
  await expect.poll(() => store(page, s => s.selectedFeatures.map((f: any) => f.id))).toEqual(variantIds);
  await expect(channel.locator('[data-testid="nfr-feature-variant"][data-selected="true"]')).toHaveCount(variantIds.length);
  await expect(card.locator('[data-testid="nfr-variant-row"][data-feature-selected="true"]')).toHaveCount(variantIds.length);
  await shot(page, 'features_channel_selected');

  // Cluster (combinatorial): the NFR card's "Group in this panel" groups, names and colours.
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setClusterMethod('combinatorial'));
  const clusterGroup = await groupControls(page, 'cluster');
  await expect(clusterGroup.getByTestId('feature-selection-chip')).toContainText(nfrId);
  await page.getByTestId('cluster-run-button').click();
  await expect.poll(() => store(page, s => Object.keys(Object.values(s.clusterGroupLabels)[0] ?? {}).length), { timeout: 60_000 }).toBeGreaterThan(1);
  const fromToolbar = await grouping(page);
  await shot(page, 'features_clustered');
  await page.getByTestId('cluster-clear-button').click();
  await expect.poll(() => store(page, s => Object.keys(s.clusterAssignments).length)).toBe(0);
  await card.getByTestId('nfr-card-open').click();
  await card.getByTestId('nfr-reads-menu').click();                     // the card's read actions: one Reads menu
  await card.getByTestId('nfr-saved-group').click();
  await expect.poll(() => store(page, s => Object.keys(s.clusterAssignments).length), { timeout: 60_000 }).toBeGreaterThan(0);
  expect(await grouping(page)).toBe(fromToolbar);
  await card.getByTestId('nfr-card-open').click();

  // Sort by membership at the selected variants.
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.setState({ sortSelection: 'features' }));
  await groupControls(page, 'sort');
  await page.getByTestId('sort-run-button').click();
  await expect.poll(() => store(page, s => Object.values(s.readSortOrder).some((o: any) => o.length > 100)), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => store(page, s => s.sortSelection)).toBe('features');

  // Filter: reads in every selected variant (members of all of them).
  const filterGroup = await groupControls(page, 'filter');
  await filterGroup.locator('select').first().selectOption('features:any');
  await page.getByTestId('filter-run-button').click();
  await expect.poll(() => store(page, s => Object.values(s.filteredReadIds).filter(Boolean).length), { timeout: 30_000 }).toBeGreaterThan(0);
  const kept = await store(page, s => Math.max(...Object.values(s.filteredReadIds).filter(Boolean).map((x: any) => x.size)));
  expect(kept).toBeGreaterThan(10);
  await page.getByTestId('filter-clear-button').click();

  // Split into panels: one panel per variant of the NFR (the selection's rule), the right read counts.
  await (await groupControls(page, 'cluster')).getByTestId('feature-split-panels').click();
  const dialog = page.getByTestId('split-panels-dialog');
  await expect(dialog.getByTestId('split-panels-row').first()).toBeVisible({ timeout: 60_000 });
  const rows = await dialog.getByTestId('split-panels-row').evaluateAll(els => els.map(e => ({
    kind: (e as HTMLElement).dataset.kind, checked: (e.querySelector('input') as HTMLInputElement).checked,
    count: Number((e as HTMLElement).dataset.count),
  })));
  const ticked = rows.filter(r => r.checked);
  expect(ticked.length).toBeGreaterThanOrEqual(2);
  if (SHOTS) await dialog.screenshot({ path: `${SHOTS}/split_dialog_light.png` });
  await dialog.getByTestId('split-panels-open').click();
  await expect(dialog).toHaveCount(0);
  const splitPanels = () => store(page, s => s.panels.filter((p: any) => p.readSubset).map((p: any) => ({ key: p.stateKey, count: p.readSubset.count, label: p.readSubset.label })));
  await expect.poll(async () => (await splitPanels()).length).toBe(ticked.length);
  const made = await splitPanels();
  expect(made.map(p => p.count)).toEqual(ticked.map(r => r.count));
  expect(made[0].label).toContain(nfrId);
  await expect(page.getByTestId('split-panel-close-all').first()).toBeVisible();
  // Each split panel loads its own reads (also a subset of thousands: a registered read set, not a sample of all).
  for (const p of made) {
    // (the reads of the group in this view: a name the run counted may lie outside it)
    await expect.poll(() => page.getByTestId('panel-header-name').evaluateAll(els => els.map(e => e.getAttribute('title') ?? '')).then(t => t.some(x => {
      // ("339 of 2,698 rows drawn": the reads of this panel in view.)
      const total = Number(x.match(/ of ([\d,]+) rows? drawn|\/([\d,]+)/)?.slice(1).find(Boolean)?.replace(/,/g, ''));
      return Math.abs(total - p.count) <= Math.max(2, p.count * 0.02);
    })), { timeout: 30_000 }).toBe(true);
  }
  await shot(page, 'split_panels');

  // Co-cluster the split panels (k-means on the selected variants' spans, every split panel in one run).
  await page.evaluate(() => { const s = (window as any).__FIBERBROWSER_STORE__.getState(); s.setClusterMethod('kmeans'); s.setClusterK(2); });
  const clustered = page.waitForResponse(r => r.url().includes('/api/cluster_all') && r.ok(), { timeout: 120_000 });
  await page.getByTestId('cluster-run-button').click();
  const body = JSON.parse((await clustered).request().postData() ?? '{}');
  const windows = (body.viewports ?? []).map((v: any) => v.result_key);
  for (const p of made) expect(windows).toContain(p.key);
  await expect.poll(() => page.evaluate(keys => keys.filter(k => Object.keys((window as any).__FIBERBROWSER_STORE__.getState().clusterAssignments[k] ?? {}).length > 0).length,
    made.map(p => p.key)), { timeout: 60_000 }).toBe(made.length);
  await shot(page, 'split_panels_coclustered');
  await page.getByTestId('split-panel-close-all').first().click();
  await expect.poll(async () => (await splitPanels()).length).toBe(0);

  // The same controls on the starred, open card: select its variants as features, Split into panels from there.
  await page.getByTestId('feature-selection-clear').click();
  await card.getByTestId('nfr-card-star').click();
  await panel.getByRole('button', { name: /^Starred/ }).click();
  const starred = panel.locator(`[data-testid="nfr-card"][data-starred="true"][data-nfr="${nfrId}"]`);
  await starred.getByTestId('nfr-card-open').click();
  await starred.getByTestId('nfr-reads-menu').click();
  await starred.getByTestId('nfr-saved-select-features').click();
  await expect.poll(() => store(page, s => s.selectedFeatures.map((f: any) => f.id))).toEqual(variantIds);
  await expect(channel.locator('[data-testid="nfr-feature-variant"][data-selected="true"]')).toHaveCount(variantIds.length);
  await starred.getByTestId('nfr-reads-menu').click();
  await starred.getByTestId('nfr-saved-split-panels').click();
  const savedDialog = page.getByTestId('split-panels-dialog');
  await expect(savedDialog.getByTestId('split-panels-row').first()).toBeVisible({ timeout: 60_000 });
  const savedRows = await savedDialog.getByTestId('split-panels-row').evaluateAll(els => els.map(e => Number((e as HTMLElement).dataset.count)));
  expect(savedRows.length).toBe(rows.length);                                 // the same split as from the toolbar
  await savedDialog.getByTestId('split-panels-open').click();
  await expect.poll(async () => (await splitPanels()).length).toBe(ticked.length);
  await shot(page, 'saved_split_panels');
  // From the card too, the panels know where they were split (the run's region): away from it they say so.
  expect(await store(page, s => s.panels.filter((p: any) => p.readSubset).map((p: any) => p.readSubset.locus?.label)))
    .toEqual(Array(ticked.length).fill(nfrId));
  await page.evaluate(v => (window as any).__FIBERBROWSER_STORE__.getState().setViewport(v.chrom, v.start - 200_000, v.end - 200_000), VIEW);
  await expect(page.getByTestId('split-away-banner').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('split-away-text').first()).toContainText(`${nfrId} at chr19:`);
  await page.getByTestId('split-away-go-back').first().click();
  await expect(page.getByTestId('split-away-banner')).toHaveCount(0);
  // Closed one by one (each panel's own close): the last one shows the source panel again.
  const sourceId = await store(page, s => s.panels.find((p: any) => p.readSubset).readSubset.sourcePanelId);
  // (several split panels: wide enough for each header's own close button)
  await page.setViewportSize({ width: 2800, height: 800 });
  for (const id of await store(page, s => s.panels.filter((p: any) => p.readSubset).map((p: any) => p.id))) {
    await page.getByTestId(`panel-close-${id}`).click();
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(async () => (await splitPanels()).length).toBe(0);
  await expect.poll(() => page.evaluate(id => (window as any).__FIBERBROWSER_STORE__.getState().panels.find((p: any) => p.id === id)?.collapsed, sourceId)).toBe(false);
  // closing the split panels re-mounts the panel: the filter and the open card are kept
  await expect(page.getByTestId('accessibility-panel').locator(`[data-testid="nfr-card"][data-starred="true"][data-nfr="${nfrId}"] [data-testid="nfr-card-open"]`))
    .toHaveAttribute('aria-expanded', 'true');

  // A plain click on a variant in the NFR channel: on the NFR pairs tab it selects the variant there (one selection
  // with the arcs and the matrix); on the NFRs tab it also opens its card at the variant (ringed), from any filter.
  // The toolbar's selection is untouched.
  if (await page.getByTestId('feature-selection-clear').count()) await page.getByTestId('feature-selection-clear').click();
  const list = page.getByTestId('accessibility-panel');
  const cardOf = list.locator(`[data-testid="nfr-card"][data-nfr="${nfrId}"]`);
  await cardOf.getByTestId('nfr-card-open').click();
  await expect(cardOf.getByTestId('nfr-card-open')).toHaveAttribute('aria-expanded', 'false');
  await list.getByRole('button', { name: /^NFR pairs/ }).click();
  const clicked = variantIds[variantIds.length - 1];
  const channelVariant = channel.locator(`[data-testid="nfr-feature-variant"][data-variant="${clicked}"]`);
  await channelVariant.click();
  await expect(channelVariant).toHaveAttribute('data-focus', 'true');
  await expect(list.getByTestId('nfr-pair-counts')).toContainText('focus');
  await channelVariant.click();                                             // again: deselected
  await expect(channelVariant).not.toHaveAttribute('data-focus', 'true');
  await list.getByRole('button', { name: /^NFRs/ }).click();
  await channelVariant.click();
  await expect(cardOf.getByTestId('nfr-card-open')).toHaveAttribute('aria-expanded', 'true');
  await expect(cardOf.locator(`[data-testid="nfr-variant-row"][data-variant="${clicked}"]`)).toHaveAttribute('data-focused', 'true');
  expect(await store(page, s => s.selectedFeatures.length)).toBe(0);
  await shot(page, 'saved_focus_from_channel');
  // unstarred, on the Starred filter: the click goes back to All and opens the card
  await cardOf.getByTestId('nfr-card-star').click();
  await expect(cardOf).toHaveCount(0);                                       // Starred shows none now
  await channelVariant.click();
  await expect(cardOf.getByTestId('nfr-card-open')).toHaveAttribute('aria-expanded', 'true');
  await expect(cardOf.locator(`[data-testid="nfr-variant-row"][data-variant="${clicked}"]`)).toHaveAttribute('data-focused', 'true');

  if (WITH_CLASSES) {
    // The same with footprint classes: shift-select two classes in the class channel, Cluster (combinatorial),
    // Sort and Filter by membership.
    if (await page.getByTestId('feature-selection-clear').count()) await page.getByTestId('feature-selection-clear').click();
    const classes = page.locator('[data-testid^="consensus-family-track-"] [data-family-id]');
    await expect.poll(() => classes.count(), { timeout: 60_000 }).toBeGreaterThan(1);
    await classes.nth(0).click({ modifiers: ['Shift'] });
    await classes.nth(1).click({ modifiers: ['Shift'] });
    await expect.poll(() => store(page, s => s.selectedFeatures.filter((f: any) => f.kind === 'fp-class').length)).toBe(2);
    await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setClusterMethod('combinatorial'));
    await page.getByTestId('cluster-run-button').click();
    await expect.poll(() => store(page, s => Object.values(s.clusterGroupLabels).some((l: any) => Object.values(l).some((x: any) => /^C\S+[+−]/.test(x)))), { timeout: 60_000 }).toBe(true);
    await page.getByTestId('sort-run-button').click();
    await expect.poll(() => store(page, s => Object.values(s.readSortOrder).some((o: any) => o.length > 10)), { timeout: 30_000 }).toBe(true);
    await shot(page, 'features_classes_clustered');
  }
  expect(errors).toEqual([]);
});
