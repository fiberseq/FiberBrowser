/**
 * Synchronise regions across three windows with the real region-sync job (coverage plan #18): sync-multi.spec.ts
 * answers the job with route.fulfill, so it never checks that the server's job finds a block shared by three
 * windows. Here nothing is faked: three panels each sit on one copy of a synthetic repeated sequence (generated per
 * run), the job maps them by sequence (minimap2), and the accepted block is one frame over all three windows.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { test as base, expect, pickRandomPort, startServer } from '../fixtures/server';

const HAS_MINIMAP2 = spawnSync('minimap2', ['--version']).status === 0;
// Copy layout (see the script): 350 bp, copy, 300 bp, copy, 300 bp, copy, 350 bp; each copy 472 bp.
const COPY = 472;
const COPY_STARTS = [350, 350 + COPY + 300, 350 + 2 * (COPY + 300)];
const FLANK = 50;

const test = base.extend({
  server: async ({}, use) => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'fb-sync3-e2e-'));
    execFileSync(process.env.FIBERBROWSER_TEST_PYTHON ?? 'python', ['-c', `
import sys, random, pysam
from pathlib import Path
from array import array
p=Path(sys.argv[1]); rng=random.Random(891)
dna=lambda n: ''.join(rng.choices('ACGT', k=n))
r=dna(472)
s=dna(350)+r+dna(300)+r+dna(300)+r+dna(350)
(p/'reference.fasta').write_text('>copies\\n'+s+'\\n'); pysam.faidx(str(p/'reference.fasta'))
with pysam.AlignmentFile(str(p/'3x.bam'),'wb',header={'HD':{'VN':'1.6','SO':'coordinate'},'SQ':[{'SN':'copies','LN':len(s)}]}) as out:
    for i in range(40):
        a=pysam.AlignedSegment(out.header); a.query_name=f'r{i}'; a.query_sequence=s
        a.reference_id=0; a.reference_start=0; a.mapping_quality=60; a.cigarstring=f'{len(s)}M'
        starts=list(range(50+i%30,len(s)-160,250))
        a.set_tag('ns',array('I',starts)); a.set_tag('nl',array('I',[150]*len(starts)))
        out.write(a)
pysam.index(str(p/'3x.bam'))
`, scratch]);
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

test('three windows, real job: one sequence block shared by all three becomes one frame', async ({ page, server }) => {
  test.skip(!HAS_MINIMAP2, 'minimap2 is not installed (region-sync maps sequence blocks with it)');
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    localStorage.clear(); sessionStorage.clear();
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(server.baseUrl); await page.waitForLoadState('networkidle');
  const ids: string[] = await page.evaluate(({ starts, copy, flank }) => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    const first = s.panels.find((p: any) => p.contentType === 'dataset');
    const ids = [first.id, s.duplicatePanel(first.id), s.duplicatePanel(first.id)];
    s.setNavigationMode('perPanel');
    ids.forEach((id: string, i: number) => s.navigatePanel(id, 'copies', starts[i] - flank, starts[i] + copy + flank));
    s.openAnalysisPanel('sync-regions');
    return ids;
  }, { starts: COPY_STARTS, copy: COPY, flank: FLANK });
  for (const id of ids) await expect(page.getByTestId(`sync-window-${id}`)).toBeVisible();
  await expect(page.getByTestId('sync-metric-sequence-input')).toBeEnabled();
  await page.getByTestId('sync-metric-sequence-input').check();
  const jobPosted = page.waitForResponse(r => r.url().endsWith('/api/lab/region-sync/jobs') && r.request().method() === 'POST');
  await page.getByTestId('sync-find').click();
  expect((await jobPosted).ok()).toBe(true);
  // The real job's blocks: every block lists a member in each of the three windows.
  const inputs = page.locator('[data-testid^="sync-member-"] input');
  await expect.poll(() => inputs.count(), { timeout: 120_000 }).toBeGreaterThanOrEqual(3);
  expect((await inputs.count()) % 3).toBe(0);
  await expect(page.getByTestId('sync-accept-blocks')).toBeEnabled();
  await page.getByTestId('sync-accept-blocks').click();
  const frames = await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().comparisonFrames);
  expect(frames.length).toBeGreaterThan(0);
  for (const frame of frames) {
    expect(frame.windows).toHaveLength(3);
    // The frame's windows lie one on each copy, at the same offset into it (the copies are identical): sorted, their
    // starts step by one copy period.
    const starts = frame.windows.map((w: any) => w.start).sort((a: number, b: number) => a - b);
    const period = COPY_STARTS[1] - COPY_STARTS[0];
    expect(Math.abs(starts[1] - starts[0] - period)).toBeLessThanOrEqual(5);
    expect(Math.abs(starts[2] - starts[1] - period)).toBeLessThanOrEqual(5);
    expect(starts[0]).toBeGreaterThanOrEqual(COPY_STARTS[0] - FLANK);
    for (const w of frame.windows) expect(w.end - w.start).toBeGreaterThan(100);
  }
  expect(errors).toEqual([]);
});
