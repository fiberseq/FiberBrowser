import type { ProjectionResponse } from '../api/clustering';
import type { LayerQualityFilter } from '../types';
import { analysisSettingsKey } from '../hooks/useAnalysisSettingsKey';
import { remapDatasetIds } from '../stores/historySlice';
import { normalizeClusterFeatureRules } from '../stores/utils';
import { normalizeAnnotationLayer } from './layerAliases';

/**
 * Per-read projection table: the Projection tab's Export, the projection
 * columns of the cluster-assignment export, and the session's copy.
 * The Python client (browser_client.projection_table_from_response /
 * write_projection_table) writes the same columns and header.
 */
export const PROJECTION_TABLE_COLUMNS = [
  'read_name', 'dataset', 'strand', 'alignment_strand', 'cluster', '{method}_x', '{method}_y', 'embedded',
] as const;

export function projectionTableColumns(method: string): string[] {
  return PROJECTION_TABLE_COLUMNS.map(c => c.replace('{method}', method || 'projection'));
}

function headerValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string' || typeof value === 'number') return String(value).replace(/[\t\r\n]+/g, ' ');
  return JSON.stringify(value).replace(/[\t\r\n]+/g, ' ');
}

function cell(value: unknown): string {
  return value == null ? '' : String(value).replace(/[\t\r\n]+/g, ' ');
}

/**
 * How one request went (its time, whether the map came from the server's
 * cache), not what defines the map: an export refetches the shown map, so
 * they described the refetch ("seconds: 0.002, cache_hit: true").
 */
const REQUEST_ONLY_PARAMS = ['seconds', 'cache_hit'];

/** Everything that defines the map, as recorded in the export header. */
export function projectionParams(data: ProjectionResponse): Record<string, unknown> {
  const params: Record<string, unknown> = { ...(data.projection_params ?? {}) };
  for (const key of REQUEST_ONLY_PARAMS) delete params[key];
  if (params.method == null) params.method = data.method;
  if (params.random_state == null && data.projection_random_state != null) params.random_state = data.projection_random_state;
  if (params.sample_seed == null && data.sample_seed != null) params.sample_seed = data.sample_seed;
  if (data.skipped_datasets && data.skipped_datasets.length > 0) params.skipped_datasets = data.skipped_datasets;
  return params;
}

export type ProjectionView = 'before' | 'after' | 'side-by-side';

/** Each read's cluster after the autocull simulation, from `data` or else the shown map (by dataset and read). */
function labelsAfter(data: ProjectionResponse, shown?: ProjectionResponse | null): Array<number | undefined> | null {
  if (data.labels_after) return data.labels_after;
  if (!shown?.labels_after) return null;
  const after = new Map<string, number>();
  shown.read_ids.forEach((id, i) => after.set(`${shown.dataset_ids[i]}\t${id}`, shown.labels_after![i]));
  return data.read_ids.map((id, i) => after.get(`${data.dataset_ids[i]}\t${id}`));
}

/**
 * The per-read table as TSV, with the map's parameters as `# key: value` lines.
 * `view`: the grouping on show. With an autocull simulation (After, or side
 * by side), `cluster` is the shown one (After's, or Before's side by side)
 * and `cluster_before` / `cluster_after` give both; `shown` is the map on
 * show, whose After labels are used when `data` (a refetch) has none.
 */
export function formatProjectionTsv(
  data: ProjectionResponse,
  extra: Record<string, unknown> = {},
  options: { view?: ProjectionView; shown?: ProjectionResponse | null } = {},
): string {
  const view = options.view ?? 'before';
  const after = view === 'before' ? null : labelsAfter(data, options.shown);
  const shownCluster = after && view === 'after' ? 'after_autocull' : 'before';
  const params: Record<string, unknown> = { ...projectionParams(data), ...(after ? { cluster_column: shownCluster } : {}), ...extra };
  const header = [
    '# fiberbrowser_export: read_projection',
    ...Object.keys(params).sort().map(key => `# ${key}: ${headerValue(params[key])}`),
  ];
  const columns = projectionTableColumns(data.method);
  const lines = [(after ? [...columns, 'cluster_before', 'cluster_after'] : columns).join('\t')];
  for (let i = 0; i < data.read_ids.length; i++) {
    const row: unknown[] = [
      data.read_ids[i],
      data.dataset_ids[i],
      data.strands?.[i] ?? '',
      data.alignment_strands?.[i] ?? '',
      after && view === 'after' ? after[i] : data.labels_before[i],
      data.coords_x[i],
      data.coords_y[i],
      data.embedded ? (data.embedded[i] ? 'True' : 'False') : 'True',
    ];
    if (after) row.push(data.labels_before[i], after[i]);
    lines.push(row.map(cell).join('\t'));
  }
  return header.join('\n') + '\n' + lines.join('\n') + '\n';
}

