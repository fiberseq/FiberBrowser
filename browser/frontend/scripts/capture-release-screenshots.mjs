/**
 * Release-doc additions to capture-pangenome-screenshots.mjs. Run through that script:
 *   node scripts/capture-pangenome-screenshots.mjs --base-url "$DEMO_URL" --only release-docs
 * Uses only the neutral unified_demo.py AluY datasets. No server is started here.
 * Biological results are real; only the software-update API is mocked. Shared shoot() applies redaction.
 */
export const RELEASE_OUTPUTS = {
  'assoc-builder': 'feature-hub/assoc-builder.png',
  'overlay-profile': 'feature-hub/overlay-profile.png',
  'hub-paging': 'feature-hub/hub-paging.png',
  'panel-window': 'nucleosome/panel-window.png',
  'update-prompt': 'updates/update-prompt.png',
  'whats-new-graph-hero': 'whats-new/graph-hero.png',
  'whats-new-hub-hero': 'whats-new/hub-hero.png',
};
export const RELEASE_SHOTS = [...Object.keys(RELEASE_OUTPUTS), 'graph-mode-site-sort'];

async function graphReady(page) {
  await page.waitForFunction(() => {
    const graph = document.querySelector('[data-testid="graph-host-body"] [data-testid="graph-panel"]');
    return Number(graph?.getAttribute('data-graph-reads') || 0) > 20
      && graph?.getAttribute('data-graph-loading') === 'false'
      && graph?.getAttribute('data-graph-reads-loading') === 'false';
  }, null, { timeout: 180_000 });
}

