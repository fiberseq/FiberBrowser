/**
 * Shared regularity geometries as features (pool → find → compare), like NFR variants and footprint classes:
 *
 * - a feature kind (`nuc-geometry`, the hub type `nuc.geometry` fiberhmm-scan declares), so shift-click selects them for
 *   the main toolbar's Cluster, Sort and Filter, and opened scans' geometries use the same kind;
 * - a feature-hub provider: each nucleosome panel's geometries are a hub set (hits, overlay, Assoc), hit ids as the
 *   scan writes them (`geometry:<start>-<end>`, `geometry-low:<start>-<end>`), a share per dataset (raw and density
 *   matched within pooled m6A/kb quintiles);
 * - per-read states through the hit's stateSpec (`nuc-geometry`: the panel's request replayed on the server, cached;
 *   services/nuc/nucgeo.geometry_record_states): 1 carries it, 0 carries it partly or not at all, '.' no call there
 *   or not spanned, as the scan maps them.
 */
import { registerFeatureKind, type FeatureRef } from '../../stores/featureStore';
import { registerHubProvider, hitSelectionEntry, selectionRefs, type HubView } from '../hub/hubState';
import { datasetGroups, dsKey, overlapsView } from '../hub/providers';
import type { FeatureHit, FeatureSet, FeatureTypeDecl, HitValue } from '../hub/types';
import { useBrowserStore, type BrowserState } from '../../stores/browserStore';
import { sameChrom } from '../../utils/chromAliases';
import { nucGeoColor, type NucPatchKind } from '../../utils/nucLayers';
import { useNucGeoRuns, type NucGeoRun } from './geoRuns';
import type { NucGeometryResult, NucGeometryRow } from './types';

export const GEO_KIND = 'nuc-geometry';
export const GEO_TYPE_ID = 'nuc.geometry';

/** The scan's declaration (fiberhmm.scan.modules.nuc), plus the density-matched share the panel computes. */
export const GEO_TYPE: FeatureTypeDecl = {
  typeId: GEO_TYPE_ID, module: 'browser:nuc', label: 'Shared regularity geometry', plural: 'Shared regularity geometries',
  provides: ['hit', 'state'], anchor: 'centre', zeroWidth: false,
  scores: [
    { name: 'share', label: 'Share of molecules carrying it', kind: 'fraction', better: 'high', perGroup: true },
    { name: 'share_dm', label: 'Share, m6A density matched', kind: 'fraction', better: 'high', perGroup: true },
  ],
  stateRule: '1: the molecule has a member patch; 0: its tiles cover the span with calls and no member patch (or it carries the geometry only partly); .: no call (over half the tiles there unscored) or not spanned',
  roles: { prevalence: 'share_dm' },
};

export const geoKindOf = (g: Pick<NucGeometryRow, 'kind'>): NucPatchKind => g.kind ?? 'high';
export const geoHitId = (g: Pick<NucGeometryRow, 'hitId' | 'kind' | 'start' | 'end'>) =>
  g.hitId ?? `${geoKindOf(g) === 'low' ? 'geometry-low' : 'geometry'}:${g.start}-${g.end}`;
/** A geometry's colour: its root's number within its kind (warm high, cool low), as in the panel and the read lane. */
export const geoColour = (g: NucGeometryRow, index: number) =>
  nucGeoColor(g.rootNumber ?? (g.parentIndex != null ? g.parentIndex + 1 : index + 1), geoKindOf(g));
export const geoSetId = (panelId: string) => `browser:nuc-geometry:${panelId}`;

/** A geometry's carriers, molecules and callable molecules per dataset, each molecule once: the server's per-dataset counts (over its
 * deduplicated molecules); an older answer without them sums its series (`seriesDataset`: series id -> dataset). */
export function geoDatasetCounts(g: Pick<NucGeometryRow, 'perDataset' | 'perObservation'>,
  seriesDataset: Record<string, string>): Record<string, { full: number; molecules: number; callable: number }> {
  const out: Record<string, { full: number; molecules: number; callable: number }> = {};
  if (g.perDataset) {
    for (const [ds, c] of Object.entries(g.perDataset)) if (Object.values(seriesDataset).includes(ds)) out[ds] = { full: c.full, molecules: c.molecules, callable: c.callable ?? 0 };
    return out;
  }
  for (const [obsId, o] of Object.entries(g.perObservation)) {
    const ds = seriesDataset[obsId];
    if (!ds) continue;
    const acc = out[ds] ?? (out[ds] = { full: 0, molecules: 0, callable: 0 });
    acc.full += o.full; acc.molecules += o.molecules; acc.callable += o.callable ?? 0;
  }
  return out;
}

/** A geometry's chromosome: its own (an analysis over observations on several chromosomes pools each apart and says
 * which one each geometry is on), else the run's window's (an older answer, or a single-chromosome one). */
