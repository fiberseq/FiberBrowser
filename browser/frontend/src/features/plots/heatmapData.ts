/**
 * Heatmap data and figure, on the one profile engine: the region heatmap (regionHeatmap.ts). One row per region
 * (selected features here; BED regions through bedData, the same figure), its profile over the window (the engine per
 * region, finished like a metaprofile), per group, with the groups' metaprofile on top; sorted by mean / centre /
 * k-means clusters / BED order / BED column. Compare draws A − B or log2(A/B) per region (each vs rest / each vs all /
 * A vs B, "rest" pooled exactly) and the profile the groups. Sequential maps (magma by default) from 0; comparisons
 * RdBu_r centred on 0 (the size rule's slots).
 *
 * Retired: reads × position over the view (it redrew the read track). Old cards and sessions in that mode still open,
 * drawn as stored, with a note; nothing new is computed for it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import type { FootprintSizesClusters, FootprintSizesTarget } from '../../components/controls/cluster-detail/useFootprintSizeData';
import type { HeatmapBlock } from '../../components/charts/HeatmapRowsChart';
import type { FootprintSizeColormap } from '../../utils/footprintSizeColormaps';
import { comparisons as pairComparisons, resolveCompareMode, type ResolvedCompareMode } from './compare';
import {
  accumulateProfiles, compareProfiles, finishProfile, poolProfiles, readRows, sortReadRows, thinRows, type ProfileRead, type ProfileRegion, type RawProfile, type ReadRow,
} from './profileEngine';
import { PROFILE_NORMALIZATIONS, type PlotSpec, type SamplingSettings } from './plotModel';
import { CLUSTER_COLOURS, kmeansRows, regionProfileLines, sortRows, type ProfileLine, type RegionRow } from './regionHeatmap';
import { fetchEngineReads, sampleScope } from './useProfileData';
import type { ReadGroupDef } from './readGroups';

export interface HeatmapFeature {
  id: string; label: string; chrom: string; start: number; end: number; genome: string | null;
  /** BED regions: the set it is from. */
  set?: string;
  /** Its place in the BED file (BED order); selected features: by position. */
  bedIndex?: number;
  /** The BED columns from 5 on, as numbers (null: not a number). */
  columns?: Array<number | null>;
  strand?: '+' | '-' | '.';
  /** The region itself (a selected peak, a BED line), when the row's window is wider. */
  region?: [number, number];
}
export interface HeatmapGroup { id: string; title: string; color?: string; /** BED groups: the set; its block shows that set's regions only. */ set?: string }

export interface HeatmapEntry {
  key: string;
  locus: { chrom: string; start: number; end: number; genome: string | null };
  mode: 'reads' | 'features';
  binBp: number;
  /** x axis start (reads: genomic; features: bp from the centre) */
  start: number;
  groups: HeatmapGroup[];
  /** reads mode */
  rows?: Array<ReadRow & { label: string }>;
  /** features mode: per feature, per group raw profile (groups' order). */
  features?: Array<{ feature: HeatmapFeature; raws: RawProfile[] }>;
  seeded?: boolean;
}

/** The selected peaks as features (by position, capped), each a window centred on it. */
export function selectedFeatures(maxFeatures: number, windowBp: number): HeatmapFeature[] {
  const s = useBrowserStore.getState();
  const peaks = s.getAllPeaks().filter(p => s.selectedPeaks.has(p.index))
    .sort((a, b) => (a.chrom ?? s.chrom).localeCompare(b.chrom ?? s.chrom) || a.start - b.start).slice(0, maxFeatures);
  return peaks.map(p => {
    const centre = Math.round((p.start + p.end) / 2);
    const chrom = p.chrom ?? s.chrom;
    return { id: `${chrom}:${p.start}-${p.end}`, label: `${chrom}:${(p.start + 1).toLocaleString('en-US')}`, chrom, start: centre - Math.round(windowBp / 2), end: centre + Math.round(windowBp / 2), genome: p.genome ?? null };
  }).map((f, i) => ({ ...f, bedIndex: i, region: [peaks[i].start, peaks[i].end] as [number, number] }));
}

