/**
 * Where = BED region sets: the reads of every (subsampled) region per dataset, then the occlusion filter, depth
 * matching and accumulation (bedRegions.ts) into a metaprofile per set (× dataset) and a row per region (heatmaps).
 * One request to /api/plots/region_reads reads every chosen region (the server subsamples, caps and samples reads per
 * region; a cancelled request stops it). The fetch is keyed only by what changes the reads (sets, subsampling,
 * windows, reads per region, source, datasets); the filter thresholds, depth matching, the excluded group and the bins
 * re-run locally without a new request.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FootprintSizesTarget } from '../../components/controls/cluster-detail/useFootprintSizeData';
import { bedCountsText, bedProfiles, regionIdentity, type BedCounts, type BedRegion, type BedRegionReads, type OccludableRead, type RegionSet } from './bedRegions';
import { fetchJson } from '../../api/sharedFetch';
import { seedMatchKey } from '../../components/controls/cluster-detail/useFootprintSizeData';
import { SERIES_DASHES } from '../../components/charts/ProfileLinesChart';
import type { HeatmapEntry } from './heatmapData';
import type { ProfileEntry } from './useProfileData';
import type { PlotSpec } from './plotModel';
import { histogramAccumulate } from './sizeHistogram';
import { sampleScope } from './useProfileData';
import { applyBandsAndCondition } from './sizeBands';
import type { ProfileRead } from './profileEngine';
import type { SummaryUnit } from './summary';

export interface BedEntry {
  key: string;
  /** The key without the refresh counter (a Gallery card answers it after a restore). */
  stableKey: string;
  counts: BedCounts[];
  countsText: string;
  /** Reads used / in scope per dataset (the plot's sampling). */
  sampled?: Record<string, { used: number; total: number }>;
  profile: ProfileEntry;
  heatmap: HeatmapEntry;
  seeded?: boolean;
}

// The fifth entry: nucleosome intervals, or the count k when they are the first k source numbers; then the read name,
// every footprint (or null) and, for size histograms (whole_footprints), the source intervals' sizes: the source
// intervals are then whole (not clipped to the window), except those listed by index last: the fetch may have cut them
// (a footprint across a large deletion can reach past the margin), so their bounds are not whole.
export type RegionReadRow = [number, number, number[], number[], number[] | number, string?, (number[] | null)?, number[]?, number[]?];

const pairs = (flat: number[]): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
};

/** The server's answer as the per-region reads bedProfiles takes. */
export function regionReadsFromServer(sets: RegionSet[], regions: Array<{ set: string; index: number; offset?: number; reads: Record<string, RegionReadRow[]> }>): BedRegionReads[] {
  const byId = new Map(sets.map(x => [x.id, x]));
  return regions.flatMap(r => {
    const set = byId.get(r.set);
    const region = set?.regions[r.index];
    if (!set || !region) return [];
    const byDataset = new Map<string, OccludableRead[]>();
    const o = r.offset ?? 0;
    const add = (xs: number[]) => (o ? xs.map(x => x + o) : xs);
    for (const [ds, rows] of Object.entries(r.reads)) {
      byDataset.set(ds, rows.map(([start, end, src, marks, nuc, name, fps, sizes, cut]) => ({ group: '', ...(name ? { id: name } : {}), start: start + o, end: end + o,
        // Whole footprints with their sizes (size histograms; a fourth 1: cut by the fetch, not whole), or intervals
        // clipped to the window.
        ...(Array.isArray(sizes)
          ? { intervals: pairs(add(src)).map(([a, b], i) => (Array.isArray(cut) && cut.includes(i)
            ? [a, b, sizes[i], 1] as [number, number, number, number] : [a, b, sizes[i]] as [number, number, number])), whole: true }
          : { intervals: pairs(add(src)) }),
        ...(marks.length ? { points: add(marks) } : {}), occluders: pairs(add(typeof nuc === 'number' ? src.slice(0, nuc) : nuc)),
        // Every footprint (conditioning on the state at the anchor), when asked for.
        ...(Array.isArray(fps) ? { footprints: pairs(add(fps)) } : {}) })));
    }
    return [{ set: set.id, region, byDataset }];
  });
}

/** Size histograms read whole footprints: the block margin that keeps every footprint in the size range uncut (twice
 *  the largest size: a footprint's reference span can exceed its size by deletions). */
export const histogramPadBp = (plot: PlotSpec): number => 2 * plot.hist.sizeMax;

