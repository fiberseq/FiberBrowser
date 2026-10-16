/**
 * Extra views for the user guide (docs/guide.md), taken after the tour ends
 * with "Keep exploring": the tour tab then still has the demo, its clusters,
 * the saved footprint, the footprint-class run and the saved class S1.
 * Used by capture-tutorial-screenshots.mjs; each view is optional (a failure
 * is logged and the next view is taken).
 */
import path from 'node:path';

const FP = '[data-panel-content-type="footprint-analysis"]';

async function settle(page, sleep, ms = 800) {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await sleep(ms);
}

async function tab(page, panel, key) {
  await page.locator(`[data-panel-content-type="${panel}"] [data-analysis-tab="${key}"]`).first().click();
}

async function openPanel(page, label) {
  // The rail's tile (the default) or the classic strip's chip.
  const button = page.locator('[data-testid="panel-rail"], [data-testid="analysis-strip"]').getByRole('button', { name: label, exact: true }).first();
  const already = await page.locator(`[data-panel-content-type] [data-panel-header]`, { hasText: label }).count();
  if (!already) await button.click();
}

/** Close an analysis panel (through the store the page exposes to scripts). */
async function closePanel(page, contentType) {
  await page.evaluate(type => {
    const st = window.__FIBERBROWSER_STORE__?.getState();
    const panel = st?.panels.find(p => p.contentType === type);
    if (panel) st.removePanel(panel.id);
  }, contentType);
}

/** The structural-variant demo's read panel (the Variants section's), its dataset id, and its view. */
async function svPanel(page) {
  return page.evaluate(() => {
    const st = window.__FIBERBROWSER_STORE__?.getState();
    const ds = st?.datasets.find(d => /^H1 insertion demo/.test(d.label ?? ''));
    const panel = ds && st.panels.find(p => p.contentType === 'dataset' && p.datasetId === ds.id && !p.viewportOverride && !p.readSubset);
    return panel ? { panelId: panel.id, datasetId: ds.id, view: { start: st.start, end: st.end } } : null;
  });
}

/**
 * The Variants section's views (x17, x18), while the tour tab still shows the structural-variant demo; then back
 * to the NAPA demo for the rest (the tour's later steps leave the SV demo in view).
 */
