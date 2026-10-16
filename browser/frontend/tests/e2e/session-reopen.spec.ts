/**
 * Reopening the last session on launch.
 *
 * The server is stopped and started again on the same port with the same
 * runtime folder (as a relaunch of the app or of `fiberbrowser` does); the page
 * keeps its autosave (IndexedDB, per origin).
 * - Quit normally (the page's Quit): relaunched empty, the Welcome card shows
 *   with "Reopen last session (1 dataset, locus)" as its first button; it brings
 *   the locus back.
 * - Killed (a crash): the crash-recovery banner instead (beside the Welcome
 *   card when the browser is empty).
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { test as base, expect } from '@playwright/test';
import { DEMO_FIXTURE, pickRandomPort, startServer, type ServerProcess } from './fixtures/server';

const test = base;

/** The relaunched server's command-line dataset is closed before the page loads (an empty browser, as the app opens). */
async function relaunchEmpty(baseUrl: string) {
  const listed = await (await fetch(`${baseUrl}/api/datasets`)).json();
  for (const d of listed.datasets ?? []) await fetch(`${baseUrl}/api/datasets/${encodeURIComponent(d.id)}`, { method: 'DELETE' });
}
const R = DEMO_FIXTURE.region;
const LOCUS = { chrom: R.chrom, start: R.start + 1_200, end: R.start + 2_200 };

async function exited(proc: ChildProcess, ms = 20_000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await Promise.race([
    new Promise<void>(resolve => proc.once('exit', () => resolve())),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('server did not stop')), ms)),
  ]);
}

