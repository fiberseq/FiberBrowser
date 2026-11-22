// Can this machine run the browser-driven smoke? Launches headless Chromium and WebKit once.
import { pw } from './common.mjs';
for (const type of [pw.chromium, pw.webkit]) {
  const browser = await type.launch({ headless: true });
  await browser.close();
}
console.log('ok');