export function geoChrom(g: Pick<NucGeometryRow, 'chrom'>, result: Pick<NucGeometryResult, 'window'>): string {
  return (typeof g.chrom === 'string' && g.chrom) ? g.chrom : result.window?.chrom ?? '';
}

/** One geometry of a panel's run as a hub hit (its stateSpec replays the run's request). */
export function geoHit(run: NucGeoRun, g: NucGeometryRow): FeatureHit {
  const chrom = geoChrom(g, run.result);
  const per = geoDatasetCounts(g, run.seriesDataset);
  let full = 0, molecules = 0, callable = 0;
  for (const acc of Object.values(per)) { full += acc.full; molecules += acc.molecules; callable += acc.callable; }
  // The hub's prevalence column is share_dm, as fiberhmm-scan writes it: carriers among callable molecules (carrying,
  // partly carrying or absent), per dataset m6A density matched across datasets (scores rise with density; one
  // dataset: the plain callable share), and for the pooled 'all' group the plain callable share (same denominator,
  // nothing to match). A dataset without a matched estimate has no prevalence (never the raw share in its place).
  // The raw share of all molecules is kept beside it as `share`.
  const pooledRaw = molecules ? full / molecules : null;
  const pooledDm = callable ? full / callable : null;
  const values: Record<string, Record<string, HitValue>> = { all: { prevalence: { v: pooledDm, n: molecules },
    share: { v: pooledRaw, n: molecules }, ...(pooledDm != null ? { share_dm: { v: pooledDm, n: molecules } } : {}) } };
  for (const [ds, acc] of Object.entries(per)) {
    const raw = acc.molecules ? acc.full / acc.molecules : null;
    const dmRaw = g.densityMatched?.[ds];
    const dm = typeof dmRaw === 'number' && Number.isFinite(dmRaw) ? dmRaw : null;
    values[dsKey(ds)] = { prevalence: { v: dm, n: acc.molecules }, share: { v: raw, n: acc.molecules },
      ...(dm != null ? { share_dm: { v: dm, n: acc.molecules } } : {}) };
  }
  return {
    hitId: geoHitId(g), setId: geoSetId(run.panelId), typeId: GEO_TYPE_ID, frame: { kind: 'linear', chrom }, chrom,
    start: g.start, end: g.end, anchor: Math.floor((g.start + g.end) / 2), label: g.id,
    scores: { share: pooledRaw }, values,
    flags: [...(g.openLeft || g.openRight ? ['open_end'] : []), geoKindOf(g)],
    detail: { kind: geoKindOf(g), parent: g.parent ?? '', width: g.width, molecules: g.molecules, patches: g.patches,
      start_mad: g.startMad, end_mad: g.endMad, P: g.period > 0 ? g.period : '' },
    stateSpec: { kind: GEO_KIND, geometryId: g.geometryId, request: run.request },
    link: { panel: 'nucleosomes', payload: { panelId: run.panelId, geometry: g.id } },
  };
}

export function geoSet(s: BrowserState, run: NucGeoRun, hits: FeatureHit[]): FeatureSet {
  const w = run.result.window!;
  // Observations on several chromosomes: each geometry is on its own (its hit's chrom); the territory is not one region.
  const multi = (run.result.chromosomes?.length ?? 1) > 1;
  const label = s.panels.find(p => p.id === run.panelId) ? 'Nucleosome panel' : 'Nucleosomes';
  return {
    setId: geoSetId(run.panelId), typeId: GEO_TYPE_ID, type: GEO_TYPE, frame: { kind: 'linear', chrom: w.chrom },
    datasets: run.datasets, groups: datasetGroups(s, run.datasets), coverage: multi ? { territory: 'regions' } : { territory: 'regions', ref: `${w.chrom}:${w.start}-${w.end}` },
    count: hits.length, status: 'complete', source: { kind: 'inline', hits },
    provenance: { producer: 'browser', module: 'nuc-geometries', inputs: run.datasets, units: 'regions',
      summary: `${label} · regularity geometries (high and low; per-dataset shares m6A density matched) · ${w.chrom}:${w.start.toLocaleString()}-${w.end.toLocaleString()}` },
  };
}

function geoSets(s: BrowserState, view: HubView): FeatureSet[] {
  const out: FeatureSet[] = [];
  for (const run of Object.values(useNucGeoRuns.getState().runs)) {
    if (!run.result.window || !run.result.geometries.length) continue;
    // each geometry on its own chromosome
    const hits = run.result.geometries.filter(g => overlapsView(geoChrom(g, run.result), g.start, g.end, view)).map(g => geoHit(run, g));
    if (hits.length) out.push(geoSet(s, run, hits));
  }
  return out;
}