const getState = <T,>(page: any, fn: (s: any) => T): Promise<T> =>
  page.evaluate((f: string) => new Function('s', `return (${f})(s)`)((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString());

/** The page's autosave (IndexedDB fiberhmm_history/autosave/latest). */
const autosave = (page: any) => page.evaluate(() => new Promise(resolve => {
  const req = indexedDB.open('fiberhmm_history', 1);
  req.onerror = () => resolve(null);
  req.onsuccess = () => {
    try {
      const get = req.result.transaction('autosave', 'readonly').objectStore('autosave').get('latest');
      get.onsuccess = () => {
        const e = get.result;
        resolve(e ? {
          chrom: e.state.chrom, start: e.state.start, end: e.state.end, bootId: e.bootId ?? null, datasets: e.state.datasets?.length ?? 0,
          clustered: Object.keys(e.state.clusterAssignments ?? {}).length,
          excluded: Object.values(e.state.excludedReadIds ?? {}).reduce((n: number, ids: any) => n + ids.length, 0),
        } : null);
      };
      get.onerror = () => resolve(null);
    } catch { resolve(null); }
  };
}));

async function open(page: any, baseUrl: string) {
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');
}

test.describe('reopen the last session after a restart', () => {
  let port: number;
  let runtimeFile: string;
  let baseUrl: string;
  let proc: ServerProcess | null = null;

  test.beforeEach(async ({ page }) => {
    port = await pickRandomPort();
    runtimeFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-reopen-')), 'browser_runtime.json');
    await page.setViewportSize({ width: 1500, height: 950 });
    await page.addInitScript(() => {
      (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
      (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    });
    proc = await startServer(DEMO_FIXTURE.bamPath, port, { runtimeFile });
    port = proc.port;
    baseUrl = proc.baseUrl;
  });

  test.afterEach(async () => {
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGTERM');
      await exited(proc).catch(() => proc?.kill('SIGKILL'));
    }
  });

  test('after Quit: Reopen last session on the Welcome card brings the datasets and locus back', async ({ page }) => {
    await open(page, baseUrl);
    await page.evaluate((l: typeof LOCUS) => (window as any).__FIBERBROWSER_STORE__.getState().setViewport(l.chrom, l.start, l.end), LOCUS);
    // The locus is saved a few seconds after moving (and again by Quit).
    await expect.poll(() => autosave(page), { timeout: 20_000 }).toMatchObject({ ...LOCUS, datasets: 1 });
    const saved: any = await autosave(page);
    expect(saved.bootId).toBeTruthy();

    // Quit from the page: the server stops normally.
    await page.getByTestId('toolbar-more-button').click();
    await page.getByTestId('quit-button').click();
    await page.getByTestId('quit-now').click();
    await expect(page.getByTestId('quit-stopped')).toBeVisible();
    await exited(proc!);

    proc = await startServer(DEMO_FIXTURE.bamPath, port, { runtimeFile });
    port = proc.port;
    baseUrl = proc.baseUrl;
    await relaunchEmpty(baseUrl);
    await open(page, baseUrl);
    const offer = page.getByTestId('welcome-reopen-last-session');
    await expect(offer).toBeVisible({ timeout: 15_000 });
    await expect(offer).toContainText('Reopen last session');
    await expect(offer).toContainText(`1 dataset, ${LOCUS.chrom}:${LOCUS.start.toLocaleString('en-US')}-${LOCUS.end.toLocaleString('en-US')}`);
    // The first choice on the card; no separate offer.
    await expect(page.getByTestId('welcome-actions').locator('button').first()).toHaveAttribute('data-testid', 'welcome-reopen-last-session');
    await expect(page.getByTestId('reopen-last-session')).toHaveCount(0);
    await expect(page.getByTestId('crash-recovery-banner')).toHaveCount(0);
    expect(await getState(page, s => `${s.chrom}:${s.start}-${s.end}`)).not.toBe(`${LOCUS.chrom}:${LOCUS.start}-${LOCUS.end}`);

    await offer.click();
    await expect(page.getByTestId('welcome-card')).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => getState(page, s => `${s.chrom}:${s.start}-${s.end}`)).toBe(`${LOCUS.chrom}:${LOCUS.start}-${LOCUS.end}`);
    expect(await getState(page, s => s.datasets.length)).toBe(1);
  });

  test('after a crash: the crash-recovery offer, not "Reopen"', async ({ page }) => {
    await open(page, baseUrl);
    await page.evaluate((l: typeof LOCUS) => (window as any).__FIBERBROWSER_STORE__.getState().setViewport(l.chrom, l.start, l.end), LOCUS);
    await expect.poll(() => getState(page, s => Object.values(s.activeReadIds as Record<string, string[]>).flat().length), { timeout: 30_000 }).toBeGreaterThan(0);
    // Some analysis worth recovering: a clustering of two reads.
    await page.evaluate(() => {
      const store = (window as any).__FIBERBROWSER_STORE__;
      const [sk, ids] = Object.entries(store.getState().activeReadIds as Record<string, string[]>)[0];
      store.setState({ clusterAssignments: { [sk]: { [ids[0]]: 0, [ids[1]]: 1 } } });
    });
    await expect.poll(() => autosave(page), { timeout: 20_000 }).toMatchObject({ ...LOCUS, datasets: 1 });

    proc!.kill('SIGKILL');
    await exited(proc!);
    proc = await startServer(DEMO_FIXTURE.bamPath, port, { runtimeFile });
    port = proc.port;
    baseUrl = proc.baseUrl;
    await open(page, baseUrl);
    await expect(page.getByTestId('crash-recovery-banner')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('crash-recovery-banner')).toContainText('Unsaved session found');
    await expect(page.getByTestId('reopen-last-session')).toHaveCount(0);
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect.poll(() => getState(page, s => `${s.chrom}:${s.start}-${s.end}`)).toBe(`${LOCUS.chrom}:${LOCUS.start}-${LOCUS.end}`);
    expect(await getState(page, s => Object.keys(s.clusterAssignments).length)).toBe(1);
  });

  // 3.0.0 audit LOW-3: a new tab opened while another tab of this run was working offered that tab's live
  // session as "Unsaved session found… Restore" (and restoring it reloaded the genome, HIGH-1).
  test('a new tab next to a live one is not offered its session; once that tab is gone it is', async ({ page, context }) => {
    await open(page, baseUrl);
    await page.evaluate((l: typeof LOCUS) => (window as any).__FIBERBROWSER_STORE__.getState().setViewport(l.chrom, l.start, l.end), LOCUS);
    await expect.poll(() => getState(page, s => Object.values(s.activeReadIds as Record<string, string[]>).flat().length), { timeout: 30_000 }).toBeGreaterThan(0);
    await page.evaluate(() => {
      const store = (window as any).__FIBERBROWSER_STORE__;
      const [sk, ids] = Object.entries(store.getState().activeReadIds as Record<string, string[]>)[0];
      store.setState({ clusterAssignments: { [sk]: { [ids[0]]: 0, [ids[1]]: 1 } } });
    });
    await expect.poll(() => autosave(page), { timeout: 20_000 }).toMatchObject({ ...LOCUS, datasets: 1, clustered: 1 });

    const second = await context.newPage();
    await second.setViewportSize({ width: 1500, height: 950 });
    await open(second, baseUrl);
    // Decided (the Welcome card or nothing), with no offer of the first tab's session.
    await second.waitForTimeout(4_000);
    await expect(second.getByTestId('crash-recovery-banner')).toHaveCount(0);
    await expect(second.getByTestId('reopen-last-session')).toHaveCount(0);
    await second.close();
    // The first tab's session is still its own.
    expect(await autosave(page)).toMatchObject({ ...LOCUS, clustered: 1 });

    // The first tab goes without the server stopping (a tab crash, a closed window): its session is offered.
    await page.close();
    const third = await context.newPage();
    await third.setViewportSize({ width: 1500, height: 950 });
    await open(third, baseUrl);
    await expect(third.getByTestId('crash-recovery-banner')).toBeVisible({ timeout: 15_000 });
    await expect(third.getByTestId('crash-recovery-banner')).toContainText('Unsaved session found');
  });

  // Audit M9: the first Undo after Reopen went back to the empty launch view.
  // The reopened session is now where history starts; reads hidden with
  // "Exclude selected" come back with it (Codex 16).
  test('after Reopen, Undo keeps the reopened session (clusters, locus, exclusions)', async ({ page }) => {
    await open(page, baseUrl);
    await page.evaluate((l: typeof LOCUS) => (window as any).__FIBERBROWSER_STORE__.getState().setViewport(l.chrom, l.start, l.end), LOCUS);
    await expect.poll(() => getState(page, s => Object.values(s.activeReadIds as Record<string, string[]>).flat().length), { timeout: 30_000 }).toBeGreaterThan(3);
    const sk: string = await page.evaluate(() => {
      const store = (window as any).__FIBERBROWSER_STORE__;
      const [key, ids] = Object.entries(store.getState().activeReadIds as Record<string, string[]>)[0];
      store.setState({
        clusterAssignments: { [key]: { [ids[0]]: 0, [ids[1]]: 1 } },
        selectedReadIds: { [key]: new Set([ids[2], ids[3]]) },
      });
      return key;
    });
    // Exclude the two selected reads (read menu).
    const reads = page.locator('canvas[data-copilot-track="reads"]').first();
    const box = (await reads.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + 70, { button: 'right' });
    await page.getByTestId('read-context-menu').locator('[data-action="exclude-selected"]').click();
    const chip = page.getByTestId(`excluded-reads-${sk}`);
    await expect(chip).toContainText('2 excluded');
    await expect.poll(() => autosave(page), { timeout: 20_000 }).toMatchObject({ ...LOCUS, datasets: 1, clustered: 1, excluded: 2 });

    await page.getByTestId('toolbar-more-button').click();
    await page.getByTestId('quit-button').click();
    await page.getByTestId('quit-now').click();
    await expect(page.getByTestId('quit-stopped')).toBeVisible();
    await exited(proc!);

    proc = await startServer(DEMO_FIXTURE.bamPath, port, { runtimeFile });
    port = proc.port;
    baseUrl = proc.baseUrl;
    await relaunchEmpty(baseUrl);
    await open(page, baseUrl);
    await page.getByTestId('welcome-reopen-last-session').click({ timeout: 15_000 });
    await expect(page.getByTestId('welcome-card')).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => getState(page, s => `${s.chrom}:${s.start}-${s.end}`)).toBe(`${LOCUS.chrom}:${LOCUS.start}-${LOCUS.end}`);
    await expect(chip).toContainText('2 excluded');
    // Let the page settle (the view-moved snapshot fires 0.5 s after the restore).
    await page.waitForTimeout(2_500);
    const labels: string[] = await getState(page, s => s._historyStack.map((h: any) => h.label));
    expect(labels[0]).toBe('Reopened last session');

    // Undo (and again, whatever automatic steps came after): the reopened
    // session stays: same locus, clusters and exclusions; never the launch view.
    for (let i = 0; i < 3; i++) await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().undo());
    await page.waitForTimeout(500);
    expect(await getState(page, s => s._historyPointer)).toBe(0);
    expect(await getState(page, s => `${s.chrom}:${s.start}-${s.end}`)).toBe(`${LOCUS.chrom}:${LOCUS.start}-${LOCUS.end}`);
    expect(await getState(page, s => Object.keys(s.clusterAssignments).length)).toBe(1);
    await expect(chip).toContainText('2 excluded');
  });

  // Owner, 15 Oct: the Welcome card always shows on an empty browser; the last session is one of its buttons.
  test('relaunched empty after Quit: the Welcome card shows at once, with Reopen last session first', async ({ page }) => {
    await open(page, baseUrl);
    await page.evaluate((l: typeof LOCUS) => (window as any).__FIBERBROWSER_STORE__.getState().setViewport(l.chrom, l.start, l.end), LOCUS);
    await expect.poll(() => autosave(page), { timeout: 20_000 }).toMatchObject({ ...LOCUS, datasets: 1 });
    await page.getByTestId('toolbar-more-button').click();
    await page.getByTestId('quit-button').click();
    await page.getByTestId('quit-now').click();
    await expect(page.getByTestId('quit-stopped')).toBeVisible();
    await exited(proc!);

    proc = await startServer(DEMO_FIXTURE.bamPath, port, { runtimeFile });
    port = proc.port;
    baseUrl = proc.baseUrl;
    await relaunchEmpty(baseUrl);
    await open(page, baseUrl);
    await expect(page.getByTestId('welcome-card')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('welcome-reopen-last-session')).toBeVisible();
    await expect(page.getByTestId('welcome-tour-cta')).toBeVisible();
    await expect(page.getByTestId('welcome-load-file-cta')).toBeVisible();
    // It stays (no separate offer replaces it).
    await page.waitForTimeout(1_000);
    await expect(page.getByTestId('welcome-card')).toBeVisible();
    await expect(page.getByTestId('reopen-last-session')).toHaveCount(0);
  });

  // Codex rc3: a command-line dataset hides the Welcome card (the only reopen control); the offer must not stay
  // pending and hold the autosave back.
  test('relaunched with a command-line dataset: the last session is declined and this one is saved', async ({ page }) => {
    await open(page, baseUrl);
    await page.evaluate((l: typeof LOCUS) => (window as any).__FIBERBROWSER_STORE__.getState().setViewport(l.chrom, l.start, l.end), LOCUS);
    await expect.poll(() => autosave(page), { timeout: 20_000 }).toMatchObject({ ...LOCUS, datasets: 1 });
    await page.getByTestId('toolbar-more-button').click();
    await page.getByTestId('quit-button').click();
    await page.getByTestId('quit-now').click();
    await expect(page.getByTestId('quit-stopped')).toBeVisible();
    await exited(proc!);

    // Relaunched with the BAM on the command line (kept, unlike relaunchEmpty).
    proc = await startServer(DEMO_FIXTURE.bamPath, port, { runtimeFile });
    port = proc.port;
    baseUrl = proc.baseUrl;
    await open(page, baseUrl);
    await expect.poll(() => getState(page, s => s.datasets.length), { timeout: 15_000 }).toBe(1);
    await page.waitForTimeout(3_500);  // past the launch decision
    await expect(page.getByTestId('welcome-card')).toHaveCount(0);
    await expect(page.getByTestId('reopen-last-session')).toHaveCount(0);
    await expect(page.getByTestId('crash-recovery-banner')).toHaveCount(0);
    // A navigation alone is saved (the previous session no longer is).
    const next = { chrom: R.chrom, start: R.start + 300, end: R.start + 1_300 };
    await page.evaluate((l: typeof LOCUS) => (window as any).__FIBERBROWSER_STORE__.getState().setViewport(l.chrom, l.start, l.end), next);
    await expect.poll(() => autosave(page), { timeout: 20_000 }).toMatchObject({ ...next, datasets: 1 });
    const saved: any = await autosave(page);
    expect(saved.start).not.toBe(LOCUS.start);
  });

  // Codex rc4: the declined save had analysis (and acted=true): the new session still replaces it, by a navigation
  // alone and by Quit.
  test('relaunched with a command-line dataset: a declined save with analysis is replaced, also on Quit', async ({ page }) => {
    await open(page, baseUrl);
    await page.evaluate((l: typeof LOCUS) => (window as any).__FIBERBROWSER_STORE__.getState().setViewport(l.chrom, l.start, l.end), LOCUS);
    await expect.poll(() => getState(page, s => Object.values(s.activeReadIds as Record<string, string[]>).flat().length), { timeout: 30_000 }).toBeGreaterThan(1);
    await page.evaluate(() => {
      const store = (window as any).__FIBERBROWSER_STORE__;
      const [sk, ids] = Object.entries(store.getState().activeReadIds as Record<string, string[]>)[0];
      store.setState({ clusterAssignments: { [sk]: { [ids[0]]: 0, [ids[1]]: 1 } } });
      store.getState().pushSnapshot?.('Cluster', { kind: 'clustering' });
    });
    await expect.poll(() => autosave(page), { timeout: 20_000 }).toMatchObject({ ...LOCUS, datasets: 1, clustered: 1 });
    await page.getByTestId('toolbar-more-button').click();
    await page.getByTestId('quit-button').click();
    await page.getByTestId('quit-now').click();
    await expect(page.getByTestId('quit-stopped')).toBeVisible();
    await exited(proc!);

    proc = await startServer(DEMO_FIXTURE.bamPath, port, { runtimeFile });
    port = proc.port;
    baseUrl = proc.baseUrl;
    await open(page, baseUrl);
    await expect.poll(() => getState(page, s => s.datasets.length), { timeout: 15_000 }).toBe(1);
    await page.waitForTimeout(3_500);  // past the launch decision
    await expect(page.getByTestId('welcome-card')).toHaveCount(0);
    await expect(page.getByTestId('crash-recovery-banner')).toHaveCount(0);
    const next = { chrom: R.chrom, start: R.start + 300, end: R.start + 1_300 };
    await page.evaluate((l: typeof LOCUS) => (window as any).__FIBERBROWSER_STORE__.getState().setViewport(l.chrom, l.start, l.end), next);
    await expect.poll(() => autosave(page), { timeout: 20_000 }).toMatchObject({ ...next, datasets: 1, clustered: 0 });
    // Quit saves where this session is.
    const last = { chrom: R.chrom, start: R.start + 500, end: R.start + 1_500 };
    await page.evaluate((l: typeof LOCUS) => (window as any).__FIBERBROWSER_STORE__.getState().setViewport(l.chrom, l.start, l.end), last);
    await page.getByTestId('toolbar-more-button').click();
    await page.getByTestId('quit-button').click();
    await page.getByTestId('quit-now').click();
    await expect(page.getByTestId('quit-stopped')).toBeVisible();
    await exited(proc!);
    expect(await autosave(page)).toMatchObject({ ...last, datasets: 1, clustered: 0 });
  });
});
