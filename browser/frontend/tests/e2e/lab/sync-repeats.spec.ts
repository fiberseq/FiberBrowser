import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test as base, expect, pickRandomPort, startServer } from '../fixtures/server';

// Three synthetic copies of one sequence (separated, or adjacent), generated per run in /tmp.
const test = base.extend<{ adjacent: boolean }>({
  adjacent: [false, { option: true }],
  server: async ({ adjacent }, use) => {
    const scratch = mkdtempSync('/tmp/fb-repeat-e2e-');
    execFileSync(process.env.FIBERBROWSER_TEST_PYTHON ?? 'python', ['-c', `
import sys, random, pysam
from pathlib import Path
from array import array
p=Path(sys.argv[1]); rng=random.Random(890)
dna=lambda n: ''.join(rng.choices('ACGT', k=n))
r=dna(500 if sys.argv[2] == 'true' else 472)
s=dna(300)+r*3+dna(300) if sys.argv[2] == 'true' else dna(350)+r+dna(300)+r+dna(300)+r+dna(350)
(p/'reference.fasta').write_text('>copies\\n'+s+'\\n'); pysam.faidx(str(p/'reference.fasta'))
with pysam.AlignmentFile(str(p/'3x.bam'),'wb',header={'HD':{'VN':'1.6','SO':'coordinate'},'SQ':[{'SN':'copies','LN':len(s)}]}) as out:
    for i in range(40):
        a=pysam.AlignedSegment(out.header); a.query_name=f'r{i}'; a.query_sequence=s
        a.reference_id=0; a.reference_start=0; a.mapping_quality=60; a.cigarstring=f'{len(s)}M'
        a.set_tag('ns',array('I',range(50+i%30,len(s)-160,250))); a.set_tag('nl',array('I',[150]*len(range(50+i%30,len(s)-160,250))))
        out.write(a)
pysam.index(str(p/'3x.bam'))
`, scratch, String(adjacent)]);
    const port = await pickRandomPort();
    const bamPath = path.join(scratch, '3x.bam');
    const proc = await startServer(bamPath, port, { extraArgs: ['--fasta', path.join(scratch, 'reference.fasta')] });
    try { await use({ port: proc.port, baseUrl: proc.baseUrl, bamPath }); }
    finally {
      proc.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 500));
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      rmSync(scratch, { recursive: true, force: true });
    }
  },
});

for (const adjacent of [false, true]) test.describe(adjacent ? 'Adjacent copies' : 'Separated copies', () => {
  test.use({ adjacent });
  test('one window finds three copies, saves a matched group and opens each copy as a panel', async ({ page, server }, info) => {
    test.setTimeout(120_000);
    await page.addInitScript(() => {
      (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
      (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
      localStorage.clear(); sessionStorage.clear();
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(server.baseUrl); await page.waitForLoadState('networkidle');
    await page.evaluate(({ adjacent }) => {
      const s = (window as any).__FIBERBROWSER_STORE__.getState();
      const panel = s.panels.find((p: any) => p.contentType === 'dataset');
      s.setNavigationMode('perPanel');
      s.navigatePanel(panel.id, 'copies', 0, adjacent ? 2100 : 2716);
      s.openAnalysisPanel('sync-regions');
    }, { adjacent });
    await expect(page.getByTestId('sync-find')).toHaveText('Find repeats in this window');
    await expect(page.getByTestId('sync-metric-sequence-input')).toBeEnabled();
    await page.getByTestId('sync-metric-sequence-input').check();
    await page.getByTestId('sync-find').click();
    const group = page.locator('[data-testid^="sync-repeat-group-"]').filter({ hasText: '3 copies' }).first();
    await expect(group).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-testid^="sync-bar-repeat-"]')).toHaveCount(1);
    await group.click();
    await expect(page.locator('[data-testid^="sync-refine-row-"]')).toHaveCount(3);
    await expect(page.getByTestId('sync-accept')).toBeEnabled();
    await page.getByTestId('sync-map').screenshot({ path: info.outputPath('repeat-map.png') });
    await page.getByTestId('sync-accept').click();
    const frame = await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().comparisonFrames[0]);
    expect(frame.windows.map((w: any) => w.copy)).toEqual(['a', 'b', 'c']);
    expect(new Set(frame.windows.map((w: any) => w.panelId)).size).toBe(1);
    const starts = adjacent ? [300, 800, 1300] : [350, 1122, 1894];
    frame.windows.forEach((w: any, i: number) => expect(Math.abs(w.start - starts[i])).toBeLessThan(20));
    await info.attach('copies', { body: JSON.stringify(frame, null, 2), contentType: 'application/json' });
    await page.locator('[data-testid^="sync-group-open-panels-"]').first().click();
    await expect(page.getByTestId('split-group-strip')).toContainText('3 regions');
    await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().panels.filter((p: any) => p.regionPanelGroup).length)).toBe(3);
  });
});

test('circular copies save once each with the full origin-spanning match', async ({ page, server }) => {
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    localStorage.clear(); sessionStorage.clear();
  });
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    const panel = s.panels.find((p: any) => p.contentType === 'dataset');
    s.setNavigationMode('perPanel');
    s.navigatePanel(panel.id, 'copies', 0, 1900);
    s.openAnalysisPanel('sync-regions');
  });
  let result: unknown;
  await page.route('**/api/lab/region-sync/jobs', async route => {
    const { windows } = route.request().postDataJSON();
    const id = windows[0].panelId;
    const match = { id: 'full', panelId: id, partnerId: id, rank: 0, template: [1650, 2151], window: [550, 1051], strand: '+', sources: ['sequence'], metrics: { sequence: { verdict: 'supports', score: 1 } }, status: 'single-metric', confidence: 1, supports: 1, assessed: 1 };
    result = { windows, metrics: ['sequence'], proposals: [{ ...match, id: 'clipped', template: [800, 1051], window: [1900, 2151] }, match], circular: { [id]: 1900 }, coverage: { [id]: Array.from({ length: 30 }, () => [[0, 1900]]) }, notes: [] };
    await route.fulfill({ json: { id: 'circular', state: 'queued', message: 'Queued', result: null } });
  });
  await page.route('**/api/lab/region-sync/jobs/circular', route => route.fulfill({ json: { id: 'circular', state: 'complete', message: 'Ready', result } }));
  await page.getByTestId('sync-find').click();
  const group = page.locator('[data-testid^="sync-repeat-group-"]').filter({ hasText: 'copy a ↔ copy b' });
  await expect(group).toHaveCount(1);
  await group.click();
  await expect(page.locator('[data-testid^="sync-refine-row-"]')).toHaveCount(2);
  await expect(page.getByTestId('sync-accept')).toBeEnabled();
  await page.getByTestId('sync-accept').click();
  const frame = await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().comparisonFrames[0]);
  expect(frame.length).toBe(501);
  expect(frame.windows.map((w: any) => [w.start, w.end])).toEqual([[550, 1051], [1650, 2151]]);
  expect(frame.windows[1].blocks.map((b: any) => b.genomic)).toEqual([[1650, 1900], [1900, 2151]]);
});
