/**
 * Headless render-mode bootstrap. Imported FIRST in main.tsx — before App,
 * before any store hook ever runs — so the globals are in place by the time
 * the React tree starts mounting.
 *
 * When the URL carries `?render=1`, this:
 *   1. Sets the legacy E2E flags so the genome autoload is disabled and the
 *      Zustand store hook is exposed on `window.__FIBERBROWSER_STORE__`
 *      (App.tsx checks `__FIBERBROWSER_E2E_EXPOSE_STORE`).
 *   2. Sets `__FIBERBROWSER_RENDER_MODE = true` so render-only UI tweaks
 *      (chrome-hiding CSS, the ready-signal effect in Browser.tsx) activate.
 *   3. Adds the `render-mode` class to <html> so renderMode.css can scope
 *      its chrome-hiding rules to render-only sessions.
 *   4. Pre-declares `__FIBERBROWSER_RENDER_READY = false` and the
 *      `__fiberbrowserMarkRenderReady(meta?)` setter the worker waits on.
 *
 * The worker (browser/frontend/scripts/render-headless.mjs) navigates with
 * the query param, injects state via `setState(...)`, and then waits for
 * `__FIBERBROWSER_RENDER_READY === true` before screenshotting.
 */
declare global {
  interface Window {
    __FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD?: boolean;
    __FIBERBROWSER_E2E_EXPOSE_STORE?: boolean;
    __FIBERBROWSER_RENDER_MODE?: boolean;
    __FIBERBROWSER_RENDER_READY?: boolean;
    __FIBERBROWSER_RENDER_META?: Record<string, unknown>;
    __fiberbrowserMarkRenderReady?: (meta?: Record<string, unknown>) => void;
    /**
     * In render mode, every network request the page initiates increments
     * this counter on start and decrements on resolve/reject. The headless
     * worker waits for it to reach 0 (stable) before screenshotting, so
     * track canvases that still display "Loading…" don't make it into the
     * screenshot.
     */
    __FIBERBROWSER_PENDING_FETCHES?: number;
  }
}

function inRenderMode(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('render') === '1';
  } catch {
    return false;
  }
}

if (inRenderMode()) {
  window.__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
  window.__FIBERBROWSER_E2E_EXPOSE_STORE = true;
  window.__FIBERBROWSER_RENDER_MODE = true;
  window.__FIBERBROWSER_RENDER_READY = false;
  window.__FIBERBROWSER_PENDING_FETCHES = 0;

  // The worker may inject state and call the marker more than once (e.g. on
  // a setState that adds a new dataset and triggers another fetch). The
  // latest meta wins; readiness is a sticky one-way flip.
  window.__fiberbrowserMarkRenderReady = (meta?: Record<string, unknown>) => {
    if (meta) window.__FIBERBROWSER_RENDER_META = { ...(window.__FIBERBROWSER_RENDER_META ?? {}), ...meta };
    window.__FIBERBROWSER_RENDER_READY = true;
  };

  // Monkey-patch window.fetch so the worker can observe in-flight requests.
  // Without this the worker can pass settlement while a reads track still
  // shows "Loading…" in the canvas (the canvas IS drawn — just with a
  // placeholder — so a canvas-count-stability check alone fails open).
  //
  // Counts ALL same-origin requests, including ones from libraries that
  // bypass sharedFetch. Only active when ?render=1, so live sessions pay
  // nothing.
  const originalFetch = window.fetch.bind(window);
  window.fetch = function trackedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    window.__FIBERBROWSER_PENDING_FETCHES = (window.__FIBERBROWSER_PENDING_FETCHES ?? 0) + 1;
    const settle = () => {
      // Use Math.max to guard against any double-decrement (shouldn't happen,
      // but a stuck counter would silently break every future render).
      window.__FIBERBROWSER_PENDING_FETCHES = Math.max(
        0,
        (window.__FIBERBROWSER_PENDING_FETCHES ?? 0) - 1,
      );
    };
    try {
      return originalFetch(input, init).finally(settle);
    } catch (err) {
      settle();
      throw err;
    }
  };

  // The render-mode CSS lives in renderMode.css; tag the root so its
  // selectors (html.render-mode .Sidebar, etc.) become active.
  // If `?nudges=1` is also present, opt back into the in-track warning
  // overlays (read-filter-empty, span-empty, hints). Default is hidden
  // so figure renders are clean.
  const showNudges = (() => {
    try {
      return new URLSearchParams(window.location.search).get('nudges') === '1';
    } catch {
      return false;
    }
  })();
  const applyClasses = () => {
    document.documentElement.classList.add('render-mode');
    if (showNudges) {
      document.documentElement.classList.add('render-mode-show-nudges');
    }
  };
  if (document.documentElement) {
    applyClasses();
  } else {
    // Edge case: this module runs before <html> is parsed (rare with
    // module-level execution; here as a safety belt).
    document.addEventListener('DOMContentLoaded', applyClasses);
  }
}

export {};
