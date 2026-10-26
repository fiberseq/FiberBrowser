/**
 * Live lift (DESIGN_LIVE_LIFT.md P2a): Source assembly-aligned reads at the chr3 AluY locus drawn on GRCh38 through
 * the HPRC graphlift map, next to the same molecules' native GRCh38 alignments. Opened from the Open menu's "Add live
 * lift…" (server started with FIBERBROWSER_LIVE_LIFT=1), it splits into a MAT and a PAT panel by default; each
 * panel's reads are its haplotype's lifted rows (lift_hap), drawn from their segments, with badges at the AluY.
 *
 * Needs the pg-lift work data (skipped without it): FIBERBROWSER_TEST_LIFT_BAM, FIBERBROWSER_TEST_LIFT_MAP and
 * FIBERBROWSER_TEST_LIFT_NATIVE.
 */
import { test, expect } from './fixtures/server';
import { existsSync } from 'node:fs';
// Private development fixtures are supplied by the runner, never stored here.
const LIFT_BAM = process.env.FIBERBROWSER_TEST_LIFT_BAM ?? '';
const NATIVE_BAM = process.env.FIBERBROWSER_TEST_LIFT_NATIVE ?? '';
const LIFT_MAP = process.env.FIBERBROWSER_TEST_LIFT_MAP ?? '';
const HAVE_DATA = [LIFT_BAM, NATIVE_BAM, LIFT_MAP].every(p => existsSync(p));
const VIEW = { chrom: 'chr3', start: 128_650_000, end: 128_670_000 };

test.skip(!HAVE_DATA, 'pg-lift work data not present');
test.skip(process.env.FIBERBROWSER_LIVE_LIFT === '0', 'live lift turned off with FIBERBROWSER_LIVE_LIFT=0');
test.use({ fixtureBam: NATIVE_BAM });

