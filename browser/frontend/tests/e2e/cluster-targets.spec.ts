/**
 * Usability round 1 (fb-u1-global), on the synthetic SV BAM with the insert-expanded Carriers panel (Preview):
 * - Cluster says what it will do before running ("Cluster at 1 selected peak in Carriers · Reference left out:
 *   different coordinates"), clusters exactly that, and reports the run beside the toolbar (not a global banner) — the audit's
 *   bug 1 scenario (a peak in the expanded insert, no panel targeted);
 * - a targeted panel the peaks can't cluster: refused before running;
 * - panel targeting from the keyboard (the header name is a toggle button) with a Target chip;
 * - the result line clears on the next run.
 */
import { test, expect, enablePreviews } from './fixtures/server';
import type { Locator, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = process.env.FIBERBROWSER_TEST_DIR
  ? path.resolve(process.env.FIBERBROWSER_TEST_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const PYTHON = process.env.FIBERBROWSER_TEST_PYTHON?.trim() || 'python';
const SHOTS = process.env.FB_SHOTS_DIR;
const VIEW = { chrom: 'chrSV', start: 8_000, end: 16_000 };
const INS_POS = 14_000;

const store = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => new Function('s', `return (${f})(s)`)((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const dark of [false, true]) {
    await page.evaluate(d => document.documentElement.classList.toggle('dark', d), dark);
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(SHOTS, `${name}_${dark ? 'dark' : 'light'}.png`) });
  }
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
}

async function groupControls(page: Page, id: string): Promise<Locator> {
  const controls = page.getByTestId(`toolbar-group-controls-${id}`);
  if (!(await controls.isVisible().catch(() => false))) {
    const toggle = page.getByTestId(`toolbar-group-toggle-${id}`).first();
    if (await toggle.isVisible().catch(() => false)) await toggle.click();
    else {
      await page.getByTestId('toolbar-groups-more').click();
      await page.getByTestId('toolbar-groups-more-menu').getByTestId(`toolbar-group-toggle-${id}`).click();
    }
  }
  await expect(controls.first()).toBeVisible();
  return controls.first();
}

