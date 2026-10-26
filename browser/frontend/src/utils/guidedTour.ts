import { panelReversed } from '../hooks/usePanelDisplayStore';
/**
 * Guided tour: a scripted Copilot tutorial-mode run over the bundled demo
 * dataset. Each step rings the button it is about, explains it in a
 * popover (with how to do it yourself), and where it makes sense does the
 * step for you (load, scan peaks, select, cluster, open panels). No model is
 * involved, so it works with Copilot off.
 */
import { revealDrawerPanel } from '../stores/drawerTabsStore';
import { getDemo, loadDemo, type DemoEntry, type DemoId, type DemoInfo, type DemoReference, type DemoRegion } from '../api/demo';
import { getChromosomes } from '../api/reference';
import { getDatasets, removeDataset as removeDatasetOnServer } from '../api/datasets';
import { executeBrowserAction, type BrowserAction } from '../actions/browserActions';
import { useBrowserStore } from '../stores/browserStore';
import { serializeState, type Snapshot } from '../stores/historySlice';
import { sameChrom } from './chromAliases';
import type { PanelConfig } from '../types';
import { SIDEBAR_WIDTH } from '../components/tracks/read-track/constants';
import { runUiScan } from './clusterRunner';
import { setToolbarGroupOpenState } from '../components/controls/ToolbarGroups';
import { isCopilotIncluded } from './copilotIncluded';
import { READ_ACTIONS_HINT } from './shortcuts';
import { highlightSelectedPeaks, highlightView } from './highlightActions';
import { fetchJson } from '../api/sharedFetch';
import { seedHistoryBaseline } from '../stores/historySlice';
import { useRegionCatalogStore } from '../stores/regionCatalogStore';
import { panelLauncherIsRail } from '../stores/panelLauncherStore';

export interface TourStep {
  /** Stable id (for starting the tour at a step: the Tutorial panel, ?tour=1&step=<id>). */
  id: string;
  /** The Tutorial panel groups steps by section. */
  section: string;
  title: string;
  text: string;
  /** "Do it yourself: …" line. */
  how?: string;
  /** Element to point at: CSS selector (or one worked out when the step is reached), or a data-copilot-anchor key. */
  selector?: string | ((session: TourSession) => string);
  anchor?: string;
  /** UI set-up before the step is explained (e.g. folding a toolbar group); must be idempotent. */
  before?: (session: TourSession) => Promise<void>;
  /** Its action/run makes something later steps need (the demo, peaks, clusters, a footprint):
   *  replayed quietly when the tour starts at a later step. 'section': only needed by the
   *  rest of its own section (e.g. the footprint classes, a minute's work), so replayed only
   *  when the tour starts at a later step of that section. */
  prereq?: boolean | 'section';
  /** The step only makes sense when this holds (e.g. a class run finished): skipped otherwise. */
  when?: (session: TourSession) => boolean;
  /** The last step: ends with a choice to reset the browser or keep exploring. */
  final?: boolean;
  /** Analysis panel to open and flash (its header is the target if nothing else is).
   *  Panels the tour opened close again when a step no longer needs them. */
  panel?: string;
  /** Clicked before the step is explained (e.g. a panel's tab), so it shows what it's about. */
  click?: string;
  /** The operations-toolbar group its control is in: shown (the More menu opened) when the row has no room for it. */
  toolbarGroup?: string;
  /** Browser action the step performs after Next (scan, cluster, …). */
  action?: BrowserAction;
  /** Or tour-only work after Next. */
  run?: (session: TourSession) => Promise<void>;
  /** When it fails, the tour can't go on (e.g. loading the demo). */
  essential?: boolean;
}

const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl';

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (check()) return true;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return check();
}

/** Select the strongest scanned peaks in view (the tour's stand-in for clicking them). */
export async function selectTopPeaks(count = 2, panelId: string | null = null): Promise<number> {
  await waitFor(() => useBrowserStore.getState().getAllPeaks().some(p => !p.isCustom), 15_000);
  // In the toured panel's view (it may show another locus than the main view;
  // peaks without a chrom were scanned in the main view).
  const st = useBrowserStore.getState();
  const view = st.panels.find(p => p.id === panelId)?.viewportOverride ?? { chrom: st.chrom, start: st.start, end: st.end };
  const peaks = st.getAllPeaks()
    .filter(p => !p.isCustom && sameChrom(p.chrom ?? st.chrom, view.chrom) && p.end > view.start && p.start < view.end)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (a.layer ?? 0) - (b.layer ?? 0))
    .slice(0, count)
    .sort((a, b) => a.start - b.start);
  // Only the selection: clearPeakSelection would also drop every panel's clusters and filters.
  useBrowserStore.getState().replacePeakSelection(peaks.map(p => p.index));
  return peaks.length;
}

/** One run of the tour. Ending it (End tour, anywhere) releases the tour at once. */
interface TourSession {
  ended: boolean;
  /** A step's action is running: the user's selection comes back once it settles. */
  busy: boolean;
  /** The user's panel selection, restored when the tour ends (the tour selects the demo panel), */
  restoreSelection: Set<string> | null;
  /** unless the selection is no longer the one the tour set. */
  tourSelection: Set<string> | null;
  bar: HTMLElement | null;
  /** The dataset panel the tour is about (the demo's); its clicks and pointers go there. */
  panelId: string | null;
  /** Analysis panels the tour opened (the only ones it closes). */
  ownedPanels: Set<string>;
  /** What the tour changes for the demonstration, put back when it ends. */
  saved: {
    selectedReadIds: Record<string, Set<string>>;
    selectedFootprints: unknown[];
    clusterMethod: string;
    clusterK: number;
    fullViewPanelId: string | null;
    selectedPeaks: Array<{ ruleId?: string; chrom?: string; start: number; end: number; mode?: string }>;
    peaksLocked: boolean;
  };
  /** This tour's 'Before the guided tour' snapshot (anything was loaded), kept here so it restores even after leaving the history. */
  snapshot: Snapshot | null;
  /** Touring the user's own data (no demo): their peak selection comes back too. */
  ownData: boolean;
  /** The demo dataset, when this tour added it to this page (removed again), */
  addedDemoId: string | null;
  /** and whether this tour also loaded it on the server (unloaded again). */
  loadedDemoOnServer: boolean;
  /** Other datasets this tour added to the page (the structural-variant demo, the insert-expanded carriers), removed likewise. */
  extraDatasets: Array<{ id: string; onServer: boolean }>;
  /** The structural-variant demo this tour shows (its dataset id), and its insertion. */
  svDemoId: string | null;
  svInsertion: { chrom: string; ref: number; len: number } | null;
  /** The panel the tour opened with the insert expanded. */
  altPanelId: string | null;
  /** cleanUp ran (it runs once). */
  cleaned: boolean;
  /** Collapsed layout rows the tour expanded to show its panels. */
  expandedRows: Set<number>;
  /** The primer panel's state before the tour (a snapshot keeps only saved primers). */
  primer: unknown;
  /** Toolbar groups the tour folded or unfolded, with how they were (put back when it ends). */
  toolbarGroups: Map<string, boolean>;
  /** Saved footprints the tour created (removed again unless the user keeps the tour's state). */
  createdFootprintGroupIds: string[];
  /** Highlights the tour made (removed again unless the user keeps the tour's state). */
  createdHighlightIds: string[];
  /** Saved regions (and categories) the tour made, by reference (removed again likewise). */
  createdRegions: Array<{ genome: string; entryIds: string[]; categoryIds: string[] }>;
  /** At the end: the user chose "Reset the browser" (else, having reached the end, "Keep exploring"). */
  resetChosen: boolean;
  /** "Keep exploring": leave the tour's demo, clusters, footprints and panels as they are. */
  keep: boolean;
}

let current: TourSession | null = null;

export function isTourRunning(): boolean {
  return current !== null;
}

function restoreSelection(session: TourSession): void {
  const saved = session.restoreSelection;
  session.restoreSelection = null;
  if (!saved) return;
  const st = useBrowserStore.getState();
  if (st.selectedDatasets !== session.tourSelection) return;  // the user chose since
  const ids = new Set(st.panels.map(p => p.id));
  useBrowserStore.setState({ selectedDatasets: new Set([...saved].filter(id => ids.has(id))) });
}

/** The panel that was maximized before the tour, maximized again (if it's still there). */
function restoreFullView(session: TourSession): void {
  const id = session.saved.fullViewPanelId;
  if (id && useBrowserStore.getState().panels.some(p => p.id === id)) useBrowserStore.getState().setFullViewPanel(id);
}

/** Put back what the tour changed for the demonstration, and close the panels it opened. */
function cleanUp(session: TourSession): void {
  if (session.cleaned) return;
  session.cleaned = true;
  // UI the tour only showed off comes back however the tour ends.
  restoreToolbarGroups(session);
  if (session.keep) {
    // "Keep exploring": the demo, clusters, saved footprint and panels stay.
    // (The 'Before the guided tour' snapshot stays in Undo's timeline.)
    session.ownedPanels.clear();
    session.restoreSelection = null;
    return;
  }
  if (session.snapshot) {
    // The user had data of their own: everything goes back as it was (panels,
    // links, clusters, filters, selections, view), and the demo is removed.
    session.ownedPanels.clear();
    session.restoreSelection = null;
    backToUserData(session);
    removeCreatedFootprints(session);
    removeCreatedRegions(session);
    restoreFullView(session);
    return;
  }
  removeCreatedFootprints(session);
  removeCreatedHighlights(session);
  removeCreatedRegions(session);
  if (session.resetChosen) removeAddedDemo(session);
  restoreSelection(session);
  restoreFullView(session);
  for (const row of session.expandedRows) {
    if (!useBrowserStore.getState().collapsedRows.has(row)) useBrowserStore.getState().toggleRowCollapsed(row);
  }
  const saved = session.saved;
  const st = useBrowserStore.getState() as unknown as {
    setClusterMethod?: (m: string) => void; setClusterK?: (k: number) => void;
  };
  st.setClusterMethod?.(saved.clusterMethod);
  st.setClusterK?.(saved.clusterK);
  useBrowserStore.setState({
    selectedReadIds: saved.selectedReadIds,
    selectedFootprints: saved.selectedFootprints as never,
  });
  // Touring the user's data: their peak selection (with its modes) and lock come
  // back. Matched by position, as a rescan renumbers peaks. (On the demo the view
  // moved, so their peaks aren't there to select.)
  if (session.ownData) {
    const peaks = useBrowserStore.getState().getAllPeaks();
    const selected = new Set<number>();
    const modes: Record<number, string> = {};
    for (const want of saved.selectedPeaks) {
      const match = peaks.find(p => (p.ruleId ?? null) === (want.ruleId ?? null)
        && p.start === want.start && p.end === want.end && (p.chrom ?? null) === (want.chrom ?? null));
      if (!match) continue;
      selected.add(match.index);
      if (want.mode) modes[match.index] = want.mode;
    }
    useBrowserStore.setState({ selectedPeaks: selected, peakModes: modes as never });
    useBrowserStore.getState().setPeaksLocked(saved.peaksLocked);
  }
  for (const id of session.ownedPanels) {
    if (useBrowserStore.getState().panels.some(p => p.id === id)) useBrowserStore.getState().removePanel(id);
  }
  session.ownedPanels.clear();
}

function finishTour(session: TourSession): void {
  session.ended = true;
  session.bar?.remove();
  session.bar = null;
  // Not while a step still runs: it would act on the user's panels. Then the
  // runner's finally cleans up and releases the tour.
  if (session.busy) return;
  cleanUp(session);
  if (current === session) current = null;
}

