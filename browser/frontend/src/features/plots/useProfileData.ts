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
import { plotSources } from './plotModel';
import { isFamilySource, loadFamilyMembership, type FamilyMembership } from '../hub/familySources';
import { familyOptionsIn } from './useFamilySources';
import { combineSourceGroups } from './multiSource';
import { useProviderVersion } from './useFamilySources';

export interface ProfileGroup {
  /** Bootstrap units (reads) with their own raw profiles: kept while a summary is on (not stored in the Gallery). */
  units?: import('./summary').SummaryUnit[];
  id: string;
  title: string;
  color?: string;
  /** A dash pattern (datasets within a BED set's colour). */
  dash?: number[];
  raw: RawProfile;
  /** Several sources (multiSource.ts): this line's source and the group it belongs to (absent with one source). */
  source?: string;
  base?: string;
  baseTitle?: string;
}

export interface ProfileEntry {
  key: string;
  /** Reads used / in scope per dataset (the plot's sampling). */
  sampled?: Record<string, { used: number; total: number }>;
  locus: { chrom: string; start: number; end: number; genome: string | null };
  binBp: number;
  groups: ProfileGroup[];
  seeded?: boolean;
  /** Sources asked for that this result could not draw (a family not in this view), with why. */
  missingSources?: Array<{ source: string; reason: string }>;
}

interface CompactLayer { intervals?: number[][] }
interface CompactRead {
  id: string;
  /** A meta-locus read-site observation or a lifted row: the id the clustering and feature states use. */
  analysis_id?: string;
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
  /** Several sources from the same reads (one fetch, the union of their layers): each read once per source, tagged
   *  with `source`. Absent: `source` alone, untagged (as before). */
  sources?: string[];
  /** Family sources' membership (hub/familySources.loadFamilyMembership). */
  families?: Map<string, FamilyMembership>;
}

/** A compact read as an engine read of a family source: the reads scored on the family (any state), with the family's
 *  span as their interval when they are members (the share of scored reads that are members, over the span). */
export function familyEngineRead(r: CompactRead, offset: number, fam: FamilyMembership | undefined, dataset: string, group: string): ProfileRead | null {
  if (!fam) return null;
  const rid = r.analysis_id ?? r.id;
  if (!fam.evaluated[dataset]?.has(rid)) return null;
  const base = engineRead(r, offset, 'm6a', group);
  if (!base) return null;
  const a = Math.max(fam.span[0], base.start), b = Math.min(fam.span[1], base.end);
  return { group, start: base.start, end: base.end, intervals: fam.members[dataset]?.has(rid) && b > a ? [[a, b]] : [] };
}

/** Reads of a region per dataset (compact reads, a seeded sample) as engine reads, with the groups in order. */
export async function fetchEngineReads(q: EngineReadsRequest): Promise<{ reads: Array<ProfileRead & { dataset?: string; source?: string; occluders?: Array<[number, number]>; footprints?: Array<[number, number]> }>; groups: Array<{ id: string; title: string; color?: string }> }> {
  const byCluster = q.groupBy === 'cluster' && !!q.clusters;
  const pooled = q.groupBy === 'none';
  const byGroups = q.groupBy === 'groups';
  const datasets = byGroups
    ? [...new Set((q.readGroups ?? []).flatMap(g => Object.keys(g.members)))].filter(d => q.panels.some(p => p.datasetId === d))
    : [...new Set(q.panels.map(p => p.datasetId))];
  const assignments = useBrowserStore.getState().clusterAssignments;
  const srcs = q.sources?.length ? q.sources : [q.source];
  // A window may start before 0 (a feature near the contig start keeps all its bins): only the fetch is clamped, and
  // the compact coordinates are relative to the fetch's start.
  const fetchStart = Math.max(0, q.region.start);
  const parts = await Promise.all(datasets.map(ds => {
    const params = new URLSearchParams({
      chrom: q.region.chrom, start: String(fetchStart), end: String(q.region.end), dataset_id: ds, max_reads: String(q.readCap),
      include_layers: 'true', include_layer_qualities: 'false', hide_terminal_gaps: 'false', sample_seed: q.sampleSeed,
    });
    const layers = [...new Set([...srcs.filter(x => !isFamilySource(x)).flatMap(sourceLayers), ...(q.occluders ? ['nuc'] : []), ...(q.footprints ? ['nuc', 'tf'] : [])])];
    if (layers.length) params.set('layer_names', layers.join(','));
    if (srcs.includes('m6a')) params.set('include_methylation', 'true');
    if (q.region.genome) params.set('panel_genome', q.region.genome);
    return fetchJson<{ reads?: CompactRead[] }>(`/api/reads/compact?${params}`, { signal: q.signal }).then(r => [ds, r.reads ?? []] as const);
  }));
  const reads: Array<ProfileRead & { dataset?: string; source?: string; occluders?: Array<[number, number]>; footprints?: Array<[number, number]> }> = [];
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
  // Each read once per source (tagged when several are asked for), from the same compact read.
  const emit = (r: CompactRead, ds: string, group: string) => {
    for (const src of srcs) {
      const er = isFamilySource(src) ? familyEngineRead(r, fetchStart, q.families?.get(src), ds, group) : engineRead(r, fetchStart, src, group);
      if (er) reads.push({ ...withExtras(er, r, ds), ...(q.sources ? { source: src } : {}) });
    }
  };
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
          emit(r, ds, `${g.id}|g`);
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
          emit(r, ds, `${p.key}|${c}`);
        }
      }
      continue;
    }
    const p = dsPanels[0];
    const id = pooled ? 'all|all' : `${p.key}|all`;
    addGroup(pooled ? { id, title: 'All datasets', color: '#52514e' } : { id, title: p.datasetLabel ?? p.label, color: p.color });
    for (const r of list) emit(r, ds, id);
  }
  return { reads, groups };
}

