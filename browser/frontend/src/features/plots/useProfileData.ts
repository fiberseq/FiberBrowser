/**
 * Metaprofile data: the reads over the plot's region, per dataset, from /api/reads/compact (a seeded display sample,
 * `readCap` per dataset, with the annotation layers or m6A marks the source needs), turned into profile-engine reads
 * of the chosen source and grouped (dataset, cluster, or pooled), then accumulated. Keyed like the size plots: the
 * result carries its request key and locus (the stale-state guard), and a stored result (Gallery) can seed it.
 *
 * Phase 3 swaps the fetch for a region-set endpoint returning the same engine reads per region; the engine stays.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson } from '../../api/sharedFetch';
import { useBrowserStore } from '../../stores/browserStore';
import { getClusterLabel } from '../../components/tracks/ReadTrack';
import type { FootprintSizesClusters, FootprintSizesTarget } from '../../components/controls/cluster-detail/useFootprintSizeData';
import { ALL_FOOTPRINTS } from '../../utils/footprintSizeSettings';
import { accumulateProfiles, type ProfileRead, type ProfileRegion, type RawProfile } from './profileEngine';
import type { PlotSpec, SamplingSettings } from './plotModel';
import { lowestK, stableKey } from '../../utils/stableSample';
import type { ReadGroupDef } from './readGroups';
import { histogramAccumulate, histogramRaws } from './sizeHistogram';
import { applyBandsAndCondition } from './sizeBands';
import { poolProfiles } from './profileEngine';
import type { HeatmapFeature } from './heatmapData';

export interface ProfileGroup {
  /** Bootstrap units (reads) with their own raw profiles: kept while a summary is on (not stored in the Gallery). */
  units?: import('./summary').SummaryUnit[];
  id: string;
  title: string;
  color?: string;
  /** A dash pattern (datasets within a BED set's colour). */
  dash?: number[];
  raw: RawProfile;
}

export interface ProfileEntry {
  key: string;
  /** Reads used / in scope per dataset (the plot's sampling). */
  sampled?: Record<string, { used: number; total: number }>;
  locus: { chrom: string; start: number; end: number; genome: string | null };
  binBp: number;
  groups: ProfileGroup[];
  seeded?: boolean;
}

interface CompactLayer { intervals?: number[][] }
interface CompactRead {
  id: string;
  intervals?: number[][];
  aligned_blocks?: number[][];
  layers?: Record<string, CompactLayer | undefined>;
  methyl_m6a?: number[];
  /** The marks of datasets without a separate m6A list (e.g. DddA deamination calls). */
  methyl?: number[];
}

/** The compact layers a source reads. */
export function sourceLayers(source: string): string[] {
  if (source === ALL_FOOTPRINTS) return ['nuc', 'tf'];
  if (source === 'fire') return ['msp', 'fire'];
  if (source === 'm6a') return [];
  return [source];
}

/** A compact read (coordinates relative to `offset`) as an engine read of `source`. */
export function engineRead(r: CompactRead, offset: number, source: string, group: string): ProfileRead | null {
  const blocks = r.aligned_blocks ?? [];
  const ivs = r.intervals ?? [];
  const start = blocks.length ? Math.min(...blocks.map(b => b[0])) : ivs.length ? offset + Math.min(...ivs.map(i => i[0])) : NaN;
  const end = blocks.length ? Math.max(...blocks.map(b => b[1])) : ivs.length ? offset + Math.max(...ivs.map(i => i[1])) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  if (source === 'm6a') return { group, start, end, points: (r.methyl_m6a?.length ? r.methyl_m6a : r.methyl ?? []).map(x => offset + x) };
  // Each footprint keeps its whole size (the compact third field; the interval itself is clipped to the window).
  const iv = (i: number[]): [number, number] | [number, number, number] => (i[2] != null && i[2] > 0 ? [offset + i[0], offset + i[1], i[2]] : [offset + i[0], offset + i[1]]);
  const fromLayer = (name: string) => (r.layers?.[name]?.intervals ?? []).filter(i => (i[2] ?? 1) > 0).map(iv);
  let intervals: Array<[number, number] | [number, number, number]>;
  if (source === ALL_FOOTPRINTS) {
    // Nuc + TF, each footprint once; the calls stand in for Nuc when a read has no Nuc layer.
    const nuc = r.layers?.nuc ? fromLayer('nuc') : ivs.filter(i => i[2] > 0).map(iv);
    intervals = [...nuc, ...fromLayer('tf')];
  } else if (source === 'nuc' && !r.layers?.nuc) {
    intervals = ivs.filter(i => i[2] > 0).map(iv);
  } else if (source === 'fire') {
    intervals = [...fromLayer('msp'), ...fromLayer('fire')];
  } else {
    intervals = fromLayer(source);
  }
  return { group, start, end, intervals };
}

