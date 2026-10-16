/**
 * Per-dataset read states for the transcription-state summaries, which are
 * reported per dataset while cluster focus lives per panel (a copy of a
 * dataset can focus other clusters). Each dataset's panels are combined:
 * reads counted once, and the dataset's focus is the union of its panels'
 * focused reads, or none when any of its panels shows every read.
 */
export function readStatesByDataset<S>(
  stateKeys: string[],
  stateKeyToDataset: Record<string, string>,
  readStates: Record<string, Record<string, S> | undefined>,
  focusedReadIds: Record<string, Set<string> | null | undefined>,
): Record<string, { states: Record<string, S>; focus: Set<string> | null }> {
  const out: Record<string, { states: Record<string, S>; focus: Set<string> | null }> = {};
  for (const sk of stateKeys) {
    const dsId = stateKeyToDataset[sk] || sk;
    const states = readStates[sk];
    if (!states) continue;
    const focus = focusedReadIds[sk] ?? null;
    const entry = out[dsId];
    if (!entry) {
      out[dsId] = { states: { ...states }, focus: focus ? new Set(focus) : null };
      continue;
    }
    Object.assign(entry.states, states);
    if (!focus || !entry.focus) entry.focus = null;
    else for (const id of focus) entry.focus.add(id);
  }
  return out;
}

/**
 * Reads whose elongating Pol II count lies in [min, max] (max null: no upper
 * bound), within each dataset's focus. Null when no read states are loaded.
 */
export function countElongatingInRange(
  byDataset: Record<string, { states: Record<string, { elongating_count: number }>; focus: Set<string> | null }>,
  min: number,
  max: number | null,
): number | null {
  let seen = false;
  let n = 0;
  for (const { states, focus } of Object.values(byDataset)) {
    for (const [readId, rs] of Object.entries(states)) {
      seen = true;
      if (focus && !focus.has(readId)) continue;
      const c = rs.elongating_count;
      if (c >= min && (max == null || c <= max)) n += 1;
    }
  }
  return seen ? n : null;
}

/**
 * The cohorts for per-cluster statistics: one per distinct clustering. Panels
 * of a dataset with the same assignments are one cohort (their reads count
 * once); a copy clustered on its own is its own cohort, never pooled with the
 * other (a read can be in cluster 1 in one and cluster 0 in the other).
 */
export function clusterCohorts(
  stateKeys: string[],
  stateKeyToDataset: Record<string, string>,
  clusterAssignments: Record<string, Record<string, number> | undefined>,
): Array<{ datasetId: string; stateKey: string; copyIndex: number }> {
  const out: Array<{ datasetId: string; stateKey: string; copyIndex: number }> = [];
  const seen: Record<string, string[]> = {};
  for (const sk of stateKeys) {
    const assignments = clusterAssignments[sk];
    if (!assignments) continue;
    const dsId = stateKeyToDataset[sk] || sk;
    const signature = Object.keys(assignments).sort().map(id => `${id}:${assignments[id]}`).join('|');
    const signatures = (seen[dsId] ??= []);
    if (signatures.includes(signature)) continue;
    signatures.push(signature);
    out.push({ datasetId: dsId, stateKey: sk, copyIndex: signatures.length - 1 });
  }
  return out;
}