export function profileRequestKey(plot: PlotSpec, target: FootprintSizesTarget, clusters: FootprintSizesClusters | null, sampleSeed: string, settingsKey: string, groupsSig = '', features: HeatmapFeature[] = [], familiesSig = ''): string {
  return JSON.stringify({
    features: plot.where === 'features' ? [features.map(f => f.id), plot.heatmap.windowBp] : null,
    kind: 'fiberbrowser.profile.v1', source: plot.source, group: plot.groupBy, chrom: target.chrom, start: target.start, end: target.end,
    genome: target.genome, panels: target.panels.map(p => `${p.key}:${p.datasetId}`), bin: plot.profile.binBp, cap: plot.profile.readCap,
    hist: plot.type === 'size-histogram' ? [plot.hist.binBp, plot.hist.sizeMin, plot.hist.sizeMax, plot.hist.normalization, plot.hist.weighting, plot.hist.inclusion] : null,
    clusters: plot.groupBy === 'cluster' && clusters ? clusters.assignmentSignature ?? null : null, groups: groupsSig || null, sampleSeed, settingsKey,
    sampling: plot.sampling.mode === 'random' ? [plot.sampling.n, plot.sampling.seed] : null,
    units: plot.summary.on || null,
    bands: plot.profile.band === 'off' && !plot.profile.conditionOn ? null : [plot.profile.band, plot.profile.bandEdges, plot.profile.conditionOn, plot.profile.conditionBp, plot.profile.conditionNucBp],
    // Several sources, or a family (one source keeps the key it always had: stored cards and sessions seed).
    ...(multiSourceKey(plot) ? { sources: plotSources(plot), families: familiesSig || null } : {}),
  });
}

/** Whether a plot's sources take the multi-source path (several, or a family). */
export const multiSourceKey = (plot: PlotSpec): boolean => { const s = plotSources(plot); return s.length > 1 || s.some(isFamilySource); };

