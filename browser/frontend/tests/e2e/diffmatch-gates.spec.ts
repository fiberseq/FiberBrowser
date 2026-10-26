/**
 * Gates that were named but had no e2e (audit A8), and the Differences/live-lift work of the same round (A3, A13,
 * owner decisions of 25 Oct):
 *
 * - Differences: assembly comparison labels in the row and table, the inspector's exact assembly allele target, and
 *   Split by carrier on lifted data (frozen inspector calls, never /api/sv/split).
 * - The "Insertions" control in the toolbar Layers row (insertion marks off by default), light and dark.
 * - Session round trip with live lift, graph mode and Differences state.
 * - A 3.0.x session and a schema-1 graph view restore unchanged.
 * - G8: image export of a graph-mode panel.
 * - Anchored zoom in a graph panel; relink after the package was deleted.
 *
 * Data (each test skips without its own): FIBERBROWSER_TEST_LIFT_{BAM,NATIVE,MAP} (live-lift.spec.ts),
 * FIBERBROWSER_TEST_GRAPH_HELPER, FIBERBROWSER_TEST_GRAPH_PACKAGES (with `alu`), FIBERBROWSER_TEST_GRAPH_HPRC_PACKAGE,
 * FIBERBROWSER_TEST_FASTA (chr3) and optionally FIBERBROWSER_TEST_LIFT_SOURCE_FASTA (the source assembly, for exact
 * insertion labels).
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { cpSync, existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { panelButton, pickRandomPort, startServer, stopServer, type ServerProcess } from './fixtures/server';

const LIFT_BAM = process.env.FIBERBROWSER_TEST_LIFT_BAM ?? '';
const NATIVE_BAM = process.env.FIBERBROWSER_TEST_LIFT_NATIVE ?? '';
const LIFT_MAP = process.env.FIBERBROWSER_TEST_LIFT_MAP ?? '';
const SOURCE_FASTA = process.env.FIBERBROWSER_TEST_LIFT_SOURCE_FASTA ?? '';
const HELPER = process.env.FIBERBROWSER_TEST_GRAPH_HELPER?.trim() ?? '';
const PACKAGES = (process.env.FIBERBROWSER_TEST_GRAPH_PACKAGES ?? '').split(':').filter(Boolean);
const ALU = PACKAGES.find(p => path.basename(p.replace(/\/$/, '')) === 'alu') ?? '';
const HPRC = process.env.FIBERBROWSER_TEST_GRAPH_HPRC_PACKAGE?.trim() ?? '';
const HAVE_LIFT = [LIFT_BAM, NATIVE_BAM, LIFT_MAP].every(p => p && existsSync(p)) && process.env.FIBERBROWSER_LIVE_LIFT !== '0';
const HAVE_ALU = Boolean(HELPER && existsSync(HELPER) && ALU && existsSync(ALU) && process.env.FIBERBROWSER_TEST_FASTA);
const HAVE_HPRC = HAVE_LIFT && Boolean(HELPER && existsSync(HELPER) && HPRC && existsSync(HPRC) && process.env.FIBERBROWSER_TEST_FASTA);
const VIEW = { chrom: 'chr3', start: 128_650_000, end: 128_670_000 };

async function server(bam: string | null, env: Record<string, string> = {}): Promise<ServerProcess> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return await startServer(bam, await pickRandomPort()); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

function graphEnv(packages: string[]): Record<string, string> {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-gates-'));
  return { FIBERBROWSER_GRAPH_HELPER: HELPER, FIBERBROWSER_GRAPH_PACKAGES: packages.join(':'),
    FIBERBROWSER_GRAPH_REGISTRY: path.join(scratch, 'graph_registrations.json') };
}

async function prepare(page: Page, { previews = false, dark = false } = {}) {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1500, height: 1050 });
  await page.addInitScript(([p, d]) => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    if (!sessionStorage.getItem('gates-kept')) { localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('gates-kept', '1'); }
    sessionStorage.setItem('fiberhmm_welcome_dismissed', '1');
    if (p) localStorage.setItem('fiberbrowser_show_preview_features', 'true');
    if (d) localStorage.setItem('fiberbrowser_theme', 'dark');
  }, [previews, dark] as const);
  return errors;
}

const state = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => (new Function('s', `return (${f})(s)`))((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;

async function ready(page: Page, url: string) {
  await page.goto(url);
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__?.getState().chroms.length ?? 0), { timeout: 120_000 }).toBeGreaterThan(0);
}

/** "Add live lift…" from the Open menu, linear (graph mode off unless asked). */
async function addLiveLift(page: Page, { graph = false, sourceFasta = '' } = {}) {
  await page.getByTestId('open-menu-button').click();
  await page.getByTestId('open-menu-add-live-lift').click();
  await page.getByTestId('live-lift-bams').fill(LIFT_BAM);
  await page.getByTestId('live-lift-manifest').fill(LIFT_MAP);
  if (sourceFasta && await page.getByTestId('live-lift-source-fasta').count()) await page.getByTestId('live-lift-source-fasta').fill(sourceFasta);
  await expect(page.getByTestId('live-lift-haplotypes')).toContainText('PAT');
  const toggle = page.getByTestId('live-lift-open-graph');
  if (await toggle.count()) { if ((await toggle.isChecked()) !== graph) await toggle.click(); }
  await page.getByTestId('live-lift-add').click();
  await expect(page.getByTestId('live-lift-dialog')).toHaveCount(0, { timeout: 60_000 });
}

