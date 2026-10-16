/**
 * Cluster assignments live per panel state key, but the merge/dissolve API
 * takes them per dataset. Panels sharing a dataset (strand halves, copies)
 * each hold part of its reads, so the request carries their union and each
 * panel takes back only its own reads.
 */
export function assignmentsByDataset(
  stateKeys: string[],
  stateKeyToDs: Record<string, string>,
  clusterAssignments: Record<string, Record<string, number>>,
): Record<string, Record<string, number>> {
  const payload: Record<string, Record<string, number>> = {};
  for (const sk of stateKeys) {
    const dsId = stateKeyToDs[sk] || sk;
    payload[dsId] = { ...(payload[dsId] ?? {}), ...(clusterAssignments[sk] ?? {}) };
  }
  return payload;
}

/** The part of a dataset-wide result that belongs to one panel's reads. */
export function assignmentsForPanel(
  result: Record<string, number>,
  panelAssignments: Record<string, number> | undefined,
): Record<string, number> {
  if (!panelAssignments) return result;
  const out: Record<string, number> = {};
  for (const readId of Object.keys(panelAssignments)) {
    if (readId in result) out[readId] = result[readId];
  }
  return out;
}
