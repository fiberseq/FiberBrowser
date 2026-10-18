export interface ReadWithId {
  id: string;
  analysis_id?: string;
}

export function stripSegmentSuffix(readId: string): string {
  return readId.replace(/_\d+$/, '');
}

export function clusterAssignmentForRead(
  assignments: Record<string, number>,
  readId: string,
): number | undefined {
  return assignments[readId] ?? assignments[stripSegmentSuffix(readId)];
}

export function clusteredReadIdSet(
  assignments: Record<string, number>,
): Set<string> | null {
  const ids = Object.keys(assignments);
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
  return read.analysis_id ? [read.id, read.analysis_id] : [read.id];
}
