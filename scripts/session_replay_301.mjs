#!/usr/bin/env node
/** Replay a new-build export in an already running release; never starts a server. */
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

// Dependencies live in browser/frontend, even when this script runs from the repo root.
const require = createRequire(new URL('../browser/frontend/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');

const usage = 'node scripts/session_replay_301.mjs --base-url URL --session FILE [--expect-panels kind,kind] [--out screenshot.png]';

async function panelsOnPage(page) {
  return page.evaluate(() => {
    const analysis = [...document.querySelectorAll('[data-analysis-panel-id]')].map(el => ({
      id: el.getAttribute('data-analysis-panel-id'),
      kind: el.getAttribute('data-panel-content-type'),
      title: el.querySelector('[data-panel-header] .font-semibold')?.textContent?.trim() ?? '',
    }));
    const datasets = [...document.querySelectorAll('[data-testid^="dataset-header-"]')].map(header => ({
      id: header.closest('[data-panel-id]')?.getAttribute('data-panel-id'),
      kind: 'dataset',
      title: header.querySelector('[data-testid="panel-header-name"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    }));
    return [...datasets, ...analysis];
  });
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    'base-url': { type: 'string' }, session: { type: 'string' },
    'expect-panels': { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(usage); return; }
  if (!values['base-url'] || !values.session) throw new Error(usage);
  const baseUrl = new URL(values['base-url']);
  if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error('--base-url must be HTTP or HTTPS');
  const sessionFile = path.resolve(values.session);
  const session = JSON.parse(await readFile(sessionFile, 'utf8'));
  if (!session.viewport || !Array.isArray(session.frontend?.panels)) throw new Error('Expected a saved session with viewport and frontend.panels');
  const expected = values['expect-panels']?.split(',').map(kind => kind.trim()).filter(Boolean);
  const out = path.resolve(values.out ?? `test-results/session-replay-301/${path.basename(sessionFile, '.json')}.png`);
  await mkdir(path.dirname(out), { recursive: true });
  const executablePath = process.env.FIBERBROWSER_PLAYWRIGHT_EXECUTABLE?.trim();
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  let report;
  let failure;
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    context.setDefaultTimeout(60_000);
    // Block every other picker too, including ones a failure/relink flow might offer.
    await context.route(/\/api\/pick_(?:file|folder|file_primer)(?:\?|$)/, route => route.fulfill({
      json: { success: false, cancelled: true, path: null, paths: [] },
    }));
    await context.addInitScript(() => {
      window.__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
      localStorage.setItem('fiberbrowser_show_preview_features', 'true');
      sessionStorage.setItem('fiberhmm_welcome_dismissed', '1');
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    let pickerCalls = 0;
    await page.route(/\/api\/pick_file(?:\?|$)/, route => {
      pickerCalls++;
      return route.fulfill({ json: { success: true, path: sessionFile, paths: [sessionFile] } });
    });
    let importResult;
    try {
      await page.goto(baseUrl.href);
      await page.waitForLoadState('networkidle');
      const [response] = await Promise.all([
        page.waitForResponse(r => new URL(r.url()).pathname === '/api/session/import' && r.request().method() === 'POST'),
        page.getByTestId('load-file-button').click(),
      ]);
      importResult = await response.json();
      if (!response.ok() || !importResult.success) throw new Error('Session import failed');
      await expect(page.getByTestId('load-file-button')).toBeEnabled({ timeout: 60_000 });
      await expect(page.locator('[data-read-track-loading="true"]')).toHaveCount(0, { timeout: 60_000 });
      // DOM only: the released build need not expose an internal test store.
      await expect.poll(async () => (await panelsOnPage(page)).length, { timeout: 60_000 }).toBe(session.frontend.panels.filter(p => !p.collapsed).length);
      if (expected) {
        await expect.poll(async () => (await panelsOnPage(page)).map(p => p.kind).sort(), { timeout: 15_000 }).toEqual([...expected].sort());
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    // Report and screenshot on assertion/import failure as well as success.
    const panels = await panelsOnPage(page);
    const errorBanners = await page.getByRole('button', { name: 'Dismiss error', exact: true }).evaluateAll(buttons =>
      buttons.map(button => button.parentElement?.textContent?.replace(/\s+/g, ' ').trim() ?? ''));
    await page.screenshot({ path: out, fullPage: true });
    report = { panelKinds: panels.map(p => p.kind), panels, errorBanners, pageErrors, pickerCalls, screenshot: out,
      ...(failure ? { failure } : {}),
      ...(importResult ? { importSuccess: importResult.success, importResults: importResult.results ?? {} } : {}),
    };
    const results = importResult?.results ?? {};
    if (failure || pickerCalls !== 1 || errorBanners.length || pageErrors.length
      || results.datasets_failed?.length || results.overlays_failed?.length || results.annotations_failed?.length
      || results.fasta_error || results.contact_map_error) process.exitCode = 1;
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
