import { removeMatchedGroups } from './matchedGroupActions';
/**
 * The app's command bus: named commands that do what the in-app controls do,
 * callable as `window.fiberbrowserCommand(name, args?)`.
 *
 * The desktop app's menu bar (fiberbrowser/app_menu.py) runs these in the
 * window in front, e.g. File > Save Session (Cmd+S) runs
 * `window.fiberbrowserCommand('save-session')`. Commands whose handler lives
 * in a component (the file picker's loading state, the Export dialog) are
 * registered by that component with `useAppCommand`; the rest are here.
 *
 * A command returns false when it isn't available on this page (e.g. Save in
 * a --public server, the Library in a tour tab), true when it ran, or a
 * string for the few that answer something (`locus`; `undo`/`redo` answer
 * 'edit' when they undid typing in the focused text field instead of an app step).
 */
import { useBrowserStore } from '../stores/browserStore';
import { findOpenAnalysisPanel } from '../plugins/registry';
import { openLibrary } from '../components/controls/library/libraryStore';
import { openDafRunDialog } from '../components/controls/daf-run/dafRunStore';
import { openConnectCluster } from './connectCluster';
import { isSandboxPage } from './sandbox';
import { isLabServerPage, labInfo, labRunsAvailable } from './labServer';
import { showLoadByPath } from './loadByPath';
import { startTutorialTour } from './tourLauncher';
import { openUpdateDialog, updatesAvailableHere } from '../components/appUpdate/appUpdateStore';
import { receiveNativeDrop } from './nativeDrop';
import { closeCommandPalette, openCommandPalette, useCommandPaletteStore } from './commandPaletteStore';
import { openOverlayState } from '../hooks/useKeyboardShortcuts';
import { resetViewUndoably } from './resetView';
import { highlightSelectedPeaks, highlightView } from './highlightActions';
import { stepRegion } from './regionNavigation';
import {
  exportProjectionTable, findFootprintClasses, findFootprintClassesInView, hasClusters, hasDatasets, NEEDS_CLUSTERS, NEEDS_DATASET,
  openCoOccupancy, openProjection,
} from './analysisCommands';

export type AppCommandResult = boolean | string;
export type AppCommandHandler = (args?: unknown) => AppCommandResult | void | Promise<unknown>;

/** Every command name. The menu bar may only use these (tests/test_desktop_app.py checks). */
export const APP_COMMANDS = [
  // registered by components (useAppCommand)
  'open-file',
  'open-session',
  'save-session',
  'export-figure',
  'export-data',
  'keyboard-shortcuts',
  'scan-peaks',
  'remove-all-matched-regions',
  'cluster-reads',
  'sort-reads',
  'filter-reads',
  'clear-read-filter',
  'autozoom',
  'copy-link',
  // built in (BUILTIN_COMMANDS below)
  'command-palette',
  'settings',
  'toggle-sidebar',
  'undo',
  'redo',
  'zoom-in',
  'zoom-out',
  'back',
  'forward',
  'go-to-locus',
  'locus',
  'copy-locus',
  'new-daf-run',
  'dataset-qc',
  'connect-cluster',
  'library',
  'load-by-path',
  'toggle-footprints',
  'toggle-clusters',
  'toggle-tutorial',
  'appearance-light',
  'appearance-dark',
  'start-tour',
  'check-updates',
  'reset-view',
  'toggle-genome-map',
  'toggle-navigation-mode',
  'toggle-analysis-details',
  'ui-size-larger',
  'ui-size-smaller',
  'ui-size-reset',
  // highlights and saved regions (fb-r4-regions)
  'highlight-view',
  'highlight-peaks',
  'toggle-highlight-mode',
  'clear-highlights',
  'next-region',
  'previous-region',
  // analyses by name (fb-n3-search; utils/analysisCommands)
  'find-classes',
  'find-classes-view',
  'open-projection',
  'export-projection-table',
  'cluster-neighbourhoods',
  'sort-by-projection',
  'co-occupancy',
  // from the desktop app itself, not the menu: the real paths of dropped files (utils/nativeDrop)
  'native-drop',
] as const;

export type AppCommandName = typeof APP_COMMANDS[number];

