/**
 * Binning for the read track's metaprofiles (ReadTrack computeMetaprofileFromReads): a profile is, per bin, the
 * share of the reads covering the bin that have the channel there, so it must stay within [0, 1].
 *
 * Two things broke that before:
 * - A channel's intervals counted once each in every bin they touch, so two intervals of one read meeting inside a
 *   bin (adjacent nucleosomes with a linker shorter than a bin, or abutting calls) counted that read twice there.
 *   Clusters group reads by their nucleosome positions, so those shared bins line up within a cluster and a cluster
 *   profile reached 1.33 on the demo locus.
 * - The covering span came from the read's footprint/gap intervals only, and a layer interval past them (an MSP
 *   after the last footprint, with terminal gaps hidden) had signal without coverage.
 * Each read now adds at most 1 per bin per channel (the union of its intervals' bins), and its covering span takes in
 * every interval it contributes.
 */

/** The bins [first, endExclusive) an interval touches in a [0, width) window of nBins bins (null: none). */
export function touchedBins(start: number, end: number, width: number, nBins: number): [number, number] | null {
  if (!(end > 0) || !(start < width) || !(end > start)) return null;
  const binSize = width / nBins;
  const first = Math.max(0, Math.floor(Math.max(0, start) / binSize));
  const endExclusive = Math.min(nBins, Math.ceil(Math.min(width, end) / binSize));
  return endExclusive > first ? [first, endExclusive] : null;
}

/**
 * One read's intervals of one channel into a difference array (length nBins + 1): the union of the bins they touch,
 * so a bin counts the read at most once however many of its intervals meet there.
 */
export function addReadIntervals(diff: Float32Array | Float64Array | number[], intervals: Iterable<readonly [number, number]>, width: number, nBins: number): void {
  const ranges: [number, number][] = [];
  for (const [a, b] of intervals) {
    const r = touchedBins(a, b, width, nBins);
    if (r) ranges.push(r);
  }
  if (!ranges.length) return;
  ranges.sort((x, y) => x[0] - y[0]);
  let [s, e] = ranges[0];
  for (let i = 1; i < ranges.length; i++) {
    const [s2, e2] = ranges[i];
    if (s2 <= e) { if (e2 > e) e = e2; continue; }
    diff[s]++; diff[e]--;
    s = s2; e = e2;
  }
  diff[s]++; diff[e]--;
}
