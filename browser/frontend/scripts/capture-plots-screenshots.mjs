/**
 * Screenshots for the Plots and meta-locus pages (docs/workflows/plots.md, docs/workflows/meta-locus.md) and the
 * 3.1 additions to the guide. Runs against a server you started on the bundled NAPA demo, with --no-token:
 *
 *   python browser.py -b browser/data/demo/napa_ddda.bam -f REF.fa.gz -p PORT --no-token --no-open --copilot off
 *   node scripts/capture-plots-screenshots.mjs --base-url http://127.0.0.1:PORT [--out ../../docs/images] [--only a,b]
 *
 * REF can be the synthetic reference from tests/make_seqsearch_fasta.py (no hg38 download). Use a scratch HOME.
 * The BED files are written by this script (sites tiled over the demo locus, neutral names) and given to the app
 * by path (Plots) or as an upload (meta-locus); no native file dialog opens. Each shot is optional: a failure is
 * logged and the next one runs. PNGs are compressed to 1600 px and 256 colours (Pillow; --python, --no-compress).
 *
 * --nuc-bams A,B adds two synthetic chromatin BAMs (tests/nuc_fixtures.py chromatin_bam, contig chr3, offset
 * 128,602,000, as tests/e2e/nucleosomes.spec.ts makes them) as Sample A and B for the Nucleosomes panel shots
 * (shot "nucleosomes"; the server needs FiberHMM with fiberhmm.nuc).
 */
import { chromium } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const opts = { baseUrl: null, out: path.resolve(here, '../../../docs/images'), only: null, python: process.env.FIBERBROWSER_TEST_PYTHON || 'python3', compress: true };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  const next = () => process.argv[++i];
  if (a === '--base-url') opts.baseUrl = next().replace(/\/$/, '');
  else if (a === '--out') opts.out = path.resolve(next());
  else if (a === '--only') opts.only = new Set(next().split(','));
  else if (a === '--python') opts.python = next();
  else if (a === '--no-compress') opts.compress = false;
  else if (a === '--nuc-bams') opts.nucBams = next().split(',');
  else throw new Error(`Unknown option ${a}`);
}
if (!opts.baseUrl) throw new Error('--base-url is required');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const store = (page, fn) => page.evaluate(f => new Function('s', `return (${f})(s)`)(window.__FIBERBROWSER_STORE__.getState()), fn.toString());
const written = [];
/** Kept at the full 2x width (the README hero): compressed to 256 colours but not resized. */
const fullWidth = new Set();

async function newPage(browser, { width = 1440, height = 900, genome = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.addInitScript(keepGenome => {
    if (!keepGenome) window.__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    window.__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    try { localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('fiberhmm_welcome_dismissed', '1'); } catch { /* private mode */ }
  }, genome);
  await page.goto(opts.baseUrl);
  await page.waitForLoadState('networkidle');
  for (let i = 0; i < 60 && !(await store(page, s => s.datasets.length)); i++) await sleep(500);
  // Dismiss first-run tips so they don't cover the reads.
  await page.getByTestId('panel-rail-coach-dismiss').click({ timeout: 3000 }).catch(() => {});
  return page;
}

async function settle(page, ms = 1200) {
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  for (const text of ['Updating…', 'Reading regions', 'Scanning peaks…']) {
    await page.getByText(text).first().waitFor({ state: 'hidden', timeout: 90_000 }).catch(() => {});
  }
  // Toasts ("Kept in the Gallery…") fade on their own.
  await page.locator('[role="status"]').first().waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => {});
  await sleep(ms);
}

