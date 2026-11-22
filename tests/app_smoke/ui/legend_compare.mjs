// part "legend": k-means clusters with one extra layer on -> every Overview card has the same legend and plot geometry;
//   a cluster without that layer keeps the full legend with a hollow "missing" entry; a user layer colour (Labels ->
//   Layer colours) reaches every card's swatch.
// part "compare": Plots metaprofile -> Compare needs two groups (disabled with a reason for one) -> by cluster, A − B,
//   Summary on: one value with its interval and a chart; Size enrichment while comparing: Summary off with the reason.
// args: { base, outdir, region: {chrom,start,end}, part, colour }
import { pw, args, main, outFile, openContext, watchErrors, st, waitDatasets, waitReadTracks, panelButton, openLayerColours } from './common.mjs';

const pick = (args.colour || '#ffd400').toLowerCase();

async function open(browser) {
  const page = await (await openContext(browser)).newPage();
  page.errors = watchErrors(page);
  await page.goto(args.base); await page.waitForLoadState('networkidle');
  await waitDatasets(page);
  await page.evaluate(r => window.__FIBERBROWSER_STORE__.getState().setViewport(r.chrom, r.start, r.end), args.region);
  await waitReadTracks(page);
  await page.waitForTimeout(2000);
  return page;
}
async function waitPeaks(page, n) {
  await page.evaluate(n => { if (window.__FIBERBROWSER_STORE__.getState().getAllPeaks().length < n) window.fiberbrowserCommand?.('scan-peaks'); }, n);
  const t0 = Date.now();
  while (Date.now() - t0 < 60000 && (await st(page, s => s.getAllPeaks().length)) < n) await page.waitForTimeout(500);
  return st(page, s => s.getAllPeaks().length);
}
async function runCluster(page) {
  const done = page.waitForResponse(r => r.url().includes('/api/cluster_all') && r.ok(), { timeout: 90000 });
  await page.getByTestId('cluster-run-button').click(); await done;
  const t0 = Date.now();
  while (Date.now() - t0 < 90000 && (await st(page, s => Object.values(s.clusterAssignments).reduce((n, a) => n + Object.keys(a || {}).length, 0))) < 10) await page.waitForTimeout(500);
  await page.waitForTimeout(1500);
}
const swatches = cards => cards.evaluateAll(els => els.map(el => {
  const wrap = el.querySelector('[data-plot-left]'); if (!wrap) return null;
  const canvas = wrap.querySelector('canvas'); const ctx = canvas.getContext('2d');
  const scale = canvas.width / canvas.getBoundingClientRect().width;
  return [...wrap.querySelectorAll('[data-testid="plot-legend-item"], [data-testid="plot-legend-missing"]')].map(sp => {
    const x = Math.round((parseFloat(sp.style.left) + 4) * scale), y = Math.round((parseFloat(sp.style.top) + parseFloat(sp.style.height) / 2) * scale);
    return { label: sp.getAttribute('title'), missing: sp.dataset.testid === 'plot-legend-missing', rgb: Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3)) };
  });
}));
const waitAttr = async (page, loc, attr, pred, ms = 120000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = await loc.getAttribute(attr).catch(() => null); if (pred(v)) return v; await page.waitForTimeout(500); }
  return loc.getAttribute(attr).catch(() => null);
};

async function legend(browser, r) {
  const page = await open(browser);
  const candidates = await st(page, s => (s.compositeTracks.find(c => c.id === '__default_metaprofile__')?.sources ?? []).filter(x => !x.visible).map(x => x.ref.ruleId));
  const layer = ['fire', 'm6a', 'deam'].find(k => candidates.includes(k));
  r.layer = layer; r.candidates = candidates;
  if (!layer) throw new Error(`no extra layer to turn on (hidden metaprofile sources: ${candidates})`);
  await page.getByTestId(`layer-checkbox-${layer}`).setChecked(true);
  r.peaks = await waitPeaks(page, 2);
  await page.evaluate(() => { const s = window.__FIBERBROWSER_STORE__.getState(); s.replacePeakSelection([0, 1]); s.setClusterMethod('kmeans'); });
  await runCluster(page);
  await panelButton(page, 'cluster-detail').click();
  const panel = page.locator('[data-panel-content-type="cluster-detail"]');
  await panel.locator('[data-analysis-tab="overview"]').click();
  const cards = panel.getByTestId('cluster-overview-profile');
  const t0 = Date.now(); while (Date.now() - t0 < 30000 && (await cards.count()) < 2) await page.waitForTimeout(500);
  await page.waitForTimeout(1000);
  const geometry = () => cards.evaluateAll(els => els.map(el => { const c = el.querySelector('[data-plot-left]'); const b = el.querySelector('canvas').getBoundingClientRect();
    return c ? { cluster: el.dataset.cluster, legend: c.dataset.legend, left: c.dataset.plotLeft, width: c.dataset.plotWidth, canvas: `${Math.round(b.left)}:${Math.round(b.width)}` } : null; }));
  r.natural = await geometry();
  // As tests/e2e/cluster-charts.spec.ts: one cluster loses the layer.
  r.dropped = await page.evaluate(key => {
    const store = window.__FIBERBROWSER_STORE__; const profiles = store.getState().clusterProfiles; const next = {}; let target = null;
    for (const [sk, byCluster] of Object.entries(profiles)) {
      const ids = Object.keys(byCluster).map(Number).filter(c => (byCluster[c]?.[key]?.length ?? 0) > 0).sort((a, b) => a - b);
      if (target == null) target = ids[0] ?? null;
      next[sk] = Object.fromEntries(Object.entries(byCluster).map(([c, ch]) => { if (Number(c) !== target) return [c, ch]; const rest = { ...ch }; delete rest[key]; return [c, rest]; }));
    }
    store.setState({ clusterProfiles: next }); return target;
  }, layer);
  await page.waitForTimeout(1200);
  r.with_missing = await geometry();
  r.missing_items = await panel.locator(`[data-testid="cluster-overview-profile"][data-cluster="${r.dropped}"] [data-testid="plot-legend-missing"]`).evaluateAll(e => e.map(x => x.getAttribute('title')));
  r.swatches_before = await swatches(cards);
  await panel.screenshot({ path: outFile('overview_cards.png') });
  const labels = await openLayerColours(page);
  await labels.getByTestId(`layer-colour-input-${layer}`).fill(pick);
  await page.waitForTimeout(1500);
  if (!(await panel.isVisible().catch(() => false))) { await panelButton(page, 'cluster-detail').click(); await panel.locator('[data-analysis-tab="overview"]').click(); await page.waitForTimeout(1200); }
  r.swatches_after = await swatches(cards);
  r.after_colour_geometry = await geometry();
  await panel.screenshot({ path: outFile('overview_cards_user_colour.png') });
  r.page_errors = page.errors.page;
}