export const COMPONENT_COMMANDS: readonly AppCommandName[] = [
  'open-file', 'open-session', 'save-session', 'export-figure', 'export-data', 'keyboard-shortcuts',
  'scan-peaks', 'cluster-reads', 'sort-reads', 'filter-reads', 'clear-read-filter', 'autozoom', 'copy-link',
];

export interface AppCommandInfo {
  /** Its name in the command palette (as the menu item or button says it). */
  label: string;
  /** Other words people search for it by. */
  keywords?: readonly string[];
  /** False where the command can't run on this page (public server, tour tab, ...): the palette leaves it out. */
  available?: () => boolean;
  /** Why it can't run now (its button would be disabled): the palette lists it with this, grayed out. */
  disabledReason?: () => string | null;
  /**
   * Why it isn't offered on this page, where saying so helps (a lab server
   * without runs): the top bar's Open menu shows it grayed out with this
   * reason. Without one an unavailable command is simply left out.
   */
  unavailableReason?: () => string | null;
  /** A second line in the palette: where it lives, what it does. */
  detail?: string;
}

/**
 * What the command palette (components/controls/CommandPalette) lists for each
 * command, next to the commands themselves so a new command can't miss it
 * (the Record makes TypeScript ask for every name); null: internal, not listed.
 * Keyboard shortcuts come from utils/shortcuts (KEYBOARD_SHORTCUTS' `commands`).
 */
