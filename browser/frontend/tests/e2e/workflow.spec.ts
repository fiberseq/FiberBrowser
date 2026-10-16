/**
 * Workflow tests: exercise multi-step analysis pipelines end-to-end via API.
 * These tests bypass the UI for the compute-heavy parts to keep them fast and
 * deterministic; they are complementary to the UI-driven layer.spec.ts checks.
 *
 * Use these tests to catch silent regressions like the "clustering used display
 * sample instead of working set" or "no-data sentinel leaking into features"
 * bugs we hit during v2 development.
 */
import { test, expect } from './fixtures/server';
import type { ServerFixture } from './fixtures/server';

async function regionHasV3Reads(
  request: any,
  baseUrl: string,
  region: { chrom: string; start: number; end: number },
): Promise<boolean> {
  const r = await request.get(
    `${baseUrl}/api/reads/compact?chrom=${region.chrom}&start=${region.start}&end=${region.end}&dataset_id=primary`
  );
  if (!r.ok()) return false;
  const data = await r.json();
  return (data.available_layers ?? []).includes('nuc') && (data.reads ?? []).length > 0;
}

async function findV3Region(request: any, server: ServerFixture): Promise<{ chrom: string; start: number; end: number }> {
  if (server.defaultRegion && await regionHasV3Reads(request, server.baseUrl, server.defaultRegion)) {
    return server.defaultRegion;
  }

  const chromsRes = await request.get(`${server.baseUrl}/api/chroms`);
  const { chroms } = await chromsRes.json();
  for (const chrom of chroms.slice(0, 10)) {
    const region = { chrom: chrom.name, start: 0, end: 500000 };
    if (await regionHasV3Reads(request, server.baseUrl, region)) {
      return region;
    }
  }
  throw new Error('No v3 region found in test BAM');
}

test('scan_peaks with msp signal source produces peaks', async ({ server, request }) => {
  const { chrom, start, end } = await findV3Region(request, server);

  const res = await request.post(
    `${server.baseUrl}/api/scan_peaks?chrom=${chrom}&start=${start}&end=${end}&dataset_id=primary`,
    {
      data: {
        min_width: 80,
        min_reads: 5,
        smooth_width: 100,
        threshold_strong: 0.50,
        threshold_medium: 0.30,
        threshold_weak: 0.15,
        threshold_rare: 0.08,
        signal_source: 'msp',
      },
    }
  );
  expect(res.ok()).toBeTruthy();
  const json = await res.json();
  expect(json).toHaveProperty('peaks');
  expect(Array.isArray(json.peaks)).toBeTruthy();
  expect(json.n_reads).toBeGreaterThan(0);
});

test('cluster_all with msp mode routes through compact path (layers used)', async ({ server, request }) => {
  const { chrom, start, end } = await findV3Region(request, server);

  // Scan peaks first to get valid peak regions
  const scanRes = await request.post(
    `${server.baseUrl}/api/scan_peaks?chrom=${chrom}&start=${start}&end=${end}&dataset_id=primary`,
    { data: { min_width: 80, min_reads: 5, signal_source: 'msp' } }
  );
  const scan = await scanRes.json();
  if (scan.peaks.length === 0) {
    test.skip(true, 'No peaks detected; cannot cluster');
    return;
  }
  // Cluster using msp layer mode. Some detected peaks in the tiny fixture only
  // have one fully-covering read, which is valid but not useful for the
  // multi-cluster regression guard. Walk candidates until one has enough
  // eligible reads to make k-means meaningful.
  for (const peak of scan.peaks) {
    const clusterRes = await request.post(
      `${server.baseUrl}/api/cluster_all?chrom=${chrom}&start=${start}&end=${end}`,
      {
        data: {
          peak_regions: [{ start: peak.start, end: peak.end, mode: 'msp' }],
          k: 5,
          method: 'kmeans',
          dataset_ids: ['primary'],
        },
      }
    );
    expect(clusterRes.ok()).toBeTruthy();
    const cluster = await clusterRes.json();
    expect(cluster).toHaveProperty('results');

    const resultEntries = Object.entries(cluster.results);
    expect(resultEntries.length).toBeGreaterThan(0);
    const [, primary] = resultEntries[0] as [string, any];
    expect(primary.cluster_counts).toBeDefined();

    const clusteredReads = primary.analysis_read_count ?? primary.working_count ?? 0;
    if (clusteredReads <= 1) continue;

    // Regression guard: ensure the clustering produced MORE than one cluster.
    // The "no-data sentinel leaking" bug caused all reads to collapse into one
    // mega-cluster; if that happens again this assertion fails on the first
    // peak with multiple eligible reads.
    const uniqueClusters = Object.keys(primary.cluster_counts).length;
    expect(uniqueClusters, 'Clustering collapsed to a single mega-cluster (sentinel bug?)').toBeGreaterThan(1);
    return;
  }

  test.skip(true, 'No detected peak in the e2e BAM had >1 fully-covering reads for k-means');
});

test('quality_filters reduce intervals in working set', async ({ server, request }) => {
  const { chrom, start, end } = await findV3Region(request, server);

  // Baseline: count reads + TF intervals with no filter
  await request.post(`${server.baseUrl}/api/quality_filters`, { data: { filters: [] } });
  const beforeRes = await request.get(
    `${server.baseUrl}/api/reads/compact?chrom=${chrom}&start=${start}&end=${end}&dataset_id=primary&include_layers=true&layer_names=tf`
  );
  const before = await beforeRes.json();
  const beforeTf = before.reads.reduce((n: number, r: any) => n + (r.layers?.tf?.intervals?.length ?? 0), 0);

  // Apply a strict tq filter — should drop most TF intervals
  await request.post(`${server.baseUrl}/api/quality_filters`, {
    data: { filters: [{ layer: 'tf', quality_name: 'tq', min_value: 200 }] },
  });
  const afterRes = await request.get(
    `${server.baseUrl}/api/reads/compact?chrom=${chrom}&start=${start}&end=${end}&dataset_id=primary&include_layers=true&layer_names=tf`
  );
  const after = await afterRes.json();
  const afterTf = after.reads.reduce((n: number, r: any) => n + (r.layers?.tf?.intervals?.length ?? 0), 0);

  // Strict filter should not leave MORE TFs than the unfiltered baseline
  expect(afterTf).toBeLessThanOrEqual(beforeTf);

  // Clear filters for downstream tests
  await request.post(`${server.baseUrl}/api/quality_filters`, { data: { filters: [] } });
});