/** Take the snapshot and return it; history skips pushes right after an undo, so wait that out once. */
async function takeTourSnapshot(): Promise<Snapshot> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = useBrowserStore.getState()._historyStack;
    useBrowserStore.getState().pushSnapshot(BEFORE_TOUR, { kind: 'layout' });
    const after = useBrowserStore.getState()._historyStack;
    const added = after.length > 0 && after[after.length - 1] !== before[before.length - 1] ? after[after.length - 1] : null;
    if (added && added.label === BEFORE_TOUR) return added;
    await new Promise(resolve => setTimeout(resolve, 1700));
  }
  // History wouldn't take it (paused, or right after an undo): keep our own.
  return { label: BEFORE_TOUR, timestamp: Date.now(), state: serializeState(useBrowserStore.getState()), kind: 'layout' };
}

/**
 * Back to how things were before the tour: the demo (if the tour added it to
 * this page) is removed first, so the snapshot's panels and links apply in
 * full (history restores layout only when the datasets match), then the
 * snapshot, view included. The server copy goes only if this tour loaded it.
 */
function backToUserData(session: TourSession): void {
  removeAddedDemo(session);
  const live = useBrowserStore.getState().primer;
  // The snapshot may have left the history meanwhile (an undo then a new
  // change, or the history's size limit): put it back on top to restore it.
  const snapshot = session.snapshot as Snapshot;
  let index = useBrowserStore.getState()._historyStack.indexOf(snapshot);
  if (index < 0) {
    const stack = [...useBrowserStore.getState()._historyStack, snapshot];
    useBrowserStore.setState({ _historyStack: stack });
    index = stack.length - 1;
  }
  useBrowserStore.getState().restoreSnapshot(index, { restoreViewport: true });
  // Designed primers and targets aren't in the snapshot: back as they were. A
  // design still running when the tour began has finished (or still runs) since,
  // so its outcome is the live one; the running flag is always the live one.
  const saved = session.primer as typeof live | null;
  if (saved && live) {
    useBrowserStore.setState({
      primer: saved.designing ? live : { ...saved, designing: live.designing, error: live.error },
    });
  }
}

/** The demos, if this tour added them to the page (and unloaded from the server if the tour loaded them). */
function removeAddedDemo(session: TourSession): void {
  const added = [
    ...(session.addedDemoId ? [{ id: session.addedDemoId, onServer: session.loadedDemoOnServer }] : []),
    ...session.extraDatasets,
  ];
  session.addedDemoId = null;
  session.extraDatasets = [];
  for (const { id, onServer } of added) {
    if (useBrowserStore.getState().datasets.some(d => d.id === id)) useBrowserStore.getState().removeDataset(id);
    if (onServer) void removeDatasetOnServer(id).catch(() => { /* stays loaded; harmless */ });
  }
}

/** Saved footprints the tour made. */
function removeCreatedFootprints(session: TourSession): void {
  const ids = new Set(session.createdFootprintGroupIds);
  session.createdFootprintGroupIds = [];
  const st = useBrowserStore.getState();
  for (const g of st.footprintGroups) if (ids.has(g.id)) st.removeFootprintGroup(g.id);
}

// ── Toolbar groups (the ▸/▾ labels that fold a group's controls) ──────────
const groupToggle = (group: string) =>
  document.querySelector(`[data-tour="${group}-controls-expand"]`) as HTMLElement | null;

/** The toolbar's More menu button: groups the row has no room for are in its menu (with all their controls). */
const MORE_BUTTON = '[data-testid="toolbar-groups-more"]';
/** session.toolbarGroups key for the More menu. */
const MORE_MENU = '(more)';
const moreButton = () => document.querySelector(MORE_BUTTON) as HTMLElement | null;
const expanded = (el: HTMLElement | null) => el?.getAttribute('aria-expanded') === 'true';
/** A group's own open state: it may be open but drawn folded to leave the reads room (ToolbarGroups, audit H5). */
const groupOpen = (el: HTMLElement | null) => (el?.hasAttribute('data-group-open') ? el.getAttribute('data-group-open') === 'true' : expanded(el));

/** The group is in the More menu (the window is too narrow for it in the row). */
export function toolbarGroupInMore(group: string): boolean {
  return (moreButton()?.getAttribute('data-toolbar-overflow') ?? '').split(' ').includes(group);
}

async function setMoreMenuOpen(open: boolean): Promise<void> {
  const more = moreButton();
  if (!more) return;
  if (expanded(more) !== open) more.click();
  await waitFor(() => expanded(moreButton()) === open, 1500);
}

/** Open or fold a group; one in the More menu shows (all its controls) while the menu is open. */
export async function setToolbarGroupOpen(group: string, open: boolean): Promise<void> {
  if (toolbarGroupInMore(group)) {
    await setMoreMenuOpen(open);
    return;
  }
  const toggle = groupToggle(group);
  if (!toggle) return;
  // Idempotent: only click when it isn't already as wanted.
  if (expanded(toggle) !== open) toggle.click();
  await waitFor(() => expanded(groupToggle(group)) === open, 1500);
}

/** Note how a group (or the More menu it is in) was before the tour first changes it (put back by restoreToolbarGroups). */
export function rememberToolbarGroup(session: TourSession, group: string): void {
  const key = toolbarGroupInMore(group) ? MORE_MENU : group;
  if (session.toolbarGroups.has(key)) return;
  const el = key === MORE_MENU ? moreButton() : groupToggle(group);
  if (!el) return;
  session.toolbarGroups.set(key, key === MORE_MENU ? expanded(el) : groupOpen(el));
}

export function restoreToolbarGroups(session: TourSession): void {
  // Groups open in the row stay open on their own (each remembers it): put each back as it was.
  for (const [group, open] of session.toolbarGroups) {
    const el = group === MORE_MENU ? moreButton() : groupToggle(group);
    if (el && group === MORE_MENU) {
      if (expanded(el) !== open) el.click();
    } else if (el) {
      // By its own state, not how it is drawn: a group folded for room is still open.
      if (groupOpen(el) !== open) setToolbarGroupOpenState(group, open);
    } else if (group !== MORE_MENU) {
      // The group went to More meanwhile (the window narrowed): no toggle to click,
      // but its remembered state still goes back to how the user had it.
      setToolbarGroupOpenState(group, open);
    }
  }
  session.toolbarGroups.clear();
}

/** Highlight the selected peaks (else the view), as the Highlight group's Peaks (View) button does. */
async function highlightForTour(session: TourSession): Promise<void> {
  const ids = highlightSelectedPeaks();
  session.createdHighlightIds.push(...(ids.length > 0 ? ids : highlightView(session.panelId ?? undefined)));
  await new Promise(resolve => setTimeout(resolve, 400));
}

/** Highlights the tour made. (A snapshot restore puts the user's own back.) */
function removeCreatedHighlights(session: TourSession): void {
  const ids = new Set(session.createdHighlightIds);
  session.createdHighlightIds = [];
  for (const h of useBrowserStore.getState().highlights) if (ids.has(h.id)) useBrowserStore.getState().removeHighlight(h.id);
}

/** Save the view in Regions, as Save view then Save do (named after the nearest gene once that's known; a tour tab, with public-mode rules, names it by its coordinates). */
async function saveViewForTour(session: TourSession): Promise<void> {
  const panel = '[data-panel-content-type="circular-genome"]';
  const open = shownElement(`${panel} [data-testid="region-save-view"]`);
  if (!open) return;
  if (!shownElement(`${panel} [data-testid="region-save-confirm"]`)) open.click();
  await waitFor(() => session.ended || Boolean(shownElement(`${panel} [data-testid="region-save-confirm"]`)), 3000);
  // The suggested name (nearest gene) arrives a moment later (never in a tour tab: public-mode rules).
  if (!useBrowserStore.getState().publicMode) {
    await waitFor(() => session.ended || (shownElement(`${panel} [data-testid="region-save-label"]`)?.getAttribute('placeholder') ?? 'Name') !== 'Name', 3000);
  }
  const confirm = shownElement(`${panel} [data-testid="region-save-confirm"]`);
  if (!confirm || session.ended) return;
  const before = useRegionCatalogStore.getState().catalogs;
  const known = (genome: string) => ({
    entries: new Set((before[genome]?.entries ?? []).map(e => e.id)),
    categories: new Set((before[genome]?.categories ?? []).map(c => c.id)),
  });
  confirm.click();
  await new Promise(resolve => setTimeout(resolve, 300));
  for (const [genome, catalog] of Object.entries(useRegionCatalogStore.getState().catalogs)) {
    const had = known(genome);
    const entryIds = catalog.entries.filter(e => !had.entries.has(e.id)).map(e => e.id);
    const categoryIds = catalog.categories.filter(c => !had.categories.has(c.id)).map(c => c.id);
    if (entryIds.length || categoryIds.length) session.createdRegions.push({ genome, entryIds, categoryIds });
  }
}

/**
 * Saved regions the tour made, and the categories it made for them once nothing
 * else is in them (removing a category also removes its subheadings and their
 * regions, so one the user has since added to, or put a subheading under, stays).
 */
export function removeCreatedRegions(session: Pick<TourSession, 'createdRegions'>): void {
  const made = session.createdRegions;
  session.createdRegions = [];
  const store = useRegionCatalogStore.getState();
  for (const { genome, entryIds, categoryIds } of made) {
    if (entryIds.length) store.removeEntries(genome, entryIds);
    const catalog = useRegionCatalogStore.getState().catalogFor(genome);
    for (const id of categoryIds) {
      const used = catalog.entries.some(e => e.category === id) || catalog.categories.some(c => c.parent === id);
      if (!used) useRegionCatalogStore.getState().removeCategory(genome, id);
    }
  }
}

/** Save the Cmd+clicked footprint (its size range at that spot), as the Save button does. */
async function saveSelectedFootprint(session: TourSession): Promise<void> {
  const selector = '[data-panel-content-type="footprint-analysis"] [data-copilot-anchor="footprint-add-group"]';
  const shown = () => Array.from(document.querySelectorAll(selector))
    .find(el => el.getClientRects().length > 0 && !(el as HTMLButtonElement).disabled) as HTMLElement | undefined;
  // The spot's analysis may still be loading.
  await waitFor(() => session.ended || Boolean(shown()), 15_000);
  const button = shown();
  if (!button) return;
  const before = new Set(useBrowserStore.getState().footprintGroups.map(g => g.id));
  button.click();
  await waitFor(() => useBrowserStore.getState().footprintGroups.some(g => !before.has(g.id)), 3000);
  for (const g of useBrowserStore.getState().footprintGroups) {
    if (!before.has(g.id) && !g.autoGeneratedFamily) session.createdFootprintGroupIds.push(g.id);
  }
}

const FOOTPRINT_PANEL = '[data-panel-content-type="footprint-analysis"]';
const CLASS_TABLE = `${FOOTPRINT_PANEL} [data-testid="recaller-class-table"]`;
/** How long the tour waits for Find footprint classes (a 4 kb view takes a minute or two). */
const CLASS_RUN_TIMEOUT_MS = 6 * 60_000;

const shownElement = (selector: string) => Array.from(document.querySelectorAll(selector))
  .find(el => el.getClientRects().length > 0) as HTMLElement | undefined;

/** A finished class run is on show (its class table). */
export function classTableShown(): boolean {
  return Boolean(shownElement(CLASS_TABLE));
}

/**
 * Find footprint classes, as its button does, and wait for the class table.
 * Leaves a finished run as it is (Find again would redo it).
 */