async function shoot(page, rel, locator = null) {
  const file = path.join(opts.out, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  if (locator) await locator.screenshot({ path: file });
  else await page.screenshot({ path: file });
  written.push(file);
  console.log(`  wrote ${rel}`);
}

async function shot(name, fn) {
  if (opts.only && !opts.only.has(name)) return;
  console.log(`shot ${name}`);
  try { await fn(); } catch (e) { console.log(`  FAILED ${name}: ${String(e.message).split('\n')[0]}`); }
}

/** Sites tiled over the demo locus (both strands), as a BED a reader would recognise. */
function writeBeds(dir, region) {
  const promoters = [];
  for (let i = 0, x = region.start + 500; x < region.end - 500; i++, x += 300) promoters.push(`${region.chrom}\t${x}\t${x + 200}\tsite${i}\t${(i * 37) % 100}\t${i % 2 ? '-' : '+'}`);
  const enhancers = [];
  for (let i = 0, x = region.start + 650; x < region.end - 650; i++, x += 420) enhancers.push(`${region.chrom}\t${x}\t${x + 100}\tenh${i}\t0\t+`);
  writeFileSync(path.join(dir, 'promoters.bed'), `${promoters.join('\n')}\n`);
  writeFileSync(path.join(dir, 'enhancers.bed'), `${enhancers.join('\n')}\n`);
  return { promoters: path.join(dir, 'promoters.bed'), enhancers: path.join(dir, 'enhancers.bed') };
}

async function openPlots(page) {
  if (!(await page.getByTestId('plots-workspace').count())) await page.keyboard.press('p');
  await page.getByTestId('plots-workspace').waitFor({ timeout: 15_000 });
  await settle(page);
}

async function moreOptions(page) {
  if (!(await page.getByTestId('plots-where').count())) await page.getByTestId('plots-more-options').click();
}

async function clusterReads(page) {
  if (await store(page, s => (s.clusterAssignments && Object.keys(s.clusterAssignments).length) || 0)) return;
  await page.getByTestId('plots-type-metaprofile').click();
  await page.getByTestId('plots-prereq-run-cluster').click();
  for (let i = 0; i < 120 && !(await store(page, s => (s.clusterAssignments && Object.keys(s.clusterAssignments).length) || 0)); i++) await sleep(1000);
  await settle(page, 2000);
}

const browser = await chromium.launch();
const work = mkdtempSync(path.join(os.tmpdir(), 'fb-plots-capture-'));
try {
  const page = await newPage(browser);
  const region = await store(page, s => ({ chrom: s.chrom, start: s.start, end: s.end }));
  const demo = await page.evaluate(() => fetch('/api/demo/info').then(r => (r.ok ? r.json() : null)).catch(() => null));
  const locus = demo?.region ?? { chrom: region.chrom, start: 47_514_000, end: 47_518_000 };
  const beds = writeBeds(work, locus);

  await shot('workspace', async () => {
    await openPlots(page);
    await page.getByTestId('plots-type-size-enrichment').click();
    await settle(page, 2500);
    await shoot(page, 'plots/workspace.png');
  });

  await shot('metaprofile-bands', async () => {
    await openPlots(page);
    await page.getByTestId('plots-type-metaprofile').click();
    await page.getByTestId('plots-group-dataset').click();
    await moreOptions(page);
    const band = page.getByTestId('plots-profile-band');
    await band.scrollIntoViewIfNeeded();
    await band.selectOption('each').catch(async () => { await band.click(); });
    await settle(page, 2500);
    await shoot(page, 'plots/metaprofile-bands.png');
    await band.selectOption('off').catch(() => {});
  });

  await shot('size-histogram', async () => {
    await openPlots(page);
    await page.getByTestId('plots-type-size-histogram').click();
    await moreOptions(page);
    await page.getByTestId('plots-where-random').click();
    // Fewer reads than the demo file has, so none are dropped.
    await page.getByTestId('plots-sampling-n').fill('2000');
    await page.getByTestId('plots-sampling-n').press('Enter');
    await settle(page, 4000);
    await shoot(page, 'plots/size-histogram-random.png');
    await page.getByTestId('plots-where-view').click();
    await settle(page);
  });

  await shot('vplot', async () => {
    await openPlots(page);
    await page.getByTestId('plots-type-vplot').click();
    await settle(page, 2500);
    await shoot(page, 'plots/vplot.png');
  });

  await shot('heatmap-bed', async () => {
    await openPlots(page);
    await page.getByTestId('plots-type-heatmap').click();
    await moreOptions(page);
    await page.getByTestId('plots-where-bed').click();
    for (const file of [beds.promoters, beds.enhancers]) {
      await page.getByTestId('plots-bed-path').fill(file);
      await page.getByTestId('plots-bed-add').click();
      await sleep(1500);
    }
    await page.getByTestId('plots-bed-path').fill('');
    await settle(page, 5000);
    await shoot(page, 'plots/heatmap-bed.png');
  });

  await shot('summary', async () => {
    await openPlots(page);
    await page.getByTestId('plots-type-metaprofile').click();
    await moreOptions(page);
    await page.getByTestId('plots-where-view').click().catch(() => {});
    await clusterReads(page);
    await page.getByTestId('plots-type-metaprofile').click();
    await page.getByTestId('plots-group-cluster').click();
    await page.getByTestId('plots-source-fire').click().catch(() => page.getByTestId('plots-source-accessibility').click().catch(() => {}));
    await page.getByTestId('plots-summary-on').check();
    await settle(page, 3000);
    await page.getByTestId('plots-workspace').evaluate(el => { const s = el.querySelector('[data-testid="plots-card"]')?.closest('.overflow-auto, .overflow-y-auto'); if (s) s.scrollTop = 0; });
    await shoot(page, 'plots/summary-clusters.png');
    await page.getByTestId('plots-summary-on').uncheck();
  });

  // Compare from the builder's main row (after Group by), with Summary across groups: one value per comparison.
  await shot('compare-summary', async () => {
    await openPlots(page);
    await clusterReads(page);
    await page.getByTestId('plots-type-metaprofile').click();
    await page.getByTestId('plots-group-cluster').click();
    await page.getByTestId('plots-compare-diff').click();
    await settle(page, 1500);
    // One comparison (A vs B: the first two clusters), so the facet and its summary fit.
    await page.getByTestId('plots-compare-mode').selectOption('a-vs-b');
    await page.getByTestId('plots-summary-on').check();
    await settle(page, 3500);
    await page.getByTestId('plots-workspace').evaluate(el => { const s = el.querySelector('[data-testid="plots-card"]')?.closest('.overflow-auto, .overflow-y-auto'); if (s) s.scrollTop = 0; });
    await shoot(page, 'plots/compare-summary.png');
    await page.getByTestId('plots-summary-on').uncheck();
    await page.getByTestId('plots-compare-mode').selectOption('rest').catch(() => {});
    await page.getByTestId('plots-compare-off').click();
    await settle(page);
  });

  await shot('gallery', async () => {
    await openPlots(page);
    await page.getByTestId('plots-type-metaprofile').click();
    await page.getByTestId('plots-group-dataset').click();
    await settle(page, 2000);
    await page.getByTestId('plots-keep').click();
    await sleep(800);
    await page.getByTestId('plots-type-size-enrichment').click();
    await settle(page, 2500);
    await page.getByTestId('plots-keep').click();
    await sleep(800);
    await page.getByTestId('plots-type-size-histogram').click();
    await settle(page, 2500);
    await page.getByTestId('plots-keep').click();
    await sleep(800);
    await page.getByTestId('plots-tab-gallery').click();
    await settle(page, 5000);
    await shoot(page, 'plots/gallery.png');
    await page.getByTestId('plots-tab-plot').click();
  });

  await shot('coacc', async () => {
    await openPlots(page);
    await page.getByTestId('plots-type-co-accessibility').click();
    await page.getByTestId('plots-group-dataset').click().catch(() => {});
    await settle(page, 5000);
    await shoot(page, 'plots/co-accessibility.png');
  });

  await page.close();

  // ── Guide extras: the default metaprofile follows the layers; Min footprints and uncalled reads ──
  const gpage = await newPage(browser);
  await shot('metaprofile-follow', async () => {
    await gpage.locator('[data-testid="panel-rail-track-browser"], [data-testid="analysis-strip-button-track-browser"]').first().click();
    const cart = gpage.locator('[data-panel-content-type="track-browser"]');
    await cart.getByRole('button', { name: /^\s*Metaprofile\s*metaprofile\b/ }).first().click();
    await cart.getByTestId('default-metaprofile-follow-layers').waitFor();
    await settle(gpage, 1500);
    await shoot(gpage, 'guide/x19_metaprofile_follow_layers.png');
  });
  await shot('min-footprints', async () => {
    await gpage.getByTestId('settings-rail-file').click();
    await gpage.getByTestId('settings-search-input').fill('min footprints');
    const control = gpage.getByTestId('settings-sidebar').locator('[data-setting-id="view.min-footprints"]');
    await control.waitFor();
    await control.scrollIntoViewIfNeeded();
    await settle(gpage, 1500);
    await shoot(gpage, 'guide/x20_min_footprints.png');
  });
  await gpage.close();

  // ── Layer colours (docs/guide.md "Layer colours"): Labels → Layer colours with the nucleosome layer recoloured,
  // and the toggle's right-click "Change colour…". The colour is set by filling the input (no native picker opens).
  const lpage = await newPage(browser);
  await shot('layer-colours', async () => {
    await lpage.locator('[data-testid="panel-rail-colormap"], [data-testid="analysis-strip-button-colormap"]').first().click();
    const panel = lpage.locator('[data-panel-content-type="colormap"]');
    await panel.waitFor({ timeout: 15_000 });
    const details = panel.getByTestId('layer-colours-details');
    if (!(await details.evaluate(el => el.open))) await details.locator('summary').click();
    const section = panel.getByTestId('layer-colours-section');
    await section.waitFor();
    const key = (await panel.locator('[data-testid^="layer-colour-row-"]').first().getAttribute('data-testid')).replace('layer-colour-row-', '');
    await panel.getByTestId(`layer-colour-input-${key}`).fill('#d97706');
    await section.scrollIntoViewIfNeeded();
    await settle(lpage, 2000);
    await shoot(lpage, 'guide/x22_layer_colours.png');
  });
  await shot('change-colour', async () => {
    await lpage.getByTestId('layer-checkbox-tf').locator('xpath=..').click({ button: 'right' });
    await lpage.getByTestId('layer-colour-menu').waitFor({ timeout: 5000 });
    await sleep(600);
    await shoot(lpage, 'guide/x23_change_colour.png');
    await lpage.keyboard.press('Escape');
  });
  await lpage.close();

  // ── Meta-locus ─────────────────────────────────────────────────────────
  const mpage = await newPage(browser);
  await shot('open-menu', async () => {
    await mpage.getByTestId('panel-rail-coach-dismiss').click({ timeout: 2000 }).catch(() => {});
    await mpage.getByTestId('open-menu-button').click();
    await mpage.getByTestId('open-menu').getByText('Open BED as meta-locus…').waitFor({ timeout: 5000 });
    await sleep(600);
    await shoot(mpage, 'meta-locus/open-menu.png');
    await mpage.keyboard.press('Escape');
    await sleep(400);
  });
  await shot('meta-locus', async () => {
    await mpage.keyboard.press('ControlOrMeta+k');
    await mpage.getByTestId('command-palette-input').fill('meta-locus');
    await mpage.locator('[role="option"][data-palette-item="cmd:open-meta-locus"]').click();
    const dialog = mpage.getByTestId('meta-locus-dialog');
    await dialog.waitFor();
    await mpage.getByTestId('meta-locus-file').setInputFiles(beds.promoters);
    await mpage.getByTestId('meta-locus-flank').fill('1500');
    await sleep(600);
    await shoot(mpage, 'meta-locus/dialog.png');
    await mpage.getByTestId('meta-locus-open').click();
    await dialog.waitFor({ state: 'hidden' });
    await mpage.getByTestId('meta-locus-progress').waitFor({ state: 'detached', timeout: 120_000 }).catch(() => {});
    await mpage.getByTestId('meta-locus-count').waitFor({ timeout: 60_000 });
    await settle(mpage, 3000);
    // Cluster and keep the workspace full, as on any locus.
    const width = await store(mpage, s => s.end);
    await mpage.evaluate(w => {
      const st = window.__FIBERBROWSER_STORE__.getState();
      st.addCustomPeak(Math.round(w * 0.42), Math.round(w * 0.47));
      st.addCustomPeak(Math.round(w * 0.53), Math.round(w * 0.58));
    }, width);
    await sleep(800);
    await mpage.getByTestId('cluster-run-button').click();
    for (let i = 0; i < 90 && !(await store(mpage, s => (s.clusterAssignments && Object.keys(s.clusterAssignments).length) || 0)); i++) await sleep(1000);
    await settle(mpage, 5000);
    await shoot(mpage, 'meta-locus/clustered.png');
  });
  await mpage.close();

  // ── README hero: the NAPA demo with genes (start the server with -f hg38.fa -g hg38.gtf), its layers, the
  // metaprofile, clustered reads and the Clusters panel's profiles beside them; run with --only hero.
  if (opts.only?.has('hero')) {
    const hpage = await newPage(browser, { width: 1600, height: 1000, genome: true });
    await shot('hero', async () => {
      await hpage.getByTestId('panel-rail-coach-dismiss').click({ timeout: 3000 }).catch(() => {});
      await hpage.evaluate(() => window.__FIBERBROWSER_STORE__.getState().setViewport('chr19', 47_514_000, 47_518_000));
      await settle(hpage, 2500);
      for (const layer of ['nuc', 'tf', 'fire', 'msp']) await hpage.getByTestId(`layer-checkbox-${layer}`).setChecked(true).catch(() => {});
      await hpage.evaluate(() => {
        const st = window.__FIBERBROWSER_STORE__.getState();
        st.addCustomPeak(47_515_000, 47_515_420);
        st.addCustomPeak(47_515_560, 47_515_700);
        const now = window.__FIBERBROWSER_STORE__.getState();
        for (const p of now.getAllPeaks()) if (p.isCustom && !now.selectedPeaks.has(p.index)) now.togglePeakSelection(p.index);
      });
      await sleep(800);
      await hpage.getByTestId('cluster-run-button').click();
      for (let i = 0; i < 120 && !(await store(hpage, s => (s.clusterAssignments && Object.keys(s.clusterAssignments).length) || 0)); i++) await sleep(1000);
      await settle(hpage, 2000);
      await hpage.locator('[data-testid="panel-rail-cluster-detail"], [data-testid="analysis-strip-button-cluster-detail"]').first().click();
      const panel = hpage.locator('[data-panel-content-type="cluster-detail"]');
      await panel.getByRole('button', { name: 'Merge similar clusters' }).first().click({ timeout: 5000 }).catch(() => {});
      await settle(hpage, 1500);
      await panel.locator('[data-analysis-tab="charts"]').first().click().catch(() => {});
      await panel.locator('[data-analysis-tab="profiles"]').first().click().catch(() => {});
      await settle(hpage, 3000);
      await shoot(hpage, 'hero/fiberbrowser.png');
      fullWidth.add(written[written.length - 1]);
    });
    await hpage.close();
  }

  // ── A custom MA group (docs/guide.md "Your own annotations"): a server on the demo BAM after the guide's pysam
  // example added a "promoter" group; run with --only custom-layer.
  if (opts.only?.has('custom-layer')) {
    const cpage = await newPage(browser);
    await shot('custom-layer', async () => {
      const box = cpage.getByTestId('layer-checkbox-promoter');
      await box.waitFor({ timeout: 30_000 });
      await box.setChecked(true);
      await settle(cpage, 3000);
      await shoot(cpage, 'guide/x21_custom_ma_layer.png');
    });
    await cpage.close();
  }

  // ── Nucleosomes panel on two synthetic chromatin samples ──
  if (opts.nucBams && (!opts.only || opts.only.has('nucleosomes'))) {
    const npage = await newPage(browser);
    await shot('nucleosomes', async () => {
      for (const [i, file] of opts.nucBams.entries()) {
        const r = await (await npage.request.post(`${opts.baseUrl}/api/datasets/add`, { data: { path: file, label: `Sample ${'AB'[i]}` } })).json();
        if (!r.success) throw new Error(`could not add ${path.basename(file)}`);
      }
      await npage.reload();
      await npage.waitForLoadState('networkidle');
      for (let i = 0; i < 60 && (await store(npage, s => s.datasets.filter(d => /^Sample [AB]$/.test(d.label ?? d.name ?? '')).length)) < 2; i++) await sleep(500);
      await npage.getByTestId('panel-rail-coach-dismiss').click({ timeout: 3000 }).catch(() => {});
      await npage.evaluate(() => {
        const s = window.__FIBERBROWSER_STORE__.getState();
        // Only the two samples: close the demo's panel if the server also loaded it.
        for (const d of s.datasets) if (!/^Sample [AB]$/.test(d.label ?? d.name ?? '')) s.removeDataset?.(d.id);
        s.setViewport('chr3', 128_622_000, 128_634_000);
        s.openAnalysisPanel('nucleosomes');
      });
      await npage.getByTestId('nuc-panel').waitFor({ timeout: 30_000 });
      await npage.getByTestId('nuc-job').and(npage.locator('[data-state="complete"]')).waitFor({ timeout: 300_000 });
      await npage.getByTestId('nuc-geo-card').waitFor({ timeout: 180_000 });
      await settle(npage, 3000);
      await shoot(npage, 'nucleosome/geometries.png');
      const charts = npage.getByRole('button', { name: 'Charts', exact: true });
      if (await charts.isVisible()) await charts.click();
      else { await npage.getByTestId('analysis-tab-more').click(); await npage.getByRole('menuitem', { name: 'Charts', exact: true }).click(); }
      await npage.getByTestId('nuc-reg-scores-chart').waitFor({ timeout: 120_000 });
      await settle(npage, 2500);
      await shoot(npage, 'nucleosome/charts.png');
    });
    await npage.close();
  }
} finally {
  await browser.close();
}

if (opts.compress && written.length) {
  const py = `
import sys
from PIL import Image
w = int(sys.argv[1])
for p in sys.argv[2:]:
    im = Image.open(p).convert('RGB')
    if im.width > w:
        im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
    im = im.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    im.save(p, optimize=True)
`;
  const r = spawnSync(opts.python, ['-c', py, '1600', ...written.filter(f => !fullWidth.has(f))], { stdio: 'inherit' });
  if (fullWidth.size) spawnSync(opts.python, ['-c', py, '100000', ...fullWidth], { stdio: 'inherit' });
  if (r.status !== 0) console.log('compression failed (Pillow?)');
}
console.log(`${written.length} screenshots`);
