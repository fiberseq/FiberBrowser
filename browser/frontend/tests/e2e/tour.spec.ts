/**
 * The guided tour, walked end to end in its sandbox tab on the bundled demo.
 *
 * A step whose control has moved or been renamed is skipped silently in a
 * normal tab and explained without its spotlight in a sandbox tab, so a stale
 * step only shows up by walking the tour. This spec clicks Next through every
 * step (the tour itself scans, clusters, saves a footprint, finds the footprint
 * classes and saves one; then, on the structural-variant demo, finds SNPs, splits
 * the reads by haplotype and opens the insertion's carriers with the insert
 * expanded) and checks that each step points at its control.
 *
 * scripts/capture-tutorial-screenshots.mjs walks the tour the same way to make
 * the screenshots in docs/images/guide.
 *
 * It also checks that the reads settle after Find footprint classes (every read
 * request and analysis re-projected the run onto all reads, several times, so
 * the reads badge stayed at "Loading..." for many steps), that the tour tab
 * splits into two strand panels that load, and that no request is refused
 * (the Add track box asked a sandbox for the host's recent tracks: 403).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { test, expect, pickRandomPort, startServer, stopServer, type ServerProcess, TEST_PANEL_LAUNCHER } from './fixtures/server';
import { TOUR_CHECKED, TOUR_PANEL_STEPS, TOUR_SANDBOX_HIDDEN, TOUR_WALKED_TITLES } from './fixtures/tourTitles';

test.use({ fixtureBam: 'demo' });

/** Steps about a whole panel: the panel's header flashes, no control is ringed. */
const PANEL_STEPS = new Set(TOUR_PANEL_STEPS);
/** Host-only controls a sandbox tab hides: explained with a note instead of a spotlight. */
const SANDBOX_HIDDEN = new Set(TOUR_SANDBOX_HIDDEN);
/**
 * How long the reads may take to settle once the classes are found, and the two
 * strand panels to load after a split. Before the one-projection fix the reads
 * took ~15 s after Find classes on this demo (and the split panels up to
 * minutes in the screenshot runs); after it, ~2-6 s on a busy machine.
 */
/**
 * Where the analysis panel buttons are for this run: the sidebar rail (default), or the
 * classic strip with FIBERBROWSER_TEST_PANEL_LAUNCHER=strip (the tour tab gets ?panels=,
 * as openTourTab passes it).
 */
const PANEL_LAUNCHER = TEST_PANEL_LAUNCHER;
const READS_SETTLE_MS = 12_000;
const SPLIT_LOAD_MS = 20_000;

type ReadTrackState = { loading: string | null; rendered: number };
/**
 * The main tab, open on the demo BAM the server started with: its reads track is
 * there and the Welcome card is not (a browser with a dataset open has no Welcome
 * card; before fb-n2-sessions it flashed for ~0.1 s until the dataset list came
 * back, and these specs waited on that flash).
 */
async function mainTabOpen(page: import('@playwright/test').Page) {
  await expect(page.locator('[data-read-track-state-key]').first()).toBeAttached({ timeout: 30_000 });
  await expect(page.getByTestId('welcome-card')).toHaveCount(0);
}

async function readTracks(page: import('@playwright/test').Page): Promise<ReadTrackState[]> {
  return page.locator('[data-read-track-state-key]').evaluateAll(els => els.map(el => ({
    loading: el.getAttribute('data-read-track-loading'),
    rendered: Number(el.getAttribute('data-read-track-render-count') ?? 0),
  })));
}

