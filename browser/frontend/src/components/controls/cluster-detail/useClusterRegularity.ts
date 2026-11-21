/**
 * Regularity per cluster for the cluster metaprofiles, on demand: the nucleosome panel's Regularity endpoint
 * (POST /api/nuc/regularity, one observation per cluster and panel, as RegularityView sends) gives each cluster's
 * mean tile score and period along the region. The server computes tiles it lacks and caches the response; this
 * module keeps each answer too, so switching channels back and forth costs nothing. Molecules without nucleosome
 * calls yet: the view is analysed first (the nucleosome panel's Analyse), then asked again.
 */
import { useEffect, useMemo, useState } from 'react';
import { usePanelActive } from '../../../hooks/usePanelDisplayStore';
import { clusterViewScope, isSupersededNuc, nucRegularity } from '../../../features/nucleosomes/api';
import type { RegSeries } from '../../../features/nucleosomes/RegularityView';
import { refreshNucDatasets, resyncAfterSuperseded, useNucJob, isLiveJob } from '../../../features/nucleosomes/nucJob';
import { analyseClusterView, useClusterNucSeries, CLUSTER_VIEWS_JOB_PANEL, type ClusterNucStatus } from './clusterNuc';
import type { NucRegularityObservation, NucRegularityResult } from '../../../features/nucleosomes/types';
import { REG_PERIOD_CHANNEL, REG_SCORE_CHANNEL, resampleTrack } from '../../../utils/clusterViewChannels';

export type RegularityStatus = ClusterNucStatus;

export interface ClusterRegularity {
  /** stateKey -> cluster -> channel key -> profile (500 bins over the panel's view). */
  profiles: Record<string, Record<number, Record<string, number[]>>>;
  /** With perMolecule: stateKey -> QNAME -> [median, max] tile score of each scored molecule. */
  molecules: Record<string, Map<string, [number | null, number | null]>>;
  status: RegularityStatus;
  message: string;
}

/** Each panel's per-molecule regularity (median, max) from an answer asked with per_molecule. */
export function regularityMolecules(series: readonly RegSeries[], result: NucRegularityResult | null | undefined) {
  const out: Record<string, Map<string, [number | null, number | null]>> = {};
  if (!result) return out;
  const byObs = new Map(result.observations.map(o => [o.obsId, o]));
  for (const s of series) {
    const per = byObs.get(s.obsId)?.perMolecule;
    if (!per) continue;
    const m = (out[s.stateKey] ??= new Map());
    for (const [qname, v] of Object.entries(per)) m.set(qname, v);
  }
  return out;
}

/** Complete answers per request (every dataset scored or nothing to analyse). */
const RESULTS = new Map<string, NucRegularityResult>();
/** Answers that still lack some dataset's nucleosome calls: shown meanwhile, never taken for complete. */
const PARTIAL = new Map<string, NucRegularityResult>();
export const CLUSTER_REGULARITY_JOB_PANEL = CLUSTER_VIEWS_JOB_PANEL;

/** Each cluster series' regularity channels, resampled onto the profile bins of its panel's view. */
export function regularityProfiles(series: readonly RegSeries[], result: NucRegularityResult | null | undefined,
  bins = 500): Record<string, Record<number, Record<string, number[]>>> {
  const out: Record<string, Record<number, Record<string, number[]>>> = {};
  if (!result) return out;
  const byObs = new Map(result.observations.map(o => [o.obsId, o]));
  for (const s of series) {
    if (s.cluster === undefined) continue;
    const r = byObs.get(s.obsId);
    if (!r?.track || r.error) continue;
    const score = resampleTrack(r.track.edges, r.track.mean, s.start, s.end, bins);
    const period = r.track.period ? resampleTrack(r.track.edges, r.track.period, s.start, s.end, bins) : [];
    const entry: Record<string, number[]> = {};
    if (score.length) entry[REG_SCORE_CHANNEL] = score;
    if (period.length) entry[REG_PERIOD_CHANNEL] = period;
    if (Object.keys(entry).length) ((out[s.stateKey] ??= {})[s.cluster] = entry);
  }
  return out;
}

/** The datasets whose observations scored nothing because their molecules have no nucleosome calls yet (each
 * dataset on its own: one analysed dataset must not hide another that isn't). */
export function datasetsToAnalyse(observations: readonly NucRegularityObservation[]): string[] {
  const by = new Map<string, NucRegularityObservation[]>();
  for (const o of observations) if (!o.error) by.set(o.datasetId, [...(by.get(o.datasetId) ?? []), o]);
  return [...by].filter(([, obs]) => obs.every(o => (o.scored ?? 0) === 0) && obs.some(o => (o.notComputed ?? 0) > 0)).map(([d]) => d);
}

