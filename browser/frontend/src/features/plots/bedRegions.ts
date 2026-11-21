/**
 * BED region sets for Plots (Phase 3): several BEDs as groups, strand-aware anchors (centre / start = TSS / end) with
 * a reference point ± window or scale-regions, subsampling (random N with a seed, equal N per group, a reads-per-
 * region cap, depth matching across datasets) and a nucleosome-occlusion filter on the region centre (per read and
 * per region), with the counts of what was used and excluded. Pure (no React, no store): the plots call it with the
 * reads they fetched per region (fetchEngineReads) and the profile engine does the accumulation.
 */
import { lowestK, stableKey } from '../../utils/stableSample';
import { accumulateProfiles, poolProfiles, type ProfileRead, type RawProfile } from './profileEngine';


/** [chrom, start, end, strand, name] (0-based, half-open). */
export type BedRegion = [string, number, number, '+' | '-' | '.', string];

export interface RegionSet {
  id: string;
  name: string;
  path: string;
  color: string;
  regions: BedRegion[];
  /** Regions in the file (more than `regions` when capped). */
  total: number;
  /** BED columns 5 on of each region, as numbers (null: not a number); parallel to `regions` (sort by score). */
  columns?: Array<Array<number | null>>;
}

export type BedAnchor = 'centre' | 'start' | 'end';
export type BedMode = 'point' | 'scale';
export type BedSubsample = 'all' | 'random' | 'equal';
export type OcclusionRead = 'off' | 'centre' | 'fraction';

export interface BedSettings {
  /** The region sets plotted (each a group), by id. */
  setIds: string[];
  anchor: BedAnchor;
  mode: BedMode;
  /** Reference point: bp either side of the anchor. */
  flankBp: number;
  /** Scale-regions: bins the region body is stretched to, and the flanks either side (bp). */
  bodyBins: number;
  scaleFlankBp: number;
  subsample: BedSubsample;
  /** Random: regions per set. */
  n: number;
  seed: number;
  /** Regions read at most per set (after subsampling). */
  maxRegions: number;
  /** Reads per region and dataset (the server's seeded display sample). */
  readsPerRegion: number;
  /** Downsample each region's reads to the dataset with the fewest there (seeded). */
  depthMatch: boolean;
  /** Per read: drop reads with a nucleosome over the centre, or covering more than readPct of centre ± readWindowBp. */
  occlusionRead: OcclusionRead;
  readPct: number;
  readWindowBp: number;
  /** Per region: keep regions whose centre is covered by a nucleosome in at most regionPct of their reads. */
  occlusionRegion: boolean;
  regionPct: number;
  /** Show the reads the occlusion filter dropped as their own group. */
  showExcluded: boolean;
}

export const DEFAULT_BED_SETTINGS: BedSettings = Object.freeze({
  setIds: [], anchor: 'centre', mode: 'point', flankBp: 1000, bodyBins: 40, scaleFlankBp: 500,
  subsample: 'random', n: 200, seed: 7, maxRegions: 2000, readsPerRegion: 50, depthMatch: false,
  occlusionRead: 'off', readPct: 50, readWindowBp: 50, occlusionRegion: false, regionPct: 50, showExcluded: false,
}) as BedSettings;

const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : d);
const pick = <T extends string>(v: unknown, opts: readonly T[], d: T): T => (opts.includes(v as T) ? v as T : d);

export function normalizeBedSettings(raw: unknown): BedSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_BED_SETTINGS;
  return {
    setIds: Array.isArray(r.setIds) ? r.setIds.filter((x): x is string => typeof x === 'string').slice(0, 20) : [],
    anchor: pick(r.anchor, ['centre', 'start', 'end'] as const, d.anchor),
    mode: pick(r.mode, ['point', 'scale'] as const, d.mode),
    flankBp: clamp(r.flankBp, 10, 100000, d.flankBp),
    bodyBins: clamp(r.bodyBins, 2, 1000, d.bodyBins),
    scaleFlankBp: clamp(r.scaleFlankBp, 0, 100000, d.scaleFlankBp),
    subsample: pick(r.subsample, ['all', 'random', 'equal'] as const, d.subsample),
    n: clamp(r.n, 1, 100000, d.n),
    seed: clamp(r.seed, 0, 2 ** 31 - 2, d.seed),
    maxRegions: clamp(r.maxRegions, 1, 100000, d.maxRegions),
    readsPerRegion: clamp(r.readsPerRegion, 1, 5000, d.readsPerRegion),
    depthMatch: r.depthMatch === true,
    occlusionRead: pick(r.occlusionRead, ['off', 'centre', 'fraction'] as const, d.occlusionRead),
    readPct: clamp(r.readPct, 0, 100, d.readPct),
    readWindowBp: clamp(r.readWindowBp, 1, 10000, d.readWindowBp),
    occlusionRegion: r.occlusionRegion === true,
    regionPct: clamp(r.regionPct, 0, 100, d.regionPct),
    showExcluded: r.showExcluded === true,
  };
}

