/**
 * The built-in measure sources (measures.ts):
 * - Layers: the read layers the metaprofile can show (getMetaprofileSourceEntries: Nuc/FP, TF, accessibility, m6A,
 *   custom MA-tag groups...), per read from /api/reads/compact as the Plots metaprofile reads them (its engineRead).
 * - Footprint families, NFR families, nucleosome geometries: the feature hub's sets in view with per-read states
 *   (Find classes, NFR runs, Find geometries), read with /api/features/states as Plots › Differential does; never
 *   recomputed. A family counts when it overlaps the bounds.
 * - Nucleosomes › regularity score: each molecule's median tile score from the Regularity endpoint (per_molecule),
 *   as the cluster views ask it; per molecule over the region, not per window (said in the header).
 */
import { fetchJson } from '../../api/sharedFetch';
import { getMetaprofileSourceEntries, getLayerColor } from '../../utils/layerColors';
import { defaultMetaprofileToggles } from '../../utils/defaultMetaprofile';
import { engineRead, sourceLayers } from '../plots/useProfileData';
import { ALL_FOOTPRINTS } from '../../utils/footprintSizeSettings';
import type { HubSelected } from '../hub/hubState';
import { FAMILY_KINDS, familyHits, familyMeasureId, loadFamilyMembership, type FamilyKind } from '../hub/familySources';
import { registerMeasureSource, unitKey, type BinnedUnit, type LoadContext, type MeasureContext, type MeasureData, type MeasureDef } from './measures';
import { binWindowWeights, readSums, shareSums, valueSums, viewFlanks, type UnitSums } from './windowMaths';
import { getProfileReadPool, type ProfileReadPool } from '../../utils/profileReadPool';
import { isMarkLayer, layerChannelRead, markLayerPoints, readPointChannels } from '../../utils/metaprofileReads';
import { accumulateChannels } from '../plots/profileEngine';
import { originalBounds } from '../plots/sizeHistogram';
import { isMetaChrom } from './spec';

type CompactRead = Parameters<typeof engineRead>[0];

/** A read's identity as the read panel and the clustering use it (readFilter.clusterAssignmentForRead): its analysis id
 *  when it has one (a meta-locus read-site observation, a lifted row), else its name. */
export const readIdOf = (r: { id: string; analysis_id?: string }): string => r.analysis_id ?? r.id;

// ------------------------------------------------------------------ layers

export const layerMeasureId = (key: string) => `layer:${key}`;

/** The layer measures: every metaprofile layer source of the datasets in view. */
export function layerMeasures(ctx: MeasureContext): MeasureDef[] {
  const s = ctx.state;
  const ids = new Set(ctx.allReads.panels.map(p => p.datasetId));
  const datasets = s.datasets.filter(d => ids.has(d.id));
  return getMetaprofileSourceEntries(datasets).map(e => {
    const marks = isMarkLayer(e.key);
    return { id: layerMeasureId(e.key), label: e.label, source: 'layers', kind: marks ? 'rate' as const : 'fraction' as const,
      unit: marks ? 'marks per kb of read' : 'fraction of covered bp', color: getLayerColor(e.key), enrichment: true, windowed: true, available: true as const };
  });
}

/** The active layers (the default metaprofile's: the read layers switched on in Tracks), as measure ids. */
export function activeLayerMeasureIds(ctx: MeasureContext): string[] {
  const on = defaultMetaprofileToggles(ctx.state);
  const all = layerMeasures(ctx);
  const canon = (k: string) => (k === 'footprint' ? 'nuc' : k === 'mod' ? 'm6a' : k === 'msp' ? 'fire' : k);
  return all.filter(m => on[canon(m.id.slice('layer:'.length))]).map(m => m.id);
}

