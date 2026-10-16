/**
 * Layer-aware behavior tests: with a v3-tagged BAM, the API should report
 * nuc/tf/msp layers, the UI should auto-discover toggles, and quality
 * filters should propagate through the working set.
 */
import { test, expect } from './fixtures/server';

test('v3 BAM exposes nuc/tf/msp layers in available_layers', async ({ server, request }) => {
  const chromsRes = await request.get(`${server.baseUrl}/api/chroms`);
  const { chroms } = await chromsRes.json();

  // The fixture's region first (the demo BAM's reads are on chr19), then scan chromosomes.
  const regions = [
    ...(server.defaultRegion ? [server.defaultRegion] : []),
    ...chroms.slice(0, 10).map((c: { name: string }) => ({ chrom: c.name, start: 0, end: 500000 })),
  ];
  let found = false;
  for (const region of regions) {
    const res = await request.get(
      `${server.baseUrl}/api/reads/compact?chrom=${region.chrom}&start=${region.start}&end=${region.end}&dataset_id=primary`
    );
    if (!res.ok()) continue;
    const data = await res.json();
    const layers = data.available_layers ?? [];
    if (layers.includes('nuc')) {
      expect(layers).toContain('nuc');
      // v3 iter17 BAM should have msp (at minimum from fallback generation)
      expect(layers).toContain('msp');
      found = true;
      break;
    }
  }
  expect(found, 'Expected at least one chromosome with nuc/msp layers').toBeTruthy();
});

test('quality filters endpoint accepts and reports filters', async ({ server, request }) => {
  // POST a filter
  const postRes = await request.post(`${server.baseUrl}/api/quality_filters`, {
    data: { filters: [{ layer: 'nuc', quality_name: 'nq', min_value: 128 }] },
  });
  expect(postRes.ok()).toBeTruthy();
  const postJson = await postRes.json();
  expect(postJson.active_filters).toBe(1);

  // GET to verify it stuck
  const getRes = await request.get(`${server.baseUrl}/api/quality_filters`);
  expect(getRes.ok()).toBeTruthy();
  const getJson = await getRes.json();
  expect(getJson.filters).toHaveLength(1);
  expect(getJson.filters[0]).toMatchObject({ layer: 'nuc', quality_name: 'nq', min_value: 128 });

  // Clear filters (tear down for other tests)
  await request.post(`${server.baseUrl}/api/quality_filters`, {
    data: { filters: [] },
  });
});

test('UI renders + available_layers propagate through /api/reads/compact', async ({ server, page, request }) => {
  // Track the API call to confirm available_layers appears in the response.
  // The UI auto-discovers layers via useReadTrackData.ts on any reads response.
  let layersFromApi: string[] | null = null;
  page.on('response', async res => {
    if (res.url().includes('/api/reads/compact') && res.ok()) {
      try {
        const json = await res.json();
        if (json.available_layers) layersFromApi = json.available_layers;
      } catch {
        // JSON parse error — ignore
      }
    }
  });
  const region = server.defaultRegion ?? { chrom: 'chr2L', start: 90000, end: 200000 };
  await page.goto(`${server.baseUrl}/?chrom=${region.chrom}&start=${region.start}&end=${region.end}`);
  await page.waitForLoadState('networkidle');
  // Give the frontend a moment to kick off the reads fetch
  await page.waitForTimeout(3000);
  // UI shell is present — canvas + sidebar root should exist
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 10_000 });
  // A known fixture region must have been fetched with its layers; otherwise
  // (a custom BAM without a region) only check them if reads were requested.
  if (server.defaultRegion) expect(layersFromApi, 'reads fetched for the fixture region').not.toBeNull();
  if (layersFromApi !== null) {
    expect(layersFromApi).toContain('nuc');
  }
});