export function heatmapRequestKey(plot: PlotSpec, target: FootprintSizesTarget, clusters: FootprintSizesClusters | null, features: HeatmapFeature[], sampleSeed: string, settingsKey: string, groupsSig = ''): string {
  const featureMode = plot.where === 'features';
  return JSON.stringify({
    kind: 'fiberbrowser.heatmap.v1', mode: featureMode ? 'features' : 'reads', source: plot.source, group: plot.groupBy, bin: plot.profile.binBp, cap: plot.profile.readCap,
    view: featureMode ? null : [target.chrom, target.start, target.end, target.genome], panels: target.panels.map(p => `${p.key}:${p.datasetId}`),
    features: featureMode ? features.map(f => f.id) : null, window: featureMode ? plot.heatmap.windowBp : null,
    clusters: plot.groupBy === 'cluster' && clusters ? clusters.assignmentSignature ?? null : null, groups: groupsSig || null, sampleSeed, settingsKey,
    sampling: plot.sampling.mode === 'random' ? [plot.sampling.n, plot.sampling.seed] : null,
  });
}

/** Per feature window, its raw profile per group, after the plot's sampling over every window together (a read in two
 *  windows is kept or dropped in both), as the metaprofile over selected features does. */
export function featureRaws(parts: Array<{ f: HeatmapFeature; reads: Array<ProfileRead & { dataset?: string }> }>, ids: string[], binBp: number,
  sampling: SamplingSettings): Array<{ feature: HeatmapFeature; raws: RawProfile[] }> {
  const keep = new Set(sampleScope(parts.flatMap(p => p.reads), sampling).reads);
  return parts.map(p => ({ feature: p.f, raws: accumulateProfiles(p.reads.filter(r => keep.has(r)), { chrom: p.f.chrom, start: p.f.start, end: p.f.end }, binBp, ids) }));
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

export function useHeatmapData(o: {
  plot: PlotSpec; target: FootprintSizesTarget; clusters: FootprintSizesClusters | null; sampleSeed: string; settingsKey: string;
  enabled: boolean; seed?: HeatmapEntry | null; readGroups?: ReadGroupDef[] | null; groupsSig?: string;
}): { entry: HeatmapEntry | null; requestKey: string; loading: boolean; error: string | null; features: HeatmapFeature[] } {
  const { plot, target, clusters, sampleSeed, settingsKey, enabled, seed = null, readGroups = null, groupsSig = '' } = o;
  const selectedPeaks = useBrowserStore(s => s.selectedPeaks);
  const features = useMemo(() => (plot.where === 'features' ? selectedFeatures(plot.heatmap.maxFeatures, plot.heatmap.windowBp) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plot.where, plot.heatmap.maxFeatures, plot.heatmap.windowBp, selectedPeaks]);
  const requestKey = useMemo(() => heatmapRequestKey(plot, target, clusters, features, sampleSeed, settingsKey, groupsSig), [plot, target, clusters, features, sampleSeed, settingsKey, groupsSig]);
  const [entry, setEntry] = useState<HeatmapEntry | null>(seed);
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const seq = useRef(0);
  useEffect(() => { if (seed) { setEntry(seed); entryRef.current = seed; } }, [seed]);

  useEffect(() => {
    if (!enabled) return;
    if (entryRef.current?.key === requestKey || (seed && seed.key === requestKey)) { setLoading(false); return; }
    const featureMode = plot.where === 'features';
    // Reads × position over the view is retired: an old plot in that mode shows its stored card only.
    if (!featureMode) { setLoading(false); return; }
    if (!target.panels.length || !features.length) { setLoading(false); return; }
    const mine = ++seq.current;
    const controller = new AbortController();
    const key = requestKey;
    const binBp = plot.profile.binBp;
    const byCluster = plot.groupBy === 'cluster' && !!clusters;
    const groupBy = readGroups ? 'groups' as const : byCluster ? 'cluster' as const : plot.groupBy === 'none' ? 'none' as const : 'dataset' as const;
    const panels = byCluster ? clusters!.panels : target.panels;
    const base = { source: plot.source, panels, clusters: byCluster ? clusters : null, readGroups: readGroups ?? undefined, groupBy, readCap: plot.profile.readCap, sampleSeed, signal: controller.signal };
    const t = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      const job = featureMode
        ? mapLimit(features, 4, f => fetchEngineReads({ ...base, region: { chrom: f.chrom, start: f.start, end: f.end, genome: f.genome } })
          .then(r => ({ f, ...r }))).then(parts => {
          const groups = parts.find(p => p.groups.length)?.groups ?? [];
          return {
            key, binBp, mode: 'features' as const, start: -Math.round(plot.heatmap.windowBp / 2), groups,
            locus: { chrom: features[0].chrom, start: features[0].start, end: features[features.length - 1].end, genome: features[0].genome },
            features: featureRaws(parts, groups.map(g => g.id), binBp, plot.sampling),
          };
        })
        : fetchEngineReads({ ...base, region: { chrom: target.chrom, start: target.start, end: target.end, genome: target.genome } }).then(({ reads, groups }) => {
          const region: ProfileRegion = { chrom: target.chrom, start: target.start, end: target.end };
          const rows = readRows(reads, region, binBp).map((r, i) => ({ ...r, label: `read ${i + 1}` }));
          return {
            key, binBp, mode: 'reads' as const, start: target.start, groups: groups.filter(g => rows.some(r => r.group === g.id)), rows,
            locus: { chrom: target.chrom, start: target.start, end: target.end, genome: target.genome },
          };
        });
      job.then(e => { if (seq.current === mine && !controller.signal.aborted) setEntry(e); })
        .catch(err => {
          if (controller.signal.aborted || err?.name === 'AbortError' || seq.current !== mine) return;
          setError({ key, message: `Heatmap could not be computed: ${err instanceof Error ? err.message : String(err)}` });
        })
        .finally(() => { if (seq.current === mine && !controller.signal.aborted) setLoading(false); });
    }, 60);
    return () => { controller.abort(); window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, enabled, seed]);

  return { entry, requestKey, loading, error: error && error.key === requestKey ? error.message : null, features };
}

