import { test, expect } from './fixtures/server';
import { decodeReadBinary, READ_BINARY_TYPE } from '../../src/api/readBinary';

test('binary compact reads preserve the JSON evidence and counts', async ({ server, request }) => {
  const region = server.defaultRegion!;
  expect(region).toBeTruthy();
  const query = new URLSearchParams({ chrom: region.chrom, start: String(region.start), end: String(region.end),
    max_reads: '1000', include_layers: 'true', include_methylation: 'true',
    include_layer_qualities: 'true', hide_terminal_gaps: 'false', min_footprints: '0' });
  const url = `${server.baseUrl}/api/reads/compact?${query}`;
  const json = await (await request.get(url)).json();
  const response = await request.get(url, { headers: { Accept: READ_BINARY_TYPE } });
  expect(response.headers()['content-type']).toContain(READ_BINARY_TYPE);
  const body = await response.body();
  const decoded = decodeReadBinary(Uint8Array.from(body).buffer);
  expect(decoded.reads.length).toBeGreaterThan(0);
  expect(decoded.reads).toEqual(json.reads);
  for (const field of ['count', 'total', 'working_count', 'total_overlapping', 'total_spanning', 'available_layers']) {
    expect(decoded[field]).toEqual(json[field]);
  }
});

test('returning to a complete loaded viewport reuses decoded reads', async ({ server, page }) => {
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
  });
  const region = server.defaultRegion!;
  await page.goto(`${server.baseUrl}/?chr=${region.chrom}&start=1&end=2001`);
  await page.waitForFunction(() => (window as any).__FIBERBROWSER_STORE__?.getState().datasets.length);
  // Machine settings arrive asynchronously during startup. Apply the test's
  // explicit full-cohort options once that initialization has settled.
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => {
    const store = (window as any).__FIBERBROWSER_STORE__;
    for (const dataset of store.getState().datasets) store.getState().setLoadAllReads(dataset.id, true);
    store.setState({ peaksLocked: true, peakRules: store.getState().peakRules.map((r: any) => ({ ...r, enabled: false })), readDisplayMode: 'all', allReadsDisplayCap: 200000, backgroundReadCap: null,
      minFootprints: 0, minFootprintsAuto: false, hideTerminalGaps: false, terminalGapThreshold: 0 });
  });
  await page.waitForLoadState('networkidle');
  let requests = 0;
  page.on('request', request => { if (request.url().includes('/api/reads/compact?')) requests++; });
  const visit = async (start: number, end: number) => {
    await page.evaluate(({ chrom, start, end }) => {
      (window as any).__FIBERBROWSER_STORE__.getState().setViewport(chrom, start, end);
    }, { chrom: region.chrom, start, end });
    await page.waitForFunction(({ start, end }) => {
      const values: any[] = Object.values((window as any).__FIBERBROWSER_STORE__.getState().readTrackStatus);
      return values.some(s => s.start === start && s.end === end && !s.loading && !s.stale && !s.fetchFailed);
    }, { start, end });
    await page.waitForLoadState('networkidle');
  };
  await visit(region.start, region.end);
  const counts = await page.evaluate(() => Object.values((window as any).__FIBERBROWSER_STORE__.getState().readTrackStatus).map((s: any) => s.working));
  expect(counts.some(count => Number(count) > 0)).toBe(true);
  await visit(1, 2001);
  const before = requests;
  await visit(region.start, region.end);
  expect(requests).toBe(before);
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.setState({ minFootprints: 1 }));
  await expect.poll(() => requests).toBeGreaterThan(before);
});

test('contained projections preserve molecular layers and uncapped summaries', async ({ server, request }) => {
  const { projectLoadedReads } = await import('../../src/api/loadedReadRegion');
  const { readRegionProfiles } = await import('../../src/api/readRegionProfiles');
  const region = server.defaultRegion!;
  const width = region.end - region.start;
  const loadedStart = Math.max(0, region.start - Math.ceil(width / 2));
  const loadedEnd = region.end + Math.ceil(width / 2);
  const query = new URLSearchParams({ chrom: region.chrom, start: String(loadedStart), end: String(loadedEnd),
    max_reads: '0', full_working_set: 'true', spanning: 'false', include_layers: 'true', layer_names: 'nuc,tf',
    include_methylation: 'true', include_layer_qualities: 'true', hide_terminal_gaps: 'false', terminal_gap_threshold: '0',
    min_footprints: '0', include_metaprofile: 'true', profile_max_reads: '0', metaprofile_layers: 'nuc,tf' });
  const response = await request.get(`${server.baseUrl}/api/reads/compact?${query}`, { headers: { Accept: READ_BINARY_TYPE } });
  const loaded = decodeReadBinary(Uint8Array.from(await response.body()).buffer);
  const normalize = (reads: any[]) => JSON.parse(JSON.stringify(reads.map(read => ({ ...read,
    ...(read.layers ? { layers: Object.fromEntries(Object.entries(read.layers).filter(([, layer]: any) => layer.intervals?.length)) } : {}),
    // A read's full SV evidence: the server sends `sv_evidence` only where it differs from `sv`, while a projection
    // always keeps it explicitly (loadedReadRegion.ts); consumers read `sv_evidence ?? sv`.
    ...((read.sv_evidence ?? read.sv) ? { sv_evidence: read.sv_evidence ?? read.sv } : {}),
  })).sort((a, b) => a.id.localeCompare(b.id))));
  let checked = 0;
  for (const [start, end] of [[region.start, region.end], [region.start + Math.floor(width / 4), region.end - Math.floor(width / 4)]]) {
    const projected = projectLoadedReads(loaded, start - loadedStart, end - start, loadedStart);
    // Unsupported breakpoint/circular geometry must fetch rather than guess.
    if (!projected) continue;
    checked++;
    query.set('start', String(start)); query.set('end', String(end));
    const fresh = await (await request.get(`${server.baseUrl}/api/reads/compact?${query}`)).json();
    expect(normalize(projected.reads)).toEqual(normalize(fresh.reads));
    expect(projected.total_overlapping).toBe(fresh.total_overlapping);
    expect(projected.total_spanning).toBe(fresh.total_spanning);
    if (projected.reads.length) expect(readRegionProfiles(projected.reads, end - start, ['nuc', 'tf'])).toEqual(fresh.metaprofile);
    expect(projected.sv_summary).toEqual(fresh.sv_summary);
  }
  expect(checked).toBeGreaterThan(0);
});

