/**
 * Shared rule-matching logic for colormap rules.
 * Extracted from ReadTrackCanvas.ts to be reusable across components
 * (canvas rendering, metaprofile computation, enrichment analysis).
 */
import type { ColorRule, Gene, FirePeak, QualityGate } from '../types';
import type { OrthogonalTrack, OrthogonalTrackViewportData } from '../types/dataset';
import { getRuleColorForSize } from './ruleColors';
import { sameChrom } from './chromAliases';

/** Rules on one track can use different percentiles: each gets its own threshold. */
export const trackThresholdKey = (trackId: string, percentile: number) => `${trackId}@${percentile}`;

export interface RuleMatchContext {
  chrom?: string;
  viewportStart: number;
  geneRegions: [number, number][];
  geneRegionsByKey: Map<string, [number, number][]>;
  peakRegionsByMinLayer: Map<number, [number, number][]>;
  motifRegions: [number, number][];
  orthogonalTracks: OrthogonalTrack[];
  orthogonalByIndex: Map<number, OrthogonalTrack>;
  trackAnnotationRegions: Map<string, [number, number][]>;
  /** Signal threshold per track and percentile (`trackThresholdKey`). */
  trackThresholds: Map<string, number>;
  regionWidth: number;
  matchCache?: Map<string, boolean>;
}

/** User-facing FIRE rules target the internal `msp` layer in older files. */
export function ruleTargetsLayer(rule: ColorRule, layerName?: string): boolean {
  const targets = rule.targetLayers ?? [];
  if (targets.length === 0 || !layerName) return true;
  if (targets.includes(layerName)) return true;
  return (layerName === 'msp' && targets.includes('fire'))
    || (layerName === 'fire' && targets.includes('msp'));
}

/**
 * Sort intervals by start and coalesce overlapping/touching ranges.
 * `overlapsAny` binary-searches assuming non-overlapping regions, so any
 * region list it consumes (genes, peaks, track annotations) must be merged
 * first — otherwise a position covered only by an earlier-starting wider
 * region is missed.
 */
export function mergeIntervals(regions: [number, number][]): [number, number][] {
  if (regions.length <= 1) return regions.slice();
  const sorted = [...regions].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [sorted[0].slice() as [number, number]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const [s, e] = sorted[i];
    if (s <= last[1]) {
      if (e > last[1]) last[1] = e;
    } else {
      merged.push([s, e]);
    }
  }
  return merged;
}

/** Binary search-based overlap check for sorted, non-overlapping regions. */
export function overlapsAny(pos: number, sortedRegions: [number, number][]): boolean {
  if (sortedRegions.length === 0) return false;
  let lo = 0, hi = sortedRegions.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedRegions[mid][0] <= pos) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && sortedRegions[lo - 1][1] > pos) return true;
  if (lo < sortedRegions.length && sortedRegions[lo][0] <= pos && sortedRegions[lo][1] > pos) return true;
  return false;
}

const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;
function getObjectCacheId(value: object): number {
  let id = objectIds.get(value);
  if (id === undefined) {
    id = nextObjectId++;
    objectIds.set(value, id);
  }
  return id;
}

const RULE_CONTEXT_CACHE_MAX = 24;
const ruleContextCache = new Map<string, RuleMatchContext>();

export function rulesNeedOrthogonalTrackData(rules: ColorRule[]): boolean {
  return rules.some(rule =>
    rule.enabled && rule.conditions.some(cond => cond.target === 'track' || cond.target === 'motif')
  );
}

export function hydrateOrthogonalTracks(
  tracks: OrthogonalTrack[],
  dataByIndex: Record<number, OrthogonalTrackViewportData>,
): OrthogonalTrack[] {
  return tracks.map(track => {
    const data = dataByIndex[track.index];
    if (!data) return track;
    return {
      ...track,
      values: data.values ?? [],
      ...(data.intervals !== undefined ? { intervals: data.intervals } : { intervals: undefined }),
    };
  });
}

function ruleContextCacheKey(
  genes: Gene[],
  allPeaks: FirePeak[],
  orthogonalTracks: OrthogonalTrack[],
  start: number,
  end: number,
  rules: ColorRule[],
  chrom?: string,
): string {
  return [
    chrom ?? '',
    start,
    end,
    getObjectCacheId(genes),
    getObjectCacheId(allPeaks),
    getObjectCacheId(orthogonalTracks),
    getObjectCacheId(rules),
  ].join('|');
}