async function findFootprintClasses(session: TourSession): Promise<void> {
  const button = `${FOOTPRINT_PANEL} [data-testid="run-lattice-consensus"]`;
  await waitFor(() => session.ended || classTableShown() || Boolean(shownElement(button)), 5000);
  if (session.ended || classTableShown()) return;
  const run = shownElement(button) as HTMLButtonElement | undefined;
  if (!run || run.disabled) throw new Error('Find footprint classes is not available here');
  run.click();
  // While it runs, the button is disabled and Cancel shows. A finished run turns it into
  // Find again (the table follows once the classes load); a failed one shows its error
  // and enables the button again as it was.
  const started = Date.now();
  const finished = () => shownElement(button)?.textContent?.trim() === 'Find again';
  const failed = () => {
    const again = shownElement(button) as HTMLButtonElement | undefined;
    const cancel = Array.from(document.querySelectorAll(`${FOOTPRINT_PANEL} [data-testid="consensus-tools"] button`))
      .some(b => b.textContent?.trim() === 'Cancel');
    return Date.now() - started > 5000 && Boolean(again) && !again!.disabled && !cancel && !finished();
  };
  await waitFor(() => session.ended || classTableShown() || finished() || failed(), CLASS_RUN_TIMEOUT_MS);
  if (finished()) await waitFor(() => session.ended || classTableShown(), 60_000);
  if (!session.ended && !classTableShown()) throw new Error('Finding footprint classes did not finish');
}

/** Save the first class of the table (S1), as its Save button does. */
async function saveFirstClass(session: TourSession): Promise<void> {
  const save = shownElement(`${CLASS_TABLE} [data-testid="recaller-save"][aria-pressed="false"]`);
  if (!save) return;
  const before = new Set(useBrowserStore.getState().footprintGroups.map(g => g.id));
  save.click();
  await waitFor(() => session.ended || useBrowserStore.getState().footprintGroups.some(g => !before.has(g.id)), 3000);
  for (const g of useBrowserStore.getState().footprintGroups) {
    if (!before.has(g.id) && !g.autoGeneratedFamily) session.createdFootprintGroupIds.push(g.id);
  }
}

/** A saved class is listed in Saved. */
const savedClassListed = () => useBrowserStore.getState().footprintGroups.some(g => g.savedClass);

/** The saved classes' prevalence plot, shown. */
async function showSavedClassPlot(): Promise<void> {
  await waitFor(() => Boolean(shownElement(`${FOOTPRINT_PANEL} [data-testid="saved-classes-plot"]`)), 3000);
  const plot = shownElement(`${FOOTPRINT_PANEL} [data-testid="saved-classes-plot"]`);
  if (plot && plot.textContent?.trim() === 'Plot') plot.click();
  await new Promise(resolve => setTimeout(resolve, 600));
}

/** Compare strands, unfolded (it is a <details>). */
async function openCompareStrands(): Promise<void> {
  const details = shownElement(`${FOOTPRINT_PANEL} [data-testid="compare-datasets"]`) as HTMLDetailsElement | undefined;
  if (details && !details.open) details.open = true;
  await new Promise(resolve => setTimeout(resolve, 400));
  try { details?.scrollIntoView({ block: 'start' }); } catch { /* not scrollable */ }
}

/** The footprint the tour saved (else the first one listed), opened in the Saved tab. */
function savedEntrySelector(session: TourSession): string {
  const id = session.createdFootprintGroupIds[session.createdFootprintGroupIds.length - 1];
  return id
    ? `[data-panel-content-type="footprint-analysis"] [data-saved-group-id="${id}"]`
    : '[data-panel-content-type="footprint-analysis"] [data-testid="saved-row"]';
}

async function openSavedEntry(session: TourSession): Promise<void> {
  const rowSelector = savedEntrySelector(session);
  await waitFor(() => Boolean(document.querySelector(`${rowSelector} [data-tour="saved-entry-open"]`)), 3000);
  const open = document.querySelector(`${rowSelector} [data-tour="saved-entry-open"]`) as HTMLElement | null;
  if (open && open.getAttribute('aria-expanded') !== 'true') open.click();
  await new Promise(resolve => setTimeout(resolve, 400));
}

/** Analysis panels open now (to tell which ones a tour step opened). */
const analysisPanelIds = () => new Set(useBrowserStore.getState().panels.filter(p => p.contentType !== 'dataset').map(p => p.id));

function claimNewPanels(session: TourSession, before: Set<string>): void {
  for (const id of analysisPanelIds()) if (!before.has(id)) session.ownedPanels.add(id);
}

/**
 * Start something the tour does and claim the panels it opens synchronously
 * (a click handler, an action's spotlight). Panels that appear later, while it
 * awaits (e.g. one the user opens during a clustering request), stay the user's.
 */
function tourDoes<T>(session: TourSession, start: () => Promise<T>): Promise<T> {
  const before = analysisPanelIds();
  const pending = start();
  claimNewPanels(session, before);
  return pending;
}

/** End the running tour, if any. */
export function endGuidedTour(): void {
  if (current) finishTour(current);
}

/** While a step works (loading, clustering…): a small bar with End tour, so it can always be stopped. */
function showWorking(session: TourSession, title: string): void {
  session.bar?.remove();
  const bar = document.createElement('div');
  bar.className = 'copilot-tutorial-working';
  bar.setAttribute('role', 'status');
  const label = document.createElement('span');
  label.textContent = `Tour: ${title}…`;
  const end = document.createElement('button');
  end.textContent = 'End tour';
  end.className = 'copilot-tutorial-end';
  end.addEventListener('click', () => finishTour(session));
  bar.append(label, end);
  document.body.appendChild(bar);
  session.bar = bar;
}

/** Expand the toured panel's layout row if it's collapsed (the snapshot, or cleanUp, collapses it again). */
function showPanelRow(panel: PanelConfig | null, session: TourSession): void {
  if (!panel) return;
  const row = panel.layoutRow ?? (panel.layoutPosition === 'column' ? 1 : 0);
  const store = useBrowserStore.getState();
  if (!store.collapsedRows.has(row)) return;
  store.toggleRowCollapsed(row);
  session.expandedRows.add(row);
}

function hideWorking(session: TourSession): void {
  session.bar?.remove();
  session.bar = null;
}

/** A request that got no answer (the connection failed or was cut), as opposed to the server's error answer. */
export function unanswered(err: unknown): boolean {
  return err instanceof TypeError;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `request`, asked again (up to `tries` times in all) while `retry` says its failure is worth another go. */
export async function askAgainIfUnanswered<T>(
  request: () => Promise<T>,
  { tries = 3, waitMs = 1000, retry = unanswered }: { tries?: number; waitMs?: number; retry?: (err: unknown) => boolean } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await request();
    } catch (err) {
      if (attempt >= tries || !retry(err)) throw err;
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }
}

/**
 * The demo the tour runs on, if this server has one. A tour tab has nothing
 * else to tour, so there it asks again after any failure before giving up;
 * `error` then says what went wrong.
 */
export async function findTourDemo(sandbox: boolean, waitMs = 1000): Promise<{ info: DemoInfo | null; error: string | null }> {
  try {
    const info = await askAgainIfUnanswered(() => getDemo(), sandbox ? { tries: 4, waitMs, retry: () => true } : { tries: 1 });
    return { info, error: null };
  } catch (err) {
    return { info: null, error: errorText(err) };
  }
}

/**
 * Load the demo (once), show its panel, and go to its region; the tour's first
 * real step. With other data loaded, the tour's actions are kept to the demo:
 * its panel is unlinked and selected (the user's selection comes back after).
 */
async function showDemo(region: DemoRegion, session: TourSession, demoId?: DemoId): Promise<void> {
  // Loaded once on the server, so asking again after a request that got no answer is safe.
  let res: Awaited<ReturnType<typeof loadDemo>>;
  try {
    res = await askAgainIfUnanswered(() => loadDemo(demoId));
  } catch (err) {
    if (!unanswered(err)) throw err;
    throw new Error(`FiberBrowser didn't answer while loading the demo (${errorText(err)}). Start the tour again in a moment.`);
  }
  if (!res.success) throw new Error(res.error || 'Could not load the demo dataset');
  if (res.reference) await showDemoReference(res.reference);
  const id = res.dataset_id ?? res.dataset?.id;
  if (!id) throw new Error('The demo dataset loaded without an id');
  if (!useBrowserStore.getState().datasets.some(d => d.id === id)) {
    let dataset = res.dataset;
    if (!dataset) dataset = (await getDatasets()).datasets.find(d => d.id === id);
    if (!dataset) throw new Error('The demo dataset is loaded on the server but could not be shown');
    useBrowserStore.getState().addDataset(dataset);
    if (demoId) {
      session.extraDatasets.push({ id, onServer: !res.already_loaded });
    } else {
      session.addedDemoId = id;
      session.loadedDemoOnServer = !res.already_loaded;
    }
    try {
      useBrowserStore.getState().setChroms((await getChromosomes()).chroms);
    } catch { /* the chromosome list refreshes on the next load */ }
  }
  if (session.ended) return;
  const store = useBrowserStore.getState();
  // A panel that follows the main view (one closed, or moved to its own locus, is replaced).
  let panel = store.panels.find(p => p.contentType === 'dataset' && p.datasetId === id && !p.viewportOverride && !p.strand);
  if (!panel) {
    const panelId = store.addPanel(id);
    panel = useBrowserStore.getState().panels.find(p => p.id === panelId);
  }
  if (panel) {
    session.panelId = panel.id;
    if (panel.collapsed) store.setPanelCollapsed(panel.id, false);
    showPanelRow(panel, session);
    // Any other dataset panel, copies of the demo included.
    const others = store.panels.some(p => p.contentType === 'dataset' && p.datasetId && p.id !== panel.id);
    if (others) {
      if (panel.linkGroup) store.unlinkPanel(panel.id);
      // (The user's own selection, from before the first demo: kept for the end.)
      if (!session.restoreSelection) session.restoreSelection = new Set(store.selectedDatasets);
      session.tourSelection = new Set([panel.id]);
      useBrowserStore.setState({ selectedDatasets: session.tourSelection });
    }
    if (demoId) {
      // Another demo, at another locus: the panels that follow the main view (the first demo's) fold away meanwhile.
      for (const p of useBrowserStore.getState().panels) {
        if (p.contentType === 'dataset' && p.id !== panel.id && !p.viewportOverride && !p.collapsed) useBrowserStore.getState().setPanelCollapsed(p.id, true);
      }
    }
  }
  const r = res.region ?? region;
  useBrowserStore.getState().setViewport(r.chrom, r.start, r.end);
  const key = panel?.stateKey ?? id;
  await waitFor(() => session.ended || (useBrowserStore.getState().activeReadIds[key]?.length ?? 0) > 0, 30_000);
}

/**
 * The tour tab's reference changed with the demo (the server loaded the demo's
 * genome into the tour's sandbox, or dropped another genome it can't replace):
 * show it as the genome picker would, so there is no mismatch banner and the
 * chromosome list is the demo's.
 */
async function showDemoReference(reference: DemoReference): Promise<void> {
  const store = useBrowserStore.getState();
  store.setHasFasta(reference.has_fasta);
  store.setFastaPath(null);
  store.setCurrentGenome(reference.genome);
  try {
    store.setChroms((await getChromosomes()).chroms);
  } catch { /* the chromosome list refreshes on the next load */ }
  useBrowserStore.getState().triggerRefresh();
}

const BEFORE_TOUR = 'Before the guided tour';

/** Open the step's panel and close the ones the tour opened that it doesn't need. */
async function arrangePanels(step: TourStep, session: TourSession): Promise<void> {
  for (const id of [...session.ownedPanels]) {
    const p = useBrowserStore.getState().panels.find(x => x.id === id);
    if (!p) { session.ownedPanels.delete(id); continue; }
    if (p.contentType === step.panel) continue;
    useBrowserStore.getState().removePanel(id);
    session.ownedPanels.delete(id);
  }
  if (step.panel) {
    const existing = useBrowserStore.getState().panels.find(p => p.contentType === step.panel);
    if (!existing) {
      const before = analysisPanelIds();
      useBrowserStore.getState().openAnalysisPanel(step.panel);
      claimNewPanels(session, before);
    } else if (existing.collapsed) {
      useBrowserStore.getState().setPanelCollapsed(existing.id, false);
    } else {
      // Open, perhaps behind another tab of the side-panel drawer or in a tucked drawer.
      revealDrawerPanel(existing.id);
    }
    // Its layout row may be collapsed (cleanUp, or the snapshot, collapses it again).
    showPanelRow(useBrowserStore.getState().panels.find(p => p.contentType === step.panel) ?? null, session);
    await waitFor(() => Boolean(document.querySelector(`[data-panel-content-type="${step.panel}"]`)), 3000);
  }
  if (step.click) {
    const selector = scoped(step.click, session);
    const shown = () => Array.from(document.querySelectorAll(selector)).find(e => e.getClientRects().length > 0) as HTMLElement | undefined;
    await waitFor(() => Boolean(shown()), 3000);
    const el = shown();
    if (el) {
      el.click();
      await new Promise(resolve => setTimeout(resolve, 400));
    }
  }
}

