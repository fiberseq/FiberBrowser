// Export -> Image -> Capture full UI (PNG, 2x) in WebKit and Chromium: the download holds the drawn reads.
// args: { base, outdir, region: {chrom,start,end}, browsers?: ['webkit','chromium'] }
import { readFileSync, statSync } from 'node:fs';
import { pw, args, main, outFile, openContext, watchErrors, waitDatasets } from './common.mjs';

await main(async out => {
  for (const name of args.browsers || ['webkit', 'chromium']) {
    const r = out[name] = {};
    const browser = await pw[name].launch({ headless: true });
    try {
      const page = await (await openContext(browser, { viewport: { width: 1280, height: 900 }, contextOptions: { acceptDownloads: true } })).newPage();
      const errors = watchErrors(page);
      const { chrom, start, end } = args.region;
      await page.goto(`${args.base}/?chrom=${chrom}&start=${start}&end=${end}`);
      await page.waitForLoadState('networkidle');
      await waitDatasets(page);
      // Two side-by-side copies of the first dataset panel, axis + reads only (as tests/e2e/ui-capture-webkit.spec.ts).
      await page.evaluate(region => {
        const store = window.__FIBERBROWSER_STORE__;
        const panel = store.getState().panels.find(p => p.contentType === 'dataset');
        const panels = Array.from({ length: 2 }, (_, i) => ({
          ...panel, id: `cap-${i}`, stateKey: `cap-${i}`, layoutRow: 0, layoutColumn: i, widthFraction: 0.5,
          subTracks: panel.subTracks.filter(t => ['axis', 'reads'].includes(t.type)),
        }));
        store.setState({ panels, slotOrder: panels.map(p => p.id), readDisplayMode: 'sample', readRowHeight: 3 });
        store.getState().setViewport(region.chrom, region.start, region.end);
      }, args.region);
      const t0 = Date.now();
      while (Date.now() - t0 < 60000) {
        const ok = await page.locator('[data-read-track-dataset-id]').evaluateAll(ts => ts.length > 0 && ts.every(t =>
          t.getAttribute('data-read-track-loading') === 'false' && Number(t.getAttribute('data-read-track-render-count')) > 0));
        if (ok) break; await page.waitForTimeout(500);
      }
      r.read_tracks = await page.locator('[data-read-track-dataset-id]').count();
      await page.screenshot({ path: outFile(`${name}_screen.png`) });
      await page.getByTestId('export-screenshot-button').click();
      await page.getByRole('button', { name: 'PNG', exact: true }).click();
      await page.getByLabel('Capture full UI').check();
      await page.getByRole('button', { name: '2x', exact: true }).click();
      const download = page.waitForEvent('download', { timeout: 90000 });
      await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
      const file = outFile(`${name}_full_ui_capture_2x.png`);
      await (await download).saveAs(file);
      r.download_bytes = statSync(file).size;
      await page.waitForTimeout(1500);
      r.could_not_load_reads_text = await page.getByText(/Could not load reads/i).count();
      r.export_error_text = await page.getByText(/export failed|could not export/i).count();
      // Read ink in each read-track box of the captured image.
      const boxes = await page.locator('[data-read-track-dataset-id]').evaluateAll(tracks => {
        const root = document.querySelector('[data-browser-root]').getBoundingClientRect();
        return tracks.map(t => { const q = t.getBoundingClientRect();
          return { x: (q.left - root.left) / root.width, y: (q.top - root.top) / root.height, w: q.width / root.width,
                   h: Math.min(q.height, innerHeight - q.top) / root.height }; });
      });
      r.ink = await page.evaluate(async ({ data, boxes }) => {
        const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
        const c = document.createElement('canvas'); c.width = image.naturalWidth; c.height = image.naturalHeight;
        const g = c.getContext('2d'); g.drawImage(image, 0, 0);
        return { size: [c.width, c.height], panels: boxes.map(b => {
          const px = g.getImageData(Math.floor(b.x * c.width), Math.floor(b.y * c.height), Math.max(1, Math.floor(b.w * c.width)), Math.max(1, Math.floor(b.h * c.height))).data;
          let k = 0; for (let i = 0; i < px.length; i += 4) { const hi = Math.max(px[i], px[i + 1], px[i + 2]), lo = Math.min(px[i], px[i + 1], px[i + 2]); if (hi - lo > 30 && lo < 210) k++; }
          return k / (px.length / 4); }) };
      }, { data: readFileSync(file).toString('base64'), boxes });
      r.page_errors = errors.page;
    } finally { await browser.close(); }
  }
});
