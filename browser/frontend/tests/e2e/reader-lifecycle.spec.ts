import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/nativeDialogs';
import { DEMO_FIXTURE, pickRandomPort, startServer, stopServer } from './fixtures/server';

/** Repeatedly open, navigate and close a dataset in a live source server. */
test('dataset removal releases readers held by request workers', async ({ request }) => {
  test.skip(process.platform === 'win32', 'Descriptor inspection uses lsof');
  const server = await startServer(null, await pickRandomPort());
  const descriptors = () => execFileSync('lsof', ['-nP', '-p', String(server.pid), '-Ffn'], { encoding: 'utf8' })
    .split('\n').filter(line => line.startsWith('n') && line.includes(DEMO_FIXTURE.bamPath)).length;
  try {
    expect(descriptors()).toBe(0);
    for (let cycle = 0; cycle < 5; cycle++) {
      const added = await request.post(`${server.baseUrl}/api/datasets/add`, {
        data: { path: DEMO_FIXTURE.bamPath, id: 'cycle', label: 'Reads' },
      });
      expect(added.ok()).toBeTruthy();
      const datasets = await (await request.get(`${server.baseUrl}/api/datasets`)).json();
      const id = datasets.datasets[0].id;
      await Promise.all(Array.from({ length: 4 }, async (_, i) => {
        const r = DEMO_FIXTURE.region;
        const params = new URLSearchParams({ dataset_id: id, chrom: r.chrom,
          start: String(r.start + i * 100), end: String(r.end + i * 100), max_reads: '100' });
        const response = await request.get(`${server.baseUrl}/api/reads/compact?${params}`);
        expect(response.ok()).toBeTruthy();
        expect((await response.json()).reads.length).toBeGreaterThan(0);
      }));
      // One BAM and its index, regardless of the number of request workers.
      expect(descriptors()).toBeLessThanOrEqual(2);
      expect((await request.delete(`${server.baseUrl}/api/datasets/${id}`)).ok()).toBeTruthy();
      await expect.poll(descriptors).toBe(0);
    }
  } finally {
    await stopServer(server);
  }
});


test('panels share one request for the same dataset group', async ({ page }) => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'reader-batch-'));
  const copy = path.join(folder, 'second.bam');
  copyFileSync(DEMO_FIXTURE.bamPath, copy);
  copyFileSync(DEMO_FIXTURE.bamPath + '.bai', copy + '.bai');
  const server = await startServer(DEMO_FIXTURE.bamPath, await pickRandomPort(), {
    extraArgs: ['--dataset', copy],
  });
  try {
    await page.addInitScript(() => {
      (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    });
    const requests: URL[] = [];
    page.on('request', request => {
      if (request.url().includes('/api/reads/compact_all?')) requests.push(new URL(request.url()));
    });
    const r = DEMO_FIXTURE.region;
    await page.goto(`${server.baseUrl}/?chr=${r.chrom}&start=${r.start}&end=${r.end}`);
    await expect(page.locator('[data-read-track-loading="false"]')).toHaveCount(2, { timeout: 45_000 });
    const cohort = requests.filter(url => url.searchParams.get('start') === String(r.start));
    expect(cohort.length).toBeGreaterThan(0);
    // Performance initialization can invalidate the initial request. Both
    // panels must still share exactly one request within each generation.
    const generations = new Map<string | null, URL[]>();
    for (const url of cohort) {
      const generation = url.searchParams.get('refresh_generation');
      generations.set(generation, [...(generations.get(generation) ?? []), url]);
    }
    for (const batch of generations.values()) {
      expect(batch).toHaveLength(1);
      const identity = JSON.parse(batch[0].searchParams.get('source_identity')!);
      expect(identity).toHaveLength(2);
      expect(identity[0][1]).not.toBe(identity[1][1]);
    }
  } finally {
    await stopServer(server);
  }
});
