// Labels -> Layer colours on the packaged app: pick a nucleosome colour, see it on the read track, save it as the
// default (phase "set"); after a restart on the same HOME the read track uses it and the source says so ("after-restart").
// args: { base, outdir, region: {chrom,start,end}, phase, colour }
import { pw, args, main, outFile, openContext, watchErrors, st, waitDatasets, waitReadTracks, openLayerColours } from './common.mjs';

const pick = (args.colour || '#ffd400').toLowerCase();
const rgb = [1, 3, 5].map(i => parseInt(pick.slice(i, i + 2), 16));
await main(async out => {
  out.phase = args.phase; out.colour = pick;
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const page = await (await openContext(browser)).newPage();
    const errors = watchErrors(page);
    const { chrom, start, end } = args.region;
    await page.goto(`${args.base}/?chrom=${chrom}&start=${start}&end=${end}`);
    await page.waitForLoadState('networkidle');
    await waitDatasets(page);
    await page.evaluate(r => window.__FIBERBROWSER_STORE__.getState().setViewport(r.chrom, r.start, r.end), args.region);
    await waitReadTracks(page);
    await page.waitForTimeout(2500);
    // Pixels of the read-track canvas: default nucleosome green, and the picked colour.
    const scan = () => page.evaluate(([r, g, b]) => {
      const c = document.querySelector('canvas[data-copilot-track="reads"]'); if (!c) return null;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let green = 0, picked = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] !== 255) continue;
        if (d[i + 1] > 120 && d[i] < 110 && d[i + 2] < 110) green++;
        if (Math.abs(d[i] - r) <= 24 && Math.abs(d[i + 1] - g) <= 24 && Math.abs(d[i + 2] - b) <= 24) picked++;
      }
      return { green, picked, w: c.width, h: c.height };
    }, rgb);
    const colours = () => st(page, s => ({ overrides: s.layerColorOverrides, user: s.userLayerColors }));
    out.before = await scan();
    out.store_before = await colours();
    await page.screenshot({ path: outFile(`${args.phase}_1_before.png`) });
    const panel = await openLayerColours(page);
    if (args.phase === 'set') {
      await panel.getByTestId('layer-colour-input-nuc').fill(pick);
      out.source_after_pick = await panel.getByTestId('layer-colour-source-nuc').textContent();
      await page.waitForTimeout(2500);
      out.after_pick = await scan();
      await page.screenshot({ path: outFile('set_2_after_pick.png') });
      await panel.getByTestId('layer-colour-save-default').click();
      await page.waitForTimeout(1500);
      out.save_message = await panel.getByTestId('layer-colours-message').textContent().catch(() => null);
      out.source_after_save = await panel.getByTestId('layer-colour-source-nuc').textContent();
      await page.screenshot({ path: outFile('set_3_saved.png') });
    } else {
      out.source_fresh = await panel.getByTestId('layer-colour-source-nuc').textContent();
      out.input_value = await panel.getByTestId('layer-colour-input-nuc').inputValue().catch(() => null);
      out.after_restart = await scan();
      await page.screenshot({ path: outFile('after_restart.png') });
    }
    out.store_end = await colours();
    out.prefs = await (await page.request.get(`${args.base}/api/preferences/analysis`)).json();
    out.page_errors = errors.page;
  } finally { await browser.close(); }
});