function qualityCacheKey(qualities?: Record<string, number>): string {
  if (!qualities) return '';
  return Object.keys(qualities)
    .sort()
    .map(key => `${key}:${qualities[key]}`)
    .join(',');
}

function matchCacheKey(
  intStart: number,
  intEnd: number,
  size: number,
  rule: ColorRule,
  layerName?: string,
  qualities?: Record<string, number>,
): string {
  return [
    getObjectCacheId(rule),
    intStart,
    intEnd,
    size,
    layerName ?? '',
    qualityCacheKey(qualities),
  ].join('|');
}

function rememberMatch(ctx: RuleMatchContext, key: string, value: boolean): boolean {
  const cache = ctx.matchCache;
  if (!cache) return value;
  cache.set(key, value);
  if (cache.size > 50000) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  return value;
}

/**
 * The peaks that belong to a panel on `panelChrom`: untagged peaks are the
 * main view's, so a panel on another chromosome leaves them out.
 */
export function peaksForPanelChrom<T extends { chrom?: string }>(peaks: T[], panelChrom: string, mainChrom: string): T[] {
  if (!panelChrom || !mainChrom || sameChrom(panelChrom, mainChrom)) return peaks;
  return peaks.filter(p => p.chrom != null && sameChrom(p.chrom, panelChrom));
}

