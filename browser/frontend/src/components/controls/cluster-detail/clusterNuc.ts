/**
 * What the cluster views' on-demand nucleosome channels (useClusterRegularity, useClusterGeometries) share:
 *
 * - their series: every cluster of each read panel, from the panels' filtered read sets (a cluster focus or pick in a
 *   read panel never strips the other clusters' profiles), re-planned when filters, split panels or assignments change;
 * - their settings: the nucleosome panel's (regParams.clusterViewNucSettings), sent in full on every request, so a
 *   cluster profile is computed exactly as the panel's Regularity view computes, never with whatever the server used
 *   last;
 * - their Analyse rule: a view without nucleosome calls is analysed under the panel's id with its analysis
 *   parameters, never while another Analyse runs (the server runs one at a time and a new request replaces the
 *   running one: the hook waits for it to end, which moves the revision and asks again), and as the panel's
 *   Auto-Analyse setting says ('off': never by itself; 'first': once per page; 'every': once per view).
 */
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../stores/browserStore';
import { useSplitPanelStore } from '../../../stores/splitPanelStore';
import { nucObservations, observationDatasets, observationViews } from '../../../features/nucleosomes/planner';
import { regularitySeries, type RegSeries } from '../../../features/nucleosomes/RegularityView';
import { analyseUnlessBusy, autoAnalyseVetoed, isNucBusy, useNucJob } from '../../../features/nucleosomes/nucJob';
import { autoAnalyseAction, consumeAutoAnalyse } from '../../../features/nucleosomes/firstOpen';
import { clusterViewNucSettings, seriesIdentity, seriesView, type NucViewSettings } from '../../../features/nucleosomes/regParams';

export type ClusterNucStatus = 'idle' | 'loading' | 'analysing' | 'needs-analyse' | 'ready' | 'error';

/** Every cluster series of the wanted read panels (state keys), and its request identity. */
export function useClusterNucSeries(active: boolean, stateKeys: readonly string[]) {
  const clusterAssignments = useBrowserStore(s => s.clusterAssignments);
  const deps = useBrowserStore(useShallow(s => [s.panels, s.datasets, s.chrom, s.start, s.end, s.filteredReadIds, s.selectedDatasets]));
  const splitReads = useSplitPanelStore(s => s.reads);
  const keysKey = stateKeys.join('\u0000');
  const series = useMemo(() => {
    if (!active) return [] as RegSeries[];
    const wanted = new Set(stateKeys);
    // Every cluster: the read panels' cluster focus and picks narrow what they draw, not these profiles.
    const st = { ...useBrowserStore.getState(), clusterFocus: {}, selectedClusters: {} };
    const obs = nucObservations(st).filter(o => wanted.has(o.stateKey) && o.kind === 'linear');
    return regularitySeries(obs, clusterAssignments).filter(s => s.cluster !== undefined);
  }, [active, keysKey, clusterAssignments, splitReads, ...deps]);   // eslint-disable-line react-hooks/exhaustive-deps
  const panels = deps[0] as Parameters<typeof clusterViewNucSettings>[0];
  const settings = useMemo(() => clusterViewNucSettings(panels), [panels]);
  // The datasets' content (a reload, a scan) changes what the server answers.
  // ... and the toolbar's QC-fail toggle (the nucleosome routes send it with the duplicate policy).
  const content = useBrowserStore(s => s.datasets.map(d => `${d.id}:${d.source_identity ?? ''}`).join(',') + `|qc${Boolean(s.showQcFailReads)}`);
  const includeDuplicates = useBrowserStore(s => Boolean(s.showDuplicateReads));
  const revision = useNucJob(s => s.revision);
  return { series, seriesKey: seriesIdentity(series), viewKey: seriesView(series), settings, content, includeDuplicates, revision };
}

/** Views (and datasets) the cluster views started an Analyse for. ('first' is the nucleosome panel's own budget,
 * firstOpen.ts: one automatic Analyse per panel, whether the panel or its cluster views start it.) */
const ATTEMPTED = new Set<string>();

/** Tests: forget attempts. */
export function resetClusterAnalyse(): void { ATTEMPTED.clear(); }

/**
 * Datasets of these series without nucleosome calls: analyse them (or wait, or offer). Returns the status the hook
 * shows with its message.
 */
export async function analyseClusterView(series: readonly RegSeries[], todo: readonly string[], viewKey: string,
  settings: NucViewSettings, includeDuplicates: boolean, what: string): Promise<{ status: ClusterNucStatus; message: string }> {
  const keys = todo.map(d => `${viewKey}|${d}`);
  const tried = keys.every(k => ATTEMPTED.has(k));
  const mode = settings.autoAnalyse;
  const panelKey = settings.panelId ?? CLUSTER_VIEWS_JOB_PANEL;
  const sub = series.filter(s => todo.includes(s.datasetId));
  const views = observationViews([...sub]);
  // The panel's 'first' budget (used up by the panel's own automatic Analyse too), and never a view whose Analyse the
  // user cancelled (until the user chooses Analyse there).
  const allowed = autoAnalyseAction(mode, panelKey, todo) === 'run' && !autoAnalyseVetoed(views);
  // An Analyse running or being submitted (the other cluster channel's, the panel's): wait for it, whether or not this
  // view was tried (its end moves the revision and the hook asks again), never "choose Analyse" meanwhile.
  if (isNucBusy()) return { status: 'analysing', message: `Waiting for the running Analyse; ${what} follow when it ends.` };
  if (tried || !allowed) {
    return { status: 'needs-analyse', message: `This view has no nucleosome calls yet for ${what}: choose Analyse this view in the nucleosome panel.` };
  }
  const outcome = await analyseUnlessBusy({
    datasets: observationDatasets([...sub]), views, include_duplicates: includeDuplicates,
    ...(settings.analysis ? { parameters: settings.analysis } : {}),
  }, settings.panelId ?? CLUSTER_VIEWS_JOB_PANEL);
  if (outcome === 'waiting') return { status: 'analysing', message: `Waiting for the running Analyse; ${what} follow when it ends.` };
  if (outcome === 'error') return { status: 'error', message: `Analyse could not start: ${useNucJob.getState().error}` };
  for (const k of keys) ATTEMPTED.add(k);
  consumeAutoAnalyse(mode, panelKey);
  return { status: 'analysing', message: `Analysing nucleosomes in this view for ${what}…` };
}

/** The job panel id when no nucleosome panel is open. */
export const CLUSTER_VIEWS_JOB_PANEL = 'cluster-views';
