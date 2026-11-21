/**
 * Plots layout fits by default: for each plot type, its builder with every section expanded (More options, the
 * summary, From panels) at 1280×800, 1440×900 and 1920×1080; no label, select, number or button overflows its
 * container, no text is clipped, and the plot card's figures stay inside the card. Every card is checked drawn, with
 * data (peaks selected, reads clustered first): the text the figures draw on their canvases (axis labels, legends,
 * colour bars, summary labels) stays inside its canvas and does not overlap other text. Screenshots of each go to
 * PLOTS_FIT_SHOTS (when set) for a look.
 *
 * Pinned to the tracked NAPA demo BAM (chr19:47514000-47518000).
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/server';
import type { Page } from '@playwright/test';

const REGION = { chrom: 'chr19', start: 47514000, end: 47518000 };
const TYPES = ['size-enrichment', 'vplot', 'metaprofile', 'heatmap', 'size-histogram', 'co-accessibility', 'differential'];
const SIZES: Array<[number, number]> = [[1280, 800], [1440, 900], [1920, 1080]];
const SHOTS = process.env.PLOTS_FIT_SHOTS?.trim() || '';

async function open(page: Page, baseUrl: string, w: number, h: number) {
  await page.setViewportSize({ width: w, height: h });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    localStorage.clear();
    sessionStorage.clear();
    sessionStorage.setItem('fiberhmm_welcome_dismissed', '1');
    // Differential is behind the hub flag: on here so its builder is checked too.
    localStorage.setItem('fiberbrowser_experimental_hub_workspace', 'true');
    // Every text a canvas draws, as a box in the canvas' pixels (reset when the canvas is painted over whole).
    const fill = CanvasRenderingContext2D.prototype.fillText;
    const rect = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function (x: number, y: number, w: number, h: number) {
      try {
        const t = this.getTransform();
        if (x <= 0 && y <= 0 && w * t.a >= this.canvas.width - 1 && h * t.d >= this.canvas.height - 1) (this.canvas as any).__texts = [];
      } catch { /* not a chart */ }
      return rect.call(this, x, y, w, h);
    };
    // A redraw starts by resetting the transform or clearing: earlier text is gone.
    const setT = CanvasRenderingContext2D.prototype.setTransform;
    CanvasRenderingContext2D.prototype.setTransform = function (...args: any[]) {
      if (args.length === 6 && !args[1] && !args[2] && !args[4] && !args[5]) (this.canvas as any).__texts = [];
      return (setT as any).apply(this, args);
    };
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (x: number, y: number, w: number, h: number) {
      if (x <= 0 && y <= 0) (this.canvas as any).__texts = [];
      return clear.call(this, x, y, w, h);
    };
    CanvasRenderingContext2D.prototype.fillText = function (text: string, x: number, y: number, maxW?: number) {
      try {
        const m = this.measureText(String(text));
        const a = this.textAlign;
        const left = a === 'center' ? x - m.width / 2 : a === 'right' || a === 'end' ? x - m.width : x;
        const asc = m.actualBoundingBoxAscent || 7, desc = m.actualBoundingBoxDescent || 2;
        const t = this.getTransform();
        const pts = [[left, y - asc], [left + m.width, y - asc], [left, y + desc], [left + m.width, y + desc]].map(([px, py]) => [t.a * px + t.c * py + t.e, t.b * px + t.d * py + t.f]);
        const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]);
        ((this.canvas as any).__texts ??= []).push({ text: String(text), box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], dpr: t.a });
      } catch { /* measuring is best effort */ }
      return maxW == null ? fill.call(this, text, x, y) : fill.call(this, text, x, y, maxW);
    };
  });
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');
  await page.evaluate((r: typeof REGION) => (window as any).__FIBERBROWSER_STORE__.getState().setViewport(r.chrom, r.start, r.end), REGION);
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 30_000 }).toBe(0);
  // Data for every type: peaks (selected: the heatmap's rows) and two clusters (Differential compares them).
  await page.evaluate(() => { if ((window as any).__FIBERBROWSER_STORE__.getState().getAllPeaks().length < 3) (window as any).fiberbrowserCommand?.('scan-peaks'); });
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().getAllPeaks().length), { timeout: 60_000 }).toBeGreaterThan(2);
  await page.evaluate(() => {
    const st = (window as any).__FIBERBROWSER_STORE__;
    const peaks = st.getState().getAllPeaks();
    st.setState({ clusterMethod: 'binary', clusterK: 2, clusterPeakMode: 'accessibility', clusterPreparationCount: null });
    st.getState().replacePeakSelection([(peaks.find((p: { layer?: number }) => p.layer === 1) ?? peaks[0]).index]);
  });
  const clustered = page.waitForResponse(r => r.url().includes('/api/cluster_all') && r.ok(), { timeout: 90_000 });
  await page.getByTestId('cluster-run-button').click();
  await clustered;
  // Let the clustering finish (changing the selection meanwhile stops it).
  await expect.poll(() => page.evaluate(() => Object.values((window as any).__FIBERBROWSER_STORE__.getState().clusterAssignments as Record<string, object>)
    .reduce((n: number, a) => n + Object.keys(a).length, 0)), { timeout: 90_000 }).toBeGreaterThan(10);
  await expect(page.getByTestId('analysis-progress')).toHaveCount(0, { timeout: 90_000 }).catch(() => undefined);
  await page.evaluate(() => { const st = (window as any).__FIBERBROWSER_STORE__; st.getState().replacePeakSelection(st.getState().getAllPeaks().slice(0, 4).map((p: { index: number }) => p.index)); });
  await page.keyboard.press('p');
  await expect(page.getByTestId('plots-workspace')).toBeVisible();
}

