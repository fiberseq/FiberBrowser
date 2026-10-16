#!/usr/bin/env node
/**
 * Long-lived Playwright worker for /api/render?engine=playwright.
 *
 * One Chromium browser, contexts-per-request. Up to N concurrent in-flight
 * renders (default 4, override via FIBERBROWSER_RENDER_CONCURRENCY). Speaks
 * length-prefixed framed JSON over stdin/stdout:
 *
 *     <8-byte zero-padded decimal length>\n<JSON payload>\n
 *
 * Requests have a uuid id; responses echo the id so out-of-order replies are
 * fine (Python-side dispatches by id). Lifecycle frames carry `id: null` and
 * a `kind` (one of "log" | "ready" | "shutdown") for the parent to filter.
 *
 * Per-request: spawn a context with the requested viewport + deviceScaleFactor,
 * navigate to `<url>?render=1`, wait for the store hook + render-ready flag,
 * inject state via setState, screenshot [data-testid="tracks-region"], return
 * base64 PNG. Per-request errors are caught locally — only the offending
 * Future fails; sibling contexts keep running.
 *
 * stderr is teed to whatever logfile the parent points at; stdout is the
 * dedicated wire so don't ever console.log from this script.
 */
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';

const CONCURRENCY = Math.max(
  1,
  parseInt(process.env.FIBERBROWSER_RENDER_CONCURRENCY || '4', 10) || 4,
);
const DEFAULT_TIMEOUT_MS = 30_000;
// Store-hook wait scales with the request timeout (floor 5s, cap 30s). The
// old hardcoded 5s value caused intermittent 502s on big merged datasets
// under memory pressure even when callers passed `timeoutMs: 120000` —
// Bug 4 in the FiberCNN bug report.
const STORE_WAIT_CAP_MS = 30_000;
const STORE_WAIT_FLOOR_MS = 5_000;
const READY_POLL_MS = 100;
const READY_STABILIZE_MS = 200;
// Settle period for the pending-fetch counter — zero inflight must hold for
// this long before we consider the page truly idle. Prevents snapping mid-burst
// when one fetch resolves moments before the next one starts. Pairs with the
// __FIBERBROWSER_PENDING_FETCHES counter set up in renderMode.ts to fix Bug 3
// (settlement firing while reads tracks still show "Loading…").
const FIGURE_FETCH_IDLE_MS = 600;
const FETCH_IDLE_STABILIZE_MS = 250;

let browserPromise = null;
let inFlight = 0;
let shuttingDown = false;
const pendingDuringShutdown = new Set();

function log(msg, extra = {}) {
  // CRITICAL: spread extras BEFORE id/kind/msg so caller-provided fields
  // can't override the lifecycle marker. A previous bug: callers passed
  // `{ id: requestId, ... }` for diagnostic context (e.g. settlement_timeout),
  // and the spread overrode `id: null` → Python's dispatcher treated the log
  // frame as a render response, resolved that request's Future with the log,
  // and dropped the actual render result. Users saw "unknown render error".
  writeFrame({ ...extra, id: null, kind: 'log', msg });
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      // GPU rasterization isn't safe inside headless Chromium on every Mac
      // GPU/driver combo; keep it conservative.
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browserPromise;
}

/**
 * Read a single length-prefixed frame from stdin. Returns null on EOF.
 */
function readFrames(onFrame, onClose) {
  let buf = Buffer.alloc(0);
  process.stdin.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    // Parse as many complete frames as the buffer holds.
    while (true) {
      if (buf.length < 9) return;
      const header = buf.subarray(0, 8).toString('utf8');
      const lengthChar = buf[8];
      if (lengthChar !== 0x0a /* '\n' */) {
        // Malformed framing — skip a byte and retry. (Defensive; the parent
        // controls framing so this shouldn't happen in practice.)
        buf = buf.subarray(1);
        continue;
      }
      const payloadLen = parseInt(header, 10);
      if (!Number.isFinite(payloadLen) || payloadLen < 0) {
        buf = buf.subarray(1);
        continue;
      }
      const total = 9 + payloadLen + 1; // header + '\n' + payload + trailing '\n'
      if (buf.length < total) return;
      const payload = buf.subarray(9, 9 + payloadLen).toString('utf8');
      buf = buf.subarray(total);
      try {
        const frame = JSON.parse(payload);
        Promise.resolve(onFrame(frame)).catch(err => {
          log('frame_handler_error', { error: String(err?.stack || err) });
        });
      } catch (err) {
        log('frame_parse_error', { error: String(err), payload_preview: payload.slice(0, 200) });
      }
    }
  });
  process.stdin.on('end', () => onClose?.());
  process.stdin.on('close', () => onClose?.());
}