test('the guided tour walks every step in its sandbox tab', async ({ page, context, server }) => {
  test.setTimeout(15 * 60_000);
  await context.addInitScript(() => {
    window.__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    window.__FIBERBROWSER_E2E_EXPOSE_STORE = true;
  });
  // The main tab stays open, as it does for a user (a local server stops once its last tab closes).
  await page.goto(server.baseUrl);
  await mainTabOpen(page);
  const sandbox = await page.evaluate(async () => (await (await fetch('/api/sandbox', { method: 'POST' })).json()).id as string);
  expect(sandbox).toMatch(/^sb-/);

  const tour = await context.newPage();
  const pageErrors: string[] = [];
  tour.on('pageerror', error => pageErrors.push(error.message));
  const leftOut: string[] = [];
  tour.on('console', message => { if (message.text().startsWith('Tour: left out')) leftOut.push(message.text()); });
  const refused: string[] = [];
  tour.on('response', response => {
    if (response.status() >= 400) refused.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
  });
  await tour.goto(`${server.baseUrl}/?sandbox=${sandbox}&tour=1&panels=${PANEL_LAUNCHER}`);

  const steps: Array<{ title: string; progress: string; ringed: boolean; note: boolean }> = [];
  let progress = '';
  for (;;) {
    const popover = tour.locator('.copilot-tutorial-popover:not(.copilot-tutorial-waiting)');
    // Wait for the next step's popover (a step may first cluster or find classes).
    await expect.poll(async () => {
      if (await tour.locator('.copilot-tutorial-working').count()) return progress;
      return (await popover.locator('.copilot-tutorial-progress').textContent().catch(() => null)) ?? progress;
    }, { timeout: 7 * 60_000, intervals: [250] }).not.toBe(progress);
    progress = (await popover.locator('.copilot-tutorial-progress').textContent()) ?? '';
    const title = ((await popover.locator('.copilot-tutorial-popover-title').textContent()) ?? '').trim();
    const body = (await popover.locator('.copilot-tutorial-popover-body').textContent()) ?? '';
    steps.push({
      title,
      progress,
      ringed: (await tour.locator('.copilot-highlight').count()) > 0,
      note: body.includes('This tour tab is a sandbox'),
    });
    if (title === TOUR_CHECKED.welcome) {
      // A tour tab doesn't show the empty browser's welcome card.
      await expect(tour.getByTestId('welcome-tour-cta')).toHaveCount(0);
    }
    if (title === TOUR_CHECKED.classTable) {
      // The classes are drawn on the reads, and the reads' count badge settles.
      await expect.poll(async () => {
        const tracks = await readTracks(tour);
        return tracks.length > 0 && tracks.every(t => t.loading === 'false' && t.rendered > 0);
      }, { timeout: READS_SETTLE_MS, intervals: [250], message: 'reads still loading after Find footprint classes' }).toBe(true);
    }
    if (title === TOUR_CHECKED.regions) {
      // The Highlight step's Next highlighted the selected peaks: shaded in the panel.
      expect(await tour.evaluate(() => window.__FIBERBROWSER_STORE__?.getState().highlights.length ?? 0)).toBeGreaterThan(0);
    }
    if (title === TOUR_CHECKED.haplotypes) {
      // The Regions step's Next saved the view (kept in the tour tab's session).
      await tour.locator('[data-panel-content-type="circular-genome"] [data-analysis-tab="catalog"]').click();
      await expect(tour.getByTestId('region-entry').first()).toBeVisible();
      await tour.locator('[data-panel-content-type="circular-genome"] [data-analysis-tab="haplotype"]').click();
    }
    if (title === TOUR_CHECKED.analysisPanels) {
      // It rings the panel buttons where they are: the strip, or the rail's launchers.
      const target = PANEL_LAUNCHER === 'rail' ? 'panel-rail-launchers' : 'analysis-strip-chips';
      await expect(tour.locator(`[data-testid="${target}"].copilot-highlight`)).toHaveCount(1);
      await expect(tour.getByTestId('analysis-strip')).toHaveCount(PANEL_LAUNCHER === 'rail' ? 0 : 1);
    }
    if (title === TOUR_CHECKED.splitByHaplotype) {
      // The Variants section split the SV demo's reads by their HP tags: one split set of at least two panels.
      const split = await tour.evaluate(() => (window.__FIBERBROWSER_STORE__?.getState().panels ?? [])
        .filter(p => p.readSubset).map(p => p.readSubset!.groupId));
      expect(split.length).toBeGreaterThanOrEqual(2);
      expect(new Set(split).size).toBe(1);
      await expect(tour.getByTestId('split-panel-close-all').first()).toBeVisible();
    }
    if (title === TOUR_CHECKED.svsTab) {
      // The split closed again; the SVs tab lists the demo's insertion.
      expect(await tour.evaluate(() => (window.__FIBERBROWSER_STORE__?.getState().panels ?? []).filter(p => p.readSubset).length)).toBe(0);
      await expect(tour.locator('[data-testid="variants-sv"][data-sv="I:23277272:7471"]')).toBeVisible();
    }
    if (title === TOUR_CHECKED.insertCtcf) {
      // The carriers on the insertion's alternate allele, at the insert's nucleosome-free region, drawn.
      const alt = await tour.evaluate(() => {
        const st = window.__FIBERBROWSER_STORE__?.getState();
        const panel = st?.panels.find(p => p.altAllele);
        return panel ? {
          reads: st!.activeReadIds[panel.stateKey ?? panel.id]?.length ?? 0, view: panel.viewportOverride, insertStart: panel.altAllele!.layout.insert_start,
          sorted: st!.readSortOrder[panel.stateKey ?? panel.id]?.length ?? 0,
          svShown: panel.subTracks.some(t => t.type === 'sv' && t.visible),
        } : null;
      });
      expect(alt).not.toBeNull();
      expect(alt!.reads).toBeGreaterThan(20);
      expect(alt!.view!.start - alt!.insertStart).toBe(3_300);
      expect(alt!.view!.end - alt!.insertStart).toBe(4_300);
      // Sorted by accessibility over the NFR, its SV row hidden.
      expect(alt!.sorted).toBeGreaterThan(20);
      expect(alt!.svShown).toBe(false);
    }
    if (title === TOUR_CHECKED.tutorialPanel) {
      // Its step list has the texts this tour shows (on the demo).
      await expect(tour.locator('[data-testid="tutorial-step"][data-step-id="welcome"]'))
        .toHaveAttribute('title', /loads a small demo dataset/);
    }
    if (await popover.locator('.copilot-tutorial-extra').count()) {
      await popover.locator('.copilot-tutorial-next').click();  // Keep exploring
      break;
    }
    await popover.locator('.copilot-tutorial-next').click();
  }

  const total = Number(progress.split(' of ')[1]);
  // No step was left out (a class step is left out only when finding classes failed).
  expect(leftOut, 'steps the tour left out').toEqual([]);
  expect(steps.map(s => s.progress)).toEqual(Array.from({ length: total }, (_, i) => `${i + 1} of ${total}`));
  const titles = steps.map(s => s.title);
  // Named, so a failure says which steps (Playwright prints only the head of an
  // arrayContaining list, which read as the class steps being skipped when the
  // missing one was the renamed Projection step).
  expect(TOUR_WALKED_TITLES.filter(t => !titles.includes(t)), 'tour steps not walked').toEqual([]);
  // Every step rings its control, except the whole-panel steps and the host-only controls.
  expect(steps.filter(s => !s.ringed && !PANEL_STEPS.has(s.title) && !SANDBOX_HIDDEN.has(s.title)).map(s => s.title)).toEqual([]);
  expect(steps.filter(s => s.note).map(s => s.title).sort()).toEqual([...SANDBOX_HIDDEN].sort());

  // Back to the NAPA demo (the Variants section left the SV demo in view), then split
  // its panel into its two DAF-seq strands: both panels load.
  await tour.evaluate(() => {
    const st = window.__FIBERBROWSER_STORE__!.getState();
    const napa = st.datasets.find(d => /^NAPA demo/.test(d.label ?? ''));
    for (const p of [...st.panels]) if (p.contentType === 'dataset' && p.datasetId !== napa?.id) st.removePanel(p.id);
    const now = window.__FIBERBROWSER_STORE__!.getState();
    for (const p of now.panels) if (p.contentType === 'dataset' && p.collapsed) now.setPanelCollapsed(p.id, false);
    now.setViewport('chr19', 47_514_000, 47_518_000);
  });
  await expect.poll(async () => (await readTracks(tour)).length, { timeout: SPLIT_LOAD_MS }).toBe(1);
  await tour.getByTestId('panel-strand-chip').first().click();
  await tour.getByTestId('split-by-strand').first().click();
  await expect.poll(async () => {
    const tracks = await readTracks(tour);
    return tracks.length === 2 && tracks.every(t => t.loading === 'false' && t.rendered > 0);
  }, { timeout: SPLIT_LOAD_MS, intervals: [250], message: 'strand panels still loading' }).toBe(true);

  expect(refused).toEqual([]);
  expect(pageErrors).toEqual([]);
});

