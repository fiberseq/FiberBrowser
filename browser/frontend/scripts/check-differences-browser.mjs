/** Real Chromium pixels, served entirely by Playwright request interception.
 * Usage: node scripts/check-differences-browser.mjs <external Vite outDir> <evidenceDir>
 * No listening socket or backend, and no worktree dist output.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [output, evidence] = process.argv.slice(2);
if (!output || !evidence) throw new Error('Supply external Vite and evidence directories');
const outDir = path.resolve(output), evidenceDir = path.resolve(evidence);
if ([outDir, evidenceDir].some(p => p === root || p.startsWith(root + path.sep))) {
  throw new Error('Browser validation outputs must be outside the frontend worktree');
}
await fs.mkdir(evidenceDir, { recursive: true });
await build({ root, configFile: path.join(root, 'vite.config.ts'), build: { outDir, emptyOutDir: true,
  rollupOptions: { input: { app: path.join(root, 'index.html'), oracle: path.join(root, 'tests/offline/differences.html') } } } });

// macOS's multi-process Mach rendezvous may be unavailable in constrained hosts.
const args = process.platform === 'darwin' ? ['--single-process', '--no-zygote', '--disable-gpu'] : [];
const browser = await chromium.launch({ headless: true, args });
try {
  const page = await browser.newPage({ viewport: { width: 1808, height: 140 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    const file = path.resolve(outDir, '.' + decodeURIComponent(url.pathname));
    assert.ok(file.startsWith(outDir + path.sep), 'resource must stay in the external Vite build');
    const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
    await route.fulfill({ status: 200, contentType: types[path.extname(file)] ?? 'application/octet-stream', body: await fs.readFile(file) });
  });
  await page.goto('https://fiberbrowser.invalid/tests/offline/differences.html');
  await page.waitForFunction(() => typeof window.probe === 'function');
  const checks = [];
  for (const orientation of ['+', '-']) for (const reversed of [false, true]) for (const expanded of [true, false]) {
    const value = await page.evaluate(([r, e, o]) => window.probe(r, e, o), [reversed, expanded, orientation]);
    assert.deepEqual(value.flank, [241, 245, 249, 255], 'observed reference body pixel');
    assert.deepEqual(value.hole, expanded ? [255, 255, 255, 255] : value.flank, 'four replaced bases and collapse');
    assert.deepEqual(value.referenceFlank, [255, 0, 0, 255], 'reference-only track flank');
    assert.deepEqual(value.referenceReplaced, [255, 0, 0, 255], 'reference ruler retains the replaced interval');
    if (expanded) {
      assert.deepEqual(value.alternate, [204, 204, 204, 255], 'alternate-local footprint pixel');
      assert.deepEqual(value.referenceAlternate, [0, 0, 0, 0], 'alternate columns contain no reference signal');
      assert.deepEqual(value.referenceRight, [255, 0, 0, 255], 'right reference flank shares the column displacement');
      assert.ok(Math.abs(value.hit - value.expectedHit) < 1e-6, 'reference gesture snaps to the authored boundary');
    }
    checks.push(value);
    await page.screenshot({ path: path.join(evidenceDir, `canvas-${orientation === '+' ? 'plus' : 'minus'}-${reversed ? 'reverse' : 'forward'}-${expanded ? 'expanded' : 'collapsed'}.png`) });
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(evidenceDir, 'browser-checks.json'), JSON.stringify(checks, null, 2));
  console.log(`Passed ${checks.length} independent Chromium pixel/gesture cases`);
} finally { await browser.close(); }