export interface EngineReadsRequest {
  source: string;
  region: ProfileRegion & { genome?: string | null };
  /** The panels whose datasets are read (cluster mode: the clustered panels). */
  panels: FootprintSizesTarget['panels'];
  clusters: FootprintSizesClusters | null;
  /** 'cluster' (per cluster, from the app's assignments), 'none' (pooled), 'groups' (read groups / classes) or by dataset. */
  groupBy: 'cluster' | 'none' | 'dataset' | 'groups';
  /** groupBy 'groups': the groups (a read in several groups counts in each). */
  readGroups?: ReadGroupDef[];
  readCap: number;
  sampleSeed: string;
  signal?: AbortSignal;
  /** Also read each read's nucleosomes (the Nuc layer, or the calls) as `occluders` (the BED occlusion filter). */
  occluders?: boolean;
  /** Also read every footprint (Nuc + TF) as `footprints` (conditioning on the state at the anchor). */
  footprints?: boolean;
}

/** Reads of a region per dataset (compact reads, a seeded sample) as engine reads, with the groups in order. */
export async function fetchEngineReads(q: EngineReadsRequest): Promise<{ reads: Array<ProfileRead & { dataset?: string; occluders?: Array<[number, number]>; footprints?: Array<[number, number]> }>; groups: Array<{ id: string; title: string; color?: string }> }> {
  const byCluster = q.groupBy === 'cluster' && !!q.clusters;
  const pooled = q.groupBy === 'none';
  const byGroups = q.groupBy === 'groups';
  const datasets = byGroups
    ? [...new Set((q.readGroups ?? []).flatMap(g => Object.keys(g.members)))].filter(d => q.panels.some(p => p.datasetId === d))
    : [...new Set(q.panels.map(p => p.datasetId))];
  const assignments = useBrowserStore.getState().clusterAssignments;
  // A window may start before 0 (a feature near the contig start keeps all its bins): only the fetch is clamped, and
  // the compact coordinates are relative to the fetch's start.
  const fetchStart = Math.max(0, q.region.start);
  const parts = await Promise.all(datasets.map(ds => {
    const params = new URLSearchParams({
      chrom: q.region.chrom, start: String(fetchStart), end: String(q.region.end), dataset_id: ds, max_reads: String(q.readCap),
      include_layers: 'true', include_layer_qualities: 'false', hide_terminal_gaps: 'false', sample_seed: q.sampleSeed,
    });
    const layers = [...new Set([...sourceLayers(q.source), ...(q.occluders ? ['nuc'] : []), ...(q.footprints ? ['nuc', 'tf'] : [])])];
    if (layers.length) params.set('layer_names', layers.join(','));
    if (q.source === 'm6a') params.set('include_methylation', 'true');
    if (q.region.genome) params.set('panel_genome', q.region.genome);
    return fetchJson<{ reads?: CompactRead[] }>(`/api/reads/compact?${params}`, { signal: q.signal }).then(r => [ds, r.reads ?? []] as const);
  }));
  const reads: Array<ProfileRead & { dataset?: string; occluders?: Array<[number, number]>; footprints?: Array<[number, number]> }> = [];
  const occludersOf = (r: CompactRead): Array<[number, number]> => {
    const off = fetchStart;
    const ivs = r.layers?.nuc?.intervals ?? (r.intervals ?? []).filter(i => i[2] > 0);
    return ivs.filter(i => (i[2] ?? 1) > 0).map(i => [off + i[0], off + i[1]] as [number, number]);
  };
  const footprintsOf = (r: CompactRead): Array<[number, number]> => {
    const all = engineRead(r, fetchStart, ALL_FOOTPRINTS, '');
    return (all?.intervals ?? []).map(([a, b]) => [a, b] as [number, number]);
  };
  const withExtras = <T extends ProfileRead>(er: T, r: CompactRead, ds: string) => ({ ...er, id: r.id, dataset: ds, ...(q.occluders ? { occluders: occludersOf(r) } : {}),
    ...(q.footprints ? { footprints: footprintsOf(r) } : {}) });
  const groups: Array<{ id: string; title: string; color?: string }> = [];
  const seen = new Set<string>();
  const addGroup = (g: { id: string; title: string; color?: string }) => { if (!seen.has(g.id)) { seen.add(g.id); groups.push(g); } };
  if (byGroups) for (const g of q.readGroups ?? []) addGroup({ id: `${g.id}|g`, title: g.title, color: g.color });
  for (const [ds, list] of parts) {
    const dsPanels = q.panels.filter(p => p.datasetId === ds);
    if (byGroups) {
      for (const g of q.readGroups ?? []) {
        const members = g.members[ds];
        if (!members?.size) continue;
        for (const r of list) {
          if (!members.has(r.id)) continue;
          const er = engineRead(r, fetchStart, q.source, `${g.id}|g`);
          if (er) reads.push(withExtras(er, r, ds));
        }
      }
      continue;
    }
    if (byCluster) {
      for (const p of dsPanels) {
        const a = assignments[p.key] ?? {};
        for (const c of q.clusters!.visible) addGroup({ id: `${p.key}|${c.cluster}`, title: `${q.clusters!.panels.length > 1 ? `${p.label} · ` : ''}${getClusterLabel(c.cluster, true)}`, color: c.color });
        for (const r of list) {
          const c = a[r.id];
          if (c == null || !seen.has(`${p.key}|${c}`)) continue;
          const er = engineRead(r, fetchStart, q.source, `${p.key}|${c}`);
          if (er) reads.push(withExtras(er, r, ds));
        }
      }
      continue;
    }
    const p = dsPanels[0];
    const id = pooled ? 'all|all' : `${p.key}|all`;
    addGroup(pooled ? { id, title: 'All datasets', color: '#52514e' } : { id, title: p.datasetLabel ?? p.label, color: p.color });
    for (const r of list) {
      const er = engineRead(r, fetchStart, q.source, id);
      if (er) reads.push(withExtras(er, r, ds));
    }
  }
  return { reads, groups };
}

