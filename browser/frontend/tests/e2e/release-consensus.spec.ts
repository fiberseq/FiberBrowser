/**
 * Release workflow for footprint classes (the lattice recaller, FiberHMM 3's
 * default consensus engine), driven through the Footprints panel on the tracked
 * NAPA demo BAM:
 *
 *   Find footprint classes → class list → class × channel table (channel chips,
 *   Export TSV with the three prevalence tiers, prevalence plot) → save two
 *   classes (Saved (n)) → tier toggles on a saved class (sent to the run's
 *   display filters) → Filter reads to a saved class → co-occupancy of the two saved classes → session save and
 *   restore keeps the saved classes and their run → tagged BAM export, reloaded
 *   as a dataset.
 *
 * The run is a 300 bp window (5 classes, ~30 s on 2 cores). The job request is
 * given FIBERBROWSER_E2E_CORES cores (default 2) so the spec stays light on a
 * shared machine; everything else is what the UI sends.
 */
import { test, expect, panelButton } from './fixtures/server';
import { clickPanelAction } from './fixtures/panelActions';
import type { Page, Response } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

test.use({ fixtureBam: 'demo' });

const REGION = { chrom: 'chr19', start: 47_515_000, end: 47_515_300 };
const DATASET = 'napa_ddda';
const CORES = Number(process.env.FIBERBROWSER_E2E_CORES ?? 2);

async function openFresh(page: Page, baseUrl: string) {
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.setViewportSize({ width: 1700, height: 1100 });
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');
  const input = page.getByTestId('location-search-input');
  await input.fill(`${REGION.chrom}:${REGION.start}-${REGION.end}`);
  await page.getByTestId('location-search-submit').click();
  await expect(input).toHaveValue(`${REGION.chrom}:${REGION.start.toLocaleString()}-${REGION.end.toLocaleString()}`);
}