async function captureSvExtras(page, { out, shoot, audit, sleep }) {
  const INS = 23_277_272;
  const views = [
    ['x17_sv_row_menu', 'The SV row: right-click an insertion', async () => {
      await closePanel(page, 'variants');
      // The insert-expanded panel stays (the menu is on the reference panel's SV row).
      await sleep(800);
      const sv = await svPanel(page);
      if (!sv) throw new Error('No SV demo panel');
      const track = page.locator(`[data-panel-id="${sv.panelId}"] canvas[data-testid="sv-track-canvas-${sv.datasetId}"]`);
      const reads = page.locator(`[data-panel-id="${sv.panelId}"] canvas[data-copilot-track="reads"]`);
      const box = await track.boundingBox();
      const sidebar = Number(await reads.getAttribute('data-track-sidebar')) || 0;
      const x = box.x + sidebar + ((INS - sv.view.start) / (sv.view.end - sv.view.start)) * (box.width - sidebar);
      await page.mouse.click(x, box.y + box.height / 2, { button: 'right' });
      await page.getByTestId('track-context-menu').waitFor({ timeout: 5000 });
      await sleep(500);
    }],
    ['x18_sv_split_carriers', 'Variants > SVs > Split into panels: carriers and reference reads', async () => {
      await page.keyboard.press('Escape');
      await sleep(300);
      // The tour's insert-expanded panel goes: the split opens the carriers (expanded) beside the reference reads.
      await page.evaluate(() => {
        const st = window.__FIBERBROWSER_STORE__?.getState();
        for (const p of st?.panels.filter(x => x.altAllele && !x.readSubset) ?? []) st.removePanel(p.id);
      });
      await sleep(500);
      await openPanel(page, 'Variants');
      await tab(page, 'variants', 'svs');
      const row = page.locator('[data-panel-content-type="variants"] [data-testid="variants-sv"]').first();
      await row.waitFor({ timeout: 15_000 });
      await row.getByRole('button', { name: 'Split into panels…' }).click();
      // The split dialog: its groups (carriers, reference), then Open.
      const open = page.getByTestId('split-panels-open');
      await open.waitFor({ timeout: 15_000 });
      await page.waitForFunction(() => {
        const b = document.querySelector('[data-testid="split-panels-open"]');
        return b && !b.disabled;
      }, null, { timeout: 30_000, polling: 250 });
      await open.click();
      // The split panels' reads.
      await page.waitForFunction(() => {
        const st = window.__FIBERBROWSER_STORE__?.getState();
        const split = st?.panels.filter(p => p.readSubset) ?? [];
        return split.length >= 2 && split.every(p => (st.activeReadIds[p.stateKey ?? p.id]?.length ?? 0) > 0);
      }, null, { timeout: 60_000, polling: 500 });
      // The SVs tab lists the reads the split was made from: the insertion and its carriers.
      await page.locator('[data-panel-content-type="variants"] [data-testid="variants-svs-split-source"]').waitFor({ timeout: 30_000 });
      await page.locator('[data-panel-content-type="variants"] [data-testid="variants-sv"]').first().waitFor({ timeout: 30_000 });
      await sleep(1500);
    }],
  ];
  for (const [file, title, act] of views) {
    try {
      await act();
      await settle(page, sleep);
      await shoot(page, path.join(out, `${file}.png`));
      audit.push({ file: `${file}.png`, title, extra: true });
      console.log(`extra     ${title}`);
    } catch (err) {
      audit.push({ file: `${file}.png`, title, extra: true, error: String(err).slice(0, 300) });
      console.log(`extra     ${title}  [FAILED: ${String(err).split('\n')[0].slice(0, 160)}]`);
    }
  }
  // Back to the NAPA demo: the SV demo's panels go, the NAPA panel unfolds, the view returns to NAPA.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await closePanel(page, 'variants');
  await page.evaluate(() => {
    const st = window.__FIBERBROWSER_STORE__?.getState();
    if (!st) return;
    const napa = st.datasets.find(d => /^NAPA demo/.test(d.label ?? ''));
    for (const p of [...st.panels]) {
      if (p.contentType === 'dataset' && p.datasetId !== napa?.id) st.removePanel(p.id);
    }
    const now = window.__FIBERBROWSER_STORE__.getState();
    for (const p of now.panels) if (p.contentType === 'dataset' && p.collapsed) now.setPanelCollapsed(p.id, false);
    now.setViewport('chr19', 47_514_000, 47_518_000);
  });
  await settle(page, sleep, 2500);
}

