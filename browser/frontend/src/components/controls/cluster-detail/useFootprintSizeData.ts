/**
 * The footprint size plots' data (Clusters › Footprint sizes and the Plots workspace): one request per clustering
 * round, or one per view for all reads (group_by 'all'), to /api/cluster/vplot, keyed by everything a plot depends
 * on. The result carries the key and the locus it was computed for, so a caller can tell a current result from a
 * previous view's (the Plots stale-state guard) and never show the latter's numbers as current.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ALL_READS_KEY, fetchFootprintSizes, type FootprintSizeData } from '../../../api/clustering';
import type { FootprintSizeSettings } from '../../../utils/footprintSizeSettings';
import type { ClusterOperationRound } from './clusterOperationRounds';
import type { ClusterSummary } from './OverviewTabContent';
import { getClusterLabel } from '../../tracks/ReadTrack';
import { useBrowserStore } from '../../../stores/browserStore';

export interface FootprintSizePanel {
  /** Panel state key. */
  key: string;
  datasetId: string;
  label: string;
  /** The dataset's own name (all-reads plots are per dataset: a split panel's group name would mislabel them). */
  datasetLabel?: string;
  color?: string;
}

export interface FootprintSizesTarget {
  chrom: string;
  start: number;
  end: number;
  /** A panel on another assembly: its reference key. */
  genome: string | null;
  panels: FootprintSizePanel[];
}

export type FootprintSizesClusters = FootprintSizesTarget & {
  rounds: ClusterOperationRound[]; visible: ClusterSummary[];
  /** Which read is in which cluster (a merge or branch switch keeps the count but changes the plots). */
  assignmentSignature?: string;
};

export interface FootprintSizePlot {
  id: string;
  title: string;
  color?: string;
  data: FootprintSizeData;
}

export interface FootprintSizeEntry {
  /** The request this answers. */
  key: string;
  /** The locus it was computed for. */
  locus: { chrom: string; start: number; end: number; genome: string | null };
  byPanel: Record<string, Record<string, FootprintSizeData>>;
  /** Drawn from stored data (a Plots Gallery entry), not fetched. */
  seeded?: boolean;
}

export interface FootprintSizeDataOptions {
  /** Plots' Random N reads per dataset (stable keys, this seed); absent: every read. */
  readSample?: { n: number; seed: number } | null;
  /** Plots summaries: the box mean's seeded bootstrap over reads, answered as each matrix's box_ci. */
  boxBootstrap?: { size_from: number; size_to: number; pos_from: number | null; pos_to: number | null; resamples: number; seed: number; transform?: string } | null;
  target: FootprintSizesTarget;
  useClusters: boolean;
  clusters?: FootprintSizesClusters | null;
  settings: FootprintSizeSettings;
  sampleSeed?: string;
  settingsKey?: string;
  /** Min footprints' uncalled-read rule (3.0.6): false counts reads without footprint calls too (default true). */
  hideUncalled?: boolean;
  /** Wait this long after the last change before fetching (ms; default 250). */
  delayMs?: number;
  /** False: hold (no request); the last result stays. */
  enabled?: boolean;
  /** A stored result (Plots Gallery): shown at once, and no request is made while the request key is its key. */
  seed?: FootprintSizeEntry | null;
  /** Every dataset pooled into one matrix (group_by 'pooled'), under the panel key POOLED_PANEL.key. */
  pooled?: boolean;
  /** Read groups (Plots: split panels, selected classes): one request per group, its reads as cluster 0, answered
   * under the panel key `${group.id}@${datasetId}`. */
  readGroups?: Array<{ id: string; members: Record<string, Set<string>> }> | null;
  /** Their identity (ids and member counts) for the request key. */
  groupsSig?: string;
}

/** The one panel a pooled plot shows (Plots, Group by None). */
export const POOLED_PANEL: FootprintSizePanel = { key: 'all', datasetId: '__pooled__', label: 'All datasets', color: '#52514e' };

/** Everything a plot depends on: the fetch runs when (and only when) this changes. */
export function footprintSizeRequestKey(o: Pick<FootprintSizeDataOptions, 'target' | 'useClusters' | 'clusters' | 'settings' | 'sampleSeed' | 'settingsKey' | 'pooled' | 'groupsSig'>): string {
  const { target, useClusters, clusters, settings } = o;
  return JSON.stringify({
    kind: 'fiberbrowser.footprint_sizes.v1',
    group: useClusters ? 'cluster' : o.pooled ? 'pooled' : o.groupsSig ? `groups:${o.groupsSig}` : 'all',
    chrom: target.chrom, start: target.start, end: target.end, genome: target.genome,
    panels: target.panels.map(p => `${p.key}:${p.datasetId}`),
    rounds: useClusters ? clusters!.rounds.map(r => Object.entries(r.assignments).map(([d, a]) => `${d}:${Object.keys(a).length}:${r.keyByDataset[d]}`)) : null,
    assignments: useClusters ? clusters!.assignmentSignature ?? null : null,
    mode: settings.mode, normalization: settings.normalization, sigmaSizeBp: settings.sigmaSizeBp, sigmaPosBp: settings.sigmaPosBp,
    sizeBin: settings.sizeBin, posBin: settings.posBin, sizeMin: settings.sizeMin, sizeMax: settings.sizeMax,
    minFootprints: settings.minFootprints, layer: settings.layer, sampleSeed: o.sampleSeed ?? null, settingsKey: o.settingsKey ?? '',
  });
}

