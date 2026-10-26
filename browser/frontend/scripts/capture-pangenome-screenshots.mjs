#!/usr/bin/env node
/**
 * Screenshots for the pangenome docs (docs/workflows/{pangenome-setup,live-lift,linked-panels,differences,
 * structural-variants,graph-mode}.md), taken in headless Chromium from a server started by scripts/unified_demo.py
 * with its default single sample:
 *
 *   python scripts/unified_demo.py --port 8890 --build ...          # "Sample A (lifted)" and "Sample A (GRCh38)"
 *   cd browser/frontend
 *   node scripts/capture-pangenome-screenshots.mjs --base-url http://localhost:8890 --work-dir ~/pglift_work
 *
 * Options:
 *   --base-url URL     the unified_demo.py server (required)
 *   --out DIR          pangenome PNGs (default: <repo>/docs/images/pangenome)
 *   --graph-out DIR    graph-mode PNGs that are recaptured here (default: <repo>/docs/images/graph)
 *   --work-dir DIR     where the demo data lives; shown as ~/pglift_work in dialogs (default: $PGLIFT_WORK or ~/pglift_work)
 *   --only a,b         take only these shots (names without .png)
 *   --python PATH      Python with Pillow, for compression (default: python3)
 *   --no-compress      keep the raw 2x PNGs
 *   --width W          final PNG width (default 1600)
 *
 * Every shot is optional: a failure is logged and the next one is taken. Text that could identify a person or a
 * computer is replaced before each shot: home folders and the work folder in paths (inputs, text and titles),
 * read names in the inspectors' tables (whatever their format), PacBio movie names and UUIDs anywhere, by
 * "read 1", "read 2", ... Tooltips are hidden. Check every PNG anyway before committing it.
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
  await page.locator('button:has-text("Dismiss")').first().click({ timeout: 3000 }).catch(() => {});
  await page.getByTestId('panel-rail-coach-dismiss').click({ timeout: 3000 }).catch(() => {});
  await idle(page, 2000);
  return page;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const stage = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-pangenome-shots-'));
  const browser = await chromium.launch();
  const done = [];
  const failed = [];
  const want = name => !opts.only || opts.only.has(name);
  const shoot = async (page, name, locator) => {
    await page.mouse.move(2, 2);
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

  try {
    // ---------------------------------------------------------------- live lift, split panels
    const page = await openPage(browser, opts.baseUrl, { lifted: 'split' });
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="live-lift-chip"]').length >= 2, null, { timeout: 120_000 });
    await idle(page, 2500);
    let ps = await panels(page);
    const mat = () => ps.find(p => p.hap === 'MAT' && !p.link);
    const pat = () => ps.find(p => p.hap === 'PAT' && !p.link);
    const native = () => ps.find(p => p.label === NATIVE);
    const readCanvas = p => page.locator(`[data-read-track-state-key="${p.stateKey}"] canvas[data-copilot-track="reads"]`).first();

    await take('live-lift-split', async () => {
      await shoot(page, 'live-lift-split');
    });

    await take('live-lift-open-menu', async () => {
      await page.getByTestId('open-menu-button').click();
      await page.getByTestId('open-menu-add-live-lift').waitFor({ timeout: 5000 });
      await shoot(page, 'live-lift-open-menu');
      await page.keyboard.press('Escape');
    });

    await take('live-lift-dialog', async () => {
      await page.getByTestId(`panel-actions-${native().id}`).click();
      await page.getByTestId('live-lift-from-bam').click();
      const dialog = page.getByTestId('live-lift-dialog');
      await dialog.waitFor({ timeout: 10_000 });
      await page.getByTestId('live-lift-map-suggestion').first().waitFor({ timeout: 30_000 }).catch(() => {});
      await page.getByTestId('live-lift-open-split').check();
      await sleep(800);
      await shoot(page, 'live-lift-dialog');
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
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

    await take('live-lift-hatching', async () => {
      // A deletion in the sample (reference bases with no counterpart) near the demo locus, from the map.
      const ds = ps.find(p => p.hap === 'MAT').ds;
      const r = await page.evaluate(async ({ ds, chrom, start, end }) => {
        const q = new URLSearchParams({ dataset_id: ds, chrom, start: String(start), end: String(end), lift_hap: 'MAT', min_bp: '200' });
        return (await fetch(`/api/lift/differences?${q}`)).json();
      }, { ds, chrom: AT.chrom, start: AT.start - 400_000, end: AT.end + 400_000 });
      const gaps = (r.differences ?? r.items ?? []).filter(d => ['deletion', 'no_correspondence', 'replacement'].includes(d.kind) && d.ref_bp >= 200)
        .sort((a, b) => b.ref_bp - a.ref_bp);
      if (!gaps.length) throw new Error('no deletion near the demo locus');
      const g = gaps[0];
      const pad = Math.max(1500, g.ref_bp * 2);
      await store(page, `s.getState().setViewport(a.chrom, a.start, a.end)`, { chrom: AT.chrom, start: g.t_start - pad, end: g.t_end + pad });
      await idle(page, 3000);
      await shoot(page, 'live-lift-hatching');
      await store(page, `s.getState().setViewport(a.chrom, a.start, a.end)`, AT);
      await idle(page, 2500);
    });

    // ---------------------------------------------------------------- the Differences row on the split panels
    // The MAT panel's Differences row: its largest insertion (insertion ticks on reads are off by default).
    const matInsertion = () => page.locator(`[data-testid="live-lift-diff-strip"][data-panel-id="${mat().id}"] `
      + '[data-testid="live-lift-diff-item"][data-kind="insertion"]').last();

    await take('differences-expanded', async () => {
      await store(page, `s.setState({ fillReadHeight: false, readRowHeight: 8 })`);
      await idle(page, 1000);
      await matInsertion().waitFor({ timeout: 30_000 });
      await matInsertion().click();
      await page.getByTestId('live-lift-expanded-block').first().waitFor({ timeout: 30_000 });
      await idle(page, 2500);
      await shoot(page, 'differences-expanded');
    });

    await take('differences-inspector', async () => {
      await matInsertion().click({ modifiers: ['ControlOrMeta'] });
      const inspector = page.getByTestId('live-lift-diff-popover');
      await inspector.waitFor({ timeout: 30_000 });
      await inspector.locator('tbody tr').first().waitFor({ timeout: 60_000 }).catch(() => {});
      await inspector.getByRole('button', { name: 'Load molecule calls', exact: true }).click().catch(() => {});
      await page.getByTestId('difference-molecule-counts').waitFor({ timeout: 60_000 }).catch(() => {});
      await sleep(1000);
      await shoot(page, 'differences-inspector');
      await page.keyboard.press('Escape');
      await sleep(300);
      await page.getByTestId('live-lift-expanded-collapse').first().click().catch(() => {});
      await store(page, `s.setState({ fillReadHeight: true })`);
      await idle(page, 1500);
    });

    // A pooled panel shows both haplotype lanes.
    await take('differences-row', async () => {
      await page.getByTestId(`panel-actions-${mat().id}`).click();
      await page.getByTestId('live-lift-pool').click();
      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="live-lift-chip"]')].some(e => /MAT\+PAT/.test(e.textContent)), null, { timeout: 30_000 });
      await idle(page, 2500);
      ps = await panels(page);
      const pooled = ps.find(p => p.label === LIFTED && !p.hap && !p.link) ?? ps.find(p => p.label === LIFTED);
      const strip = page.locator(`[data-testid="live-lift-diff-strip"][data-panel-id="${pooled.id}"]`);
      await strip.waitFor({ timeout: 20_000 });
      await shoot(page, 'differences-row', page.locator(`[data-panel-id="${pooled.id}"]`).first());
    });

    await take('differences-menu', async () => {
      const pooled = (await panels(page)).find(p => p.label === LIFTED && !p.link);
      const item = page.locator(`[data-testid="live-lift-diff-strip"][data-panel-id="${pooled.id}"] [data-testid="live-lift-diff-item"][data-kind="insertion"]`).first();
      await item.click({ button: 'right' });
      await page.getByTestId('track-context-menu').waitFor({ timeout: 5000 });
      await sleep(400);
      await shoot(page, 'differences-menu');
      await page.keyboard.press('Escape');
    });

    await take('differences-table', async () => {
      const pooled = (await panels(page)).find(p => p.label === LIFTED && !p.link);
      const strip = page.locator(`[data-testid="live-lift-diff-strip"][data-panel-id="${pooled.id}"]`);
      await strip.locator('[data-testid="live-lift-diff-header"]').click({ button: 'right' });
      await page.getByTestId('track-context-menu').getByText('Show the table', { exact: false }).click();
      await sleep(1500);
      await shoot(page, 'differences-table', page.locator(`[data-panel-id="${pooled.id}"]`).first());
      await strip.locator('[data-testid="live-lift-diff-header"]').click({ button: 'right' });
      await page.getByTestId('track-context-menu').getByText('Hide the table', { exact: false }).click().catch(() => page.keyboard.press('Escape'));
    });

    // Split again for the linked views.
    await page.reload();
    await page.waitForFunction(() => window.__FIBERBROWSER_STORE__?.getState().panels.some(p => p.contentType === 'dataset'), null, { timeout: 120_000 });
    await idle(page, 2500);
    ps = await panels(page);
    if (!mat()) {
      const pooled = ps.find(p => p.label === LIFTED && !p.link);
      await page.getByTestId(`panel-actions-${pooled.id}`).click();
      await page.getByTestId('live-lift-split').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="live-lift-chip"]').length >= 2, null, { timeout: 30_000 });
      await idle(page, 2000);
      ps = await panels(page);
    }

    // ---------------------------------------------------------------- linked panels
    await take('linked-source-view', async () => {
      // Only the MAT panel and its source view: fold the others away.
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
      for (let y = box.y + 20; y < box.y + box.height - 2 && !both; y += 3) {
        await page.mouse.move(box.x + box.width * 0.55, y);
        await sleep(60);
        both = Number(await m.getAttribute('data-lift-hover-rows')) > 0 && Number(await sc.getAttribute('data-lift-hover-rows')) > 0;
      }
      if (!both) throw new Error('no molecule drawn in both panels');
      await sleep(400);
      await page.evaluate(() => document.querySelectorAll('[role="tooltip"], [data-testid$="tooltip"]').forEach(e => { e.style.display = 'none'; }));
      await redact(page, opts.workDir);
      await page.screenshot({ path: path.join(stage, 'linked-hover.png') });   // keeps the pointer where it is
      await page.mouse.move(2, 2);
      await store(page, `s.setState({ fillReadHeight: true })`);
    });
    await page.close();

    // ---------------------------------------------------------------- structural variants on the native panel
    const sv = await openPage(browser, opts.baseUrl, { lifted: 'split' });
    let sps = await panels(sv);
    for (const p of sps.filter(p => p.label !== NATIVE)) await store(sv, `s.getState().removePanel(a)`, p.id);
    await idle(sv, 2500);
    sps = await panels(sv);
    const nat = sps.find(p => p.label === NATIVE);
    const svTrack = sv.locator(`[data-panel-id="${nat.id}"] canvas[data-testid="sv-track-canvas-${nat.ds}"]`).first();
    /** The x of the strongest insertion on the native row, from the SV summary the row drew. */
    const insertionX = async () => {
      const box = await svTrack.boundingBox();
      const reads = sv.locator(`[data-panel-id="${nat.id}"] canvas[data-copilot-track="reads"]`).first();
      const sidebar = Number(await reads.getAttribute('data-track-sidebar')) || 0;
      const at = await store(sv, `const st = s.getState(); return { start: st.start, end: st.end };`);
      // The SV clusters in view, as the Variants panel asks for them (POST /api/variants/svs).
      const pos = await sv.evaluate(async ({ ds, chrom, start, end }) => {
        const r = await fetch('/api/variants/svs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataset_id: ds, chrom, start: Math.floor(start), end: Math.ceil(end), min_len: 50, include_duplicates: false }) });
        if (!r.ok) return null;
        const j = await r.json();
        const ins = (j.clusters ?? []).filter(c => c.t === 'I').sort((a, b) => (b.support ?? 0) - (a.support ?? 0))[0];
        return ins ? ins.ref : null;
      }, { ds: nat.ds, chrom: AT.chrom, start: at.start, end: at.end });
      if (pos == null) throw new Error('no insertion on the native row in view');
      const p = pos;
      return { x: box.x + sidebar + ((p - at.start) / (at.end - at.start)) * (box.width - sidebar), y: box.y + box.height / 2 };
    };

    await take('sv-row-menu', async () => {
      await svTrack.waitFor({ timeout: 30_000 });
      const { x, y } = await insertionX();
      await sv.mouse.click(x, y, { button: 'right' });
      await sv.getByTestId('track-context-menu').waitFor({ timeout: 5000 });
      await sleep(500);
      await shoot(sv, 'sv-row-menu');
      await sv.keyboard.press('Escape');
    });

    await take('sv-highlight', async () => {
      await store(sv, `s.setState({ fillReadHeight: false, readRowHeight: 8 })`);
      await idle(sv, 1000);
      const { x, y } = await insertionX();
      await sv.mouse.click(x, y, { button: 'right' });
      await sv.getByTestId('track-context-menu').getByText('Highlight carriers (confirmed + putative)', { exact: true }).click();
      await idle(sv, 2000);
      await shoot(sv, 'sv-highlight');
      await store(sv, `s.setState({ fillReadHeight: true })`);
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
      const { x, y } = await insertionX();
      await sv.mouse.click(x, y, { button: 'right' });
      await sv.getByTestId('track-context-menu').getByText('Open this insertion in the lens', { exact: true }).click();
      await sv.locator('[data-panel-content-type="insertion-lens"], [data-panel-content-type*="insertion"]').first().waitFor({ timeout: 30_000 });
      await idle(sv, 4000);
      await shoot(sv, 'differences-lens');
    });

    await take('sv-settings', async () => {
      await openSettings(sv, 'view');
      const details = sv.locator('details:has(> summary:text-is("Advanced carrier evidence"))').first();
      await details.scrollIntoViewIfNeeded();
      await details.evaluate(d => { d.open = true; });
      await sleep(600);
      await shoot(sv, 'sv-settings');
      await sv.keyboard.press('Escape');
    });

    await take('setup-preview-features', async () => {
      await openSettings(sv, 'view');
      const el = sv.getByTestId('preview-features-setting');
      await el.scrollIntoViewIfNeeded();
      await sleep(600);
      await shoot(sv, 'setup-preview-features');
      await sv.keyboard.press('Escape');
    });

    await take('setup-graph-register', async () => {
      // The standalone Graph view panel (a preview feature), its registration form open.
      const tile = sv.locator('[data-testid="panel-rail"], [data-testid="analysis-strip"]').getByRole('button', { name: /^Graph view/ }).first();
      await tile.click();
      const panel = sv.locator('[data-panel-content-type="graph-view"]').first();
      await panel.waitFor({ timeout: 30_000 });
      await idle(sv, 3000);
      const form = panel.getByTestId('graph-panel-register');
      if (!(await form.count())) {
        await panel.getByTestId('graph-panel').click({ button: 'right', position: { x: 200, y: 120 } });
        await sv.getByText('Register a graph package…', { exact: true }).click();
      }
      await panel.getByTestId('graph-panel-register').waitFor({ timeout: 10_000 });
      await sleep(500);
      await shoot(sv, 'setup-graph-register');
      await sv.keyboard.press('Escape');
    });
    await sv.close();

    // ---------------------------------------------------------------- graph mode: the cluster screenshot
    await take('graph-mode-cluster', async () => {
      const g = await openPage(browser, opts.baseUrl, { lifted: 'graph' });
      await g.waitForFunction(() => document.querySelectorAll('[data-testid="graph-host-body"] [data-testid="graph-panel"]').length >= 1, null, { timeout: 180_000 });
      let gps = await panels(g);
      const host = gps.find(p => p.mode === 'graph');
      const nativeP = gps.find(p => p.label === NATIVE);
      // The native panel joins the graph, so the run covers several panels.
      await g.getByTestId(`panel-actions-${host.id}`).click();
      await g.locator(`[data-testid="graph-add-panel"][data-member="${nativeP.id}"]`).first().click();
      await g.waitForFunction(id => window.__FIBERBROWSER_STORE__.getState().panels.find(p => p.id === id)?.collapsedByGraphGroup, nativeP.id, { timeout: 30_000 });
      await idle(g, 2500);
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
      await idle(g, 3000);
      await shoot(g, 'graph-mode-cluster');
      await g.close();
    });
  } finally {
    await browser.close();
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

/** Open Settings on one of its sections ('view': Reads & Display). */
async function openSettings(page, section) {
  const rail = page.getByTestId(`settings-rail-${section}`);
  if (!(await rail.count())) {
    const toggle = page.getByTestId('settings-toggle');
    if (await toggle.count()) await toggle.first().click();
    else await page.getByRole('button', { name: /^Settings/ }).first().click();
  }
  await rail.first().click();
  await sleep(800);
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