export function normalizeRegionSet(raw: unknown): RegionSet | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !Array.isArray(r.regions)) return null;
  const regions = (r.regions as unknown[]).filter((x): x is BedRegion => Array.isArray(x) && typeof x[0] === 'string' && Number.isFinite(x[1]) && Number.isFinite(x[2]))
    .map(x => [x[0], Number(x[1]), Number(x[2]), x[3] === '+' || x[3] === '-' ? x[3] : '.', typeof x[4] === 'string' ? x[4] : ''] as BedRegion);
  const columns = Array.isArray(r.columns) && r.columns.length === regions.length
    ? (r.columns as unknown[]).map(row => (Array.isArray(row) ? row.slice(0, 26).map(v => (typeof v === 'number' && Number.isFinite(v) ? v : null)) : []))
    : undefined;
  return { id: r.id, name: typeof r.name === 'string' ? r.name : 'regions', path: typeof r.path === 'string' ? r.path : '',
    color: typeof r.color === 'string' ? r.color : '#52514e', regions, total: Number(r.total) || regions.length, ...(columns ? { columns } : {}) };
}

/** A seeded random generator (mulberry32). */
/** A BED region's identity for sampling keys (as the server's region_identity). */
export const regionIdentity = (r: BedRegion): string => `${r[0]}:${r[1]}-${r[2]}:${r[3] || '.'}:${r[4] || ''}`;

/** The regions read per set: all (to the cap), random N per set, or equal N per set (down to the smallest set), by
 *  the stable sampling rule (utils/stableSample: the smallest keys of (seed, set id, region)), as the server picks. */
export function subsampleSets(sets: RegionSet[], s: BedSettings, seed: number = s.seed): Map<string, BedRegion[]> {
  const out = new Map<string, BedRegion[]>();
  const smallest = Math.min(...sets.map(x => x.regions.length));
  for (const set of sets) {
    const k = Math.min(s.subsample === 'all' ? set.regions.length : s.subsample === 'equal' ? smallest : s.n, s.maxRegions, set.regions.length);
    if (k >= set.regions.length) { out.set(set.id, set.regions.slice()); continue; }
    const idx = lowestK(set.regions.map((_, i) => i), k, i => stableKey(seed, set.id, regionIdentity(set.regions[i])), i => `${regionIdentity(set.regions[i])}#${String(i).padStart(9, '0')}`);
    out.set(set.id, idx.sort((x, y) => x - y).map(i => set.regions[i]));
  }
  return out;
}

/** The region's anchor (strand-aware: start is the 5′ end, the TSS for genes). */
export function anchorOf(r: BedRegion, anchor: BedAnchor): number {
  const [, start, end, strand] = r;
  if (anchor === 'centre') return Math.round((start + end) / 2);
  const fivePrime = strand === '-' ? end : start;
  const threePrime = strand === '-' ? start : end;
  return anchor === 'start' ? fivePrime : threePrime;
}

/** The window a region is read over: anchor ± flank (point), or the body with its flanks (scale). Not clamped at 0: a
 *  region near the contig start keeps every bin (empty before 0) so it pools with the others; only fetches clamp. */
export function readWindow(r: BedRegion, s: BedSettings): { chrom: string; start: number; end: number; centre: number; strand: '+' | '-' } {
  const strand = r[3] === '-' ? '-' : '+';
  if (s.mode === 'scale') {
    return { chrom: r[0], start: r[1] - s.scaleFlankBp, end: r[2] + s.scaleFlankBp, centre: Math.round((r[1] + r[2]) / 2), strand };
  }
  const a = anchorOf(r, s.anchor);
  return { chrom: r[0], start: a - s.flankBp, end: a + s.flankBp, centre: a, strand };
}