test('streamed frames preserve the complete cohort and draw before completion', async ({ server, page, request }) => {
  const { decodeReadStream, READ_STREAM_TYPE } = await import('../../src/api/readStream');
  const region = server.defaultRegion!;
  const query = new URLSearchParams({ chrom: region.chrom, start: String(region.start), end: String(region.end),
    max_reads: '0', full_working_set: 'true', spanning: 'false',
    include_layers: 'true', layer_names: 'nuc,tf', include_methylation: 'true', include_layer_qualities: 'true',
    hide_terminal_gaps: 'false', terminal_gap_threshold: '0', min_footprints: '0',
    include_metaprofile: 'true', profile_max_reads: '0' });
  const url = `${server.baseUrl}/api/reads/compact?${query}`;
  const partial: number[] = [];
  const response = await fetch(url, { headers: { Accept: READ_STREAM_TYPE } });
  expect(response.headers.get('content-type')).toContain(READ_STREAM_TYPE);
  const streamed = await decodeReadStream(response, data => partial.push(data.reads.length));
  const json = await (await request.get(url)).json();
  expect(streamed.reads).toEqual(json.reads);
  expect(streamed.working_count).toBe(json.working_count);
  expect(streamed.metaprofile).toEqual(json.metaprofile);
  expect(streamed.sv_summary).toEqual(json.sv_summary);
  expect(partial.length).toBeGreaterThan(0);

  // Hold the completion record to inspect the display/analysis boundary.
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (!response.headers.get('content-type')?.includes('reads.stream.v1')) return response;
      const bytes = new Uint8Array(await response.arrayBuffer());
      const first = bytes.length >= 4 ? new DataView(bytes.buffer).getUint32(0, true) + 4 : bytes.length;
      if (first === bytes.length) return new Response(bytes, { headers: response.headers });
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(bytes.slice(0, first));
        setTimeout(() => { controller.enqueue(bytes.slice(first)); controller.close(); }, 1500);
      } }), { headers: response.headers });
    };
  });
  await page.goto(`${server.baseUrl}/?chr=${region.chrom}&start=1&end=2001`);
  await page.waitForFunction(() => (window as any).__FIBERBROWSER_STORE__?.getState().datasets.length);
  // Machine settings arrive asynchronously during startup. Apply the test's
  // explicit full-cohort options once that initialization has settled.
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => {
    const store = (window as any).__FIBERBROWSER_STORE__;
    for (const dataset of store.getState().datasets) store.getState().setLoadAllReads(dataset.id, true);
    store.setState({ minFootprints: 0, minFootprintsAuto: false, hideTerminalGaps: false, terminalGapThreshold: 0,
      readDisplayMode: 'all', allReadsDisplayCap: 200000, backgroundReadCap: null });
  });
  await page.waitForLoadState('networkidle');
  // The API comparison used this region already; clear server caches with a
  // read-option change so this visit also exercises incremental decoding.
  await page.evaluate(({ chrom, start, end }) => {
    const store = (window as any).__FIBERBROWSER_STORE__;
    store.setState({ showDuplicateReads: true });
    store.getState().setViewport(chrom, start, end);
  }, region);
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('[data-read-track-loading="true"]')]
    .some(track => Number(track.dataset.readTrackRenderCount) > 0));
  expect(await page.evaluate(() => Object.values((window as any).__FIBERBROWSER_STORE__.getState().activeReadIds)
    .every(ids => (ids as string[]).length === 0))).toBe(true);
  await page.waitForFunction(() => {
    const tracks = [...document.querySelectorAll<HTMLElement>('[data-read-track-dataset-id]')];
    return tracks.length > 0 && tracks.every(track => track.dataset.readTrackLoading === 'false' && Number(track.dataset.readTrackRenderCount) > 0);
  });
});
