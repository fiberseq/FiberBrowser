/**
 * Dragging reads with more than one read panel open.
 *
 * Every read panel pans when its reads are dragged (the linked panels move
 * together; a panel with its own navigation moves alone), and a drag on the
 * reads never turns into a text selection painted over the panel.
 */
import { test, expect, DEMO_FIXTURE } from './fixtures/server';

test.use({ fixtureBam: 'demo' });

const REGION = DEMO_FIXTURE.region;

type Arrangement = 'side' | 'stack' | 'independent';

async function openTwoPanels(page: any, server: any, arrangement: Arrangement = 'side') {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => {
    window.__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    window.__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    localStorage.clear();
  });
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');
  // Two read panels of the demo dataset side by side, linked to the main view
  // (what loading a second dataset gives).
  await page.evaluate(({ r, arrangement }: { r: typeof REGION; arrangement: Arrangement }) => {
    const store = (window as any).__FIBERBROWSER_STORE__;
    const panel = store.getState().panels.find((p: any) => p.contentType === 'dataset');
    store.setState({
      panels: [0, 1].map(i => ({
        ...panel, id: `drag-panel-${i}`, stateKey: i === 0 ? panel.stateKey : `drag-panel-${i}`,
        layoutRow: 0, layoutColumn: i, widthFraction: 0.5, linkGroup: 'link-1',
      })),
    });
    store.getState().setViewport(r.chrom, r.start, r.end);
    if (arrangement === 'stack') store.getState().arrangePanel('drag-panel-1', 'stack');
    if (arrangement === 'independent') store.getState().setPanelIndependent('drag-panel-1', true);
  }, { r: REGION, arrangement });
  const reads = page.locator('canvas[data-copilot-track="reads"]');
  await expect(reads).toHaveCount(2);
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 30_000 }).toBe(0);
  return reads;
}

const mainStart = (page: any) => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().start);
const panelStart = (page: any, id: string) => page.evaluate(
  (panelId: string) => (window as any).__FIBERBROWSER_STORE__.getState().panels.find((p: any) => p.id === panelId)?.viewportOverride?.start ?? null,
  id,
);

async function dragReads(page: any, canvas: any, dx: number, inspect?: () => Promise<void>) {
  const box = (await canvas.boundingBox())!;
  const x = box.x + box.width * 0.6;
  const y = box.y + Math.min(80, box.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 8 });
  if (inspect) await inspect();
  await page.mouse.up();
}

test('dragging the reads of either side-by-side panel pans the linked view', async ({ server, page }) => {
  const reads = await openTwoPanels(page, server);
  const start0 = await mainStart(page);
  await dragReads(page, reads.nth(1), -200);
  // The right panel's drag used to snap back: only the leftmost panel panned.
  await expect.poll(() => mainStart(page)).toBeGreaterThan(start0 + 100);
  const start1 = await mainStart(page);
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 30_000 }).toBe(0);
  await dragReads(page, reads.nth(0), 200);
  await expect.poll(() => mainStart(page)).toBeLessThan(start1 - 100);
});

test('stacked read panels each pan the view', async ({ server, page }) => {
  const reads = await openTwoPanels(page, server, 'stack');
  const start0 = await mainStart(page);
  await dragReads(page, reads.nth(1), -200);
  await expect.poll(() => mainStart(page)).toBeGreaterThan(start0 + 100);
});

test('a panel with its own navigation pans alone, and only it slides while dragged', async ({ server, page }) => {
  const reads = await openTwoPanels(page, server, 'independent');
  const main0 = await mainStart(page);
  const own0 = await panelStart(page, 'drag-panel-1');
  expect(own0).not.toBeNull();
  await dragReads(page, reads.nth(1), -200, async () => {
    expect(await reads.nth(1).evaluate((el: HTMLElement) => el.style.transform)).toContain('translate');
    expect(await reads.nth(0).evaluate((el: HTMLElement) => el.style.transform)).toBe('');
  });
  await expect.poll(() => panelStart(page, 'drag-panel-1')).toBeGreaterThan(own0 + 100);
  expect(await mainStart(page)).toBe(main0);
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 30_000 }).toBe(0);
  const own1 = await panelStart(page, 'drag-panel-1');
  await dragReads(page, reads.nth(0), 200, async () => {
    expect(await reads.nth(1).evaluate((el: HTMLElement) => el.style.transform)).toBe('');
  });
  await expect.poll(() => mainStart(page)).toBeLessThan(main0 - 100);
  expect(await panelStart(page, 'drag-panel-1')).toBe(own1);
});

const selectionState = (page: any) => page.evaluate(() => {
  const s = window.getSelection()!;
  const canvases = [...document.querySelectorAll('canvas[data-copilot-track="reads"]')];
  return { collapsed: s.isCollapsed, overReads: canvases.some(c => s.containsNode(c, true)) };
});

test('dragging the reads never leaves the read panel selected', async ({ server, page }) => {
  const reads = await openTwoPanels(page, server);
  const box = (await reads.nth(0).boundingBox())!;
  const region = (await page.getByTestId('tracks-region').boundingBox())!;

  // A drag that starts in the blank gutter beside the panel and runs over the
  // reads used to select the whole panel.
  await page.mouse.move(region.x + 2, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(region.x + 150, box.y + 200, { steps: 6 });
  await page.mouse.up();
  expect(await selectionState(page)).toEqual({ collapsed: true, overReads: false });

  // A selection made elsewhere (here: everything) is dropped when the reads are
  // pressed, instead of staying painted over the panel through every drag.
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('[data-testid="tracks-region"]')!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
  });
  expect((await selectionState(page)).overReads).toBe(true);
  await dragReads(page, reads.nth(1), -120, async () => {
    expect(await selectionState(page)).toEqual({ collapsed: true, overReads: false });
  });

  // Double-click then drag on the reads selects nothing either.
  await page.mouse.dblclick(box.x + box.width * 0.5, box.y + 60);
  await dragReads(page, reads.nth(0), 80, async () => {
    expect((await selectionState(page)).collapsed).toBe(true);
  });
  expect((await selectionState(page)).collapsed).toBe(true);
});


test('opposite stacked panels keep both rulers, including during figure export', async ({ server, page }) => {
  await openTwoPanels(page, server, 'stack');
  await page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    s.setNavigationMode('perPanel');
    s.setPanelReversed('drag-panel-1', true);
  });
  await expect(page.getByTestId('axis-ruler')).toHaveCount(2);
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.setState({ exportInProgress: true }));
  await expect(page.getByTestId('axis-ruler')).toHaveCount(2);
  await page.evaluate(() => {
    const store = (window as any).__FIBERBROWSER_STORE__;
    store.setState({ exportInProgress: false });
    store.getState().setPanelReversed('drag-panel-1', false);
  });
  await expect(page.getByTestId('axis-ruler')).toHaveCount(1);
});

test('a reversed genome-only panel pans with its displayed direction', async ({ server, page }) => {
  await openTwoPanels(page, server);
  await page.evaluate(() => {
    const store = (window as any).__FIBERBROWSER_STORE__;
    const s = store.getState();
    store.setState({ navigationMode: 'perPanel', isReversed: false, panels: [{
      ...s.panels[0], datasetId: undefined, viewportOverride: undefined, reversed: true,
      layoutColumn: 0, widthFraction: 1, subTracks: [{ type: 'axis', visible: true }],
    }] });
  });
  const before = await mainStart(page);
  await dragReads(page, page.locator('[data-genome-spacer]'), 150);
  await expect.poll(() => mainStart(page)).toBeGreaterThan(before + 100);
});