export function profileRequestKey(plot: PlotSpec, target: FootprintSizesTarget, clusters: FootprintSizesClusters | null, sampleSeed: string, settingsKey: string, groupsSig = '', features: HeatmapFeature[] = []): string {
  return JSON.stringify({
    features: plot.where === 'features' ? [features.map(f => f.id), plot.heatmap.windowBp] : null,
    kind: 'fiberbrowser.profile.v1', source: plot.source, group: plot.groupBy, chrom: target.chrom, start: target.start, end: target.end,
    genome: target.genome, panels: target.panels.map(p => `${p.key}:${p.datasetId}`), bin: plot.profile.binBp, cap: plot.profile.readCap,
    hist: plot.type === 'size-histogram' ? [plot.hist.binBp, plot.hist.sizeMin, plot.hist.sizeMax, plot.hist.normalization, plot.hist.weighting, plot.hist.inclusion] : null,
    clusters: plot.groupBy === 'cluster' && clusters ? clusters.assignmentSignature ?? null : null, groups: groupsSig || null, sampleSeed, settingsKey,
    sampling: plot.sampling.mode === 'random' ? [plot.sampling.n, plot.sampling.seed] : null,
    units: plot.summary.on || null,
    bands: plot.profile.band === 'off' && !plot.profile.conditionOn ? null : [plot.profile.band, plot.profile.bandEdges, plot.profile.conditionOn, plot.profile.conditionBp, plot.profile.conditionNucBp],
  });
}