export async function captureExtras(page, { baseUrl, out, shoot, audit, sleep, waitForPanels, main }) {
  // The tour ends beside its step list (the Tutorial panel): make room.
  await closePanel(page, 'history');
  await sleep(800);
  await captureSvExtras(page, { out, shoot, audit, sleep });
  const views = [
    ['x01_class_highlighted_on_reads', 'Footprint classes: a class highlighted on the reads', async () => {
      await openPanel(page, 'Footprints');
      await tab(page, 'footprint-analysis', 'states');
      const name = page.locator(`${FP} [data-testid="recaller-class-table"] [data-testid="recaller-row"] button`).first();
      await name.scrollIntoViewIfNeeded();
      await name.click();
      await sleep(1500);
      await page.locator(`${FP} [data-testid="recaller-class-table"]`).first().evaluate(el => el.scrollIntoView({ block: 'start' }));
    }],
    ['x02_compare_strands_plot', 'Compare strands: class prevalence on CT and GA', async () => {
      await page.locator(`${FP} [data-testid="compare-datasets"]`).evaluate(el => { el.open = true; });
      await sleep(500);
      const plot = page.locator(`${FP} [data-testid="recaller-plot"]`).first();
      if ((await plot.textContent())?.trim() === 'Plot') await plot.click();
      await sleep(800);
      await page.locator(`${FP} [data-testid="recaller-compare"]`).first().scrollIntoViewIfNeeded();
    }],
    ['x03_saved_class_details', 'Saved: a saved class opened (channels, counting tiers, sequence and motifs)', async () => {
      await tab(page, 'footprint-analysis', 'saved');
      await sleep(500);
      const card = page.locator(`${FP} [data-testid="saved-class"] button[aria-expanded="false"]`).first();
      if (await card.count()) await card.click();
      await sleep(1500);
      await page.locator(`${FP} [data-testid="saved-class"]`).first().scrollIntoViewIfNeeded();
    }],
    ['x04_co_occupancy_matrix', 'Co-occupancy of the saved footprint and the saved class', async () => {
      await tab(page, 'footprint-analysis', 'co-occ');
      await sleep(2500);
    }],
    ['x12_read_menu', 'Right-click a read: the read menu', async () => {
      await closePanel(page, 'footprint-analysis');
      await sleep(600);
      const canvas = page.locator('canvas[data-copilot-track="reads"]').first();
      const box = await canvas.boundingBox();
      await page.mouse.click(box.x + box.width * 0.55, box.y + Math.min(120, box.height * 0.3), { button: 'right' });
      await page.getByTestId('read-context-menu').waitFor({ timeout: 5000 });
    }],
    ['x13_command_palette', 'The command palette (Cmd/Ctrl+K)', async () => {
      await page.keyboard.press('Escape');
      await sleep(300);
      await page.getByTestId('command-palette-button').click();
      await page.getByTestId('command-palette-input').fill('row height');
      await sleep(800);
    }],
    ['x14_export_data', 'Export data (Cmd/Ctrl+Shift+E)', async () => {
      await page.keyboard.press('Escape');
      await sleep(300);
      await page.getByTestId('export-data-button').click();
      await page.getByTestId('export-data-dialog').waitFor({ timeout: 5000 });
      await sleep(800);
    }],
    ['x07_export_dialog', 'Export: a figure', async () => {
      await page.keyboard.press('Escape');
      await sleep(400);
      await page.getByTestId('export-screenshot-button').click();
      await sleep(1200);
    }],
    ['x08_history_timeline', 'Undo history timeline', async () => {
      await page.keyboard.press('Escape');
      await sleep(400);
      const close = page.getByRole('button', { name: /^(Close|Cancel)$/ }).first();
      if (await close.count()) await close.click().catch(() => {});
      await page.getByTestId('history-timeline-button').click();
      await sleep(800);
    }],
    ['x15_regions_catalog', 'Regions: the saved regions in categories', async () => {
      await page.keyboard.press('Escape');
      await openPanel(page, 'Regions');
      await tab(page, 'circular-genome', 'catalog');
      await sleep(800);
    }],
    ['x16_highlights', 'Highlight: the list of highlights', async () => {
      await page.keyboard.press('Escape');
      const toggle = page.locator('[data-tour="highlight-controls-expand"]');
      if (await toggle.count() && (await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
      await sleep(300);
      await page.getByTestId('highlight-list-button').click();
      await page.getByTestId('highlight-list').waitFor({ timeout: 5000 });
      await sleep(500);
    }],
    ['x09_regions_compare_haplotypes', 'Regions > Compare haplotypes', async () => {
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await openPanel(page, 'Regions');
      await tab(page, 'circular-genome', 'haplotype');
      await sleep(800);
    }],
  ];
  for (const [file, title, act] of views) {
    try {
      await act();
      await settle(page, sleep);
      await shoot(page, path.join(out, `${file}.png`));
      audit.push({ file: `${file}.png`, title, extra: true });
      console.log(`extra     ${title}`);
    } catch (err) {
      audit.push({ file: `${file}.png`, title, extra: true, error: String(err).slice(0, 300) });
      console.log(`extra     ${title}  [FAILED: ${String(err).split('\n')[0].slice(0, 160)}]`);
    }
  }

  // An independent workspace: a second workspace of the same server (its own state).
  try {
    const ws = await page.context().newPage();
    await ws.setViewportSize({ width: 1440, height: 900 });
    await ws.goto(`${baseUrl}/?workspace=new`);
    await ws.waitForSelector('[data-testid="panel-rail"], [data-testid="analysis-strip"]', { timeout: 30_000 });
    await settle(ws, sleep, 2000);
    await shoot(ws, path.join(out, 'x10_new_workspace.png'));
    audit.push({ file: 'x10_new_workspace.png', title: 'A new independent workspace', extra: true, url: ws.url() });
    console.log('extra     A new independent workspace');
    await ws.close();
  } catch (err) {
    audit.push({ file: 'x10_new_workspace.png', extra: true, error: String(err).slice(0, 300) });
    console.log(`extra     workspace  [FAILED: ${String(err).split('\n')[0].slice(0, 160)}]`);
  }

  // The main tab's sidebar: Data & Sessions > Session (save, restore, New Independent Workspace).
  if (main) {
    try {
      await main.bringToFront();
      const dismiss = main.getByRole('button', { name: 'Dismiss welcome screen' });
      if (await dismiss.count()) await dismiss.click();
      // Settings open from the rail at the right edge: its Data & Sessions icon.
      await main.getByTestId('settings-rail-file').click();
      await sleep(600);
      const session = main.locator('[data-tour="sidebar-file.session"]').first();
      if ((await session.getAttribute('aria-expanded')) !== 'true') await session.click();
      await sleep(600);
      await main.getByTestId('new-workspace').scrollIntoViewIfNeeded();
      await settle(main, sleep);
      await shoot(main, path.join(out, 'x11_session_sidebar.png'));
      audit.push({ file: 'x11_session_sidebar.png', title: 'Data & Sessions > Session', extra: true });
      console.log('extra     Data & Sessions > Session');
    } catch (err) {
      audit.push({ file: 'x11_session_sidebar.png', extra: true, error: String(err).slice(0, 300) });
      console.log(`extra     session sidebar  [FAILED: ${String(err).split('\n')[0].slice(0, 160)}]`);
    }
  }
}

/**
 * DAF-seq strands (x05, x06), in a fresh tour tab in a browser context of its own:
 * only the demo and its peaks. (Split in the long-lived tour tab above, the two new
 * panels stayed at "Loading..." for minutes in the capture runs.)
 */
export async function captureStrands(browser, { baseUrl, out, shoot, audit, sleep }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
  try {
    const strands = await context.newPage();
    await strands.goto(baseUrl);
    const sandbox = await strands.evaluate(async () => (await (await fetch('/api/sandbox', { method: 'POST' })).json()).id);
    await strands.goto(`${baseUrl}/?sandbox=${encodeURIComponent(sandbox)}&tour=1&step=layers`);
    await strands.waitForSelector('.copilot-tutorial-popover .copilot-tutorial-end', { timeout: 240_000 });
    await strands.locator('.copilot-tutorial-popover .copilot-tutorial-end').last().click();
    await settle(strands, sleep, 1500);
    await strands.getByTestId('panel-strand-chip').first().click();
    await sleep(600);
    await shoot(strands, path.join(out, 'x05_strand_chip.png'));
    audit.push({ file: 'x05_strand_chip.png', title: 'The strand chip: CT, GA, both, or split into two panels', extra: true });
    console.log('extra     The strand chip');
    await strands.getByTestId('split-by-strand').first().click();
    // Both panels drawn (their read tracks loaded and rendered, as tour.spec.ts checks).
    await strands.waitForFunction(() => {
      const tracks = Array.from(document.querySelectorAll('[data-read-track-state-key]'));
      return tracks.length >= 2 && tracks.every(el => el.getAttribute('data-read-track-loading') === 'false'
        && Number(el.getAttribute('data-read-track-render-count') ?? 0) > 0);
    }, null, { timeout: 150_000, polling: 1000 });
    await settle(strands, sleep, 1500);
    await shoot(strands, path.join(out, 'x06_split_by_strand.png'));
    audit.push({ file: 'x06_split_by_strand.png', title: 'Split into CT and GA panels', extra: true });
    console.log('extra     Split into CT and GA panels');
  } catch (err) {
    audit.push({ file: 'x05/x06', extra: true, error: String(err).slice(0, 300) });
    console.log(`extra     strands  [FAILED: ${String(err).split('\n')[0].slice(0, 160)}]`);
  } finally {
    await context.close();
  }
}