export interface HeatmapFigure {
  blocks: HeatmapBlock[];
  signed: boolean;
  comparing: boolean;
  mode: ResolvedCompareMode | null;
  valueLabel: string;
  colormap: FootprintSizeColormap;
  reverse: boolean;
  /** Why Compare does not apply here, or that the mode is retired. */
  note: string | null;
  /** The metaprofile on top (same x axis): the groups, or per cluster. */
  profile: { lines: ProfileLine[]; yLabel: string } | null;
  /** Sort = clusters: each cluster's regions (for Save cluster as BED set and Group by), in cluster order. */
  clusters: Array<{ id: string; label: string; color: string; features: HeatmapFeature[] }> | null;
}

/** The score of a region for sort = BED column (1-based column; 5 = score). */
const scoreOf = (f: HeatmapFeature, column: number): number | null => f.columns?.[column - 5] ?? null;

export function heatmapFigure(plot: PlotSpec, e: HeatmapEntry): HeatmapFigure {
  const seq = plot.size.colormaps.enrichment;
  const cmp = plot.size.colormaps.comparative;
  const marks = plot.source === 'm6a';
  if (e.mode === 'reads') {
    // Retired mode (an old card or session): drawn as stored.
    const order = e.groups.map(g => g.id);
    const sorted = sortReadRows(e.rows ?? [], 'signal', order) as Array<ReadRow & { label: string }>;
    const total = Math.max(1, sorted.length);
    const blocks = e.groups.map(g => {
      const rows = sorted.filter(r => r.group === g.id);
      const keep = Math.max(1, Math.round((rows.length / total) * plot.heatmap.maxRows));
      return { id: g.id, title: g.title, color: g.color, rows: thinRows(rows, keep).map(r => ({ label: r.label, values: r.values })) };
    }).filter(b => b.rows.length);
    return {
      blocks, signed: false, comparing: false, mode: null, valueLabel: marks ? 'marks per bp' : 'fraction of bin', colormap: seq.name, reverse: seq.reverse,
      note: 'The reads × position heatmap was retired (it redrew the read track): this card shows it as stored. The heatmap is per region now: selected features or BED regions.',
      profile: null, clusters: null,
    };
  }
  const opts = { normalization: plot.profile.normalization, sigmaBp: plot.profile.sigmaBp, minCoverage: plot.profile.minCoverage, binBp: e.binBp, marksPerBp: marks };
  const feats = e.features ?? [];
  const inGroup = (gi: number, i: number) => { const g = e.groups[gi]; return !g?.set || feats[i].feature.set === g.set; };
  const finished = feats.map((f, i) => f.raws.map((r, gi) => (inGroup(gi, i) ? finishProfile(r, opts) : null)));
  const n = finished.find(r => r.some(Boolean))?.find(Boolean)?.length ?? 0;
  const rows: RegionRow[] = feats.map((f, i) => ({ id: f.feature.id, label: f.feature.label, bedIndex: f.feature.bedIndex ?? i, score: scoreOf(f.feature, plot.heatmap.scoreColumn), values: finished[i] }));
  const clusterOf = plot.heatmap.sort === 'cluster' ? kmeansRows(rows, plot.heatmap.k, plot.sampling.seed) : null;
  const order = sortRows(rows, plot.heatmap, { n, start: e.start, binBp: e.binBp, scaled: plot.where === 'bed' && plot.bed.mode === 'scale' }, clusterOf);
  const unit = PROFILE_NORMALIZATIONS.find(x => x.value === plot.profile.normalization)?.label.toLowerCase() ?? '';
  const profile = { lines: regionProfileLines(e.groups, feats.map(f => f.raws), inGroup, opts, clusterOf), yLabel: marks ? 'marks per read per bp' : unit };
  const kCount = clusterOf ? Math.max(0, ...clusterOf) + 1 : 0;
  const clusters = clusterOf ? Array.from({ length: kCount }, (_, c) => ({ id: `C${c + 1}`, label: `Cluster ${c + 1}`, color: CLUSTER_COLOURS[c % CLUSTER_COLOURS.length],
    features: order.filter(i => clusterOf[i] === c).map(i => feats[i].feature) })) : null;
  // Row blocks: per group, and per cluster within it.
  const split = (title: string, color: string | undefined, idx: number[], mk: (i: number) => (number | null)[], id: string) => (clusterOf
    ? Array.from({ length: kCount }, (_, c) => ({ id: `${id}#C${c + 1}`, title: `${title} · C${c + 1}`, color: CLUSTER_COLOURS[c % CLUSTER_COLOURS.length],
      rows: idx.filter(i => clusterOf[i] === c).map(i => ({ label: feats[i].feature.label, values: mk(i) })) }))
    : [{ id, title, ...(color ? { color } : {}), rows: idx.map(i => ({ label: feats[i].feature.label, values: mk(i) })) }]);
  const op = plot.compare === 'diff' ? 'diff' as const : plot.compare === 'log2ratio' ? 'log2ratio' as const : null;
  if (op && e.groups.length >= 2) {
    const mode = resolveCompareMode(plot.compareMode, plot.groupBy, e.groups.length);
    const pairs = pairComparisons(e.groups.map(g => ({ id: g.id, title: g.title, panelKey: g.id.slice(0, g.id.lastIndexOf('|')), matrix: [[1]] })), mode, plot.compareAB);
    const gi = (id: string) => e.groups.findIndex(g => g.id === id);
    const blocks = pairs.flatMap(c => {
      const ai = gi(c.a);
      const panelOf = (id: string) => id.slice(0, id.lastIndexOf('|'));
      const pool = e.groups.filter(g => panelOf(g.id) === panelOf(c.a));
      const scope = (pool.length > 1 ? pool : e.groups).map(g => gi(g.id));
      return split(c.label, undefined, order.filter(i => inGroup(ai, i)), i => {
        const f = feats[i];
        let b: RawProfile;
        if (c.b === 'rest') b = poolProfiles(scope.filter(j => j !== ai).map(j => f.raws[j]), 'rest');
        else if (c.b === 'all') b = poolProfiles(scope.map(j => f.raws[j]), 'all');
        else b = f.raws[gi(c.b)];
        return compareProfiles(finished[i][ai] ?? [], finishProfile(b, opts), op);
      }, c.id);
    }).filter(b => b.rows.length);
    return { blocks, signed: true, comparing: true, mode, valueLabel: op === 'diff' ? `Δ ${unit}` : `log2 ratio (${unit})`, colormap: cmp.name, reverse: cmp.reverse, note: null, profile, clusters };
  }
  const blocks = e.groups.flatMap((g, gi) => split(g.title, g.color, order.filter(i => inGroup(gi, i)), i => finished[i][gi] ?? [], g.id)).filter(b => b.rows.length);
  return { blocks, signed: false, comparing: false, mode: null, valueLabel: marks ? 'marks per read per bp' : unit, colormap: seq.name, reverse: seq.reverse, note: null, profile, clusters };
}

export function heatmapTsv(plot: PlotSpec, fig: HeatmapFigure, e: HeatmapEntry, locus: string): string {
  const n = fig.blocks[0]?.rows[0]?.values.length ?? 0;
  const head = [`# plot: ${plot.name || 'Heatmap'}`, `# computed_for: ${locus}`, `# rows: ${e.mode === 'reads' ? 'reads' : 'features'}`, `# source: ${plot.source}`,
    `# value: ${fig.valueLabel}`, `# bin_bp: ${e.binBp}`, ['block', 'row', ...Array.from({ length: n }, (_, i) => String(e.start + i * e.binBp + (e.mode === 'reads' ? 1 : 0)))].join('\t')];
  const rows = fig.blocks.flatMap(b => b.rows.map(r => [b.title, r.label, ...r.values.map(v => (v == null ? 'NA' : String(+v.toPrecision(5))))].join('\t')));
  return [...head, ...rows].join('\n');
}