/** A read with the occluding (nucleosome) intervals it carries. */
export type OccludableRead = ProfileRead & { occluders?: Array<[number, number]>; /** Every footprint (conditioning on the state at the anchor). */ footprints?: Array<[number, number]> };

/** Covered bp of [a, b) by the intervals (merged). */
function coveredBp(ivs: Array<[number, number]>, a: number, b: number): number {
  const sorted = ivs.map(([x, y]) => [Math.max(x, a), Math.min(y, b)] as [number, number]).filter(([x, y]) => y > x).sort((p, q) => p[0] - q[0]);
  let total = 0, cur = -Infinity, curEnd = -Infinity;
  for (const [x, y] of sorted) {
    if (x > curEnd) { if (curEnd > cur) total += curEnd - cur; cur = x; curEnd = y; } else curEnd = Math.max(curEnd, y);
  }
  if (curEnd > cur) total += curEnd - cur;
  return total;
}

/** Whether the read covers the centre with a nucleosome. */
export const centreOccluded = (r: OccludableRead, centre: number): boolean => (r.occluders ?? []).some(([a, b]) => a <= centre && b > centre);

/** The per-read occlusion filter: true when the read is dropped. Reads not covering the centre are kept. */
export function readOccluded(r: OccludableRead, centre: number, s: Pick<BedSettings, 'occlusionRead' | 'readPct' | 'readWindowBp'>): boolean {
  if (s.occlusionRead === 'off' || r.start > centre || r.end <= centre) return false;
  if (s.occlusionRead === 'centre') return centreOccluded(r, centre);
  const a = centre - s.readWindowBp, b = centre + s.readWindowBp;
  return coveredBp(r.occluders ?? [], a, b) / (b - a) * 100 > s.readPct;
}

/** The share (%) of reads covering the centre whose centre is under a nucleosome (null: no read covers it). */
export function regionOcclusionPct(reads: OccludableRead[], centre: number): number | null {
  const over = reads.filter(r => r.start <= centre && r.end > centre);
  if (!over.length) return null;
  return (over.filter(r => centreOccluded(r, centre)).length / over.length) * 100;
}

/** Depth matching: each dataset's reads downsampled to the fewest any dataset has there, by the stable sampling
 *  rule (the reads with the smallest keys of (seed, dataset, read name); the read's order is kept). */
export function depthMatch<T extends { id?: string; start?: number }>(byDataset: Map<string, T[]>, seed: number): Map<string, T[]> {
  const min = Math.min(...[...byDataset.values()].map(v => v.length));
  const out = new Map<string, T[]>();
  for (const [ds, reads] of byDataset) {
    if (reads.length <= min) { out.set(ds, reads.slice()); continue; }
    const ident = (r: T, i: number) => r.id ?? `#${r.start ?? 0}:${i}`;
    const keyed = reads.map((r, i) => ({ r, i, id: ident(r, i) }));
    const keep = new Set(lowestK(keyed, min, x => stableKey(seed, ds, x.id), x => x.id).map(x => x.i));
    out.set(ds, reads.filter((_, i) => keep.has(i)));
  }
  return out;
}

/** Scale-regions: upstream flank, the body stretched to `bodyBins`, downstream flank (strand-aware), as one profile.
 *  `rawMarkCounts`: marks count 1 each (Count); otherwise each weighs plot bin / segment bin, a density for the
 *  per-bp normalisations. */
export function accumulateScaled(reads: ProfileRead[], r: BedRegion, s: BedSettings, binBp: number, groups: string[], rawMarkCounts = false): RawProfile[] {
  const [chrom, start, end] = r;
  const minus = r[3] === '-';
  const flankBins = s.scaleFlankBp > 0 ? Math.max(1, Math.round(s.scaleFlankBp / binBp)) : 0;
  // Marks weigh plot bin / segment bin, so every bin's marks finish per bp with the plot's bin (marksPerBp).
  const flankBp = s.scaleFlankBp / Math.max(1, flankBins), bodyBp = (end - start) / s.bodyBins;
  const scale = (segBp: number) => (rawMarkCounts ? 1 : binBp / segBp);
  const left = flankBins ? accumulateProfiles(reads, { chrom, start: start - s.scaleFlankBp, end: start }, flankBp, groups, scale(flankBp)) : null;
  const body = accumulateProfiles(reads, { chrom, start, end }, bodyBp, groups, scale(bodyBp));
  const right = flankBins ? accumulateProfiles(reads, { chrom, start: end, end: end + s.scaleFlankBp }, flankBp, groups, scale(flankBp)) : null;
  return groups.map((g, i) => {
    const parts = [left?.[i], body[i], right?.[i]].filter((x): x is RawProfile => !!x);
    const cat = (key: 'coverage' | 'signal') => {
      const arr = Float64Array.from(parts.flatMap(p => Array.from(p[key])));
      return minus ? arr.reverse() : arr;
    };
    return { group: g, nReads: body[i].nReads, coverage: cat('coverage'), signal: cat('signal') };
  });
}