test.describe('Differences and live lift', () => {
  test.skip(!HAVE_LIFT, 'needs the pg-lift work data (FIBERBROWSER_TEST_LIFT_BAM, _NATIVE, _MAP)');

  test('assembly comparison in the row, table and inspector; exact allele target; lifted split by carrier', async ({ page }) => {
    test.setTimeout(420_000);
    const srv = await server(NATIVE_BAM);
    try {
      const errors = await prepare(page);
      const svSplit: string[] = [];
      page.on('request', r => { if (r.url().includes('/api/sv/split')) svSplit.push(r.url()); });
      await ready(page, `${srv.baseUrl}/?chr=${VIEW.chrom}&start=${VIEW.start}&end=${VIEW.end}`);
      await addLiveLift(page, { sourceFasta: SOURCE_FASTA });
      await expect(page.getByTestId('live-lift-chip')).toHaveCount(2, { timeout: 60_000 });
      // The reads lane on: read differences get their assembly comparison, saved in the session's identity ledger.
      const compared = page.waitForResponse(r => r.url().includes('/api/differences/compare') && r.ok(), { timeout: 120_000 });
      await page.getByTestId('live-lift-diff-strip').first().click({ button: 'right', position: { x: 300, y: 30 } });
      await page.getByTestId('track-context-menu').getByRole('menuitem', { name: /Read-supported edits/ }).click();
      const comparison = await (await compared).json();
      expect(comparison.status).toBeUndefined();
      expect(Object.keys(comparison.reads).length).toBeGreaterThan(0);
      const labels = Object.values(comparison.reads).map((r: any) => r.label);
      for (const l of labels) expect(['confirmed_by_assembly', 'assembly_supported_approximate', 'assembly_candidate', 'unassessed', 'novel_relative_to_assembly']).toContain(l);
      await expect.poll(() => state(page, s => Object.keys(s.differencesSession.ledger.records).length), { timeout: 30_000 }).toBeGreaterThan(0);
      const item = page.locator('[data-testid="live-lift-diff-item"][data-assembly-label]').first();
      await expect(item).toBeVisible({ timeout: 60_000 });
      // The table's Assembly comparison column.
      await page.getByTestId('live-lift-diff-strip').first().click({ button: 'right', position: { x: 300, y: 30 } });
      await page.getByTestId('track-context-menu').getByRole('menuitem', { name: 'Show the table' }).click();
      await expect(page.getByTestId('difference-table-comparison').first()).toBeVisible();
      await expect(page.locator('[data-testid="difference-table-comparison"]').filter({ hasText: /Confirmed by assembly|assembly-supported \(approximate\)|Assembly candidate|unassessed|Not in the compared/ }).first()).toBeVisible();
      await page.screenshot({ path: test.info().outputPath('differences-comparison-table.png') });
      await page.getByTestId('live-lift-diff-strip').first().click({ button: 'right', position: { x: 300, y: 30 } });
      await page.getByTestId('track-context-menu').getByRole('menuitem', { name: 'Hide the table' }).click();

      // Inspect an assembly insertion (⌘/Ctrl-click): its comparison section replaces "assembly comparison unassessed".
      const insertion = page.locator('[data-testid="live-lift-diff-item"][data-kind="insertion"]').first();
      await insertion.click({ modifiers: ['ControlOrMeta'] });
      const inspector = page.getByTestId('live-lift-diff-popover');
      await expect(inspector).toBeVisible();
      await expect(inspector.getByTestId('assembly-comparison')).toBeVisible({ timeout: 60_000 });
      await expect(inspector).not.toContainText('assembly comparison unassessed');
      // Inspector read names are plain QNAMEs (no dataset prefix).
      const names = await inspector.getByTestId('inspection-read-name').allTextContents();
      if (names.length) expect(names.every(n => !n.includes('|'))).toBe(true);
      // Molecule calls; with the source FASTA an exact assembly allele target with its competitors.
      await inspector.getByRole('button', { name: 'Load molecule calls' }).click();
      await expect(inspector.getByTestId('difference-molecule-counts')).toBeVisible({ timeout: 120_000 });
      const targets = inspector.getByTestId('allele-target');
      if (SOURCE_FASTA) {
        await expect(targets).toBeVisible();
        const option = await targets.locator('option').nth(1).getAttribute('value');
        const exact = page.waitForRequest(r => r.url().includes('/api/differences/inspect') && JSON.parse(r.postData() ?? '{}').target?.target_type === 'exact');
        await targets.selectOption(option!);
        await exact;
        await expect(inspector.getByTestId('allele-target-competitors')).toContainText('reference');
        await expect(inspector.getByTestId('exact-counts')).toBeVisible({ timeout: 120_000 });
      }
      await page.screenshot({ path: test.info().outputPath('differences-inspector.png') });
      // Split by carrier on lifted data: the frozen calls, no /api/sv/split.
      const key = await state(page, s => { const p = s.panels.find((x: any) => x.liftHap); return p.stateKey ?? p.datasetId; });
      await inspector.getByRole('button', { name: /^(Split by carrier|Preview recompute)$/ }).click();
      if (await inspector.getByRole('button', { name: 'Apply recomputed split' }).count()) await inspector.getByRole('button', { name: 'Apply recomputed split' }).click();
      await expect.poll(() => state(page, s => Object.keys(s.svSplits ?? {}).length), { timeout: 30_000 }).toBeGreaterThan(0);
      expect(await state(page, s => Object.values(s.svSplits).some((d: any) => d.frozenImport))).toBe(true);
      expect(key).toBeTruthy();
      expect(svSplit).toEqual([]);
      await page.screenshot({ path: test.info().outputPath('differences-lifted-split.png') });
      expect(errors).toEqual([]);
    } finally { await stopServer(srv); }
  });

  for (const dark of [false, true]) {
    test(`the Insertions control in the Layers row (${dark ? 'dark' : 'light'}): off by default, easy to switch`, async ({ page }) => {
      test.setTimeout(240_000);
      const srv = await server(NATIVE_BAM);
      try {
        const errors = await prepare(page, { dark });
        await ready(page, `${srv.baseUrl}/?chr=${VIEW.chrom}&start=${VIEW.start}&end=${VIEW.end}`);
        await expect(page.getByTestId('insertion-marks-control')).toHaveCount(0);   // no lifted dataset yet
        await addLiveLift(page);
        const control = page.getByTestId('insertion-marks-control');
        await expect(control).toBeVisible({ timeout: 30_000 });
        await expect(control).toHaveAttribute('title', /Off by default/);
        await expect(page.getByTestId('insertion-marks-select')).toHaveValue('off');
        await control.scrollIntoViewIfNeeded();
        await page.screenshot({ path: test.info().outputPath(`insertions-control-${dark ? 'dark' : 'light'}.png`) });
        const bar = await control.locator('xpath=ancestor::*[@data-testid="layer-toggle-group"]').boundingBox();
        if (bar) await page.screenshot({ path: test.info().outputPath(`insertions-control-${dark ? 'dark' : 'light'}-crop.png`),
          clip: { x: Math.max(0, bar.x - 8), y: Math.max(0, bar.y - 8), width: Math.min(1500, bar.width + 16), height: bar.height + 16 } });
        await page.getByTestId('insertion-marks-select').selectOption('ticks');
        await expect.poll(() => state(page, s => s.differencesSession.options.readBadges)).toBe('ticks');
        // Lifted read canvases then draw ticks.
        await expect.poll(async () => {
          const n = await page.locator('canvas[data-live-lift-badges]').evaluateAll(cs => cs.map(c => Number(c.getAttribute('data-live-lift-badges'))));
          return n.some(v => v > 0);
        }, { timeout: 60_000 }).toBe(true);
        expect(errors).toEqual([]);
      } finally { await stopServer(srv); }
    });
  }
});