export function useProfileData(o: {
  plot: PlotSpec; target: FootprintSizesTarget; clusters: FootprintSizesClusters | null; sampleSeed: string; settingsKey: string;
  enabled: boolean; seed?: ProfileEntry | null; delayMs?: number; readGroups?: ReadGroupDef[] | null; groupsSig?: string;
  /** Where = Selected features: the feature windows the profile is pooled over (centred; minus-strand flipped). */
  features?: HeatmapFeature[];
}): { entry: ProfileEntry | null; requestKey: string; loading: boolean; error: string | null } {
  const { plot, target, clusters, sampleSeed, settingsKey, enabled, seed = null, delayMs = 60, readGroups = null, groupsSig = '', features = [] } = o;
  const requestKey = useMemo(() => profileRequestKey(plot, target, clusters, sampleSeed, settingsKey, groupsSig, features),
    [plot, target, clusters, sampleSeed, settingsKey, groupsSig, features]);
  const [entry, setEntry] = useState<ProfileEntry | null>(seed);
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const seq = useRef(0);
  useEffect(() => { if (seed) { setEntry(seed); entryRef.current = seed; } }, [seed]);

  useEffect(() => {
    if (!enabled) return;
    if (entryRef.current?.key === requestKey || (seed && seed.key === requestKey)) { setLoading(false); return; }
    const featureMode = plot.where === 'features' && (plot.type === 'metaprofile' || plot.type === 'size-histogram');
    if (!target.panels.length || (featureMode ? !features.length : target.end <= target.start)) { setLoading(false); return; }
    const mine = ++seq.current;
    const controller = new AbortController();
    const key = requestKey;
    const region: ProfileRegion = { chrom: target.chrom, start: target.start, end: target.end, strand: '+' };
    const binBp = plot.profile.binBp;
    const source = plot.source;
    const byCluster = plot.groupBy === 'cluster' && !!clusters;
    const pooled = plot.groupBy === 'none';
    const panels = byCluster ? clusters!.panels : target.panels;
    const t = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      if (featureMode) {
        // Pooled across feature windows: the engine per region, raw sums added per group (exact).
        const base = { source, panels, clusters: byCluster ? clusters : null, readGroups: readGroups ?? undefined,
          groupBy: (readGroups ? 'groups' : byCluster ? 'cluster' : pooled ? 'none' : 'dataset') as 'groups' | 'cluster' | 'none' | 'dataset', readCap: plot.profile.readCap, sampleSeed, signal: controller.signal,
          footprints: plot.profile.conditionOn };
        Promise.all(features.map(f => fetchEngineReads({ ...base, region: { chrom: f.chrom, start: f.start, end: f.end, genome: f.genome } })
          .then(r => ({ f, ...r }))))
          .then(parts => {
            if (seq.current !== mine || controller.signal.aborted) return;
            const histogram = plot.type === 'size-histogram';
            // The plot's sampling over every window together (a read in two windows is kept or dropped in both).
            const sampled = sampleScope(parts.flatMap(x => x.reads), plot.sampling);
            const keepRead = new Set(sampled.reads);
            parts.forEach(x => { x.reads = x.reads.filter(r => keepRead.has(r)); });
            // Size bands and conditioning (the feature's centre is its anchor).
            let bandGroups = parts.find(x => x.groups.length)?.groups ?? [];
            parts.forEach(x => {
              const t = applyBandsAndCondition(x.reads, x.groups, plot.profile, () => Math.round((x.f.start + x.f.end) / 2));
              x.reads = t.reads;
              if (x.groups.length) bandGroups = t.groups;
            });
            const groups = bandGroups;
            const ids = groups.map(g => g.id);
            const unitsMap = new Map<string, Map<string, { cov: Float64Array; sig: Float64Array }>>();
            if (plot.summary.on) for (const x of parts) addReadUnits(unitsMap, x.reads, r => (histogram
              ? histogramAccumulate([r], { start: x.f.start, end: x.f.end }, plot.hist, [r.group])[0]
              : accumulateProfiles([r], { chrom: x.f.chrom, start: x.f.start, end: x.f.end }, binBp, [r.group])[0]));
            const perRegion = parts.map(x => (histogram
              ? histogramAccumulate(x.reads, { start: x.f.start, end: x.f.end }, plot.hist, ids)
              : accumulateProfiles(x.reads, { chrom: x.f.chrom, start: x.f.start, end: x.f.end }, binBp, ids)));
            const pooledRaw = ids.map((id, gi) => poolProfiles(perRegion.map(r => r[gi]), id));
            setEntry({
              key, binBp: histogram ? plot.hist.binBp : binBp, locus: { chrom: features[0]?.chrom ?? target.chrom, start: features[0]?.start ?? 0, end: features[features.length - 1]?.end ?? 0, genome: features[0]?.genome ?? null },
              groups: groups.map((g, i) => ({ ...g, raw: pooledRaw[i], ...(plot.summary.on ? { units: unitsOf(unitsMap, g.id) } : {}) })).filter(g => g.raw.nReads > 0), sampled: sampled.counts,
            });
          })
          .catch(err => {
            if (controller.signal.aborted || err?.name === 'AbortError' || seq.current !== mine) return;
            setError({ key, message: `Metaprofile could not be computed: ${err instanceof Error ? err.message : String(err)}` });
          })
          .finally(() => { if (seq.current === mine && !controller.signal.aborted) setLoading(false); });
        return;
      }
      fetchEngineReads({
        source, region: { ...region, genome: target.genome }, panels, clusters: byCluster ? clusters : null, readGroups: readGroups ?? undefined,
        groupBy: readGroups ? 'groups' : byCluster ? 'cluster' : pooled ? 'none' : 'dataset', readCap: plot.profile.readCap, sampleSeed, signal: controller.signal,
        footprints: plot.profile.conditionOn,
      })
        .then(({ reads: fetched, groups: groups0 }) => {
          if (seq.current !== mine || controller.signal.aborted) return;
          const sampledScope = sampleScope(fetched, plot.sampling);
          const sampledCounts = sampledScope.counts;
          // Size bands and conditioning (the view's centre is the anchor).
          const { reads, groups } = applyBandsAndCondition(sampledScope.reads, groups0, plot.profile, () => Math.round((target.start + target.end) / 2));
          // A size histogram counts footprint sizes (bins of size); a metaprofile accumulates along position.
          const histogram = plot.type === 'size-histogram';
          const raws = histogram ? histogramRaws(reads, groups, region, plot) : accumulateProfiles(reads, region, binBp, groups.map(g => g.id));
          const unitsMap = new Map<string, Map<string, { cov: Float64Array; sig: Float64Array }>>();
          if (plot.summary.on) addReadUnits(unitsMap, reads, r => (histogram ? histogramAccumulate([r], region, plot.hist, [r.group])[0] : accumulateProfiles([r], region, binBp, [r.group])[0]));
          setEntry({
            key, binBp: histogram ? plot.hist.binBp : binBp, locus: { chrom: target.chrom, start: target.start, end: target.end, genome: target.genome },
            groups: groups.map((g, i) => ({ ...g, raw: raws[i], ...(plot.summary.on ? { units: unitsOf(unitsMap, g.id) } : {}) })).filter(g => g.raw.nReads > 0), sampled: sampledCounts,
          });
        })
        .catch(err => {
          if (controller.signal.aborted || err?.name === 'AbortError' || seq.current !== mine) return;
          setError({ key, message: `Metaprofile could not be computed: ${err instanceof Error ? err.message : String(err)}` });
        })
        .finally(() => { if (seq.current === mine && !controller.signal.aborted) setLoading(false); });
    }, delayMs);
    return () => { controller.abort(); window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, enabled, seed]);

  return { entry, requestKey, loading, error: error && error.key === requestKey ? error.message : null };
}

