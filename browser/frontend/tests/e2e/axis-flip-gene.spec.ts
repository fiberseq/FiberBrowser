/**
 * Relative x-axis to a minus-strand gene and "Flip to gene direction" (3.1.1), on the tracked NAPA demo BAM:
 *
 *   a window on the metaprofile track → Quantify window → x-axis Relative, anchored at the TSS of a minus-strand gene
 *   whose TSS (its last base, end − 1) is the view centre → the track's axis strip reads downstream (+) on the left (genome order) → Flip to
 *   gene direction turns Reverse view on → the strip reads upstream (−) on the left and the button goes.
 *
 * The gene is added to the loaded annotation through the store (neutral name), so the spec needs no GTF.
 */
import { test, expect } from './fixtures/server';
import type { Page } from '@playwright/test';
import type { ServerFixture } from './fixtures/server';

test.use({ fixtureBam: 'demo' });

const getState = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => { const s = (window as any).__FIBERBROWSER_STORE__.getState(); return new Function('s', `return (${f})(s)`)(s); }, fn.toString()) as Promise<T>;

async function openAt(page: Page, server: ServerFixture) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');
  const r = server.defaultRegion!;
  const reads = page.waitForResponse(res => res.url().includes('/api/reads/compact'), { timeout: 45_000 }).catch(() => null);
  await page.getByTestId('location-search-input').fill(`${r.chrom}:${r.start}-${r.end}`);
  await page.getByTestId('location-search-submit').click();
  await reads;
  await page.waitForTimeout(1500);
}

const tickLabels = async (page: Page) =>
  JSON.parse((await page.getByTestId('quant-track-axis').first().getAttribute('data-ticks')) ?? '[]') as Array<[number, string]>;

test('relative axis to a minus-strand gene: Flip to gene direction turns Reverse view on and upstream reads left', async ({ server, page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await openAt(page, server);

  const view = await getState(page, s => ({ chrom: s.chrom, start: s.start, end: s.end }));
  const centre = Math.round((view.start + view.end) / 2);
  await page.evaluate(({ chrom, centre }) => {
    const st = (window as any).__FIBERBROWSER_STORE__.getState();
    st.setGenes([...st.genes, { id: 'GENEM', name: 'GENEM', chrom, start: centre - 5000, end: centre, strand: '-', biotype: 'protein_coding',
      exons: [{ start: centre - 5000, end: centre }] }]);
    st.setQuantWindow({ chrom, from: centre - 200, to: centre + 200 });
  }, { chrom: view.chrom, centre });
  expect(await getState(page, s => s.isReversed)).toBe(false);

  await page.getByTestId('quant-track-open').first().click();
  const host = page.getByTestId('quant-host-card');
  await expect(host).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('quant-host-axis-frame-relative').click();
  await page.getByTestId('quant-host-axis-frame-anchor').selectOption('tss');
  await page.getByTestId('quant-host-axis-frame-gene').selectOption('GENEM');
  await expect(page.getByTestId('quant-host-axis-frame')).toHaveAttribute('data-anchor', `${centre - 1}-`);
  await expect(page.getByTestId('quant-host-axis-frame-label')).toContainText('GENEM');

  // Genome order: the minus-strand gene's downstream (lower coordinates) is on the left, so the left ticks are positive.
  let ticks = await tickLabels(page);
  expect(ticks.length).toBeGreaterThanOrEqual(3);
  expect(ticks[0][1].startsWith('+')).toBe(true);
  expect(ticks[ticks.length - 1][1].startsWith('-')).toBe(true);
  expect(ticks.some(([, l]) => l === '0')).toBe(true);

  const flip = page.getByTestId('quant-host-axis-frame-flip');
  await expect(flip).toBeVisible();
  await flip.click();
  await expect.poll(() => getState(page, s => s.isReversed)).toBe(true);
  await expect(flip).toHaveCount(0);
  // Gene direction: upstream (negative) on the left, the anchor unchanged.
  await expect.poll(async () => (await tickLabels(page))[0]?.[1].startsWith('-')).toBe(true);
  ticks = await tickLabels(page);
  expect(ticks[ticks.length - 1][1].startsWith('+')).toBe(true);
  await expect(page.getByTestId('quant-host-axis-frame')).toHaveAttribute('data-anchor', `${centre - 1}-`);
  expect(errors).toEqual([]);
});