export const APP_COMMAND_INFO: Record<AppCommandName, AppCommandInfo | null> = {
  'open-file': { label: 'Open file…', keywords: ['load', 'bam', 'bigbed', 'bigwig', 'fasta', 'gtf', 'data', 'import'], available: () => !isPublic() },
  'open-session': { label: 'Open session…', keywords: ['load session', 'restore', 'json'], available: () => !isPublic() },
  'save-session': { label: 'Save session', keywords: ['download', 'session file', 'json'], available: () => !isPublic() },
  'export-figure': { label: 'Export figure…', keywords: ['png', 'svg', 'pdf', 'screenshot', 'image', 'picture'] },
  'export-data': { label: 'Export data…', keywords: ['download', 'table', 'tsv', 'bed', 'bam subset', 'read names', 'data export'] },
  'keyboard-shortcuts': { label: 'Keyboard shortcuts', keywords: ['keys', 'hotkeys', 'help'] },
  'remove-all-matched-regions': { label: 'Remove all matched regions', keywords: ['remove', 'groups', 'peaks'], available: () => useBrowserStore.getState().peakRules.some(r => r.source === 'matched') },
  'scan-peaks': { label: 'Scan for peaks', keywords: ['peaks', 'detect', 'accessibility', 'call peaks'] },
  'cluster-reads': { label: 'Cluster reads', keywords: ['clustering', 'group reads', 'kmeans', 'hierarchical'] },
  'sort-reads': { label: 'Sort reads', keywords: ['order', 'arrange'] },
  'filter-reads': { label: 'Filter reads', keywords: ['filter rule', 'subset'] },
  'clear-read-filter': { label: 'Clear read filter', keywords: ['unfilter', 'remove filter', 'show all reads'] },
  autozoom: { label: 'Autozoom to the best-covered window', keywords: ['spanning reads', 'coverage', 'zoom'] },
  'copy-link': { label: 'Copy link to this view', keywords: ['share', 'url', 'permalink'] },
  'command-palette': null,  // the palette itself
  settings: { label: 'Settings', keywords: ['preferences', 'options', 'sidebar'] },
  'toggle-sidebar': { label: 'Show or hide the settings sidebar', keywords: ['sidebar', 'settings', 'panel'] },
  undo: { label: 'Undo', keywords: ['back', 'revert'] },
  redo: { label: 'Redo', keywords: ['again'] },
  'zoom-in': { label: 'Zoom in', keywords: ['magnify', 'closer'] },
  'zoom-out': { label: 'Zoom out', keywords: ['wider', 'further'] },
  back: { label: 'Back (previous locus)', keywords: ['history', 'previous', 'navigation'] },
  forward: { label: 'Forward (next locus)', keywords: ['history', 'next', 'navigation'] },
  'go-to-locus': { label: 'Go to locus…', keywords: ['navigate', 'coordinates', 'gene', 'search', 'location'] },
  locus: null,  // answers the locus (Copy Locus)
  'copy-locus': { label: 'Copy locus', keywords: ['coordinates', 'clipboard'] },
  // The top bar's Open ▾ menu lists these with the same labels (utils/openMenu).
  'new-daf-run': {
    label: 'Process raw data (New DAF-seq run)…',
    keywords: ['new daf-seq run', 'pipeline', 'fiberhmm', 'call', 'run', 'fastq', 'align', 'raw reads', 'process dataset'],
    available: () => isLocal() && labRunsAvailable(),
    unavailableReason: () => labRunsReason('start runs'),
  },
  'dataset-qc': {
    label: 'Data quality (QC a dataset)…',
    detail: 'fiberhmm-qc on a BAM (loaded, from the Library or a file): verdicts, efficiency and background (in-MSP / outside-MSP rates), periodicity and footprint sizes',
    keywords: ['qc', 'quality', 'fiberhmm-qc', 'verdict', 'check', 'deamination', 'periodicity', 'efficiency', 'background', 'msp'],
    available: () => isLocal() && labRunsAvailable(),
    unavailableReason: () => labRunsReason('run QC'),
  },
  'connect-cluster': {
    label: 'Connect to cluster…',
    keywords: ['ssh', 'remote', 'hpc', 'server'],
    available: () => !isPublic() && !isLabServerPage(),
    unavailableReason: () => (!isPublic() && isLabServerPage() ? 'Not on a lab server: connect from FiberBrowser on your own computer' : null),
  },
  library: { label: 'Open from Library', keywords: ['library', 'datasets', 'files', 'collection', 'recent'], available: () => isLocal() },
  'load-by-path': {
    label: 'Load by path / URL…',
    detail: 'Data & Sessions: Load by path (a path on the server) and Load Remote URL (s3:// or https://)',
    keywords: ['path', 'server path', 'paste path', 'url', 'remote', 's3', 'https', 'endpoint', 'r2', 'minio', 'cloud'],
    available: () => !isPublic(),
  },
  'toggle-footprints': { label: 'Show or hide the Footprints panel', keywords: ['footprint analysis', 'classes'] },
  'toggle-clusters': { label: 'Show or hide the Clusters panel', keywords: ['cluster detail', 'profiles'] },
  'toggle-tutorial': { label: 'Show or hide the Tutorial panel', keywords: ['tour', 'help', 'copilot'] },
  'appearance-light': { label: 'Light appearance', keywords: ['theme', 'light mode', 'day', 'colors'] },
  'appearance-dark': { label: 'Dark appearance', keywords: ['theme', 'dark mode', 'night', 'colors'] },
  'start-tour': { label: 'Start the guided tour', keywords: ['tutorial', 'help', 'walkthrough', 'demo'] },
  'check-updates': {
    label: 'Check for updates…',
    detail: 'A newer FiberBrowser on this build\'s channel: notes, a verified download, the installer',
    keywords: ['update', 'upgrade', 'new version', 'release', 'download', 'install', 'about', 'version'],
    available: () => updatesAvailableHere(),
  },
  'reset-view': { label: 'Reset view', keywords: ['clear', 'clustering', 'filters', 'selections', 'start over'] },
  'toggle-genome-map': { label: 'Show or hide the genome map', keywords: ['genome overview', 'coverage map', 'chromosome'] },
  'toggle-navigation-mode': { label: 'Switch navigation: linked or each panel', keywords: ['per panel', 'linked', 'navigation mode', 'locus box'] },
  'toggle-analysis-details': { label: 'Show or hide analysis details', keywords: ['provenance', 'seeds', 'run details', 'reproducibility'] },
  'ui-size-larger': { label: 'Larger UI size', keywords: ['zoom interface', 'bigger', 'text size', 'scale', 'font'] },
  'ui-size-smaller': { label: 'Smaller UI size', keywords: ['zoom interface', 'text size', 'scale', 'font'] },
  'ui-size-reset': { label: 'Reset UI size to 100%', keywords: ['zoom interface', 'text size', 'scale', 'font'] },
  'highlight-view': { label: 'Highlight this view', keywords: ['highlight', 'shade', 'mark', 'annotate', 'region'] },
  'highlight-peaks': { label: 'Highlight selected peaks', keywords: ['highlight', 'shade', 'mark', 'peaks'], available: () => useBrowserStore.getState().selectedPeaks.size > 0 },
  'toggle-highlight-mode': { label: 'Highlight: drag on a ruler (on / off)', keywords: ['highlight', 'draw', 'shade', 'ruler', 'drag', 'mark region'] },
  'clear-highlights': { label: 'Clear highlights', keywords: ['highlight', 'remove highlights', 'unshade'], available: () => useBrowserStore.getState().highlights.length > 0 },
  'next-region': { label: 'Next saved region', keywords: ['regions', 'amplicon', 'bookmark', 'step', 'category'] },
  'previous-region': { label: 'Previous saved region', keywords: ['regions', 'amplicon', 'bookmark', 'step', 'category'] },
  'find-classes': {
    label: 'Find footprint classes',
    detail: 'Footprints › Classes: the footprints that recur at the same place across the reads, in the region its card shows',
    keywords: ['classes', 'footprint classes', 'consensus', 'recaller', 'lattice', 'discover', 'tf', 'binding', 'states', 'run'],
    disabledReason: () => (hasDatasets() ? null : NEEDS_DATASET),
  },
  'find-classes-view': {
    label: 'Find classes in this view',
    detail: 'Footprints › Classes, on the whole view the panels show (not only the selected peaks)',
    keywords: ['classes', 'footprint classes', 'view', 'whole view', 'region', 'recaller', 'run'],
    disabledReason: () => (hasDatasets() ? null : NEEDS_DATASET),
  },
  'open-projection': {
    label: 'Open projection (t-SNE map)',
    detail: 'Clusters › Projection: each read as a dot, coloured by cluster',
    keywords: ['projection', 't-sne', 'tsne', 'umap', 'pca', 'map', 'embedding', 'scatter', 'dimensionality'],
    disabledReason: () => (hasClusters() ? null : NEEDS_CLUSTERS),
  },
  'export-projection-table': {
    label: 'Export projection table',
    detail: 'Clusters › Projection › Export table: each read\'s place on the map and its cluster (TSV)',
    keywords: ['projection', 't-sne', 'tsne', 'map', 'coordinates', 'tsv', 'download', 'export', 'table'],
    disabledReason: () => (hasClusters() ? null : NEEDS_CLUSTERS),
  },
  'cluster-neighbourhoods': {
    label: 'Cluster reads with Neighbourhoods',
    detail: 'Cluster with the Neighbourhoods method: reads that sit together on the t-SNE map',
    keywords: ['neighbourhoods', 'neighborhoods', 'graph', 'community', 'leiden', 'louvain', 't-sne', 'tsne', 'cluster', 'clustering'],
  },
  'sort-by-projection': {
    label: 'Sort reads by projection (t-SNE)',
    detail: 'Sort › By projection: reads in the order of the t-SNE map',
    keywords: ['projection', 't-sne', 'tsne', 'order', 'sort', 'map'],
    disabledReason: () => (hasClusters() ? null : NEEDS_CLUSTERS),
  },
  'co-occupancy': {
    label: 'Co-occupancy of saved footprints and classes',
    detail: 'Footprints › Co-occupancy: which saved footprints and classes sit on the same reads',
    keywords: ['co-occupancy', 'cooccupancy', 'co-occurrence', 'cooccurrence', 'together', 'odds ratio', 'pairs', 'classes', 'footprints'],
  },
  'native-drop': null,  // the desktop app's dropped files
};