const store = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => new Function('s', `return (${f})(s)`)((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;

const savedClassIds = (page: Page) =>
  store(page, s => [...new Set(s.footprintGroups.filter((g: any) => g.savedClass).map((g: any) => g.savedClass.id))].sort());

test('footprint classes: find, compare, save, tiers, co-occupancy, session, tagged BAM', async ({ page, server }, info) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  // Keep the run light on a shared machine; the rest of the request is the UI's own.
  await page.route('**/api/footprint/consensus/jobs', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = route.request().postDataJSON();
    body.parameters = { ...(body.parameters ?? {}), compute: { ...(body.parameters?.compute ?? {}), cores: CORES } };
    await route.continue({ postData: JSON.stringify(body) });
  });

  await openFresh(page, server.baseUrl);
  await panelButton(page, 'footprint-analysis').click();
  const panel = page.getByTestId('consensus-tools');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('automatic-family-mode')).toHaveText('Find footprint classes');
  await expect(panel.getByTestId('family-engine')).toHaveValue('lattice_recaller');

  // Pin the run to the window (the view already is; this is the explicit form).
  await panel.getByText('Advanced: edit classes, export, algorithm settings', { exact: true }).click();
  await panel.getByText('Algorithm, region, and display settings', { exact: true }).click();
  await panel.getByLabel('Consensus chromosome', { exact: true }).fill(REGION.chrom);
  await panel.getByLabel('Consensus start (0-based)', { exact: true }).fill(String(REGION.start));
  await panel.getByLabel('Consensus end (exclusive)', { exact: true }).fill(String(REGION.end));

  // --- Find footprint classes -------------------------------------------------------------
  const posted = page.waitForResponse(r => r.url().endsWith('/api/footprint/consensus/jobs') && r.request().method() === 'POST');
  await panel.getByTestId('run-lattice-consensus').click();
  const submitted = await posted;
  expect(submitted.ok(), await submitted.text()).toBe(true);
  const { job_id: jobId } = await submitted.json();
  const jobUrl = `${server.baseUrl}/api/footprint/consensus/jobs/${jobId}`;
  await expect.poll(async () => {
    const job = await (await page.request.get(jobUrl)).json();
    if (job.status === 'failed') throw new Error(JSON.stringify(job));
    return job.status;
  }, { timeout: 240_000, intervals: [1000] }).toBe('complete');

  const catalog = await (await page.request.get(`${jobUrl}/catalog`)).json();
  expect(catalog.cr_mode).toBe('lattice_recaller');
  const classes = catalog.datasets[DATASET].catalog as Array<{ family: string }>;
  expect(classes.length).toBeGreaterThanOrEqual(2);

  // The class list: one row per class, each with a Save button.
  const classTable = panel.getByTestId('recaller-class-table');
  await expect(classTable).toBeVisible({ timeout: 30_000 });
  await expect(classTable.getByTestId('recaller-row')).toHaveCount(classes.length);
  await expect(panel.getByTestId('automatic-family-mode')).toHaveText('Find again');
  // The results name the region the run analysed (fb-n5-classregion): the view (the coordinates typed above are the view's).
  await expect(panel.getByTestId('class-region-analysed')).toHaveText('Analysed: chr19:47,515,000–47,515,300 · 300 bp · this view');
  await page.screenshot({ path: info.outputPath('classes.png'), fullPage: true });
  if (process.env.FIBERBROWSER_E2E_SHOTS) await panel.screenshot({ path: `${process.env.FIBERBROWSER_E2E_SHOTS}/class_region_results.png` });

  // --- Usability round 1: the settings fold after the run; Inspect opens a class without saving it -------------
  await expect(panel.getByTestId('class-config-summary')).toContainText('Lattice recaller');
  await expect(panel.getByTestId('family-workflow')).toBeHidden();
  await panel.getByTestId('class-config-edit').click();
  await expect(panel.getByTestId('family-workflow')).toBeVisible();
  await expect(panel.getByTestId('recaller-stringency')).toBeVisible();
  await panel.getByTestId('class-config-collapse').click();
  await expect(panel.getByTestId('class-config-summary')).toBeVisible();
  await expect(classTable.getByTestId('recaller-class-name').first()).toHaveText(/^Class \d{3}$/);   // the class's own id
  await classTable.getByTestId('recaller-inspect').first().click();
  await expect(classTable.getByTestId('recaller-inspect-panel')).toBeVisible();
  await expect(classTable.getByTestId('recaller-inspect-channel').first()).toContainText('exact');
  await expect(classTable.getByTestId('recaller-row').first()).toHaveAttribute('data-selected', 'true');
  expect(await store(page, s => s.footprintGroups.filter((g: any) => g.savedClass).length)).toBe(0);   // nothing saved
  await classTable.getByTestId('recaller-inspect').first().click();
  await expect(classTable.getByTestId('recaller-inspect-panel')).toHaveCount(0);

  // --- The exported figure keeps the footprint-class row the view shows (audit H3) ----------
  const classTrack = page.getByTestId(`consensus-family-track-${DATASET}`);
  await expect(classTrack.locator('[data-family-id]').first()).toBeVisible();
  const trackBox = (await classTrack.locator('svg[data-figure-svg]').boundingBox())!;
  const figureBox = (await page.locator('[data-export-container]').boundingBox())!;
  await page.getByTestId('export-screenshot-button').click();
  await page.getByRole('button', { name: '1x', exact: true }).click();
  const figureDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  const figurePath = info.outputPath('figure.png');
  await (await figureDownload).saveAs(figurePath);
  const classPixels = await page.evaluate(async ({ data, track, figure }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    // 1x figure: the tracks sit where they are on screen, under a 40 px title.
    const x = Math.round(track.x - figure.x), y = Math.round(track.y - figure.y + 40);
    const px = ctx.getImageData(x, y, Math.round(track.width), Math.min(40, Math.round(track.height))).data;
    let coloured = 0;
    for (let i = 0; i < px.length; i += 4) if (Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2]) > 40) coloured++;
    return coloured;
  }, { data: readFileSync(figurePath).toString('base64'), track: trackBox, figure: figureBox });
  expect(classPixels, 'class blocks drawn in the exported figure').toBeGreaterThan(50);

  // --- Class × channel table: chips, Export TSV, prevalence plot ----------------------------
  const compareBox = page.getByTestId('compare-datasets');
  await compareBox.locator('summary').click();
  const compare = compareBox.getByTestId('recaller-compare');
  await expect(compare).toBeVisible();
  await expect(compare.getByTestId('recaller-row')).toHaveCount(classes.length);
  const chips = compare.getByTestId('recaller-channel-chip');
  expect(await chips.count()).toBeGreaterThanOrEqual(2); // DddA: CT and GA strands
  const cellsBefore = await compare.getByTestId('recaller-cell').count();
  await chips.first().click();
  await expect(chips.first()).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => compare.getByTestId('recaller-cell').count()).toBeLessThan(cellsBefore);
  await chips.first().click();
  await expect(chips.first()).toHaveAttribute('aria-pressed', 'true');
  await expect(compare.getByTestId('recaller-cell')).toHaveCount(cellsBefore);

  const download = page.waitForEvent('download');
  await compare.getByTestId('recaller-export-tsv').click();
  const tsvPath = info.outputPath('classes.tsv');
  await (await download).saveAs(tsvPath);
  // The table names the region its run analysed first (a '#' line), then the header.
  const [note, header, ...lines] = readFileSync(tsvPath, 'utf8').trim().split('\n');
  expect(note).toBe('# analysed: chr19:47,515,000–47,515,300 · 300 bp · this view');
  const columns = header.split('\t');
  for (const col of ['class', 'class_id', 'channel', 'molecules', 'prevalence_core', 'prevalence_edge', 'prevalence_loose', 'supported', 'flags']) {
    expect(columns, `TSV column ${col}`).toContain(col);
  }
  expect(new Set(lines.map(l => l.split('\t')[columns.indexOf('class_id')]))).toEqual(new Set(classes.map(c => c.family)));
  for (const line of lines) {
    const row = line.split('\t');
    const [core, edge, loose] = ['prevalence_core', 'prevalence_edge', 'prevalence_loose'].map(k => Number(row[columns.indexOf(k)]));
    expect(core).toBeGreaterThanOrEqual(0);
    expect(edge).toBeGreaterThanOrEqual(core - 1e-9); // strict ≤ + one edge ≤ + overlap
    expect(loose).toBeGreaterThanOrEqual(edge - 1e-9);
    expect(loose).toBeLessThanOrEqual(1 + 1e-9);
  }

  await compare.getByTestId('recaller-plot').click();
  await expect(compare.getByTestId('class-prevalence-chart')).toBeVisible();
  await expect(compare.getByTestId('recaller-plot')).toHaveText('Hide plot');

  // --- Save two classes ---------------------------------------------------------------------
  // Saved classes are co-occupancy groups: the panel re-requests co-occupancy on its own each
  // time they change (saving, tier toggles, filters), not when its tab is opened. So collect
  // every two-class co-occupancy response from here on; the tab shows the latest one.
  const coocResponses: Response[] = [];
  page.on('response', r => {
    if (!r.url().includes('/api/footprint/analyze') || r.request().method() !== 'POST') return;
    const body = r.request().postDataJSON();
    if (body?.include_coocc && (body.groups ?? []).filter((g: any) => g.consensusStateId).length === 2) coocResponses.push(r);
  });
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  const rows = classTable.getByTestId('recaller-row');
  await rows.nth(0).getByTestId('recaller-save').click();
  await expect(rows.nth(0).getByTestId('recaller-save')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Saved (1)', exact: true })).toBeVisible();
  await rows.nth(1).getByTestId('recaller-save').click();
  await expect(page.getByRole('button', { name: 'Saved (2)', exact: true })).toBeVisible();
  await expect(classTable).toContainText('2 saved');
  expect(await savedClassIds(page)).toEqual(['S1', 'S2']);
  const saved = await store(page, s => s.footprintGroups.filter((g: any) => g.savedClass).map((g: any) => [g.consensusJobId, g.consensusStateId]));
  expect(new Set(saved.map(([job]) => job))).toEqual(new Set([jobId]));
  const savedFamilies = new Set(saved.map(([, family]) => family));
  expect(savedFamilies.size).toBe(2);
  for (const family of savedFamilies) expect(classes.map(c => c.family)).toContain(family);

  // --- Tier toggles: what a saved class counts reaches the run's display filters --------------
  await page.getByRole('button', { name: 'Saved (2)', exact: true }).click();
  const cards = page.getByTestId('saved-class');
  await expect(cards).toHaveCount(2);
  const s1 = page.locator('[data-testid="saved-class"][data-saved-class-id="S1"]');
  await expect(s1.getByLabel('S1 counts strict')).toBeChecked();
  await expect(s1.getByLabel('S1 counts edge')).not.toBeChecked();
  await s1.getByLabel('S1 counts edge').check();
  await expect(s1.getByLabel('S1 counts edge')).toBeChecked();
  const s1Family = await store(page, s => s.footprintGroups.find((g: any) => g.savedClass?.id === 'S1').consensusStateId);
  await expect.poll(async () => (await (await page.request.get(jobUrl)).json()).filters?.recaller_class_tiers?.[s1Family], { timeout: 20_000 })
    .toBe('core+edge');
  await s1.getByLabel('S1 counts edge').uncheck();
  await expect.poll(async () => (await (await page.request.get(jobUrl)).json()).filters?.recaller_class_tiers?.[s1Family] ?? 'core', { timeout: 20_000 })
    .toBe('core');
  // Filter reads to a saved class (its members in its run, as it counts them).
  const s2 = page.locator('[data-testid="saved-class"][data-saved-class-id="S2"]');
  const members = page.waitForResponse(r => r.url().includes(`/jobs/${jobId}/state-reads`));
  await s2.getByRole('button', { name: 'Filter reads' }).click();
  const memberIds = (await (await members).json()).read_ids as string[];
  expect(memberIds.length).toBeGreaterThan(0);
  await expect.poll(() => store(page, s => s.footprintFilterKey)).toBe('cart:saved:S2');
  expect(await store(page, s => s.filteredReadIds.napa_ddda?.size)).toBe(new Set(memberIds).size);
  await s2.getByRole('button', { name: 'Filtering', exact: true }).click();
  await expect.poll(() => store(page, s => s.footprintFilterKey)).toBeNull();
  await page.getByTestId('saved-classes-plot').click();
  await expect(page.getByTestId('saved-classes-summary').getByTestId('class-prevalence-chart')).toBeVisible();

  // --- Co-occupancy of the two saved classes ------------------------------------------------
  await page.getByRole('button', { name: /^Co-occupancy/ }).click();
  // The heatmap is drawn only from a finished request for the current classes and view.
  await expect(page.getByTestId('cooccupancy-heatmap')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Per-group occupancy')).toBeVisible();
  await expect(page.getByTestId('coocc-group-unavailable')).toHaveCount(0);
  expect(coocResponses.length).toBeGreaterThan(0);
  const coocResponse = coocResponses[coocResponses.length - 1];
  expect(coocResponse.ok()).toBe(true);
  const co = (await coocResponse.json()).co_occupancy[DATASET];
  expect(co.error ?? null).toBeNull();
  expect(co.per_group).toHaveLength(2);
  expect(co.per_group.every((g: any) => !g.unavailable && g.eligible_reads > 0)).toBe(true);
  expect(co.pairs).toHaveLength(1);
  const pair = co.pairs[0];
  expect(pair.n_both + pair.n_i_only + pair.n_j_only + pair.n_neither).toBeGreaterThan(0);
  // What opens and what filters: the lone pair's matrix cell is a disclosure, open from the start,
  // controlling its 2×2 table; the counts are filter toggles.
  await expect(page.getByTestId('coocc-intro')).toBeVisible();
  const pairCell = page.getByTestId('coocc-pair-cell');
  await expect(pairCell).toHaveCount(1);
  await expect(pairCell).toHaveAttribute('aria-expanded', 'true');
  const pairDetail = page.getByTestId('coocc-pair-detail');
  await expect(pairDetail).toBeVisible();
  await expect(pairDetail).toHaveAttribute('id', (await pairCell.getAttribute('aria-controls'))!);
  await page.screenshot({ path: info.outputPath('co-occupancy.png'), fullPage: true });
  await pairCell.click();
  await expect(pairCell).toHaveAttribute('aria-expanded', 'false');
  await expect(pairDetail).toHaveCount(0);
  await pairCell.click();
  await expect(pairDetail).toBeVisible();
  const withCount = page.getByTestId('coocc-group-with').first();
  await expect(withCount).toHaveAttribute('aria-pressed', 'false');
  await withCount.click();
  await expect(withCount).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => store(page, s => s.footprintFilterKey)).toMatch(/:-1:with$/);
  await withCount.click();
  await expect.poll(() => store(page, s => s.footprintFilterKey)).toBeNull();

  // --- Session: save, restore in a fresh page, the saved classes and their run come back -------
  const sessionDownload = page.waitForEvent('download');
  await page.getByTestId('save-session-button').click();
  const sessionPath = info.outputPath('session.json');
  await (await sessionDownload).saveAs(sessionPath);
  const exportedSession = JSON.parse(readFileSync(sessionPath, 'utf8'));
  expect(exportedSession.consensus_runs.runs.map((r: any) => r.job_id)).toContain(jobId);
  expect(new Set(exportedSession.frontend.footprintGroups.filter((g: any) => g.savedClass).map((g: any) => g.savedClass.id)))
    .toEqual(new Set(['S1', 'S2']));

  const fresh = await page.context().newPage();
  fresh.on('pageerror', e => errors.push(e.message));
  await openFresh(fresh, server.baseUrl);
  expect(await savedClassIds(fresh)).toEqual([]);
  await fresh.getByTestId('settings-rail-file').click();
  const fileInput = fresh.getByTestId('restore-session-file-input');
  const imported = fresh.waitForResponse(r => r.url().includes('/api/session/import') && r.request().method() === 'POST');
  await fileInput.setInputFiles(sessionPath);
  const importResult = await (await imported).json();
  expect(importResult.success, JSON.stringify(importResult)).toBe(true);
  expect(importResult.results.consensus_runs_failed ?? []).toEqual([]);
  expect(importResult.results.consensus_runs_restored).toBeGreaterThanOrEqual(1);
  await expect.poll(() => savedClassIds(fresh), { timeout: 20_000 }).toEqual(['S1', 'S2']);
  expect(await store(fresh, s => [...new Set(s.footprintGroups.filter((g: any) => g.savedClass).map((g: any) => g.consensusJobId))]))
    .toEqual([jobId]);
  expect((await (await fresh.request.get(jobUrl)).json()).status).toBe('complete');
  if (!(await fresh.getByTestId('consensus-tools').count())) await panelButton(fresh, 'footprint-analysis').click();
  await fresh.getByRole('button', { name: 'Saved (2)', exact: true }).click();
  await expect(fresh.getByTestId('saved-class')).toHaveCount(2);
  await expect(fresh.getByTestId('saved-class-stale')).toHaveCount(0);
  await fresh.screenshot({ path: info.outputPath('session-restored.png'), fullPage: true });
  await fresh.close();

  // --- Tagged BAM export and reload ---------------------------------------------------------
  await page.getByRole('button', { name: 'Classes', exact: true }).click();
  const advanced = panel.getByTestId('states-advanced');
  if (!(await advanced.evaluate(el => (el as HTMLDetailsElement).open))) await advanced.locator('summary').first().click();
  await panel.getByText('Save options', { exact: true }).first().click();
  await expect(panel.getByLabel('Family BAM contents')).toHaveValue('regions');
  await expect(panel.getByLabel('Family BAM grouping')).toHaveValue('datasets');
  await panel.getByLabel('Class BAM output folder').fill(mkdtempSync(join(tmpdir(), 'browser-class-export-')));
  const bamExport = page.waitForResponse(r => r.url().endsWith('/bam-export') && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Save tagged BAMs', exact: true }).click();
  const receiptResponse = await bamExport;
  expect(receiptResponse.ok(), await receiptResponse.text()).toBe(true);
  const receipt = await receiptResponse.json();
  expect(receipt.outputs).toHaveLength(1);
  expect(receipt.outputs[0].annotations).toBeGreaterThan(0);
  const added = await page.request.post(`${server.baseUrl}/api/datasets/add`, { data: { path: receipt.outputs[0].bam, label: 'Round-trip classes' } });
  expect(added.ok(), await added.text()).toBe(true);
  const reload = await added.json();
  expect(reload.success).toBe(true);
  const compact = await page.request.get(`${server.baseUrl}/api/reads/compact`, {
    params: { ...REGION, dataset_id: reload.dataset.id, spanning: false, include_layers: true },
  });
  expect(compact.ok(), await compact.text()).toBe(true);
  const loaded = await compact.json();
  expect(loaded.reads.length).toBeGreaterThan(0);
  expect(JSON.stringify(loaded)).toContain('fhcr_');
  await info.attach('bam-export', { body: JSON.stringify(receipt), contentType: 'application/json' });

  expect(errors).toEqual([]);
});