test('session round trip with live lift, graph mode and Differences state (G1/G8)', async ({ page }, info) => {
  test.skip(!HAVE_HPRC, 'needs the graph helper, the HPRC package and the pg-lift work data');
  test.setTimeout(600_000);
  const srv = await server(NATIVE_BAM, graphEnv([HPRC]));
  try {
    const errors = await prepare(page);
    await ready(page, `${srv.baseUrl}/?chr=${VIEW.chrom}&start=${VIEW.start}&end=${VIEW.end}`);
    await addLiveLift(page, { graph: true });
    await expect.poll(() => state(page, s => s.panels.filter((p: any) => p.viewMode === 'graph').length), { timeout: 120_000 }).toBe(1);
    // Differences state: a reads lane on a lifted panel, a selected difference and a ledger.
    await page.evaluate(() => {
      const s = (window as any).__FIBERBROWSER_STORE__;
      s.setState({ panels: s.getState().panels.map((p: any) => p.liftHap ? { ...p, differenceSources: { assembly: true, reads: true }, liveLiftMinBp: 50 } : p) });
      const ses = s.getState().differencesSession;
      s.setState({ differencesSession: { ...ses, options: { ...ses.options, readBadges: 'labels', projectionPolicy: { ...ses.options.projectionPolicy, min_mapq: 7 } },
        ledger: { ...ses.ledger, records: { ...ses.ledger.records, 'difference:v1:e2e': { identity_state: 'retired', revision: 2, exact_allele_id: null, namespace: 'e2e', observation_ids: ['a'] } },
          lineage: { ...ses.ledger.lineage, 'difference:v1:e2e': { descendants: ['x', 'y'], reason: 'cluster_split', proof: null } } } } });
    });
    const before = await state(page, s => ({
      panels: s.panels.filter((p: any) => p.contentType === 'dataset').map((p: any) => ({ hap: p.liftHap ?? null, viewMode: p.viewMode ?? null,
        reads: p.differenceSources?.reads ?? false, minBp: p.liveLiftMinBp ?? 0, member: Boolean(p.graphMemberOf) })).sort((a: any, b: any) => String(a.hap).localeCompare(String(b.hap))),
      badges: s.differencesSession.options.readBadges, mapq: s.differencesSession.options.projectionPolicy.min_mapq,
      lineage: s.differencesSession.ledger.lineage['difference:v1:e2e'] }));
    const download = page.waitForEvent('download');
    await page.getByTestId('save-session-button').click();
    const file = info.outputPath('round-trip-session.json');
    await (await download).saveAs(file);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.datasets.some((d: any) => d.data_type === 'bam_livelift')).toBe(true);
    expect(saved.frontend.differencesSession.ledger.lineage['difference:v1:e2e'].reason).toBe('cluster_split');

    const fresh = await page.context().newPage();
    fresh.on('pageerror', e => errors.push(e.message));
    await ready(fresh, srv.baseUrl);
    await fresh.getByTestId('settings-rail-file').click();
    const imported = fresh.waitForResponse(r => r.url().includes('/api/session/import') && r.request().method() === 'POST');
    await fresh.getByTestId('restore-session-file-input').setInputFiles(file);
    expect((await (await imported).json()).success).toBe(true);
    await expect.poll(() => state(fresh, s => s.panels.filter((p: any) => p.viewMode === 'graph').length), { timeout: 120_000 }).toBe(1);
    const after = await state(fresh, s => ({
      panels: s.panels.filter((p: any) => p.contentType === 'dataset').map((p: any) => ({ hap: p.liftHap ?? null, viewMode: p.viewMode ?? null,
        reads: p.differenceSources?.reads ?? false, minBp: p.liveLiftMinBp ?? 0, member: Boolean(p.graphMemberOf) })).sort((a: any, b: any) => String(a.hap).localeCompare(String(b.hap))),
      badges: s.differencesSession.options.readBadges, mapq: s.differencesSession.options.projectionPolicy.min_mapq,
      lineage: s.differencesSession.ledger.lineage['difference:v1:e2e'] }));
    expect(after).toEqual(before);
    expect(after.mapq).toBe(7);   // an explicit threshold saved in a session stays
    const graph = fresh.locator('[data-testid="graph-host-body"] [data-testid="graph-panel"]').first();
    await expect.poll(async () => Number(await graph.getAttribute('data-graph-reads') || 0), { timeout: 180_000 }).toBeGreaterThan(5);
    await fresh.screenshot({ path: info.outputPath('round-trip-restored.png') });

    // G8: image export of the graph-mode panel (Chromium) carries the graph canvas' ink.
    await fresh.getByTestId('export-screenshot-button').click();
    await fresh.getByRole('button', { name: 'PNG', exact: true }).click();
    await fresh.getByLabel('Capture full UI').check();
    const shot = fresh.waitForEvent('download', { timeout: 120_000 });
    await fresh.getByRole('button', { name: 'Export PNG', exact: true }).click();
    const png = info.outputPath('graph-mode-export.png');
    await (await shot).saveAs(png);
    const ink = await canvasInk(fresh, graph.getByTestId('graph-panel-canvas'), png);
    await info.attach('graph-export-ink', { body: JSON.stringify(ink), contentType: 'application/json' });
    expect(ink).toBeGreaterThan(0.01);
    await fresh.close();
    expect(errors).toEqual([]);
  } finally { await stopServer(srv); }
});

