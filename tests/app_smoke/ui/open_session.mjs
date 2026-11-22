// Open a saved session through the toolbar Open path as soon as the page shows it, while the app's start-up dataset
// list may still be in flight (/api/pick_file answers with the session path: no native dialog). hold_ms > 0 holds the
// first GET /api/datasets response that long, so it lands after the import (the start-up race, forced).
// args: { base, outdir, session, hold_ms }
import { readFileSync } from 'node:fs';
import { pw, args, main, outFile, openContext, watchErrors, st, poll } from './common.mjs';

const file = JSON.parse(readFileSync(args.session, 'utf8'));
await main(async res => {
  res.timeline = []; res.picker_calls = 0; res.genome_requests = [];
  const t0 = Date.now();
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const context = await openContext(browser, { viewport: { width: 1600, height: 1100 } });
    // Registered after openContext's routes, so it wins for /api/pick_file.
    await context.route(/\/api\/pick_file(?:\?|$)/, r => { res.picker_calls++; return r.fulfill({ json: { success: true, path: args.session, paths: [args.session] } }); });
    let held = false;
    if (args.hold_ms) await context.route(/\/api\/datasets(?:\?|$)/, async r => {
      if (r.request().method() !== 'GET' || held) return r.continue();
      held = true; const resp = await r.fetch(); const body = await resp.body();
      await new Promise(f => setTimeout(f, Number(args.hold_ms)));
      res.timeline.push(`${Date.now() - t0}ms start-up GET /api/datasets released after ${args.hold_ms} ms`);
      return r.fulfill({ response: resp, body });
    });
    const page = await context.newPage();
    const errors = watchErrors(page);
    page.on('response', r => { const u = new URL(r.url()); if (['/api/datasets', '/api/session/import'].includes(u.pathname)) res.timeline.push(`${Date.now() - t0}ms ${r.request().method()} ${u.pathname} ${r.status()}`); });
    page.on('request', r => { const u = r.url(); if (/hg38|genome\/download|\.fa(\.gz)?$|ucsc|ensembl/i.test(u) && !u.includes('/assets/')) res.genome_requests.push(`${r.method()} ${u}`); });
    const snapshot = () => st(page, s => ({
      viewport: { chrom: s.chrom, start: s.start, end: s.end },
      datasets: s.datasets.map(d => d.paths ?? (d.path ? [d.path] : null)),
      reads: Object.fromEntries(Object.entries(s.activeReadIds ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.length : (v?.size ?? null)])),
      error: s.error ?? null,
    }));
    await page.goto(args.base);
    await page.getByTestId('load-file-button').waitFor({ timeout: 45000 });
    res.datasets_at_open = await st(page, s => s.datasets.length).catch(() => null);
    const [resp] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === '/api/session/import' && r.request().method() === 'POST', { timeout: 60000 }),
      page.getByTestId('load-file-button').click(),
    ]);
    const imp = await resp.json().catch(() => ({}));
    res.import = { status: resp.status(), success: imp.success, datasets_failed: imp.results?.datasets_failed ?? null, error: imp.error ?? null };
    const want = file.datasets.map(d => d.paths ?? [d.path]);
    res.want_datasets = want;
    await poll(page, () => st(page, s => s.datasets.length), n => n === want.length, 30000);
    await poll(page, () => st(page, s => Object.values(s.activeReadIds ?? {}).filter(v => (Array.isArray(v) ? v.length : (v?.size ?? 0)) > 0).length), n => n >= want.length, 60000);
    await page.locator('[data-read-track-loading="true"]').first().waitFor({ state: 'detached', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const a = await snapshot();
    await page.waitForTimeout(2000);
    res.state = await snapshot();
    res.stable = JSON.stringify({ ...a, reads: 0 }) === JSON.stringify({ ...res.state, reads: 0 });
    res.server_datasets = await page.evaluate(async () => { const j = await (await fetch('/api/datasets')).json(); return (Array.isArray(j) ? j : (j.datasets ?? [])).map(d => d.paths ?? [d.path]); });
    res.error_banners = { dismiss: await page.getByRole('button', { name: 'Dismiss error', exact: true }).count(), crash: await page.getByTestId('crash-recovery-banner').count() };
    await page.screenshot({ path: outFile('session.png') });
    res.page_errors = errors.page; res.console_errors = errors.console;
  } finally { await browser.close(); }
});