/** Build precomputed context for rule matching from current viewport state. */
export function buildRuleMatchContext(
  genes: Gene[],
  allPeaks: FirePeak[],
  orthogonalTracks: OrthogonalTrack[],
  start: number,
  end: number,
  rules: ColorRule[],
  chrom?: string,
): RuleMatchContext {
  const regionWidth = end - start;
  const cacheKey = ruleContextCacheKey(genes, allPeaks, orthogonalTracks, start, end, rules, chrom);
  const cached = ruleContextCache.get(cacheKey);
  if (cached) {
    ruleContextCache.delete(cacheKey);
    ruleContextCache.set(cacheKey, cached);
    return cached;
  }

  const enabledRules = rules.filter(rule => rule.enabled);
  const orthogonalByIndex = new Map(orthogonalTracks.map(track => [track.index, track]));

  // Precompute gene body regions (region-relative). Rules can target any
  // viewport annotation, not just protein-coding models, because users may
  // need to exclude overlapping noncoding or regulatory annotations.
  // Genes and chromosome-tagged peaks on another chromosome never match here,
  // whatever their numeric coordinates (a panel on chr2 next to a chr1 view).
  const onChrom = (c: string | null | undefined) => !chrom || !c || sameChrom(c, chrom);
  const coordinateValidGenes = genes.filter(g =>
    Number.isFinite(g.start) && Number.isFinite(g.end) && onChrom(g.chrom)
  );
  const geneRegions: [number, number][] = mergeIntervals(
    coordinateValidGenes.map(g => [
      Math.max(0, g.start - start),
      Math.min(regionWidth, g.end - start)
    ] as [number, number]).filter(([s, e]) => e > s)
  );
  const geneRegionsByKey = new Map<string, [number, number][]>();
  const addGeneRegion = (key: string | null | undefined, region: [number, number]) => {
    if (!key) return;
    const existing = geneRegionsByKey.get(key) ?? [];
    existing.push(region);
    geneRegionsByKey.set(key, existing);
  };
  for (const gene of coordinateValidGenes) {
    const region: [number, number] = [
      Math.max(0, gene.start - start),
      Math.min(regionWidth, gene.end - start),
    ];
    if (region[1] <= region[0]) continue;
    addGeneRegion(`id:${gene.id}`, region);
    addGeneRegion(gene.name ? `name:${gene.name.toLowerCase()}` : null, region);
  }
  for (const [key, regions] of geneRegionsByKey) {
    geneRegionsByKey.set(key, mergeIntervals(regions));
  }

  // Precompute peak regions by minimum layer threshold
  const peakRegionsByMinLayer = new Map<number, [number, number][]>();
  for (let layer = 0; layer <= 3; layer++) {
    const regions: [number, number][] = mergeIntervals(
      allPeaks
        .filter(p => (p.layer ?? 0) <= layer && onChrom(p.chrom))
        .map(p => [
          Math.max(0, p.start - start),
          Math.min(regionWidth, p.end - start)
        ] as [number, number])
        .filter(([s, e]) => e > s)
    );
    peakRegionsByMinLayer.set(layer, regions);
  }

  // Precompute orthogonal track data for track overlap conditions
  const trackThresholds = new Map<string, number>();
  const trackAnnotationRegions = new Map<string, [number, number][]>();

  const referencedTrackIds = new Set<string>();
  for (const rule of enabledRules) {
    for (const cond of rule.conditions) {
      if (cond.target === 'track' && cond.trackId) {
        referencedTrackIds.add(cond.trackId);
      }
    }
  }

  for (const trackIdStr of referencedTrackIds) {
    const trackIdx = parseInt(trackIdStr);
    const track = orthogonalByIndex.get(trackIdx);
    if (!track) continue;

    if (track.renderMode === 'annotation' && track.intervals) {
      const regions: [number, number][] = mergeIntervals(
        track.intervals
          .map(iv => [
            Math.max(0, iv.start - start),
            Math.min(regionWidth, iv.end - start)
          ] as [number, number])
          .filter(([s, e]) => e > s)
      );
      trackAnnotationRegions.set(trackIdStr, regions);
    } else if (track.values && track.values.length > 0) {
      for (const rule of enabledRules) {
        for (const cond of rule.conditions) {
          if (cond.target === 'track' && cond.trackId === trackIdStr) {
            const pctile = cond.trackThreshold ?? 50;
            const sorted = [...track.values].filter(v => v > 0).sort((a, b) => a - b);
            if (sorted.length > 0) {
              const idx = Math.min(sorted.length - 1, Math.floor(pctile / 100 * sorted.length));
              trackThresholds.set(trackThresholdKey(trackIdStr, pctile), sorted[idx]);
            }
          }
        }
      }
    }
  }

  // Precompute merged motif regions for 'motif' overlap conditions
  let motifRegions: [number, number][] = [];
  const hasMotifCondition = enabledRules.some(
    r => r.conditions.some(c => c.target === 'motif')
  );
  if (hasMotifCondition) {
    const all: [number, number][] = [];
    for (const track of orthogonalTracks) {
      if (track.category === 'motif' && track.intervals) {
        for (const iv of track.intervals) {
          const s = Math.max(0, iv.start - start);
          const e = Math.min(regionWidth, iv.end - start);
          if (e > s) all.push([s, e]);
        }
      }
    }
    all.sort((a, b) => a[0] - b[0]);
    for (const iv of all) {
      if (motifRegions.length > 0 && motifRegions[motifRegions.length - 1][1] >= iv[0]) {
        motifRegions[motifRegions.length - 1][1] = Math.max(
          motifRegions[motifRegions.length - 1][1], iv[1]
        );
      } else {
        motifRegions.push([...iv]);
      }
    }
  }

  const ctx: RuleMatchContext = {
    chrom,
    viewportStart: start,
    geneRegions,
    geneRegionsByKey,
    peakRegionsByMinLayer,
    motifRegions,
    orthogonalTracks,
    orthogonalByIndex,
    trackAnnotationRegions,
    trackThresholds,
    regionWidth,
    matchCache: new Map(),
  };
  ruleContextCache.set(cacheKey, ctx);
  while (ruleContextCache.size > RULE_CONTEXT_CACHE_MAX) {
    const first = ruleContextCache.keys().next().value;
    if (first !== undefined) ruleContextCache.delete(first);
    else break;
  }
  return ctx;
}

/** A rule's quality gates as the sort/filter API takes them (snake_case). */
export interface QualityGatePayload { quality_name: string; min_value: number; max_value: number | null }
export function qualityGatesPayload(gates: QualityGate[] | null | undefined): QualityGatePayload[] {
  return (gates ?? [])
    .filter(gate => gate && gate.qualityName)
    .map(gate => ({ quality_name: gate.qualityName, min_value: Number(gate.minValue) || 0, max_value: gate.maxValue ?? null }));
}

/** Check if a single footprint (region-relative coords) matches a rule's conditions.
 *
 *  `qualities` (optional) is a per-interval map `{ qualityName → byteValue }`
 *  built by the caller from `layer.quality_names` / `layer.qualities[qi][li]`.
 *  If the rule has `qualityGates` and no qualities are supplied, the rule
 *  skips — a gated rule cannot match a layer that doesn't expose the
 *  required quality dimension. */