/** A step's selector with $panel standing for the tour's dataset panel. */
function scoped(selector: string, session: TourSession): string {
  return selector.replace(/\$panel\s*/g, panelScope(session.panelId));
}

/** A CSS scope for the tour's panel ('' when it has none). */
const panelScope = (panelId: string | null) => (panelId ? `[data-panel-id="${panelId}"] ` : '');

/** The reads canvas of the tour's panel. */
function readsCanvas(panelId: string | null): HTMLCanvasElement | null {
  const found = Array.from(document.querySelectorAll(`${panelScope(panelId)}canvas[data-copilot-track="reads"]`))
    .find(el => el.getClientRects().length > 0);
  return (found as HTMLCanvasElement | undefined) ?? null;
}

/** A real click on the reads (so the browser's own handlers run), at fractions of the canvas. */
function clickReads(canvas: HTMLCanvasElement, fx: number, fy: number, keys: { meta?: boolean; shift?: boolean }): void {
  const r = canvas.getBoundingClientRect();
  canvas.dispatchEvent(new MouseEvent('click', {
    bubbles: true, cancelable: true, view: window,
    clientX: r.left + fx * r.width, clientY: r.top + fy * r.height,
    metaKey: !!keys.meta, ctrlKey: !!keys.meta && mod === 'Ctrl', shiftKey: !!keys.shift,
  }));
}

/**
 * Cmd+click a footprint, as a user would: a TF-sized one inside a selected
 * peak if there is one, else any footprint there. Tries a few spots in the
 * peaks (not the whole view), yielding between clicks, and stops once one
 * lands (or the tour ends). Opens it in the Footprints panel.
 */
