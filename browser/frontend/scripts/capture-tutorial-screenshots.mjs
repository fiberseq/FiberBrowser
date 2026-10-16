#!/usr/bin/env node
/**
 * Walk the guided tour in a real (headless) Chromium and save one screenshot
 * per tour step, plus a few extra views for the illustrated user guide
 * (docs/guide.md). It also audits the tour: every step's title, text, the
 * element it spotlights, and whether that element was found.
 *
 *   cd browser/frontend
 *   node scripts/capture-tutorial-screenshots.mjs              # starts its own server
 *   node scripts/capture-tutorial-screenshots.mjs --base-url http://localhost:8310
 *
 * Options:
 *   --base-url URL      use a running server (started with --no-token) instead of starting one
 *   --port N            port for the server this script starts (default: first free in 8300-8399)
 *   --python PATH       interpreter for browser.py (default: $FIBERBROWSER_TEST_PYTHON or python3)
 *   --out DIR           where the PNGs go (default: <repo>/docs/images/guide)
 *   --audit FILE        also write the step-by-step audit as JSON
 *   --no-extras         only the tour steps
 *   --no-compress       keep the raw 2x PNGs (else downscaled and palette-compressed with Pillow)
 *   --width W           final PNG width in pixels (default 1600)
 *
 * The server it starts runs `browser.py --no-token --copilot off` with
 * FIBERBROWSER_SETTINGS pointing at a missing file, and a scratch runtime file,
 * Library, jobs, uploads and region catalog, so it never reads or changes the
 * user's settings or shows their files. That Python needs FiberHMM
 * 3.x: installed, or a source tree named by FIBERHMM_SOURCE_DIR (PYTHONPATH
 * alone is not enough when an older fiberhmm is installed). Everything runs in
 * the tour's sandbox tab on the bundled demo (browser/data/demo/napa_ddda.bam).
 * Build the frontend first (npm run build): the server serves dist/.
 */
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

function parseArgs(argv) {
  const opts = {
    baseUrl: null, port: null, python: process.env.FIBERBROWSER_TEST_PYTHON || 'python3',
    out: path.join(REPO_ROOT, 'docs', 'images', 'guide'), audit: null,
    extras: true, compress: true, width: 1600,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--base-url') opts.baseUrl = next().replace(/\/$/, '');
    else if (a === '--port') opts.port = Number(next());
    else if (a === '--python') opts.python = next();
    else if (a === '--out') opts.out = path.resolve(next());
    else if (a === '--audit') opts.audit = path.resolve(next());
    else if (a === '--no-extras') opts.extras = false;
    else if (a === '--no-compress') opts.compress = false;
    else if (a === '--width') opts.width = Number(next());
    else if (a === '-h' || a === '--help') {
      console.log('See the header of scripts/capture-tutorial-screenshots.mjs');
      process.exit(0);
    } else throw new Error(`Unknown option ${a}`);
  }
  return opts;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function portFree(port) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

async function startServer(opts) {
  let port = opts.port;
  if (!port) {
    for (let p = 8300; p < 8400; p += 1) if (await portFree(p)) { port = p; break; }
  }
  if (!port) throw new Error('No free port in 8300-8399');
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-capture-'));
  const proc = spawn(opts.python, ['browser.py', '-p', String(port), '--no-token', '--no-open', '--copilot', 'off'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      FIBERBROWSER_NO_OPEN: '1',
      PYTHONUNBUFFERED: '1',
      FIBERBROWSER_SETTINGS: path.join(runtimeDir, 'no_settings.json'),
      FIBERBROWSER_RUNTIME_FILE: path.join(runtimeDir, 'browser_runtime.json'),
      // The user's Library, runs, uploads and saved regions never show up in (or change for) the screenshots.
      FIBERBROWSER_LIBRARY: path.join(runtimeDir, 'library.json'),
      FIBERBROWSER_LIBRARY_NO_STARTUP_SCAN: '1',
      FIBERBROWSER_JOBS_DIR: path.join(runtimeDir, 'jobs'),
      FIBERBROWSER_UPLOAD_DIR: path.join(runtimeDir, 'uploads'),
      FIBERBROWSER_REGION_CATALOG_DIR: path.join(runtimeDir, 'regions'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });
  const baseUrl = `http://localhost:${port}`;
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    try {
      if ((await fetch(`${baseUrl}/api/status`)).ok) return { baseUrl, proc, runtimeDir };
    } catch { /* not up yet */ }
    if (proc.exitCode !== null) break;
    await sleep(300);
  }
  proc.kill('SIGTERM');
  throw new Error(`The server did not start:\n${log.slice(-3000)}`);
}

const slug = s => s.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48);

/** What the running tour shows now: its popover, and the element it rings. */
async function readStep(page) {
  return page.evaluate(() => {
    const pop = Array.from(document.querySelectorAll('.copilot-tutorial-popover'))
      .find(p => !p.classList.contains('copilot-tutorial-waiting'));
    if (!pop) return null;
    const text = sel => pop.querySelector(sel)?.textContent?.trim() ?? '';
    const ring = document.querySelector('.copilot-highlight');
    const describe = el => {
      if (!el) return null;
      const attrs = ['data-testid', 'data-copilot-anchor', 'data-tour', 'data-analysis-tab', 'aria-label', 'title']
        .map(a => (el.getAttribute(a) ? `${a}=${el.getAttribute(a)}` : null)).filter(Boolean);
      return `${el.tagName.toLowerCase()}[${attrs.join(' ')}] "${(el.textContent || '').trim().slice(0, 40)}"`;
    };
    return {
      title: text('.copilot-tutorial-popover-title'),
      body: text('.copilot-tutorial-popover-body'),
      how: text('.copilot-tutorial-popover-how'),
      progress: text('.copilot-tutorial-progress'),
      floating: pop.classList.contains('copilot-tutorial-floating'),
      ring: describe(ring),
      next: text('.copilot-tutorial-next'),
      extra: text('.copilot-tutorial-extra'),
      sandboxNote: /This tour tab is a sandbox/.test(text('.copilot-tutorial-popover-body')),
      errors: Array.from(document.querySelectorAll('[role="alert"]')).map(e => e.textContent.trim()).filter(Boolean).slice(0, 3),
    };
  });
}

