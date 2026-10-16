import type { ReadProjectionIndex } from './projectionExport';

type AssignmentMap = Record<string, number>;

interface ExportDataset {
  id: string;
  label?: string;
}

interface ExportPanel {
  id: string;
  contentType?: string;
  datasetId?: string | null;
  stateKey?: string | null;
  layoutRow?: number;
  layoutColumn?: number;
}

export interface ClusterAssignmentRow {
  read_id: string;
  dataset: string;
  cluster: number;
  /** The group's name from its source (an SV allele split's "Carriers"). */
  group?: string;
  pattern?: string;
  viewer_order: number;
  /** Map position from the Projection tab, when that map covers the read. */
  projection_x?: number;
  projection_y?: number;
}

interface ClusterAssignmentExportOptions {
  clusterAssignments: Record<string, AssignmentMap>;
  clusterPatterns?: Record<number, number[]> | Record<string, number[]>;
  datasets?: ExportDataset[];
  panels?: ExportPanel[];
  readSortOrder?: Record<string, string[]>;
  clusterOrder?: Record<string, number[]>;
  activeReadIds?: Record<string, string[]>;
  jupyterReadOrder?: Record<string, string[]>;
  provenance?: Record<string, unknown>;
  /** The Projection tab's latest map: adds <method>_x / <method>_y columns. */
  projection?: ReadProjectionIndex | null;
  /** Group names per state key (stores/svSlice.ts clusterGroupLabels): adds a `group` column. */
  clusterGroupLabels?: Record<string, Record<number, string>>;
}

function rankMap<T>(items: T[] | undefined): Map<T, number> {
  return new Map((items ?? []).map((item, i) => [item, i]));
}

function lookupOrder(
  record: Record<string, string[]> | undefined,
  stateKey: string,
  datasetId: string,
): string[] {
  return record?.[stateKey] ?? record?.[datasetId] ?? [];
}

function lookupClusterOrder(
  record: Record<string, number[]> | undefined,
  stateKey: string,
  datasetId: string,
): number[] {
  return record?.[stateKey] ?? record?.[datasetId] ?? [];
}

export function resolveDatasetForStateKey(
  stateKey: string,
  datasets: ExportDataset[] = [],
  panels: ExportPanel[] = [],
): { datasetId: string; label: string } {
  const panel = panels.find(p => {
    if (p.contentType && p.contentType !== 'dataset') return false;
    return (p.stateKey ?? p.datasetId) === stateKey || p.id === stateKey;
  });
  const datasetId = panel?.datasetId ?? stateKey;
  const dataset = datasets.find(d => d.id === datasetId) ?? datasets.find(d => d.id === stateKey);
  return { datasetId, label: dataset?.label ?? datasetId };
}

export function orderStateKeysForExport(
  clusterAssignments: Record<string, AssignmentMap>,
  datasets: ExportDataset[] = [],
  panels: ExportPanel[] = [],
): string[] {
  const keys = new Set(Object.keys(clusterAssignments));
  const ordered: string[] = [];
  const push = (key: string | null | undefined) => {
    if (!key || !keys.has(key) || ordered.includes(key)) return;
    ordered.push(key);
  };

  [...panels]
    .filter(p => !p.contentType || p.contentType === 'dataset')
    .sort((a, b) =>
      (a.layoutRow ?? 0) - (b.layoutRow ?? 0) ||
      (a.layoutColumn ?? 0) - (b.layoutColumn ?? 0)
    )
    .forEach(p => push(p.stateKey ?? p.datasetId));

  datasets.forEach(d => push(d.id));
  Object.keys(clusterAssignments).forEach(push);
  return ordered;
}