test.describe('Cluster: what it applies to, before and after the run', () => {
  test.use({
    fixtureBam: async ({}, use) => {
      const bam = path.join(mkdtempSync(path.join(tmpdir(), 'fiberbrowser-u1-cluster-')), 'sv_demo.bam');
      execFileSync(PYTHON, [path.join(REPO_ROOT, 'tests', 'make_sv_demo_bam.py'), bam], { stdio: 'inherit' });
      await use(bam);
    },
  });

  test('peak in the expanded insert, nothing targeted: Carriers only, said before and after; targeted Reference refused', async ({ page, server }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.addInitScript(() => {
      (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
      (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
      if (!window.sessionStorage.getItem('fb-e2e-kept')) { window.localStorage.clear(); window.sessionStorage.setItem('fb-e2e-kept', '1'); }
      // The "Clustered … in Carriers" line is off by default (owner, 6 Oct): this spec checks its wording.
      window.localStorage.setItem('fiberbrowser_show_run_summaries', 'true');
    });
    await enablePreviews(page);
    const firstReads = page.waitForResponse(r => r.url().includes('/api/reads/compact') && r.url().includes('chrSV') && r.ok());
    await page.goto(`${server.baseUrl}/?chr=${VIEW.chrom}&start=${VIEW.start}&end=${VIEW.end}`);
    await page.waitForFunction(() => !!(window as any).__FIBERBROWSER_STORE__);
    await firstReads;
    await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 30_000 }).toBe(0);
    await expect(page.getByTestId('panel-rail-coach')).toBeVisible();

    // Split by the insertion: Carriers (insert expanded) and Reference.
    const svTrack = page.locator('canvas[data-testid^="sv-track-canvas-"]');
    const box = (await svTrack.boundingBox())!;
    const sidebar = Number(await page.locator('canvas[data-copilot-track="reads"]').first().getAttribute('data-track-sidebar')) || 0;
    await page.mouse.click(box.x + sidebar + ((INS_POS - VIEW.start) / (VIEW.end - VIEW.start)) * (box.width - sidebar), box.y + box.height / 2, { button: 'right' });
    await page.getByTestId('track-context-menu').getByRole('menuitem', { name: 'Split into panels by this SV' }).click();
    const dialog = page.getByTestId('split-panels-dialog');
    await expect(dialog.getByTestId('split-panels-row').first()).toBeVisible({ timeout: 30_000 });
    // SV-4: the Carriers panel's body says the insertion reference is being built, and for how long.
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as any).__altBuildStatus = seen;
      new MutationObserver(() => {
        const el = document.querySelector('[data-testid="alt-allele-build-status"]');
        if (el && !seen.includes(el.textContent ?? '')) seen.push(el.textContent ?? '');
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await dialog.getByTestId('split-panels-open').click();
    if (await page.getByTestId('alt-allele-build-status').waitFor({ timeout: 5_000 }).then(() => true, () => false)) await shot(page, 'alt_allele_build_status');
    await expect.poll(() => store(page, s => s.panels.some((p: any) => p.readSubset && p.altAllele)), { timeout: 90_000 }).toBe(true);
    const statuses = await page.evaluate(() => (window as any).__altBuildStatus as string[]);
    expect(statuses.some(t => /Building insertion reference/.test(t) && /\d+s elapsed/.test(t))).toBe(true);
    // SV-8: the rail's hint goes once panels open (it sat over their headers' actions).
    await expect(page.getByTestId('panel-rail-coach')).toHaveCount(0);
    const ids = await store(page, s => {
      const alt = s.panels.find((p: any) => p.readSubset && p.altAllele);
      const ref = s.panels.find((p: any) => p.readSubset && !p.altAllele);
      return { alt: alt.id, altKey: alt.stateKey, ref: ref.id, refKey: ref.stateKey, source: ref.readSubset.sourcePanelId, ds: ref.datasetId };
    });
    // A native scanned peak, not the matched-flank regions added by an SV split.
    await expect.poll(() => store(page, s => s.getAllPeaks().filter((p: any) => !p.match && p.genome && p.chrom?.includes('_INS')).length), { timeout: 30_000 }).toBeGreaterThan(0);
    await page.evaluate(() => {
      const s = (window as any).__FIBERBROWSER_STORE__.getState();
      const peak = s.getAllPeaks().find((p: any) => !p.match && p.genome && p.chrom?.includes('_INS'));
      s.togglePeakSelection(peak.index);
      s.setClusterMethod('kmeans');
    });
    const before = await store(page, s => Object.fromEntries(Object.entries(s.clusterAssignments).map(([k, v]: any) => [k, Object.keys(v).length])));

    // Before running: what it applies to, and why the Reference panel is left out.
    await groupControls(page, 'cluster');
    // The toolbar's chip is short (round 2, N7); the picker has the long form.
    // (Round 3, R8: it names what it chooses.)
    await expect(page.getByTestId('cluster-applies-to-short')).toHaveText('Panels: Carriers · 1 left out');
    await page.getByTestId('cluster-applies-to').click();
    const menu = page.getByTestId('cluster-applies-to-menu');
    // N2 / R8: focus is in the picker, on the checked mode radio; ↓ moves to the other radio (in All mode the panel
    // rows are status only).
    await expect(menu.getByTestId('cluster-applies-all-input')).toBeFocused();
    await expect(menu.locator('li[data-testid="cluster-applies-row"] input')).toHaveCount(0);
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByTestId('cluster-applies-selected-input')).toBeFocused();
    // N15: before a run, what it will do (never "Clustered").
    await expect(menu.locator(`[data-panel-id="${ids.alt}"]`)).toContainText('Will cluster');
    await expect(menu).not.toContainText('Clustered');
    await expect(menu).toContainText('Panels for Cluster, Sort and Filter');
    await expect(menu.getByTestId('cluster-applies-to-scope')).toContainText('Sort and Filter act on the same panels');
    // R6: the plan the run follows, the same words as the Cluster button's tooltip.
    await expect(menu.getByTestId('cluster-applies-to-summary')).toHaveText('Cluster at 1 selected peak in Carriers');
    await expect(menu.getByTestId('cluster-applies-to-note')).toHaveText('Reference left out: different coordinates');
    await expect(page.getByTestId('cluster-run-button')).toHaveAttribute('title', /^Cluster at 1 selected peak in Carriers/);
    await expect(menu.locator(`[data-panel-id="${ids.ref}"] [data-testid="cluster-applies-reason"]`)).toContainText('different coordinates from Carriers');
    await expect(menu.locator(`[data-panel-id="${ids.alt}"]`)).toHaveAttribute('data-in-run', 'true');
    await shot(page, 'cluster_applies_to');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId('cluster-applies-to')).toBeFocused();

    // Run: Carriers clustered, nothing else changes; the outcome is a result line, not the red banner.
    const requests: any[] = [];
    page.on('request', r => { if (r.url().includes('/api/cluster_all')) requests.push(JSON.parse(r.postData() ?? '{}')); });
    await page.getByTestId('cluster-run-button').click();
    await expect.poll(() => store(page, s => Object.keys(s.clusterAssignments[(s.panels.find((p: any) => p.readSubset && p.altAllele) ?? {}).stateKey] ?? {}).length), { timeout: 90_000 }).toBeGreaterThan(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].viewports.map((v: any) => v.result_key)).toEqual([ids.altKey]);
    const after = await store(page, s => Object.fromEntries(Object.entries(s.clusterAssignments).map(([k, v]: any) => [k, Object.keys(v).length])));
    expect(after[ids.refKey] ?? 0).toBe(0);
    // The folded source keeps the split's own grouping (what the audit read as "dm6 reads clustered"): unchanged.
    expect(after[ids.ds] ?? 0).toBe(before[ids.ds] ?? 0);
    const result = page.getByTestId('run-result-cluster');
    await expect(result).toBeVisible();
    await expect(result).toContainText(/Clustered \d+ reads? in Carriers at 1 selected peak\./);
    const marker = page.getByTestId('run-result-cluster-marker');
    const firstRun = Number(await marker.getAttribute('data-run'));
    await expect(result).toContainText('Not clustered: Reference (different coordinates from Carriers');
    await expect(page.getByLabel('Dismiss error')).toHaveCount(0);
    await shot(page, 'cluster_run_result');

    // B5: SVs ticked with the peak selected, a region method: the run is on the peak, and everything says so; a rerun
    // with the same outcome visibly replaces the line (its run number).
    await page.evaluate(([chrom, ins, ds]) => {
      const s = (window as any).__FIBERBROWSER_STORE__.getState();
      s.selectFeature({ kind: 'sv', source: ds, id: `I:${ins}:400`, datasetId: ds, chrom, start: ins, end: ins + 1, label: 'INS 400' }, true);
    }, [VIEW.chrom, INS_POS, ids.ds] as const);
    const runTitle = await page.getByTestId('cluster-run-button').getAttribute('title');
    expect(runTitle).toMatch(/^Cluster at 1 selected peak in Carriers/);
    expect(runTitle).toContain('ticked SVs group reads only with Combinatorial');
    expect(runTitle).not.toMatch(/INS 400|accessibility layer/);
    await page.getByTestId('cluster-run-button').click();
    await expect(marker).toHaveAttribute('data-run', String(firstRun + 1), { timeout: 60_000 });
    await expect(result).toContainText(/Clustered \d+ reads? in Carriers at 1 selected peak \(ticked SVs group reads only with Combinatorial\)\./, { timeout: 60_000 });
    expect(requests).toHaveLength(2);
    await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().clearFeatureSelection());

    // Target the Reference panel from the keyboard: a toggle with its state, and a chip.
    const refName = page.locator(`[data-panel-id="${ids.ref}"] button[data-testid="panel-header-name"]`);
    await refName.focus();
    await page.keyboard.press('Enter');
    await expect(refName).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(`[data-panel-id="${ids.ref}"] [data-testid="panel-target-chip"]`)).toBeVisible();
    // Reference targeted, the peak in Carriers: refused before running, and the picker said so.
    await expect(page.getByTestId('cluster-applies-to-short')).toContainText('Panels: none');
    await page.getByTestId('cluster-applies-to').click();
    await expect(page.getByTestId('cluster-applies-refusal')).toContainText("Cluster can't include Reference");
    await shot(page, 'cluster_refused_picker');
    await page.keyboard.press('Escape');
    // Refused before running: Cluster is off and says why (round 4, Q7), and nothing is sent.
    const run = page.getByTestId('cluster-run-button');
    await expect(run).toHaveAttribute('aria-disabled', 'true');
    await expect(run).toHaveAttribute('title', /Cluster can't include Reference/);
    expect(requests).toHaveLength(2);
    await shot(page, 'cluster_refused_result');

    // Untarget from the picker ("All compatible panels"); the next run replaces the result.
    await page.getByTestId('cluster-applies-to').click();
    await page.getByTestId('cluster-applies-all').click();
    await page.keyboard.press('Escape');
    await expect(refName).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId('cluster-run-button').click();
    await expect(result).toHaveAttribute('data-tone', /done|note/, { timeout: 60_000 });
    await expect(result).not.toContainText("can't include");
    // N5: once the panels it clustered close (the split), the line says so rather than reading as current.
    await expect(page.getByTestId('run-result-cluster-closed')).toHaveCount(0);
    await page.getByTestId('split-panel-close-all').first().click();
    await expect(page.getByTestId('run-result-cluster-closed')).toHaveText(/\(panels? closed\)/, { timeout: 30_000 });
  });
});
