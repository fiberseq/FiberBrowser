/**
 * The guided tour in its own tab: a sandbox (utils/sandbox.ts) that starts
 * empty, loads the demo, and can never change the user's work.
 *
 *   openTourTab()                   from a click handler in the main tab
 *   openTourTab({ stepId: 'x' })    same, starting the tour at step `x`
 *   isSandboxTab()                  true in the tour's tab
 *   tourRequestFromUrl()            what the tour tab was opened to do
 *
 * The tour tab starts the tour by itself (useTourTabAutostart).
 */
import { withRootPath } from './rootPath';
import { isSandboxPage, validSandboxId } from './sandbox';
import { buildDefaultPanelLauncher, usePanelLauncherStore } from '../stores/panelLauncherStore';

export interface TourTabOptions {
  /** Start the tour at this step (a TourStep id). */
  stepId?: string;
}

export interface TourRequest {
  tour: boolean;
  stepId?: string;
}

/** The address a tour tab for this sandbox opens at. */
export function tourTabUrl(sandbox: string, opts: TourTabOptions = {}): string {
  const params = new URLSearchParams({ sandbox, tour: '1' });
  if (opts.stepId) params.set('step', opts.stepId);
  // The tab's storage starts empty: it shows the panel buttons where this viewer has them.
  const launcher = usePanelLauncherStore.getState().mode;
  if (launcher !== buildDefaultPanelLauncher()) params.set('panels', launcher);
  return `/?${params.toString()}`;
}

/**
 * Open the tour in a new tab running on a fresh sandbox.
 *
 * Call it straight from a click handler: the tab is opened synchronously
 * (so popup blockers allow it) and navigated once the sandbox exists.
 * Resolves to the new window, or null when it couldn't be opened (blocked,
 * or the server refused a sandbox, e.g. a --public server); the caller can
 * then fall back to running the tour in place.
 */
export async function openTourTab(opts: TourTabOptions = {}): Promise<Window | null> {
  // No `noopener`: with it, window.open returns null and the tab can't be
  // navigated once the sandbox exists. The opener link is cut below.
  const tab = window.open('about:blank', '_blank');
  if (!tab) return null;
  try {
    tab.opener = null;
  } catch { /* read-only here: harmless */ }
  try {
    tab.document.title = 'FiberBrowser tour';
    tab.document.body.textContent = 'Starting the tour…';
  } catch { /* not scriptable: it navigates below anyway */ }
  try {
    const response = await fetch('/api/sandbox', { method: 'POST' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !validSandboxId(body?.id)) throw new Error(body?.detail || 'No sandbox');
    // Another window's location isn't covered by the page's URL-prefix layer.
    tab.location.href = withRootPath(tourTabUrl(body.id, opts));
    return tab;
  } catch {
    try { tab.close(); } catch { /* already gone */ }
    return null;
  }
}

/** This tab is a sandbox (the tour's tab). */
export function isSandboxTab(): boolean {
  return isSandboxPage();
}

/** What this tab was opened for: `?tour=1[&step=<id>]`. */
export function tourRequestFromUrl(search: string = typeof window === 'undefined' ? '' : window.location.search): TourRequest {
  const params = new URLSearchParams(search);
  const tour = params.get('tour') === '1';
  const step = params.get('step');
  return tour && step ? { tour, stepId: step } : { tour };
}

/** Drop `tour`/`step` from the address bar, so a reload doesn't start the tour again. */
export function clearTourRequestFromUrl(): void {
  try {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('tour') && !params.has('step')) return;
    params.delete('tour');
    params.delete('step');
    const query = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  } catch { /* leave the address bar */ }
}
