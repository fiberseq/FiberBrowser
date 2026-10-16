/**
 * The Library, end to end: a watched folder is scanned (headers only), its
 * files are searched, filtered, tagged, grouped and opened from the Library
 * window. The files are small synthetic FiberHMM BAMs written by
 * tests/make_library_fixture.py; the server's Library is a scratch file.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures/server';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.FIBERBROWSER_TEST_DIR ? path.resolve(process.env.FIBERBROWSER_TEST_DIR) : path.resolve(HERE, '../../../..');
const PYTHON = process.env.FIBERBROWSER_TEST_PYTHON?.trim() || 'python';

test.use({ fixtureBam: 'demo' });

function makeFolder(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-library-data-'));
  const made = spawnSync(PYTHON, [path.join(REPO_ROOT, 'tests', 'make_library_fixture.py'), dir], { encoding: 'utf-8' });
  if (made.status !== 0) throw new Error(`make_library_fixture.py failed: ${made.stderr}`);
  return dir;
}

test('Library: watch a folder, search, tag, group and open', async ({ page, server }) => {
  const folder = makeFolder();
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');

  // Watch the folder (the UI's "Watch a folder…" uses the system folder picker).
  const watched = await page.request.post(`${server.baseUrl}/api/library/watched`, { data: { path: folder, max_depth: 3 } });
  expect(watched.ok()).toBeTruthy();
  await expect.poll(async () => {
    const res = await page.request.get(`${server.baseUrl}/api/library`);
    return (await res.json()).entries.length;
  }, { timeout: 20_000 }).toBe(2);

  // Data & Sessions > Library > Open Library
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-section', {
    detail: { sectionId: 'file', subsectionId: 'file.library' },
  })));
  await expect(page.getByTestId('library-sidebar')).toContainText('2 files');
  await page.getByTestId('library-open-panel').click();
  const dialog = page.getByTestId('library-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('library-row')).toHaveCount(2);
  await expect(dialog.getByTestId('library-suggested')).toContainText('exp1');

  // Search and filter.
  await dialog.getByTestId('library-search').fill('sampleA');
  await expect(dialog.getByTestId('library-row')).toHaveCount(1);
  await dialog.getByTestId('library-search').fill('');
  await dialog.getByTestId('library-filter-qc').selectOption('WARN');
  await expect(dialog.getByTestId('library-row')).toHaveCount(1);
  await expect(dialog.getByTestId('library-qc-verdict')).toHaveText('WARN');
  await dialog.getByTestId('library-filter-qc').selectOption('');

  // Details: the native QC report, then tags.
  await dialog.getByTestId('library-row').filter({ hasText: 'sampleA' }).click();
  const details = dialog.getByTestId('library-details');
  await expect(details).toContainText('DddB');
  await expect(details.getByTestId('qc-verdict-overall')).toContainText('WARN');
  await details.getByTestId('library-tags-input').fill('e2e, embryo');
  await details.getByTestId('library-save-notes').click();
  await expect(dialog.getByTestId('library-row').filter({ hasText: 'sampleA' })).toContainText('#e2e');

  // Group both files.
  const boxes = dialog.getByTestId('library-table').locator('thead input[type="checkbox"]');
  await boxes.check();
  await dialog.getByTestId('library-bulk-group').click();
  await dialog.getByTestId('library-new-group-name').fill('Embryo');
  await dialog.getByTestId('library-add-to-group-confirm').click();
  await expect(dialog.getByTestId('library-group')).toContainText('Embryo (2)');

  // The group exports as a --catalog JSON the catalog loader accepts.
  const lib = await (await page.request.get(`${server.baseUrl}/api/library`)).json();
  const exported = await (await page.request.post(`${server.baseUrl}/api/library/catalog`, {
    data: { group_ids: [lib.groups[0].id], relative: true },
  })).json();
  expect(exported.catalog.groups[0].datasets.map((d: { path: string }) => d.path).sort()).toEqual([
    'sampleA.fiberhmm.bam', 'sampleB.fiberhmm.bam',
  ]);

  // Open sampleA: it joins the loaded datasets and the window closes.
  await dialog.getByTestId('library-row').filter({ hasText: 'sampleA' }).click();
  await details.getByTestId('library-open').click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => {
    const res = await page.request.get(`${server.baseUrl}/api/datasets`);
    return (await res.json()).datasets.map((d: { path: string }) => path.basename(d.path));
  }).toContain('sampleA.fiberhmm.bam');
});

test('Library: a suggested experiment scans its whole folder before it is saved as a group', async ({ page, server }) => {
  const folder = makeFolder();
  const exp1 = path.join(folder, 'exp1');
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');
  // Only sampleA is in the Library (opened or added by hand); sampleB sits beside it.
  const addedA = await page.request.post(`${server.baseUrl}/api/library/entries`, {
    data: { paths: [path.join(exp1, 'sampleA.fiberhmm.bam')] },
  });
  expect(addedA.ok()).toBeTruthy();

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-section', {
    detail: { sectionId: 'file', subsectionId: 'file.library' },
  })));
  await page.getByTestId('library-open-panel').click();
  const dialog = page.getByTestId('library-dialog');
  const suggestion = dialog.getByTestId('library-suggestion').filter({ hasText: 'exp1' });
  await expect(suggestion.getByTestId('library-suggestion-count')).toHaveText('(1)');

  await suggestion.getByTestId('library-save-suggestion').click();
  const review = dialog.getByTestId('library-suggestion-review');
  await expect(review.getByTestId('library-suggestion-summary')).toHaveText(
    'Found 2 files: 2 BAMs — 1 new to the Library.');
  await expect(review.getByTestId('library-suggestion-scope')).toContainText('tracks/ sub-folders');
  await expect(review.getByTestId('library-suggestion-file')).toHaveCount(2);
  await expect(review.getByTestId('library-suggestion-file').filter({ hasText: 'sampleB' })).toContainText('new');
  await review.getByTestId('library-suggestion-name').fill('Folder exp1');
  await review.getByTestId('library-suggestion-run').click();
  await expect(review).toBeHidden();
  await expect(dialog.getByTestId('library-group').filter({ hasText: 'Folder exp1' })).toContainText('Folder exp1 (2)');
  await expect(dialog.getByTestId('library-row')).toHaveCount(2);

  const lib = await (await page.request.get(`${server.baseUrl}/api/library`)).json();
  expect(lib.watched).toEqual([]);  // scanned once, not watched
  const group = lib.groups.find((g: { name: string }) => g.name === 'Folder exp1');
  const byId = new Map(lib.entries.map((e: { id: string; path: string }) => [e.id, e.path]));
  expect(group.entry_ids.map((id: string) => path.basename(String(byId.get(id)))).sort())
    .toEqual(['sampleA.fiberhmm.bam', 'sampleB.fiberhmm.bam']);
  // Both entries keep the folder as the user knows it (no second, resolved-path suggestion).
  expect(new Set(lib.entries.map((e: { folder: string }) => e.folder))).toEqual(new Set([exp1]));
});

test('Library: a state-aware fiberhmm-qc report beside a BAM shows efficiency and background', async ({ page, server }) => {
  // tests/fixtures/qc_state_aware: fiberhmm-qc (FiberHMM 3.0, state-aware) run on this demo BAM.
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-library-qc-')));
  const demo = path.join(REPO_ROOT, 'browser', 'data', 'demo', 'napa_ddda.bam');
  copyFileSync(demo, path.join(dir, 'napa_ddda.bam'));
  copyFileSync(`${demo}.bai`, path.join(dir, 'napa_ddda.bam.bai'));
  mkdirSync(path.join(dir, 'qc'));
  for (const name of ['napa_ddda.qc.json', 'napa_ddda.qc.curves.json']) {
    copyFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'qc_state_aware', name), path.join(dir, 'qc', name));
  }
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');
  const watched = await page.request.post(`${server.baseUrl}/api/library/watched`, { data: { path: dir, max_depth: 2 } });
  expect(watched.ok()).toBeTruthy();
  await expect.poll(async () => {
    const res = await page.request.get(`${server.baseUrl}/api/library`);
    return (await res.json()).entries.filter((e: { path: string }) => e.path.startsWith(dir)).length;
  }, { timeout: 20_000 }).toBe(1);

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-section', {
    detail: { sectionId: 'file', subsectionId: 'file.library' },
  })));
  await page.getByTestId('library-open-panel').click();
  const dialog = page.getByTestId('library-dialog');
  const row = dialog.getByTestId('library-row').filter({ hasText: 'napa_ddda' });
  // The badge is the state-aware overall verdict (the overall-rate grade alone is FAIL).
  await expect(row.getByTestId('library-qc-verdict')).toHaveText('WARN');
  await expect(row.getByTestId('library-qc-verdict')).toHaveAttribute('title', 'Overall verdict from efficiency, background and periodicity (state-aware).');
  await row.click();
  const details = dialog.getByTestId('library-details');
  await expect(details.getByTestId('qc-verdict-overall')).toContainText('WARN');
  await expect(details.getByTestId('qc-verdict-basis')).toContainText('Verdict from efficiency, background and periodicity (state-aware)');
  await expect(details.getByTestId('qc-state-efficiency')).toContainText('62.1%');
  await expect(details.getByTestId('qc-state-efficiency')).toContainText('reference 66.4%');
  await expect(details.getByTestId('qc-state-efficiency')).toContainText('PASS ≥ 62.4% · WARN ≥ 55.4%');
  await expect(details.getByTestId('qc-state-background')).toContainText('16.8%');
  await expect(details.getByTestId('qc-state-background')).toContainText('PASS ≤ 19.2% · WARN ≤ 22.8%');
  await expect(details.getByTestId('qc-state-source')).toContainText('States from the FiberHMM calls in the BAM');
  await expect(details.getByTestId('qc-state-cdf').locator('svg path')).toHaveCount(4);
});

test('Library: Run QC on an entry without opening it; the verdict is kept after a reload', async ({ page, server }) => {
  // The owner: "QC a dataset should also just run QC on the dataset, not open a prompt which says to load a bam".
  test.setTimeout(240_000);
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-library-runqc-')));
  const demo = path.join(REPO_ROOT, 'browser', 'data', 'demo', 'napa_ddda.bam');
  copyFileSync(demo, path.join(dir, 'napa_ddda.bam'));
  copyFileSync(`${demo}.bai`, path.join(dir, 'napa_ddda.bam.bai'));
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');
  const added = await page.request.post(`${server.baseUrl}/api/library/entries`, { data: { paths: [path.join(dir, 'napa_ddda.bam')] } });
  expect(added.ok()).toBeTruthy();
  const entryId: string = (await added.json()).ids[0];

  const openLibrary = async () => {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-section', {
      detail: { sectionId: 'file', subsectionId: 'file.library' },
    })));
    await page.getByTestId('library-open-panel').click();
    return page.getByTestId('library-dialog');
  };
  let dialog = await openLibrary();
  const rowOf = () => dialog.locator(`[data-testid="library-row"][data-entry-id="${entryId}"]`);
  await expect(rowOf().getByTestId('library-qc-verdict')).toHaveCount(0);
  await rowOf().click();
  const details = dialog.getByTestId('library-details');
  await expect(details).not.toContainText('QC a dataset');
  await details.getByTestId('library-qc-run').click();
  await expect(details.getByTestId('library-qc-progress')).toBeVisible();
  await expect(page.getByTestId('daf-run-dialog')).toHaveCount(0);  // no "load a BAM" prompt
  await expect(details.getByTestId('qc-verdict-overall')).toBeVisible({ timeout: 180_000 });
  await expect(details.getByTestId('library-qc-run')).toHaveCount(0);
  // Nothing was written beside the BAM.
  await expect(rowOf().getByTestId('library-qc-verdict')).toHaveText(/PASS|WARN|FAIL|INSUFFICIENT/);
  const listed = await page.request.get(`${server.baseUrl}/api/library`);
  const entry = (await listed.json()).entries.find((e: { id: string }) => e.id === entryId);
  expect(entry.qc.verdicts.overall).toMatch(/PASS|WARN|FAIL|INSUFFICIENT/);
  expect(entry.qc.json.startsWith(dir)).toBe(false);

  // After a reload the Library still has the verdict (column and details).
  await page.reload();
  await page.waitForLoadState('networkidle');
  dialog = await openLibrary();
  await expect(rowOf().getByTestId('library-qc-verdict')).toHaveText(String(entry.qc.verdicts.overall).toUpperCase());
  await rowOf().click();
  await expect(dialog.getByTestId('library-details').getByTestId('qc-verdict-overall')).toBeVisible();
});