function isEditable(element: Element | null): boolean {
  if (!element) return false;
  const html = element as HTMLElement;
  if (html.isContentEditable) return true;
  if (element.tagName === 'TEXTAREA') return !(element as HTMLTextAreaElement).readOnly;
  if (element.tagName !== 'INPUT') return false;
  const input = element as HTMLInputElement;
  const textTypes = ['text', 'search', 'url', 'tel', 'email', 'password', 'number', ''];
  return textTypes.includes((input.type || '').toLowerCase()) && !input.readOnly;
}

function historyStep(direction: 'undo' | 'redo'): AppCommandResult {
  // Typing in a field: its own undo, as Edit > Undo does in any Mac app.
  if (typeof document !== 'undefined' && isEditable(document.activeElement)) {
    document.execCommand(direction);
    return 'edit';
  }
  const s = useBrowserStore.getState();
  if (direction === 'undo') s.undo(); else s.redo();
  return true;
}

/** The main view's locus, as the location box takes it (no thousands separators). */
export function currentLocus(): string {
  const { chrom, start, end } = useBrowserStore.getState();
  if (!chrom) return '';
  return `${chrom}:${Math.round(start)}-${Math.round(end)}`;
}

/** Like a click on the panel's button in the analysis strip: open it, or close it. */
function toggleAnalysisPanel(contentType: string): boolean {
  const s = useBrowserStore.getState();
  const open = findOpenAnalysisPanel(s.panels, contentType);
  if (open) s.closeAnalysisPanel(open.id);
  else s.openAnalysisPanel(contentType as Parameters<typeof s.openAnalysisPanel>[0]);
  return true;
}