export function footprintMatchesRule(
  intStart: number, intEnd: number, size: number,
  rule: ColorRule, ctx: RuleMatchContext,
  layerName?: string,
  qualities?: Record<string, number>,
  annotationName?: string,
): boolean {
  if (!rule.enabled) return false;
  // Class-aware: if rule targets specific layers, skip if this footprint's layer doesn't match.
  // FIRE is a user-facing alias for the internal MSP/as-al layer.
  if (!ruleTargetsLayer(rule, layerName)) {
    return false;
  }
  if (size < rule.sizeMin) return false;
  if (rule.sizeMax !== null && size > rule.sizeMax) return false;
  if (rule.requireAnnotationName && !annotationName) return false;

  // Quality gates — all must pass. A missing quality dimension is a hard
  // fail rather than a pass-through, so a FIRE rule doesn't accidentally
  // paint a layer that has no `aq` scores.
  if (rule.qualityGates && rule.qualityGates.length > 0) {
    if (!qualities) return false;
    for (const gate of rule.qualityGates) {
      const v = qualities[gate.qualityName];
      if (v === undefined) return false;
      if (v < gate.minValue) return false;
      if (gate.maxValue != null && v > gate.maxValue) return false;
    }
  }

  if (rule.conditions.length === 0) return true;

  const cacheKey = matchCacheKey(intStart, intEnd, size, rule, layerName, qualities);
  const cached = ctx.matchCache?.get(cacheKey);
  if (cached !== undefined) return cached;

  const midpoint = (intStart + intEnd) / 2;

  for (const cond of rule.conditions) {
    let match = false;
    if (cond.target === 'gene') {
      const idRegions = cond.geneId ? ctx.geneRegionsByKey.get(`id:${cond.geneId}`) : undefined;
      const nameRegions = cond.geneName
        ? ctx.geneRegionsByKey.get(`name:${cond.geneName.toLowerCase()}`)
        : undefined;
      // A named gene that isn't in view matches nothing (not "any gene").
      const named = Boolean(cond.geneId || cond.geneName);
      const regions = idRegions?.length ? idRegions : (nameRegions ?? (named ? [] : ctx.geneRegions));
      match = overlapsAny(midpoint, regions);
    } else if (cond.target === 'peak') {
      const layer = cond.minPeakLayer ?? 3;
      const regions = ctx.peakRegionsByMinLayer.get(layer) ?? [];
      match = overlapsAny(midpoint, regions);
    } else if (cond.target === 'motif') {
      match = overlapsAny(midpoint, ctx.motifRegions);
    } else if (cond.target === 'region') {
      const regionStart = Number(cond.regionStart);
      const regionEnd = Number(cond.regionEnd);
      const chromMatches = !cond.regionChrom || !ctx.chrom || sameChrom(cond.regionChrom, ctx.chrom);
      if (Number.isFinite(regionStart) && Number.isFinite(regionEnd) && chromMatches) {
        const s = Math.max(0, Math.min(regionStart, regionEnd) - ctx.viewportStart);
        const e = Math.min(ctx.regionWidth, Math.max(regionStart, regionEnd) - ctx.viewportStart);
        match = e > s && midpoint >= s && midpoint < e;
      }
    } else if (cond.target === 'track' && cond.trackId) {
      const trackIdx = parseInt(cond.trackId);
      const track = ctx.orthogonalByIndex.get(trackIdx);
      if (track) {
        if (track.renderMode === 'annotation') {
          const regions = ctx.trackAnnotationRegions.get(cond.trackId) ?? [];
          match = overlapsAny(midpoint, regions);
        } else if (track.values && track.values.length > 0) {
          const binIdx = Math.min(
            track.values.length - 1,
            Math.floor(midpoint / ctx.regionWidth * track.values.length)
          );
          const signalVal = track.values[binIdx] ?? 0;
          // No positive signal in view means no threshold: nothing overlaps
          // (not "everything is above 0").
          const threshold = ctx.trackThresholds.get(trackThresholdKey(cond.trackId, cond.trackThreshold ?? 50));
          match = threshold !== undefined && signalVal >= threshold;
        }
      }
    }
    if (cond.negate) match = !match;
    if (!match) return rememberMatch(ctx, cacheKey, false);
  }

  return rememberMatch(ctx, cacheKey, true);
}