/** The toolbar selection's ref of a geometry: the same identity a hub selection of its hit gives (selectionRefs). */
export function geoFeatureRef(s: BrowserState, run: NucGeoRun, g: NucGeometryRow, index: number): FeatureRef {
  const hit = geoHit(run, g);
  const ref = selectionRefs([hitSelectionEntry(geoSet(s, run, [hit]), hit)])[0];
  return { ...ref, colour: geoColour(g, index) };
}

let registered = false;
export function registerGeometryFeatures(): void {
  if (registered) return;
  registered = true;
  registerFeatureKind({
    kind: GEO_KIND, typeId: GEO_TYPE_ID, layerLabel: 'regularity patches', pluralName: 'regularity geometries', listOrder: 3,
    stateNote: 'geometries: carried or not', layerNote: 'regularity geometries on the regularity layer',
    groupingNote: 'the nucleosome panel\'s "Group reads" buttons',
    shortName: f => f.label || f.id.replace(/^geometry(-low)?:/, ''),
    regionMode: () => 'nuc.reg',
  });
  registerHubProvider({ id: 'nuc-geometries', sets: geoSets, subscribe: fn => useNucGeoRuns.subscribe(fn) });
}

/**
 * A panel's new geometry run: toolbar selections of its earlier run's geometries carry that run's request (the
 * stateSpec the server replays), which the server refuses once the panel's settings moved on. Each selected geometry
 * of this panel is matched in the new run (its stable id, else the same kind with both ends within the grouping
 * tolerance, as the Saved list matches) and re-selected with the new run's request; one that is gone is dropped.
 */
/** Fields of a geometry request that are not its settings: the observations it pools, and the request's routing
 * (which panel/tab asked, whether it may move the lanes), which never change what a replay computes. */
const NOT_SETTINGS = new Set(['observations', 'requestScope', 'adopt', 'relabel']);

/** Canonical JSON: object keys sorted at every depth (undefined members dropped, as JSON.stringify drops them). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(x => (x === undefined || typeof x === 'function' ? 'null' : canonicalJson(x))).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter(k => o[k] !== undefined && typeof o[k] !== 'function')
    .map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/** A geometry request's settings (everything but its observations and routing, nested settings included), for
 * comparing two requests. */
export function settingsOf(request: unknown): string {
  if (!request || typeof request !== 'object') return 'null';
  const rest = Object.fromEntries(Object.entries(request as Record<string, unknown>).filter(([k]) => !NOT_SETTINGS.has(k)));
  return canonicalJson(rest);
}

export function reconcileGeoSelection(run: NucGeoRun): void {
  const s = useBrowserStore.getState();
  const src = geoSetId(run.panelId);
  if (!s.selectedFeatures.some(f => f.source === src)) return;
  const G = run.result.geometries;
  const tolRaw = Number(run.result.params?.geometry?.tol_bp);
  const tol = Number.isFinite(tolRaw) && tolRaw >= 0 ? tolRaw : 500;
  let changed = false;
  const next = s.selectedFeatures.flatMap(f => {
    if (f.source !== src) return [f];
    const spec = f.hubHit?.stateSpec as { geometryId?: string; request?: unknown } | undefined;
    let i = G.findIndex(g => g.geometryId === spec?.geometryId);
    if (i < 0 && f.start != null && f.end != null) {
      const kind: NucPatchKind = f.id.startsWith('geometry-low:') ? 'low' : 'high';
      let best = Infinity;
      G.forEach((g, j) => {
        const d = Math.abs(g.start - f.start!) + Math.abs(g.end - f.end!);
        if (f.chrom && !sameChrom(geoChrom(g, run.result), f.chrom)) return;   // the same chromosome only
        if (geoKindOf(g) === kind && Math.abs(g.start - f.start!) <= tol && Math.abs(g.end - f.end!) <= tol && d < best) { best = d; i = j; }
      });
    }
    // A geometry on a chromosome the new run does not cover (the panel moved to another chromosome) stays selected
    // with its own request (a replay computes with it); one gone from a chromosome the run covers is dropped.
    if (i < 0 && f.chrom && !G.some(g => sameChrom(geoChrom(g, run.result), f.chrom!))) return [f];
    if (i < 0) { changed = true; return []; }
    const ref = geoFeatureRef(s, run, G[i], i);
    // Only when the geometry moved or the settings it was found with changed (the server refuses those): a new
    // request over other series (a cluster run, a filter) with the same settings replays as it is, and churning the
    // selection would stop a running Cluster refinement or add an undo step.
    if (ref.id !== f.id || settingsOf(spec?.request) !== settingsOf(run.request)) { changed = true; return [ref]; }
    return [f];
  });
  if (changed) s.setSelectedFeatures(next);
}

/** The panel's run found no geometries: its toolbar selections name nothing any more. */
export function dropGeoSelection(panelId: string): void {
  const s = useBrowserStore.getState();
  const src = geoSetId(panelId);
  if (s.selectedFeatures.some(f => f.source === src)) s.setSelectedFeatures(s.selectedFeatures.filter(f => f.source !== src));
}