/** Each type's plot element and how to make it draw with data. */
const PLOT_OF: Record<string, string> = {
  'size-enrichment': 'plots-size-plot', vplot: 'plots-size-plot', metaprofile: 'plots-profile-plot', heatmap: 'plots-heatmap-plot',
  'size-histogram': 'plots-histogram-plot', 'co-accessibility': 'plots-coacc-plot', differential: 'plots-diff-plot',
};

/** Text the card's canvases draw outside the canvas, or over other text. */
async function canvasText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const c of Array.from(document.querySelectorAll<HTMLCanvasElement>('[data-testid="plots-card"] canvas'))) {
      const texts = ((c as any).__texts ?? []) as Array<{ text: string; box: number[]; dpr: number }>;
      const id = c.closest('[data-testid]')?.getAttribute('data-testid') ?? 'canvas';
      const W = c.width, H = c.height;
      for (const t of texts) {
        const [x0, y0, x1, y1] = t.box;
        if (x0 < -1 || y0 < -1 || x1 > W + 1 || y1 > H + 1) out.push(`${id}: "${t.text.slice(0, 40)}" outside the canvas (${x0.toFixed(0)},${y0.toFixed(0)}–${x1.toFixed(0)},${y1.toFixed(0)} of ${W}×${H})`);
      }
      for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i].box, b = texts[j].box;
        const ix = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), iy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
        if (ix <= 0 || iy <= 0) continue;
        const area = Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]));
        // The same text in the same place is one label drawn twice (a redraw), not an overlap.
        const same = texts[i].text === texts[j].text && Math.abs(a[0] - b[0]) < 1 && Math.abs(a[1] - b[1]) < 1;
        if (!same && ix * iy > 0.25 * area && texts[i].text.trim() && texts[j].text.trim()) out.push(`${id}: "${texts[i].text.slice(0, 30)}" overlaps "${texts[j].text.slice(0, 30)}"`);
      }
    }
    return [...new Set(out)];
  });
}