function setAppearance(dark: boolean): boolean {
  const s = useBrowserStore.getState();
  if (s.darkMode !== dark) s.toggleDarkMode();
  return true;
}

/** UI size in 10% steps (Settings > Reads & Display, UI size: 50–400%). */
function stepUiSize(direction: 1 | -1): boolean {
  const s = useBrowserStore.getState();
  s.setUiScale(Math.round(s.uiScale * 10 + direction) / 10);
  return true;
}

const isPublic = () => useBrowserStore.getState().publicMode;
const isLocal = () => !isPublic() && !isSandboxPage();

/** Why runs (and run QC) aren't offered on this lab server page; null elsewhere. */
function labRunsReason(what: string): string | null {
  if (!isLocal() || labRunsAvailable()) return null;
  const info = labInfo();
  if (info && !info.jobs) return `This lab server does not ${what}`;
  return `Sign in to ${what}`;
}

export const BUILTIN_COMMANDS: Partial<Record<AppCommandName, AppCommandHandler>> = {
  // The gear button's sidebar holds the settings.
  settings: () => { useBrowserStore.getState().setSidebarOpen(true); return true; },
  'toggle-sidebar': () => { useBrowserStore.getState().toggleSidebar(); return true; },
  undo: () => historyStep('undo'),
  redo: () => historyStep('redo'),
  'zoom-in': () => { useBrowserStore.getState().zoomIn(); return true; },
  'zoom-out': () => { useBrowserStore.getState().zoomOut(); return true; },
  back: () => { useBrowserStore.getState().goBack(); return true; },
  forward: () => { useBrowserStore.getState().goForward(); return true; },
  'go-to-locus': () => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="location-search-input"]');
    if (!input) return false;
    input.focus();
    input.select();
    return true;
  },
  locus: () => currentLocus(),
  'copy-locus': () => {
    const locus = currentLocus();
    if (!locus || !navigator.clipboard?.writeText) return false;
    void navigator.clipboard.writeText(locus).catch(() => {});
    return true;
  },
  // The sidebar offers these only where they work; so do the commands.
  'new-daf-run': () => {
    if (!isLocal() || !labRunsAvailable()) return false;
    openDafRunDialog('new');
    return true;
  },
  // Data & Sessions > DAF-seq runs > QC a dataset (with no BAM loaded, it QCs one from the Library or a file).
  'dataset-qc': () => {
    if (!isLocal() || !labRunsAvailable()) return false;
    openDafRunDialog('qc');
    return true;
  },
  'load-by-path': () => {
    if (isPublic()) return false;
    void showLoadByPath();
    return true;
  },
  'connect-cluster': () => {
    if (useBrowserStore.getState().publicMode || isLabServerPage()) return false;
    openConnectCluster();
    return true;
  },
  library: () => {
    if (!isLocal()) return false;
    openLibrary();
    return true;
  },
  'toggle-footprints': () => toggleAnalysisPanel('footprint-analysis'),
  'toggle-clusters': () => toggleAnalysisPanel('cluster-detail'),
  'toggle-tutorial': () => toggleAnalysisPanel('history'),
  'appearance-light': () => setAppearance(false),
  'appearance-dark': () => setAppearance(true),
  'start-tour': () => { startTutorialTour(); return true; },
  'check-updates': () => openUpdateDialog(),
  // As Cmd/Ctrl+K in the page: closes an open palette, and doesn't open over another dialog.
  'command-palette': () => {
    if (useCommandPaletteStore.getState().open) { closeCommandPalette(); return true; }
    if (typeof document !== 'undefined' && openOverlayState().modal) return false;
    openCommandPalette();
    return true;
  },
  'reset-view': () => { resetViewUndoably(); return true; },
  'toggle-genome-map': () => { useBrowserStore.getState().toggleGenomeOverview(); return true; },
  'toggle-navigation-mode': () => {
    const s = useBrowserStore.getState();
    s.setNavigationMode(s.navigationMode === 'perPanel' ? 'linked' : 'perPanel');
    return true;
  },
  'toggle-analysis-details': () => {
    const s = useBrowserStore.getState();
    s.setShowAnalysisDetails(!s.showAnalysisDetails);
    return true;
  },
  'ui-size-larger': () => stepUiSize(1),
  'ui-size-smaller': () => stepUiSize(-1),
  'ui-size-reset': () => { useBrowserStore.getState().setUiScale(1); return true; },
  'highlight-view': () => highlightView().length > 0,
  'highlight-peaks': () => highlightSelectedPeaks().length > 0,
  'toggle-highlight-mode': () => {
    const s = useBrowserStore.getState();
    s.setHighlightDrawMode(!s.highlightDrawMode);
    return true;
  },
  'clear-highlights': () => { useBrowserStore.getState().clearHighlights(); return true; },
  // Nothing to step through: false (the Regions panel says why).
  'next-region': () => stepRegion(1) === null,
  'previous-region': () => stepRegion(-1) === null,
  'find-classes': () => findFootprintClasses(),
  'find-classes-view': () => findFootprintClassesInView(),
  'open-projection': () => openProjection(),
  'export-projection-table': () => exportProjectionTable(),
  // The Cluster group's button with that method (it reads the method when it runs).
  'cluster-neighbourhoods': () => {
    const s = useBrowserStore.getState();
    const before = s.clusterMethod;
    s.setClusterMethod('graph');
    const ran = runAppCommand('cluster-reads');
    if (ran === false) s.setClusterMethod(before);
    return ran;
  },
  // The Sort group's "By projection (t-SNE)", as if chosen there and run.
  'sort-by-projection': () => (hasClusters() ? runAppCommand('sort-reads', { by: 'projection' }) : false),
  'co-occupancy': () => openCoOccupancy(),
  'native-drop': args => receiveNativeDrop(args),
  'remove-all-matched-regions': () => removeMatchedGroups(),
};

