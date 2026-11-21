import { idSetHas, qnameOfId, recordKey } from './recordKeys';
import { create } from 'zustand';
import { useBrowserStore, type BrowserState } from '../stores/browserStore';
import { captureRunViews, runViewsStillCurrent } from './panelRunScope';
import { sortStateStillCurrent } from './sortScope';

type Kind = 'cluster' | 'sort';
type Progress = { kind: Kind; text: string; refining: boolean };
export const useAnalysisProgress = create<{ progress: Progress | null }>(() => ({ progress: null }));
let active: { cancel: () => void } | null = null;
export function cancelProgressiveAnalysis() { active?.cancel(); }

/** What the progress line says when a run is stopped (`locus`: a panel it ran for moved meanwhile). */
export function stoppedText(kind: Kind, refining: boolean, reason?: 'locus' | 'changed'): string {
  if (reason === 'changed') {
    const again = kind === 'cluster' ? 'Cluster again.' : 'Sort again.';
    return refining
      ? `Refinement stopped: the clusters, filters, read order or settings changed, so the result shown is the preview. ${again}`
      : `Stopped: the clusters, filters, read order or settings changed before it finished, so nothing was applied. ${again}`;
  }
  if (reason === 'locus') {
    const again = kind === 'cluster' ? 'Cluster again here.' : 'Sort again here.';
    return refining
      ? `Refinement stopped: the locus changed, so the result shown is the preview. ${again}`
      : `Stopped: the locus changed before it finished, so nothing was applied. ${again}`;
  }
  return refining ? 'Full refinement stopped; the previous result was a preview.' : 'Run stopped before completion.';
}

/** Intersect the display with an optional full scope; an empty display stays empty. */
export function displayedScope(ids: string[] | undefined, full?: string[]): string[] {
  const allowed = full === undefined ? null : new Set(full);
  // By identity: a graph row's shown id names its record, which a scope may hold as a record key (a graph run's
  // labels) or a QNAME (graph features review).
  return [...new Set(ids ?? [])].filter(id => !allowed || idSetHas(allowed, [id, qnameOfId(id)], recordKey(id)));
}

/** Wait for every target's display; skip a duplicate fit when its full scope is already drawn. */
export function needsDisplayPreview(windows: Array<{ shown: string[]; full?: string[] }>): boolean {
  return windows.length > 0 && windows.every(view => view.shown.length > 0)
    && windows.some(view => view.full === undefined || new Set(view.full).size > new Set(view.shown).size);
}

/** Fields of a dataset the server refreshes as its outputs change (nucleosome layers, regularity tiles, patches, the
 * patch lane's geometry labels): a display refetch or relabel, not a change of intent. */
export const REFRESHED_DATASET_FIELDS = new Set(['source_identity', 'regularity_identity', 'patch_labels_identity',
  'available_layers', 'derived_layers']);

/** The same datasets with the same settings, whatever outputs the server added meanwhile. */
export function sameDatasetIntent(a: BrowserState['datasets'], b: BrowserState['datasets']): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    if (x === y) return true;
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    for (const k of keys) {
      if (REFRESHED_DATASET_FIELDS.has(k)) continue;
      if ((x as unknown as Record<string, unknown>)[k] !== (y as unknown as Record<string, unknown>)[k]) return false;
    }
    return true;
  });
}

/** One preview/refinement owns its original scope until user intent changes.
 * Display refetches are allowed. Navigation, filters, selection, edits, restore,
 * or a newer operation abort network work and prevent stale publication.
 */
export function beginProgressiveAnalysis(kind: Kind, keys: string[]) {
  cancelProgressiveAnalysis();
  const controller = new AbortController();
  let expected = useBrowserStore.getState();
  const views = captureRunViews(expected, keys);
  let applying = false;
  let refining = false;
  const globals: Array<keyof BrowserState> = ['activeClusterTreeNodeId', 'spanningOnly',
    'minFootprints', 'analysisSampleCount', 'analysisSampleSeed', 'clusterK', 'clusterMethod',
    'clusterResolution', 'clusterFeatureRules', 'subnucleosomalThreshold', 'accessibilityThreshold',
    'selectedPeaks', 'peakModes', 'peaksByRule', 'selectedGenes', 'selectedFeatures', 'clusterPeakMode', 'selectedDatasets', 'datasets',
    'clusterGroupLabels', 'clusterTreeNodes', 'clusterPreparationCount'];
  // One run over all its views: any of them moving stops it (3.0.0 audit MED-1).
  const viewsCurrent = (now: BrowserState) => runViewsStillCurrent(views, now);
  const matches = (now: BrowserState) => viewsCurrent(now)
    && globals.every(key => (key === 'datasets' ? sameDatasetIntent(expected.datasets, now.datasets) : expected[key] === now[key]))
    && expected.activeColormap.qualityFilters === now.activeColormap.qualityFilters
    && keys.every(key => sortStateStillCurrent(expected, now, key));
  let unsubscribe = () => {};
  const run = {
    signal: controller.signal,
    current: () => !controller.signal.aborted && active === run && matches(useBrowserStore.getState()),
    cancel: (reason?: 'locus' | 'changed') => {
      controller.abort();
      unsubscribe();
      if (active === run) {
        active = null;
        useAnalysisProgress.setState({ progress: { kind, refining: false, text: stoppedText(kind, refining, reason) } });
      }
    },
    commit: (apply: () => void) => {
      if (!run.current()) return false;
      applying = true;
      try { apply(); } finally { expected = useBrowserStore.getState(); applying = false; }
      return true;
    },
    refine: () => {
      refining = true;
      if (run.current()) useAnalysisProgress.setState({ progress: { kind,
        text: 'Preview shown · refining the full active subset…', refining: true } });
    },
    complete: () => { if (run.current()) useAnalysisProgress.setState({ progress: null }); },
    dispose: () => {
      unsubscribe();
      if (active === run) {
        if (useAnalysisProgress.getState().progress?.refining) run.cancel();
        else active = null;
      }
    },
  };
  active = run;
  useAnalysisProgress.setState({ progress: null });
  // A panel it ran for moved (or the main locus did): said so, the run's results belong to the old locus.
  unsubscribe = useBrowserStore.subscribe(now => {
    if (!applying && !matches(now)) run.cancel(viewsCurrent(now) ? 'changed' : 'locus');
  });
  return run;
}