// 2026-09-30 UI audit H6: Undo of "Close dataset" brought the reads back without the class track.
test('closing a dataset with footprint classes: Undo brings back the class track and the saved class', async ({ page, server }) => {
  test.setTimeout(300_000);
  await page.route('**/api/footprint/consensus/jobs', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = route.request().postDataJSON();
    body.parameters = { ...(body.parameters ?? {}), compute: { ...(body.parameters?.compute ?? {}), cores: CORES } };
    await route.continue({ postData: JSON.stringify(body) });
  });
  await openFresh(page, server.baseUrl);
  await panelButton(page, 'footprint-analysis').click();
  const panel = page.getByTestId('consensus-tools');
  const posted = page.waitForResponse(r => r.url().endsWith('/api/footprint/consensus/jobs') && r.request().method() === 'POST');
  await panel.getByTestId('run-lattice-consensus').click();
  const { job_id: jobId } = await (await posted).json();
  await expect.poll(async () => (await (await page.request.get(`${server.baseUrl}/api/footprint/consensus/jobs/${jobId}`)).json()).status,
    { timeout: 240_000, intervals: [1000] }).toBe('complete');
  const rows = panel.getByTestId('recaller-class-table').getByTestId('recaller-row');
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  await rows.nth(0).getByTestId('recaller-save').click();
  await expect(page.getByRole('button', { name: 'Saved (1)', exact: true })).toBeVisible();
  const track = page.getByTestId(`consensus-family-track-${DATASET}`);
  await expect(track).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500); // the save's history step settles

  await clickPanelAction(page, 'panel-close');
  await expect.poll(() => store(page, s => s.datasets.length)).toBe(0);
  await expect(page.getByTestId('quick-undo-button')).toHaveAttribute('title', `Undo: Close ${DATASET} (Cmd/Ctrl+Z)`);

  await page.getByTestId('quick-undo-button').click();
  await expect.poll(() => store(page, s => s.datasets.map((d: any) => d.id)), { timeout: 30_000 }).toEqual([DATASET]);
  await expect.poll(() => store(page, s => s.datasets[0]?.derived_layers?.tf_rc?.consensus_job_id ?? null), { timeout: 30_000 }).toBe(jobId);
  await expect(track).toBeVisible({ timeout: 30_000 });
  expect(await savedClassIds(page)).toEqual(['S1']);
  await expect(page.getByRole('button', { name: 'Saved (1)', exact: true })).toBeVisible();
  await expect(page.getByTestId('nav-status')).toHaveCount(0, { timeout: 30_000 });
});