/** Reads kept by the plot's sampling: all, or the N per dataset with the smallest stable keys (seed, dataset, read
 *  name) over every read in scope (all regions or windows together); counts used / total per dataset. */
export function sampleScope<T extends { id?: string; dataset?: string }>(reads: T[], sampling: SamplingSettings):
  { reads: T[]; counts: Record<string, { used: number; total: number }> } {
  const byDs = new Map<string, Set<string>>();
  for (const r of reads) {
    if (!r.id) continue;
    const ds = r.dataset ?? '';
    if (!byDs.has(ds)) byDs.set(ds, new Set());
    byDs.get(ds)!.add(r.id);
  }
  const counts: Record<string, { used: number; total: number }> = {};
  if (sampling.mode !== 'random') {
    for (const [ds, ids] of byDs) counts[ds] = { used: ids.size, total: ids.size };
    return { reads, counts };
  }
  const keep = new Map<string, Set<string>>();
  for (const [ds, ids] of byDs) {
    const chosen = lowestK([...ids], sampling.n, id => stableKey(sampling.seed, ds, id), id => id);
    keep.set(ds, new Set(chosen));
    counts[ds] = { used: chosen.length, total: ids.size };
  }
  return { reads: reads.filter(r => !r.id || keep.get(r.dataset ?? '')?.has(r.id)), counts };
}