export function projectionFilename(method: string, chrom: string, start: number, end: number): string {
  return `${method || 'projection'}_reads_${chrom}_${start}-${end}.tsv`;
}

/** A map's coordinates by dataset and read, kept for the other exports. */
export interface ReadProjectionIndex {
  method: string;
  chrom: string;
  start: number;
  end: number;
  /** The inputs that shape the map (see projectionInputSignature): another value means another map. */
  signature?: string;
  /**
   * The panel whose own view the map was drawn for (a locus of its own, Each
   * panel navigates, another assembly); absent or null: the main view.
   */
  panelId?: string | null;
  /** That view's reference (PanelConfig.genome); absent or null: the main genome. */
  genome?: string | null;
  params: Record<string, unknown>;
  /** datasetId -> readId -> [x, y] */
  coords: Record<string, Record<string, [number, number]>>;
}

/** The store state that decides a map's geometry (cluster labels only colour it). */
export interface ProjectionInputs {
  chrom: string;
  start: number;
  end: number;
  analysisSampleSeed?: string | null;
  subnucleosomalThreshold?: number;
  spanningOnly?: boolean;
  clusterFeatureRules?: unknown;
  clusterPeakRegions?: Array<{ start: number; end: number; mode?: string }>;
  selectedPeaks?: Set<number>;
  peakModes?: Record<number, string>;
  getAllPeaks?: () => Array<{ index: number; start: number; end: number }>;
  activeColormap?: { qualityFilters?: LayerQualityFilter[] };
  refreshGeneration?: number;
  legacyLayerInference?: boolean;
  legacyNucMinSize?: number;
  /** Which reads are mapped: their ids per panel (labels don't matter). */
  clusterAssignments?: Record<string, Record<string, number>>;
  /** The view's reference when it is a panel's own (another assembly); absent or null: the main genome. */
  genome?: string | null;
  /** The panels (to find the view a panel's map was drawn for). */
  panels?: Array<{ id: string; genome?: string; viewportOverride?: { chrom: string; start: number; end: number } }>;
}

/** A short, order-independent fingerprint of a set of read ids. */
function idSetFingerprint(ids: string[]): string {
  let h1 = 0x811c9dc5;
  let h2 = 0;
  for (const id of [...ids].sort()) {
    for (let i = 0; i < id.length; i++) {
      h1 = Math.imul(h1 ^ id.charCodeAt(i), 0x01000193) >>> 0;
      h2 = (h2 * 31 + id.charCodeAt(i)) >>> 0;
    }
    h1 = Math.imul(h1 ^ 0x2c, 0x01000193) >>> 0;
  }
  return `${ids.length}:${h1.toString(16)}:${h2.toString(16)}`;
}

/**
 * Everything that shapes a map's geometry: region, seed, threshold, cluster
 * rules, the peaks (with their modes), the read-loading settings and which
 * reads are mapped. Taken when the projection is requested and again at export.
 */
export function projectionInputSignature(s: ProjectionInputs): string {
  return JSON.stringify(signatureParts(s));
}

