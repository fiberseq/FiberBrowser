/**
 * Native file dialogs never open in an e2e test.
 *
 * On a desktop, the server's /api/pick_file, /api/pick_folder and /api/pick_file_primer open a real
 * dialog on the developer's screen (osascript, PowerShell or Tk) and wait up to minutes for it. A
 * headless test that clicks Open… or Browse… would put one there. Every browser context a spec gets
 * from this `test` answers those requests itself with "cancelled", so the server is never asked.
 *
 * - Specs import `test` from here (or from ./server, which extends it), never from @playwright/test.
 * - A spec that tests a picker mocks it with page.route, which takes precedence over this route.
 * - A context a spec makes itself (browser.newContext()) needs `await blockNativeDialogs(context)`.
 */
import { test as base, type BrowserContext } from '@playwright/test';

/** The server's native file and folder dialogs (Open…, Browse…, primer files). */
export const NATIVE_DIALOG_ROUTE = /\/api\/pick_(?:file|folder|file_primer)(?:\?|$)/;

export async function blockNativeDialogs(context: BrowserContext): Promise<void> {
  await context.route(NATIVE_DIALOG_ROUTE, route => {
    process.stderr.write(`[e2e] answered a native file dialog request in the test: ${route.request().url()}\n`);
    return route.fulfill({
      json: { success: false, cancelled: true, path: null, paths: [], message: 'Native file dialogs are off in e2e tests' },
    });
  });
}

export const test = base.extend({
  context: async ({ context }, use) => {
    await blockNativeDialogs(context);
    await use(context);
  },
});

export { expect } from '@playwright/test';