export interface BedCounts {
  set: string;
  regionsTotal: number;
  regionsRead: number;
  regionsUsed: number;
  regionsDroppedOcclusion: number;
  readsUsed: number;
  readsExcluded: number;
}

export interface BedRegionReads {
  set: string;
  region: BedRegion;
  /** dataset id -> its reads over the region's window (with occluders when the filter is on). */
  byDataset: Map<string, OccludableRead[]>;
}

export interface BedResult {
  /** Per group (set × dataset, or set pooled): the raw profile over the anchor window, pooled across regions. */
  pooled: Array<{ id: string; set: string; title: string; color?: string; dash?: number[]; raw: RawProfile; excluded?: boolean }>;
  /** Per region (heatmaps): the region and its raw profile per group (same order as `pooled`). */
  perRegion: Array<{ set: string; region: BedRegion; raws: RawProfile[] }>;
  counts: BedCounts[];
}

/**
 * Filter, match and accumulate reads already fetched per region. Groups: one per set and dataset (`pooledDatasets`:
 * one per set), plus an "excluded" group per set when the occlusion filter drops reads and `showExcluded` is on.
 */
/** Extras of a BED plot: size bands and the state at the anchor (as the view and features), per-read summary units. */
export interface BedProfileExtras {
  /** Split groups and reads by size band and / or the read's state at the region's anchor (the caller passes
   *  sizeBands.applyBandsAndCondition with its settings; groups: (groups) => split groups, reads: (reads, anchor)). */
  bands?: {
    groups: (groups: Array<{ id: string; title: string; color?: string }>) => Array<{ id: string; title: string; color?: string; dash?: number[] }>;
    reads: (reads: ProfileRead[], anchor: number) => ProfileRead[];
  } | null;
  /** Filled with each read's own raw profile per group, merged by read id (the summaries' bootstrap, units = reads). */
  readUnits?: Map<string, Map<string, { cov: Float64Array; sig: Float64Array }>>;
  /** Scale-regions marks as raw counts (the Count normalisation), not rescaled to a per-plot-bin density. */
  rawMarkCounts?: boolean;
}

