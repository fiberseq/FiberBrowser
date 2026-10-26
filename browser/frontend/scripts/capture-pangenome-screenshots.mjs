#!/usr/bin/env node
/**
 * Screenshots for the pangenome docs (docs/workflows/{pangenome-setup,live-lift,linked-panels,differences,
 * structural-variants,graph-mode}.md), taken in headless Chromium from a server started by scripts/unified_demo.py
 * with its default single sample ("Sample A (lifted)" and "Sample A (GRCh38)") and, for the assembly labels, the
 * sample's assembly FASTA:
 *
 *   python scripts/unified_demo.py --port 8890 --build --source-fasta ~/pglift_work/ref/source.fa.gz
 *   cd browser/frontend
 *   node scripts/capture-pangenome-screenshots.mjs --base-url http://localhost:8890 --work-dir ~/pglift_work
 *
 * Writes docs/images/pangenome/*.png (live lift, linked panels, the Differences row and inspector with the
 * assembly-comparison labels, SV evidence levels, setup) and docs/images/graph/graph-mode-*.png. The guide's
 * Variants images (48-51, x17, x18) come from capture-tutorial-screenshots.mjs (--base-url works there too).
 *
 * Options:
 *   --base-url URL     the unified_demo.py server (required)
 *   --out DIR          pangenome PNGs (default: <repo>/docs/images/pangenome)
 *   --graph-out DIR    graph-mode PNGs (default: <repo>/docs/images/graph)
 *   --work-dir DIR     where the demo data lives; shown as ~/pglift_work in dialogs (default: $PGLIFT_WORK or ~/pglift_work)
 *   --only a,b         take only these shots (names without .png)
 *   --python PATH      Python with Pillow, for compression (default: python3)
 *   --no-compress      keep the raw 2x PNGs
 *   --width W          final PNG width (default 1600)
 *
 * Every shot is optional: a failure is logged and the next one is taken (the exit status is 1 if any failed). Datasets
 * a shot opens (source views, the own-assembly BAM) are removed again, so every page starts from the launcher's
 * state. Text that could identify a person or a computer is replaced before each shot: home folders, the work
 * folder and any other absolute path in inputs, text and titles; read names in the inspectors' tables (whatever
 * their format); PacBio movie names and UUIDs anywhere; laboratory sample IDs. Tooltips and transient notices are
 * hidden. Check every PNG anyway before committing it.
 */
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const AT = { chrom: 'chr3', start: 128_653_000, end: 128_661_000 };   // the AluY insertion of the demo data
const LIFTED = 'Sample A (lifted)';
const NATIVE = 'Sample A (GRCh38)';
const OWN = 'Sample A (own assembly)';