/** Compact reads per dataset over the view (a seeded sample of readCap), with the layers asked for. */
async function compactReads(ctx: LoadContext, layers: string[], marks: boolean): Promise<Array<[string, CompactRead[]]>> {
  const datasets = [...new Set(ctx.allReads.panels.map(p => p.datasetId))];
  return Promise.all(datasets.map(async ds => {
    const params = new URLSearchParams({
      chrom: ctx.view.chrom, start: String(Math.round(ctx.view.start)), end: String(Math.round(ctx.view.end)), dataset_id: ds, max_reads: String(ctx.readCap),
      include_layers: 'true', include_layer_qualities: 'false', hide_terminal_gaps: 'false', sample_seed: String(ctx.seed),
    });
    if (layers.length) params.set('layer_names', layers.join(','));
    if (marks) params.set('include_methylation', 'true');
    if (ctx.view.genome) params.set('panel_genome', ctx.view.genome);
    const r = await fetchJson<{ reads?: CompactRead[]; total_reads?: number }>(`/api/reads/compact?${params}`, { signal: ctx.signal });
    return [ds, r.reads ?? []] as [string, CompactRead[]];
  }));
}

/** The read track's channel for a layer key (ReadTrack names: layer:<name>, msp as fire; marks by their point keys). */
function channelOf(key: string, cr: { spans: Record<string, Array<[number, number]>>; points: Record<string, number[]> }): { ivs?: Array<[number, number]>; pts?: number[] } {
  if (isMarkLayer(key)) return { pts: markLayerPoints(cr.points, key) };
  if (key === 'nuc' || key === 'footprint') return { ivs: cr.spans['layer:nuc'] ?? cr.spans['layer:footprint'] ?? [] };
  if (key === 'fire' || key === 'msp') return { ivs: cr.spans['layer:fire'] ?? cr.spans.fire ?? [] };
  return { ivs: cr.spans[`layer:${key}`] ?? [] };
}

/**
 * Layers from the panels' own profile pools (utils/profileReadPool: the reads, filters and spans the curves were
 * computed from), in window coordinates. Curve units: each read's touched bins over the curve's grid ('touch', as
 * ReadTrack), kept for the bins inside the bounds. Exact bp: the read's layer bp over its span's bp. The span is the
 * read track's (its call intervals, widened to every channel interval it adds). Null when a panel has no pool for
 * this view (the caller then reads a fresh sample).
 */
/** The flank bins of a view's grid: the y-scale's rule (plotSetYScale.flankMean), round(res × fraction) bins at each end. */
export function flankBins(res: number, fraction: number): Int32Array {
  const k = Math.max(1, Math.min(Math.floor(res / 2), Math.round(res * fraction)));
  const out: number[] = [];
  for (let i = 0; i < k; i++) out.push(i);
  for (let i = res - k; i < res; i++) out.push(i);
  return Int32Array.from(out);
}

/** Whether a panel's pool can answer a layer: marks when the panel fetched them; any other layer when it was fetched
 *  or some read carries it (Nuc and footprints: either name). Otherwise Quantify reads a fresh sample (whose reader
 *  also takes a legacy read's calls as footprints) rather than count zeros. An empty pool answers: no value. */
export function poolCarries(pool: ProfileReadPool, key: string): boolean {
  if (isMarkLayer(key)) return pool.marks !== false;
  if (!pool.reads.length) return true;
  const names = key === 'nuc' || key === 'footprint' ? ['nuc', 'footprint'] : sourceLayers(key);
  if (pool.layers && names.some(n => pool.layers!.includes(n))) return true;
  return pool.reads.some(r => names.some(n => (r.layers?.[n]?.intervals?.length ?? 0) > 0));
}

