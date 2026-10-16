/**
 * Datasets on different assemblies side by side (fb-r2-genomes): the hg38 demo
 * and a dm6 BAM. The dm6 dataset is opened with dm6 in its own panel from the
 * genome-mismatch banner (hg38 stays the main genome); each panel navigates
 * on its own reference, with its own genes and sequence; "Each panel
 * navigates" gives the hg38 panel its own locus box too and turns the main
 * one off; a saved session brings the panels, their references and loci back.
 *
 * Needs a dm6 DddB amplicon BAM (FIBERBROWSER_TEST_DM6_BAM)
 * and dm6 in ~/.fiberhmm/genomes (it is never downloaded here).
 */
import { test, expect } from './fixtures/server';
import type { Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

test.use({ fixtureBam: 'demo' });

const DM6_BAM = process.env.FIBERBROWSER_TEST_DM6_BAM?.trim() || '';
const DM6_CACHED = existsSync(path.join(homedir(), '.fiberhmm', 'genomes', 'dm6.fa.fai'));
const HG38_CACHED = existsSync(path.join(homedir(), '.fiberhmm', 'genomes', 'hg38.fa.fai'));
const SHOTS = process.env.FB_R2_GENOMES_SHOTS?.trim();
const MAIN = { chrom: 'chr19', start: 47_515_000, end: 47_515_400 };

const store = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => new Function('s', `return (${f})(s)`)((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;

async function open(page: Page, baseUrl: string, size = { width: 1728, height: 1080 }) {
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    if (!window.sessionStorage.getItem('fb-e2e-kept')) {
      window.localStorage.clear();
      window.sessionStorage.clear();
    }
  });
  await page.setViewportSize(size);
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');
}

async function goMain(page: Page, locus: { chrom: string; start: number; end: number }) {
  const input = page.getByTestId('location-search-input');
  await input.fill(`${locus.chrom}:${locus.start}-${locus.end}`);
  await page.getByTestId('location-search-submit').click();
  await expect.poll(() => store(page, s => [s.chrom, s.start])).toEqual([locus.chrom, locus.start]);
}

const panelOf = (page: Page, datasetId: string) =>
  store(page, s => s.panels.filter((p: any) => p.contentType === 'dataset' && !p.collapsed)
    .map((p: any) => ({ id: p.id, datasetId: p.datasetId, genome: p.genome ?? null, v: p.viewportOverride ?? null, navOwn: !!p.navOwn })))
    .then(list => list.find(p => p.datasetId === datasetId)!);

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, name) });
}