function parseArgs(argv) {
  const opts = {
    baseUrl: null, out: path.join(REPO_ROOT, 'docs', 'images', 'pangenome'),
    graphOut: path.join(REPO_ROOT, 'docs', 'images', 'graph'),
    workDir: process.env.PGLIFT_WORK || path.join(os.homedir(), 'pglift_work'),
    only: null, python: 'python3', compress: true, width: 1600,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--base-url') opts.baseUrl = next().replace(/\/$/, '');
    else if (a === '--out') opts.out = path.resolve(next());
    else if (a === '--graph-out') opts.graphOut = path.resolve(next());
    else if (a === '--work-dir') opts.workDir = path.resolve(next().replace(/^~(?=\/|$)/, os.homedir()));
    else if (a === '--only') opts.only = new Set(next().split(','));
    else if (a === '--python') opts.python = next();
    else if (a === '--no-compress') opts.compress = false;
    else if (a === '--width') opts.width = Number(next());
    else if (a === '-h' || a === '--help') { console.log('See the header of scripts/capture-pangenome-screenshots.mjs'); process.exit(0); }
    else throw new Error(`Unknown option ${a}`);
  }
  if (!opts.baseUrl) throw new Error('--base-url is required (a server started by scripts/unified_demo.py)');
  return opts;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Replace paths and read names in the page (text nodes, inputs, titles) before a shot. */
async function redact(page, workDir) {
  const real = p => { try { return realpathSync(p); } catch { return p; } };
  await page.evaluate(({ home, work, realHome, realWork }) => {
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rules = [[new RegExp(esc(realWork), 'g'), '~/pglift_work'], [new RegExp(esc(work), 'g'), '~/pglift_work'],
      [new RegExp(esc(realHome), 'g'), '~'], [new RegExp(esc(home), 'g'), '~'],
      [/(?:\/Users|\/home|\/data\/home)\/[^/\s"'<>]+/g, '~'],
      [/\/private\/(tmp|var)\/[^\s"'<>]*\/(?=pglift_work)/g, '~/'],
      // A safety net for laboratory sample IDs in file names or headers (the demo data is staged under neutral names).
      [/(?<![A-Za-z0-9])PS0\d+(?![A-Za-z0-9])/gi, 'sample_a']];
    const names = new Map();
    const readName = /\b(m\d{5}[A-Za-z0-9_]*\/\d+\/ccs(?:\/[A-Za-z0-9_]+)*|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/g;
    const fix = s => {
      let out = s;
      for (const [re, to] of rules) out = out.replace(re, to);
      // Any other absolute path keeps only its file name, under the neutral work folder (URLs are left alone).
      out = out.replace(/(?<![\w:/.])(?:~|\/)[^\s"'<>,]*\/([^/\s"'<>,]+)/g,
        (m, base) => (m.startsWith('~/pglift_work/') ? m : `~/pglift_work/${base}`));
      return out.replace(readName, m => {
        if (!names.has(m)) names.set(m, `read ${names.size + 1}`);
        return names.get(m);
      });
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const v = fix(n.nodeValue);
      if (v !== n.nodeValue) n.nodeValue = v;
    }
    for (const el of document.querySelectorAll('input, textarea')) {
      const v = fix(el.value);
      if (v !== el.value) el.value = v;
    }
    for (const el of document.querySelectorAll('[title]')) el.setAttribute('title', fix(el.getAttribute('title')));
    // Read and molecule names in the inspectors' tables are replaced whatever their format (first column).
    const tables = '[data-testid="live-lift-diff-popover"] tbody tr, [role="dialog"][aria-label^="Inspect"] tbody tr, '
      + 'section[aria-label="Molecule calls"] tbody tr, [data-panel-content-type*="insertion"] tbody tr';
    document.querySelectorAll(tables).forEach((tr, i) => {
      const cell = tr.querySelector('td');
      if (cell && cell.firstChild) cell.textContent = `read ${i + 1}`;
    });
  }, { home: os.homedir(), work: workDir, realHome: real(os.homedir()), realWork: real(workDir) });
}

const store = (page, body, arg) => page.evaluate(([b, a]) => {
  const s = window.__FIBERBROWSER_STORE__;
  return new Function('s', 'a', b)(s, a);
}, [body, arg ?? null]);

const panels = page => store(page, `const st = s.getState();
  return st.panels.filter(p => p.contentType === 'dataset').map(p => ({ id: p.id, ds: p.datasetId,
    label: st.datasets.find(d => d.id === p.datasetId)?.label ?? '', hap: p.liftHap ?? null, stateKey: p.stateKey ?? p.datasetId,
    mode: p.viewMode ?? 'linear', member: p.graphMemberOf ?? null, link: Boolean(p.liftLink), collapsed: Boolean(p.collapsed) }));`);

async function idle(page, ms = 800) {
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('[data-read-track-loading="true"]'), null, { timeout: 60_000 }).catch(() => {});
  await sleep(ms);
}

async function openPage(browser, baseUrl, { lifted = 'split', view = AT } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  page.on('pageerror', e => console.warn(`  pageerror: ${e.message}`));
  await page.addInitScript(view => {
    window.__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    localStorage.clear();
    sessionStorage.setItem('fiberhmm_welcome_dismissed', '1');
    localStorage.setItem('fiberbrowser_graph_mode_settings_v1', JSON.stringify({ defaultLiftedView: view }));
  }, lifted);
  await page.goto(`${baseUrl}/?chr=${view.chrom}&start=${view.start}&end=${view.end}`);
  await page.waitForFunction(() => window.__FIBERBROWSER_STORE__?.getState().panels.some(p => p.contentType === 'dataset'), null, { timeout: 120_000 });
  await idle(page, 2000);
  await dismissNotices(page);
  return page;
}

/** Close start-up notices (an unsaved-session offer, a genome notice, the rail's coach mark) so shots show the work. */
async function dismissNotices(page) {
  for (let i = 0; i < 4; i += 1) {
    const button = page.getByRole('button', { name: /Dismiss/ }).first();
    if (!(await button.isVisible().catch(() => false))) break;
    await button.click({ timeout: 2000 }).catch(() => {});
    await sleep(300);
  }
  await page.getByTestId('panel-rail-coach-dismiss').click({ timeout: 1500 }).catch(() => {});
  await page.locator('[aria-label="Close"], button:has-text("×")').filter({ has: page.locator('xpath=ancestor::*[contains(., "Analysis panels")]') }).first()
    .click({ timeout: 1000 }).catch(() => {});
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const stage = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-pangenome-shots-'));
  const browser = await chromium.launch();
  const done = [];
  const failed = [];
  const want = name => !opts.only || opts.only.has(name);
  const wantAny = (...names) => names.some(want);
  const shoot = async (page, name, locator) => {
    await page.mouse.move(2, 2);
    // A transient read-filter notice ("Min footprints is off") would cover the reads.
    await store(page, `s.getState().dismissMinFootprintsNotice?.()`).catch(() => {});
    // ... and the read tracks' other amber notices (for example a read filter hiding most reads at a wide view).
    await page.evaluate(() => document.querySelectorAll('[class*="bg-amber-50"] button[aria-label^="Dismiss"]').forEach(b => b.click())).catch(() => {});
    await sleep(500);
    await redact(page, opts.workDir);
    await (locator ?? page).screenshot({ path: path.join(stage, `${name}.png`) });
  };
  /** Run one shot; a failure is logged and the next shot is taken. */
  const take = async (name, fn) => {
    if (!want(name)) return;
    try {
      await fn();
      done.push(name);
      console.log(`ok    ${name}`);
    } catch (e) {
      failed.push(name);
      console.warn(`FAIL  ${name}: ${String(e.message ?? e).split('\n')[0]}`);
    }
  };
  // The server's datasets at the start (the launcher's samples). Source views and the own-assembly BAM a shot opens are
  // datasets too: they are removed before the next page, so every page starts from the launcher's state.
  const listDatasets = async () => {
    const r = await (await fetch(`${opts.baseUrl}/api/datasets`)).json();
    return (Array.isArray(r) ? r : r.datasets ?? []).map(d => d.id);
  };
  const initial = new Set(await listDatasets());
  const resetDatasets = async () => {
    for (const id of await listDatasets()) {
      if (!initial.has(id)) await fetch(`${opts.baseUrl}/api/datasets/${encodeURIComponent(id)}`, { method: 'DELETE' });
    }
  };
  const newPage = async lifted => { await resetDatasets(); return openPage(browser, opts.baseUrl, { lifted }); };

  try {
    // ================================================================ live lift, split panels
    if (wantAny('live-lift-split', 'live-lift-open-menu', 'live-lift-settings', 'live-lift-insertions', 'live-lift-hatching',
      'differences-expanded', 'differences-inspector', 'differences-row', 'differences-menu', 'differences-table',
      'differences-comparison', 'differences-comparison-inspector', 'linked-source-view', 'linked-hover')) {
      const page = await newPage('split');
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="live-lift-chip"]').length >= 2, null, { timeout: 120_000 });
      await idle(page, 2500);
      let ps = await panels(page);
      const mat = () => ps.find(p => p.hap === 'MAT' && !p.link);
      const pooledPanel = () => ps.find(p => p.label === LIFTED && !p.hap && !p.link);
      const readCanvas = p => page.locator(`[data-read-track-state-key="${p.stateKey}"] canvas[data-copilot-track="reads"]`).first();
      const strip = p => page.locator(`[data-testid="live-lift-diff-strip"][data-panel-id="${p.id}"]`);
      const rowMenu = async p => {
        await strip(p).locator('[data-testid="live-lift-diff-header"]').click({ button: 'right' });
        const menu = page.getByTestId('track-context-menu');
        await menu.waitFor({ timeout: 5000 });
        return menu;
      };
      /** A mark of the Differences row: a plain click (an element click, as the row re-renders while reads load). */
      const clickMark = loc => loc.evaluate(el => el.click());
      /** Inspect a mark from the keyboard (Enter on a focused mark opens the inspector). */
      const inspectMark = async loc => { await loc.focus(); await page.keyboard.press('Enter'); };

      await take('live-lift-split', async () => { await shoot(page, 'live-lift-split'); });

      await take('live-lift-open-menu', async () => {
        await page.getByTestId('open-menu-button').click();
        await page.getByTestId('open-menu-add-live-lift').waitFor({ timeout: 5000 });
        await shoot(page, 'live-lift-open-menu');
        await page.keyboard.press('Escape');
      });

      await take('live-lift-settings', async () => {
        await page.getByTestId(`panel-actions-${mat().id}`).click();
        await page.getByTestId('live-lift-settings-item').click();
        const dialog = page.getByTestId('live-lift-settings-dialog');
        await dialog.waitFor({ timeout: 10_000 });
        await sleep(600);
        await shoot(page, 'live-lift-settings');
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      });

      await take('live-lift-insertions', async () => {
        // The Insertions control in the toolbar's Layers row, set to "Ticks with size" (off by default).
        await store(page, `s.setState({ fillReadHeight: false, readRowHeight: 10 })`);
        await page.getByTestId('insertion-marks-select').selectOption({ label: 'Ticks with size' });
        await idle(page, 2500);
        await shoot(page, 'live-lift-insertions');
        await page.getByTestId('insertion-marks-select').selectOption({ label: 'Off' });
        await store(page, `s.setState({ fillReadHeight: true })`);
        await idle(page, 1000);
      });

      /** The map's differences of one haplotype in a window (individual items: the window is under the detail width). */
      const diffsOf = (hap, start, end) => page.evaluate(async ({ ds, hap, chrom, start, end }) => {
        const q = new URLSearchParams({ dataset_id: ds, chrom, start: String(start), end: String(end), lift_hap: hap, min_bp: '0', detail_bp: '250000' });
        const r = await fetch(`/api/lift/differences?${q}`);
        return r.ok ? ((await r.json()).items ?? []) : [];
      }, { ds: mat().ds, hap, chrom: AT.chrom, start, end });

      await take('live-lift-hatching', async () => {
        // The largest stretch of the reference with no counterpart on a haplotype (a deletion in the sample) near the
        // demo locus, zoomed so its hatching is wide.
        const gaps = [];
        for (const hap of ['MAT', 'PAT']) {
          for (const d of await diffsOf(hap, AT.start - 30_000, AT.end + 30_000)) {
            if (['deletion', 'no_correspondence', 'replacement'].includes(d.kind) && d.ref_bp >= 15) gaps.push({ ...d, hap });
          }
        }
        if (!gaps.length) throw new Error('no deletion near the demo locus');
        const g = gaps.sort((a, b) => b.ref_bp - a.ref_bp)[0];
        const pad = Math.max(150, g.ref_bp * 6);
        await store(page, `s.setState({ showCoverageHistogram: true })`);   // the hatching is drawn on the coverage track
        await store(page, `s.getState().setViewport(a.chrom, a.start, a.end)`, { chrom: AT.chrom, start: g.t_start - pad, end: g.t_end + pad });
        await idle(page, 3500);
        await shoot(page, 'live-lift-hatching');
        await store(page, `s.setState({ showCoverageHistogram: false })`);
        await store(page, `s.getState().setViewport(a.chrom, a.start, a.end)`, AT);
        await idle(page, 2500);
      });

      // ---------------------------------------------------------------- the Differences row
      const bigInsertion = (await diffsOf('MAT', AT.start, AT.end)).filter(d => d.kind === 'insertion' && d.alt_bp >= 50 && d.alt_bp <= 50_000)
        .sort((a, b) => b.alt_bp - a.alt_bp)[0];
      const matInsertion = () => strip(mat()).locator(bigInsertion ? `[data-difference-id="${bigInsertion.id}"]`
        : '[data-testid="live-lift-diff-item"][data-kind="insertion"]').first();

      // Closer in, so the expanded column (2.4 kb) is wide.
      const NEAR = { chrom: AT.chrom, start: 128_656_400, end: 128_658_400 };
      const collapseAll = async () => {
        for (let i = 0; i < 4 && await page.getByTestId('live-lift-expanded-collapse').count(); i += 1) {
          await page.getByTestId('live-lift-expanded-collapse').first().evaluate(el => el.click());
          await sleep(500);
        }
      };
      await take('differences-expanded', async () => {
        await store(page, `s.setState({ fillReadHeight: false, readRowHeight: 8 })`);
        await store(page, `s.getState().setViewport(a.chrom, a.start, a.end)`, NEAR);
        await idle(page, 2500);
        await matInsertion().waitFor({ timeout: 30_000 });
        await clickMark(matInsertion());
        await page.getByTestId('live-lift-expanded-block').first().waitFor({ timeout: 30_000 });
        await idle(page, 3000);
        await shoot(page, 'differences-expanded');
      });

      await take('differences-inspector', async () => {
        await inspectMark(matInsertion());
        const inspector = page.getByTestId('live-lift-diff-popover');
        await inspector.waitFor({ timeout: 30_000 });
        await inspector.locator('tbody tr').first().waitFor({ timeout: 60_000 }).catch(() => {});
        await inspector.getByRole('button', { name: 'Load molecule calls', exact: true }).click().catch(() => {});
        await page.getByTestId('difference-molecule-counts').waitFor({ timeout: 90_000 }).catch(() => {});
        await sleep(1000);
        await shoot(page, 'differences-inspector');
        await page.keyboard.press('Escape');
        await sleep(300);
      });
      await collapseAll();
      await store(page, `s.setState({ fillReadHeight: true })`);
      await store(page, `s.getState().setViewport(a.chrom, a.start, a.end)`, AT);
      await idle(page, 2500);

      // A pooled panel shows both haplotype lanes.
      if (wantAny('differences-row', 'differences-menu', 'differences-table', 'differences-comparison', 'differences-comparison-inspector')) {
        await page.getByTestId(`panel-actions-${mat().id}`).click();
        await page.getByTestId('live-lift-pool').click();
        await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="live-lift-chip"]')].some(e => /MAT\+PAT/.test(e.textContent)), null, { timeout: 30_000 });
        await idle(page, 2500);
        ps = await panels(page);
      }
      const pooledBox = () => page.locator(`[data-panel-id="${pooledPanel().id}"]`).first();

      const rowHeight = h => store(page, `s.getState().setSubTrackHeight(a.id, 'sv', a.h)`, { id: pooledPanel().id, h });
      // The table opens below the row, over the reads. At this build the row's wrapper has content-visibility: auto
      // (SubTrackDispatch.tsx), whose paint containment clips the table to the row, so it never shows; the shot lets
      // the row overflow and lifts it above the reads. Reported as a UI bug.
      const liftTable = () => page.evaluate(id => {
        const strip = document.querySelector(`[data-testid="live-lift-diff-strip"][data-panel-id="${id}"]`);
        const row = strip?.closest('.fb-track-row');
        for (const el of [strip, row]) {
          if (!el) continue;
          el.style.contentVisibility = 'visible';
          el.style.position = 'relative';
          el.style.zIndex = '45';
        }
      }, pooledPanel().id);
      await take('differences-row', async () => {
        await strip(pooledPanel()).waitFor({ timeout: 20_000 });
        await rowHeight(84);   // two lanes
        await idle(page, 1000);
        await shoot(page, 'differences-row', pooledBox());
      });

      await take('differences-menu', async () => {
        const item = strip(pooledPanel()).locator(bigInsertion ? `[data-difference-id="${bigInsertion.id}"]` : '[data-kind="insertion"]').first();
        await item.click({ button: 'right', force: true });
        await page.getByTestId('track-context-menu').waitFor({ timeout: 5000 });
        await sleep(400);
        await shoot(page, 'differences-menu');
        await page.keyboard.press('Escape');
      });

      await take('differences-table', async () => {
        await (await rowMenu(pooledPanel())).getByText('Show the table', { exact: false }).click();
        await sleep(1500);
        await liftTable();
        await shoot(page, 'differences-table', pooledBox());
      });

      // Read-supported edits: the Reads lane, compared with the assembly (labels in the row, the table and the inspector).
      const readMarks = () => strip(pooledPanel()).locator('[data-testid="live-lift-diff-item"]')
        .filter({ hasNot: page.locator('xpath=self::*[starts-with(@data-difference-id, "MAT:") or starts-with(@data-difference-id, "PAT:")]') });
      if (wantAny('differences-comparison', 'differences-comparison-inspector')) {
        await rowHeight(114);   // three lanes: MAT, PAT and Reads
        await (await rowMenu(pooledPanel())).getByText('Read-supported edits', { exact: false }).first().click();
        await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="live-lift-diff-item"]')]
          .some(e => !/^(MAT|PAT):/.test(e.dataset.differenceId ?? '')), null, { timeout: 90_000 }).catch(() => {});
        await idle(page, 2000);
      }
      await take('differences-comparison-inspector', async () => {
        // A read-supported insertion of 50 bp or more (else the largest read difference), compared with the assembly
        // through the reads' consensus.
        const pick = await readMarks().evaluateAll(els => {
          const big = els.find(e => e.dataset.kind === 'insertion') ?? els[0];
          return big?.dataset.differenceId ?? null;
        });
        if (!pick) throw new Error('no read-supported difference in view');
        await inspectMark(strip(pooledPanel()).locator(`[data-difference-id="${pick}"]`).first());
        const inspector = page.getByTestId('live-lift-diff-popover');
        await inspector.waitFor({ timeout: 30_000 });
        await inspector.getByRole('button', { name: 'Load molecule calls', exact: true }).click().catch(() => {});
        const compare = inspector.getByRole('button', { name: 'Compare consensus with assembly', exact: true });
        if (await compare.waitFor({ timeout: 60_000 }).then(() => true).catch(() => false)) await compare.click();
        await page.waitForFunction(() => /Confirmed by assembly|assembly-supported \(approximate\)/
          .test(document.querySelector('[data-testid="assembly-comparison-label"]')?.textContent ?? ''), null, { timeout: 180_000 }).catch(() => {});
        await sleep(1000);
        await shoot(page, 'differences-comparison-inspector');
        const label = await page.getByTestId('assembly-comparison-label').first().textContent().catch(() => '');
        console.log(`      comparison label: ${label || '(none)'}`);
        await page.keyboard.press('Escape');
      });

      await take('differences-comparison', async () => {
        // After the inspector compared the read insertion: its mark and the table's column show the label.
        if (!(await strip(pooledPanel()).locator('.top-full').count())) {
          await (await rowMenu(pooledPanel())).getByText('Show the table', { exact: false }).click().catch(() => page.keyboard.press('Escape'));
        }
        await idle(page, 2000);
        await liftTable();
        await shoot(page, 'differences-comparison', pooledBox());
      });

      // ---------------------------------------------------------------- linked panels (split panels again)
      if (wantAny('linked-source-view', 'linked-hover')) {
        // Back to the row's defaults: the map's lanes only, at the default height.
        for (const p of await panels(page)) await store(page, `s.getState().setSubTrackHeight(a, 'sv', null)`, p.id);
        await store(page, `s.setState(st => ({ panels: st.panels.map(p => (p.differenceSources ? { ...p, differenceSources: { assembly: true, reads: false } } : p)) }))`);
        if (!mat()) {
          await page.getByTestId(`panel-actions-${pooledPanel().id}`).click();
          await page.getByTestId('live-lift-split').click();
          await page.waitForFunction(() => document.querySelectorAll('[data-testid="live-lift-chip"]').length >= 2, null, { timeout: 30_000 });
          await idle(page, 2000);
          ps = await panels(page);
        }
      }

      await take('linked-source-view', async () => {
        // Only the MAT panel and its source view.
        for (const p of ps.filter(p => p.id !== mat().id)) await store(page, `s.getState().removePanel(a)`, p.id);
        await idle(page, 1000);
        await page.getByTestId(`panel-actions-${mat().id}`).click();
        await page.getByTestId('live-lift-open-source-MAT').click();
        await page.getByTestId('lift-link-chip').waitFor({ timeout: 60_000 });
        await idle(page, 4000);
        ps = await panels(page);
        await shoot(page, 'linked-source-view');
      });

      await take('linked-hover', async () => {
        ps = await panels(page);
        const src = ps.find(p => p.link);
        if (!src) throw new Error('no source view');
        await store(page, `s.setState({ fillReadHeight: false, readRowHeight: 6 })`);
        await idle(page, 1500);
        // Tooltips off (the outline follows the pointer either way, and a tooltip would show a read name).
        await store(page, `const st = s.getState(); if ('showTooltips' in st) s.setState({ showTooltips: false }); if ('tooltipsEnabled' in st) s.setState({ tooltipsEnabled: false });`);
        const m = readCanvas(mat());
        const sc = readCanvas(src);
        const box = await m.boundingBox();
        let both = false;
        for (const fx of [0.55, 0.35, 0.75, 0.2, 0.9]) {
          for (let y = box.y + 4; y < box.y + box.height - 2 && !both; y += 3) {
            await page.mouse.move(box.x + box.width * fx, y);
            await sleep(50);
            both = Number(await m.getAttribute('data-lift-hover-rows')) > 0 && Number(await sc.getAttribute('data-lift-hover-rows')) > 0;
          }
          if (both) break;
        }
        if (!both) throw new Error('no molecule drawn in both panels');
        await sleep(400);
        await page.evaluate(() => document.querySelectorAll('[role="tooltip"], [data-testid$="tooltip"]').forEach(e => { e.style.display = 'none'; }));
        await redact(page, opts.workDir);
        await page.screenshot({ path: path.join(stage, 'linked-hover.png') });   // keeps the pointer where it is
        await page.mouse.move(2, 2);
      });
      await page.close();
    }

    // ================================================================ structural variants on the native panel
    if (wantAny('sv-row-menu', 'sv-highlight', 'sv-tab', 'differences-lens', 'differences-native-inspector', 'sv-settings', 'setup-preview-features')) {
      const sv = await newPage('split');
      let sps = await panels(sv);
      for (const p of sps.filter(p => p.label !== NATIVE)) await store(sv, `s.getState().removePanel(a)`, p.id);
      await idle(sv, 2500);
      sps = await panels(sv);
      const nat = sps.find(p => p.label === NATIVE);
      const svTrack = sv.locator(`[data-panel-id="${nat.id}"] canvas[data-testid="sv-track-canvas-${nat.ds}"]`).first();
      /** The x of the strongest insertion on the native row (POST /api/variants/svs, as the Variants panel asks). */
      const insertionX = async () => {
        const box = await svTrack.boundingBox();
        const reads = sv.locator(`[data-panel-id="${nat.id}"] canvas[data-copilot-track="reads"]`).first();
        const sidebar = Number(await reads.getAttribute('data-track-sidebar')) || 0;
        const at = await store(sv, `const st = s.getState(); return { start: st.start, end: st.end };`);
        const pos = await sv.evaluate(async ({ ds, chrom, start, end }) => {
          const r = await fetch('/api/variants/svs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dataset_id: ds, chrom, start: Math.floor(start), end: Math.ceil(end), min_len: 50, include_duplicates: false }) });
          if (!r.ok) return null;
          const ins = ((await r.json()).clusters ?? []).filter(c => c.t === 'I').sort((a, b) => (b.support ?? 0) - (a.support ?? 0))[0];
          return ins ? ins.ref : null;
        }, { ds: nat.ds, chrom: AT.chrom, start: at.start, end: at.end });
        if (pos == null) throw new Error('no insertion on the native row in view');
        return { x: box.x + sidebar + ((pos - at.start) / (at.end - at.start)) * (box.width - sidebar), y: box.y + box.height / 2 };
      };
      const svMenu = async () => {
        await svTrack.waitFor({ timeout: 30_000 });
        const { x, y } = await insertionX();
        await sv.mouse.click(x, y, { button: 'right' });
        const menu = sv.getByTestId('track-context-menu');
        await menu.waitFor({ timeout: 5000 });
        return menu;
      };

      await take('sv-row-menu', async () => {
        await svMenu();
        await sleep(500);
        await shoot(sv, 'sv-row-menu');
        await sv.keyboard.press('Escape');
      });

      await take('sv-highlight', async () => {
        await store(sv, `s.setState({ fillReadHeight: false, readRowHeight: 8 })`);
        await idle(sv, 1000);
        await (await svMenu()).getByText('Highlight carriers (confirmed + putative)', { exact: true }).click();
        await idle(sv, 2000);
        await shoot(sv, 'sv-highlight');
        await store(sv, `s.setState({ fillReadHeight: true })`);
        await idle(sv, 1000);
      });

      await take('differences-native-inspector', async () => {
        // The native inspector compares with the open lifted dataset's assembly.
        await (await svMenu()).getByText('Inspect…', { exact: true }).click();
        const dialog = sv.locator('[role="dialog"][aria-label="Inspect difference"]').first();
        await dialog.waitFor({ timeout: 30_000 });
        await sv.getByTestId('assembly-comparison').first().waitFor({ timeout: 60_000 }).catch(() => {});
        await sv.waitForFunction(() => !/Comparing with the assembly/.test(document.querySelector('[data-testid="assembly-comparison"]')?.textContent ?? ''),
          null, { timeout: 120_000 }).catch(() => {});
        // Compared through the reads' consensus (an insertion's assembly label needs its sequence).
        await dialog.getByRole('button', { name: 'Load molecule calls', exact: true }).click().catch(() => {});
        const compare = dialog.getByRole('button', { name: 'Compare consensus with assembly', exact: true });
        if (await compare.waitFor({ timeout: 60_000 }).then(() => true).catch(() => false)) await compare.click();
        await sv.waitForFunction(() => /Confirmed by assembly|assembly-supported \(approximate\)/
          .test(document.querySelector('[data-testid="assembly-comparison-label"]')?.textContent ?? ''), null, { timeout: 180_000 }).catch(() => {});
        await idle(sv, 1500);
        await shoot(sv, 'differences-native-inspector');
        await sv.keyboard.press('Escape');
      });

      await take('sv-tab', async () => {
        const tile = sv.locator('[data-testid="panel-rail"], [data-testid="analysis-strip"]').getByRole('button', { name: 'Variants', exact: true }).first();
        await tile.click();
        await sv.locator('[data-panel-content-type="variants"] [data-analysis-tab="svs"]').first().click();
        await sv.locator('[data-panel-content-type="variants"] [data-testid="variants-sv"]').first().waitFor({ timeout: 90_000 });
        await idle(sv, 1500);
        await shoot(sv, 'sv-tab');
      });

      await take('differences-lens', async () => {
        await sv.keyboard.press('Escape');
        await (await svMenu()).getByText('Open this insertion in the lens', { exact: true }).click();
        await sv.locator('[data-panel-content-type="insertion-lens"], [data-panel-content-type*="insertion"]').first().waitFor({ timeout: 30_000 });
        await sv.waitForFunction(() => !/Loading the insertion's reads/.test(document.body.textContent ?? ''), null, { timeout: 180_000 }).catch(() => {});
        await idle(sv, 4000);
        await shoot(sv, 'differences-lens');
      });

      await take('sv-settings', async () => {
        await openSettings(sv, 'view', 'SV display');
        const details = sv.locator('details').filter({ has: sv.locator('summary', { hasText: 'Advanced carrier evidence' }) }).first();
        await details.evaluate(d => { d.open = true; d.scrollIntoView({ block: 'center' }); });
        await sleep(600);
        await shoot(sv, 'sv-settings');
        await closeSettings(sv, 'view');
      });

      await take('setup-preview-features', async () => {
        await openSettings(sv, 'view', 'preview features');
        await sv.getByTestId('preview-features-setting').scrollIntoViewIfNeeded();
        await sleep(600);
        await shoot(sv, 'setup-preview-features');
        await closeSettings(sv, 'view');
      });
      await sv.close();
    }

    // ================================================================ graph mode
    if (wantAny('setup-graph-packages', 'graph-mode-host', 'graph-mode-menu', 'graph-mode-joined', 'graph-mode-popout',
      'graph-mode-cluster', 'graph-mode-strips', 'graph-mode-handoff')) {
      const g = await newPage('graph');
      await take('setup-graph-packages', async () => {
        // Open > Register graph package... opens Settings at Graph mode > Graph packages.
        await g.getByTestId('open-menu-button').click();
        await g.getByRole('menuitem', { name: /Register graph package/ }).click();
        await g.getByTestId('graph-packages').waitFor({ timeout: 10_000 });
        await g.getByTestId('graph-mode-settings').scrollIntoViewIfNeeded().catch(() => {});
        await sleep(800);
        await shoot(g, 'setup-graph-packages');
        await closeSettings(g, 'view');
      });

      const graphReady = async () => {
        await g.waitForFunction(() => document.querySelectorAll('[data-testid="graph-host-body"] [data-testid="graph-panel"]').length >= 1, null, { timeout: 180_000 });
        await g.waitForFunction(() => Number(document.querySelector('[data-testid="graph-host-body"] [data-testid="graph-panel"]')?.getAttribute('data-graph-reads') || 0) > 20,
          null, { timeout: 120_000 }).catch(() => {});
        await idle(g, 2500);
      };
      if (wantAny('graph-mode-host', 'graph-mode-menu', 'graph-mode-joined', 'graph-mode-popout', 'graph-mode-cluster', 'graph-mode-strips', 'graph-mode-handoff')) {
        await graphReady();
        let gps = await panels(g);
        const host = gps.find(p => p.mode === 'graph');
        const nativeP = gps.find(p => p.label === NATIVE);
        const st = id => store(g, `return s.getState().panels.find(p => p.id === a)`, id);

        await take('graph-mode-host', async () => { await shoot(g, 'graph-mode-host'); });

        await take('graph-mode-menu', async () => {
          await g.getByTestId(`panel-actions-${host.id}`).click();
          await sleep(400);
          await shoot(g, 'graph-mode-menu');
          await g.keyboard.press('Escape');
        });

        // The native panel joins the graph (also for the cluster run, so it covers several panels).
        await g.getByTestId(`panel-actions-${host.id}`).click();
        await g.locator(`[data-testid="graph-add-panel"][data-member="${nativeP.id}"]`).first().click();
        await g.waitForFunction(id => window.__FIBERBROWSER_STORE__.getState().panels.find(p => p.id === id)?.collapsedByGraphGroup, nativeP.id, { timeout: 30_000 });
        await idle(g, 3000);
        await take('graph-mode-joined', async () => { await shoot(g, 'graph-mode-joined'); });

        await take('graph-mode-popout', async () => {
          gps = await panels(g);
          const pat = gps.find(p => p.member === host.id && p.hap === 'PAT');
          await g.getByTestId(`panel-actions-${host.id}`).click();
          await g.locator(`[data-testid="graph-pop-out"][data-member="${pat.id}"]`).first().click();
          await g.waitForFunction(id => !window.__FIBERBROWSER_STORE__.getState().panels.find(p => p.id === id)?.collapsed, pat.id, { timeout: 30_000 });
          await idle(g, 3500);
          await shoot(g, 'graph-mode-popout');
          await g.getByTestId(`panel-actions-${pat.id}`).click();
          await g.getByTestId('graph-fold-in').first().click();
          await idle(g, 2500);
        });

        await take('graph-mode-cluster', async () => {
          const PEAKS = [[128655000, 128655100], [128656200, 128656300], [128658000, 128658100], [128659000, 128659100]];
          await g.evaluate(PEAKS => {
            const s = window.__FIBERBROWSER_STORE__;
            const rule = { ...s.getState().peakRules[0], id: 'demo', enabled: true, name: 'Peaks', color: '#167dcd' };
            s.setState({ clusterMethod: 'kmeans', clusterK: 3, clusterPeakMode: 'accessibility', selectedPeaks: new Set(PEAKS.map((_, i) => i)),
              peakRules: [rule], peaksByRule: { demo: PEAKS.map(([start, end], i) => ({ start, end, index: i, layer: 0, chrom: 'chr3' })) }, peaksLocked: true });
          }, PEAKS);
          await sleep(800);
          await g.getByTestId('cluster-run-button').click();
          await g.waitForFunction(() => Boolean(window.__FIBERBROWSER_STORE__.getState().clusterMatchedRun?.graph), null, { timeout: 120_000 });
          await idle(g, 3500);
          await shoot(g, 'graph-mode-cluster');
        });

        await take('graph-mode-strips', async () => {
          // At most 16 rows per band: each band's density strip and its count of molecules drawn.
          await g.evaluate(pid => window.__FIBERBROWSER_STORE__.setState(st => ({ panels: st.panels.map(p => (p.id === pid
            ? { ...p, graphView: { ...p.graphView, reads: { ...(p.graphView.reads ?? { show: true, datasets: null }), maxRowsPerLane: 16 } } } : p)) })), host.id);
          await idle(g, 3000);
          await shoot(g, 'graph-mode-strips');
          await g.evaluate(pid => window.__FIBERBROWSER_STORE__.setState(st => ({ panels: st.panels.map(p => (p.id === pid
            ? { ...p, graphView: { ...p.graphView, reads: { ...p.graphView.reads, maxRowsPerLane: undefined } } } : p)) })), host.id);
          await idle(g, 1500);
        });

        await take('graph-mode-handoff', async () => {
          await g.evaluate(() => window.__FIBERBROWSER_STORE__.getState().setViewport('chr3', 128620000, 128690000));
          await g.waitForFunction(id => window.__FIBERBROWSER_STORE__.getState().panels.find(p => p.id === id)?.graphView?.handoff?.shown === 'linear', host.id, { timeout: 30_000 });
          await idle(g, 4500);
          await g.waitForFunction(() => !/Scanning peaks/.test(document.body.textContent ?? ''), null, { timeout: 90_000 }).catch(() => {});
          await sleep(1000);
          await shoot(g, 'graph-mode-handoff');
          await g.evaluate(() => window.__FIBERBROWSER_STORE__.getState().setViewport('chr3', 128653000, 128661000));
        });
        void st;
      }
      await g.close();
    }

    // ================================================================ the dialog, from a BAM aligned to the sample's assembly
    // Taken last: it opens that BAM as a plain dataset (as a user would before "View on another assembly"), then removes it.
    await take('live-lift-dialog', async () => {
      const own = path.join(opts.workDir, 'demo_data', 'sample_a.alu_chr3.hg002v1.1.bam');
      await resetDatasets();
      const r = await fetch(`${opts.baseUrl}/api/datasets/add`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: own, label: OWN }) });
      const added = await r.json();
      if (!added.success) throw new Error(`could not open the sample's own BAM: ${added.error}`);
      const d = await openPage(browser, opts.baseUrl, { lifted: 'graph' });
      try {
        await d.waitForFunction(label => window.__FIBERBROWSER_STORE__.getState().panels.some(p => p.contentType === 'dataset'
          && window.__FIBERBROWSER_STORE__.getState().datasets.find(x => x.id === p.datasetId)?.label === label), OWN, { timeout: 60_000 });
        await idle(d, 1500);
        const ownPanel = (await panels(d)).find(p => p.label === OWN);
        await d.getByTestId(`panel-actions-${ownPanel.id}`).click();
        await d.getByTestId('live-lift-from-bam').click();
        const dialog = d.getByTestId('live-lift-dialog');
        await dialog.waitFor({ timeout: 10_000 });
        await d.getByTestId('live-lift-map-suggestion').first().waitFor({ timeout: 30_000 });
        await d.waitForFunction(() => document.querySelector('[data-testid="live-lift-manifest"]')?.value, null, { timeout: 30_000 });
        await d.getByTestId('live-lift-haplotypes').waitFor({ timeout: 30_000 }).catch(() => {});
        await sleep(800);
        await dismissNotices(d);
        // The dialog alone (with a margin): the page behind it holds the BAM opened on the wrong genome.
        const box = await dialog.boundingBox();
        await d.mouse.move(2, 2);
        await redact(d, opts.workDir);
        await d.screenshot({ path: path.join(stage, 'live-lift-dialog.png'),
          clip: { x: Math.max(0, box.x - 16), y: Math.max(0, box.y - 16), width: box.width + 32, height: box.height + 32 } });
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      } finally {
        await d.close();
        await resetDatasets();
      }
    });
  } finally {
    await browser.close();
    await resetDatasets().catch(() => {});
  }

  if (opts.compress && done.length) compressAll(stage, opts.width, opts.python);
  mkdirSync(opts.out, { recursive: true });
  for (const f of readdirSync(stage).filter(f => f.endsWith('.png'))) {
    copyFileSync(path.join(stage, f), path.join(f.startsWith('graph-mode-') ? opts.graphOut : opts.out, f));
  }
  rmSync(stage, { recursive: true, force: true });
  console.log(`${done.length} screenshots${failed.length ? `; failed: ${failed.join(', ')}` : ''}`);
  if (failed.length) process.exitCode = 1;
}

/** Open Settings on one of its sections ('view': Reads & Display), searched for `query` (opens folded groups). */
async function openSettings(page, section, query) {
  const rail = page.getByTestId(`settings-rail-${section}`);
  if (!(await rail.count())) {
    const toggle = page.getByTestId('settings-toggle');
    if (await toggle.count()) await toggle.first().click();
    else await page.getByRole('button', { name: /^Settings/ }).first().click();
  }
  if (await rail.first().getAttribute('aria-pressed') !== 'true') await rail.first().click();
  await sleep(600);
  if (query) {
    await page.getByPlaceholder('Search settings').first().fill(query);
    await sleep(900);
  }
}

/** Close the Settings drawer (its rail button toggles it). */
async function closeSettings(page, section) {
  const rail = page.getByTestId(`settings-rail-${section}`).first();
  if (await rail.getAttribute('aria-pressed').catch(() => null) === 'true') await rail.click();
  await page.keyboard.press('Escape');
  await sleep(500);
}

/** Downscale to `width` and palette-compress (Pillow), in place (as capture-tutorial-screenshots.mjs). */
function compressAll(dir, width, python) {
  const py = `
import sys, os
from PIL import Image
d, width = sys.argv[1], int(sys.argv[2])
for name in sorted(os.listdir(d)):
    if not name.endswith('.png'):
        continue
    p = os.path.join(d, name)
    im = Image.open(p).convert('RGB')
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    im = im.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    im.save(p, optimize=True)
`;
  const r = spawnSync(python, ['-c', py, dir, String(width)], { stdio: 'inherit' });
  if (r.status !== 0) console.warn('Compression failed (is Pillow installed?); the PNGs stay uncompressed.');
}

main().catch(err => { console.error(err); process.exit(1); });