function writeFrame(obj) {
  try {
    const payload = JSON.stringify(obj);
    const len = Buffer.byteLength(payload, 'utf8');
    const header = String(len).padStart(8, '0');
    process.stdout.write(header + '\n' + payload + '\n');
  } catch (err) {
    process.stderr.write('[render-headless] write_frame_error: ' + String(err) + '\n');
  }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutdown_begin', { in_flight: inFlight, pending: pendingDuringShutdown.size });
  writeFrame({ id: null, kind: 'shutdown' });
  try {
    if (browserPromise) {
      const browser = await browserPromise;
      await browser.close().catch(() => undefined);
    }
  } catch {}
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

/**
 * Run one render. Resolves with a response envelope; never throws.
 */
async function renderOne(req) {
  const id = req.id;
  const startMs = Date.now();
  const timings = {};
  let phaseStartMs = startMs;
  const markTiming = (name) => {
    const now = Date.now();
    timings[name] = now - phaseStartMs;
    phaseStartMs = now;
  };
  const timeoutMs = req.timeoutMs || DEFAULT_TIMEOUT_MS;
  const viewport = req.viewport || { width: 2000, height: 1200 };
  const deviceScaleFactor = req.deviceScaleFactor || 1;
  const state = req.state || {};
  const url = req.url;

  if (!url) {
    return { id, ok: false, error: 'request missing url' };
  }

  let browser, context, page;
  try {
    browser = await getBrowser();
    markTiming('browser_ms');
    context = await browser.newContext({
      viewport: { width: Math.max(200, viewport.width), height: Math.max(200, viewport.height) },
      deviceScaleFactor,
      // Skip animations + reduce noise.
      reducedMotion: 'reduce',
    });
    page = await context.newPage();
    markTiming('context_page_ms');

    // Forward page console errors into the worker log for debugging.
    // Also write to stderr so they end up in ~/.fiberhmm/logs/render_worker.log (the
    // framed `log()` channel goes to stdout where the Python parent
    // silently discards lifecycle frames — they don't reach the logfile).
    page.on('pageerror', err => {
      const s = String(err?.stack || err);
      log('page_error', { id, error: s });
      process.stderr.write(`[page_error id=${id}] ${s.slice(0, 600)}\n`);
    });
    page.on('crash', () => {
      log('page_crash', { id });
      process.stderr.write(`[page_crash id=${id}]\n`);
    });

    const renderUrl = url.includes('?')
      ? `${url}&render=1`
      : `${url}?render=1`;
    await page.goto(renderUrl, { waitUntil: 'load', timeout: timeoutMs });
    markTiming('goto_ms');

    // Wait for the store hook to be exposed. Scale with the request's
    // timeoutMs (Bug 4): callers passing generous timeouts (e.g. 120s for big
    // merged datasets) need the store wait to scale up too, or it bottlenecks
    // here with a 502 long before the request budget is spent. Floor 5s for
    // small requests; cap 30s as a sanity guard.
    const storeWaitMs = Math.min(
      STORE_WAIT_CAP_MS,
      Math.max(STORE_WAIT_FLOOR_MS, timeoutMs),
    );
    await page.waitForFunction(
      () => Boolean(window.__FIBERBROWSER_STORE__),
      undefined,
      { timeout: storeWaitMs },
    );
    markTiming('store_hook_ms');

    if (req.figure) {
      // Figure mode: restore a full browser state (session/live view) the way
      // a session import does, then export like the Export button.
      await page.waitForFunction(
        () => typeof window.__fiberbrowserApplyFigureState === 'function',
        undefined,
        { timeout: storeWaitMs },
      );
      await page.evaluate(({ baseJson, resultJson }) => {
        const store = window.__FIBERBROWSER_STORE__;
        const base = JSON.parse(baseJson);
        if (Object.keys(base).length) store.setState(base);
        return window.__fiberbrowserApplyFigureState(JSON.parse(resultJson));
      }, {
        baseJson: JSON.stringify(req.figure.baseState || {}),
        resultJson: JSON.stringify(req.figure.importResult || {}),
      });
    } else {
      // Inject all RenderRequest-derived state in one setState call so React
      // re-renders once. Object is plain JSON; Sets/Maps inside `state` are
      // re-created in the page context to satisfy Zustand expectations.
      await page.evaluate(({ stateJson }) => {
        const store = window.__FIBERBROWSER_STORE__;
        if (!store) throw new Error('store hook missing');
        const incoming = JSON.parse(stateJson);
        // Re-hydrate Set-typed fields the store expects.
        if (Array.isArray(incoming.selectedPeaks)) incoming.selectedPeaks = new Set(incoming.selectedPeaks);
        if (incoming.selectedDatasets && Array.isArray(incoming.selectedDatasets)) {
          incoming.selectedDatasets = new Set(incoming.selectedDatasets);
        }
        // filteredReadIds is shaped { datasetId: Set<string> | null } in the
        // store. The Python payload ships arrays per datasetId; hydrate each
        // value into a Set so ReadTrack's `filteredReadIds[stateKey]` lookup
        // gets the type it expects (otherwise filter is silently ignored —
        // this was Bug 1 in the FiberCNN bug report).
        if (incoming.filteredReadIds && typeof incoming.filteredReadIds === 'object') {
          const hydrated = {};
          for (const [dsid, value] of Object.entries(incoming.filteredReadIds)) {
            hydrated[dsid] = Array.isArray(value) ? new Set(value) : value;
          }
          incoming.filteredReadIds = hydrated;
        }
        // activeColormap deep-merge. Zustand setState is shallow per top-level
        // key, so sending a partial activeColormap (e.g. just `{qualityShading:
        // {enabled: true}}` when Python wants to toggle shading without a live
        // colormap source) would replace the entire object — wiping rules,
        // layerOpacities, qualityFilters, etc. That breaks the React tree
        // (ReadTrackCanvas reads activeColormap.qualityShading.mode, ColormapEditor
        // reads .rules, etc.) and the page renders 0 canvases.
        // Merge field-by-field so partial activeColormap payloads are additive,
        // preserving the store's DEFAULT_COLORMAP for everything not specified.
        if (incoming.activeColormap && typeof incoming.activeColormap === 'object') {
          const current = store.getState().activeColormap || {};
          const merged = { ...current, ...incoming.activeColormap };
          // Same shallow-replace risk one level deeper for qualityShading + qualityFilters.
          if (incoming.activeColormap.qualityShading) {
            merged.qualityShading = {
              ...(current.qualityShading || {}),
              ...incoming.activeColormap.qualityShading,
            };
          }
          incoming.activeColormap = merged;
        }
        // Reset render-ready before applying state so the ensuing re-render
        // re-arms the marker.
        window.__FIBERBROWSER_RENDER_READY = false;
        store.setState(incoming);
      }, { stateJson: JSON.stringify(state) });
    }
    markTiming('inject_state_ms');

    // Wait for the ready flag set by Browser.tsx's render-mode effect (two
    // RAF cycles after the latest chrom/start/end/panels change), PLUS canvas
    // count stable, PLUS no in-flight fetches for FETCH_IDLE_STABILIZE_MS.
    //
    // The fetch-idle check is the Bug 3 fix: previously a track that displays
    // "Loading…" while its data fetch was in flight would draw a populated
    // canvas (with the placeholder text) and the canvas-count check would
    // pass — so the worker would screenshot a half-loaded page. We now also
    // wait for renderMode.ts's __FIBERBROWSER_PENDING_FETCHES counter to drop
    // to 0 and stay there for FETCH_IDLE_STABILIZE_MS.
    let lastCount = -1;
    let canvasStableSince = 0;
    let fetchIdleSince = 0;
    let lastPending = -1;
    let lastReadsReady = false;
    const readyTimeoutMs = timeoutMs;
    const deadline = Date.now() + readyTimeoutMs;
    let ready = false;
    let lastReason = null;
    while (Date.now() < deadline) {
      // Fetch settles at response headers; a streamed read body may still be arriving and drawing.
      const probe = await page.evaluate(() => {
        const tracks = [...document.querySelectorAll('[data-read-track-dataset-id]')];
        return {
          ready: Boolean(window.__FIBERBROWSER_RENDER_READY),
          canvases: document.querySelectorAll('canvas').length,
          pending: Number(window.__FIBERBROWSER_PENDING_FETCHES ?? 0),
          readsReady: tracks.every(track => track.dataset.readTrackLoading === 'false'
            && track.querySelector('canvas[data-copilot-track="reads"]')?.dataset.readTrackReady === 'true'),
          readError: tracks.find(track => track.dataset.readTrackError && track.dataset.readTrackLoading !== 'true')?.dataset.readTrackError,
        };
      });
      if (probe.readError) throw new Error(probe.readError);
      lastReadsReady = probe.readsReady;
      const now = Date.now();
      if (probe.canvases !== lastCount) {
        lastCount = probe.canvases;
        canvasStableSince = now;
      }
      // Reset the fetch-idle clock whenever pending changes (including 0→N).
      if (probe.pending !== lastPending) {
        lastPending = probe.pending;
        fetchIdleSince = probe.pending === 0 ? now : 0;
      } else if (probe.pending === 0 && fetchIdleSince === 0) {
        // First poll observing a stable zero — start the idle clock now.
        fetchIdleSince = now;
      }
      const canvasStable = now - canvasStableSince >= READY_STABILIZE_MS;
      // Figure mode fetches genes/tracks like the live app, behind a 300 ms
      // debounce, so idle must last longer than that to mean "done".
      const fetchIdle = probe.pending === 0
        && fetchIdleSince > 0
        && now - fetchIdleSince >= (req.figure ? FIGURE_FETCH_IDLE_MS : FETCH_IDLE_STABILIZE_MS);
      if (probe.ready && canvasStable && fetchIdle && probe.readsReady && probe.canvases > 0) {
        ready = true;
        break;
      }
      lastReason = !probe.ready ? 'ready_flag' : (!probe.readsReady ? 'read_tracks' : (!canvasStable ? 'canvas_count' : (!fetchIdle ? `pending=${probe.pending}` : 'no_canvas')));
      await new Promise(r => setTimeout(r, READY_POLL_MS));
    }
    markTiming('settle_ms');

    let partial = false;
    let reason = null;
    if (!ready) {
      if (!lastReadsReady) throw new Error('Reads did not finish drawing before the render timeout. Wait for reads to load or use a smaller view, then export again.');
      partial = true;
      reason = `settlement timeout after ${readyTimeoutMs}ms (canvases=${lastCount}, blocked_on=${lastReason || 'unknown'}, pending_fetches=${lastPending})`;
      log('settlement_timeout', {
        id,
        lastCount,
        durationMs: readyTimeoutMs,
        blockedOn: lastReason,
        pendingFetches: lastPending,
      });
    }

    if (req.figure) {
      // The export itself waits for expanded/count-matched tracks to redraw.
      const exportTimeoutMs = Math.max(30_000, timeoutMs);
      const figure = await Promise.race([
        page.evaluate(options => window.__fiberbrowserExportFigure(options), req.figure.export || {}),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`figure export timed out after ${exportTimeoutMs}ms`)), exportTimeoutMs)),
      ]);
      markTiming('export_ms');
      return {
        id,
        ok: true,
        format: req.figure.export?.format || 'png',
        figure_b64: figure.b64,
        width: figure.width,
        height: figure.height,
        partial,
        reason,
        diagnostics: {
          duration_ms: Date.now() - startMs,
          canvas_count: lastCount,
          pending_fetches_at_capture: lastPending,
          timings,
        },
      };
    }

    // Locate the screenshot target. Prefer the tagged tracks-region; fall
    // back to <body> if the test id was stripped (e.g. stale dist).
    const target = page.locator('[data-testid="tracks-region"]').first();
    const targetCount = await target.count();
    const screenshotBuffer = targetCount > 0
      ? await target.screenshot({ type: 'png', timeout: 5_000 })
      : await page.screenshot({ type: 'png', fullPage: false, timeout: 5_000 });
    markTiming('screenshot_ms');

    const diagnostics = {
      duration_ms: Date.now() - startMs,
      canvas_count: lastCount,
      target_anchor_found: targetCount > 0,
      pending_fetches_at_capture: lastPending,
      store_wait_ms: storeWaitMs,
      timings,
    };

    return {
      id,
      ok: true,
      format: 'png',
      png_b64: screenshotBuffer.toString('base64'),
      partial,
      reason,
      diagnostics,
    };
  } catch (err) {
    const s = String(err?.stack || err);
    log('render_error', { id, error: s });
    process.stderr.write('[render_error id=' + id + '] ' + s.slice(0, 600) + '\n');
    return {
      id,
      ok: false,
      error: String(err?.message || err),
      diagnostics: { duration_ms: Date.now() - startMs, timings },
    };
  } finally {
    try { if (context) await context.close(); } catch {}
  }
}