export function bedFetchKey(plot: PlotSpec, sets: RegionSet[], target: FootprintSizesTarget, sampleSeed: string, settingsKey: string): string {
  const b = plot.bed;
  return JSON.stringify({
    kind: 'fiberbrowser.bed.v1', sets: sets.map(s => [s.id, s.path, s.regions.length]), subsample: [b.subsample, b.n, plot.sampling.seed, b.maxRegions],
    window: [b.mode, b.anchor, b.flankBp, b.scaleFlankBp], reads: b.readsPerRegion, occluders: b.occlusionRead !== 'off' || b.occlusionRegion, footprints: plot.profile.conditionOn || undefined,
    source: plot.source, datasets: [...new Set(target.panels.map(p => p.datasetId))], sampleSeed, settingsKey,
    whole: plot.type === 'size-histogram' ? histogramPadBp(plot) : undefined,
  });
}

/** x axis of a BED plot: relative to the anchor (point), or flank · body · flank (scale). */
export function bedAxis(plot: PlotSpec): { start: number; binBp: number; ticks?: [string, string, string]; label: string } {
  const b = plot.bed;
  if (b.mode === 'scale') {
    return { start: -b.scaleFlankBp, binBp: plot.profile.binBp, ticks: [`−${b.scaleFlankBp.toLocaleString()} bp`, `region start → end (${b.bodyBins} bins)`, `+${b.scaleFlankBp.toLocaleString()} bp`],
      label: 'Scale-regions: flanks in bp, the region body stretched' };
  }
  const anchor = b.anchor === 'centre' ? 'centre' : b.anchor === 'start' ? 'start (TSS, strand-aware)' : 'end (strand-aware)';
  return { start: -b.flankBp, binBp: plot.profile.binBp, label: `bp from the region ${anchor} (${plot.profile.binBp} bp bins)` };
}

/** Regions per region_reads request: a large set is read in chunks so progress advances and Cancel stops it. */
export const BED_CHUNK_REGIONS = 250;

export interface BedProgress { done: number; total: number | null; startedAt: number }

type RegionsAnswer = { success: boolean; cancelled?: boolean; jobs_total?: number; regions: Array<{ set: string; index: number; offset?: number; reads: Record<string, RegionReadRow[]> }> };

/** Read every chosen region in chunks (job_offset / job_limit), reporting regions done of the total after each. */
export async function readRegionChunks(fetchChunk: (offset: number, limit: number) => Promise<RegionsAnswer>, chunk: number,
  onProgress: (done: number, total: number) => void, signal?: AbortSignal): Promise<RegionsAnswer['regions'] | null> {
  const out: RegionsAnswer['regions'] = [];
  let total: number | null = null;
  for (let offset = 0; total == null || offset < total; offset += chunk) {
    if (signal?.aborted) return null;
    const r = await fetchChunk(offset, chunk);
    if (!r.success) return null;
    total = r.jobs_total ?? r.regions.length;
    out.push(...r.regions);
    onProgress(Math.min(total, offset + r.regions.length), total);
    if (!r.regions.length) break;
  }
  return out;
}

