import { recordKey } from '../../../utils/recordKeys';

/** A read's place in a sort order (`orderIndex` of it): its cohort identity (lifted rows; the server's sort names
 * them so), else its id, else its record key (an order written in the graph view); unsorted reads last. */
export function sortRankOf(index: ReadonlyMap<string, number>, read: ReadWithId): number {
  return (read.analysis_id !== undefined ? index.get(read.analysis_id) : undefined) ?? index.get(read.id)
    ?? (read.analysis_id ? index.get(recordKey(read.analysis_id) ?? '') : undefined) ?? 999999;
}

export interface ReadWithId {
  id: string;
  analysis_id?: string;
  live_lift?: unknown;
}

export function stripSegmentSuffix(readId: string): string {
  return readId.replace(/_\d+$/, '');
}

export function clusterAssignmentForRead(
  assignments: Record<string, number>,
  read: string | ReadWithId,
): number | undefined {
  const readId = typeof read === 'string' ? read : read.analysis_id ?? read.id;
  const own = assignments[readId] ?? assignments[stripSegmentSuffix(readId)]
    ?? (typeof read !== 'string' && !read.live_lift ? assignments[read.id] : undefined);
  if (own !== undefined || typeof read === 'string') return own;
  // A display row with folded supplementaries (supplementary_display='fold') is coloured by its primary member's
  // cluster (its own analysis_id), else by the first member that has one.
  for (const id of foldedIds(read)) if (assignments[id] !== undefined) return assignments[id];
  // A graph run writes its labels under record keys (DESIGN_GRAPH_PRIMARY §3.1): a linear row of the same record
  // (its own chain placement and row index) reads its record's label.
  const rk = recordKey(read.analysis_id);
  if (rk && assignments[rk] !== undefined) return assignments[rk];
  return undefined;
}

/** Cohort identities of the records folded into a display row (live_lift.folded.analysis_ids). */
export function foldedIds(read: ReadWithId): string[] {
  const folded = (read.live_lift as { folded?: { analysis_ids?: unknown } } | undefined)?.folded;
  return Array.isArray(folded?.analysis_ids) ? folded!.analysis_ids.filter((id): id is string => typeof id === 'string') : [];
}

export function clusteredReadIdSet(
  assignments: Record<string, number>,
): Set<string> | null {
  const ids = Object.keys(assignments);
  // Labels that are all "not a carrier" (-2: a graph run's path without the regions' sequence) scope nothing: the
  // panel keeps every read, unlabelled ones as Unassigned (graph features review).
  if (ids.length > 0 && ids.every(id => assignments[id] === -2)) return null;
  return ids.length > 0 ? new Set(ids) : null;
}

export function filterReadsByReadIdSet<T extends ReadWithId>(
  reads: T[],
  readIds?: Set<string> | null,
): T[] {
  if (!readIds || readIds.size === 0) return reads;

  const expandedIds = new Set<string>();
  for (const id of readIds) {
    expandedIds.add(id);
    expandedIds.add(stripSegmentSuffix(id));
  }

  return reads.filter(read => (
    readIdKeys(read).some(id => expandedIds.has(id) || expandedIds.has(stripSegmentSuffix(id)))
  ));
}

export function filterReadsByBranchScope<T extends ReadWithId>(
  reads: T[],
  branchScopeActive: boolean,
  readIds?: Set<string> | null,
): T[] {
  if (!branchScopeActive) return reads;
  if (!readIds || readIds.size === 0) return [];
  return filterReadsByReadIdSet(reads, readIds);
}

/** A QNAME is a display label; analysis identity can represent several rows. */
export function readIdKeys(read: ReadWithId): string[] {
  const keys = read.analysis_id ? [read.id, read.analysis_id] : [read.id];
  // A folded row is kept by any member's identity, as on the server (read_id_keys).
  for (const id of foldedIds(read)) if (!keys.includes(id)) keys.push(id);
  // And by its record key (DESIGN_GRAPH_PRIMARY §3.1): an id set written in the graph view names the record.
  for (const id of keys.slice(1)) { const rk = recordKey(id); if (rk && !keys.includes(rk)) keys.push(rk); }
  return keys;
}