test('a dm6 dataset beside the hg38 demo: its own genome, panel, navigation and session', async ({ page, server }, info) => {
  test.skip(!DM6_BAM || !existsSync(DM6_BAM), 'needs a dm6 BAM (FIBERBROWSER_TEST_DM6_BAM)');
  test.skip(!DM6_CACHED, 'needs dm6 in ~/.fiberhmm/genomes (not downloaded by tests)');
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));

  // The demo's genome as the main one (FIBERBROWSER_TEST_FASTA may have loaded it already).
  const status = await (await page.request.get(`${server.baseUrl}/api/status`)).json();
  if (status.current_genome !== 'hg38') {
    test.skip(!HG38_CACHED, 'needs hg38 in ~/.fiberhmm/genomes (not downloaded by tests)');
    expect((await (await page.request.post(`${server.baseUrl}/api/load_genome?genome_id=hg38`)).json()).success).toBe(true);
  }
  const added = await page.request.post(`${server.baseUrl}/api/datasets/add`, { data: { path: DM6_BAM } });
  const fly = (await added.json()).dataset.id as string;
  await open(page, server.baseUrl);
  await goMain(page, MAIN);
  const human = (await store(page, s => s.datasets.map((d: any) => d.id))).find((id: string) => id !== fly) as string;

  // --- The mismatch: open the dm6 dataset with dm6 in its own panel ------------------
  const banner = page.getByTestId('genome-mismatch-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('dm6');
  await expect(page.getByTestId('genome-mismatch-own-genome')).toHaveText(/Open with dm6 in its own panel/);
  await expect(page.getByTestId('genome-mismatch-load-genome')).toHaveText(/Switch to dm6/);
  await shot(page, 'mismatch-banner-1728.png');
  const flyGenes = page.waitForResponse(r => r.url().includes('/api/genes?') && r.url().includes('panel_genome=dm6'), { timeout: 60_000 });
  await page.getByTestId('genome-mismatch-own-genome').click();
  await expect(banner).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId('panel-genome-chip')).toHaveText('dm6');
  const referenceChip = page.getByTestId('panel-genome-chip');
  await expect(referenceChip).toHaveAttribute('title', 'Reference: dm6 — click to manage');
  await referenceChip.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Reference manager' })).toBeVisible();
  await expect(page.getByTestId('reference-manager-details')).toContainText('dm6');
  await expect(page.getByTestId('reference-manager-datasets')).toContainText('Aligned to:');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('reference-manager')).toHaveCount(0);
  await expect(referenceChip).toBeFocused();

  let flyPanel = await panelOf(page, fly);
  expect(flyPanel.genome).toBe('dm6');
  expect(flyPanel.v?.chrom).toBe('chr2L');
  // fb-r3-nav: opened in its own panel beside another one, each panel navigates now (said briefly).
  await expect(page.getByTestId('navigation-mode-notice')).toContainText('Switched to Per panel');
  expect(await store(page, s => s.navigationMode)).toBe('perPanel');
  await shot(page, 'own-genome-per-panel-1728.png');
  await page.getByTestId('nav-mode-linked').click();
  await expect(page.getByTestId('navigation-mode-notice')).toHaveCount(0);
  expect((await panelOf(page, fly)).v).toEqual(flyPanel.v);
  expect((await (await flyGenes).json()).genes.length).toBeGreaterThan(0);
  // hg38 is still the main genome, at the same place.
  expect(await store(page, s => [s.currentGenome, s.chrom, s.start, s.end])).toEqual(['hg38', MAIN.chrom, MAIN.start, MAIN.end]);
  expect((await panelOf(page, human)).v).toBeNull();
  await shot(page, 'own-genome-1728.png');

  // --- Each panel on its own reference: sequence and genes ---------------------------
  const flyBar = page.getByTestId('panel-site-bar').filter({ has: page.getByTestId('panel-genome-chip') });
  // The new locus's request (a late one for where it opened can still arrive under load).
  const flySeq = page.waitForResponse(r => r.url().includes('/api/sequence?') && r.url().includes('panel_genome=dm6') && r.url().includes('chrom=chr3R'));
  // Somewhere it hasn't been (the bases around where it opened are cached).
  await flyBar.getByTestId('panel-location-input').fill('chr3R:1000000-1000200');
  await flyBar.getByTestId('panel-location-submit').click();
  const flySeqBody = await (await flySeq).json();
  expect(flySeqBody.chrom).toBe('chr3R');
  expect(flySeqBody.sequence).toMatch(/^[ACGTN]+$/);
  const direct = await (await page.request.get(`${server.baseUrl}/api/sequence?chrom=chr3R&start=${flySeqBody.start}&end=${flySeqBody.end}&panel_genome=dm6`)).json();
  expect(direct.sequence).toBe(flySeqBody.sequence);
  const humanSeq = page.waitForResponse(r => r.url().includes('/api/sequence?') && r.url().includes('chrom=chr19') && !r.url().includes('panel_genome'));
  // Somewhere new (the bases around the first view are cached).
  await goMain(page, { chrom: 'chr19', start: 47_600_000, end: 47_600_200 });
  expect((await (await humanSeq).json()).sequence).toMatch(/^[ACGTN]+$/);
  // The main view moved; the dm6 panel did not.
  flyPanel = await panelOf(page, fly);
  expect(flyPanel.v).toEqual({ chrom: 'chr3R', start: 1_000_000, end: 1_000_200 });
  // dm6's chromosome list in its panel; a gene search there finds a fly gene.
  const flyChroms = await flyBar.getByTestId('panel-chrom-select').locator('option').allTextContents();
  expect(flyChroms).toContain('chr3R');
  expect(flyChroms).not.toContain('chr19');
  await flyBar.getByTestId('panel-location-input').fill('eve');
  await flyBar.getByTestId('panel-location-submit').click();
  await expect.poll(async () => (await panelOf(page, fly)).v?.chrom).toBe('chr2R');
  expect(await store(page, s => s.chrom)).toBe('chr19');
  // No Link button across assemblies.
  await expect(flyBar.getByTestId('panel-site-lock')).toHaveCount(0);

  // --- Each panel navigates -----------------------------------------------------------
  await page.getByTestId('nav-mode-perPanel').click();
  await expect(page.getByTestId('location-search-input')).toBeDisabled();
  await expect(page.getByTestId('panel-site-bar')).toHaveCount(2);
  const humanBar = page.getByTestId('panel-site-bar').filter({ hasNot: page.getByTestId('panel-genome-chip') });
  await humanBar.getByTestId('panel-location-input').fill('chr19:47515500-47515900');
  await humanBar.getByTestId('panel-location-submit').click();
  await expect.poll(async () => (await panelOf(page, human)).v).toEqual({ chrom: 'chr19', start: 47_515_500, end: 47_515_900 });
  expect((await panelOf(page, fly)).v?.chrom).toBe('chr2R');
  await shot(page, 'per-panel-1728.png');
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot(page, 'per-panel-1280.png');
  await page.setViewportSize({ width: 1728, height: 1080 });

  // Back to linked: the main view goes where the hg38 panel was; the dm6 panel stays.
  await page.getByTestId('nav-mode-linked').click();
  await expect(page.getByTestId('location-search-input')).toBeEnabled();
  expect(await store(page, s => [s.chrom, s.start, s.end])).toEqual(['chr19', 47_515_500, 47_515_900]);
  expect((await panelOf(page, human)).v).toBeNull();
  expect((await panelOf(page, fly)).v?.chrom).toBe('chr2R');
  await page.getByTestId('nav-mode-perPanel').click();
  const flyBefore = (await panelOf(page, fly)).v;
  const humanBefore = (await panelOf(page, human)).v;

  // --- Session: save, restore in a fresh page --------------------------------------------
  const download = page.waitForEvent('download');
  await page.getByTestId('save-session-button').click();
  const sessionPath = info.outputPath('session.json');
  await (await download).saveAs(sessionPath);
  const saved = JSON.parse(readFileSync(sessionPath, 'utf8'));
  expect(saved.panel_genomes.datasets[fly]).toBe('dm6');
  expect(saved.panel_genomes.contexts.dm6).toEqual({ genome_id: 'dm6' });
  expect(saved.frontend.navigationMode).toBe('perPanel');

  // Forget the dm6 reference, then restore.
  await page.request.post(`${server.baseUrl}/api/panel_genomes/detach`, { data: { dataset_ids: [fly] } });
  expect((await (await page.request.get(`${server.baseUrl}/api/panel_genomes`)).json()).genomes).toEqual([]);
  const fresh = await page.context().newPage();
  fresh.on('pageerror', e => errors.push(e.message));
  await open(fresh, server.baseUrl);
  await fresh.getByTestId('settings-rail-file').click();
  const fileInput = fresh.getByTestId('restore-session-file-input');
  const imported = fresh.waitForResponse(r => r.url().includes('/api/session/import') && r.request().method() === 'POST');
  await fileInput.setInputFiles(sessionPath);
  const importResult = await (await imported).json();
  expect(importResult.success, JSON.stringify(importResult)).toBe(true);
  expect(importResult.results.panel_genomes_restored).toBe(1);
  await expect.poll(() => store(fresh, s => s.navigationMode), { timeout: 20_000 }).toBe('perPanel');
  await expect.poll(async () => (await panelOf(fresh, fly))?.genome, { timeout: 20_000 }).toBe('dm6');
  expect((await panelOf(fresh, fly)).v).toEqual(flyBefore);
  expect((await panelOf(fresh, human)).v).toEqual(humanBefore);
  await expect(fresh.getByTestId('panel-genome-chip')).toHaveText('dm6');
  await expect(fresh.getByTestId('location-search-input')).toBeDisabled();
  await fresh.close();

  expect(errors).toEqual([]);
});