async function handleRequest(frame) {
  if (!frame || frame.id == null) {
    // Lifecycle / control frame
    if (frame?.kind === 'shutdown') return shutdown();
    return;
  }
  if (shuttingDown) {
    writeFrame({ id: frame.id, ok: false, error: 'worker shutting down' });
    return;
  }
  if (inFlight >= CONCURRENCY) {
    writeFrame({
      id: frame.id,
      ok: false,
      error: 'concurrency exceeded',
      diagnostics: { in_flight: inFlight, limit: CONCURRENCY },
    });
    return;
  }
  inFlight += 1;
  try {
    const response = await renderOne(frame);
    writeFrame(response);
  } finally {
    inFlight -= 1;
  }
}

async function startWorker() {
  try {
    // Launch Chromium before announcing ready. If the browser binary or Linux
    // shared libraries are missing, the Python parent will time out waiting for
    // this frame and convert the worker log into an install hint.
    await getBrowser();
    writeFrame({ id: null, kind: 'ready', pid: process.pid, concurrency: CONCURRENCY });
    log('worker_started', { node: process.version, concurrency: CONCURRENCY });
    readFrames(handleRequest, () => shutdown());
  } catch (err) {
    process.stderr.write('[render-headless] startup_error: ' + String(err?.stack || err) + '\n');
    process.exit(1);
  }
}

startWorker();
