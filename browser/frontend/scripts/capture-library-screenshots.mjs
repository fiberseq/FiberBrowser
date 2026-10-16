#!/usr/bin/env node
/**
 * Screenshots of the Library for docs/workflows/library.md, against a running
 * FiberBrowser with a scratch Library and a synthetic lab folder:
 *
 *   python tests/make_library_fixture.py /scratch/lab --demo
 *   FIBERBROWSER_LIBRARY=/scratch/library.json python browser.py -p 8851 --no-token --no-open
 *   cd browser/frontend && node scripts/capture-library-screenshots.mjs \
 *        --base-url http://localhost:8851 --folder /scratch/lab
 *
 * Options: --out DIR (default <repo>/docs/images/library), --no-compress,
 * --python PATH (Pillow, for compression; default python3).
 */
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

const opts = { baseUrl: null, folder: null, out: path.join(REPO_ROOT, 'docs', 'images', 'library'), compress: true, python: 'python3', width: 1600 };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--base-url') opts.baseUrl = argv[++i].replace(/\/$/, '');
  else if (a === '--folder') opts.folder = path.resolve(argv[++i]);
  else if (a === '--out') opts.out = path.resolve(argv[++i]);
  else if (a === '--no-compress') opts.compress = false;
  else if (a === '--python') opts.python = argv[++i];
}
if (!opts.baseUrl || !opts.folder) {
  console.error('Need --base-url and --folder (see the header of this script).');
  process.exit(2);
}

function compressAll(dir) {
  const code = `
import sys, glob
from PIL import Image
for path in glob.glob(sys.argv[1] + '/*.png'):
    im = Image.open(path).convert('RGB')
    if im.width > ${opts.width}:
        im = im.resize((${opts.width}, round(im.height * ${opts.width} / im.width)), Image.LANCZOS)
    im = im.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    im.save(path, optimize=True)
`;
  const r = spawnSync(opts.python, ['-c', code, dir], { stdio: 'inherit' });
  if (r.status !== 0) console.warn('Compression failed (is Pillow installed?); the PNGs stay uncompressed.');
}

mkdirSync(opts.out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 2 });
const shot = async (name, target = page) => {
  await page.waitForTimeout(400);
  await target.screenshot({ path: path.join(opts.out, name) });
  console.log(`saved ${name}`);
};

await page.goto(opts.baseUrl);
await page.waitForLoadState('networkidle');
const watched = await page.request.post(`${opts.baseUrl}/api/library/watched`, { data: { path: opts.folder, max_depth: 4 } });
if (!watched.ok()) throw new Error(`watch failed: ${watched.status()}`);
for (let i = 0; i < 60; i += 1) {
  const lib = await (await page.request.get(`${opts.baseUrl}/api/library`)).json();
  if (!lib.scan.running && !lib.scan.queued.length && lib.entries.length) break;
  await page.waitForTimeout(500);
}

await page.evaluate(() => window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-section', {
  detail: { sectionId: 'file', subsectionId: 'file.library' },
})));
await page.getByTestId('library-sidebar').scrollIntoViewIfNeeded();
await shot('01_sidebar.png', page.getByTestId('settings-sidebar'));

await page.getByTestId('library-open-panel').click();
const dialog = page.getByTestId('library-dialog');
await dialog.waitFor();
await page.waitForTimeout(600);
await shot('02_library.png', dialog);

await dialog.getByTestId('library-row').filter({ hasText: 'embryo_4-6h' }).click();
await dialog.getByTestId('library-details').waitFor();
await page.waitForTimeout(800);
await shot('03_details.png', dialog);
await browser.close();
if (opts.compress) compressAll(opts.out);