/** Elements that stick out of their pane or clip their own text. */
async function overflows(page: Page, paneTestId: string): Promise<string[]> {
  return page.evaluate((pid: string) => {
    const pane = document.querySelector(`[data-testid="${pid}"]`) as HTMLElement | null;
    if (!pane) return [`no ${pid}`];
    const box = pane.getBoundingClientRect();
    const out: string[] = [];
    const sel = 'label, select, input, button, span, p, h3, div';
    for (const el of Array.from(pane.querySelectorAll<HTMLElement>(sel))) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const name = `${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ''} "${(el.textContent || (el as HTMLInputElement).value || '').trim().slice(0, 40)}"`;
      // Out of the pane sideways (the pane scrolls only vertically).
      if (r.right > box.right + 1 || r.left < box.left - 1) out.push(`outside: ${name} (${Math.round(r.left)}–${Math.round(r.right)} vs ${Math.round(box.left)}–${Math.round(box.right)})`);
      // Its own content cut off: a clipping box narrower than what it holds (selects: their chosen option).
      const clips = cs.overflowX === 'hidden' || cs.overflowX === 'clip' || el.tagName === 'SELECT' || el.tagName === 'INPUT' || el.tagName === 'BUTTON';
      if (clips && el.scrollWidth > el.clientWidth + 1 && !el.classList.contains('truncate')) out.push(`clipped: ${name} (${el.scrollWidth} > ${el.clientWidth})`);
      if (el.tagName === 'SELECT') {
        const s = el as HTMLSelectElement;
        const label = s.options[s.selectedIndex]?.text ?? '';
        const c = document.createElement('canvas').getContext('2d')!;
        c.font = `${cs.fontSize} ${cs.fontFamily}`;
        const need = c.measureText(label).width + 24; // text plus the arrow
        if (need > s.clientWidth + 2) out.push(`select text cut: ${name} "${label}" (${Math.round(need)} > ${s.clientWidth})`);
      }
    }
    return [...new Set(out)];
  }, paneTestId);
}

for (const [w, h] of SIZES) {
  test(`builder and plot card fit at ${w}×${h} for every plot type`, async ({ server, page }) => {
    test.setTimeout(900_000);
    await open(page, server.baseUrl, w, h);
    const ws = page.getByTestId('plots-workspace');
    const problems: string[] = [];
    for (const type of TYPES) {
      await ws.getByTestId(`plots-type-${type}`).click();
      const more = ws.getByTestId('plots-more-options');
      if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
      const summary = ws.getByTestId('plots-summary-on');
      if (await summary.count() && !(await summary.isChecked())) await summary.check();
      // Every optional block shown: the state-at-anchor filter of the profile types.
      const cond = ws.getByTestId('plots-profile-condition');
      if (await cond.count() && !(await cond.isChecked())) await cond.check();
      const fromPanels = ws.getByTestId('plots-from-panels-toggle');
      if (await fromPanels.count() && (await fromPanels.getAttribute('aria-expanded')) !== 'true') await fromPanels.click();
      // Each type on its natural scope (the heatmap is per region: it keeps the selected features).
      const view = ws.getByTestId('plots-where-view');
      if (type !== 'heatmap' && await view.count() && await view.isEnabled() && (await view.getAttribute('aria-pressed')) !== 'true') await view.click();
      if (type === 'differential') await ws.getByTestId('plots-group-cluster').click();
      // Drawn, with data, before anything is measured.
      const plotEl = ws.getByTestId(PLOT_OF[type]);
      await expect(plotEl).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
      if (type === 'heatmap') await expect.poll(async () => Number(await plotEl.getAttribute('data-row-count')), { timeout: 60_000 }).toBeGreaterThan(0);
      await expect(ws.getByText(/Computing|Updating…/)).toHaveCount(0, { timeout: 60_000 });
      await page.waitForTimeout(800);
      for (const p of await canvasText(page)) problems.push(`${type} @${w}: drawn: ${p}`);
      for (const pane of ['plots-builder-pane', 'plots-side-pane', 'plots-card']) {
        for (const p of await overflows(page, pane)) problems.push(`${type} @${w}: ${pane}: ${p}`);
      }
      if (SHOTS) {
        mkdirSync(SHOTS, { recursive: true });
        // The panes scroll: a tall window for the picture (same width, so the same layout across).
        await page.setViewportSize({ width: w, height: 3200 });
        await expect(plotEl).toHaveAttribute('data-state', 'current', { timeout: 60_000 });
        await page.waitForTimeout(600);
        await ws.getByTestId('plots-builder-pane').screenshot({ path: path.join(SHOTS, `${w}x${h}_${type}_builder.png`) });
        await ws.getByTestId('plots-card').screenshot({ path: path.join(SHOTS, `${w}x${h}_${type}_card.png`) });
        await page.setViewportSize({ width: w, height: h });
      }
      if (type === 'differential') await ws.getByTestId('plots-group-dataset').click();
    }
    expect(problems).toEqual([]);
  });
}