/** Coloured fraction of an element's box in an exported full-UI PNG. */
async function canvasInk(page: Page, el: Locator, file: string): Promise<number> {
  const box = await el.evaluate(node => {
    const root = document.querySelector('[data-browser-root]')!.getBoundingClientRect();
    const r = node.getBoundingClientRect();
    return { x: (r.left - root.left) / root.width, y: (r.top - root.top) / root.height, w: r.width / root.width, h: r.height / root.height };
  });
  return page.evaluate(async ({ data, b }) => {
    const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
    const c = document.createElement('canvas'); c.width = image.naturalWidth; c.height = image.naturalHeight;
    const ctx = c.getContext('2d')!; ctx.drawImage(image, 0, 0);
    const px = ctx.getImageData(Math.floor(b.x * c.width), Math.floor(b.y * c.height), Math.max(1, Math.floor(b.w * c.width)), Math.max(1, Math.floor(b.h * c.height))).data;
    let coloured = 0;
    for (let i = 0; i < px.length; i += 4) { const hi = Math.max(px[i], px[i + 1], px[i + 2]), lo = Math.min(px[i], px[i + 1], px[i + 2]); if (hi - lo > 30 && lo < 210) coloured++; }
    return coloured / (px.length / 4);
  }, { data: readFileSync(file).toString('base64'), b: box });
}