export function poolLayerData(keys: string[], ctx: LoadContext): Record<string, MeasureData> | null {
  const out: Record<string, MeasureData> = {};
  const panels = ctx.allReads.panels;
  const pools = panels.map(p => ({ p, pool: getProfileReadPool(p.key) }));
  if (!pools.length || pools.some(({ pool }) => !pool || pool.chrom !== ctx.view.chrom || pool.start !== ctx.view.start || pool.end !== ctx.view.end)) return null;
  // A layer the panel didn't fetch (an extra layer off in Tracks, marks not asked for) would count as zero: read a
  // fresh sample instead. Nuc / TF / footprints come with every read; other layers when fetched or present.
  if (pools.some(({ pool }) => !keys.every(k => poolCarries(pool!, k)))) return null;
  const width = ctx.view.end - ctx.view.start;
  const wa = ctx.bounds.from - ctx.view.start, wb = ctx.bounds.to - ctx.view.start;
  const fl = viewFlanks(0, width, ctx.flankFraction);
  const res = pools[0].pool!.resolution;
  const allW = binWindowWeights(res, 0, width, wa, wb);
  const keep: number[] = [];
  allW.forEach((w, i) => { if (w > 0) keep.push(i); });
  const weights = Float64Array.from(keep.map(i => allW[i]));
  const at = new Map(keep.map((i, j) => [i, j]));
  for (const key of keys) out[layerMeasureId(key)] = isMarkLayer(key) || ctx.layerUnits === 'exact'
    ? { units: new Map(), sampled: {}, readSource: 'panel' }
    : { binned: { weights, units: new Map(), binBp: width / res, ...(ctx.viewBins ? { res, flank: flankBins(res, ctx.flankFraction) } : {}) }, sampled: {}, readSource: 'panel' };
  // Every panel's pool (split panels of one dataset hold different reads); a read shown in two panels counts once.
  const seen = new Set<string>();
  for (const { p } of pools) for (const key of keys) out[layerMeasureId(key)].sampled![p.datasetId] ??= { used: 0 };
  for (const { p, pool } of pools) {
    for (const read of pool!.reads) {
      const uid = unitKey(p.datasetId, readIdOf(read as unknown as { id: string; analysis_id?: string }));
      if (seen.has(uid)) continue;
      seen.add(uid);
      for (const key of keys) out[layerMeasureId(key)].sampled![p.datasetId].used++;
      const cr = layerChannelRead(read);
      // The coverage span as accumulateChannels' touch weighting widens it (every interval of every channel).
      let s0 = cr.end > cr.start ? cr.start : Infinity, e0 = cr.end > cr.start ? cr.end : -Infinity;
      for (const ivs of Object.values(cr.spans)) for (const [a, b] of ivs) if (b > a) { if (a < s0) s0 = a; if (b > e0) e0 = b; }
      if (!(e0 > s0)) continue;
      const id = unitKey(p.datasetId, readIdOf(read as unknown as { id: string; analysis_id?: string }));
      let acc: { coverage: Float64Array; channels: Record<string, Float64Array> } | null = null;
      for (const key of keys) {
        const ch = channelOf(key, cr);
        const d = out[layerMeasureId(key)];
        if (d.binned) {
          acc ??= accumulateChannels([cr], res, width, 'touch');
          const name = key === 'nuc' || key === 'footprint' ? (cr.spans['layer:nuc'] ? 'layer:nuc' : 'layer:footprint') : key === 'fire' || key === 'msp' ? (cr.spans['layer:fire'] ? 'layer:fire' : 'fire') : `layer:${key}`;
          const sig = acc.channels[name];
          const idx: number[] = [], sv: number[] = [], cv: number[] = [];
          for (const i of keep) { const c = acc.coverage[i]; if (c > 0) { idx.push(at.get(i)!); cv.push(c); sv.push(sig ? sig[i] : 0); } }
          const unit: BinnedUnit = { idx: Int32Array.from(idx), sig: Float64Array.from(sv), cov: Float64Array.from(cv) };
          if (ctx.viewBins) {
            const ai: number[] = [], as: number[] = [], ac: number[] = [];
            for (let i = 0; i < res; i++) { const c = acc.coverage[i]; if (c > 0) { ai.push(i); ac.push(c); as.push(sig ? sig[i] : 0); } }
            if (ai.length) unit.all = { idx: Int32Array.from(ai), sig: Float64Array.from(as), cov: Float64Array.from(ac) };
          }
          if (idx.length || unit.all) d.binned.units.set(id, unit);
        } else {
          const sums = readSums({ start: s0, end: e0, ...(ch.pts ? { points: ch.pts } : { intervals: ch.ivs ?? [] }) }, { win: [wa, wb], flanks: fl, view: [0, width] });
          if (sums[1] > 0 || sums[5] > 0) d.units!.set(id, sums);
        }
      }
    }
  }
  return out;
}

