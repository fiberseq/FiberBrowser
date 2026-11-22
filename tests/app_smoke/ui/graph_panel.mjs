// Graph view (preview) on a configured graph package: the Graph-view analysis panel draws the package's paths at the
// region, without an error. args: { base, outdir, region: {chrom,start,end}, genome?, has_dataset }
import { pw, args, main, outFile, openContext, watchErrors, st } from './common.mjs';

await main(async res => {
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const context = await openContext(browser, { viewport: { width: 1600, height: 1100 },
      extraInit: () => { try { localStorage.setItem('fiberbrowser_show_preview_features', 'true'); } catch {} } });
    const page = await context.newPage();
    const errors = watchErrors(page);
    const { chrom, start, end } = args.region;
    await page.goto(`${args.base}/?chr=${chrom}&start=${start}&end=${end}`);
    await page.waitForFunction(() => !!window.__FIBERBROWSER_STORE__, null, { timeout: 60000 });
    if (args.has_dataset) await page.waitForFunction(() => (window.__FIBERBROWSER_STORE__.getState().datasets.length ?? 0) > 0, null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    if (args.genome) {
      await page.evaluate(g => window.__FIBERBROWSER_STORE__.getState().setCurrentGenome(g), args.genome);
      await page.waitForTimeout(1500);
    }
    await page.evaluate(r => window.__FIBERBROWSER_STORE__.getState().setViewport(r.chrom, r.start, r.end), args.region);
    await page.waitForTimeout(1000);
    res.view = await st(page, s => ({ chrom: s.chrom, start: s.start, end: s.end, genome: s.currentGenome ?? null }));
    const before = await page.getByTestId('graph-panel').count();
    await page.locator('[data-testid="panel-rail-graph-view"], [data-testid="analysis-strip-button-graph-view"]').first().click();
    const graph = page.getByTestId('graph-panel').nth(before);
    await graph.waitFor({ timeout: 30000 });
    await page.waitForFunction(el => el.getAttribute('data-graph-loading') === 'false' && (!!el.getAttribute('data-graph-lanes') || !!el.getAttribute('data-graph-error')),
      await graph.elementHandle(), { timeout: 90000 });
    await page.waitForTimeout(1500);
    res.attrs = await graph.evaluate(el => Object.fromEntries([...el.attributes].filter(a => a.name.startsWith('data-graph')).map(a => [a.name, a.value.slice(0, 300)])));
    res.status_text = await graph.getByTestId('graph-panel-status').innerText().catch(() => null);
    res.scene = await page.evaluate(id => { const e = window.__FIBERBROWSER_GRAPH_SCENES__?.[id]; if (!e) return null;
      const kinds = {}; for (const h of e.scene?.hits ?? []) kinds[h.payload?.kind] = (kinds[h.payload?.kind] ?? 0) + 1;
      return { rows: (e.scene?.rows ?? []).length, hit_kinds: kinds }; }, res.attrs['data-graph-panel-id']);
    await page.screenshot({ path: outFile('graph_panel.png') });
    res.error_banners = { dismiss: await page.getByRole('button', { name: 'Dismiss error', exact: true }).count(), store_error: await st(page, s => s.error ?? null) };
    res.page_errors = errors.page;
  } finally { await browser.close(); }
});
