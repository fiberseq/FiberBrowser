/**
 * Dissolve / merge requests take one assignment map per dataset. Two panels of
 * the same dataset (copies with their own clusters) would collide in one
 * request, so they are sent in rounds: each round holds at most one panel per
 * dataset, and its results go back to exactly those panels.
 */
export interface ClusterOperationRound {
  /** datasetId -> the panel state key this round sends for it. */
  keyByDataset: Record<string, string>;
  /** datasetId -> that panel's assignments (the request payload). */
  assignments: Record<string, Record<string, number>>;
}

export function clusterOperationRounds(
  stateKeys: string[],
  stateKeyToDs: Record<string, string>,
  clusterAssignments: Record<string, Record<string, number> | undefined>,
): ClusterOperationRound[] {
  const rounds: ClusterOperationRound[] = [];
  for (const sk of stateKeys) {
    const dsId = stateKeyToDs[sk] || sk;
    let round = rounds.find(r => !(dsId in r.keyByDataset));
    if (!round) {
      round = { keyByDataset: {}, assignments: {} };
      rounds.push(round);
    }
    round.keyByDataset[dsId] = sk;
    round.assignments[dsId] = clusterAssignments[sk] || {};
  }
  return rounds;
}

/**
 * Whether a round's results may still be applied: each panel's assignments are
 * the very ones that were sent (not cleared by navigation, restored from a
 * snapshot, or changed by another operation), and the view is where it was.
 */
export function roundStillCurrent(
  round: ClusterOperationRound,
  sentView: { chrom: string; start: number; end: number },
  now: {
    chrom: string; start: number; end: number;
    clusterAssignments: Record<string, Record<string, number> | undefined>;
  },
): boolean {
  if (now.chrom !== sentView.chrom || now.start !== sentView.start || now.end !== sentView.end) return false;
  return Object.entries(round.keyByDataset).every(([dsId, sk]) => now.clusterAssignments[sk] === round.assignments[dsId]);
}