export async function loadLayers(measures: MeasureDef[], ctx: LoadContext): Promise<Record<string, MeasureData>> {
  const keys = measures.map(m => m.id.slice('layer:'.length));
  if (ctx.readSource === 'panel') {
    const fromPool = poolLayerData(keys, ctx);
    if (fromPool) return fromPool;
  }
  // A fresh seeded sample (or a panel without curves for this view): exact bp. Interval layers and marks are read
  // separately (the marks' methylation path samples its own reads).
  const layers = [...new Set(keys.filter(k => !isMarkLayer(k)).flatMap(k => sourceLayers(k)))];
  const [ivParts, markParts] = await Promise.all([
    keys.some(k => !isMarkLayer(k)) ? compactReads(ctx, layers, false) : Promise.resolve([] as Array<[string, CompactRead[]]>),
    keys.some(k => isMarkLayer(k)) ? compactReads(ctx, [], true) : Promise.resolve([] as Array<[string, CompactRead[]]>),
  ]);
  const bounds = { win: [ctx.bounds.from, ctx.bounds.to] as [number, number], flanks: viewFlanks(ctx.view.start, ctx.view.end, ctx.flankFraction),
    view: [ctx.view.start, ctx.view.end] as [number, number] };
  const out: Record<string, MeasureData> = {};
  measures.forEach((m, i) => {
    const key = keys[i];
    const source = key === 'footprint' ? 'nuc' : key;
    const units = new Map<string, UnitSums>();
    const sampled: Record<string, { used: number }> = {};
    const mark = isMarkLayer(key);
    const offset = Math.round(ctx.view.start);
    for (const [ds, reads] of mark ? markParts : ivParts) {
      sampled[ds] = { used: reads.length };
      for (const r of reads) {
        const span = engineRead(r, offset, mark ? 'nuc' : source, '');
        if (!span) continue;
        // Marks: the layer's own point channel (5mC, deamination or m6A), as the read track reads it.
        const er = mark ? { start: span.start, end: span.end, points: markLayerPoints(readPointChannels(r), key).map(x => offset + x) } : span;
        const sums = readSums(er, bounds);
        if (sums[1] > 0 || sums[5] > 0) units.set(unitKey(ds, readIdOf(r)), sums);
      }
    }
    out[m.id] = { units, sampled, readSource: 'fetch' };
  });
  return out;
}

registerMeasureSource({ id: 'layers', label: 'Layers', order: 10, list: layerMeasures, load: loadLayers });

// ------------------------------------------------------------------ footprint size band
export const SIZE_BAND_MEASURE = 'size:band';

/** A read's footprints (Nuc + TF, each once) whose centre lies in a range: [in the band, all]. A footprint is its whole
 *  bounds, with its whole size as an optional third number (else its length). */
export function bandCounts(fps: ReadonlyArray<readonly [number, number, number?]>, ranges: ReadonlyArray<readonly [number, number]>, band: readonly [number, number]): [number, number] {
  let k = 0, n = 0;
  for (const [a, b, whole] of fps) {
    const c = (a + b) / 2;
    if (!ranges.some(([x, y]) => c >= x && c < y)) continue;
    n++;
    const size = whole ?? b - a;
    if (size >= band[0] && size < band[1]) k++;
  }
  return [k, n];
}

/** A compact footprint clipped at both ends of the fetched view (its whole size is longer than what was sent). */
export const cutBothEnds = (iv: ReadonlyArray<number>, view: { start: number; end: number }): boolean =>
  iv[2] != null && iv[2] > iv[1] - iv[0] && iv[0] <= view.start && iv[1] >= view.end;

export function sizeBandMeasures(ctx: MeasureContext): MeasureDef[] {
  const ids = new Set(ctx.allReads.panels.map(p => p.datasetId));
  const has = ctx.state.datasets.some(d => ids.has(d.id) && (d.available_layers?.nuc || d.available_layers?.footprint || d.available_layers?.tf || d.layer_type === 'nuc'));
  return [{ id: SIZE_BAND_MEASURE, label: 'Footprints in the size band', source: 'size-band', kind: 'ratio', unit: 'share of footprints in the size band', color: '#7c3aed',
    enrichment: true, windowed: true, note: 'footprints counted by their centre (one wider than the view, with no known centre, is left out); the band is set in Options',
    available: has ? true : { reason: 'No footprint calls (Nuc / TF layers) in these datasets' } }];
}

