/**
 * Regularity patches per cluster for the cluster views, on demand: the nucleosome panel's patch section endpoint
 * (POST /api/nuc/geometries, one observation per cluster and panel, as for regularity). The server's patch and
 * geometry caches answer it (no patches are recomputed here); this module keeps each answer too.
 *
 * - Patch share: the fraction of a cluster's molecules in a high- / low-regularity patch at each position (the answer's
 *   share profiles).
 * - Geometry carried: each molecule's geometry group (the root geometry it carries in full, else partly; 0 = none),
 *   for the read map's colour.
 *
 * The patch parameters and reference overrides are the nucleosome panel's (the first one open), so asking here
 * never resets what the panel set. Molecules without regularity tiles yet: the view is analysed first, then asked
 * again (as the regularity channels do).
 */
import { useEffect, useMemo, useState } from 'react';
import { usePanelActive } from '../../../hooks/usePanelDisplayStore';
import { clusterViewScope, isSupersededNuc, nucGeometries } from '../../../features/nucleosomes/api';
import type { RegSeries } from '../../../features/nucleosomes/RegularityView';
import { refreshNucDatasets, resyncAfterSuperseded, useNucJob, isLiveJob } from '../../../features/nucleosomes/nucJob';
import type { NucGeometryResult } from '../../../features/nucleosomes/types';
import { analyseClusterView, useClusterNucSeries } from './clusterNuc';
import { PATCH_SHARE_CHANNEL, PATCH_SHARE_LOW_CHANNEL, resampleTrack } from '../../../utils/clusterViewChannels';
import { requestPatchParams } from '../../../features/nucleosomes/PatchGeometryView';
import type { RegularityStatus } from './useClusterRegularity';

export interface ClusterGeometries {
  /** stateKey -> cluster -> { 'nucpatch.share': profile (500 bins over the panel's view) }. */
  profiles: Record<string, Record<number, Record<string, number[]>>>;
  /** dataset id -> QNAME -> high-regularity geometry group (root geometry number; 0 = carries none). */
  groups: Record<string, Map<string, number>>;
  /** The same over the low-regularity geometries (L numbers). */
  groupsLow: Record<string, Map<string, number>>;
  /** Geometries found (for the legend). */
  nGeometries: number;
  status: RegularityStatus;
  message: string;
}

/** Complete answers per request; answers still lacking some dataset's tiles are kept apart (shown meanwhile). */
const RESULTS = new Map<string, NucGeometryResult>();
const PARTIAL = new Map<string, NucGeometryResult>();

/** Each cluster series' patch share, resampled onto the profile bins of its panel's view. */
export function patchShareProfiles(series: readonly RegSeries[], result: NucGeometryResult | null | undefined,
  bins = 500): Record<string, Record<number, Record<string, number[]>>> {
  const out: Record<string, Record<number, Record<string, number[]>>> = {};
  const edges = result?.profiles?.edges;
  if (!result || !edges?.length) return out;
  for (const s of series) {
    if (s.cluster === undefined || result.errors[s.obsId]) continue;
    const values = result.profiles.share?.[s.obsId];
    if (!values) continue;
    const share = resampleTrack(edges, values, s.start, s.end, bins);
    const low = result.profiles.shareLow?.[s.obsId];
    const shareLow = low ? resampleTrack(edges, low, s.start, s.end, bins) : [];
    if (share.length || shareLow.length) (out[s.stateKey] ??= {})[s.cluster] = {
      ...(share.length ? { [PATCH_SHARE_CHANNEL]: share } : {}), ...(shareLow.length ? { [PATCH_SHARE_LOW_CHANNEL]: shareLow } : {}) };
  }
  return out;
}

/** Each dataset's geometry group per molecule (QNAME). */
export function geometryGroups(result: NucGeometryResult | null | undefined, kind: 'high' | 'low' = 'high'): Record<string, Map<string, number>> {
  const out: Record<string, Map<string, number>> = {};
  const G = result?.geometries ?? [];
  // assignments give the root's index in the list + 1; the map shows its number within its kind (G3, L2)
  const number = (g: number) => (g > 0 ? G[g - 1]?.number ?? g : 0);
  for (const [ds, a] of Object.entries(result?.assignments ?? {})) {
    const src = kind === 'low' ? a.groupLow : a.group;
    if (src) out[ds] = new Map(Object.entries(src).map(([q, g]) => [q, number(g)]));
  }
  return out;
}

/** The datasets whose observations all got no patches because the dataset has no regularity reference / tiles
 * in this view yet (each dataset on its own: one analysed dataset must not hide another that isn't). */