test('add a live-lift dataset next to the native BAM: split MAT/PAT panels render lifted rows', async ({ page, server }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1500, height: 1100 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    localStorage.clear();
    sessionStorage.clear();
  });
  const lifted: Record<string, any[]> = {};
  page.on('response', async r => {
    const url = new URL(r.url());
    if (!url.pathname.endsWith('/api/reads/compact') || !url.searchParams.get('lift_hap') || !r.ok()) return;
    try { (lifted[url.searchParams.get('lift_hap')!] ??= []).push(await r.json()); } catch { /* superseded */ }
  });
  await page.goto(`${server.baseUrl}/?chr=${VIEW.chrom}&start=${VIEW.start}&end=${VIEW.end}`);
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 60_000 }).toBe(0);

  // The flag is on: the Open menu offers "Add live lift…".
  await page.getByTestId('open-menu-button').click();
  await page.getByTestId('open-menu-add-live-lift').click();
  const dialog = page.getByTestId('live-lift-dialog');
  await expect(dialog).toBeVisible();
  await page.getByTestId('live-lift-bams').fill(LIFT_BAM);
  await page.getByTestId('live-lift-manifest').fill(LIFT_MAP);
  await expect(page.getByTestId('live-lift-haplotypes')).toContainText('MAT');
  await expect(page.getByTestId('live-lift-haplotypes')).toContainText('PAT');
  await page.getByTestId('live-lift-add').click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });

  // Split by default: one panel per haplotype, each with its chip, next to the native panel.
  await expect(page.getByTestId('live-lift-chip')).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByTestId('live-lift-chip').filter({ hasText: 'MAT' })).toHaveCount(1);
  await expect(page.getByTestId('live-lift-chip').filter({ hasText: 'PAT' })).toHaveCount(1);
  const panels = await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().panels
    .filter((p: any) => p.contentType === 'dataset').map((p: any) => ({ id: p.id, stateKey: p.stateKey ?? p.datasetId, dataset: p.datasetId, hap: p.liftHap ?? null })));
  expect(panels.filter((p: any) => p.hap === null)).toHaveLength(1);   // the native GRCh38 panel
  expect(panels.filter((p: any) => p.hap).map((p: any) => p.hap).sort()).toEqual(['MAT', 'PAT']);

  // Each panel's reads are its haplotype's lifted rows, drawn on GRCh38 (badges at the AluY source insertion).
  await expect.poll(() => (lifted.MAT?.length ?? 0) > 0 && (lifted.PAT?.length ?? 0) > 0, { timeout: 60_000 }).toBe(true);
  const last = (hap: string) => lifted[hap][lifted[hap].length - 1];
  for (const hap of ['MAT', 'PAT']) {
    const reads = last(hap).reads as any[];
    expect(reads.length).toBeGreaterThan(5);
    expect(reads.every(r => r.live_lift?.hap_label === hap)).toBe(true);
    expect(reads.every(r => r.live_lift.segments.length > 0)).toBe(true);
  }
  expect([...last('MAT').reads, ...last('PAT').reads].some((r: any) => (r.live_lift.badges ?? [])
    .some((b: any) => b[1] === 'source_insertion' && b[2] > 2000))).toBe(true);
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 60_000 }).toBe(0);
  // Read canvases for the native and both lifted panels.
  await expect.poll(() => page.locator('canvas[data-copilot-track="reads"]').count()).toBeGreaterThanOrEqual(3);
  await page.screenshot({ path: test.info().outputPath('live-lift-split.png') });

  // The canvas publishes the geometry it actually drew, so this clicks the
  // +2.4 kb badge of a visible MAT row, independent of sorting or row density.
  const mat = panels.find((p: any) => p.hap === 'MAT')!;
  await page.evaluate(() => {
    const store = (window as any).__FIBERBROWSER_STORE__;
    store.setState({ fillReadHeight: false, readRowHeight: 16 });
  });
  const matCanvas = page.locator(`[data-read-track-state-key="${mat.stateKey}"] canvas[data-copilot-track="reads"]`);
  await expect.poll(() => matCanvas.getAttribute('data-live-lift-badge-target')).toBeTruthy();
  const target = JSON.parse((await matCanvas.getAttribute('data-live-lift-badge-target'))!);
  expect(target.bp).toBeGreaterThan(2000);
  expect(target.ins_id).toMatch(/^MAT:.*:insertion$/);
  const scale = await matCanvas.evaluate((c: HTMLCanvasElement) => ({ x: c.getBoundingClientRect().width / c.clientWidth, y: c.getBoundingClientRect().height / c.clientHeight }));
  await matCanvas.click({ position: { x: target.x * scale.x, y: target.y * scale.y } });
  // A plain click on the badge expands the insertion across all three panels (no inspector).
  await expect(page.getByTestId('live-lift-expanded-block')).toHaveCount(3, { timeout: 30_000 });
  await expect(page.getByTestId('live-lift-diff-popover')).toHaveCount(0);
  // ⌘/Ctrl-click opens its inspector, whose per-read observations load by themselves (the cohort is within the
  // auto-load bound). The badge is now beside its expanded column: find it again.
  const before = JSON.stringify(target);
  await expect.poll(async () => {
    const t = await matCanvas.getAttribute('data-live-lift-badge-target');
    return Boolean(t) && JSON.stringify(JSON.parse(t!)) !== before;
  }, { timeout: 30_000 }).toBe(true);
  const opened = JSON.parse((await matCanvas.getAttribute('data-live-lift-badge-target'))!);
  await matCanvas.click({ position: { x: opened.x * scale.x, y: opened.y * scale.y }, modifiers: ['ControlOrMeta'] });
  const badgeInspection = page.getByTestId('live-lift-diff-popover');
  await expect(badgeInspection).toBeVisible();
  await expect(badgeInspection.locator('tbody tr').first()).toBeVisible({ timeout: 30_000 });
  await expect(badgeInspection.getByRole('button', { name: 'Load observed bases and chromatin', exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('live-lift-inspector-aluy.png') });
  for (const block of await page.getByTestId('live-lift-expanded-block').all()) {
    // Shared columns carry a short label; the tooltip has the source and both allele spans.
    await expect(block.getByTestId('live-lift-expanded-label')).toContainText('MAT +2.4 kb');
    await expect(block.getByTestId('live-lift-expanded-label')).toHaveAttribute('title', /^Assembly MAT · ref 0 → alt 2,353 bp/);
  }
  await page.keyboard.press('Escape');
  await expect(badgeInspection).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().liveLiftExpansions.main?.length)).toBe(1);
  await expect.poll(async () => Number(await matCanvas.getAttribute('data-live-lift-insertion-calls'))).toBeGreaterThan(0);
  await expect.poll(async () => JSON.parse((await matCanvas.getAttribute('data-live-lift-insertion-calls-by-id')) ?? '{}')[target.ins_id] ?? 0).toBeGreaterThan(0);
  const patPanel = panels.find((p: any) => p.hap === 'PAT')!;
  const patCanvas = page.locator(`[data-read-track-state-key="${patPanel.stateKey}"] canvas[data-copilot-track="reads"]`);
  await expect.poll(async () => Number(await patCanvas.getAttribute('data-live-lift-insertion-calls'))).toBeGreaterThan(0);
  await expect(page.getByTestId('live-lift-expanded-block').first()).toContainText('PAT +2.4 kb');
  const nativePanel = panels.find((p: any) => p.hap === null)!;
  const nativeCanvas = page.locator(`[data-read-track-state-key="${nativePanel.stateKey}"] canvas[data-copilot-track="reads"]`);
  await expect(nativeCanvas).toHaveAttribute('data-live-lift-insertion-calls', '0');
  // Identify must use a full carrier from the real API, including noisy
  // carrier lengths. This exercises the actual identification job as well.
  await page.getByTestId('live-lift-expanded-block').first().getByRole('button', { name: 'Identify', exact: true }).click();
  const insertionInspection = page.getByTestId('live-lift-diff-popover');
  await expect(insertionInspection).toBeVisible();
  await expect(insertionInspection).toContainText('AluY', { timeout: 120_000 });
  await page.keyboard.press('Escape');
  // The × control closes the shared columns in all three panels.
  await page.getByTestId('live-lift-expanded-collapse').first().click();
  await expect(page.getByTestId('live-lift-expanded-block')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().liveLiftExpansions.main?.length)).toBe(0);

  const strip = page.locator(`[data-testid="live-lift-diff-strip"][data-panel-id="${mat.id}"]`);
  // Resolve this known MAT-only SNV at base detail so adjacent 1 bp glyphs do
  // not mask its mouse target at the original 20 kb scale.
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setViewport('chr3', 128_657_405, 128_657_445));
  const snv = strip.locator('[data-testid="live-lift-diff-item"][data-difference-id="MAT:chr3_MATERNAL:131197059-131197060:snv"]');
  await expect(snv).toBeVisible();
  // Shift-click only selects, a plain click highlights the carriers; ⌘/Ctrl-click opens the inspector with the
  // reads' observations loaded.
  await snv.click({ modifiers: ['Shift'] });
  await expect(page.getByTestId('live-lift-diff-popover')).toHaveCount(0);
  await snv.click();
  await expect(page.getByTestId('live-lift-diff-popover')).toHaveCount(0);
  await snv.click({ modifiers: ['ControlOrMeta'] });
  const inspection = page.getByTestId('live-lift-diff-popover');
  await expect(inspection).toBeVisible();
  await expect(inspection.locator('tbody tr').first()).toBeVisible({ timeout: 30_000 });
  await expect(inspection).toContainText('Allele');
  await expect(inspection).toContainText('HG002');
  await expect(inspection).toContainText('GRCh38');
  await expect(inspection.locator('tbody tr[data-hap="MAT"][data-allele="hg002"]').first()).toBeVisible();
  await expect(inspection.locator('tbody tr').first()).toHaveAttribute('data-hap', 'MAT');
  await expect(inspection.getByTestId('live-lift-other-hap-summary')).toContainText(/PAT: no difference here, \d+ reads agree with GRCh38/);
  await expect(inspection.locator('tbody tr[data-hap="PAT"][data-allele="grch38"]')).toHaveCount(0);
  await expect(inspection.locator('tbody')).not.toContainText('/ ?');
  await page.keyboard.press('Escape');

  const beforeNext = await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().start);
  await strip.getByTestId('live-lift-diff-next').click();
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().start), { timeout: 30_000 }).not.toBe(beforeNext);
  const beforePrev = await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().start);
  await strip.getByTestId('live-lift-diff-prev').click();
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().start), { timeout: 30_000 }).not.toBe(beforePrev);

  // Co-cluster native GRCh38 + MAT + PAT in one model. Provenance sharing is
  // explicit, even though these fixtures contain the same molecular library.
  await page.evaluate(async view => {
    const store = (window as any).__FIBERBROWSER_STORE__;
    store.getState().setViewport(view.chrom, view.start, view.end);
    for (const dataset of store.getState().datasets.filter((d: any) => ['bam', 'bam_livelift'].includes(d.data_type))) {
      const response = await fetch(`/api/lift/provenance/${encodeURIComponent(dataset.id)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ molecule_groups: (dataset.paths ?? [dataset.path]).map((p: string) => [p, 'e2e-shared']), joint_dedup: 'off' }),
      });
      if (!response.ok) throw new Error(`Provenance: ${response.status}`);
      const result = await response.json();
      store.setState((s: any) => ({ datasets: s.datasets.map((d: any) => d.id === dataset.id ? result.dataset : d), refreshGeneration: s.refreshGeneration + 1 }));
    }
    const st = store.getState();
    st.addCustomPeak(128_656_200, 128_656_300, view.chrom);
    st.addCustomPeak(128_659_000, 128_659_100, view.chrom);
    const selected = st.getAllPeaks().filter((p: any) => p.isCustom && [128_656_200, 128_659_000].includes(p.start));
    st.replacePeakSelection(selected.map((p: any) => p.index));
    st.setClusterMethod('combinatorial');
    store.setState({ spanningOnly: false, peaksLocked: true, clusterPreparationCount: null, selectedDatasets: new Set() });
  }, VIEW);
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 60_000 }).toBe(0);
  const clustered = page.waitForResponse(r => new URL(r.url()).pathname === '/api/cluster_all', { timeout: 90_000 });
  await page.getByTestId('cluster-run-button').click();
  const clusterResponse = await clustered;
  expect(clusterResponse.status()).toBe(200);
  const joint = await clusterResponse.json();
  expect(joint.joint_cohort.shared_molecules).toBeGreaterThan(5);
  expect(joint.joint_cohort.policy).toBe('off');
  const sent = clusterResponse.request().postDataJSON();
  expect(sent.viewports.filter((v: any) => v.lift_hap).map((v: any) => v.lift_hap).sort()).toEqual(['MAT', 'PAT']);
  for (const panel of panels) {
    expect(Object.keys(joint.results[panel.stateKey].assignments).length).toBeGreaterThan(5);
  }
  for (const canvas of [matCanvas, patCanvas]) {
    await expect.poll(async () => Number(await canvas.getAttribute('data-live-lift-clustered-rows')), { timeout: 30_000 }).toBeGreaterThan(0);
  }
  await page.screenshot({ path: test.info().outputPath('live-lift-co-clustered.png') });

  // Pooled is one click away.
  const datasetId = panels.find((p: any) => p.hap)!.dataset;
  await page.evaluate(id => (window as any).__FIBERBROWSER_STORE__.getState().poolLiftHapPanels(id), datasetId);
  await expect(page.getByTestId('live-lift-chip')).toHaveCount(1);
  await expect(page.getByTestId('live-lift-chip')).toContainText('MAT+PAT');
  expect(errors).toEqual([]);
});

test('open a linked source view: panels move together through the map, the ribbon, shared hover, insertion jump', async ({ page, server }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1500, height: 1200 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    localStorage.clear();
    sessionStorage.clear();
  });
  const store = (fn: string, arg?: unknown) => page.evaluate(([f, a]) => new Function('s', 'a', f)((window as any).__FIBERBROWSER_STORE__, a), [fn, arg] as const);
  await page.goto(`${server.baseUrl}/?chr=${VIEW.chrom}&start=${VIEW.start}&end=${VIEW.end}`);
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 60_000 }).toBe(0);
  await page.getByTestId('open-menu-button').click();
  await page.getByTestId('open-menu-add-live-lift').click();
  await page.getByTestId('live-lift-bams').fill(LIFT_BAM);
  await page.getByTestId('live-lift-manifest').fill(LIFT_MAP);
  await expect(page.getByTestId('live-lift-haplotypes')).toContainText('MAT');
  await page.getByTestId('live-lift-add').click();
  await expect(page.getByTestId('live-lift-chip')).toHaveCount(2, { timeout: 30_000 });
  const mat = await store(`return s.getState().panels.find(p => p.liftHap === 'MAT')`) as any;

  // "Open source view" in the MAT panel's "…" menu: the source BAM on HG002 MAT coordinates, under the MAT panel.
  await page.getByTestId(`panel-actions-${mat.id}`).click();
  await page.getByTestId('live-lift-open-source-MAT').click();
  await expect(page.getByTestId('lift-link-chip')).toHaveCount(1, { timeout: 60_000 });
  const linked = await store(`return s.getState().panels.find(p => p.liftLink)`) as any;
  expect(linked.liftLink).toMatchObject({ liftPanelId: mat.id, hapLabel: 'MAT' });
  expect(linked.genome).toBeTruthy();                                  // its own (BAM-header) reference
  expect(linked.viewportOverride.chrom).toBe('chr3_MATERNAL');
  expect(linked.layoutColumn).toBe((await store(`return s.getState().panels.find(p => p.id === a)`, mat.id) as any).layoutColumn);
  // The AluY is a MAT insertion: the source view is wider than the target view by about its length.
  const width0 = linked.viewportOverride.end - linked.viewportOverride.start;
  expect(width0 - (VIEW.end - VIEW.start)).toBeGreaterThan(2000);
  expect(width0 - (VIEW.end - VIEW.start)).toBeLessThan(3000);

  const ribbon = page.locator(`[data-testid="lift-ribbon"][data-panel-id="${linked.id}"]`);
  await expect(ribbon).toBeVisible();
  await expect.poll(async () => JSON.parse((await ribbon.getAttribute('data-ribbon-shapes')) ?? '{}').primary ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
  const shapes = JSON.parse((await ribbon.getAttribute('data-ribbon-shapes'))!);
  expect(shapes.source_insertion).toBeGreaterThanOrEqual(1);          // the AluY wedge
  await expect(ribbon.locator('path[data-ribbon-kind="source_insertion"]').first()).toBeVisible();
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 60_000 }).toBe(0);
  const srcCanvas = page.locator(`[data-read-track-state-key="${linked.stateKey}"] canvas[data-copilot-track="reads"]`);
  await expect(srcCanvas).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: test.info().outputPath('live-lift-linked-aluy.png') });
  await ribbon.screenshot({ path: test.info().outputPath('live-lift-ribbon-aluy.png') });

  // Main view → source panel (exact through the tiles), and the main view doesn't move back.
  await store(`s.getState().setViewport('chr3', a.start + 5000, a.end + 5000)`, VIEW);
  await expect.poll(async () => ((await store(`return s.getState().panels.find(p => p.id === a).viewportOverride.start`, linked.id)) as number)
    - linked.viewportOverride.start, { timeout: 15_000 }).toBeGreaterThan(4000);
  expect(await store(`return s.getState().start`)).toBe(VIEW.start + 5000);
  // Source panel → main view; the source panel keeps exactly the view it moved to.
  const moved = await store(`const p = s.getState().panels.find(p => p.id === a); return p.viewportOverride`, linked.id) as any;
  await store(`s.getState().setPanelViewport(a.id, a.start - 2000, a.end - 2000)`, { id: linked.id, ...moved });
  await expect.poll(() => store(`return s.getState().start`), { timeout: 15_000 }).toBeLessThan(VIEW.start + 4000);
  await page.waitForTimeout(500);
  expect(await store(`return s.getState().panels.find(p => p.id === a).viewportOverride`, linked.id)).toEqual({ chrom: 'chr3_MATERNAL', start: moved.start - 2000, end: moved.end - 2000 });
  // Back to the AluY.
  await store(`s.getState().setViewport(a.chrom, a.start, a.end)`, VIEW);
  await expect.poll(async () => ((await store(`return s.getState().panels.find(p => p.id === a).viewportOverride`, linked.id)) as any).end
    - ((await store(`return s.getState().panels.find(p => p.id === a).viewportOverride`, linked.id)) as any).start, { timeout: 15_000 }).toBe(width0);
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 60_000 }).toBe(0);

  // Hovering a lifted molecule outlines it in both panels and lines it in the ribbon.
  await store(`s.setState({ fillReadHeight: false, readRowHeight: 16 })`);
  const matCanvas = page.locator(`[data-read-track-state-key="${mat.stateKey ?? mat.datasetId}"] canvas[data-copilot-track="reads"]`);
  await expect.poll(() => matCanvas.getAttribute('data-live-lift-badge-target'), { timeout: 30_000 }).toBeTruthy();
  const scale = await matCanvas.evaluate((c: HTMLCanvasElement) => ({ x: c.getBoundingClientRect().width / c.clientWidth, y: c.getBoundingClientRect().height / c.clientHeight }));
  // Each panel draws a sample of its reads: walk down the MAT rows until one is also drawn in the source panel.
  await store(`s.setState({ fillReadHeight: false, readRowHeight: 5 })`);
  await page.waitForTimeout(500);
  const box = (await matCanvas.boundingBox())!;
  let both = false;
  for (let y = box.y + 20; y < box.y + box.height - 2 && !both; y += 3) {
    await page.mouse.move(box.x + box.width * 0.55, y);
    await page.waitForTimeout(60);
    both = Number(await matCanvas.getAttribute('data-lift-hover-rows')) > 0 && Number(await srcCanvas.getAttribute('data-lift-hover-rows')) > 0;
  }
  expect(both).toBe(true);
  await expect(ribbon.getByTestId('lift-ribbon-hover-line')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('live-lift-linked-hover.png') });
  await page.mouse.move(5, 5);
  await store(`s.setState({ fillReadHeight: false, readRowHeight: 16 })`);
  await page.waitForTimeout(500);

  // Clicking the AluY badge in the MAT panel shows its inserted bases in the source panel (the main view stays).
  const before = await store(`return { main: s.getState().start, src: s.getState().panels.find(p => p.id === a).viewportOverride }`, linked.id) as any;
  const badge = JSON.parse((await matCanvas.getAttribute('data-live-lift-badge-target'))!);
  // A plain click expands the insertion; the expansion shows its inserted bases in the linked source panel.
  await matCanvas.click({ position: { x: badge.x * scale.x, y: badge.y * scale.y } });
  await expect(page.getByTestId('live-lift-expanded-block').first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => JSON.stringify((await store(`return s.getState().panels.find(p => p.id === a).viewportOverride`, linked.id))), { timeout: 15_000 })
    .not.toBe(JSON.stringify(before.src));
  const jumped = await store(`return s.getState().panels.find(p => p.id === a).viewportOverride`, linked.id) as any;
  const expansion = await store(`return s.getState().liveLiftExpansions.main[0]`) as any;
  const src = (expansion.alleles?.find((a: any) => a.hap_label === 'MAT') ?? expansion).src;
  expect(src.contig).toBe('chr3_MATERNAL');
  expect(jumped.start).toBeLessThanOrEqual(src.start);
  expect(jumped.end).toBeGreaterThanOrEqual(src.end);
  await page.screenshot({ path: test.info().outputPath('live-lift-linked-expanded.png') });
  await page.getByTestId('live-lift-expanded-collapse').first().click();
  expect(await store(`return s.getState().start`)).toBe(before.main);
  await page.keyboard.press('Escape');

  // Orientation: reversing the source panel relative to the lifted one is the user's choice, and is kept.
  await page.getByTestId(`panel-actions-${linked.id}`).click();
  await page.getByTestId('lift-link-flip').click();
  await expect.poll(() => store(`return s.getState().panels.find(p => p.id === a).liftLink.flip`, linked.id)).toBe(true);
  await expect(page.getByTestId('lift-link-chip')).toContainText('reversed');
  expect(errors).toEqual([]);
});

test.describe('insertion badges on retina displays', () => {
  test.use({ deviceScaleFactor: 2 });
  test('MAT and PAT reads both mark the AluY at DPR 2 and several widths; labels follow the row height', async ({ page, server }) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
      (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.goto(`${server.baseUrl}/?chr=${VIEW.chrom}&start=${VIEW.start}&end=${VIEW.end}`);
    await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 60_000 }).toBe(0);
    await page.getByTestId('open-menu-button').click();
    await page.getByTestId('open-menu-add-live-lift').click();
    await page.getByTestId('live-lift-bams').fill(LIFT_BAM);
    await page.getByTestId('live-lift-manifest').fill(LIFT_MAP);
    await expect(page.getByTestId('live-lift-haplotypes')).toContainText('PAT');
    await page.getByTestId('live-lift-add').click();
    await expect(page.getByTestId('live-lift-chip')).toHaveCount(2, { timeout: 30_000 });
    const keys = await page.evaluate(() => Object.fromEntries((window as any).__FIBERBROWSER_STORE__.getState().panels
      .filter((p: any) => p.liftHap).map((p: any) => [p.liftHap, p.stateKey ?? p.datasetId])));
    const canvas = (hap: string) => page.locator(`[data-read-track-state-key="${keys[hap]}"] canvas[data-copilot-track="reads"]`);
    const setMode = (mode: string) => page.evaluate(m => (window as any).__FIBERBROWSER_STORE__.setState((s: any) => ({
      differencesSession: { ...s.differencesSession, options: { ...s.differencesSession.options, readBadges: m } } })), mode);
    const results: any[] = [];
    for (const [width, height] of [[1280, 900], [1440, 900], [1728, 900], [1728, 970], [1728, 1080]]) {
      await page.setViewportSize({ width, height });
      await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 60_000 }).toBe(0);
      for (const mode of ['labels', 'ticks']) {
        await setMode(mode);
        await page.waitForTimeout(400);
        for (const hap of ['MAT', 'PAT']) {
          const c = canvas(hap);
          await expect.poll(async () => Number(await c.getAttribute('data-live-lift-badges')), { timeout: 30_000 }).toBeGreaterThan(0);
          const row = Number(await c.getAttribute('data-read-row-height'));
          const labels = Number(await c.getAttribute('data-live-lift-badge-labels'));
          results.push({ width, height, mode, hap, rowHeight: row, badges: Number(await c.getAttribute('data-live-lift-badges')), labels });
          // Ticks are never labelled; labels need rows of 7 px (MAT has more rows than PAT, so at some window heights
          // only PAT's rows are tall enough: the owner's "no +2.4 kb on MAT" report).
          if (mode === 'ticks') expect(labels).toBe(0);
          if (mode === 'labels' && row < 7) expect(labels).toBe(0);
          if (mode === 'labels' && row >= 8) expect(labels).toBeGreaterThan(0);
        }
        await page.screenshot({ path: test.info().outputPath(`live-lift-badges-${width}x${height}-${mode}.png`) });
      }
    }
    await test.info().attach('badges.json', { body: JSON.stringify(results, null, 1), contentType: 'application/json' });
    console.log('BADGES', JSON.stringify(results));
    expect(errors).toEqual([]);
  });
});

test('the Differences row: compact header, options in its right-click menu and the settings dialog', async ({ page, server }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto(`${server.baseUrl}/?chr=${VIEW.chrom}&start=${VIEW.start}&end=${VIEW.end}`);
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 60_000 }).toBe(0);
  // The entry point on a loaded BAM: the dialog opens with it as the source.
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().panels.some((p: any) => p.contentType === 'dataset')), { timeout: 30_000 }).toBe(true);
  const nativeId = await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().panels.find((p: any) => p.contentType === 'dataset').id);
  await page.getByTestId(`panel-actions-${nativeId}`).click();
  await page.getByTestId('live-lift-from-bam').click();
  await expect(page.getByTestId('live-lift-dialog')).toBeVisible();
  await expect(page.getByTestId('live-lift-bams')).toHaveValue(NATIVE_BAM);
  await expect(page.getByTestId('live-lift-map-suggestions')).toBeVisible();
  await page.getByTestId('live-lift-bams').fill(LIFT_BAM);
  await page.getByTestId('live-lift-manifest').fill(LIFT_MAP);
  await expect(page.getByTestId('live-lift-haplotypes')).toContainText('PAT');
  await page.getByTestId('live-lift-add').click();
  await expect(page.getByTestId('live-lift-chip')).toHaveCount(2, { timeout: 30_000 });
  const header = page.getByTestId('live-lift-diff-header').first();
  await expect(header).toBeVisible({ timeout: 30_000 });
  await expect(header.locator('input, select')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('live-lift-diff-row-1600.png') });
  // Right-click the row: its options.
  await page.getByTestId('live-lift-diff-strip').first().click({ button: 'right', position: { x: 300, y: 30 } });
  const menu = page.getByTestId('track-context-menu');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('Assembly differences (the map)');
  await expect(menu).toContainText('Insertions on reads');
  await page.screenshot({ path: test.info().outputPath('live-lift-diff-row-menu.png') });
  await menu.getByRole('menuitem', { name: /Read-supported edits/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().panels.filter((p: any) => p.liftHap)
    .some((p: any) => p.differenceSources?.reads))).toBe(true);
  // The same options in the Live-lift settings.
  await page.getByTestId('live-lift-diff-strip').first().click({ button: 'right', position: { x: 300, y: 30 } });
  await page.getByTestId('track-context-menu').getByRole('menuitem', { name: 'Live-lift settings…' }).click();
  await expect(page.getByTestId('live-lift-settings-differences')).toBeVisible();
  // Insertion marks are off by default (owner, 25 Oct); the settings turn ticks on.
  await expect(page.getByTestId('live-lift-settings-read-badges')).toHaveValue('off');
  await page.getByTestId('live-lift-settings-read-badges').selectOption('ticks');
  await page.getByTestId('live-lift-settings-save').click();
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().differencesSession.options.readBadges)).toBe('ticks');
});
