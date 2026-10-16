/**
 * Navigation with the background panels on (fixtures/navperf.ts): background requests are not duplicated and the
 * reads load first.
 */
import { test } from './fixtures/server';
import { BAM, MEASURE, runNavperf } from './fixtures/navperf';

test.use({ fixtureBam: BAM || 'demo' });

test('navigation: background requests are not duplicated and reads load first', async ({ page, server }) => {
  test.setTimeout(MEASURE ? 1_500_000 : 240_000);
  await runNavperf(page, server, {});
});
