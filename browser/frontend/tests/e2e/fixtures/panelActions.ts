import type { Locator, Page } from '@playwright/test';

/**
 * A dataset panel header action (fb-n11-tracks): shown as a button when the
 * header has room, else in its "…" menu. Clicks it either way, in the first
 * dataset panel (or `header`).
 */
export async function clickPanelAction(page: Page, tour: string, header?: Locator): Promise<void> {
  const scope = header ?? page.locator('[data-testid^="dataset-header-"]').first();
  const direct = scope.locator(`[data-tour="${tour}"]`);
  if (await direct.count()) {
    await direct.first().click();
    return;
  }
  await scope.locator('[data-testid^="panel-actions-"]').first().click();
  await page.locator(`[role="menu"] [data-tour="${tour}"]`).first().click();
}