async function compare(browser, r) {
  const page = await open(browser);
  r.peaks = await waitPeaks(page, 3);
  await page.evaluate(() => {
    const s = window.__FIBERBROWSER_STORE__; const peaks = s.getState().getAllPeaks();
    s.setState({ clusterMethod: 'binary', clusterK: 2, clusterPeakMode: 'accessibility', clusterPreparationCount: null });
    s.getState().replacePeakSelection([(peaks.find(p => p.layer === 1) ?? peaks[0]).index]);
  });
  await runCluster(page);
  await page.keyboard.press('p');
  const ws = page.getByTestId('plots-workspace'); await ws.waitFor({ state: 'visible', timeout: 15000 });
  await ws.getByTestId('plots-type-metaprofile').click();
  const plot = ws.getByTestId('plots-profile-plot');
  await waitAttr(page, plot, 'data-state', v => v === 'current');
  r.one_group = { groups: await plot.getAttribute('data-groups'), diff_disabled: await ws.getByTestId('plots-compare-diff').isDisabled(),
    diff_title: await ws.getByTestId('plots-compare-diff').getAttribute('title'), hint: (await ws.getByTestId('plots-compare').textContent()).slice(0, 160) };
  await page.screenshot({ path: outFile('compare_one_group.png') });
  await ws.getByTestId('plots-group-cluster').click();
  await waitAttr(page, plot, 'data-state', v => v === 'current');
  await waitAttr(page, plot, 'data-groups', v => Number(v) >= 2, 60000);
  r.two_groups = await plot.getAttribute('data-groups');
  r.diff_enabled = await ws.getByTestId('plots-compare-diff').isEnabled();
  await ws.getByTestId('plots-compare-diff').click();
  await waitAttr(page, plot, 'data-comparing', v => !!v, 60000);
  await ws.getByTestId('plots-compare-mode').selectOption('a-vs-b');
  r.comparing = await waitAttr(page, plot, 'data-comparing', v => v === 'a-vs-b', 30000);
  await ws.getByTestId('plots-summary-on').check();
  const summary = ws.getByTestId('plots-summary');
  await summary.waitFor({ state: 'visible', timeout: 60000 });
  await waitAttr(page, summary, 'data-intervals', v => { try { return JSON.parse(v || '[]').length === 1 && JSON.parse(v)[0]; } catch { return false; } }, 60000);
  r.summary = { groups: await summary.getAttribute('data-groups'), values: await summary.getAttribute('data-values'), intervals: await summary.getAttribute('data-intervals'),
    chart_visible: await ws.getByTestId('plots-summary-chart').isVisible() };
  r.state_line = await ws.getByTestId('plots-state-line').textContent();
  await page.screenshot({ path: outFile('compare_summary.png') });
  await ws.getByTestId('plots-type-size-enrichment').click();
  await waitAttr(page, ws.getByTestId('plots-size-plot'), 'data-state', v => v === 'current');
  r.size = { summary_disabled: await ws.getByTestId('plots-summary-on').isDisabled(), blocked: await ws.getByTestId('plots-summary-blocked').textContent().catch(() => null),
    summary_count: await ws.getByTestId('plots-summary').count(), state_line: await ws.getByTestId('plots-state-line').textContent().catch(() => null) };
  await page.screenshot({ path: outFile('compare_size_summary_off.png') });
  r.page_errors = page.errors.page;
}

await main(async out => {
  const browser = await pw.chromium.launch({ headless: true });
  try { await (args.part === 'legend' ? legend : compare)(browser, out); } finally { await browser.close(); }
});
