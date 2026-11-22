// Shared by the packaged-app smoke drivers (tests/app_smoke/test_packaged_app_ui.py runs them with node).
// Each driver gets one JSON argument ({ base, outdir, ... }), writes <outdir>/result.json and exits non-zero on a throw.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const modules = process.env.FIBERBROWSER_APP_SMOKE_NODE_MODULES || path.resolve(here, '../../../browser/frontend/node_modules');
export const pw = createRequire(path.join(modules, 'resolve.js'))('playwright');
export const args = JSON.parse(process.argv[2] || '{}');
export const outFile = name => path.join(args.outdir, name);

export async function main(fn) {
  const out = {};
  let code = 0;
  try { await fn(out); } catch (e) { out.error = String((e && e.stack) || e); code = 1; }
  writeFileSync(outFile('result.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out).slice(0, 4000));
  process.exit(code);
}

/** A page on the app with the store exposed, the hg38 autoload off and no native dialog ever (every picker cancels;
 *  starting an install or a download of an update is refused and counted). */
export async function openContext(browser, { viewport = { width: 1600, height: 1000 }, clear = true, extraInit, contextOptions = {} } = {}) {
  const context = await browser.newContext({ viewport, ...contextOptions });
  context.blocked = [];
  await context.route(/\/api\/pick_[a-z_]*(?:\?|$)/, r => r.fulfill({ json: { success: false, cancelled: true, path: null, paths: [] } }));
  await context.route(/\/api\/app\/(?:fiberhmm\/install|update\/download|update\/install)(?:\?|$)/, r => {
    if (r.request().method() === 'GET') return r.continue();  // progress polls only
    context.blocked.push(`${r.request().method()} ${new URL(r.request().url()).pathname}`);
    return r.fulfill({ status: 403, json: { detail: 'refused by the app smoke' } });
  });
  await context.addInitScript(([doClear]) => {
    window.__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    window.__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    if (doClear) { try { localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('fiberhmm_welcome_dismissed', '1'); } catch {} }
  }, [clear]);
  if (extraInit) await context.addInitScript(extraInit);
  return context;
}

export function watchErrors(page) {
  const errors = { page: [], console: [] };
  page.on('pageerror', e => errors.page.push(String(e).slice(0, 400)));
  page.on('console', m => { if (m.type() === 'error') errors.console.push(m.text().slice(0, 400)); });
  return errors;
}

/** Run a function of the store state in the page: st(page, s => s.datasets.length). */
export const st = (page, fn, arg) => page.evaluate(({ f, a }) => new Function('s', 'a', `return (${f})(s, a)`)(window.__FIBERBROWSER_STORE__.getState(), a), { f: fn.toString(), a: arg });

export async function poll(page, fn, ok, ms = 30000) {
  const t0 = Date.now(); let v;
  while (Date.now() - t0 < ms) { v = await fn().catch(() => undefined); if (ok(v)) return v; await page.waitForTimeout(300); }
  return v;
}

export async function waitDatasets(page, ms = 60000) {
  await page.waitForFunction(() => !!window.__FIBERBROWSER_STORE__?.getState().datasets.length, null, { timeout: ms });
}

export async function waitReadTracks(page, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms && (await page.locator('[data-read-track-loading="true"]').count()) > 0) await page.waitForTimeout(500);
}

export const panelButton = (page, id) => page.locator(`[data-testid="panel-rail-${id}"], [data-testid="analysis-strip-button-${id}"]`).first();

export async function openLayerColours(page) {
  const panel = page.locator('[data-panel-content-type="colormap"]');
  if (!(await panel.isVisible().catch(() => false))) await panelButton(page, 'colormap').click();
  await panel.waitFor({ state: 'visible', timeout: 15000 });
  const details = panel.getByTestId('layer-colours-details');
  if (!(await details.evaluate(el => el.open))) await details.locator('summary').click();
  await panel.getByTestId('layer-colours-section').waitFor({ state: 'visible' });
  return panel;
}