/** True when some dataset scored nothing for want of nucleosome calls. */
export function needsAnalyse(observations: readonly NucRegularityObservation[]): boolean {
  return datasetsToAnalyse(observations).length > 0;
}

export function useClusterRegularity(activeAsked: boolean, stateKeys: readonly string[], perMolecule = false): ClusterRegularity {
  // A cluster view in a panel hidden by full view asks nothing (shown again: its answers are cached, or asked once).
  const panelActive = usePanelActive();
  const active = activeAsked && panelActive;
  const { series, seriesKey, viewKey, settings, content, includeDuplicates, revision } = useClusterNucSeries(active, stateKeys);
  const job = useNucJob(s => s.job);
  // The nucleosome panel's settings, in full: these profiles are computed as its Regularity view computes them.
  const requestKey = `${seriesKey}|${JSON.stringify(settings.regularity)}|${settings.cohort}|${includeDuplicates}|${revision}|${content}|${perMolecule ? 'mol' : ''}`;
  const [state, setState] = useState<{ key: string; status: RegularityStatus; message: string }>({ key: '', status: 'idle', message: '' });

  useEffect(() => {
    if (!active || !series.length) return;
    if (RESULTS.has(requestKey)) { setState({ key: requestKey, status: 'ready', message: '' }); return; }
    const c = new AbortController();
    setState({ key: requestKey, status: 'loading', message: 'Computing regularity per cluster…' });
    const timer = setTimeout(() => {
      nucRegularity(series, settings.regularity, settings.cohort, includeDuplicates, c.signal, perMolecule, clusterViewScope(settings.panelId))
        .then(async res => {
          if (c.signal.aborted) return;
          const todo = datasetsToAnalyse(res.observations);
          if (todo.length) {
            // Datasets without nucleosome calls yet: the others' answer shows meanwhile; the view is analysed as the
            // panel's Auto-Analyse says (never replacing a running Analyse), and its end asks again.
            PARTIAL.set(requestKey, res);
            if (PARTIAL.size > 8) PARTIAL.delete(PARTIAL.keys().next().value as string);
            setState({ key: requestKey, status: 'analysing', message: 'Analysing nucleosomes in this view for regularity…' });
            const next = await analyseClusterView(series, todo, viewKey, settings, includeDuplicates, 'the regularity channels');
            if (!c.signal.aborted) setState({ key: requestKey, ...next });
            return;
          }
          RESULTS.set(requestKey, res);
          if (RESULTS.size > 24) RESULTS.delete(RESULTS.keys().next().value as string);
          setState({ key: requestKey, status: 'ready', message: '' });
          // New tiles: read tracks that carry the regularity layer fetch rows with them.
          if (res.updatedDatasets.length) await refreshNucDatasets(res.updatedDatasets);
        })
        .catch(e => {
          if (c.signal.aborted) return;
          // Superseded (an Analyse of these datasets): not an error. The profiles on show stay; the Analyse's end
          // moves the revision and this asks again, once.
          if (isSupersededNuc(e)) {
            setState({ key: requestKey, status: 'analysing', message: `Waiting for the running Analyse; the regularity channels follow when it ends.` });
            void resyncAfterSuperseded(settings.panelId);
            return;
          }
          setState({ key: requestKey, status: 'error', message: `Regularity could not be computed: ${String(e?.message ?? e)}` });
        });
    }, 250);
    return () => { clearTimeout(timer); c.abort(); };
  }, [active, requestKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  const result = RESULTS.get(requestKey) ?? PARTIAL.get(requestKey) ?? null;
  const profiles = useMemo(() => regularityProfiles(series, result), [series, result]);
  const molecules = useMemo(() => regularityMolecules(series, result), [series, result]);
  if (!active) return { profiles: {}, molecules: {}, status: 'idle', message: '' };
  if (state.key === requestKey && state.status === 'analysing' && job && isLiveJob(job)) {
    const done = job.progress?.completed, total = job.progress?.total;
    return { profiles, molecules, status: 'analysing', message: `${state.message} ${job.stage ?? job.status}${total ? ` ${done ?? 0}/${total}` : ''}` };
  }
  if (RESULTS.has(requestKey)) return { profiles, molecules, status: 'ready', message: '' };
  if (state.key === requestKey) return { profiles, molecules, status: state.status, message: state.message };
  return { profiles, molecules, status: series.length ? 'loading' : 'idle', message: series.length ? 'Computing regularity per cluster…' : '' };
}