// H5 (UI audit): with dm6 in the main tab, the tour tab showed the hg38 demo under a
// red "Genome mismatch" banner, with dm6's chromosomes in the selector, for all
// 55 steps. The tour tab now runs on the demo's own genome (hg38 from the local
// cache, else no reference) and the main tab keeps its own.
test("the tour tab runs on the demo's genome, not the main tab's", async ({ page, context, server }) => {
  test.setTimeout(3 * 60_000);
  await context.addInitScript(() => {
    window.__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-tour-genome-'));
  const fasta = path.join(dir, 'dm6.fa');
  fs.writeFileSync(fasta, `>chr2L\n${'ACGT'.repeat(5000)}\n>chr3R\n${'TTGA'.repeat(5000)}\n`);
  fs.writeFileSync(`${fasta}.fai`, 'chr2L\t20000\t7\t20000\t20001\nchr3R\t20000\t20015\t20000\t20001\n');
  await page.goto(server.baseUrl);
  const loaded = await page.evaluate(async p => (await fetch(`/api/load_fasta?path=${encodeURIComponent(p)}`, { method: 'POST' })).json(), fasta);
  expect(loaded.success).toBe(true);
  const sandbox = await page.evaluate(async () => (await (await fetch('/api/sandbox', { method: 'POST' })).json()).id as string);

  const tour = await context.newPage();
  const refused: string[] = [];
  tour.on('response', response => {
    if (response.status() >= 400) refused.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
  });
  await tour.goto(`${server.baseUrl}/?sandbox=${sandbox}&tour=1&panels=${PANEL_LAUNCHER}`);
  // Step 1, then Next: the tour loads the demo.
  await tour.locator('.copilot-tutorial-popover .copilot-tutorial-next').click({ timeout: 60_000 });
  await expect.poll(async () => (await readTracks(tour)).some(t => t.rendered > 0), { timeout: 60_000, intervals: [250] }).toBe(true);
  await expect(tour.getByTestId('chrom-selector')).toHaveValue('chr19');
  await expect(tour.getByTestId('genome-mismatch-banner')).toHaveCount(0);
  const options = await tour.getByTestId('chrom-selector').locator('option').allTextContents();
  expect(options.some(o => o.startsWith('chr2L'))).toBe(false);
  expect(refused).toEqual([]);

  // The main tab still has its own reference.
  const status = await page.evaluate(async () => (await fetch('/api/status')).json());
  expect(status.fasta_path).toBe(fasta);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Owner report (3.0.0, first launch): the tour sat at its first step. The tour tab ran the start-up genome
// auto-load too (hg38, its default, when the main tab had no genome yet); that load held the tab's sandbox while
// it waited for the main tab's hg38 download, so the demo couldn't be added until the download was done. A tour
// tab now loads no genome of its own (the server gives it the demo's), and the tour goes on while the main tab
// is still getting its genome.
test.describe('a tour tab and the start-up genome', () => {
  // Its own server only: no demo-BAM fixture server beside it (the page's baseURL would start one).
  test.use({ baseURL: async ({}, use) => { await use(undefined); } });
  let proc: ServerProcess | null = null;
  test.afterEach(async () => {
    if (proc) await stopServer(proc);
    proc = null;
  });

  test('the tour tab loads no genome of its own while the main tab is still getting one', async ({ page, context }) => {
    test.setTimeout(3 * 60_000);
    // A server with no reference (not even FIBERBROWSER_TEST_FASTA), as on a first launch.
    const testFasta = process.env.FIBERBROWSER_TEST_FASTA;
    delete process.env.FIBERBROWSER_TEST_FASTA;
    try {
      proc = await startServer(null, await pickRandomPort());
    } finally {
      if (testFasta !== undefined) process.env.FIBERBROWSER_TEST_FASTA = testFasta;
    }
    const server = proc;
    // Every start-up genome load is held (never answered, never downloads): the main tab's stays pending.
    await context.route(/\/api\/(load_genome|load_fasta)/, async () => {
      await new Promise(() => {});
    });
    await page.goto(server.baseUrl);
    await expect(page.getByTestId('welcome-tour-cta')).toBeVisible({ timeout: 30_000 });
    const sandbox = await page.evaluate(async () => (await (await fetch('/api/sandbox', { method: 'POST' })).json()).id as string);
    const tour = await context.newPage();
    const fromTour: string[] = [];
    tour.on('request', request => {
      const where = new URL(request.url()).pathname;
      if (/^\/api\/(load_genome|load_fasta)/.test(where)) fromTour.push(where);
    });
    await tour.goto(`${server.baseUrl}/?sandbox=${sandbox}&tour=1&panels=${PANEL_LAUNCHER}`);
    const popover = tour.locator('.copilot-tutorial-popover:not(.copilot-tutorial-waiting)');
    const title = popover.locator('.copilot-tutorial-popover-title');
    await expect(title).toHaveText(TOUR_CHECKED.welcome, { timeout: 60_000 });
    await popover.locator('.copilot-tutorial-next').click();
    // The demo loads and the tour goes on to its next step.
    await expect(title).not.toHaveText(TOUR_CHECKED.welcome, { timeout: 60_000 });
    await expect.poll(async () => (await readTracks(tour)).some(t => t.rendered > 0), { timeout: 60_000, intervals: [250] }).toBe(true);
    await expect(popover.locator('.copilot-tutorial-popover-body')).not.toContainText('load a BAM');
    expect(fromTour).toEqual([]);
  });
});

// Codex integration review (fb24, M4): in a narrow window Sort (and the groups after it) go to the
// toolbar's More menu; the tour never opened it, so a normal tab skipped those steps
// and a sandbox tab said the controls only exist in the main tab.
test('in a narrow window the tour opens More for the toolbar groups that went there', async ({ page, context, server }) => {
  test.setTimeout(5 * 60_000);
  await context.addInitScript(() => {
    window.__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
  });
  await page.goto(server.baseUrl);
  await mainTabOpen(page);
  const sandbox = await page.evaluate(async () => (await (await fetch('/api/sandbox', { method: 'POST' })).json()).id as string);
  const tour = await context.newPage();
  const pageErrors: string[] = [];
  tour.on('pageerror', error => pageErrors.push(error.message));
  await tour.setViewportSize({ width: 500, height: 900 });
  await tour.goto(`${server.baseUrl}/?sandbox=${sandbox}&tour=1&step=sort-filter&panels=${PANEL_LAUNCHER}`);

  const popover = tour.locator('.copilot-tutorial-popover:not(.copilot-tutorial-waiting)');
  const title = popover.locator('.copilot-tutorial-popover-title');
  for (const [step, group] of [[TOUR_CHECKED.sortFilter, 'sort']] as const) {
    await expect(title).toHaveText(step, { timeout: 3 * 60_000 });
    // The group is in the More menu at this width, and the tour opened it and rings the group.
    expect((await tour.getByTestId('toolbar-groups-more').getAttribute('data-toolbar-overflow'))?.split(' ')).toContain(group);
    await expect(tour.getByTestId('toolbar-groups-more-menu')).toBeVisible();
    await expect(tour.getByTestId('toolbar-groups-more-menu').getByTestId(`toolbar-group-${group}`)).toBeVisible();
    expect(await tour.locator('.copilot-highlight').count(), `${step}: ringed`).toBeGreaterThan(0);
    await expect(popover.locator('.copilot-tutorial-popover-body')).not.toContainText('This tour tab is a sandbox');
    await popover.locator('.copilot-tutorial-next').click();
  }
  // The next step is about the reads; the More menu is closed again.
  await expect(title).not.toHaveText(TOUR_CHECKED.sortFilter);
  await expect(tour.getByTestId('toolbar-groups-more-menu')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

// fb-n4-tour: the Welcome card's "Take the tour" is how a user starts the tour. The
// launchers start the server with no dataset; the card waits (at most 3 s) for the
// launch decision (fb-n2-sessions: a saved last session becomes the card's first
// button), then offers the tour, which opens in its own sandbox tab.
test.describe('the Welcome card offers the tour', () => {
  // Its own empty server only: no demo-BAM fixture server beside it (the page's baseURL would start one).
  test.use({ baseURL: async ({}, use) => { await use(undefined); } });
  let proc: ServerProcess | null = null;
  test.afterEach(async () => {
    if (proc) await stopServer(proc);
    proc = null;
  });

  test('an empty launch shows the Welcome card, and Take the tour opens the tour tab', async ({ page, context }) => {
    test.setTimeout(3 * 60_000);
    const port = await pickRandomPort();
    proc = await startServer(null, port);
    const baseUrl = proc.baseUrl;
    await context.addInitScript(() => {
      window.__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    });
    await page.goto(baseUrl);
    const cta = page.getByTestId('welcome-tour-cta');
    await expect(cta).toBeVisible();
    // It stays (not a flash before the launch decision).
    await page.waitForTimeout(1_000);
    await expect(cta).toBeVisible();

    const opened = context.waitForEvent('page');
    const sandboxCreated = page.waitForResponse(r => new URL(r.url()).pathname === '/api/sandbox' && r.request().method() === 'POST');
    await cta.click();
    const tour = await opened;
    // (The tour tab tidies ?sandbox=…&tour=1 out of its address bar once it starts: not waited on.)
    expect((await (await sandboxCreated).json()).id).toMatch(/^sb-/);
    const popover = tour.locator('.copilot-tutorial-popover:not(.copilot-tutorial-waiting)');
    await expect(popover.locator('.copilot-tutorial-popover-title')).toHaveText(TOUR_CHECKED.welcome, { timeout: 2 * 60_000 });
    // The main tab keeps its Welcome card (the tour ran in its own tab).
    await expect(cta).toBeVisible();
  });
});

// fb-n4-tour: a launch with a dataset on the command line never shows the Welcome card,
// not even for the moment before the dataset list comes back (it flashed for ~0.1 s
// before fb-n2-sessions held the card back for the launch decision).
test('a launch with a dataset never flashes the Welcome card', async ({ page, context, server }) => {
  await context.addInitScript(() => {
    window.__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as unknown as { __welcomeSeen: boolean }).__welcomeSeen = false;
    const seen = () => {
      if (document.querySelector('[data-testid="welcome-card"]')) (window as unknown as { __welcomeSeen: boolean }).__welcomeSeen = true;
    };
    new MutationObserver(seen).observe(document, { childList: true, subtree: true });
  });
  await page.goto(server.baseUrl);
  await mainTabOpen(page);
  // Past the launch decision's 3 s cap.
  await page.waitForTimeout(3_500);
  expect(await page.evaluate(() => (window as unknown as { __welcomeSeen: boolean }).__welcomeSeen)).toBe(false);
});