// fb-r3-nav: two dm6 datasets beside the hg38 demo are opened with dm6 together and form one
// linked group; Per panel -> Linked takes them to the one moved last; "Match other panels"
// moves the others without linking them.
const DM6_BAM_2 = process.env.FIBERBROWSER_TEST_DM6_BAM_2?.trim() || '';
const NAV_SHOTS = process.env.FB_R3_NAV_SHOTS?.trim();

async function navShot(page: Page, name: string) {
  if (!NAV_SHOTS) return;
  mkdirSync(NAV_SHOTS, { recursive: true });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(NAV_SHOTS, name) });
}

test('two dm6 datasets opened with dm6 together move as one; per panel and back; match to a panel', async ({ page, server }) => {
  test.skip(!DM6_BAM || !existsSync(DM6_BAM) || !DM6_BAM_2 || !existsSync(DM6_BAM_2), 'needs two dm6 BAMs (FIBERBROWSER_TEST_DM6_BAM, FIBERBROWSER_TEST_DM6_BAM_2)');
  test.skip(!DM6_CACHED, 'needs dm6 in ~/.fiberhmm/genomes (not downloaded by tests)');
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const status = await (await page.request.get(`${server.baseUrl}/api/status`)).json();
  if (status.current_genome !== 'hg38') {
    test.skip(!HG38_CACHED, 'needs hg38 in ~/.fiberhmm/genomes (not downloaded by tests)');
    expect((await (await page.request.post(`${server.baseUrl}/api/load_genome?genome_id=hg38`)).json()).success).toBe(true);
  }
  const fly1 = (await (await page.request.post(`${server.baseUrl}/api/datasets/add`, { data: { path: DM6_BAM } })).json()).dataset.id as string;
  const fly2 = (await (await page.request.post(`${server.baseUrl}/api/datasets/add`, { data: { path: DM6_BAM_2 } })).json()).dataset.id as string;
  await open(page, server.baseUrl);
  await goMain(page, MAIN);
  const human = (await store(page, s => s.datasets.map((d: any) => d.id))).find((id: string) => id !== fly1 && id !== fly2) as string;

  // One action for both, beside opening one at a time.
  const own = page.getByTestId('genome-mismatch-own-genome');
  await expect(own).toHaveText('Open all 2 dm6 datasets with dm6');
  await expect(page.getByTestId('genome-mismatch-own-genome-one')).toBeVisible();
  await navShot(page, 'banner-two-dm6-1728.png');
  await own.click();
  await expect(page.getByTestId('genome-mismatch-banner')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId('panel-genome-chip')).toHaveCount(2);
  // Still Linked: one dm6 locus for both, the hg38 panel on the main view.
  expect(await store(page, s => s.navigationMode)).toBe('linked');
  const a = await panelOf(page, fly1);
  const b = await panelOf(page, fly2);
  expect(a.genome).toBe('dm6');
  expect(b.v).toEqual(a.v);
  expect((await panelOf(page, human)).v).toBeNull();
  await expect(page.getByTestId('panel-genome-linked')).toHaveCount(2);
  await navShot(page, 'linked-dm6-group-1728.png');

  // The locus box of the second moves both; the main view stays.
  const bars = page.getByTestId('panel-site-bar').filter({ has: page.getByTestId('panel-genome-chip') });
  await bars.nth(1).getByTestId('panel-location-input').fill('chr3R:1000000-1004000');
  await bars.nth(1).getByTestId('panel-location-submit').click();
  await expect.poll(async () => (await panelOf(page, fly1)).v).toEqual({ chrom: 'chr3R', start: 1_000_000, end: 1_004_000 });
  expect((await panelOf(page, fly2)).v).toEqual({ chrom: 'chr3R', start: 1_000_000, end: 1_004_000 });
  expect(await store(page, s => [s.chrom, s.start, s.end])).toEqual([MAIN.chrom, MAIN.start, MAIN.end]);
  // A pan button of the first moves both.
  await bars.nth(0).getByTitle('Pan right').click();
  await expect.poll(async () => (await panelOf(page, fly2)).v?.start).toBeGreaterThan(1_000_000);
  expect((await panelOf(page, fly2)).v).toEqual((await panelOf(page, fly1)).v);

  // Per panel: each on its own. Move the second, then the first (last).
  await page.getByTestId('nav-mode-perPanel').click();
  await bars.nth(1).getByTestId('panel-location-input').fill('chr2L:500000-504000');
  await bars.nth(1).getByTestId('panel-location-submit').click();
  await expect.poll(async () => (await panelOf(page, fly2)).v?.chrom).toBe('chr2L');
  await bars.nth(0).getByTestId('panel-location-input').fill('chrX:2000000-2004000');
  await bars.nth(0).getByTestId('panel-location-submit').click();
  await expect.poll(async () => (await panelOf(page, fly1)).v?.chrom).toBe('chrX');
  expect((await panelOf(page, fly2)).v?.chrom).toBe('chr2L');
  await navShot(page, 'per-panel-two-dm6-1728.png');
  // Match: the other dm6 panel goes where this one is, still per panel.
  await bars.nth(1).getByTestId('panel-match-others').focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await panelOf(page, fly1)).v).toEqual({ chrom: 'chr2L', start: 500_000, end: 504_000 });
  expect(await store(page, s => s.navigationMode)).toBe('perPanel');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await panelOf(page, fly1)).v?.chrom).toBe('chrX');
  // A pan of the first makes it the one moved last.
  await bars.nth(0).getByTitle('Pan right').click();
  await expect.poll(async () => (await panelOf(page, fly1)).v?.start).toBeGreaterThan(2_000_000);
  const last = (await panelOf(page, fly1)).v;
  expect((await panelOf(page, fly2)).v?.chrom).toBe('chr2L');
  // Back to Linked: the dm6 panels go where the one moved last is (the first, on chrX), not the primary dataset's.
  await page.getByTestId('nav-mode-linked').click();
  expect((await panelOf(page, fly1)).v).toEqual(last);
  expect((await panelOf(page, fly2)).v).toEqual(last);
  expect(await store(page, s => [s.chrom, s.start, s.end])).toEqual([MAIN.chrom, MAIN.start, MAIN.end]);
  await navShot(page, 'linked-again-1728.png');
  expect(errors).toEqual([]);
});
