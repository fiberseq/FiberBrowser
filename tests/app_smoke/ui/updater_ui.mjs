// The FiberHMM update offer in the UI: the start-up banner names it, View opens the update dialog, and its FiberHMM
// section offers "Update FiberHMM to <version>". Nothing is clicked that installs (the install routes are refused and
// counted by openContext). args: { base, outdir }
import { pw, args, main, outFile, openContext, watchErrors } from './common.mjs';

await main(async res => {
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const context = await openContext(browser);
    const page = await context.newPage();
    const errors = watchErrors(page);
    await page.goto(args.base);
    const banner = page.getByTestId('app-update-banner');
    await banner.waitFor({ state: 'visible', timeout: 60000 });
    res.banner = (await banner.innerText()).slice(0, 300);
    await page.screenshot({ path: outFile('banner.png') });
    await banner.getByRole('button', { name: 'View' }).click();
    const dialog = page.getByTestId('app-update-dialog');
    await dialog.waitFor({ state: 'visible', timeout: 15000 });
    const section = dialog.getByTestId('fiberhmm-updates');
    await section.getByText(/FiberHMM \S+ is available/).waitFor({ timeout: 60000 });
    res.section = (await section.innerText()).slice(0, 600);
    const button = section.getByRole('button', { name: /^Update FiberHMM to / });
    res.install_button = { count: await button.count(), text: await button.first().textContent().catch(() => null), enabled: await button.first().isEnabled().catch(() => null) };
    await page.screenshot({ path: outFile('dialog.png') });
    res.blocked = context.blocked;
    res.page_errors = errors.page;
  } finally { await browser.close(); }
});
