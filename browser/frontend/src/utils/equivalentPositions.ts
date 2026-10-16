import type { FirePeak, MatchedRegionInfo } from '../types';
import { sameChrom } from './chromAliases';

export type PositionBlock = MatchedRegionInfo['blocks'][number];

/** Intersect aligned coordinates without bridging an insertion or an unaligned stretch. */
export function sharedPositionBlocks(members: FirePeak[]): [number, number][] {
  if (!members.length || members.some(p => !p.match)) return [];
  let spans: [number, number][] = [[0, members[0].match!.length]];
  for (const member of members) spans = spans.flatMap(([a, b]) => member.match!.blocks.flatMap(block => {
    const start = Math.max(a, block.frame[0]), end = Math.min(b, block.frame[1]);
    return end > start ? [[start, end] as [number, number]] : [];
  }));
  return spans;
}

/** Project a frame interval into one member, preserving orientation and gaps. */
export function framePeak(member: FirePeak, start: number, end: number, feature: FirePeak, groupId: string): FirePeak | null {
  const m = member.match!;
  const blocks = m.blocks.flatMap(b => {
    const lo = Math.max(start, b.frame[0]), hi = Math.min(end, b.frame[1]);
    if (hi <= lo) return [];
    const g = m.reversed ? b.genomic[1] - (hi - b.frame[0]) : b.genomic[0] + lo - b.frame[0];
    return [{ frame: [lo - start, hi - start] as [number, number], genomic: [g, g + hi - lo] as [number, number] }];
  });
  if (!blocks.length) return null;
  return { ...feature, chrom: member.chrom, genome: member.genome, ...(feature.memberPanelId ? { memberPanelId: m.panelId } : {}),
    start: Math.min(...blocks.map(b => b.genomic[0])), end: Math.max(...blocks.map(b => b.genomic[1])),
    match: { ...m, groupId, correspondenceId: m.groupId, length: end - start, blocks } };
}

/** A feature in an accepted correspondence is one selection, drawn in each member's coordinates. */
export function equivalentPeaks(peaks: FirePeak[], groups: FirePeak[][], chrom: string): FirePeak[] {
  return peaks.flatMap(p => {
    if (p.match) return [p];
    for (const members of groups) {
      if (p.correspondenceId && members[0]?.match?.groupId !== p.correspondenceId) continue;
      const source = members.find(m => (!p.memberPanelId || !m.match!.panelId || m.match!.panelId === p.memberPanelId) && sameChrom(m.chrom ?? chrom, p.chrom ?? chrom) && (m.genome ?? null) === (p.genome ?? null)
        && m.match!.blocks.some(b => b.genomic[0] < p.end && b.genomic[1] > p.start));
      if (!source) continue;
      const m = source.match!, shared = sharedPositionBlocks(members);
      const projected: FirePeak[] = [], covered: [number, number][] = [];
      for (const block of m.blocks) {
        const a = Math.max(p.start, block.genomic[0]), z = Math.min(p.end, block.genomic[1]);
        if (z <= a) continue;
        const lo = m.reversed ? block.frame[0] + block.genomic[1] - z : block.frame[0] + a - block.genomic[0];
        const hi = lo + z-a;
        for (const [u, v] of shared) {
          const start = Math.max(lo, u), end = Math.min(hi, v);
          if (end <= start) continue;
          const id = `${m.groupId}:${p.featureIndex !== undefined ? `feature-${p.featureIndex}` : p.ruleId ?? 'peak'}:${start}-${end}`;
          projected.push(...members.map(member => framePeak(member, start, end, p, id)!).filter(Boolean));
          const own = framePeak(source, start, end, p, id)!;
          covered.push([own.start, own.end]);
        }
      }
      if (!projected.length) continue;
      // A drawn feature crossing a seam keeps its unmapped pieces on its source member.
      const ownPeak = m.panelId ? { ...p, memberPanelId: m.panelId } : p;
      let cursor = p.start;
      for (const [a, z] of covered.sort((a, b) => a[0]-b[0])) {
        if (a > cursor) projected.push({ ...ownPeak, start: cursor, end: a });
        cursor = Math.max(cursor, z);
      }
      if (cursor < p.end) projected.push({ ...ownPeak, start: cursor, end: p.end });
      return projected;
    }
    return [p];
  });
}

/** Exact alternate-allele flanks; deleted/reference-only and inserted bases have no counterpart. */
export function variantPositionBlocks(start: number, end: number, breakpoint: number, deleted: number, inserted: number): { reference: PositionBlock[]; alternate: PositionBlock[]; length: number } {
  if (!(start <= breakpoint && breakpoint + deleted <= end) || deleted < 0 || inserted < 0) throw new Error('Invalid variant interval');
  const left = breakpoint - start, right = end - breakpoint - deleted;
  const reference: PositionBlock[] = [], alternate: PositionBlock[] = [];
  if (left) {
    reference.push({ frame: [0, left], genomic: [start, breakpoint] });
    alternate.push({ frame: [0, left], genomic: [0, left] });
  }
  if (right) {
    reference.push({ frame: [left + deleted, end - start], genomic: [breakpoint + deleted, end] });
    alternate.push({ frame: [left + deleted, end - start], genomic: [left + inserted, left + inserted + right] });
  }
  return { reference, alternate, length: end - start };
}
