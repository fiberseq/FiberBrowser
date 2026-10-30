/** Browser gates for the synthetic M1 corpus; restores and saves use the toolbar. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test as base, expect, panelButton, pickRandomPort, startServer, stopServer } from './fixtures/server';

// JSON from an older release deliberately has no dependency on today's TS schema.
type JsonState = Record<string, any>;
const frontendDir = fileURLToPath(new URL('../..', import.meta.url));
const corpusDir = path.resolve(frontendDir, '../../tests/fixtures/sessions');
const exportDir = path.join(frontendDir, 'test-results/session-exports');
const corpus = readdirSync(corpusDir).filter(name => /^301-.*\.json$/.test(name) || name === '30x-graph-differences.json').sort();

// A fixed UI contract: do not derive expected titles from the current registry.
const titles: Record<string, string> = {
  'dataset-layout': 'Layout', colormap: 'Labeling', 'cluster-detail': 'Clusters',
  'cluster-features': 'Rules', 'transcription-state': 'Transcription',
  'footprint-analysis': 'Footprints', 'contact-map': 'Contacts', 'read-stats': 'Read Stats',
  'primer-design': 'Primers', history: 'Tutorial', 'track-browser': 'Tracks',
  'co-accessibility': 'Co-accessibility', annotations: 'Annotations', capture: 'Capture Regions',
  'peak-detection': 'Peak Detection', 'sync-regions': 'Synchronise regions',
  'circular-genome': 'Regions', accessibility: 'NFRs', variants: 'Variants',
  'insertion-lens': 'Insertion lens', 'graph-view': 'Graph view',
  // This corpus kind has no registered standalone panel in the cited build:
  // it retains the generic header, while Differences state has its own bridge.
  differences: 'differences',
};

let bamPath: string;
const test = base.extend({
  server: async ({}, use) => {
    const proc = await startServer(bamPath, await pickRandomPort());
    try { await use({ port: proc.port, baseUrl: proc.baseUrl, bamPath }); }
    finally { await stopServer(proc); }
  },
});

test.beforeAll(() => {
  // Kept for the coordinator's subsequent release replay. /tmp paths are portable
  // on this host and contain no account-specific directories in exported JSON.
  const scratch = mkdtempSync('/tmp/fiberbrowser-session-migration-');
  bamPath = path.join(scratch, 'sample.bam');
  execFileSync(process.env.FIBERBROWSER_TEST_PYTHON?.trim() || 'python', ['-c', `
import sys, pysam
header = {'HD': {'VN': '1.6', 'SO': 'coordinate'}, 'SQ': [{'SN': 'chrT', 'LN': 10000}]}
with pysam.AlignmentFile(sys.argv[1], 'wb', header=header):
    pass
pysam.index(sys.argv[1])
`, bamPath]);
  mkdirSync(exportDir, { recursive: true });
});

async function peakState(page: Page) {
  return page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    return { selectedPeaks: [...s.selectedPeaks].sort((a: any, b: any) => a - b), peakModes: s.peakModes, peaksLocked: s.peaksLocked };
  });
}

function checkPeakOwners(actual: JsonState, legacy: JsonState) {
  expect(actual.selectedPeaks).toEqual(legacy.selectedPeaks);
  expect(actual.peakModes).toEqual(legacy.peakModes);
  expect(actual.peaksLocked).toBe(legacy.peaksLocked);
  for (const [id, node] of Object.entries(legacy.clusterTreeNodes) as [string, JsonState][]) {
    expect(actual.clusterTreeNodes[id]).toMatchObject({ selectedPeakIndices: node.selectedPeakIndices, peakModes: node.peakModes });
  }
  for (const saved of legacy.savedClusters) {
    expect(actual.savedClusters.find((s: JsonState) => s.id === saved.id)).toMatchObject(saved);
  }
}

function checkLegacyExport(saved: JsonState, source: JsonState) {
  expect(saved.version).toBe('2.0');
  expect(saved.viewport).toMatchObject(source.viewport);
  const actual = saved.frontend, legacy = source.frontend;
  checkPeakOwners(actual, legacy);
  expect(actual.selectedFeatures).toEqual(legacy.selectedFeatures); // includes one-base insertion stubs
  // Importers can add explicit defaults; every legacy cart field must remain.
  expect(actual.footprintGroups).toMatchObject(legacy.footprintGroups);
  expect(actual.savedNfrVariants).toMatchObject(legacy.savedNfrVariants);
  expect(actual.peakRules).toMatchObject(legacy.peakRules);
  expect(actual.panels.map((p: JsonState) => [p.id, p.contentType])).toEqual(legacy.panels.map((p: JsonState) => [p.id, p.contentType]));
  for (const panel of legacy.panels) {
    const restored = actual.panels.find((p: JsonState) => p.id === panel.id);
    // Includes the legacy SNP scan/selection, split rule and graph view state.
    expect(restored).toMatchObject(panel);
  }
  if (legacy.peaksLocked) expect(actual.peaksByRule).toMatchObject(legacy.peaksByRule);
  if (legacy.differencesSession) {
    expect(actual.differencesSession.legacySnapshot.differencesSession).toEqual(legacy.differencesSession);
  }
  for (const [index, snapshot] of legacy.historySnapshots.entries()) {
    const state = actual.historySnapshots[index].state;
    checkPeakOwners(state, snapshot.state);
    expect(state.selectedFeatures).toEqual(snapshot.state.selectedFeatures);
    expect(state.footprintGroups).toMatchObject(snapshot.state.footprintGroups);
    expect(state.savedNfrVariants).toMatchObject(snapshot.state.savedNfrVariants);
    expect(state.peaksByRule).toMatchObject(snapshot.state.peaksByRule);
    expect(state.featureHub.peakSelection.selected).toHaveLength(snapshot.state.selectedPeaks.length);
  }
  if (legacy.historySnapshots.length) expect(actual.historyPointer).toBe(legacy.historyPointer);
  expect(actual.featureHub.peakSelection.selected).toHaveLength(legacy.selectedPeaks.length);
}

for (const name of corpus) test(`${name}: user restore, rendered panels and legacy dual-write`, async ({ page, server }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('fiberbrowser_show_preview_features', 'true');
    sessionStorage.setItem('fiberhmm_welcome_dismissed', '1');
  });
  const source: JsonState = JSON.parse(readFileSync(path.join(corpusDir, name), 'utf8').replaceAll('/data/sample.bam', bamPath));
  const input = info.outputPath(name);
  writeFileSync(input, JSON.stringify(source));
  let pickerCalls = 0;
  await page.route(/\/api\/pick_file(?:\?|$)/, route => {
    pickerCalls++;
    return route.fulfill({ json: { success: true, path: input, paths: [input] } });
  });
  await page.goto(server.baseUrl);
  await page.waitForFunction(() => Boolean((window as any).__FIBERBROWSER_STORE__?.getState().chroms.length));
  const [response] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === '/api/session/import' && r.request().method() === 'POST'),
    page.getByTestId('load-file-button').click(),
  ]);
  expect(response.ok()).toBe(true);
  const result = await response.json();
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(result.results?.datasets_failed ?? []).toEqual([]);
  expect(result.results?.hub_legacy?.problems ?? []).toEqual([]);
  await expect(page.getByTestId('load-file-button')).toBeEnabled();
  expect(pickerCalls).toBe(1);

  const expectedPanels = source.frontend.panels.map((p: JsonState) => [p.id, p.contentType]);
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().panels.map((p: JsonState) => [p.id, p.contentType]))).toEqual(expectedPanels);
  await expect(page.locator('[data-analysis-panel-id]')).toHaveCount(source.frontend.panels.filter((p: JsonState) => p.contentType !== 'dataset').length);
  await expect(page.getByTestId('panel-header-name')).toHaveCount(source.frontend.panels.filter((p: JsonState) => p.contentType === 'dataset').length);
  for (const panel of source.frontend.panels) {
    if (panel.contentType === 'dataset') {
      const rendered = page.locator(`[data-panel-id="${panel.id}"]`);
      await expect(rendered).toHaveCount(1);
      const title = panel.readSubset ? `${panel.readSubset.label} · Sample A` : 'Sample A';
      await expect(rendered.getByTestId('panel-header-name')).toHaveText(title);
    } else {
      const rendered = page.locator(`[data-analysis-panel-id="${panel.id}"]`);
      await expect(rendered).toHaveAttribute('data-panel-content-type', panel.contentType);
      expect(titles[panel.contentType], `expected title for ${panel.contentType}`).toBeTruthy();
      await expect(rendered.getByTestId(`analysis-panel-header-${panel.contentType}`).locator('span.font-semibold').first()).toHaveText(new RegExp(`^${titles[panel.contentType]}\\s*(?:Preview)?$`));
    }
  }
  await expect.poll(() => peakState(page)).toEqual({ selectedPeaks: source.frontend.selectedPeaks, peakModes: source.frontend.peakModes, peaksLocked: source.frontend.peaksLocked });
  await expect(page.locator('[data-read-track-loading="true"]')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Dismiss error', exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().error)).toBeNull();

  // Save before opening the hub: the exported panel list is still the legacy list.
  const download = page.waitForEvent('download');
  await page.getByTestId('save-session-button').click();
  const output = path.join(exportDir, name);
  await (await download).saveAs(output);
  const saved = JSON.parse(readFileSync(output, 'utf8'));
  checkLegacyExport(saved, source);
  expect(saved.datasets[0].paths).toEqual([bamPath]);
  await info.attach('new-build-session', { path: output, contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('restored.png'), fullPage: true });

  if (source.frontend.footprintGroups.length || source.frontend.savedNfrVariants.length) {
    const pins = await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().featureHub.pinned);
    expect(pins).toHaveLength(2);
    expect(pins).toEqual(expect.arrayContaining([
      expect.objectContaining({ cart: 'class', cartId: 'cart-class', typeId: 'fp.class', start: 200, end: 220 }),
      expect.objectContaining({ cart: 'nfr', cartId: 'cart-nfr', typeId: 'nfr.variant', start: 310, end: 370 }),
    ]));
    expect(saved.frontend.featureHub.pinned).toEqual(pins);
    await panelButton(page, 'feature-hub').click();
    await expect(page.getByTestId('hub-panel')).toBeVisible();
    for (const kind of ['fp.class', 'nfr.variant']) {
      const row = page.locator(`[data-testid="hub-row"][data-type="${kind}"]`);
      await expect(row).toHaveCount(1);
      await expect(row.getByText('Pinned', { exact: true })).toBeVisible();
    }
    await page.screenshot({ path: info.outputPath('pinned-carts.png'), fullPage: true });
  }
  await expect(page.getByRole('button', { name: 'Dismiss error', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