async function cmdClickAFootprint(session: TourSession): Promise<boolean> {
  const canvas = readsCanvas(session.panelId);
  if (!canvas) return false;
  const st = useBrowserStore.getState();
  const panel = st.panels.find(p => p.id === session.panelId);
  const view = panel?.viewportOverride ?? { chrom: st.chrom, start: st.start, end: st.end };
  const peaks = st.getAllPeaks().filter(p => st.selectedPeaks.has(p.index) && sameChrom(p.chrom ?? st.chrom, view.chrom));
  const clustered = Object.values(st.clusterAssignments).some(a => a && Object.keys(a).length > 0);
  const sidebar = clustered ? SIDEBAR_WIDTH : 0;
  const width = canvas.clientWidth || canvas.getBoundingClientRect().width;
  const fxOf = (pos: number) => {
    const frac = (pos - view.start) / Math.max(1, view.end - view.start);
    return (sidebar + (panelReversed(st, session.panelId) ? 1 - frac : frac) * (width - sidebar)) / Math.max(1, width);
  };
  const spots = peaks.length > 0
    ? peaks.flatMap(p => [0.3, 0.5, 0.7].map(t => fxOf(p.start + t * (p.end - p.start))))
    : [0.4, 0.55, 0.7];
  st.clearFootprintSelection();
  const footprintPanelOpen = () => useBrowserStore.getState().panels.some(p => p.contentType === 'footprint-analysis');
  let firstHit: [number, number] | null = null;
  let clicks = 0;
  for (const fx of spots) {
    for (let fy = 0.1; fy < 0.95 && clicks < 60; fy += 0.085) {
      if (session.ended) return false;
      clicks += 1;
      const before = useBrowserStore.getState().selectedFootprints.length;
      const openBefore = footprintPanelOpen();
      const panelsBefore = analysisPanelIds();
      clickReads(canvas, fx, fy, { meta: true });
      claimNewPanels(session, panelsBefore);
      const after = useBrowserStore.getState().selectedFootprints;
      if (after.length <= before) {
        // An annotated class (consensus) selection opens the panel instead of selecting.
        if (!openBefore && footprintPanelOpen()) return true;
        continue;
      }
      const fp = after[after.length - 1];
      if (fp.size > 0 && fp.size < 90) return true;
      if (!firstHit) firstHit = [fx, fy];
      useBrowserStore.getState().clearFootprintSelection();
      if (clicks % 8 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  if (firstHit && !session.ended) {
    const panelsBefore = analysisPanelIds();
    clickReads(canvas, firstHit[0], firstHit[1], { meta: true });
    claimNewPanels(session, panelsBefore);
  }
  return Boolean(firstHit);
}

/** Shift+click a few reads, as a user would: they're selected and Read Stats opens. */
async function shiftClickReads(session: TourSession, count = 3): Promise<number> {
  const canvas = readsCanvas(session.panelId);
  if (!canvas) return 0;
  const panelsBefore = analysisPanelIds();
  for (let i = 0; i < count; i += 1) clickReads(canvas, 0.6, 0.15 + i * 0.12, { shift: true });
  claimNewPanels(session, panelsBefore);
  // Let Read Stats fetch the statistics before the next step describes them.
  await new Promise(resolve => setTimeout(resolve, 2000));
  return Object.values(useBrowserStore.getState().selectedReadIds).reduce((n, ids) => n + (ids?.size ?? 0), 0);
}

/** A step's CSS selector, worked out now (with $panel filled in). */
function stepSelector(step: TourStep, session: TourSession): string | undefined {
  if (!step.selector) return undefined;
  return scoped(typeof step.selector === 'function' ? step.selector(session) : step.selector, session);
}

/** Whether a step's element is on screen (a step about a button that isn't there is skipped). */
function targetShown(step: TourStep, session: TourSession): boolean {
  if (!step.selector && !step.anchor) return true;
  const selector = stepSelector(step, session) ?? `[data-copilot-anchor="${step.anchor}"]`;
  try {
    return Array.from(document.querySelectorAll(selector)).some(el => el.getClientRects().length > 0);
  } catch {
    return false;
  }
}

/** The tour runs in a tab of its own (the sandbox tab): at the end it offers to close it. */
const inSandboxTab = () => typeof location !== 'undefined' && new URLSearchParams(location.search).has('sandbox');

/** Fold or unfold a toolbar group for a step, noting first how the user had it. */
async function showToolbarGroup(session: TourSession, group: string, open: boolean): Promise<void> {
  rememberToolbarGroup(session, group);
  await setToolbarGroupOpen(group, open);
}


// ── The Variants section (the structural-variant demo) ──────────────
const VARIANTS = '[data-panel-content-type="variants"]';
/** Where the insert's nucleosome-free region and its central CTCF footprint are, in insert coordinates. */
const INSERT_NFR_VIEW = { start: 3_300, end: 4_300 };
/** The insert's nucleosome-free region and the CTCF footprint at its centre (insert coordinates, Fig. 4c). */
const INSERT_NFR = { start: 3_723, end: 3_879 };
const INSERT_FOOTPRINT = { start: 3_771, end: 3_804 };

/** Load the structural-variant demo beside the first one and go to its insertion. */
async function showSvDemo(sv: DemoEntry, session: TourSession): Promise<void> {
  await showDemo(sv.region, session, 'sv');
  session.svDemoId = session.panelId
    ? useBrowserStore.getState().panels.find(p => p.id === session.panelId)?.datasetId ?? null
    : null;
  session.svInsertion = sv.insertion ?? null;
}

/** The scan the Variants panel shows for the toured dataset (the one it keeps). */
async function variantsScan(session: TourSession) {
  const vs = await import('../features/variants/variantsState');
  const scan = vs.variantsPanelState()?.scan;
  return scan && (!session.svDemoId || scan.dataset_id === session.svDemoId) ? scan : null;
}

/** The Variants panel on the toured dataset (the structural-variant demo), on its SNPs tab. */
async function showVariantsForTour(session: TourSession): Promise<void> {
  const vs = await import('../features/variants/variantsState');
  await waitFor(() => session.ended || Boolean(shownElement(VARIANTS)), 3000);
  vs.updateVariantsState({ tab: 'snps', ...(session.svDemoId ? { datasetId: session.svDemoId } : {}) });
}

/** Find SNPs in view, as its button does, on the toured dataset; wait for the result. */
async function scanSnpsForTour(session: TourSession): Promise<void> {
  const vs = await import('../features/variants/variantsState');
  vs.updateVariantsState({ tab: 'snps', ...(session.svDemoId ? { datasetId: session.svDemoId } : {}) });
  const button = `${VARIANTS} [data-testid="variants-scan"]`;
  await waitFor(() => session.ended || Boolean(shownElement(button)), 5000);
  if (session.ended || (await variantsScan(session))) return;
  shownElement(button)?.click();
  const t0 = Date.now();
  while (!session.ended && Date.now() - t0 < 60_000) {
    if (await variantsScan(session)) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!session.ended) throw new Error('Finding the SNPs did not finish');
}

/** The split panels open now (a split by allele or by SV), by their split set. */
const splitGroupIds = () => [...new Set(useBrowserStore.getState().panels.map(p => p.readSubset?.groupId).filter((g): g is string => Boolean(g)))];

/** Open the split dialog's panels (Open, and Open again when it asks), and wait for the new panels' reads. */
async function openSplitDialog(session: TourSession, before: Set<string>): Promise<void> {
  const open = () => shownElement('[data-testid="variant-split-open"]') as HTMLButtonElement | undefined;
  await waitFor(() => session.ended || Boolean(open() && !open()!.disabled), 15_000);
  if (session.ended || !open()) return;
  open()!.click();
  // More panels than the soft limit ask once more.
  await waitFor(() => session.ended || !open() || Boolean(shownElement('[data-testid="variant-split-confirm"]')), 3000);
  if (open() && shownElement('[data-testid="variant-split-confirm"]')) open()!.click();
  await waitFor(() => session.ended || splitGroupIds().some(g => !before.has(g)), 15_000);
  await waitFor(() => {
    if (session.ended) return true;
    const st = useBrowserStore.getState();
    const panels = st.panels.filter(p => p.readSubset && !before.has(p.readSubset.groupId));
    return panels.length > 0 && panels.every(p => (st.activeReadIds[p.stateKey ?? p.id]?.length ?? 0) > 0);
  }, 30_000);
  await new Promise(resolve => setTimeout(resolve, 600));
}

/**
 * Split the reads by haplotype, as a user would: Combinations → HP tags, then Split into panels… and Open. (On the
 * demo the SNPs the scan finds sit at the insertion's breakpoint, where they come from aligning the insert: the HP
 * tags, phased upstream, are the honest split here.)
 */
async function splitByHaplotypeForTour(session: TourSession): Promise<void> {
  if (!(await variantsScan(session))?.hp.tagged) return;
  const tab = shownElement(`${VARIANTS} [data-analysis-tab="combos"]`);
  tab?.click();
  const hp = `${VARIANTS} [data-testid="variants-source-hp"]`;
  await waitFor(() => session.ended || Boolean(shownElement(hp)), 5000);
  const radio = shownElement(hp) as HTMLInputElement | undefined;
  if (!radio || session.ended) return;
  if (!radio.checked) radio.click();
  const split = `${VARIANTS} [data-testid="variants-combos-split"]`;
  await waitFor(() => session.ended || (shownElement(split) as HTMLButtonElement | undefined)?.disabled === false, 20_000);
  if (session.ended || !shownElement(split)) return;
  const before = new Set(splitGroupIds());
  shownElement(split)!.click();
  await openSplitDialog(session, before);
}

/** A split of the reads is on show (its panels, with Split × in their headers). */
const splitShown = () => splitGroupIds().length > 0 && Boolean(shownElement('[data-testid="split-panel-close-all"]'));

/** Close the split panels: the reads are back in one panel. */
async function closeSplitsForTour(session: TourSession): Promise<void> {
  const { closeSplitPanels } = await import('./splitPanels');
  for (const group of splitGroupIds()) {
    if (session.ended) return;
    await closeSplitPanels(group);
  }
  if (session.panelId) {
    const panel = useBrowserStore.getState().panels.find(p => p.id === session.panelId);
    if (panel?.collapsed) useBrowserStore.getState().setPanelCollapsed(panel.id, false);
  }
  await new Promise(resolve => setTimeout(resolve, 400));
}

/** The SVs tab lists the demo's insertion. */
const svListed = () => Boolean(shownElement(`${VARIANTS} [data-testid="variants-sv"]`));

/**
 * Open the insertion's carriers with the insert expanded, beside the reads, as the SV row's menu item does, and go
 * to the insert's nucleosome-free region; wait for its reads.
 */
async function openInsertForTour(session: TourSession): Promise<void> {
  const ins = session.svInsertion;
  if (!ins || !session.svDemoId) return;
  const { openAltAllelePanel } = await import('../features/altAllele/altAllelePanel');
  const before = new Set(useBrowserStore.getState().datasets.map(d => d.id));
  const id = await openAltAllelePanel({ datasetId: session.svDemoId, chrom: ins.chrom, ref: ins.ref, len: ins.len },
    session.panelId ? { afterPanelId: session.panelId } : {});
  if (!id) throw new Error('Could not open the carriers with the insert expanded');
  session.altPanelId = id;
  const panel = useBrowserStore.getState().panels.find(p => p.id === id);
  if (panel?.datasetId && !before.has(panel.datasetId)) session.extraDatasets.push({ id: panel.datasetId, onServer: true });
  const layout = panel?.altAllele?.layout;
  const chrom = panel?.viewportOverride?.chrom;
  if (layout && chrom) {
    useBrowserStore.getState().navigatePanel(id, chrom, layout.insert_start + INSERT_NFR_VIEW.start, layout.insert_start + INSERT_NFR_VIEW.end);
  }
  const key = panel?.stateKey ?? id;
  await waitFor(() => session.ended || (useBrowserStore.getState().activeReadIds[key]?.length ?? 0) > 0, 30_000);
  // The SV row's per-read insertion flags only clutter the insert: hidden in this panel.
  const sv = useBrowserStore.getState().panels.find(p => p.id === id)?.subTracks.find(t => t.type === 'sv');
  if (sv?.visible) useBrowserStore.getState().toggleSubTrack(id, 'sv', true);
  if (layout && chrom && panel?.datasetId && !session.ended) await sortByInsertNfr(session, id, panel.datasetId, chrom, layout.insert_start);
  await new Promise(resolve => setTimeout(resolve, 800));
}

/**
 * Sort the carriers by accessibility over the insert's NFR (open, with the central footprint, first; then open; then
 * closed), as Sort writes a panel's read order: the NFR and its central footprint show as a block at the top. (A
 * highlight over the footprint would hide its colour.)
 */
async function sortByInsertNfr(session: TourSession, panelId: string, datasetId: string, chrom: string, insertStart: number): Promise<void> {
  const nfr = { start: insertStart + INSERT_NFR.start, end: insertStart + INSERT_NFR.end };
  const fp = { start: insertStart + INSERT_FOOTPRINT.start, end: insertStart + INSERT_FOOTPRINT.end };
  const params = new URLSearchParams({
    chrom, start: String(nfr.start), end: String(nfr.end), dataset_id: datasetId, max_reads: '5000', spanning: 'false',
    include_layers: 'true', layer_names: 'nuc,tf',
  });
  type Interval = [number, number, number?];
  let reads: Array<{ id: string; intervals?: Interval[]; layers?: Record<string, { intervals?: Interval[] }> }> = [];
  try {
    reads = (await fetchJson<{ reads?: typeof reads }>(`/api/reads/compact?${params}`)).reads ?? [];
  } catch {
    return;  // the panel stays in its own order
  }
  if (session.ended || !reads.length) return;
  // Intervals are relative to the request's start.
  const overlaps = (ivs: Interval[] | undefined, a: number, b: number) => (ivs ?? []).some(([s, e]) => s + nfr.start < b && e + nfr.start > a);
  const core = { start: nfr.start + 30, end: nfr.end - 30 };
  const rank = (r: (typeof reads)[number]) => {
    const nucs = r.layers?.nuc?.intervals ?? (r.intervals ?? []).filter(iv => (iv[2] ?? 0) >= 80);
    if (overlaps(nucs, core.start, core.end)) return 2;
    return overlaps(r.layers?.tf?.intervals, fp.start, fp.end) ? 0 : 1;
  };
  const order = reads.map((r, i) => ({ id: r.id, rank: rank(r), i })).sort((a, b) => a.rank - b.rank || a.i - b.i).map(r => r.id);
  const panel = useBrowserStore.getState().panels.find(p => p.id === panelId);
  if (!panel) return;
  seedHistoryBaseline(useBrowserStore.getState(), 'Before sorting', 'sorting');
  useBrowserStore.getState().setReadSortOrder(panel.stateKey ?? panelId, order);
  useBrowserStore.getState().pushSnapshot('Sort by accessibility over the insert\'s NFR');
}

/** The insert-expanded panel the tour opened is there. */
const altPanelShown = (session: TourSession) => Boolean(session.altPanelId && useBrowserStore.getState().panels.some(p => p.id === session.altPanelId));

export function tourSteps(demo: DemoRegion | null, withOwnData = false, sv: DemoEntry | null = null): TourStep[] {
  const wayBack = withOwnData ? ', and your own data comes back as it was' : '';
  const sandbox = inSandboxTab();
  // Where the analysis panel buttons are (Settings › Reads & Display › Analysis panels).
  const rail = panelLauncherIsRail();
  const endChoice = sandbox
    ? 'Keep exploring leaves everything as it is in this tab; Close this tab ends the tour.'
    : `Reset the browser puts everything back as it was${demo ? ' and removes the demo' : ''}; Keep exploring leaves it as it is (Undo's timeline keeps "${BEFORE_TOUR}").`;
  // Keep each step to one or two plain sentences: docs/guide.md has the details.
  const steps: TourStep[] = [
    // ── Getting started ─────────────────────────────────────────────
    {
      id: 'welcome',
      section: 'Getting started',
      title: 'Welcome to FiberBrowser',
      text: demo
        ? `This tour loads a small demo dataset (DddA-seq reads at the NAPA promoter) and shows the main tools, often doing each step for you. Next moves on; End tour stops at any time${wayBack}.`
        : 'This tour shows the main tools on the data you have loaded, often doing each step for you. Next moves on; End tour stops at any time.',
      ...(demo ? { run: (session: TourSession) => showDemo(demo, session), essential: true } : {}),
      prereq: true,
    },
    {
      id: 'loading-data',
      section: 'Getting started',
      title: 'Loading data',
      selector: '[data-testid="load-file-button"]',
      text: 'Open opens BAMs, BigBeds, tracks, a genome FASTA or a saved session; the arrow beside it has the other ways in (the Library, a path or URL, a cluster, Process raw data for a DAF-seq run, and Data quality).'
        + (demo ? ' The tour has loaded the demo for you.' : ''),
      how: 'Click Open, or drag files onto the window (a BAM and its index can go together); the arrow beside it has the Library and raw data.',
    },
    {
      id: 'going-somewhere',
      section: 'Getting started',
      title: 'Going somewhere',
      selector: '[data-testid="location-search-input"]',
      text: 'Type a gene, coordinates, a read name or a saved region\'s name and press Enter. The arrows step back and forward through where you have been.',
      how: 'Type e.g. "NAPA" and press Enter.',
    },
    {
      id: 'pan-zoom',
      section: 'Getting started',
      title: 'Pan and zoom',
      selector: '[aria-label="Go to the next best-covered locus"]',
      text: 'Zoom with + and −, and pan with the arrows or by dragging the reads. The crosshair jumps to the best-covered places in your data.',
      how: 'Arrow keys pan; ↑/↓ or +/− zoom.',
    },
    {
      id: 'command-palette',
      section: 'Getting started',
      title: 'Search commands and settings',
      selector: '[data-testid="command-palette-button"]',
      text: `${mod}+K (or this magnifier) finds any command, panel or setting, and goes to a locus, gene, region or read. A setting opens where it lives; on/off ones switch right in the list.`,
      how: `Press ${mod}+K, type "row height", then Enter.`,
    },
    {
      id: 'analysis-panels',
      section: 'Getting started',
      title: 'Analysis panels',
      // The launchers in the sidebar rail (the default), or the classic strip above the reads (folded or not).
      selector: () => (panelLauncherIsRail()
        ? '[data-testid="panel-rail-launchers"]'
        : '[data-testid="analysis-strip-chips"], [data-testid="analysis-strip-collapsed"]'),
      text: rail
        ? 'Each coloured tile in the rail opens an analysis panel (Clusters, Footprints, Rules, ...); hover or focus one for its name. A panel opens beside the reads, or in a drawer when the window is narrow; Settings › Reads & Display has the classic strip instead.'
        : 'Each coloured button in this strip opens an analysis panel (Clusters, Footprints, Rules, ...). A panel opens beside the reads, or in a drawer at the right when the window is narrow.',
      how: rail ? 'Click a tile; click it again to close the panel.' : 'Click a button; click it again to close the panel.',
    },
    // ── Reads ───────────────────────────────────────────────────────
    {
      id: 'reads',
      section: 'Reads',
      title: 'Reads',
      selector: '$panel [data-copilot-track="reads"]',
      text: 'Each row is one DNA molecule: green blocks are nucleosomes, magenta ones smaller TF-sized footprints, and the gaps are accessible DNA. The Metaprofile above sums them across reads.',
      how: 'Hover a read for its details.',
    },
    {
      id: 'read-actions',
      section: 'Reads',
      title: 'Acting on reads: right-click',
      selector: '$panel [data-copilot-track="reads"]',
      text: 'A click or drag on the reads pans. Right-click a read to copy its name, zoom to it, highlight it in every panel, or keep only (or exclude) the selected reads.',
      how: `${READ_ACTIONS_HINT}.`,
    },
    {
      id: 'select-reads',
      section: 'Reads',
      title: 'Selecting reads: Shift+click',
      selector: '$panel [data-copilot-track="reads"]',
      text: 'Shift+click reads to select them: they are outlined and Read Stats opens. Next selects three reads.',
      how: 'Shift+click a read; Shift+click it again to deselect.',
      run: async (session) => { await shiftClickReads(session, 3); },
    },
    {
      id: 'read-stats',
      section: 'Reads',
      title: 'Read Stats',
      panel: 'read-stats',
      text: 'Read Stats summarises the selected reads, lists them in a table and plots their distributions. Its Reads menu switches to every read shown or to one cluster.',
      run: async (session) => { useBrowserStore.setState({ selectedReadIds: session.saved.selectedReadIds }); },
    },
    {
      id: 'toolbar-groups',
      section: 'Reads',
      title: 'Toolbar groups',
      // Opened (in a narrow window it is in the More menu at the row's end, with all its controls).
      selector: '[data-testid="toolbar-group-reads"]',
      before: (session) => showToolbarGroup(session, 'reads', true),
      text: 'The toolbar is in groups: click a group\'s name (or the arrow beside Scan, Cluster, Sort, Filter or Highlight) to open its controls in the row, and again to fold it. Reads, opened here, sets how reads are drawn (Fit or All, row height).',
      how: 'Click the small Reads label at the left of the toolbar.',
      run: async (session) => { await setToolbarGroupOpen('reads', session.toolbarGroups.get('reads') ?? false); },
    },
    {
      id: 'layers',
      toolbarGroup: 'layers',
      section: 'Reads',
      title: 'Layers',
      selector: '[data-testid="toolbar-group-layers"]',
      text: 'Layers turns each kind of call on or off: nucleosomes, accessible DNA, TF footprints, and for DAF-seq the deamination marks.',
    },
    // ── Peaks and clustering ────────────────────────────────────────
    {
      id: 'peaks',
      toolbarGroup: 'peaks',
      section: 'Peaks and clustering',
      title: 'Peaks',
      anchor: 'scan-peaks-button',
      text: 'Peaks are regions accessible in many reads, found automatically in the Peaks track. Next scans this view again.',
      how: 'Click Scan (or press S); drag on the Custom row of the Peaks track to draw your own.',
      prereq: true,
      run: async () => {
        useBrowserStore.getState().setPeaksLocked(false);
        if (!(await runUiScan())) {
          await executeBrowserAction({ type: 'scan_peaks' } as BrowserAction, { tutorial: false, durationMs: 200 });
        }
      },
    },
    {
      id: 'select-peaks',
      section: 'Peaks and clustering',
      title: 'Selecting peaks',
      selector: '$panel [data-copilot-track="peaks"]',
      text: 'Click a peak to select it for clustering and analysis. Next selects the two strongest.',
      how: `Click a peak; ${mod}+click adds more; click again to deselect.`,
      prereq: true,
      run: async (session) => { await selectTopPeaks(2, session.panelId); },
    },
    {
      id: 'clustering',
      toolbarGroup: 'cluster',
      section: 'Peaks and clustering',
      title: 'Clustering',
      anchor: 'cluster-button',
      text: 'Cluster groups the reads by their footprints at the selected peaks; K-means usually works best, and Neighbourhoods groups reads that sit together on the t-SNE map. Next runs K-means with K = 6.',
      how: 'With peaks selected, pick a method and K in the Cluster group, then click Cluster.',
      prereq: true,
      run: async (session) => {
        for (const action of [{ type: 'set_cluster_method', method: 'kmeans' }, { type: 'set_cluster_k', k: 6 }, { type: 'cluster_selected_peaks' }]) {
          if (session.ended) return;
          await executeBrowserAction(action as BrowserAction, { tutorial: false, durationMs: 200 });
        }
      },
    },
    {
      id: 'merge-clusters',
      section: 'Peaks and clustering',
      title: 'Merging similar clusters',
      panel: 'cluster-detail',
      selector: '[data-copilot-anchor="cluster-panel-auto-cull"]',
      text: 'Choose K a little high, then Merge similar clusters joins the tiny clusters and the pairs that look alike; Unmerge switches back. Next merges them.',
      how: 'Clusters panel → Merge similar clusters; the sliders button beside it chooses how clusters are compared (Merge by) and previews the result on the map.',
      action: { type: 'auto_cull_clusters' },
    },
    {
      id: 'clusters-panel',
      section: 'Peaks and clustering',
      title: 'The Clusters panel',
      panel: 'cluster-detail',
      click: '[data-panel-content-type="cluster-detail"] [data-analysis-tab="overview"]',
      text: 'The coloured bar beside the reads shows each read\'s cluster, and the Clusters panel lists them: click one to focus, hide or subcluster it. Snapshot keeps a clustering in Saved, to restore later.',
      how: 'Click a colour in the bar beside the reads, or press 1–9 (0 clears the focus).',
    },
    {
      id: 'cluster-profiles',
      section: 'Peaks and clustering',
      title: 'Profiles and other views',
      panel: 'cluster-detail',
      click: '[data-panel-content-type="cluster-detail"] [data-analysis-tab="profiles"]',
      selector: '[data-panel-content-type="cluster-detail"] [data-analysis-tab="profiles"]',
      text: 'The Charts tab compares the clusters: their average Profiles, Composition (Bar, Pie or Line), V-Plot (Midpoint or Full footprint) and Differences. Click cluster names above a chart to show only those clusters.',
    },
    {
      id: 'projection',
      section: 'Peaks and clustering',
      title: 'The read map',
      panel: 'cluster-detail',
      click: '[data-panel-content-type="cluster-detail"] [data-analysis-tab="projection"]',
      selector: '[data-panel-content-type="cluster-detail"] [data-tour="clusters-projection-map"]',
      text: 'Overview\'s map draws each read as a dot on a t-SNE map, coloured by cluster: neighbours are similar reads, but distances and sizes mean little. Click a dot to focus its cluster in every panel (Esc shows all again).',
      how: `Clusters → Overview → Map (beside the profiles in a wide panel); ⇧-click adds a cluster, ${mod}-click shows the read, Export table saves each read's place.`,
    },
    {
      id: 'sort-filter',
      toolbarGroup: 'sort',
      section: 'Peaks and clustering',
      title: 'Sort and filter',
      selector: '[data-testid="toolbar-group-sort"]',
      text: 'Sort orders the reads within each cluster (by accessibility at a peak, footprint count, or their place on the t-SNE map). Filter keeps only the reads that match a rule.',
    },
    // ── Footprints ──────────────────────────────────────────────────
    {
      id: 'cmd-click',
      section: 'Footprints',
      title: `Analysing a spot: ${mod}+click`,
      selector: '$panel [data-copilot-track="reads"]',
      text: `${mod}+click a footprint on a read to analyse that spot: the Footprints panel opens with the footprint sizes there across all reads. Next does it on a footprint in a selected peak.`,
      how: `Hold ${mod} and click a footprint (a coloured block) on any read.`,
      prereq: true,
      run: async (session) => { await cmdClickAFootprint(session); },
    },
    {
      id: 'save-footprint',
      section: 'Footprints',
      title: 'Saving a footprint',
      panel: 'footprint-analysis',
      click: `${FOOTPRINT_PANEL} [data-analysis-tab="states"]`,
      selector: `${FOOTPRINT_PANEL} [data-copilot-anchor="footprint-add-group"]`,
      text: 'The bars count the reads with a footprint of each size at that spot; drag across them (or type a range) and Save to keep that footprint. Next saves the one the tour clicked.',
      how: 'Choose a size range under the bars, then Save.',
      prereq: true,
      run: saveSelectedFootprint,
    },
    {
      id: 'saved-footprints',
      section: 'Footprints',
      title: 'Saved footprints',
      panel: 'footprint-analysis',
      click: `${FOOTPRINT_PANEL} [data-analysis-tab="saved"]`,
      before: openSavedEntry,
      selector: savedEntrySelector,
      text: 'Saved lists the footprints and classes you keep; the tour has opened the one it saved (its sequence, motifs and V-plot). Filter reads shows only the reads that carry it.',
      how: 'Click a saved footprint to open its details.',
    },
    {
      id: 'footprint-classes',
      section: 'Footprints',
      title: 'Footprint classes',
      panel: 'footprint-analysis',
      click: `${FOOTPRINT_PANEL} [data-analysis-tab="states"]`,
      selector: `${FOOTPRINT_PANEL} [data-testid="run-lattice-consensus"]`,
      text: 'Find footprint classes groups the footprints that recur at the same place, across every read in view, into classes with their own colours. Next finds them here (a minute or two).',
      how: 'Footprints → Classes → Find footprint classes; Stringency and Check robustness to read order are beside it.',
      prereq: 'section',
      run: findFootprintClasses,
    },
    {
      id: 'class-table',
      section: 'Footprints',
      title: 'The class table',
      panel: 'footprint-analysis',
      click: `${FOOTPRINT_PANEL} [data-analysis-tab="states"]`,
      selector: CLASS_TABLE,
      when: () => classTableShown(),
      text: 'One row per class, with bars for how often it is occupied on each strand (CT and GA). The classes are also drawn on the reads.',
      how: `Click a class name to highlight it on the reads (${mod}+click adds more).`,
    },
    {
      id: 'save-class',
      section: 'Footprints',
      title: 'Saving a class',
      panel: 'footprint-analysis',
      click: `${FOOTPRINT_PANEL} [data-analysis-tab="states"]`,
      selector: `${CLASS_TABLE} [data-testid="recaller-save"]`,
      when: () => classTableShown(),
      text: 'Add to Saved keeps a class in Saved (S1, S2, …) to count, filter, plot and export on its own (the arrow at the start of a row inspects it without saving). Next saves the first one.',
      how: 'Click Add to Saved at the end of a class\'s row.',
      prereq: 'section',
      run: saveFirstClass,
    },
    {
      id: 'saved-class',
      section: 'Footprints',
      title: 'Saved classes and their prevalence',
      panel: 'footprint-analysis',
      click: `${FOOTPRINT_PANEL} [data-analysis-tab="saved"]`,
      before: showSavedClassPlot,
      selector: `${FOOTPRINT_PANEL} [data-testid="saved-classes-summary"]`,
      when: savedClassListed,
      text: 'Each saved class shows how often it is occupied on each strand; Plot, opened here, draws them side by side. Filter reads shows only the reads it counts.',
    },
    {
      id: 'co-occupancy',
      section: 'Footprints',
      title: 'Co-occupancy',
      panel: 'footprint-analysis',
      click: `${FOOTPRINT_PANEL} [data-analysis-tab="co-occ"]`,
      selector: `${FOOTPRINT_PANEL} [data-analysis-tab="co-occ"]`,
      text: 'Co-occupancy tests which saved footprints and classes occur together on the same reads more (or less) often than chance. Click any count to see just those reads.',
    },
    {
      id: 'compare-strands',
      section: 'Footprints',
      title: 'Compare strands',
      panel: 'footprint-analysis',
      click: `${FOOTPRINT_PANEL} [data-analysis-tab="states"]`,
      before: openCompareStrands,
      selector: `${FOOTPRINT_PANEL} [data-testid="compare-datasets"]`,
      text: 'For DAF-seq, Compare strands puts each class\'s prevalence on the C→T and G→A strands side by side and flags where they disagree.',
    },
    // ── Regions and highlights ──────────────────────────────────────
    {
      id: 'highlight',
      toolbarGroup: 'highlight',
      section: 'Regions and highlights',
      title: 'Highlight',
      selector: '[data-testid="toolbar-group-highlight"]',
      before: (session) => showToolbarGroup(session, 'highlight', true),
      text: 'Highlight shades a region in every panel: Shift-drag on a ruler, or use View or Peaks here; List names them and Clear removes them. Next highlights the selected peaks.',
      how: 'Shift-drag on the ruler above the reads.',
      run: async (session) => {
        await highlightForTour(session);
        await setToolbarGroupOpen('highlight', session.toolbarGroups.get('highlight') ?? false);
      },
    },
    {
      id: 'regions',
      section: 'Regions and highlights',
      title: 'Regions',
      panel: 'circular-genome',
      click: '[data-panel-content-type="circular-genome"] [data-analysis-tab="catalog"]',
      selector: '[data-panel-content-type="circular-genome"] [data-testid="region-save-view"]',
      text: 'Regions keeps saved regions in categories: views you save, BED files, and (in your own tab) the regions Scan regions finds in your datasets. Type a region\'s name in the locus box, or press N and P to step through a category; Next saves this view.',
      how: 'Regions → Save view; Import BED and Export BED share regions.',
      run: saveViewForTour,
    },
    {
      id: 'compare-haplotypes',
      section: 'Regions and highlights',
      title: 'Comparing haplotypes',
      panel: 'circular-genome',
      click: '[data-panel-content-type="circular-genome"] [data-analysis-tab="haplotype"]',
      selector: '[data-panel-content-type="circular-genome"] [data-analysis-tab="haplotype"]',
      text: 'Compare haplotypes opens the same coordinates on two chromosomes side by side (say maternal and paternal), to cluster them separately or together.',
      how: 'Pick the two chromosomes (Detected pairs fills both), then Compare Haplotypes.',
    },
    // ── Labeling and rules ──────────────────────────────────────────
    {
      id: 'labeling',
      section: 'Labeling and rules',
      title: 'Labeling',
      panel: 'colormap',
      click: '[data-panel-content-type="colormap"] [data-analysis-tab="rules"]',
      anchor: 'colormap-add-rule',
      text: 'Labeling colours footprints by rules (a size, a layer, where they sit); the first rule that matches wins. Add rule makes a new one, and Quick add makes common ones in one click.',
    },
    {
      id: 'quality-filters',
      section: 'Labeling and rules',
      title: 'Quality filters',
      panel: 'colormap',
      click: '[data-panel-content-type="colormap"] [data-analysis-tab="quality"]',
      selector: '[data-panel-content-type="colormap"] [data-analysis-tab="quality"]',
      text: 'The Quality tab sets how confident a footprint call must be to count, for the colours and the analyses (Find footprint classes has its own settings). The toolbar\'s Quality group shows what is in effect.',
    },
    {
      id: 'rules',
      section: 'Labeling and rules',
      title: 'Rules',
      panel: 'cluster-features',
      click: '[data-panel-content-type="cluster-features"] [data-analysis-tab="cluster"]',
      anchor: 'analysis-rules-add-cluster-rule',
      text: 'Rules are reusable definitions to cluster, sort or filter by, such as "open at the promoter and bound at the enhancer". Add rule builds one, and it then appears in that toolbar group.',
    },
    // ── Tracks ──────────────────────────────────────────────────────
    {
      id: 'add-track',
      section: 'Tracks',
      title: 'Adding a track',
      panel: 'track-browser',
      anchor: 'jaspar-name-input',
      text: 'Type here to add a track: a file path or URL, a JASPAR motif name, or a sequence to find. + Metaprofile and + Combined track add tracks built from your reads or from several sources.',
    },
    {
      id: 'track-hubs',
      section: 'Tracks',
      title: 'Track hubs',
      panel: 'track-browser',
      selector: '[data-tour="track-browse-hubs"]',
      text: 'Browse hubs searches UCSC, ENCODE and ChIP-Atlas for tracks to show beside your reads.',
    },
    // ── Other analyses ──────────────────────────────────────────────
    {
      id: 'co-accessibility',
      section: 'Other analyses',
      title: 'Co-accessibility',
      panel: 'co-accessibility',
      selector: '[data-testid="coacc-export-json-button"]',
      text: 'Co-accessibility shows which positions are open together on the same molecules, as a matrix you can export.',
    },
    {
      id: 'primers',
      section: 'Other analyses',
      title: 'Primers',
      panel: 'primer-design',
      click: '[data-panel-content-type="primer-design"] [data-analysis-tab="design"]',
      anchor: 'primer-design-button',
      text: 'Primers designs PCR primers around the selected peaks (or for 3C and 4C) and checks them with BLAST; its Order list exports the ones you keep for IDT and other vendors.',
      how: 'Select the peaks to amplify, then Design Primers.',
    },
    // ── Panels and layout ───────────────────────────────────────────
    {
      id: 'link-merge',
      section: 'Panels and layout',
      title: 'Linking and merging datasets',
      panel: 'dataset-layout',
      anchor: 'dataset-link-button',
      // With one dataset panel Link is not offered; a line says why instead.
      selector: '[data-copilot-anchor="dataset-link-button"], [data-testid="layout-link-needs-two"]',
      text: 'The Layout panel links panels so they share clustering and analysis, merges datasets into one panel, and renames them.',
    },
    {
      id: 'navigation',
      section: 'Panels and layout',
      title: 'Genomes and navigation',
      selector: '[data-testid="navigation-mode-toggle"]',
      text: 'Linked moves the panels on each genome together; Per panel gives each panel its own locus box, with a Match button to bring the others there. A dataset on another genome (say dm6) can open in its own panel with that genome, from the banner that offers it.',
    },
    {
      id: 'panel-menu',
      section: 'Panels and layout',
      title: 'Panel actions',
      selector: '$panel [data-tour="panel-subtracks"]',
      text: 'The header\'s buttons: Tracks lists the panel\'s tracks to show, remove, restore or reorder; + adds a copy; then minimize, expand and close (in a narrow panel, the rest go under ⋯). Right-click any track for its menu, and drag its bottom edge to resize it.',
      how: 'Click Tracks in the panel header.',
    },
    {
      id: 'layout',
      section: 'Panels and layout',
      title: 'Layout',
      panel: 'dataset-layout',
      selector: '[data-testid="layout-equal-widths"]',
      text: 'Equal widths evens out the panels and Reset puts rows and sizes back. A side panel\'s pin button slides it into a drawer over the reads (drag its edge to resize); Dock brings the drawer\'s panels back beside the reads.',
    },
    // ── Variants (the structural-variant demo) ─────────────────────
    {
      id: 'sv-demo',
      section: 'Variants',
      title: 'A structural-variant demo',
      text: sv
        ? 'Next loads a second demo: PacBio Fiber-seq reads from H1 cells around a 7,471-bp insertion on chr1 that one copy of the chromosome carries. The NAPA panel folds away meanwhile.'
        : 'The Variants panel finds the SNPs, small indels and structural variants in the reads in view, and splits the reads by allele.',
      ...(sv ? { run: (session: TourSession) => showSvDemo(sv, session) } : {}),
      prereq: 'section',
    },
    {
      id: 'variants-panel',
      section: 'Variants',
      title: 'The Variants panel',
      panel: 'variants',
      selector: () => (panelLauncherIsRail() ? '[data-testid="panel-rail-variants"]' : '[data-testid="analysis-strip-button-variants"]'),
      before: showVariantsForTour,
      text: 'This tile opens Variants: the SNPs, small indels and structural variants in the reads in view, called from their own bases and alignments. Next finds the SNPs here.',
      how: 'Variants → SNPs → Find SNPs in view (Auto scans again as the view moves).',
      prereq: 'section',
      run: scanSnpsForTour,
    },
    {
      id: 'snp-table',
      section: 'Variants',
      title: 'SNPs in view',
      panel: 'variants',
      selector: `${VARIANTS} [data-testid="variants-table"]`,
      text: sv
        ? 'Each row is a SNP or small indel with its allele counts and minor-allele fraction; the cluster here sits at the insertion\'s breakpoint, where aligning the inserted sequence makes mismatches, not real SNPs. Next splits the reads by haplotype (their HP tags) instead; Split into panels… works the same on any SNP the scan finds.'
        : 'Each row is a SNP or small indel with its allele counts and minor-allele fraction; the same SNPs are ticks in the SNP channel above the reads. Next splits the reads by haplotype (their HP tags) when they carry them; Split into panels… works the same on any SNP you select.',
      how: 'Variants → Combinations → HP tags → Split into panels… → Open; for a SNP: click its row, then Split into panels….',
      prereq: 'section',
      run: splitByHaplotypeForTour,
    },
    {
      id: 'split-by-haplotype',
      section: 'Variants',
      title: 'Reads split by haplotype',
      panel: 'variants',
      selector: '[data-testid="split-panel-close-all"]',
      when: splitShown,
      text: sv
        ? 'Each haplotype now has a read panel of its own: every read that holds the whole insertion is on HP1, and none is on HP2. Next closes the split, and the reads are back in one panel.'
        : 'Each haplotype now has a read panel of its own. Next closes the split, and the reads are back in one panel.',
      how: 'Split × in a split panel\'s header (or × on the strip above) closes them all and unfolds the original.',
      prereq: 'section',
      run: closeSplitsForTour,
    },
    {
      id: 'svs-tab',
      section: 'Variants',
      title: 'Structural variants',
      panel: 'variants',
      click: `${VARIANTS} [data-analysis-tab="svs"]`,
      selector: `${VARIANTS} [data-testid="variants-sv"]`,
      when: svListed,
      text: sv
        ? 'The SVs tab lists the deletions and insertions in view with the reads that carry each: here the 7,471-bp insertion, on one haplotype. Its buttons group or split the reads by the SV, or show which SNP alleles travel with it.'
        : 'The SVs tab lists the deletions and insertions in view with the reads that carry each. Its buttons group or split the reads by the SV, or show which SNP alleles travel with it.',
    },
    {
      id: 'sv-flag',
      section: 'Variants',
      title: 'Insertions on the reads',
      selector: '$panel [data-copilot-track="sv"]',
      text: 'The Differences row above the reads flags each insertion with its size and confirmed carriers. Click it to highlight the carriers and expand it in place; ⌘-click to inspect it read by read; right-click for splits, highlights by evidence level and the inserted sequence.',
      how: 'Click the insertion in the Differences row; ⌘-click or right-click → Inspect… to inspect it.',
    },
    {
      id: 'insert-expanded',
      section: 'Variants',
      title: 'The insert, expanded',
      selector: '$panel [data-copilot-track="sv"]',
      when: (session) => Boolean(session.svInsertion),
      text: 'Open carriers with the insert expanded (a Preview feature) re-aligns the carriers onto the insertion\'s own sequence between its reference flanks, in a panel of their own, so the reads inside the insert can be clustered and sorted like any region. Next opens it beside the reads.',
      how: 'Right-click the insertion in the Differences row → Open carriers with the insert expanded (Settings › Show preview features).',
      prereq: 'section',
      run: openInsertForTour,
    },
    {
      id: 'insert-ctcf',
      section: 'Variants',
      title: 'Inside the insert: a CTCF site',
      // The whole panel: the popover goes beside it, so the reads stay in view.
      selector: (session) => `[data-panel-id="${session.altPanelId ?? ''}"]`,
      when: altPanelShown,
      text: 'The carriers are sorted by accessibility over a nucleosome-free region about 3.7–3.9 kb into the insert: most are open there (at the top), and most of those have a footprint at its centre over a CTCF motif. The reference genome has no such element; the ruler counts positions inside the insert.',
    },
    // ── Around the browser ──────────────────────────────────────────
    {
      id: 'undo',
      section: 'Around the browser',
      title: 'Undo',
      selector: '[data-testid="history-timeline-button"]',
      text: `Changes can be undone (${mod}+Z) and redone; the ▾ opens a timeline to jump back to any step. Reset view (R) clears clustering, filters and selections in one go.`,
    },
    {
      id: 'save',
      section: 'Around the browser',
      title: 'Save',
      selector: '[data-testid="save-session-button"]',
      text: 'Save downloads the session as a file to reopen with Open. Your work is also kept as you go, and the next launch offers to reopen it.',
    },
    {
      id: 'export',
      section: 'Around the browser',
      title: 'Export a figure',
      selector: '[data-testid="export-screenshot-button"]',
      text: 'Export makes a figure (PNG, SVG or PDF) of what you see, with text as large as on screen.',
    },
    {
      id: 'export-data',
      section: 'Around the browser',
      title: 'Export data',
      selector: '[data-testid="export-data-button"]',
      text: `Data (${mod}+Shift+E) exports read names, tables, BED files and the session file, grouped by topic; in your own tab also a BAM of chosen reads.`,
    },
    {
      id: 'tutorial-panel',
      section: 'Around the browser',
      title: 'The Tutorial panel',
      panel: 'history',
      click: '[data-panel-content-type="history"] [data-analysis-tab="tour"]',
      selector: '[data-tour="tutorial-tour-list"]',
      text: 'Tutorial lists every step of this tour: click one to start there, and the tour first sets up what it needs.',
      how: rail ? 'Click the Tutorial tile in the sidebar rail, then a step.' : 'Click Tutorial in the analysis strip, then a step.',
    },
    {
      id: 'copilot',
      section: 'Around the browser',
      title: 'Copilot',
      panel: 'history',
      click: '[data-panel-content-type="history"] [data-analysis-tab="copilot"]',
      selector: '[data-tour="copilot-input"]',
      text: 'The Copilot tab (optional, runs on your computer) answers questions like "how do I cluster the reads?" by pointing at the controls, like this tour.',
    },
    {
      id: 'end',
      section: 'Around the browser',
      title: 'That\'s the tour',
      final: true,
      // Beside the step list, which stays open to explore from (Keep exploring).
      panel: 'history',
      click: '[data-panel-content-type="history"] [data-analysis-tab="tour"]',
      text: `${endChoice} Start again, or at any step, from this Tutorial panel; Quit FiberBrowser is in the ⋮ menu of your own tab.`,
    },
  ];
  // FiberBrowser.app leaves the Copilot out: no step about it.
  return isCopilotIncluded() ? steps : steps.filter(step => step.id !== 'copilot');
}

/**
 * The tour's steps, for the Tutorial panel's list (id, section, title and text).
 * With the server's demo region, the texts are the ones the tour shows (it tours
 * the demo, in its own tab); without one, the tour's texts for the loaded data.
 */
export function tourOutline(demo: DemoRegion | null = null, sv: DemoEntry | null = null): Array<Pick<TourStep, 'id' | 'section' | 'title' | 'text'>> {
  return tourSteps(demo, false, sv).map(({ id, section, title, text }) => ({ id, section, title, text }));
}

/** Run a step's action or run, with the panels it opens claimed by the tour. */
async function doStep(step: TourStep, session: TourSession): Promise<void> {
  if (step.action) await tourDoes(session, () => executeBrowserAction(step.action!, { tutorial: false, durationMs: 200 }));
  else if (step.run) await tourDoes(session, () => step.run!(session));
}

/**
 * The steps before the start step whose work it needs: every `prereq: true`
 * step, and a `prereq: 'section'` one only when the start step is in its section.
 */
export function prerequisitesFor(steps: TourStep[], startSection?: string): TourStep[] {
  return steps.filter(step => (step.action || step.run)
    && (step.prereq === true || (step.prereq === 'section' && step.section === startSection)));
}

/**
 * Starting at a later step: quietly do what the earlier steps make that it
 * needs (the demo, peaks and their selection, clusters, a footprint). False
 * when that failed and the tour can't go on.
 */
async function replayPrerequisites(steps: TourStep[], session: TourSession, startSection?: string): Promise<boolean> {
  showWorking(session, 'Getting ready');
  session.busy = true;
  try {
    for (const step of prerequisitesFor(steps, startSection)) {
      if (session.ended) return false;
      await arrangePanels(step, session);
      if (step.when && !(await waitFor(() => step.when!(session), 2000))) continue;
      if (step.before) await step.before(session);
      try {
        await doStep(step, session);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (step.essential) {
          hideWorking(session);
          await executeBrowserAction({ type: 'explain', text: message } as BrowserAction, {
            tutorial: true, waitForClick: true, title: 'The tour can\'t continue', description: message, durationMs: 300,
          });
          return false;
        }
        useBrowserStore.getState().setError(`Tour: ${message}`);
      }
    }
    return !session.ended;
  } finally {
    session.busy = false;
    hideWorking(session);
    if (session.ended) cleanUp(session);
  }
}

/**
 * Run the tour. Uses the demo when this server has it (loading it if needed),
 * else whatever data is loaded. With a step id, it starts at that step, after
 * quietly setting up what the steps before it would have.
 */
export async function runGuidedTour(opts: { stepId?: string } = {}): Promise<void> {
  if (current) {
    if (current.ended) useBrowserStore.getState().setError('The tour is finishing a step; start it again in a moment.');
    return;
  }
  const start = useBrowserStore.getState();
  const session: TourSession = {
    ended: false, busy: false, restoreSelection: null, tourSelection: null, bar: null,
    panelId: null,
    ownedPanels: new Set(),
    saved: {
      selectedReadIds: start.selectedReadIds,
      selectedFootprints: start.selectedFootprints,
      clusterMethod: start.clusterMethod,
      clusterK: start.clusterK,
      fullViewPanelId: start.fullViewPanelId,
      selectedPeaks: start.getAllPeaks().filter(p => start.selectedPeaks.has(p.index))
        .map(p => ({ ruleId: p.ruleId, chrom: p.chrom, start: p.start, end: p.end, mode: start.peakModes[p.index] })),
      peaksLocked: start.peaksLocked,
    },
    snapshot: null,
    ownData: false,
    addedDemoId: null,
    loadedDemoOnServer: false,
    extraDatasets: [],
    svDemoId: null,
    svInsertion: null,
    altPanelId: null,
    cleaned: false,
    expandedRows: new Set<number>(),
    primer: null,
    toolbarGroups: new Map(),
    createdFootprintGroupIds: [],
    createdHighlightIds: [],
    createdRegions: [],
    resetChosen: false,
    keep: false,
  };
  current = session;
  let closeTab = false;
  try {
    let demo: DemoRegion | null = null;
    let demoId: string | null = null;
    // The structural-variant demo of the Variants section (servers from before 3.0 have none).
    let sv: DemoEntry | null = null;
    // (A public server or an older backend has no demo: the tour tours the loaded data.)
    const found = await findTourDemo(inSandboxTab());
    const info = found.info;
    if (info?.available) {
      demo = info.region;
      demoId = info.dataset_id;
      sv = info.demos?.find(d => d.id === 'sv' && d.available) ?? null;
    }
    if (!demo && useBrowserStore.getState().datasets.length === 0) {
      // A tour tab never has data of its own: it needs the demo, and says why it has none.
      const description = inSandboxTab()
        ? `The tour's demo dataset ${found.error ? `couldn't be loaded (${found.error})` : "isn't available here"}. Close this tab and start the tour again.`
        : 'The tour needs data: load a BAM or BigBed with Open, then start the tour again.';
      await executeBrowserAction({ type: 'explain', text: inSandboxTab() ? 'No demo dataset' : 'Load a dataset first' } as BrowserAction, {
        tutorial: true, waitForClick: true, title: inSandboxTab() ? 'The tour can\'t start' : 'Guided tour',
        description,
        durationMs: 400,
      });
      return;
    }
    const withOwnData = useBrowserStore.getState().datasets.some(d => d.id !== demoId && d.id !== sv?.dataset_id);
    if (useBrowserStore.getState().datasets.length > 0) {
      // Before the tour changes anything: the way back (links, clusters and
      // layout of anything already loaded, the demo included).
      session.snapshot = await takeTourSnapshot();
      session.primer = useBrowserStore.getState().primer;
    }
    if (!demo) {
      session.ownData = true;
      // Touring the user's data: the selected (else first) dataset panel.
      const st = useBrowserStore.getState();
      const shown = st.panels.filter(p => p.contentType === 'dataset' && p.datasetId && !p.collapsed);
      // All collapsed: open one to tour.
      const panel = shown.find(p => st.selectedDatasets.has(p.id))
        ?? shown.find(p => !p.viewportOverride) ?? shown[0]
        ?? st.panels.find(p => p.contentType === 'dataset' && p.datasetId);
      if (panel?.collapsed) st.setPanelCollapsed(panel.id, false);
      showPanelRow(panel ?? null, session);
      // A panel at its own locus: bring the main view there, so clustering and
      // merging (which act on the main view's panels) include it.
      const v = panel?.viewportOverride;
      if (v && (v.chrom !== st.chrom || v.start !== st.start || v.end !== st.end)) {
        useBrowserStore.getState().setViewport(v.chrom, v.start, v.end);
      }
      session.panelId = panel?.id ?? null;
      const others = st.panels.some(p => p.contentType === 'dataset' && p.datasetId && p.id !== panel?.id);
      if (panel && others) {
        // Its clustering and merging act on this panel only.
        if (panel.linkGroup) st.unlinkPanel(panel.id);
        session.restoreSelection = new Set(st.selectedDatasets);
        session.tourSelection = new Set([panel.id]);
        useBrowserStore.setState({ selectedDatasets: session.tourSelection });
      }
    }
    // A maximized panel would hide the one being toured.
    if (useBrowserStore.getState().fullViewPanelId) useBrowserStore.getState().setFullViewPanel(null);
    const steps = tourSteps(demo, withOwnData, sv);
    const first = Math.max(0, opts.stepId ? steps.findIndex(s => s.id === opts.stepId) : 0);
    if (first > 0 && !(await replayPrerequisites(steps.slice(0, first), session, steps[first].section))) return;
    for (let i = first; i < steps.length && !session.ended; i += 1) {
      const step = steps[i];
      await arrangePanels(step, session);
      if (session.ended) break;
      // A step about something an earlier step made (a class run) is left out when that failed.
      // (Logged, so a walk that comes up short says which step went and why.)
      if (step.when && !(await waitFor(() => session.ended || step.when!(session), 2000))) {
        console.info(`Tour: left out "${step.title}" (what it shows, e.g. a class run, is not there)`);
        continue;
      }
      if (session.ended) break;
      if (step.before) {
        try { await step.before(session); } catch { /* the step is still worth explaining */ }
        if (session.ended) break;
      }
      // Its control is in a toolbar group the row has no room for: open the More menu.
      if (step.toolbarGroup && toolbarGroupInMore(step.toolbarGroup)) {
        await showToolbarGroup(session, step.toolbarGroup, true);
        if (session.ended) break;
      }
      // A lazily loaded panel's controls can appear a moment after its frame.
      // A sandbox tab hides host-only controls (Open, Primers, Copilot):
      // those steps are still explained, just without a spotlight.
      let hiddenHere = false;
      if (!targetShown(step, session) && !(await waitFor(() => targetShown(step, session), 3000))) {
        if (!inSandboxTab()) {
          console.info(`Tour: left out "${step.title}" (its control is not shown)`);
          continue;
        }
        hiddenHere = true;
      }
      if (session.ended) break;
      const selector = hiddenHere ? null : stepSelector(step, session);
      const text = hiddenHere
        ? `${step.text} (This tour tab is a sandbox, so this control only appears in your own FiberBrowser tab.)`
        : step.text;
      const explain = {
        type: 'explain',
        text,
        ...(selector ? { selector } : {}),
        ...(step.anchor && !hiddenHere ? { anchor: step.anchor } : {}),
        ...(step.panel && !hiddenHere ? { panel_type: step.panel } : {}),
      } as unknown as BrowserAction;
      const popover = {
        tutorial: true,
        waitForClick: true,
        durationMs: 300,
        title: step.title,
        description: text,
        manualHow: step.how,
        progress: `${i + 1} of ${steps.length}`,
      };
      if (step.final) {
        // The end: reset the browser (or close the tour's own tab), or keep exploring.
        let reset = false;
        await executeBrowserAction(explain, {
          ...popover,
          nextLabel: 'Keep exploring',
          extraAction: { label: inSandboxTab() ? 'Close this tab' : 'Reset the browser', onClick: () => { reset = true; } },
        });
        if (reset && inSandboxTab()) {
          session.keep = true;
          closeTab = true;
        } else if (reset) {
          session.resetChosen = true;
        } else {
          session.keep = true;
        }
        break;
      }
      await executeBrowserAction(explain, { ...popover, onEnd: () => finishTour(session) });
      if (session.ended) break;
      // A step whose control this tab hides can't do its part here either.
      if (hiddenHere || (!step.action && !step.run)) continue;
      showWorking(session, step.title);
      session.busy = true;
      try {
        await doStep(step, session);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (step.essential) {
          hideWorking(session);
          await executeBrowserAction({ type: 'explain', text: message } as BrowserAction, {
            tutorial: true, waitForClick: true, title: 'The tour can\'t continue', description: message, durationMs: 300,
          });
          break;
        }
        useBrowserStore.getState().setError(`Tour: ${message}`);
      } finally {
        session.busy = false;
        hideWorking(session);
        if (session.ended) cleanUp(session);
      }
    }
  } finally {
    session.busy = false;
    finishTour(session);
    if (closeTab) window.close();
  }
}