test.describe('saved sessions from earlier versions', () => {
  test('a 3.0.x session restores unchanged: its panels, legacy SV track and settings', async ({ page }, info) => {
    test.skip(!HAVE_LIFT, 'needs the native BAM of the pg-lift work data');
    test.setTimeout(240_000);
    const fixture = path.join(__dirname, 'fixtures', 'session-3.0.x.json');
    test.skip(!existsSync(fixture), 'the 3.0.x session fixture is missing');
    const session = JSON.parse(readFileSync(fixture, 'utf8').replaceAll('__NATIVE_BAM__', NATIVE_BAM));
    const file = info.outputPath('session-3.0.x.json');
    writeFileSync(file, JSON.stringify(session));
    const srv = await server(null);
    try {
      const errors = await prepare(page);
      await ready(page, srv.baseUrl);
      await page.getByTestId('settings-rail-file').click();
      const imported = page.waitForResponse(r => r.url().includes('/api/session/import') && r.request().method() === 'POST');
      await page.getByTestId('restore-session-file-input').setInputFiles(file);
      const result = await (await imported).json();
      expect(result.success, JSON.stringify(result)).toBe(true);
      const savedPanels = session.frontend.panels.filter((p: any) => p.contentType === 'dataset');
      await expect.poll(() => state(page, s => s.panels.filter((p: any) => p.contentType === 'dataset').length), { timeout: 60_000 }).toBe(savedPanels.length);
      const restored = await state(page, s => ({ chrom: s.chrom, start: s.start, end: s.end,
        panels: s.panels.filter((p: any) => p.contentType === 'dataset').map((p: any) => ({ id: p.id, viewMode: p.viewMode ?? null, member: p.graphMemberOf ?? null, tracks: p.subTracks.map((t: any) => t.type) })),
        differences: Boolean(s.differencesSession?.schema_version) }));
      expect([restored.chrom, restored.start, restored.end]).toEqual([session.frontend.chrom, session.frontend.start, session.frontend.end]);
      expect(restored.panels.map((p: any) => p.id).sort()).toEqual(savedPanels.map((p: any) => p.id).sort());
      expect(restored.panels.every((p: any) => p.viewMode !== 'graph' && p.member === null)).toBe(true);   // no graph mode invented
      expect(restored.differences).toBe(true);
      await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 60_000 }).toBe(0);
      await expect.poll(() => page.locator('canvas[data-copilot-track="reads"]').count()).toBeGreaterThan(0);
      await page.screenshot({ path: info.outputPath('session-3.0.x-restored.png') });
      expect(errors).toEqual([]);
    } finally { await stopServer(srv); }
  });

  test('a schema-1 graph view restores as a standalone graph view and draws', async ({ page }, info) => {
    test.skip(!HAVE_ALU, 'needs the graph helper and the alu package');
    test.setTimeout(240_000);
    const srv = await server(null, { ...graphEnv([ALU]), FIBERBROWSER_LIVE_LIFT: '0' });
    try {
      const errors = await prepare(page, { previews: true });
      await ready(page, `${srv.baseUrl}/?chr=chr3&start=92395&end=102395`);
      const reg = (await (await page.request.get(`${srv.baseUrl}/api/graph/registrations`)).json()).registrations[0];
      const exported = await page.request.post(`${srv.baseUrl}/api/session/export`, { data: { chrom: 'chr3', start: 92395, end: 102395,
        frontend: { chrom: 'chr3', start: 92395, end: 102395, panels: [{ id: 'gv1', contentType: 'graph-view', datasetId: null, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0,
          graphView: { schema: 1, registrationId: reg.id, packageRevision: reg.revisions.package, graphRevision: reg.revisions.graph, mapRevision: reg.revisions.maps,
            targetBinding: reg.target_binding ?? reg.targets?.[0]?.binding ?? 'target', selectedPathKeys: [], linkMode: 'follow' } }] } } });
      expect(exported.ok()).toBe(true);
      const file = info.outputPath('session-schema1-graph.json');
      writeFileSync(file, JSON.stringify(await exported.json()));
      await page.getByTestId('settings-rail-file').click();
      const imported = page.waitForResponse(r => r.url().includes('/api/session/import') && r.request().method() === 'POST');
      await page.getByTestId('restore-session-file-input').setInputFiles(file);
      expect((await (await imported).json()).success).toBe(true);
      await expect.poll(() => state(page, s => s.panels.find((p: any) => p.id === 'gv1')?.graphView?.role ?? null), { timeout: 30_000 }).toBe('standalone');
      expect(await state(page, s => s.panels.find((p: any) => p.id === 'gv1').graphView.schema)).toBe(2);
      const graph = page.locator('[data-testid="graph-panel"][data-graph-panel-id="gv1"]');
      await expect(graph).toHaveAttribute('data-graph-loading', 'false', { timeout: 60_000 });
      await expect.poll(async () => (await graph.getAttribute('data-graph-lanes')) ?? '', { timeout: 60_000 }).toContain('target');
      await page.screenshot({ path: info.outputPath('schema1-graph-restored.png') });
      expect(errors).toEqual([]);
    } finally { await stopServer(srv); }
  });
});

