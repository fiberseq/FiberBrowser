/**
 * Release GUI workflow tests: click real analysis-panel and toolbar controls.
 * Compute-heavy correctness stays in API parity tests; these guards catch the
 * common release failures where a panel, toolbar button, or async status path
 * gets disconnected from the working backend.
 */
import { test, expect, panelButton, panelLaunchers } from './fixtures/server';
import type { ServerFixture } from './fixtures/server';

async function gotoFresh(page: any, url: string) {
  await page.addInitScript(() => {
    window.__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.goto(url);
  await page.waitForLoadState('networkidle');
  await expect(panelLaunchers(page)).toBeVisible();
}

async function gotoFreshRegion(
  page: any,
  server: ServerFixture,
  region: { chrom: string; start: number; end: number },
) {
  await gotoFresh(page, server.baseUrl);
  const input = page.getByTestId('location-search-input');
  const compactResponsePromise = page.waitForResponse(
    response => response.url().includes('/api/reads/compact') && response.request().method() === 'GET',
    { timeout: 45_000 },
  ).catch(() => null);
  await input.fill(`${region.chrom}:${region.start}-${region.end}`);
  await page.getByTestId('location-search-submit').click();
  await expect(input).toHaveValue(
    `${region.chrom}:${region.start.toLocaleString()}-${region.end.toLocaleString()}`,
    { timeout: 10_000 },
  );
  await compactResponsePromise;
}

async function regionHasReads(
  request: any,
  baseUrl: string,
  region: { chrom: string; start: number; end: number },
  spanning = false,
): Promise<boolean> {
  const res = await request.get(
    `${baseUrl}/api/reads/compact?chrom=${region.chrom}&start=${region.start}&end=${region.end}&dataset_id=primary&spanning=${spanning}`,
  );
  if (!res.ok()) return false;
  const data = await res.json();
  return (data.reads ?? []).length > 0;
}

function centeredRegion(
  region: { chrom: string; start: number; end: number },
  width: number,
): { chrom: string; start: number; end: number } {
  const center = Math.floor((region.start + region.end) / 2);
  const half = Math.floor(width / 2);
  return { chrom: region.chrom, start: Math.max(0, center - half), end: center + half };
}

async function findReadRegion(
  request: any,
  server: ServerFixture,
): Promise<{ chrom: string; start: number; end: number }> {
  if (server.defaultRegion) {
    const centered = centeredRegion(server.defaultRegion, 10_000);
    if (await regionHasReads(request, server.baseUrl, centered, true)) return centered;
    if (await regionHasReads(request, server.baseUrl, server.defaultRegion)) return server.defaultRegion;
  }

  const chromsRes = await request.get(`${server.baseUrl}/api/chroms`);
  const { chroms } = await chromsRes.json();
  for (const chrom of chroms.slice(0, 12)) {
    const region = { chrom: chrom.name, start: 0, end: 500000 };
    if (await regionHasReads(request, server.baseUrl, region)) return region;
  }
  throw new Error('No readable region found for release GUI workflow test');
}

test('analysis strip opens and closes core release panels', async ({ server, page, request }) => {
  const region = await findReadRegion(request, server);
  await gotoFreshRegion(page, server, region);

  // Peak rules live in Analysis Rules > Peaks since v1 (the stand-alone
  // peak-detection panel is hidden from the strip, AnalysisStrip.tsx), so the
  // strip opens the Rules panel; its Peaks tab is checked in the toolbar test.
  const panels = [
    { id: 'cluster-features', marker: /Cluster Rules/i },
    // Footprints opens on its Classes tab (the consensus launcher), not an empty-selection note.
    // The launcher reads 'Find footprint classes' when the BAM header declares its assay (the
    // demo BAM) and 'Set up datasets to continue' when it does not (lab BAMs without a
    // FIBERHMM-CHEMISTRY @CO line). A bare getByText would also match the hidden
    // Compare-strands note ('Find footprint classes above first…').
    { id: 'footprint-analysis', marker: /Find footprint classes|Set up datasets to continue/i, role: 'button' as const },
    { id: 'co-accessibility', marker: /Co-accessibility/i },
    { id: 'transcription-state', marker: /Select a gene/i },
    { id: 'cluster-detail', marker: /No clusters computed/i },
    { id: 'primer-design', marker: /Select peaks to define the target/i },
    // The 'history' panel is the Tutorial panel now (guided tour + Copilot); the
    // undo history itself opens from the Undo/Redo toolbar (release-v1-workflows).
    { id: 'history', marker: /Take the guided tour/i },
  ];

  for (const panel of panels) {
    const button = panelButton(page, panel.id);
    await expect(button, `${panel.id} launcher`).toBeVisible();
    await button.click();
    await expect(button, `${panel.id} active state`).toHaveAttribute('aria-pressed', 'true');
    const marker = panel.role ? page.getByRole(panel.role, { name: panel.marker }) : page.getByText(panel.marker);
    await expect(marker.first(), `${panel.id} rendered marker`).toBeVisible({ timeout: 10_000 });
    await button.click();
    await expect(button, `${panel.id} inactive state`).toHaveAttribute('aria-pressed', 'false');
  }
});

test('peak scan, lock, and rules controls stay wired through the toolbar', async ({ server, page, request }) => {
  const region = await findReadRegion(request, server);
  await gotoFreshRegion(page, server, region);

  await page.getByTestId('toolbar-group-toggle-peaks').click();
  const scan = page.getByTestId('peak-scan-button');
  const lock = page.getByTestId('peak-lock-toggle');

  await expect(scan).toBeEnabled({ timeout: 15_000 });
  const scanResponsePromise = page.waitForResponse(
    response => response.url().includes('/api/scan_peaks') && response.request().method() === 'POST',
    { timeout: 45_000 },
  );
  await scan.click();
  const scanResponse = await scanResponsePromise;
  expect(scanResponse.ok()).toBeTruthy();
  const scanPayload = await scanResponse.json();
  if ((scanPayload.peaks ?? []).length === 0) {
    test.skip(true, 'No peaks detected in this fixture region; peak-lock wiring cannot be validated');
    return;
  }

  await expect(lock).toBeEnabled({ timeout: 10_000 });
  await lock.click();
  await expect(lock).toHaveAttribute('aria-pressed', 'true');
  await expect(lock).toContainText('Locked');
  await expect(scan).toBeDisabled();

  await lock.click();
  await expect(lock).toHaveAttribute('aria-pressed', 'false');
  await expect(scan).toBeEnabled();

  // "Rules" opens Analysis Rules on its Peaks tab (the peak rules editor).
  await page.getByTestId('peak-rules-button').click();
  await expect(panelButton(page, 'cluster-features')).toHaveAttribute('aria-pressed', 'true');
  const rules = page.locator('[data-panel-content-type="cluster-features"]');
  await expect(rules.locator('[data-analysis-tab="peaks"]')).toBeVisible();
  await expect(rules.getByRole('button', { name: 'Add rule', exact: true })).toBeVisible();
});

test('co-accessibility refresh renders metadata and clears loading status', async ({ server, page, request }) => {
  const region = await findReadRegion(request, server);
  await gotoFreshRegion(page, server, region);

  await panelButton(page, 'co-accessibility').click();
  await expect(page.getByTestId('coacc-matrix-canvas')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('coacc-metadata')).toContainText(/reads/, { timeout: 45_000 });

  const metadataResponsePromise = page.waitForResponse(
    response => response.url().includes('/api/coacc/metadata') && response.ok(),
    { timeout: 45_000 },
  );
  await page.getByTestId('coacc-refresh-button').click();
  await metadataResponsePromise;
  await expect(page.getByTestId('coacc-status')).toContainText(/Matrix refreshed/i, { timeout: 45_000 });
  await expect(page.getByTestId('coacc-metadata')).toContainText(/bins/);
  await expect(page.getByText('Computing matrix...')).toHaveCount(0);
});