const registered = new Map<string, AppCommandHandler>();

/** Register a component's handler; returns the unregister function. */
export function registerAppCommand(name: AppCommandName, handler: AppCommandHandler): () => void {
  registered.set(name, handler);
  return () => {
    if (registered.get(name) === handler) registered.delete(name);
  };
}

/** Whether a command has a handler here now (a component's is registered while it is mounted). */
export function hasAppCommand(name: string): boolean {
  return registered.has(name) || Boolean(BUILTIN_COMMANDS[name as AppCommandName]);
}

/**
 * What the menu bar may still do while the command palette is open: close it,
 * and undo/redo typing in its field (Edit menu); everything else would act
 * behind it.
 */
const WHILE_PALETTE_OPEN = new Set<string>(['command-palette', 'undo', 'redo', 'locus', 'native-drop']);

/** Run a command. False when it is unknown or not available here. */
export function runAppCommand(name: string, args?: unknown): AppCommandResult {
  if (useCommandPaletteStore.getState().open && !WHILE_PALETTE_OPEN.has(name)) return false;
  const handler = registered.get(name) ?? BUILTIN_COMMANDS[name as AppCommandName];
  if (!handler) return false;
  try {
    const result = handler(args);
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      (result as Promise<unknown>).catch(error => console.error(`[appCommands] ${name} failed`, error));
      return true;
    }
    return typeof result === 'string' || typeof result === 'boolean' ? result : true;
  } catch (error) {
    console.error(`[appCommands] ${name} failed`, error);
    return false;
  }
}

declare global {
  interface Window {
    fiberbrowserCommand?: (name: string, args?: unknown) => AppCommandResult;
  }
}

export function installAppCommandBus(target: Window | undefined = typeof window === 'undefined' ? undefined : window): void {
  if (target) target.fiberbrowserCommand = runAppCommand;
}

installAppCommandBus();
