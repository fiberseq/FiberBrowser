import type { WorkingSampling } from './types';

/** Compare before/after filtering within one cohort; never count sampling as filtering. */
export function readFilterCounts(inScope: number, working: number, sampling: WorkingSampling | null, spanning: boolean) {
  const total = Math.max(0, sampling ? (spanning ? sampling.kept_spanning : sampling.kept) : inScope);
  const kept = Math.max(0, sampling ? (spanning ? sampling.loaded_spanning : sampling.loaded) ?? working : working);
  const hidden = Math.max(0, total - kept);
  return { total, hidden, fraction: total > 0 ? hidden / total : 0, sampled: sampling !== null };
}

export interface ReadStatusCounts {
  loading: boolean;
  displayed: number;
  serverReturned: number;
  working: number;
  inScope: number;
  overlapping?: number;
  spanning: number;
}

function fmt(n: number): string {
  return Math.max(0, n).toLocaleString();
}

/** "1 read", "3,170 reads" (audit L6: the header said "1 reads"). */
function reads(n: number): string {
  return `${fmt(n)} ${Math.max(0, n) === 1 ? 'read' : 'reads'}`;
}

export function formatReadStatus(counts: ReadStatusCounts): { text: string; title: string } {
  if (counts.loading) {
    return counts.serverReturned > 0
      ? { text: `${reads(counts.serverReturned)} loaded...`, title: 'Loading the complete read set' }
      : { text: 'Loading...', title: 'Loading read data' };
  }

  const displayed = Math.max(0, counts.displayed);
  const serverReturned = Math.max(0, counts.serverReturned);
  const working = Math.max(0, counts.working > 0 ? counts.working : serverReturned);
  const inScope = Math.max(0, counts.inScope > 0 ? counts.inScope : working);
  const overlapping = Math.max(0, counts.overlapping ?? inScope);
  const spanning = Math.max(0, counts.spanning);

  const title = [
    `Rows drawn: ${reads(displayed)}`,
    `Browser sampled/payload: ${reads(serverReturned)}`,
    `Eligible total: ${reads(working)} after active read filters`,
    `Viewport total: ${reads(inScope)} in request scope`,
    `${fmt(overlapping)} overlapping ${overlapping === 1 ? 'read' : 'reads'}`,
    `${fmt(spanning)} fully spanning ${spanning === 1 ? 'read' : 'reads'}`,
  ].join('; ');

  if (displayed === 0 && serverReturned === 0 && working === 0 && overlapping > 0 && spanning === 0) {
    return { text: `0 spanning / ${fmt(overlapping)} overlapping`, title };
  }

  // One shape in every header, its scope said (round 3, R10: "339/2,698 visible" beside the footer's "1,825 of 3,639
  // reads (sampled)", and split headers mixing "332/697" with "80 reads"): the rows drawn of the reads eligible.
  return { text: `${fmt(displayed)} of ${fmt(working)} ${working === 1 ? 'row' : 'rows'} drawn`, title };
}

/**
 * The short form of formatReadStatus' text, for a narrow panel header (audit
 * M14): "586 of 3,170 rows drawn" -> "586/3,170", "0 spanning / 125 overlapping"
 * -> "0/125" (and the older "586/3,170 visible", "42 reads"). Anything else is kept.
 */
export function compactReadStatus(text: string): string {
  const drawn = text.match(/^([\d,]+) of ([\d,]+) rows? drawn$/);
  if (drawn) return `${drawn[1]}/${drawn[2]}`;
  const visible = text.match(/^([\d,]+)\/([\d,]+) visible$/);
  if (visible) return `${visible[1]}/${visible[2]}`;
  const count = text.match(/^([\d,]+) reads?$/);
  if (count) return count[1];
  const span = text.match(/^([\d,]+) spanning \/ ([\d,]+) overlapping$/);
  if (span) return `${span[1]}/${span[2]}`;
  return text;
}