export async function captureReleaseDocs({ newPage, take, shoot, want, store, idle, nativeLabel }) {
  if (want('whats-new-graph-hero') || want('graph-mode-site-sort')) {
    const graph = await newPage('graph');
    try {
      await take('whats-new-graph-hero', async () => {
        await graphReady(graph);
        await idle(graph);
        await shoot(graph, 'whats-new-graph-hero');
      });
      await take('graph-mode-site-sort', async () => {
        await graphReady(graph);
        // Find a measured site on an actual read. Canvas row positions depend on the graph layout and budgets.
        const canvas = graph.locator('[data-testid="graph-host-body"] [data-testid="graph-panel-canvas"]').first();
        await canvas.scrollIntoViewIfNeeded();
        const box = await canvas.boundingBox();
        if (!box) throw new Error('Graph canvas has no bounds');
        let found = false;
        const viewport = graph.viewportSize();
        for (const fraction of [0.6, 0.4, 0.8, 0.25]) {
          if (found) break;
          for (let y = box.y + 70; y < Math.min(box.y + box.height - 5, viewport.height - 10); y += 12) {
            await graph.mouse.click(box.x + box.width * fraction, y, { button: 'right' });
            const site = graph.locator('[data-testid="graph-panel-menu"] [data-submenu="site-sort"]');
            if (await site.isVisible()) { await site.click(); found = true; break; }
            await graph.keyboard.press('Escape');
          }
        }
        if (!found) throw new Error('No read with a measured graph column found');
        await graph.getByRole('menuitem', { name: 'Footprint size at site', exact: true }).waitFor();
        await shoot(graph, 'graph-mode-site-sort');
        await graph.keyboard.press('Escape');
      });
    } finally { await graph.close(); }
  }

  const hubShots = ['assoc-builder', 'overlay-profile', 'hub-paging', 'panel-window', 'whats-new-hub-hero'];
  if (hubShots.some(want)) {
    const page = await newPage('graph');
    await page.setViewportSize({ width: 1600, height: 1000 });
    let scanned;
    const ensureScan = () => scanned ??= (async () => {
      await store(page, `s.getState().openAnalysisPanel('feature-hub')`);
      await page.getByTestId('hub-scan').click();
      const dialog = page.getByTestId('hub-scan-dialog');
      await dialog.waitFor();
      // A source-frame scan is a separate workflow. Use the native demo file for these regional examples.
      const datasets = await store(page, `return s.getState().datasets.map(d => ({id: d.id, label: d.label}));`);
      const native = datasets.find(d => d.label === nativeLabel);
      if (!native) throw new Error('The unified demo native dataset is missing');
      for (const d of datasets) {
        const checkbox = page.getByTestId(`hub-scan-dataset-${d.id}`);
        if (await checkbox.count()) await checkbox.setChecked(d.id === native.id);
      }
      for (const module of ['fp', 'nfr', 'nuc', 'peaks']) await page.getByTestId(`hub-scan-module-${module}`).check();
      await dialog.locator('summary').click();
      await page.getByTestId('hub-scan-params').fill('{"nfr":{"nfr":{"bootstrap":0,"kmax":3,"splits":2}}}');
      await page.getByTestId('hub-scan-workers').fill('4');
      await page.getByTestId('hub-scan-submit').waitFor();
      await page.waitForFunction(() => !document.querySelector('[data-testid="hub-scan-submit"]')?.disabled, null, { timeout: 60_000 });
      await page.getByTestId('hub-scan-submit').click();
      await page.getByTestId('hub-job').waitFor({ timeout: 30_000 });
      await page.waitForFunction(() => ['complete', 'error', 'cancelled'].includes(document.querySelector('[data-testid="hub-job"]')?.getAttribute('data-state')),
        null, { timeout: 600_000 });
      if (await page.getByTestId('hub-job').getAttribute('data-state') !== 'complete') throw new Error('Demo scan did not complete');
      await page.getByTestId('hub-row').first().waitFor({ timeout: 60_000 });
    })();
    const hits = async () => {
      await ensureScan();
      await store(page, `s.getState().setFeatureHub(h => ({ui: {...h.ui, tab: undefined, scope: {kind: 'view'}, offset: 0, pageSize: 500, typeFilter: ''}}));`);
      await page.getByTestId('hub-table').waitFor();
      await idle(page);
    };
    let computed;
    const ensureNuc = () => computed ??= (async () => {
      await ensureScan();
      await store(page, `s.getState().openAnalysisPanel('nucleosomes')`);
      await page.getByTestId('nuc-compute').click();
      await page.waitForFunction(() => ['complete', 'error', 'cancelled'].includes(document.querySelector('[data-testid="nuc-job"]')?.getAttribute('data-state')),
        null, { timeout: 600_000 });
      if (await page.getByTestId('nuc-job').getAttribute('data-state') !== 'complete') throw new Error('Demo nucleosome compute did not complete');
      // Give the hub the drawer again; keep the real outputs and remove only the extra panel.
      await store(page, `for (const p of s.getState().panels.filter(p => p.contentType === 'nucleosomes')) s.getState().removePanel(p.id);`);
      await store(page, `s.getState().openAnalysisPanel('feature-hub')`);
    })();
    try {
      await take('hub-paging', async () => {
        await hits();
        await page.getByLabel('Hub scope', { exact: true }).selectOption('genome');
        await page.getByLabel('Page size', { exact: true }).selectOption('50');
        await idle(page);
        await page.getByTestId('hub-row').first().click();
        await page.getByRole('button', { name: 'Next page', exact: true }).click({ timeout: 30_000 });
        await page.waitForFunction(() => document.querySelector('[data-testid="hub-paging"]')?.textContent.includes('51–'), null, { timeout: 60_000 });
        await page.getByTestId('hub-selected-count').waitFor();
        await shoot(page, 'hub-paging');
      });
      await take('assoc-builder', async () => {
        await hits();
        await page.locator('button[data-analysis-tab="assoc"]').first().click();
        await page.getByTestId('assoc-preset-q1').click();
        await page.getByTestId('assoc-builder').waitFor();
        await shoot(page, 'assoc-builder');
      });
      // Both overlay shots share one genuine result. Selection comes from NFR scan hits, never fabricated rows.
      let overlaid;
      const ensureOverlay = () => overlaid ??= (async () => {
        await ensureNuc();
        await hits();
        await page.getByTestId('hub-type-filter').selectOption('nfr.region');
        await idle(page);
        await page.locator('[data-testid="hub-row"][data-type="nfr.region"]').first().waitFor();
        await page.getByTestId('hub-select-shown').click();
        await page.getByTestId('hub-overlay').click();
        await page.getByTestId('overlay-layer').selectOption('regular');
        await page.getByTestId('overlay-align').selectOption('anchor');
        await page.getByTestId('overlay-run').click();
        await page.getByTestId('overlay-result').waitFor({ timeout: 180_000 });
        const valid = await store(page, `return s.getState().featureHub.overlay.result?.series.some(x => !x.error && x.den.some(v => v > 0));`);
        if (!valid) throw new Error('Overlay has no measured molecules');
        await idle(page);
      })();
      await take('overlay-profile', async () => { await ensureOverlay(); await shoot(page, 'overlay-profile'); });
      await take('whats-new-hub-hero', async () => { await ensureOverlay(); await shoot(page, 'whats-new-hub-hero'); });
      await take('panel-window', async () => {
        await ensureNuc();
        await hits();
        await page.getByTestId('hub-type-filter').selectOption('nfr.region');
        await idle(page);
        await page.locator('[data-testid="hub-row"][data-type="nfr.region"]').first().waitFor();
        await page.getByTestId('hub-select-shown').click();
        await page.getByTestId('hub-use-nuc-window').click();
        await page.getByTestId('nuc-mode-window').waitFor();
        await store(page, `for (const p of s.getState().panels.filter(p => p.contentType === 'feature-hub')) s.getState().removePanel(p.id);`);
        await page.getByTestId('nuc-background').selectOption('hub');
        await page.getByTestId('nuc-phasing-anchor').first().waitFor({ timeout: 180_000 });
        await idle(page);
        await shoot(page, 'panel-window');
      });
    } finally { await page.close(); }
  }

  if (want('update-prompt')) {
    const page = await newPage('graph', async p => {
      // Intercept the whole update API before navigation, including startup checks. Never install or quit.
      await p.route('**/api/app/update**', async route => {
        const url = new URL(route.request().url());
        if (route.request().method() !== 'GET') return route.fulfill({ status: 409, json: { detail: 'Screenshot only: update actions are disabled.' } });
        if (url.pathname === '/api/app/update/download') return route.fulfill({ json: { state: 'idle' } });
        if (url.pathname !== '/api/app/update') return route.fulfill({ status: 404, json: {} });
        return route.fulfill({ json: {
          status: 'update_available', current: '3.0.1', build: 'demo', latest: '3.1.0', latest_build: 'demo',
          channel: 'public', packaged: true, platform: 'macos-arm64', where: 'Simulated update for documentation',
          private: false, message: 'Demo offer. No update will be installed.',
          notes: 'Live lift and graph mode. Feature hub and nucleosome analysis. Session and navigation fixes.',
          installable: true,
          download: { name: 'FiberBrowser-demo-arm64.dmg', kind: 'dmg', size: 190000000, sha256: '0'.repeat(64) },
          install_download: { name: 'FiberBrowser-demo-arm64.zip', kind: 'zip', size: 185000000, sha256: '0'.repeat(64) },
        } });
      });
      await p.route('**/api/quit', route => route.fulfill({ status: 409, json: { detail: 'Screenshot only.' } }));
    });
    try {
      await take('update-prompt', async () => {
        await page.getByTestId('command-palette-button').click();
        await page.getByTestId('command-palette-input').fill('Check for updates');
        await page.getByRole('option').filter({ hasText: 'Check for updates…' }).first().click();
        await page.getByTestId('app-update-install').waitFor({ timeout: 30_000 });
        await shoot(page, 'update-prompt');
      });
    } finally { await page.close(); }
  }
}