/** The signature's parts, in order (SETTINGS_PART and COHORT_PART are compared loosely across a restore). */
function signatureParts(s: ProjectionInputs): unknown[] {
  const regions = s.clusterPeakRegions ?? [];
  // Without the clustering's own peaks the map is of the selected peaks, by position and mode.
  const selected = regions.length > 0 ? [] : (() => {
    const all = s.getAllPeaks?.() ?? [];
    return [...(s.selectedPeaks ?? [])].sort((a, b) => a - b).map(index => {
      const peak = all.find(p => p.index === index);
      return [index, peak?.start ?? null, peak?.end ?? null, s.peakModes?.[index] ?? 'accessibility'];
    });
  })();
  const cohort = Object.keys(s.clusterAssignments ?? {}).sort()
    .map(key => [key, idSetFingerprint(Object.keys(s.clusterAssignments![key] ?? {}))]);
  return [
    s.chrom, s.start, s.end, s.analysisSampleSeed ?? null, s.subnucleosomalThreshold ?? null, !!s.spanningOnly,
    s.clusterFeatureRules ?? [], regions.map(r => [r.start, r.end, r.mode ?? 'accessibility']), selected,
    analysisSettingsKey(s.refreshGeneration ?? 0, !!s.legacyLayerInference, s.legacyNucMinSize ?? 0,
      s.activeColormap?.qualityFilters ?? []),
    cohort,
    // A view on another assembly: its reference (main-genome maps keep their earlier signature).
    ...(s.genome ? [s.genome] : []),
  ];
}

/**
 * The inputs of the view a map was drawn for, as that view is now: its
 * panel's own locus and reference (a panel moved on its own, or on another
 * assembly), else the main view. null: the panel is gone, or is now on
 * another reference than the map's.
 */
export function projectionViewInputs<I extends ProjectionInputs>(
  projection: Pick<ReadProjectionIndex, 'panelId' | 'genome'>,
  inputs: I,
): I | null {
  if (!projection.panelId) return projection.genome ? null : { ...inputs, genome: null };
  const panel = inputs.panels?.find(p => p.id === projection.panelId);
  if (!panel || (panel.genome ?? null) !== (projection.genome ?? null)) return null;
  const v = panel.viewportOverride ?? { chrom: inputs.chrom, start: inputs.start, end: inputs.end };
  return { ...inputs, chrom: v.chrom, start: v.start, end: v.end, genome: panel.genome ?? null };
}
const RULES_PART = 6;
const SETTINGS_PART = 9;
const COHORT_PART = 10;

/** A dataset id or state key (`<id>` or `<id>:…`) under the reopened ids (as historySlice.remapDatasetIds). */
function remapKey(id: string, idMap: Record<string, string>): string {
  if (Object.prototype.hasOwnProperty.call(idMap, id)) return idMap[id];
  const colon = id.indexOf(':');
  const head = colon > 0 ? id.slice(0, colon) : '';
  return head && Object.prototype.hasOwnProperty.call(idMap, head) ? idMap[head] + id.slice(colon) : id;
}

/**
 * Cluster rules as far as they shape the map: their terms, scope and on/off
 * (not their names or rule and term ids), in the form a save and an import give them (each
 * normalizes again and fills in defaults: twice reaches the fixed form).
 */
function ruleGeometry(rules: unknown): string {
  const normal = normalizeClusterFeatureRules(normalizeClusterFeatureRules(rules));
  // A term without an id gets a new random one each time: its id is not part of what it selects.
  return JSON.stringify(normal.map(r => [r.enabled, r.scope, r.terms.map(({ id: _id, ...term }) => term)]));
}

/**
 * Was a saved map made from these (restored) inputs? Its signature, taken
 * when it was computed, must match them except for what a restore itself
 * changes: the page's refresh counter, the datasets' ids (`idMap`, old ->
 * reopened: the cohort's keys and the ids inside cluster rules), and how the
 * cluster rules are written down (normalized again on save and import). A map
 * saved before sessions kept only current maps can be stale (another
 * threshold, other peaks); unsigned, it can't be checked.
 */
