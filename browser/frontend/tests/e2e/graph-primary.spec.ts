/**
 * Graph mode as the main view of a dataset panel (DESIGN_GRAPH_PRIMARY v2.2, thin first delivery: G1, G3, G6) with
 * the real helper, the HPRC package and the live-lift demo data, in a real browser:
 *
 * - a new lifted dataset with a package opens in graph mode: its first haplotype panel is the host, the other folded
 *   in, both haplotypes' reads in their own sub-bands;
 * - toggle to linear and back keeps the panel's id and state;
 * - pop out a haplotype, fold it back (state kept);
 * - one molecule set selects the same QNAMEs in the graph and in the popped-out linear panel, both ways;
 * - the zoom hand-off: out above 50 kb (members side by side), back at 40 kb, no flapping in between.
 *
 * Needs FIBERBROWSER_TEST_GRAPH_HELPER, FIBERBROWSER_TEST_GRAPH_HPRC_PACKAGE, FIBERBROWSER_TEST_LIFT_{BAM,MAP},
 * FIBERBROWSER_TEST_FASTA (chr3) and FIBERBROWSER_LIVE_LIFT=1. FIBERBROWSER_GRAPH_SHOTS: a folder for screenshots.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/nativeDialogs';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickRandomPort, startServer, stopServer, type ServerProcess } from './fixtures/server';

const HELPER = process.env.FIBERBROWSER_TEST_GRAPH_HELPER?.trim() ?? '';
const HPRC = process.env.FIBERBROWSER_TEST_GRAPH_HPRC_PACKAGE?.trim() ?? '';
const LIFT_BAM = process.env.FIBERBROWSER_TEST_LIFT_BAM ?? '';
const LIFT_MAP = process.env.FIBERBROWSER_TEST_LIFT_MAP ?? '';
const SHOTS = process.env.FIBERBROWSER_GRAPH_SHOTS?.trim();
const READY = [HELPER, HPRC, LIFT_BAM, LIFT_MAP].every(p => p && existsSync(p)) && process.env.FIBERBROWSER_LIVE_LIFT !== '0'
  && Boolean(process.env.FIBERBROWSER_TEST_FASTA);

async function graphServer(): Promise<ServerProcess> {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-graph-primary-'));
  const env = { FIBERBROWSER_GRAPH_HELPER: HELPER, FIBERBROWSER_GRAPH_PACKAGES: HPRC, FIBERBROWSER_GRAPH_REGISTRY: path.join(scratch, 'reg.json') };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return await startServer(null, await pickRandomPort()); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const S = (page: Page) => ({
  panels: () => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().panels.filter((p: any) => p.contentType === 'dataset')
    .map((p: any) => ({ id: p.id, stateKey: p.stateKey, liftHap: p.liftHap, viewMode: p.viewMode, collapsed: p.collapsed,
      member: p.graphMemberOf ?? null, folded: p.collapsedByGraphGroup ?? null, shown: p.graphView?.handoff?.shown ?? null }))),
  selected: (key: string) => page.evaluate(k => [...((window as any).__FIBERBROWSER_STORE__.getState().selectedReadIds[k] ?? [])].sort(), key),
  view: (start: number, end: number) => page.evaluate(([a, b]) => (window as any).__FIBERBROWSER_STORE__.getState().setViewport('chr3', a, b), [start, end] as const),
  groups: (id: string) => page.evaluate(pid => {
    const e = (window as any).__FIBERBROWSER_GRAPH_SCENES__?.[pid as string];
    return e?.reads ? Object.fromEntries(Object.entries(e.reads.lanes).map(([k, l]: any) => [k, (l.groups ?? []).map((g: any) => [g.member, g.reads])])) : null;
  }, id),
  outlined: (id: string) => page.evaluate(pid => (window as any).__FIBERBROWSER_GRAPH_SCENES__?.[pid as string]?.reads?.drawn?.outlined ?? 0, id),
});

async function headerItem(page: Page, panelId: string, testId: string) {
  await page.getByTestId(`panel-actions-${panelId}`).click();
  await page.getByTestId(testId).first().click();
}

test('graph mode of a lifted dataset: toggle, pop out and fold in, selection both ways, zoom hand-off (HPRC)', async ({ page }) => {
  test.skip(!READY, 'needs the graph helper, the HPRC package, the live-lift demo data (live lift is on unless FIBERBROWSER_LIVE_LIFT=0)');
  test.setTimeout(600_000);
  const server = await graphServer();
  const s = S(page);
  try {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({ width: 1500, height: 1100 });
    await page.addInitScript(() => {
      (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
      (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
      localStorage.clear();
      sessionStorage.clear();
      sessionStorage.setItem('fiberhmm_welcome_dismissed', '1');
    });
    await page.goto(`${server.baseUrl}/?chr=chr3&start=128650000&end=128660000`);
    await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__?.getState().chroms.length ?? 0), { timeout: 120_000 }).toBeGreaterThan(0);
    await page.getByTestId('open-menu-button').click();
    await page.getByTestId('open-menu-add-live-lift').click();
    await page.getByTestId('live-lift-bams').fill(LIFT_BAM);
    await page.getByTestId('live-lift-manifest').fill(LIFT_MAP);
    await expect(page.getByTestId('live-lift-haplotypes')).toContainText('MAT');
    await expect(page.getByTestId('live-lift-open-graph')).toBeChecked();   // D2: graph is the default
    await page.getByTestId('live-lift-add').click();

    // Opened in graph mode: the first haplotype panel hosts, the other is folded in with its own state key.
    await expect.poll(async () => (await s.panels()).filter(p => p.viewMode === 'graph').length, { timeout: 120_000 }).toBe(1);
    let panels = await s.panels();
    const host = panels.find(p => p.viewMode === 'graph')!;
    const pat = panels.find(p => p.id !== host.id)!;
    expect(pat).toMatchObject({ collapsed: true, folded: host.id, member: host.id });
    expect(pat.stateKey).not.toBe(host.stateKey);
    const graph = page.locator(`[data-testid="graph-host-body"][data-panel-id="${host.id}"] [data-testid="graph-panel"]`);
    await expect(graph).toBeVisible({ timeout: 60_000 });
    await expect.poll(async () => Number(await graph.getAttribute('data-graph-reads') || 0), { timeout: 120_000 }).toBeGreaterThan(20);
    // Both haplotypes in their own sub-bands: the host on its path, the folded member on the other.
    const groups = await s.groups(host.id);
    const hostLane = Object.keys(groups!).find(k => groups![k].some((g: any) => g[0] === host.id))!;
    const patLane = Object.keys(groups!).find(k => groups![k].some((g: any) => g[0] === pat.id))!;
    expect(hostLane).toBeTruthy();
    expect(patLane).toBeTruthy();
    expect(hostLane).not.toBe(patLane);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'e2e-graph-mode.png') });

    // Toggle to linear and back: same id and state key; the member is revealed side by side, then folded again.
    await page.getByTestId('graph-mode-toggle').first().click();
    await expect.poll(async () => (await s.panels()).find(p => p.id === host.id)?.viewMode).toBe('linear');
    expect((await s.panels()).find(p => p.id === pat.id)).toMatchObject({ collapsed: false });
    await headerItem(page, host.id, 'graph-view-as-graph');
    await expect.poll(async () => (await s.panels()).find(p => p.id === pat.id)?.collapsed).toBe(true);
    expect((await s.panels()).find(p => p.id === host.id)).toMatchObject({ viewMode: 'graph', stateKey: host.stateKey });
    await expect.poll(async () => Number(await graph.getAttribute('data-graph-reads') || 0), { timeout: 120_000 }).toBeGreaterThan(20);

    // Selection in the graph: Shift-click a read of the PAT sub-band selects its QNAME in the PAT member.
    const target = await page.evaluate(([pid, member]) => {
      const e = (window as any).__FIBERBROWSER_GRAPH_SCENES__[pid as string];
      const h = e.reads.hits.find((x: any) => x.member === member && x.x1 - x.x0 > 20);
      return h ? { x: (h.x0 + h.x1) / 2 + e.offset, y: (h.y0 + h.y1) / 2, q: h.molecule.read.q } : null;
    }, [host.id, pat.id] as const);
    expect(target).not.toBeNull();
    const box = (await graph.getByTestId('graph-panel-canvas').boundingBox())!;
    await page.keyboard.down('Shift');
    await page.mouse.click(box.x + target!.x, box.y + target!.y);
    await page.keyboard.up('Shift');
    await expect.poll(() => s.selected(pat.stateKey)).toEqual([target!.q]);
    await expect.poll(() => s.outlined(host.id)).toBeGreaterThan(0);

    // Pop out PAT: an ordinary panel with its state; the graph's selection is its selection.
    await headerItem(page, host.id, 'graph-pop-out');
    await expect.poll(async () => (await s.panels()).find(p => p.id === pat.id)?.collapsed).toBe(false);
    await expect(page.locator(`[data-panel-id="${pat.id}"] [data-testid="graph-member-chip"]`)).toContainText('In graph');
    expect(await s.selected(pat.stateKey)).toEqual([target!.q]);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'e2e-pop-out.png') });
    // And the other way: a read selected in the linear pop-out is outlined in the graph.
    const other = await page.evaluate(([pid, member, q]) => {
      const e = (window as any).__FIBERBROWSER_GRAPH_SCENES__[pid as string];
      return e.reads.hits.find((x: any) => x.member === member && x.molecule.read.q !== q)?.molecule.read.q ?? null;
    }, [host.id, pat.id, target!.q] as const);
    expect(other).not.toBeNull();
    const before = await s.outlined(host.id);
    await page.evaluate(([k, q]) => (window as any).__FIBERBROWSER_STORE__.getState().toggleReadSelection(k, q), [pat.stateKey, other] as const);
    await expect.poll(() => s.outlined(host.id)).toBeGreaterThan(before);

    // Fold it back: hidden, state kept.
    await headerItem(page, pat.id, 'graph-fold-in');
    await expect.poll(async () => (await s.panels()).find(p => p.id === pat.id)?.collapsed).toBe(true);
    expect(await s.selected(pat.stateKey)).toEqual([target!.q, other!].sort());

    // Zoom hand-off: wider than 50 kb draws linear with PAT beside; 45 kb stays linear; 30 kb is the graph again.
    await s.view(128_620_000, 128_690_000);
    await expect.poll(async () => (await s.panels()).find(p => p.id === host.id)?.shown, { timeout: 10_000 }).toBe('linear');
    await expect(page.getByTestId('graph-handoff-bar')).toBeVisible();
    expect((await s.panels()).find(p => p.id === pat.id)).toMatchObject({ collapsed: false, viewMode: undefined });
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'e2e-handoff-linear.png') });
    await s.view(128_632_500, 128_677_500);
    await page.waitForTimeout(800);
    expect((await s.panels()).find(p => p.id === host.id)?.shown).toBe('linear');
    await s.view(128_640_000, 128_670_000);
    await expect.poll(async () => (await s.panels()).find(p => p.id === host.id)?.shown, { timeout: 10_000 }).toBe('graph');
    await expect.poll(async () => (await s.panels()).find(p => p.id === pat.id)?.collapsed).toBe(true);
    await expect(graph).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await stopServer(server);
  }
});