export async function loadSizeBand(measures: MeasureDef[], ctx: LoadContext): Promise<Record<string, MeasureData>> {
  if (!measures.length) return {};
  const parts = await compactReads(ctx, sourceLayers(ALL_FOOTPRINTS), false);
  const flanks = viewFlanks(ctx.view.start, ctx.view.end, ctx.flankFraction);
  const view = { start: Math.round(ctx.view.start), end: Math.round(ctx.view.end) };
  const units = new Map<string, UnitSums>();
  const sampled: Record<string, { used: number }> = {};
  for (const [ds, reads] of parts) {
    sampled[ds] = { used: reads.length };
    for (const r of reads) {
      const er = engineRead(r, Math.round(ctx.view.start), ALL_FOOTPRINTS, '');
      if (!er) continue;
      // A footprint clipped to the fetched view keeps its whole size and bounds (as the Plots size histogram reads it):
      // its size picks the band, its whole centre the range. One cut at both edges (wider than the view) has no known
      // centre, so it is not counted anywhere.
      const fps = (er.intervals ?? []).filter(iv => iv[1] > iv[0] && !cutBothEnds(iv, view)).map(iv => {
        const [a, b] = originalBounds(iv[0], iv[1], iv[2], view);
        return [a, b, iv[2] ?? iv[1] - iv[0]] as [number, number, number];
      });
      const w = bandCounts(fps, [[ctx.bounds.from, ctx.bounds.to]], ctx.sizeBand);
      const f = bandCounts(fps, flanks, ctx.sizeBand);
      const v = bandCounts(fps, [[ctx.view.start, ctx.view.end]], ctx.sizeBand);
      if (w[1] > 0 || v[1] > 0) units.set(unitKey(ds, readIdOf(r)), [w[0], w[1], f[0], f[1], v[0], v[1]]);
    }
  }
  return { [SIZE_BAND_MEASURE]: { units, sampled } };
}

registerMeasureSource({ id: 'size-band', label: 'Footprint sizes', order: 15, list: sizeBandMeasures, load: loadSizeBand });

// ------------------------------------------------------------------ families (hub sets with per-read states)
// One source of truth with Plots' metaprofile sources: hub/familySources (kinds, ids, hits in view, membership rule).
export { FAMILY_KINDS, familyMeasureId } from '../hub/familySources';

const viewOf = (ctx: MeasureContext) => ({ chrom: ctx.view.chrom, start: ctx.view.start, end: ctx.view.end });

/** Why a kind has none in view, as the picker's unavailable entry (with its Plots prerequisite step). */
function emptyStep(kind: FamilyKind): MeasureDef['available'] {
  const e = kind.empty;
  return e.prereq ? { reason: e.reason, step: { prereq: e.prereq, label: e.stepLabel ?? e.prereq, run: () => true } } : { reason: e.reason };
}

export function familyMeasures(ctx: MeasureContext, kind: FamilyKind): MeasureDef[] {
  const hits = familyHits(ctx.state, viewOf(ctx), kind.typeIds);
  if (!hits.length) {
    return [{ id: `${kind.source}:none`, label: `No ${kind.label.toLowerCase()} in this view`, source: kind.source, kind: 'share', unit: 'share of reads',
      enrichment: true, windowed: false, available: emptyStep(kind) }];
  }
  return hits.map(h => {
    const inBounds = h.end > ctx.bounds.from && h.start < ctx.bounds.to;
    return { id: familyMeasureId(h), label: h.label ?? h.hitId, source: kind.source, kind: 'share' as const, unit: 'share of reads', enrichment: true, windowed: false,
      span: [h.start, h.end] as [number, number],
      available: inBounds ? true as const : { reason: `Outside the bounds (${h.start.toLocaleString('en-US')}–${h.end.toLocaleString('en-US')})` } };
  });
}

/** Shares of reads per family: hub/familySources' membership (member or not, of the reads scored on the hit). */
export async function loadFamilies(measures: MeasureDef[], ctx: LoadContext, kind: FamilyKind): Promise<Record<string, MeasureData>> {
  const hits = familyHits(ctx.state, viewOf(ctx), kind.typeIds);
  const byId = new Map(hits.map(h => [familyMeasureId(h), h]));
  const want = measures.map(m => byId.get(m.id)).filter((h): h is HubSelected => !!h);
  const out: Record<string, MeasureData> = {};
  if (!want.length) return out;
  const membership = await loadFamilyMembership(want);
  for (const h of want) {
    const id = familyMeasureId(h);
    const fm = membership.get(id);
    const units = new Map<string, UnitSums>();
    const sampled: Record<string, { used: number }> = {};
    for (const [ds, evaluated] of Object.entries(fm?.evaluated ?? {})) {
      const members = fm!.members[ds] ?? new Set<string>();
      for (const read of evaluated) units.set(unitKey(ds, read), shareSums(members.has(read) ? '1' : '0')!);
      sampled[ds] = { used: evaluated.size };
    }
    out[id] = { units, sampled };
  }
  return out;
}