export function useProfileData(o: {
  plot: PlotSpec; target: FootprintSizesTarget; clusters: FootprintSizesClusters | null; sampleSeed: string; settingsKey: string;
  enabled: boolean; seed?: ProfileEntry | null; delayMs?: number; readGroups?: ReadGroupDef[] | null; groupsSig?: string;
  /** Where = Selected features: the feature windows the profile is pooled over (centred; minus-strand flipped). */
  features?: HeatmapFeature[];
}): { entry: ProfileEntry | null; requestKey: string; loading: boolean; error: string | null } {
  const { plot, target, clusters, sampleSeed, settingsKey, enabled, seed = null, delayMs = 60, readGroups = null, groupsSig = '', features = [] } = o;
  // Family sources: the hits in this view (recomputed when the hub's providers change) and which are here.
  const providerVersion = useProviderVersion();
  const famSources = useMemo(() => plotSources(plot).filter(isFamilySource), [plot]);
  const famHits = useMemo(() => {
    if (!famSources.length) return null;
    const all = familyOptionsIn({ chrom: target.chrom, start: target.start, end: target.end }).flatMap(k => k.options);
    return famSources.map(id => ({ id, hit: all.find(o => o.id === id)?.hit ?? null }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [famSources, target.chrom, target.start, target.end, providerVersion]);
  const familiesSig = famHits ? famHits.map(f => `${f.id}:${f.hit ? 'y' : 'n'}`).join(',') : '';
  const requestKey = useMemo(() => profileRequestKey(plot, target, clusters, sampleSeed, settingsKey, groupsSig, features, familiesSig),
    [plot, target, clusters, sampleSeed, settingsKey, groupsSig, features, familiesSig]);
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
    // Several sources (or a family): one fetch, each source accumulated on its own, groups combined (multiSource.ts).
    const allSources = plotSources(plot);
    const multi = multiSourceKey(plot);
    const missing = (famHits ?? []).filter(f => !f.hit || featureMode).map(f => ({ source: f.id, reason: featureMode ? 'a family is one locus: not pooled over feature windows' : 'not in this view' }));
    const drawSources = allSources.filter(src => !missing.some(m => m.source === src));
    const famLoad: Promise<Map<string, FamilyMembership> | undefined> = multi && famHits && !featureMode
      ? loadFamilyMembership(famHits.flatMap(f => (f.hit ? [f.hit] : []))) : Promise.resolve(undefined);
    const srcOpt = multi ? { sources: drawSources.length ? drawSources : [allSources[0]] } : {};
    /** Per source (or once, untagged): `fn` on that source's reads, then the groups combined base × source. */
    const bySource = <R extends { source?: string }>(rs: R[], fn: (rs: R[]) => ProfileGroup[]): ProfileGroup[] => (multi
      ? combineSourceGroups(srcOpt.sources!.map(src => ({ source: src, groups: fn(rs.filter(r => r.source === src)) })), plot.sourceLabels)
      : fn(rs));
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
          footprints: plot.profile.conditionOn, ...(multi ? { sources: srcOpt.sources!.filter(x => !isFamilySource(x)).length ? srcOpt.sources!.filter(x => !isFamilySource(x)) : [allSources[0]] } : {}) };
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
            const featureSources = multi ? (base as { sources?: string[] }).sources! : [null];
            const perSource = featureSources.map(src => {
              const partsS = src == null ? parts : parts.map(x => ({ ...x, reads: x.reads.filter(r => (r as { source?: string }).source === src) }));
              const unitsMap = new Map<string, Map<string, { cov: Float64Array; sig: Float64Array }>>();
              if (plot.summary.on) for (const x of partsS) addReadUnits(unitsMap, x.reads, r => (histogram
                ? histogramAccumulate([r], { start: x.f.start, end: x.f.end }, plot.hist, [r.group])[0]
                : accumulateProfiles([r], { chrom: x.f.chrom, start: x.f.start, end: x.f.end }, binBp, [r.group])[0]));
              const perRegion = partsS.map(x => (histogram
                ? histogramAccumulate(x.reads, { start: x.f.start, end: x.f.end }, plot.hist, ids)
                : accumulateProfiles(x.reads, { chrom: x.f.chrom, start: x.f.start, end: x.f.end }, binBp, ids)));
              const pooledRaw = ids.map((id, gi) => poolProfiles(perRegion.map(r => r[gi]), id));
              return { source: src ?? '', groups: groups.map((g, i) => ({ ...g, raw: pooledRaw[i], ...(plot.summary.on ? { units: unitsOf(unitsMap, g.id) } : {}) })).filter(g => g.raw.nReads > 0) };
            });
            setEntry({
              key, binBp: histogram ? plot.hist.binBp : binBp, locus: { chrom: features[0]?.chrom ?? target.chrom, start: features[0]?.start ?? 0, end: features[features.length - 1]?.end ?? 0, genome: features[0]?.genome ?? null },
              groups: multi ? combineSourceGroups(perSource, plot.sourceLabels) : perSource[0].groups, sampled: sampled.counts,
              ...(missing.length ? { missingSources: missing } : {}),
            });
          })
          .catch(err => {
            if (controller.signal.aborted || err?.name === 'AbortError' || seq.current !== mine) return;
            setError({ key, message: `Metaprofile could not be computed: ${err instanceof Error ? err.message : String(err)}` });
          })
          .finally(() => { if (seq.current === mine && !controller.signal.aborted) setLoading(false); });
        return;
      }
      famLoad.then(families => fetchEngineReads({
        source, region: { ...region, genome: target.genome }, panels, clusters: byCluster ? clusters : null, readGroups: readGroups ?? undefined,
        groupBy: readGroups ? 'groups' : byCluster ? 'cluster' : pooled ? 'none' : 'dataset', readCap: plot.profile.readCap, sampleSeed, signal: controller.signal,
        footprints: plot.profile.conditionOn, ...srcOpt, ...(families ? { families } : {}),
      }))
        .then(({ reads: fetched, groups: groups0 }) => {
          if (seq.current !== mine || controller.signal.aborted) return;
          const sampledScope = sampleScope(fetched, plot.sampling);
          const sampledCounts = sampledScope.counts;
          // A size histogram counts footprint sizes (bins of size); a metaprofile accumulates along position.
          const histogram = plot.type === 'size-histogram';
          const groupsOut = bySource(sampledScope.reads, rs => {
            // Size bands and conditioning (the view's centre is the anchor).
            const { reads, groups } = applyBandsAndCondition(rs, groups0, plot.profile, () => Math.round((target.start + target.end) / 2));
            const raws = histogram ? histogramRaws(reads, groups, region, plot) : accumulateProfiles(reads, region, binBp, groups.map(g => g.id));
            const unitsMap = new Map<string, Map<string, { cov: Float64Array; sig: Float64Array }>>();
            if (plot.summary.on) addReadUnits(unitsMap, reads, r => (histogram ? histogramAccumulate([r], region, plot.hist, [r.group])[0] : accumulateProfiles([r], region, binBp, [r.group])[0]));
            return groups.map((g, i) => ({ ...g, raw: raws[i], ...(plot.summary.on ? { units: unitsOf(unitsMap, g.id) } : {}) })).filter(g => g.raw.nReads > 0);
          });
          setEntry({
            key, binBp: histogram ? plot.hist.binBp : binBp, locus: { chrom: target.chrom, start: target.start, end: target.end, genome: target.genome },
            groups: groupsOut, sampled: sampledCounts, ...(missing.length ? { missingSources: missing } : {}),
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