test('find classes with the read-order check: robust classes marked, option kept in the saved session', async ({ page, server }, info) => {
  test.setTimeout(420_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  let request: any = null;
  await page.route('**/api/footprint/consensus/jobs', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = route.request().postDataJSON();
    body.parameters = { ...(body.parameters ?? {}), compute: { ...(body.parameters?.compute ?? {}), cores: CORES } };
    request = body;
    await route.continue({ postData: JSON.stringify(body) });
  });
  await openFresh(page, server.baseUrl);
  await panelButton(page, 'footprint-analysis').click();
  const panel = page.getByTestId('consensus-tools');
  const option = panel.getByTestId('recaller-robust');
  await expect(option).not.toBeChecked();                                    // off by default: default runs unchanged
  await expect(panel.getByText('Check robustness to read order', { exact: false })).toContainText('slower, ~3×');
  await option.check();

  const posted = page.waitForResponse(r => r.url().endsWith('/api/footprint/consensus/jobs') && r.request().method() === 'POST');
  await panel.getByTestId('run-lattice-consensus').click();
  const { job_id: jobId } = await (await posted).json();
  expect(request.parameters.recaller.order_replicates).toBe(2);
  const jobUrl = `${server.baseUrl}/api/footprint/consensus/jobs/${jobId}`;
  await expect.poll(async () => {
    const job = await (await page.request.get(jobUrl)).json();
    if (job.status === 'failed' || job.status === 'error') throw new Error(JSON.stringify(job));
    return job.status;
  }, { timeout: 360_000, intervals: [1000] }).toBe('complete');

  const catalog = await (await page.request.get(`${jobUrl}/catalog`)).json();
  expect(catalog.robustness).toMatchObject({ orderings: 3, replicates: 2, robust_fraction: 1 });
  const families = catalog.datasets[DATASET].catalog as Array<{ family: string; robust: boolean; order_robustness: number }>;
  expect(families.length).toBeGreaterThanOrEqual(2);
  expect(families.every(f => typeof f.robust === 'boolean' && f.order_robustness > 0 && f.order_robustness <= 1)).toBe(true);
  const robust = families.filter(f => f.robust).length;
  expect(robust).toBeGreaterThanOrEqual(1);

  const classTable = panel.getByTestId('recaller-class-table');
  await expect(classTable.getByTestId('recaller-row')).toHaveCount(families.length, { timeout: 30_000 });
  await expect(classTable.getByTestId('recaller-robust-summary'))
    .toHaveText(`${robust} of ${families.length} classes are robust to read order`);
  await expect(classTable.getByTestId('recaller-robust-badge')).toHaveCount(robust);
  await expect(classTable.getByTestId('recaller-not-robust')).toHaveCount(families.length - robust);
  await page.screenshot({ path: info.outputPath('robust-classes.png'), fullPage: true });

  // The session carries the run with its setting: a fresh page that restores it has the option ticked.
  const sessionDownload = page.waitForEvent('download');
  await page.getByTestId('save-session-button').click();
  const sessionPath = info.outputPath('session.json');
  await (await sessionDownload).saveAs(sessionPath);
  // The saved run itself carries the setting and the verdicts (this server still holds the job, so the import below
  // reuses it; tests/test_consensus_robustness.py restores the saved payload into an empty server).
  const saved = JSON.parse(readFileSync(sessionPath, 'utf8')).consensus_runs.runs.find((r: any) => r.job_id === jobId);
  const savedRun = JSON.parse(gunzipSync(Buffer.from(saved.payload_gz_b64, 'base64')).toString('utf8'));
  expect(savedRun.result.manifest.parameters.recaller.order_replicates).toBe(2);
  expect(savedRun.result.manifest.recaller.order_robustness.orderings).toBe(3);
  expect((savedRun.result.datasets[DATASET].cr.catalog as any[]).filter(f => f.robust).length).toBe(robust);
  const fresh = await page.context().newPage();
  fresh.on('pageerror', e => errors.push(e.message));
  await openFresh(fresh, server.baseUrl);
  await fresh.getByTestId('settings-rail-file').click();
  const fileInput = fresh.getByTestId('restore-session-file-input');
  const imported = fresh.waitForResponse(r => r.url().includes('/api/session/import') && r.request().method() === 'POST');
  await fileInput.setInputFiles(sessionPath);
  expect((await (await imported).json()).success).toBe(true);
  // Open the Footprints panel once the restore has settled (it may reopen the panel itself).
  await expect(fresh.getByText('Session restored.', { exact: true })).toBeVisible({ timeout: 30_000 });
  const tools = fresh.getByTestId('consensus-tools');
  await expect.poll(async () => {
    if (!(await tools.count())) await panelButton(fresh, 'footprint-analysis').click();
    return tools.count();
  }, { timeout: 30_000, intervals: [1500] }).toBeGreaterThan(0);
  await expect(tools.getByTestId('recaller-robust')).toBeChecked({ timeout: 30_000 });
  await expect(fresh.getByTestId('recaller-robust-summary')).toHaveText(`${robust} of ${families.length} classes are robust to read order`);
  await fresh.close();
  expect(errors).toEqual([]);
});