/** "Reads: 2,000 of 3,202 (random, seed 1)" per dataset, joined. */
export function sampleCountsText(counts: Record<string, { used: number; total: number }>, sampling: SamplingSettings, label: (ds: string) => string = ds => ds): string {
  const parts = Object.entries(counts).map(([ds, c]) => `${label(ds)} ${c.used.toLocaleString('en-US')}${c.used < c.total ? ` of ${c.total.toLocaleString('en-US')}` : ''}`);
  return `Reads used: ${parts.join(' · ') || '—'} (${sampling.mode === 'random' ? `random ${sampling.n.toLocaleString('en-US')} per dataset` : 'all in scope'}, seed ${sampling.seed}; ${Object.values(counts).reduce((a, c) => a + c.total - c.used, 0).toLocaleString('en-US')} dropped)`;
}

/** Per-read raw profiles (the summaries' bootstrap units), merged by read name within each group (a read in two feature
 *  windows is one unit). */
export function addReadUnits(into: Map<string, Map<string, { cov: Float64Array; sig: Float64Array }>>, reads: ProfileRead[],
  one: (r: ProfileRead) => RawProfile | undefined): void {
  reads.forEach((r, i) => {
    const raw = one(r);
    if (!raw) return;
    const g = into.get(r.group) ?? new Map();
    into.set(r.group, g);
    // A unit is one dataset's read: independent reads of two datasets that share a name are never paired.
    const id = r.id ? `${r.dataset ?? ''}\u0000${r.id}` : `#${r.start}:${r.end}:${i}`;
    const cur = g.get(id);
    if (!cur) { g.set(id, { cov: Float64Array.from(raw.coverage), sig: Float64Array.from(raw.signal) }); return; }
    for (let k = 0; k < cur.cov.length; k++) { cur.cov[k] += raw.coverage[k]; cur.sig[k] += raw.signal[k]; }
  });
}

export function unitsOf(units: Map<string, Map<string, { cov: Float64Array; sig: Float64Array }>>, group: string): import('./summary').SummaryUnit[] | undefined {
  const g = units.get(group);
  return g ? [...g.entries()].map(([id, v]) => ({ id, cov: v.cov, sig: v.sig })) : undefined;
}