export function bedProfiles(input: BedRegionReads[], sets: RegionSet[], s: BedSettings, binBp: number,
  datasetLabels: Record<string, string>, pooledDatasets: boolean,
  /** Another accumulation per region over its window (the size histogram); default: the profile along position. */
  accumulate?: (reads: ProfileRead[], window: { start: number; end: number }, ids: string[]) => RawProfile[],
  extras: BedProfileExtras = {}): BedResult {
  const datasets = [...new Set(input.flatMap(x => [...x.byDataset.keys()]))];
  const groups: BedResult['pooled'] = [];
  const multi = datasets.length > 1 && !pooledDatasets;
  for (const set of sets) {
    if (!input.some(x => x.set === set.id)) continue;
    for (const ds of pooledDatasets ? ['*'] : datasets) {
      groups.push({ id: `${set.id}|${ds}`, set: set.id, title: multi ? `${set.name} · ${datasetLabels[ds] ?? ds}` : set.name, color: set.color, raw: null as unknown as RawProfile });
    }
    if (s.showExcluded && s.occlusionRead !== 'off') groups.push({ id: `${set.id}|excluded`, set: set.id, title: `${set.name} · excluded (occluded)`, color: '#9ca3af', raw: null as unknown as RawProfile, excluded: true });
  }
  if (extras.bands) {
    // One group per band (and state), each keeping its set (sizeBands' ids: <group>|b<band>|s:<state>).
    const split = extras.bands.groups(groups.map(g => ({ id: g.id, title: g.title, ...(g.color ? { color: g.color } : {}) })));
    const parentOf = (id: string) => groups.find(g => id === g.id || id.startsWith(`${g.id}|b`) || id.startsWith(`${g.id}|s:`))!;
    groups.splice(0, groups.length, ...split.map(og => { const pg = parentOf(og.id); return { ...pg, id: og.id, title: og.title, ...(og.dash ? { dash: og.dash } : {}) }; }));
  }
  const ids = groups.map(g => g.id);
  const counts = new Map<string, BedCounts>(sets.map(x => [x.id, { set: x.id, regionsTotal: x.total, regionsRead: 0, regionsUsed: 0, regionsDroppedOcclusion: 0, readsUsed: 0, readsExcluded: 0 }]));
  const perRegion: BedResult['perRegion'] = [];
  input.forEach((item, ri) => {
    const c = counts.get(item.set)!;
    c.regionsRead += 1;
    const w = readWindow(item.region, s);
    let byDs = item.byDataset;
    if (s.occlusionRegion) {
      const pct = regionOcclusionPct([...byDs.values()].flat(), w.centre);
      if (pct != null && pct > s.regionPct) { c.regionsDroppedOcclusion += 1; return; }
    }
    const kept: ProfileRead[] = [];
    const excluded: ProfileRead[] = [];
    if (s.depthMatch && byDs.size > 1) byDs = depthMatch(byDs, s.seed);
    for (const [ds, reads] of byDs) {
      for (const r of reads) {
        const group = `${item.set}|${pooledDatasets ? '*' : ds}`;
        if (readOccluded(r, w.centre, s)) { excluded.push({ ...r, group: `${item.set}|excluded`, dataset: ds }); continue; }
        kept.push({ ...r, group, dataset: ds });
      }
    }
    c.regionsUsed += 1;
    c.readsUsed += kept.length;
    c.readsExcluded += excluded.length;
    const both = s.showExcluded ? [...kept, ...excluded] : kept;
    const reads = extras.bands ? extras.bands.reads(both, w.centre) : both;
    const acc = (rs: ProfileRead[], gids: string[]) => (accumulate ? accumulate(rs, { start: s.mode === 'scale' ? item.region[1] : w.start, end: s.mode === 'scale' ? item.region[2] : w.end }, gids) : s.mode === 'scale'
      ? accumulateScaled(rs, item.region, s, binBp, gids, !!extras.rawMarkCounts)
      : accumulateProfiles(rs, { chrom: w.chrom, start: w.start, end: w.end, strand: w.strand }, binBp, gids));
    const raws = acc(reads, ids);
    if (extras.readUnits) {
      reads.forEach((r, k) => {
        const one = acc([r], [r.group])[0];
        if (!one) return;
        const byGroup = extras.readUnits!.get(r.group) ?? new Map();
        extras.readUnits!.set(r.group, byGroup);
        // A unit is one dataset's read (two datasets' reads of one name are independent).
        const id = r.id ? `${r.dataset ?? ''}\u0000${r.id}` : `${ri}#${k}`;
        const cur = byGroup.get(id);
        if (!cur) byGroup.set(id, { cov: Float64Array.from(one.coverage), sig: Float64Array.from(one.signal) });
        else for (let i = 0; i < cur.cov.length; i++) { cur.cov[i] += one.coverage[i]; cur.sig[i] += one.signal[i]; }
      });
    }
    perRegion.push({ set: item.set, region: item.region, raws });
  });
  const pooled = groups.map((g, gi) => ({ ...g, raw: poolProfiles(perRegion.filter(p => p.set === g.set).map(p => p.raws[gi]), g.id) }));
  return { pooled, perRegion, counts: sets.map(x => counts.get(x.id)!).filter(x => x.regionsRead > 0) };
}

/** "promoters.bed: 200 of 12,310 regions (3 dropped by occlusion) · 8,120 reads · 412 excluded". */
export function bedCountsText(counts: BedCounts[], sets: RegionSet[]): string {
  return counts.map(c => {
    const name = sets.find(x => x.id === c.set)?.name ?? c.set;
    const dropped = c.regionsDroppedOcclusion ? ` (${c.regionsDroppedOcclusion} dropped by the region filter)` : '';
    const excl = c.readsExcluded ? ` · ${c.readsExcluded.toLocaleString()} reads excluded by occlusion` : '';
    return `${name}: ${c.regionsUsed.toLocaleString()} of ${c.regionsTotal.toLocaleString()} regions${dropped} · ${c.readsUsed.toLocaleString()} reads${excl}`;
  }).join(' — ');
}
