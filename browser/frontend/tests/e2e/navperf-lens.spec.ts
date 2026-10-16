/**
 * Navigation with the insertion lens on too (its panel on "Insertions in view"): its background requests are
 * not duplicated either, and the reads load first (fixtures/navperf.ts).
 */
import { test, expect, panelButton } from './fixtures/server';
import { BAM, MEASURE, runNavperf } from './fixtures/navperf';

test.use({ fixtureBam: BAM || 'demo' });

test('navigation with the insertion lens: background requests are not duplicated and reads load first', async ({ page, server }) => {
  test.setTimeout(MEASURE ? 1_500_000 : 240_000);
  await runNavperf(page, server, {
    background: ['/api/insertions/clusters'],
    setup: async (p, inflight) => {
      // The insertion lens panel, on its "Insertions in view" list.
      await panelButton(p, 'insertion-lens').first().click();
      await p.locator('[data-analysis-tab="insertions"]').first().click();
      await expect.poll(() => inflight('/api/insertions/clusters'), { timeout: 180_000 }).toBe(0);
    },
  });
});
