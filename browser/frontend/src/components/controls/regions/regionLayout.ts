/** Layout helpers for the Regions panel's chromosome and zoom-window maps. */

export interface Interval { start: number; end: number }

/** A round step giving about `target` ticks over `span`. */
export function niceStep(span: number, target: number): number {
  if (!(span > 0) || !(target > 0)) return 1;
  const raw = span / target;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / pow;
  const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return Math.max(1, step * pow);
}

/** Tick positions inside [start, end], on multiples of `step`. */
export function ticks(start: number, end: number, step: number): number[] {
  const out: number[] = [];
  if (!(step > 0) || end <= start) return out;
  for (let p = Math.ceil(start / step) * step; p <= end && out.length < 200; p += step) out.push(p);
  return out;
}

/** A coordinate as a tick label at this step: 47.52 Mb, 120 kb, 850 bp. */
export function formatTick(position: number, step: number): string {
  if (step >= 100_000 || Math.abs(position) >= 1_000_000) {
    const decimals = Math.max(0, Math.min(3, Math.ceil(-Math.log10(step / 1_000_000) - 1e-9)));
    return `${(position / 1_000_000).toFixed(decimals)} Mb`;
  }
  if (step >= 100 || Math.abs(position) >= 1_000) {
    const decimals = Math.max(0, Math.min(3, Math.ceil(-Math.log10(step / 1_000) - 1e-9)));
    return `${(position / 1_000).toFixed(decimals)} kb`;
  }
  return `${Math.round(position)} bp`;
}

export interface OverviewGene { id: string; name: string; start: number; end: number; strand: string }

/**
 * Transcripts of one gene merged into one span (the map shows genes, not
 * isoforms): same name and strand, overlapping.
 */
export function mergeTranscripts<T extends OverviewGene>(genes: T[]): OverviewGene[] {
  const sorted = [...genes].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: OverviewGene[] = [];
  for (const gene of sorted) {
    const name = gene.name || gene.id;
    const last = [...out].reverse().find(g => g.name === name && g.strand === gene.strand && gene.start <= g.end);
    if (last) last.end = Math.max(last.end, gene.end);
    else out.push({ id: gene.id, name, start: gene.start, end: gene.end, strand: gene.strand });
  }
  return out;
}

export interface PackedItem<T> { item: T; lane: number; x1: number; x2: number; showLabel: boolean }

/**
 * Greedy lane packing in screen space: each gene goes in the first lane where
 * it (and its name, when the name is shown) clears what is already there.
 * Genes past `maxLanes` are counted in `hidden`.
 */
export function packLanes<T extends Interval & { name: string }>(
  items: T[],
  toX: (bp: number) => number,
  { maxLanes, charWidth = 6, gap = 6, minBarPx = 2 }: { maxLanes: number; charWidth?: number; gap?: number; minBarPx?: number },
): { placed: PackedItem<T>[]; hidden: number; lanes: number } {
  const laneEnds: number[] = [];
  const placed: PackedItem<T>[] = [];
  let hidden = 0;
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  for (const item of sorted) {
    const x1 = toX(item.start);
    const x2 = Math.max(x1 + minBarPx, toX(item.end));
    const labelEnd = Math.max(x1, 0) + item.name.length * charWidth;
    const withLabel = Math.max(x2, labelEnd);
    let lane = laneEnds.findIndex(end => end + gap <= x1);
    if (lane < 0 && laneEnds.length < maxLanes) lane = laneEnds.length;
    if (lane < 0) { hidden += 1; continue; }
    laneEnds[lane] = withLabel;
    placed.push({ item, lane, x1, x2, showLabel: true });
  }
  return { placed, hidden, lanes: laneEnds.length };
}
