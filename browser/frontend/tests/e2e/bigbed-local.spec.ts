/**
 * Local rich-fixture BigBed smoke test.
 *
 * Uses one representative standard Fiber-seq BigBed from the 2-4hr set when
 * present on the maintainer/development machine. This keeps the default e2e
 * suite fast while still exercising the BigBed parser against real data.
 */
import { test, expect } from './fixtures/server';

const CURRENT_FIBER_REGION = { chrom: 'chrX', start: 23_300_000, end: 23_310_000 };

async function removeLoadedDatasets(request: any, baseUrl: string) {
  const response = await request.get(`${baseUrl}/api/datasets`);
  const payload = await response.json();
  for (const dataset of payload.datasets ?? []) {
    await request.delete(`${baseUrl}/api/datasets/${encodeURIComponent(dataset.id)}`);
  }
}

test('standard Fiber-seq BigBed loads inferred nuc/tf/msp layers', async ({ server, request }) => {
  if (!server.fiberBigBedPath) {
    test.skip(true, 'No local standard Fiber-seq BigBed fixture configured');
    return;
  }

  const add = await request.post(`${server.baseUrl}/api/datasets/add`, {
    data: { path: server.fiberBigBedPath, label: 'standard fiber bigbed e2e' },
  });
  expect(add.ok()).toBeTruthy();
  const addPayload = await add.json();
  expect(addPayload.success).toBeTruthy();
  const datasetId = addPayload.dataset.id;

  expect(addPayload.dataset.available_layers).toMatchObject({
    footprint: true,
    nuc: true,
    tf: true,
    msp: true,
  });

  const region = server.defaultRegion ?? { chrom: 'chr2R', start: 9_929_319, end: 10_029_319 };
  const reads = await request.get(
    `${server.baseUrl}/api/reads/compact?chrom=${region.chrom}&start=${region.start}&end=${region.end}&dataset_id=${datasetId}&include_layers=true&layer_names=nuc,tf,msp`
  );
  expect(reads.ok()).toBeTruthy();
  const payload = await reads.json();
  expect(payload.available_layers).toContain('nuc');
  expect(payload.available_layers).toContain('tf');
  expect(payload.available_layers).toContain('msp');
  expect(payload.reads.length).toBeGreaterThan(0);
  expect(payload.reads.some((r: any) => (r.layers?.nuc?.intervals?.length ?? 0) > 0)).toBeTruthy();
  expect(payload.reads.some((r: any) => (r.layers?.tf?.intervals?.length ?? 0) > 0)).toBeTruthy();
  expect(payload.reads.some((r: any) => (r.layers?.msp?.intervals?.length ?? 0) > 0)).toBeTruthy();
});
