/**
 * Analysis commands for the command bus and the ⌘K palette (fb-n3-search):
 * the analyses people look for by name ("proj", "t-sne", "footprint
 * classes"), each doing what its own button does, where that button lives:
 *
 * - Find footprint classes: Footprints › Classes, its Find button;
 * - Open projection: Clusters › Projection (the t-SNE map of the clustered reads);
 * - Export projection table: Clusters › Projection, its Export table button;
 * - Cluster reads with Neighbourhoods: the Cluster group with that method;
 * - Sort reads by projection: the Sort group's "By projection (t-SNE)";
 * - Co-occupancy: Footprints › Co-occupancy (the saved footprints and classes, compared).
 *
 * A command whose button would be disabled says why instead (APP_COMMAND_INFO's
 * `disabledReason`, shown in the palette).
 */
import { useBrowserStore } from '../stores/browserStore';

// Panels that open on a requested tab: read when they mount, the event moves an open one
// (as utils/dataExportActions' openPanelForExport; kept here so the command bus stays light).
const TAB_REQUESTS = {
  'footprint-analysis': { storageKey: 'fiberbrowser_footprint_analysis_tab', event: 'fiberbrowser:open-footprint-analysis-tab' },
  'cluster-detail': { storageKey: 'fiberbrowser_cluster_detail_tab', event: 'fiberbrowser:open-cluster-detail-tab' },
} as const;

/** Open an analysis panel on one of its tabs (or show it there when it is open). */
export function openPanelOnTab(panel: keyof typeof TAB_REQUESTS, tab: string): void {
  const request = TAB_REQUESTS[panel];
  try { window.sessionStorage.setItem(request.storageKey, tab); } catch { /* opens on its last tab */ }
  useBrowserStore.getState().openAnalysisPanel(panel as never);
  queueMicrotask(() => window.dispatchEvent(new CustomEvent(request.event, { detail: { tab, source: 'command' } })));
}

const WAIT_MS = 4000;

/** Tells an open Find classes card to drop a region set in place of its choice (coordinates typed, a restored run). */
export const CLASS_REGION_RESET_EVENT = 'fiberbrowser:class-region-reset';

/** The first element matching `selector` once it is in the page (panels mount after a render). */
function waitForElement<T extends HTMLElement>(selector: string, ready: (el: T) => boolean = () => true, timeoutMs = WAIT_MS): Promise<T | null> {
  const started = Date.now();
  return new Promise(resolve => {
    const look = () => {
      const found = Array.from(document.querySelectorAll<T>(selector)).find(el => ready(el)) ?? null;
      if (found) { resolve(found); return; }
      if (Date.now() - started >= timeoutMs) { resolve(null); return; }
      window.setTimeout(look, 50);
    };
    look();
  });
}

/** Show a control the user can then use (scrolled into view and focused). */
function reveal(el: HTMLElement): void {
  el.scrollIntoView?.({ block: 'nearest' });
  el.focus({ preventScroll: true });
}

const FOOTPRINTS = '[data-panel-content-type="footprint-analysis"]';
const CLUSTERS = '[data-panel-content-type="cluster-detail"]';

/** Some dataset is open (the analyses need reads). */
export const hasDatasets = (): boolean => useBrowserStore.getState().datasets.length > 0;

/** Some panel has cluster assignments (the projection maps the clustered reads). */
export function hasClusters(): boolean {
  return Object.values(useBrowserStore.getState().clusterAssignments ?? {}).some(a => Object.keys(a ?? {}).length > 0);
}

export const NEEDS_DATASET = 'Open a dataset first';
export const NEEDS_CLUSTERS = 'Cluster reads first: the projection maps the clustered reads';

/**
 * Find footprint classes: Footprints › Classes and its Find button, pressed
 * when it would run (a finished run is left as it is: "Find again" would redo
 * it, so it is only shown).
 */
export async function findFootprintClasses(): Promise<boolean> {
  if (!hasDatasets()) return false;
  openPanelOnTab('footprint-analysis', 'states');
  const selector = `${FOOTPRINTS} [data-testid="run-lattice-consensus"]`;
  // The button mounts disabled while the panel loads its settings and history: wait until it can run.
  const button = await waitForElement<HTMLButtonElement>(selector, el => !el.disabled, 8000)
    ?? document.querySelector<HTMLButtonElement>(selector);
  if (!button) return false;
  const again = button.textContent?.trim() === 'Find again';
  if (button.disabled || again) {
    reveal(button);
    return false;
  }
  button.click();
  return true;
}

/**
 * Find classes in this view: the region choice becomes This view (an undo
 * step, as choosing it in the card), then Find as above.
 */
export async function findFootprintClassesInView(): Promise<boolean> {
  if (!hasDatasets()) return false;
  const store = useBrowserStore.getState();
  if (store.classRegionMode !== 'view') store.setClassRegionMode('view');
  // An open card also drops coordinates set by hand there.
  window.dispatchEvent(new CustomEvent(CLASS_REGION_RESET_EVENT));
  openPanelOnTab('footprint-analysis', 'states');
  // Run only once the card names the view: its Find button then sends the view (not the region shown before).
  await waitForElement(`${FOOTPRINTS} [data-testid="class-region"][data-source="view"]`, () => true, 8000);
  return findFootprintClasses();
}

/** Clusters › Projection. */
export function openProjection(): boolean {
  openPanelOnTab('cluster-detail', 'projection');
  return true;
}

/** Clusters › Projection, then its Export table (once the map has loaded). */
export async function exportProjectionTable(): Promise<boolean> {
  if (!hasClusters()) return false;
  openProjection();
  const button = await waitForElement<HTMLButtonElement>(`${CLUSTERS} [data-testid="projection-export"]`, el => !el.disabled, 30_000);
  if (!button) return false;
  button.click();
  return true;
}

/** Footprints › Co-occupancy. */
export function openCoOccupancy(): boolean {
  openPanelOnTab('footprint-analysis', 'co-occ');
  return true;
}