for (const kind of FAMILY_KINDS) {
  registerMeasureSource({ id: kind.source, label: kind.label, order: kind.order, list: ctx => familyMeasures(ctx, kind),
    load: (ms, ctx) => loadFamilies(ms, ctx, kind),
    signature: ctx => familyHits(ctx.state, viewOf(ctx), kind.typeIds).map(h => h.hitId).join(',') });
}

// ------------------------------------------------------------------ nucleosome regularity (per molecule)
export const REGULARITY_MEASURE = 'nuc:regularity';

/** What the caller's regularity hook (useClusterRegularity with per_molecule) gives: per panel key, QNAME -> [median, max]. */
export interface NucExtras {
  molecules: Record<string, Map<string, [number | null, number | null]>>;
  status: string;
  message: string;
  /** Ask for it (the cluster views' request: analyses the view first when it has no nucleosome calls). */
  request?: () => void;
}

export function regularityMeasures(ctx: MeasureContext): MeasureDef[] {
  const nuc = ctx.extras.nuc as NucExtras | undefined;
  const ready = !!nuc && nuc.status === 'ready' && Object.keys(nuc.molecules).length > 0;
  const meta = isMetaChrom(ctx.view.chrom);
  const available: MeasureDef['available'] = meta ? { reason: 'Not on a meta-locus (the nucleosome engine reads one genomic region)' }
    : !ctx.clusters ? { reason: 'Regularity per molecule is read through the clusters: cluster the reads first', step: { prereq: 'cluster', label: 'Cluster reads', run: () => true } }
      : ready ? true : nuc && (nuc.status === 'loading' || nuc.status === 'analysing') ? { reason: nuc.message || 'Computing regularity…' }
        // Outside the Clusters panel nothing here can compute it: say where, never a button that does nothing.
        : !nuc?.request ? { reason: 'Regularity per molecule is computed in Clusters › Profiles: quantify there' }
        : { reason: nuc.status === 'error' || nuc.status === 'needs-analyse' ? (nuc.message || 'Regularity per molecule is not computed for this view') : 'Regularity per molecule is not computed for this view', step: { label: 'Compute regularity', title: 'The cluster views\' regularity request (the Nucleosomes panel\'s settings; analyses the view first if it has no nucleosome calls)', run: () => { nuc?.request?.(); return true; } } };
  return [{ id: REGULARITY_MEASURE, label: 'Regularity score', source: 'nuc-geometries', kind: 'value', unit: 'median tile score (signed log2)', enrichment: false,
    windowed: false, note: 'per molecule over the whole region', available }];
}

export async function loadRegularity(_measures: MeasureDef[], ctx: LoadContext): Promise<Record<string, MeasureData>> {
  const nuc = ctx.extras.nuc as NucExtras | undefined;
  const units = new Map<string, UnitSums>();
  for (const p of ctx.allReads.panels) {
    const m = nuc?.molecules[p.key];
    if (!m) continue;
    for (const [q, [median]] of m) { const s = valueSums(median); if (s) units.set(unitKey(p.datasetId, q), s); }
  }
  return { [REGULARITY_MEASURE]: { units } };
}

registerMeasureSource({ id: 'nuc-regularity', label: 'Nucleosomes', order: 41, list: regularityMeasures, load: loadRegularity,
  // The result's content, not only its size: other settings at the same locus can score the same molecules differently.
  signature: ctx => { const n = ctx.extras.nuc as NucExtras | undefined; return n ? `${n.status}:${regularityDigest(n.molecules)}` : ''; } });

/** A cheap content digest of per-molecule regularity (count, and a hash of names and medians). */
export function regularityDigest(molecules: NucExtras['molecules']): string {
  let n = 0, h = 2166136261;
  const mix = (s: string) => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } };
  for (const key of Object.keys(molecules).sort()) {
    mix(key);
    for (const [q, [median]] of molecules[key]) { n++; mix(q); mix(median == null ? 'n' : median.toPrecision(12)); }
  }
  return `${n}:${h.toString(36)}`;
}