async function waitForStep(page, previousProgress, timeoutMs = 8 * 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const working = await page.locator('.copilot-tutorial-working').count();
    const step = working ? null : await readStep(page);
    if (step && step.progress !== previousProgress && step.next) return step;
    await sleep(250);
  }
  return null;
}

/** Wait (a while) for panels to finish loading, so a screenshot doesn't catch "Loading…". */
async function waitForPanels(page, timeoutMs = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const busy = await page.evaluate(() => Array.from(document.querySelectorAll('[data-panel-content-type] *'))
      .some(el => el.children.length === 0 && el.getClientRects().length > 0
        && /^(Loading|Fetching|Analyzing|Analysing|Starting|Computing)\b.*(…|\.\.\.)$/.test((el.textContent || '').trim())));
    if (!busy) return;
    await sleep(300);
  }
}

async function shoot(page, file) {
  await waitForPanels(page);
  await page.screenshot({ path: file, fullPage: false, animations: 'disabled', caret: 'hide' });
}

/** Downscale to `width` and palette-compress (Pillow), in place: ~200 KB a screenshot. */
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
    # Octree keeps the class and layer colours true (median cut shifts them).
    im = im.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    im.save(p, optimize=True)
`;
  const r = spawnSync(python, ['-c', py, dir, String(width)], { stdio: 'inherit' });
  if (r.status !== 0) console.warn('Compression failed (is Pillow installed?); the PNGs stay uncompressed.');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let server = null;
  const baseUrl = opts.baseUrl ?? (server = await startServer(opts)).baseUrl;
  mkdirSync(opts.out, { recursive: true });
  for (const f of readdirSync(opts.out)) if (f.endsWith('.png')) rmSync(path.join(opts.out, f));

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
  // Scripts may reach the page's store (the extras close a panel with it).
  await context.addInitScript(() => { window.__FIBERBROWSER_E2E_EXPOSE_STORE = true; });
  const audit = [];
  const consoleErrors = [];
  try {
    const page = await context.newPage();
    page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });

    // 00: the welcome screen of an empty browser.
    await page.goto(baseUrl);
    await page.waitForSelector('[data-testid="load-file-button"]');
    await sleep(1500);
    await shoot(page, path.join(opts.out, '00_welcome_screen.png'));

    // The tour in its own sandbox tab, as Tour / Take the tour opens it. The
    // main tab stays open (a local server stops once its last tab closes).
    const sandbox = await page.evaluate(async () => (await (await fetch('/api/sandbox', { method: 'POST' })).json()).id);
    if (!sandbox) throw new Error('The server refused a sandbox');
    const tour = await context.newPage();
    tour.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));
    tour.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
    tour.on('response', r => { if (r.status() >= 400) consoleErrors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().slice(0, 200)}`); });
    await tour.goto(`${baseUrl}/?sandbox=${encodeURIComponent(sandbox)}&tour=1`);

    let progress = '';
    let n = 1;
    for (;;) {
      const step = await waitForStep(tour, progress);
      if (!step) { audit.push({ error: `No next step after ${progress || 'the start'}` }); break; }
      progress = step.progress;
      await sleep(900);  // let the panel, spotlight and popover settle
      const file = `${String(n).padStart(2, '0')}_${slug(step.title)}.png`;
      await shoot(tour, path.join(opts.out, file));
      audit.push({ file, ...step });
      console.log(`${step.progress.padEnd(9)} ${step.title}${step.ring ? '' : '  [no spotlight]'}${step.sandboxNote ? '  [sandbox note]' : ''}`);
      n += 1;
      if (step.extra) {
        // The last step: Keep exploring leaves the demo, clusters and panels as they are.
        await tour.locator('.copilot-tutorial-next').click();
        break;
      }
      await tour.locator('.copilot-tutorial-popover:not(.copilot-tutorial-waiting) .copilot-tutorial-next').click();
    }
    if (opts.extras) {
      const { captureExtras, captureStrands } = await import('./capture-tutorial-extras.mjs');
      await captureExtras(tour, { baseUrl, out: opts.out, shoot, audit, sleep, waitForPanels, main: page });
      await captureStrands(browser, { baseUrl, out: opts.out, shoot, audit, sleep });
    }
  } finally {
    await browser.close();
    if (server) {
      server.proc.kill('SIGTERM');
      await sleep(500);
      rmSync(server.runtimeDir, { recursive: true, force: true });
    }
  }
  if (opts.compress) compressAll(opts.out, opts.width, opts.python);
  if (opts.audit) writeFileSync(opts.audit, JSON.stringify({ steps: audit, consoleErrors }, null, 2));
  const pngs = readdirSync(opts.out).filter(f => f.endsWith('.png'));
  console.log(`${pngs.length} screenshots in ${opts.out}`);
  if (consoleErrors.length) console.log(`${consoleErrors.length} console errors (see --audit)`);
}

main().catch(err => { console.error(err); process.exit(1); });