export function orderAssignmentReadIds(
  stateKey: string,
  assignments: AssignmentMap,
  options: Omit<ClusterAssignmentExportOptions, 'clusterAssignments' | 'clusterPatterns'> = {},
): string[] {
  const ids = Object.keys(assignments);
  const inputRank = rankMap(ids);
  const { datasetId } = resolveDatasetForStateKey(stateKey, options.datasets, options.panels);
  const jupyterOrder = lookupOrder(options.jupyterReadOrder, stateKey, datasetId);
  const readSortOrder = lookupOrder(options.readSortOrder, stateKey, datasetId);
  const activeReadOrder = lookupOrder(options.activeReadIds, stateKey, datasetId);
  const myClusterOrder = lookupClusterOrder(options.clusterOrder, stateKey, datasetId);

  const byInput = (a: string, b: string) => (inputRank.get(a) ?? 0) - (inputRank.get(b) ?? 0);

  if (jupyterOrder.length > 0) {
    const rank = rankMap(jupyterOrder);
    return [...ids].sort((a, b) => {
      const diff = (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER);
      return diff || byInput(a, b);
    });
  }

  if (readSortOrder.length > 0 && myClusterOrder.length > 0) {
    const readRank = rankMap(readSortOrder);
    const clusterRank = rankMap(myClusterOrder);
    return [...ids].sort((a, b) => {
      const ca = assignments[a] ?? Number.MAX_SAFE_INTEGER;
      const cb = assignments[b] ?? Number.MAX_SAFE_INTEGER;
      const clusterDiff = (clusterRank.get(ca) ?? Number.MAX_SAFE_INTEGER) - (clusterRank.get(cb) ?? Number.MAX_SAFE_INTEGER);
      if (clusterDiff !== 0) return clusterDiff;
      const readDiff = (readRank.get(a) ?? Number.MAX_SAFE_INTEGER) - (readRank.get(b) ?? Number.MAX_SAFE_INTEGER);
      return readDiff || byInput(a, b);
    });
  }

  if (readSortOrder.length > 0) {
    const rank = rankMap(readSortOrder);
    return [...ids].sort((a, b) => {
      const diff = (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER);
      return diff || byInput(a, b);
    });
  }

  if (activeReadOrder.length > 0) {
    const rank = rankMap(activeReadOrder);
    return [...ids].sort((a, b) => {
      const diff = (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER);
      return diff || byInput(a, b);
    });
  }

  if (myClusterOrder.length > 0) {
    const clusterRank = rankMap(myClusterOrder);
    return [...ids].sort((a, b) => {
      const diff = (clusterRank.get(assignments[a]) ?? Number.MAX_SAFE_INTEGER) - (clusterRank.get(assignments[b]) ?? Number.MAX_SAFE_INTEGER);
      return diff || byInput(a, b);
    });
  }

  return [...ids].sort((a, b) => {
    const diff = (assignments[a] ?? Number.MAX_SAFE_INTEGER) - (assignments[b] ?? Number.MAX_SAFE_INTEGER);
    return diff || byInput(a, b);
  });
}

export function buildClusterAssignmentRows(options: ClusterAssignmentExportOptions): ClusterAssignmentRow[] {
  const rows: ClusterAssignmentRow[] = [];
  let viewerOrder = 1;
  const stateKeys = orderStateKeysForExport(options.clusterAssignments, options.datasets, options.panels);

  for (const stateKey of stateKeys) {
    const assignments = options.clusterAssignments[stateKey];
    if (!assignments) continue;
    const { label, datasetId } = resolveDatasetForStateKey(stateKey, options.datasets, options.panels);
    const orderedReadIds = orderAssignmentReadIds(stateKey, assignments, options);
    const coords = options.projection?.coords[datasetId] ?? options.projection?.coords[stateKey];
    for (const readId of orderedReadIds) {
      const cluster = assignments[readId];
      const patterns = options.clusterPatterns as Record<string, number[]> | undefined;
      const pattern = patterns?.[String(cluster)]?.join('');
      const xy = coords?.[readId];
      const group = options.clusterGroupLabels?.[stateKey]?.[cluster];
      rows.push({
        read_id: readId,
        dataset: label,
        cluster,
        ...(group ? { group } : {}),
        ...(pattern != null ? { pattern } : {}),
        viewer_order: viewerOrder++,
        ...(xy ? { projection_x: xy[0], projection_y: xy[1] } : {}),
      });
    }
  }

  return rows;
}

function tsvCell(value: string | number | undefined): string {
  return value == null ? '' : String(value).replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}

function provenanceValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
  }
  return JSON.stringify(value).replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}

function formatProvenanceComments(provenance: Record<string, unknown> | undefined): string {
  if (!provenance || Object.keys(provenance).length === 0) return '';
  const lines = [
    ['fiberbrowser_export', 'cluster_assignments'],
    ...Object.entries(provenance)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  ];
  return lines.map(([key, value]) => `# ${key}: ${provenanceValue(value)}`).join('\n') + '\n';
}

export function formatClusterAssignmentsTsv(options: ClusterAssignmentExportOptions): string {
  const rows = buildClusterAssignmentRows(options);
  const hasPatterns = Object.keys(options.clusterPatterns ?? {}).length > 0;
  // The map's columns only when it covers some of these reads (blank for the others).
  const projection = options.projection && rows.some(row => row.projection_x != null) ? options.projection : null;
  const hasGroups = rows.some(row => row.group);
  const header = [
    'read_id', 'dataset', 'cluster', ...(hasGroups ? ['group'] : []), ...(hasPatterns ? ['pattern'] : []), 'viewer_order',
    ...(projection ? [`${projection.method}_x`, `${projection.method}_y`] : []),
  ];
  const lines = [header.join('\t')];
  for (const row of rows) {
    const cells = [
      row.read_id, row.dataset, row.cluster, ...(hasGroups ? [row.group] : []), ...(hasPatterns ? [row.pattern] : []), row.viewer_order,
      ...(projection ? [row.projection_x, row.projection_y] : []),
    ];
    lines.push(cells.map(tsvCell).join('\t'));
  }
  const provenance = projection
    ? {
      ...options.provenance,
      ...Object.fromEntries(Object.entries(projection.params).map(([key, value]) => [`projection_${key}`, value])),
      projection_region: `${projection.chrom}:${projection.start}-${projection.end}`,
    }
    : options.provenance;
  return formatProvenanceComments(provenance) + lines.join('\n') + '\n';
}