export function savedSignatureMatches(saved: unknown, inputs: ProjectionInputs, idMap: Record<string, string> = {}): boolean {
  if (typeof saved !== 'string') return false;
  let parts: unknown;
  try { parts = JSON.parse(saved); } catch { return false; }
  const now = signatureParts(inputs);
  if (!Array.isArray(parts) || parts.length !== now.length) return false;
  const settings = (key: unknown): string | null => {
    if (typeof key !== 'string') return null;
    try {
      const v = JSON.parse(key);
      if (!Array.isArray(v)) return null;
      // Without the refresh counter; quality-filter layers under their current names (an import renames old aliases).
      const [, legacy, nucMin, filters] = v;
      const named = Array.isArray(filters)
        ? filters.map(f => (Array.isArray(f) ? [normalizeAnnotationLayer(f[0]) ?? f[0], ...f.slice(1)] : f))
        : filters;
      return JSON.stringify([legacy, nucMin, named]);
    } catch { return null; }
  };
  // Which reads each panel maps, by panel key (the saved keys under the reopened ids).
  const cohort = (c: unknown, map: Record<string, string>): string | null => {
    if (!Array.isArray(c) || !c.every(e => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string')) return null;
    const rows = (c as Array<[string, unknown]>).map(([key, reads]): [string, unknown] => [remapKey(key, map), reads]);
    return JSON.stringify(rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
  };
  const savedParts = parts;
  return now.every((part, i) => {
    if (i === SETTINGS_PART) return settings(savedParts[i]) !== null && settings(savedParts[i]) === settings(part);
    if (i === COHORT_PART) return cohort(savedParts[i], idMap) !== null && cohort(savedParts[i], idMap) === cohort(part, {});
    // (Remapped as the restore remaps the state's own rules.)
    if (i === RULES_PART) return ruleGeometry(remapDatasetIds({ clusterFeatureRules: savedParts[i] }, idMap).clusterFeatureRules) === ruleGeometry(part);
    return JSON.stringify(savedParts[i]) === JSON.stringify(part);
  });
}

/** The kept map, if it is still the map of the current inputs. */
export function currentReadProjection(
  projection: ReadProjectionIndex | null | undefined,
  inputs: ProjectionInputs,
): ReadProjectionIndex | null {
  if (!projection) return null;
  // Compared with the view it was drawn for (a panel's own, else the main view).
  const view = projectionViewInputs(projection, inputs);
  if (!view) return null;
  if (projection.chrom !== view.chrom || projection.start !== view.start || projection.end !== view.end) return null;
  if (projection.signature != null && projection.signature !== projectionInputSignature(view)) return null;
  return projection;
}

export function indexProjection(
  data: ProjectionResponse,
  region: { chrom: string; start: number; end: number; panelId?: string | null; genome?: string | null },
  signature?: string,
): ReadProjectionIndex {
  const coords: Record<string, Record<string, [number, number]>> = {};
  for (let i = 0; i < data.read_ids.length; i++) {
    const ds = data.dataset_ids[i];
    (coords[ds] ??= {})[data.read_ids[i]] = [data.coords_x[i], data.coords_y[i]];
  }
  const { panelId, genome, ...locus } = region;
  return {
    method: data.method, ...locus,
    ...(panelId ? { panelId } : {}), ...(genome ? { genome } : {}),
    ...(signature != null ? { signature } : {}), params: projectionParams(data), coords,
  };
}

/**
 * The kept map to carry in a save (a session file, the autosave that "reopen
 * last session" restores): only while it is still the map of the current inputs.
 */
export function projectionForSave(
  s: ProjectionInputs & { readProjection?: ReadProjectionIndex | null },
): ReadProjectionIndex | null {
  return currentReadProjection(s.readProjection, s);
}

/**
 * A saved map back in a restored workspace: its datasets under their new ids
 * (`idMap`, the reopened datasets), signed with the restored inputs. The
 * signature's refresh counter is the page's own (a restore bumps it), so the
 * saved one never matches as is: it is checked against the restored inputs
 * without the counter and the dataset ids (savedSignatureMatches), so a map
 * an older version saved after its inputs had changed is dropped, not made
 * current again.
 */
export function restoreSavedProjection(
  saved: unknown,
  idMap: Record<string, string>,
  inputs: ProjectionInputs,
): ReadProjectionIndex | null {
  if (!saved || typeof saved !== 'object') return null;
  const p = saved as ReadProjectionIndex;
  if (typeof p.chrom !== 'string' || typeof p.start !== 'number' || typeof p.end !== 'number' || !p.coords || typeof p.coords !== 'object') return null;
  // The view it was drawn for, restored: its panel's own (panel ids survive a restore), else the main view.
  const view = projectionViewInputs(p, inputs);
  if (!view) return null;
  if (p.chrom !== view.chrom || p.start !== view.start || p.end !== view.end) return null;
  if (!savedSignatureMatches(p.signature, view, idMap)) return null;
  const coords: ReadProjectionIndex['coords'] = {};
  for (const [ds, reads] of Object.entries(p.coords)) coords[idMap[ds] ?? ds] = reads;
  return { ...p, coords, signature: projectionInputSignature(view) };
}
