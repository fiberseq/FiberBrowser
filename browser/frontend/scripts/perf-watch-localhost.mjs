#!/usr/bin/env node
import { chromium } from 'playwright';

const autoPan = process.argv.includes('--auto-pan') || process.env.FIBERBROWSER_PERF_AUTO_PAN === '1';
const target = process.argv.find(arg => !arg.startsWith('--') && arg !== process.argv[0] && arg !== process.argv[1]) || 'http://localhost:8000';
const url = new URL(target);
url.searchParams.set('perf', '1');

const requestStart = new Map();
const interesting = [
  '/api/reads/compact',
  '/api/reads/compact_all',
  '/api/scan_peaks',
  '/api/tracks/batch',
  '/api/genes',
  '/api/sequence',
];

function isInteresting(rawUrl) {
  return interesting.some(path => rawUrl.includes(path));
}

function summarizePath(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return `${u.pathname}${u.search}`;
  } catch {
    return rawUrl;
  }
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage({ viewport: { width: 1728, height: 1117 } });

page.on('console', async msg => {
  const text = msg.text();
  if (text.startsWith('[perf]') || text.includes('longtask')) {
    const args = await Promise.all(msg.args().map(async arg => {
      try { return await arg.jsonValue(); } catch { return undefined; }
    }));
    console.log('[browser]', text, ...args.slice(1));
  }
});

page.on('request', req => {
  if (isInteresting(req.url())) requestStart.set(req, Date.now());
});

page.on('response', async res => {
  const req = res.request();
  const started = requestStart.get(req);
  if (!started || !isInteresting(res.url())) return;
  requestStart.delete(req);
  const elapsed = Date.now() - started;
  const path = summarizePath(res.url());
  let parsed = null;
  const contentType = res.headers()['content-type'] || '';
  if (contentType.includes('application/json')) {
    try { parsed = await res.json(); } catch {}
  }
  const serverMs = numberOrNull(parsed?.server_elapsed_ms);
  const timings = parsed?.server_timings;
  const reads = Array.isArray(parsed?.reads)
    ? parsed.reads.length
    : parsed?.datasets
      ? Object.values(parsed.datasets).reduce((sum, ds) => sum + (Array.isArray(ds?.reads) ? ds.reads.length : 0), 0)
      : undefined;
  const total = parsed?.total ?? parsed?.total_in_scope;
  const peaks = Array.isArray(parsed?.peaks) ? parsed.peaks.length : undefined;
  console.log('[network]', JSON.stringify({
    ms: elapsed,
    status: res.status(),
    path,
    serverMs,
    timings,
    reads,
    total,
    peaks,
  }));
});

await page.addInitScript(() => {
  localStorage.setItem('fiberbrowser_perf_debug', '1');
  window.__FIBERBROWSER_E2E_EXPOSE_STORE = true;
  const longTaskObserver = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      console.warn('[perf] longtask', {
        ms: Math.round(entry.duration * 10) / 10,
        start: Math.round(entry.startTime * 10) / 10,
      });
    }
  });
  try { longTaskObserver.observe({ entryTypes: ['longtask'] }); } catch {}

  let lastFrame = performance.now();
  let maxGap = 0;
  let dropped = 0;
  const tick = () => {
    const now = performance.now();
    const gap = now - lastFrame;
    if (gap > maxGap) maxGap = gap;
    if (gap > 50) dropped++;
    lastFrame = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  setInterval(() => {
    if (maxGap > 35 || dropped > 0) {
      console.warn('[perf] raf.gaps', {
        maxMs: Math.round(maxGap * 10) / 10,
        dropped,
      });
    }
    maxGap = 0;
    dropped = 0;
  }, 1000);
});

await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
console.log(`[watch] Opened ${url.toString()}`);
if (autoPan) {
  await page.waitForFunction(() => {
    const store = window.__FIBERBROWSER_STORE__;
    return Boolean(store?.getState?.().datasets?.length);
  }, { timeout: 10000 }).catch(() => undefined);
  await page.evaluate(() => {
    const store = window.__FIBERBROWSER_STORE__;
    const state = store?.getState?.();
    if (!state?.datasets?.length) return;
    const hasVisibleReads = state.panels?.some(panel => (
      !panel.collapsed &&
      panel.contentType === 'dataset' &&
      panel.subTracks?.some(track => track.type === 'reads' && track.visible)
    ));
    if (!hasVisibleReads && typeof state.addPanel === 'function') {
      state.addPanel(state.datasets[0].id);
    }
  });
  console.log('[watch] Auto-pan enabled; pressing ArrowRight after initial settle.');
  await page.waitForTimeout(1500);
  await page.keyboard.press('ArrowRight');
} else {
  console.log('[watch] Use the opened Chromium window normally. Press Ctrl+C here when done.');
}

process.on('SIGINT', async () => {
  await browser.close();
  process.exit(0);
});

await new Promise(() => {});