/** Get the first matching rule's color for a footprint, or null if no rule matches. */
export function getMatchingRuleColor(
  intStart: number, intEnd: number, size: number,
  rules: ColorRule[], ctx: RuleMatchContext,
): string | null {
  for (const rule of rules) {
    if (footprintMatchesRule(intStart, intEnd, size, rule, ctx)) {
      return getRuleColorForSize(rule, size);
    }
  }
  return null;
}

/** Get the first matching rule's ID for a footprint, or null if no rule matches. */
export function getMatchingRuleId(
  intStart: number, intEnd: number, size: number,
  rules: ColorRule[], ctx: RuleMatchContext,
): string | null {
  for (const rule of rules) {
    if (footprintMatchesRule(intStart, intEnd, size, rule, ctx)) {
      return rule.id;
    }
  }
  return null;
}

export interface CompactReadLike {
  id: string;
  intervals: [number, number, number][];  // [start, end, size]
  /** Per-layer calls (TF, nucleosome, FIRE...) on layered reads. */
  layers?: Record<string, {
    intervals?: [number, number, number][];
    quality_names?: string[];
    qualities?: (number[] | undefined)[];
    annotation_names?: (string | undefined)[];
  } | undefined>;
}

/** Does any footprint on this read match the rule? Reads the same places the
 * read canvas colours: top-level intervals, the TF layer for every rule, and
 * other layers only for rules that target them. */
export function readMatchesRule(read: CompactReadLike, rule: ColorRule, ctx: RuleMatchContext): boolean {
  // Top-level intervals are the primary 'footprint' layer, as the canvas names
  // them, so a rule targeting only other layers (e.g. TF) skips them.
  for (const [intStart, intEnd, size] of read.intervals) {
    if (size > 0 && footprintMatchesRule(intStart, intEnd, size, rule, ctx, 'footprint')) return true;
  }
  for (const [layerName, layer] of Object.entries(read.layers ?? {})) {
    const intervals = layer?.intervals;
    if (!intervals?.length) continue;
    const isTf = layerName === 'tf';
    if (!isTf && ((rule.targetLayers ?? []).length === 0 || !ruleTargetsLayer(rule, layerName))) continue;
    const needsQualities = (rule.qualityGates?.length ?? 0) > 0;
    for (let i = 0; i < intervals.length; i++) {
      const [intStart, intEnd, size] = intervals[i];
      if (size <= 0) continue;
      let qualities: Record<string, number> | undefined;
      if (needsQualities && layer?.quality_names && layer.qualities) {
        qualities = {};
        layer.quality_names.forEach((name, q) => {
          const value = layer.qualities?.[q]?.[i];
          if (value !== undefined) qualities![name] = value;
        });
      }
      if (footprintMatchesRule(intStart, intEnd, size, rule, ctx, layerName, qualities, layer?.annotation_names?.[i])) {
        return true;
      }
    }
  }
  return false;
}

export interface EnrichmentResult {
  matched: number;
  total: number;
}

/**
 * Count reads with at least one footprint matching each rule, grouped by cluster.
 * Returns: ruleId -> clusterNumber -> { matched read count, total read count }
 */
export function computePerClusterEnrichment(
  reads: CompactReadLike[],
  rules: ColorRule[],
  clusterAssignments: Record<string, number>,
  ctx: RuleMatchContext,
): Map<string, Map<number, EnrichmentResult>> {
  const enabledRules = rules.filter(r => r.enabled);
  const result = new Map<string, Map<number, EnrichmentResult>>();

  // Initialize result maps
  for (const rule of enabledRules) {
    result.set(rule.id, new Map());
  }

  // Process each read
  for (const read of reads) {
    const cluster = clusterAssignments[read.id];
    if (cluster === undefined) continue;

    // For each rule, check if ANY footprint in this read matches
    for (const rule of enabledRules) {
      const clusterMap = result.get(rule.id)!;
      if (!clusterMap.has(cluster)) {
        clusterMap.set(cluster, { matched: 0, total: 0 });
      }
      const entry = clusterMap.get(cluster)!;
      entry.total++;

      if (readMatchesRule(read, rule, ctx)) entry.matched++;
    }
  }

  return result;
}