test.describe('graph panel navigation gates (Phase F)', () => {
  test.skip(!HAVE_ALU, 'needs the graph helper and the alu package');

  async function openGraph(page: Page): Promise<Locator> {
    await panelButton(page, 'graph-view').first().click();
    const graph = page.getByTestId('graph-panel').first();
    await expect(graph).toHaveAttribute('data-graph-loading', 'false', { timeout: 60_000 });
    await expect(graph).toHaveAttribute('data-graph-lanes', /target/, { timeout: 60_000 });
    return graph;
  }
  /** Target base under a canvas x (CSS px), from the scene the panel exposes to e2e runs. */
  const targetAt = (page: Page, graph: Locator, x: number) => graph.getAttribute('data-graph-panel-id').then(id => page.evaluate(([pid, px]) => {
    const e = (window as any).__FIBERBROWSER_GRAPH_SCENES__?.[pid as string];
    if (!e) return null;
    const m = e.scene.targetMap.find((t: any) => t.kind === 'seq' && t.x0 + e.offset <= (px as number) && (px as number) < t.x1 + e.offset);
    return m ? m.t0 + (((px as number) - e.offset - m.x0) / (m.x1 - m.x0)) * (m.t1 - m.t0) : null;
  }, [id, x] as const));
  const xOfTarget = (page: Page, graph: Locator, t: number) => graph.getAttribute('data-graph-panel-id').then(id => page.evaluate(([pid, tb]) => {
    const e = (window as any).__FIBERBROWSER_GRAPH_SCENES__?.[pid as string];
    const m = e?.scene.targetMap.find((q: any) => q.kind === 'seq' && q.t0 <= (tb as number) && (tb as number) < q.t1);
    return m ? m.x0 + (((tb as number) - m.t0) / (m.t1 - m.t0)) * (m.x1 - m.x0) + e.offset : null;
  }, [id, t] as const));

  test('anchored zoom keeps the target base under the pointer', async ({ page }) => {
    test.setTimeout(240_000);
    const srv = await server(null, { ...graphEnv([ALU]), FIBERBROWSER_LIVE_LIFT: '0' });
    try {
      const errors = await prepare(page, { previews: true });
      await ready(page, `${srv.baseUrl}/?chr=chr3&start=92395&end=102395`);
      const graph = await openGraph(page);
      const canvas = graph.getByTestId('graph-panel-canvas');
      const box = (await canvas.boundingBox())!;
      const px = Math.round(box.width * 0.3);
      const anchor = await targetAt(page, graph, px);
      expect(anchor).not.toBeNull();
      const start = Number(await graph.getAttribute('data-graph-start'));
      await page.mouse.move(box.x + px, box.y + 40);
      await page.keyboard.down('ControlOrMeta');
      await page.mouse.wheel(0, -120);
      await page.keyboard.up('ControlOrMeta');
      await expect.poll(async () => Number(await graph.getAttribute('data-graph-start')), { timeout: 30_000 }).not.toBe(start);
      await expect(graph).toHaveAttribute('data-graph-loading', 'false', { timeout: 30_000 });
      // The correction lands after the new scene is drawn: the anchor base is back under the pointer.
      await expect.poll(async () => {
        const x = await xOfTarget(page, graph, Math.round(anchor!));
        return x === null ? Infinity : Math.abs(x - px);
      }, { timeout: 30_000 }).toBeLessThanOrEqual(3);
      const width = Number(await graph.getAttribute('data-graph-end')) - Number(await graph.getAttribute('data-graph-start'));
      expect(width).toBeLessThan(10_000);   // zoomed in
      expect(errors).toEqual([]);
    } finally { await stopServer(srv); }
  });

  test('relink after the package was deleted: unavailable with its frozen view, then live again', async ({ page }) => {
    test.setTimeout(240_000);
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-relink-'));
    const pkg = path.join(scratch, 'alu');
    cpSync(ALU, pkg, { recursive: true });
    const srv = await server(null, { ...graphEnv([pkg]), FIBERBROWSER_LIVE_LIFT: '0' });
    try {
      const errors = await prepare(page, { previews: true });
      await ready(page, `${srv.baseUrl}/?chr=chr3&start=92395&end=102395`);
      const graph = await openGraph(page);
      // The package folder is deleted (moved away): the restored view stays frozen and offers a relink.
      renameSync(pkg, `${pkg}.gone`);
      await page.reload();
      await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__?.getState().chroms.length ?? 0), { timeout: 60_000 }).toBeGreaterThan(0);
      const stale = page.getByTestId('graph-panel-stale');
      if (!(await stale.count())) {
        // A kept page state may need the status checked again.
        await page.getByText('Check again').click().catch(() => {});
      }
      await expect(stale).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('graph-panel-frozen')).toContainText('chr3');
      await page.screenshot({ path: test.info().outputPath('relink-unavailable.png') });
      renameSync(`${pkg}.gone`, pkg);
      const relink = page.getByTestId('graph-panel-relink');
      if (await relink.count()) await relink.first().click();
      else {
        await page.getByTestId('graph-panel-register-path').fill(pkg);
        await page.getByTestId('graph-panel-register-submit').click();
      }
      await expect(page.getByTestId('graph-panel-stale')).toHaveCount(0, { timeout: 60_000 });
      await expect(page.getByTestId('graph-panel').first()).toHaveAttribute('data-graph-lanes', /target/, { timeout: 60_000 });
      await page.screenshot({ path: test.info().outputPath('relink-live.png') });
      expect(graph).toBeTruthy();
      expect(errors).toEqual([]);
    } finally { await stopServer(srv); }
  });
});