export function geometryDatasetsToAnalyse(result: NucGeometryResult, series: readonly RegSeries[]): string[] {
  const errors = result.errors ?? {};
  const by = new Map<string, RegSeries[]>();
  for (const s of series) by.set(s.datasetId, [...(by.get(s.datasetId) ?? []), s]);
  return [...by].filter(([, ss]) => ss.every(s => /Analyse/i.test(errors[s.obsId] ?? ''))).map(([d]) => d);
}

export function useClusterGeometries(activeAsked: boolean, stateKeys: readonly string[]): ClusterGeometries {
  // A cluster view in a panel hidden by full view asks nothing (shown again: its answers are cached, or asked once).
  const panelActive = usePanelActive();
  const active = activeAsked && panelActive;
  const { series, seriesKey, viewKey, settings, content, includeDuplicates, revision } = useClusterNucSeries(active, stateKeys);
  const job = useNucJob(s => s.job);
  // The nucleosome panel's settings, in full (patch parameters, reference choices, regularity parameters, cohort).
  const body = useMemo(() => ({ patches: requestPatchParams(settings.patches.params), regularity: settings.regularity,
    ...(settings.patches.reference ? { reference: settings.patches.reference } : {}), cohort: settings.cohort, includeDuplicates }),
  [settings, includeDuplicates]);
  const requestKey = `${seriesKey}|${JSON.stringify(body)}|${revision}|${content}`;
  const [state, setState] = useState<{ key: string; status: RegularityStatus; message: string }>({ key: '', status: 'idle', message: '' });

  useEffect(() => {
    if (!active || !series.length) return;
    if (RESULTS.has(requestKey)) { setState({ key: requestKey, status: 'ready', message: '' }); return; }
    const c = new AbortController();
    setState({ key: requestKey, status: 'loading', message: 'Finding regularity patches per cluster…' });
    const timer = setTimeout(() => {
      nucGeometries(series, body, c.signal, clusterViewScope(settings.panelId))
        .then(async res => {
          if (c.signal.aborted) return;
          const todo = geometryDatasetsToAnalyse(res, series);
          if (todo.length) {
            // Datasets without a regularity reference yet: the others' patches show meanwhile; the view is analysed
            // as the panel's Auto-Analyse says (never replacing a running Analyse), and its end asks again.
            PARTIAL.set(requestKey, res);
            if (PARTIAL.size > 8) PARTIAL.delete(PARTIAL.keys().next().value as string);
            setState({ key: requestKey, status: 'analysing', message: 'Analysing nucleosomes in this view for patches…' });
            const next = await analyseClusterView(series, todo, viewKey, settings, includeDuplicates, 'the patch channels');
            if (!c.signal.aborted) setState({ key: requestKey, ...next });
            return;
          }
          RESULTS.set(requestKey, res);
          if (RESULTS.size > 16) RESULTS.delete(RESULTS.keys().next().value as string);
          setState({ key: requestKey, status: 'ready', message: '' });
          if (res.updatedDatasets.length) await refreshNucDatasets(res.updatedDatasets);
        })
        .catch(e => {
          if (c.signal.aborted) return;
          // Superseded (an Analyse of these datasets): not an error. The patches on show stay; the Analyse's end
          // moves the revision and this asks again, once.
          if (isSupersededNuc(e)) {
            setState({ key: requestKey, status: 'analysing', message: `Waiting for the running Analyse; the patch channels follow when it ends.` });
            void resyncAfterSuperseded(settings.panelId);
            return;
          }
          setState({ key: requestKey, status: 'error', message: `Patches could not be computed: ${String(e?.message ?? e)}` });
        });
    }, 250);
    return () => { clearTimeout(timer); c.abort(); };
  }, [active, requestKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  const result = RESULTS.get(requestKey) ?? PARTIAL.get(requestKey) ?? null;
  const profiles = useMemo(() => patchShareProfiles(series, result), [series, result]);
  const groups = useMemo(() => geometryGroups(result), [result]);
  const groupsLow = useMemo(() => geometryGroups(result, 'low'), [result]);
  const nGeometries = result?.geometries?.length ?? 0;
  if (!active) return { profiles: {}, groups: {}, groupsLow: {}, nGeometries: 0, status: 'idle', message: '' };
  if (state.key === requestKey && state.status === 'analysing' && job && isLiveJob(job)) {
    const done = job.progress?.completed, total = job.progress?.total;
    return { profiles, groups, groupsLow, nGeometries, status: 'analysing', message: `${state.message} ${job.stage ?? job.status}${total ? ` ${done ?? 0}/${total}` : ''}` };
  }
  if (RESULTS.has(requestKey)) return { profiles, groups, groupsLow, nGeometries, status: 'ready', message: '' };
  if (state.key === requestKey) return { profiles, groups, groupsLow, nGeometries, status: state.status, message: state.message };
  return { profiles, groups, groupsLow, nGeometries, status: series.length ? 'loading' : 'idle', message: series.length ? 'Finding regularity patches per cluster…' : '' };
}