/**
 * A request key without the refresh generation (the first element of the analysis settings key): a stored result
 * still answers a request that differs only by a repaint counter (restoring a browser state bumps it), but not one
 * with other quality filters or layer inference.
 */
export function seedMatchKey(key: string): string {
  try {
    const k = JSON.parse(key) as Record<string, unknown>;
    if (typeof k.settingsKey === 'string' && k.settingsKey) {
      const parts = JSON.parse(k.settingsKey);
      if (Array.isArray(parts)) k.settingsKey = JSON.stringify(parts.slice(1));
    }
    return JSON.stringify(k);
  } catch {
    return key;
  }
}

export function useFootprintSizeData(o: FootprintSizeDataOptions): {
  entry: FootprintSizeEntry | null; requestKey: string; loading: boolean; error: string | null;
} {
  const { target, useClusters, clusters, settings, sampleSeed, settingsKey = '', delayMs = 250, enabled = true, seed = null, pooled = false, readGroups = null, groupsSig = '' } = o;
  const [entry, setEntry] = useState<FootprintSizeEntry | null>(seed);
  const entryRef = useRef(entry);
  entryRef.current = entry;
  // A new seed (another Gallery entry opened): show it at once.
  useEffect(() => { if (seed) { setEntry(seed); entryRef.current = seed; } }, [seed]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const seq = useRef(0);

  // Uncalled reads (no footprints) are left out unless Min footprints is "All reads, including uncalled" (-1).
  // An explicit option (o.hideUncalled) wins; part of the request key either way.
  const storeHidesUncalled = useBrowserStore(st => st.minFootprints !== -1);
  const hideUncalled = o.hideUncalled ?? storeHidesUncalled;
  const requestKey = useMemo(() => footprintSizeRequestKey({ target, useClusters, clusters, settings, sampleSeed, settingsKey: `${o.readSample ? `${settingsKey}|sample:${o.readSample.n}:${o.readSample.seed}` : settingsKey}${o.boxBootstrap ? `|boot:${JSON.stringify(o.boxBootstrap)}` : ''}${hideUncalled ? '' : '|uncalled'}`, pooled, groupsSig: readGroups ? groupsSig : '' }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [useClusters, target, clusters, settings.mode, settings.normalization, settings.sigmaSizeBp, settings.sigmaPosBp,
      settings.sizeBin, settings.posBin, settings.sizeMin, settings.sizeMax, settings.minFootprints, settings.layer, sampleSeed, settingsKey, pooled, groupsSig, readGroups, o.readSample?.n, o.readSample?.seed, JSON.stringify(o.boxBootstrap ?? null), hideUncalled]);

  useEffect(() => {
    if (!enabled) return;
    // Already showing the answer to this request (a stored result): nothing to fetch.
    if (seed && seed.key !== requestKey && seedMatchKey(seed.key) === seedMatchKey(requestKey)) {
      const rekeyed = { ...seed, key: requestKey };
      setEntry(rekeyed);
      entryRef.current = rekeyed;
      setLoading(false);
      return;
    }
    const have = seed && seed.key === requestKey ? seed : entryRef.current;
    if (have && have.key === requestKey) { setLoading(false); return; }
    if (!target.panels.length || target.end <= target.start) { setLoading(false); return; }
    const controller = new AbortController();
    const mine = ++seq.current;
    const key = requestKey;
    const locus = { chrom: target.chrom, start: target.start, end: target.end, genome: target.genome };
    const common = {
      sizeBin: settings.sizeBin, posBin: settings.posBin, sizeMin: settings.sizeMin, sizeMax: settings.sizeMax,
      mode: settings.mode, normalization: settings.normalization, sigmaSizeBp: settings.sigmaSizeBp, sigmaPosBp: settings.sigmaPosBp,
      minFootprints: settings.minFootprints, layer: settings.layer, sampleSeed, panelGenome: target.genome, signal: controller.signal, readSample: o.readSample ?? null, boxBootstrap: o.boxBootstrap ?? null, hideUncalled,
    };
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      const jobs: Array<Promise<Array<[string, string, Record<string, FootprintSizeData>]>>> = [];
      if (useClusters) {
        for (const round of clusters!.rounds) {
          jobs.push(fetchFootprintSizes(target.chrom, target.start, target.end, {
            ...common, groupBy: 'cluster', clusterAssignments: round.assignments, datasetIds: Object.keys(round.assignments),
          }).then(res => Object.entries(round.keyByDataset).flatMap(([ds, k]) => {
            const d = res.data?.[ds];
            return d && !('error' in d) ? [[k, ds, d as Record<string, FootprintSizeData>]] as Array<[string, string, Record<string, FootprintSizeData>]> : [];
          })));
        }
      } else if (readGroups) {
        const inView = new Set(target.panels.map(p => p.datasetId));
        for (const g of readGroups) {
          const assignments: Record<string, Record<string, number>> = {};
          for (const [ds, ids] of Object.entries(g.members)) {
            if (!inView.has(ds) || !ids.size) continue;
            assignments[ds] = Object.fromEntries([...ids].map(id => [id, 0]));
          }
          const dsIds = Object.keys(assignments);
          if (!dsIds.length) continue;
          jobs.push(fetchFootprintSizes(target.chrom, target.start, target.end, { ...common, groupBy: 'cluster', clusterAssignments: assignments, datasetIds: dsIds })
            .then(res => dsIds.flatMap(ds => {
              const d = res.data?.[ds];
              return d && !('error' in d) ? [[`${g.id}@${ds}`, ds, d as Record<string, FootprintSizeData>]] as Array<[string, string, Record<string, FootprintSizeData>]> : [];
            })));
        }
      } else if (pooled) {
        const datasetIds = [...new Set(target.panels.map(p => p.datasetId))];
        jobs.push(fetchFootprintSizes(target.chrom, target.start, target.end, { ...common, groupBy: 'pooled', datasetIds })
          .then(res => {
            const d = (res.data as Record<string, unknown> | undefined)?.__pooled__ as Record<string, FootprintSizeData> | undefined;
            return d ? [[POOLED_PANEL.key, POOLED_PANEL.datasetId, d]] as Array<[string, string, Record<string, FootprintSizeData>]> : [];
          }));
      } else {
        const datasetIds = [...new Set(target.panels.map(p => p.datasetId))];
        jobs.push(fetchFootprintSizes(target.chrom, target.start, target.end, { ...common, groupBy: 'all', datasetIds })
          .then(res => target.panels.flatMap(p => {
            const d = res.data?.[p.datasetId];
            if (d && 'error' in d) throw new Error(String((d as { error: string }).error));
            return d ? [[p.key, p.datasetId, d as Record<string, FootprintSizeData>]] as Array<[string, string, Record<string, FootprintSizeData>]> : [];
          })));
      }
      Promise.all(jobs)
        .then(parts => {
          // A late answer for a view the plot has left is dropped (the stale-state guard's first line).
          if (seq.current !== mine || controller.signal.aborted) return;
          const byPanel: Record<string, Record<string, FootprintSizeData>> = {};
          for (const [k, , d] of parts.flat()) byPanel[k] = d;
          setEntry({ key, locus, byPanel });
        })
        .catch(err => {
          if (controller.signal.aborted || err?.name === 'AbortError' || seq.current !== mine) return;
          setError({ key, message: `Footprint size plots could not be computed: ${err instanceof Error ? err.message : String(err)}` });
        })
        .finally(() => { if (seq.current === mine && !controller.signal.aborted) setLoading(false); });
    }, delayMs);
    return () => { controller.abort(); window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, enabled, seed]);

  return { entry, requestKey, loading, error: error && error.key === requestKey ? error.message : null };
}

/** The plots, in panel order: one per dataset (panels sharing a dataset show it once), or per shown cluster. */
export function footprintSizePlots(
  byPanel: Record<string, Record<string, FootprintSizeData>> | null,
  panels: FootprintSizePanel[],
  useClusters: boolean,
  shownClusters: Array<{ cluster: number; color: string }>,
): FootprintSizePlot[] {
  if (!byPanel) return [];
  const out: FootprintSizePlot[] = [];
  const seenDs = new Set<string>();
  for (const p of panels) {
    const d = byPanel[p.key];
    if (!d) continue;
    if (!useClusters) {
      if (seenDs.has(p.datasetId)) continue;
      seenDs.add(p.datasetId);
      const m = d[String(ALL_READS_KEY)];
      if (m) out.push({ id: `${p.key}|all`, title: p.datasetLabel ?? p.label, color: p.color, data: m });
      continue;
    }
    for (const c of shownClusters) {
      const m = d[String(c.cluster)];
      if (m) out.push({ id: `${p.key}|${c.cluster}`, title: `${panels.length > 1 ? `${p.label} · ` : ''}${getClusterLabel(c.cluster, true)}`, color: c.color, data: m });
    }
  }
  return out;
}