export function useBedData(o: {
  plot: PlotSpec; sets: RegionSet[]; target: FootprintSizesTarget; sampleSeed: string; settingsKey: string; enabled: boolean;
  datasetLabels: Record<string, string>; seed?: BedEntry | null;
}): { entry: BedEntry | null; requestKey: string; loading: boolean; error: string | null; progress: BedProgress | null; cancelled: boolean; cancel: () => void; retry: () => void } {
  const { plot, sets, target, sampleSeed, settingsKey, enabled, datasetLabels, seed = null } = o;
  const fetchKey = useMemo(() => bedFetchKey(plot, sets, target, sampleSeed, settingsKey), [plot, sets, target, sampleSeed, settingsKey]);
  const b = plot.bed;
  // Scale-regions marks under Count are raw counts; the per-bp normalisations take them as a density.
  const rawMarkCounts = plot.profile.normalization === 'count';
  const derivedKey = JSON.stringify([plot.profile.band !== 'off' ? ['band', plot.profile.band, plot.profile.bandEdges] : null,
    plot.profile.conditionOn ? ['cond', plot.profile.conditionBp, plot.profile.conditionNucBp] : null, plot.summary.on ? ['units', plot.summary.unit] : null, plot.sampling.mode === 'random' ? ['sample', plot.sampling.n, plot.sampling.seed] : null, b.occlusionRead, b.readPct, b.readWindowBp, b.occlusionRegion, b.regionPct, b.showExcluded, b.depthMatch, b.bodyBins, plot.profile.binBp, plot.groupBy,
    b.mode === 'scale' && rawMarkCounts ? 'raw-marks' : null,
    plot.type === 'size-histogram' ? ['hist', plot.hist.binBp, plot.hist.sizeMin, plot.hist.sizeMax, plot.hist.normalization, plot.hist.weighting, plot.hist.inclusion] : null]);
  const requestKey = `${fetchKey}|${derivedKey}`;
  const stableKey = `${seedMatchKey(fetchKey)}|${derivedKey}`;
  const seedFits = !!seed && seed.stableKey === stableKey;
  const [fetched, setFetched] = useState<{ key: string; input: BedRegionReads[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<BedProgress | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [cancelledKey, setCancelledKey] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  // Cancel: abort the request in flight (the server stops when the client goes away) and read no more chunks.
  const cancel = useCallback(() => {
    if (!controllerRef.current) return;
    controllerRef.current.abort();
    controllerRef.current = null;
    seq.current += 1;
    setCancelledKey(fetchKey);
    setLoading(false);
  }, [fetchKey]);
  const retry = useCallback(() => { setCancelledKey(null); setAttempt(n => n + 1); }, []);

  useEffect(() => {
    if (!enabled || seedFits) return;
    if (fetched?.key === fetchKey) return;
    if (!sets.length || !target.panels.length) { setLoading(false); return; }
    if (cancelledKey === fetchKey) return;
    const mine = ++seq.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(null);
    setProgress({ done: 0, total: null, startedAt: Date.now() });
    const b2 = plot.bed;
    const body = {
      sets: sets.map(x => ({ id: x.id, regions: x.regions })), dataset_ids: [...new Set(target.panels.map(p => p.datasetId))], source: plot.source,
      anchor: b2.anchor, mode: b2.mode, flank_bp: b2.flankBp, scale_flank_bp: b2.scaleFlankBp, subsample: b2.subsample, n: b2.n, seed: plot.sampling.seed,
      max_regions: b2.maxRegions, reads_per_region: b2.readsPerRegion, occluders: b2.occlusionRead !== 'off' || b2.occlusionRegion, footprints: plot.profile.conditionOn, sample_seed: sampleSeed,
      ...(plot.type === 'size-histogram' ? { whole_footprints: true, footprint_pad_bp: histogramPadBp(plot) } : {}),
    };
    readRegionChunks(
      (offset, limit) => fetchJson<RegionsAnswer>('/api/plots/region_reads', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ ...body, job_offset: offset, job_limit: limit }),
      }),
      BED_CHUNK_REGIONS,
      (done, total) => { if (seq.current === mine) setProgress(p => ({ done, total, startedAt: p?.startedAt ?? Date.now() })); },
      controller.signal,
    )
      .then(regions => { if (seq.current === mine && !controller.signal.aborted && regions) setFetched({ key: fetchKey, input: regionReadsFromServer(sets, regions) }); })
      .catch(err => {
        if (controller.signal.aborted || err?.name === 'AbortError' || seq.current !== mine) return;
        setError({ key: requestKey, message: `BED regions could not be read: ${err instanceof Error ? err.message : String(err)}` });
      })
      .finally(() => {
        if (seq.current === mine && !controller.signal.aborted) { setLoading(false); setProgress(null); }
        if (controllerRef.current === controller) controllerRef.current = null;
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchKey, enabled, seed, attempt, cancelledKey]);

  const entry = useMemo<BedEntry | null>(() => {
    if (seedFits) return { ...seed!, key: requestKey, profile: { ...seed!.profile, key: requestKey }, heatmap: { ...seed!.heatmap, key: requestKey } };
    if (!fetched || fetched.key !== fetchKey) return null;
    const axis = bedAxis(plot);
    const pooledDatasets = plot.groupBy === 'none';
    const histogram = plot.type === 'size-histogram';
    // The plot's read sampling over every region together (a read in two regions is kept or dropped in both).
    const flat = fetched.input.flatMap(item => [...item.byDataset.entries()].flatMap(([ds, rs]) => rs.map(r => ({ r, id: r.id, dataset: ds }))));
    const sampled = sampleScope(flat, plot.sampling);
    const keep = new Set(sampled.reads.map(x => x.r));
    const sampledInput = plot.sampling.mode === 'random'
      ? fetched.input.map(item => ({ ...item, byDataset: new Map([...item.byDataset.entries()].map(([ds, rs]) => [ds, rs.filter(r => keep.has(r))])) }))
      : fetched.input;
    // Size bands (one band, or a line per band) and the state at each region's anchor, as for the view and features.
    const p = plot.profile;
    const bands = p.band !== 'off' || p.conditionOn ? {
      groups: (gs: Array<{ id: string; title: string; color?: string }>) => applyBandsAndCondition([], gs, p, () => null).groups,
      reads: (rs: ProfileRead[], anchor: number) => applyBandsAndCondition(rs, [], p, () => anchor).reads,
    } : null;
    // The summaries' bootstrap over reads (BED's option; regions are the default units).
    const readUnits = plot.summary.on && plot.summary.unit === 'reads' ? new Map<string, Map<string, { cov: Float64Array; sig: Float64Array }>>() : undefined;
    const res = bedProfiles(sampledInput, sets, { ...plot.bed, seed: plot.sampling.seed }, plot.profile.binBp, datasetLabels, pooledDatasets,
      histogram ? (reads, win, ids) => histogramAccumulate(reads, win, plot.hist, ids) : undefined, { bands, readUnits, rawMarkCounts });
    // Bootstrap units per group: the regions (each region's own raw profile) or the reads.
    const unitsOf = (gi: number, id: string, set: string): SummaryUnit[] | undefined => {
      if (!plot.summary.on) return undefined;
      if (readUnits) return [...(readUnits.get(id)?.entries() ?? [])].map(([rid, v]) => ({ id: rid, cov: v.cov, sig: v.sig }));
      // A unit is the genomic region: the same region in two BED sets is one unit, so a comparison pairs it.
      return res.perRegion.filter(r => r.set === set && r.raws[gi]?.nReads > 0).map(r => ({ id: regionIdentity(r.region), cov: r.raws[gi].coverage, sig: r.raws[gi].signal }));
    };
    // Datasets within a set's colour: one dash pattern each (the excluded group dotted), told apart in print.
    const dsOrder = [...new Set(res.pooled.map(g => g.id.slice(g.id.indexOf('|') + 1)).filter(d => d !== 'excluded' && d !== '*'))];
    const dashOf = (id: string) => {
      const ds = id.slice(id.indexOf('|') + 1);
      return ds === 'excluded' ? [1, 3] : SERIES_DASHES[Math.max(0, dsOrder.indexOf(ds)) % SERIES_DASHES.length];
    };
    // BED order and columns: each region's line in its set.
    const lineOf = new Map(sets.map(x => [x.id, new Map(x.regions.map((r, i) => [regionIdentity(r), i]))]));
    const bedIndexOf = (set: string, r: BedRegion) => lineOf.get(set)?.get(regionIdentity(r)) ?? 0;
    const first = fetched.input[0]?.region;
    const locus = { chrom: first?.[0] ?? '', start: first?.[1] ?? 0, end: first?.[2] ?? 0, genome: null };
    return {
      key: requestKey, stableKey, counts: res.counts, countsText: bedCountsText(res.counts, sets), sampled: sampled.counts,
      profile: { key: requestKey, locus, binBp: histogram ? plot.hist.binBp : axis.binBp, groups: res.pooled.map((g, gi) => ({ g, gi })).filter(({ g }) => g.raw.nReads > 0).map(({ g, gi }) => ({ id: g.id, title: g.title, color: g.color, raw: g.raw, dash: g.dash ?? dashOf(g.id), ...(plot.summary.on ? { units: unitsOf(gi, g.id, g.set) } : {}) })) },
      heatmap: {
        key: requestKey, locus, mode: 'features', binBp: axis.binBp, start: axis.start,
        groups: res.pooled.map(g => ({ id: g.id, title: g.title, color: g.color, set: g.set })),
        features: res.perRegion.map(p => {
          const idx = bedIndexOf(p.set, p.region);
          return {
            feature: { id: `${p.set}:${regionIdentity(p.region)}`, label: p.region[4] || `${p.region[0]}:${(p.region[1] + 1).toLocaleString('en-US')}`, chrom: p.region[0], start: p.region[1], end: p.region[2], genome: null, set: p.set,
              bedIndex: idx, strand: p.region[3], region: [p.region[1], p.region[2]] as [number, number], columns: sets.find(x => x.id === p.set)?.columns?.[idx] ?? undefined },
            raws: p.raws,
          };
        }),
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetched, fetchKey, requestKey, stableKey, seedFits, sets, datasetLabels, seed]);

  return { entry, requestKey, loading, error: error && error.key === requestKey ? error.message : null, progress, cancelled: cancelledKey === fetchKey, cancel, retry };
}
