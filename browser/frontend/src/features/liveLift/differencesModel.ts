import type { Difference, DifferenceInspection, DifferencesResponse } from './differenceTypes';
import { BADGE_REASONS, formatBadgeBp } from '../../components/tracks/read-track/liveLiftCanvas';
export const differenceSize = (d: Difference) => Math.max(d.ref_bp, d.alt_bp);
export const MIN_SIZES = [0, 10, 50, 1000] as const;
export function differenceLanes(labels: string[], hap?: string | null): string[] { return hap ? [hap] : labels; }
export function differenceGlyph(d: Difference) {
  const shape = d.kind === 'snv' || d.kind === 'mnv' ? 'tick' : d.kind === 'insertion' ? 'wedge'
    : d.kind === 'deletion' ? 'bracket' : d.kind === 'inversion' ? 'chevron' : 'hatch';
  return { shape, label: d.kind === 'insertion' && d.alt_bp >= 50 ? formatBadgeBp(d.alt_bp) : '',
    width: d.kind === 'insertion' ? Math.min(30, 4 + Math.log2(Math.max(1, d.alt_bp)) * 1.5) : 2 };
}
export function stripModel(response: DifferencesResponse, minBp: number) {
  return { items: response.items.filter(d => differenceSize(d) >= minBp), bins: response.mode === 'bins' ? response.bins : [] };
}
/** Beyond the view edge, not the last selected item: repeated clicks always make progress. */
export function nextDifference(items: Difference[], start: number, end: number, direction: -1 | 1, minBp: number) {
  return items.filter(d => differenceSize(d) >= minBp && (direction > 0 ? d.t_start >= end : d.t_end <= start))
    .sort((a, b) => direction * (a.t_start - b.t_start))[0] ?? null;
}
export function inspectionModel(rows: DifferenceInspection[], preferredHap?: string | null) {
  const ordered = [...rows].sort((a, b) => Number(b.hap_label === preferredHap) - Number(a.hap_label === preferredHap));
  const summary: Record<string, Record<string, number>> = {};
  for (const r of ordered) { const hap = summary[r.hap_label] ??= {}; hap[r.allele] = (hap[r.allele] ?? 0) + 1; }
  return { rows: ordered, summary, misphased: rows.filter(r => r.allele === 'grch38'),
    carriers: rows.filter(r => r.allele === 'hg002' || r.carries_insertion).map(r => r.id) };
}
export function haplotypeSummary(alleles: Record<string, number>) {
  return Object.entries(alleles).map(([allele, n]) => allele === 'same_as_grch38'
    ? `no difference here, ${n} ${n === 1 ? 'read agrees' : 'reads agree'} with GRCh38`
    : `${allele.toUpperCase().replace(/_/g, ' ')} ${n}`).join(' · ');
}
export function differenceDescription(d: Difference, chrom: string): string {
  const locus = d.src.contig && d.src.start !== null && d.src.end !== null
    ? `${d.src.contig}:${(d.src.start + 1).toLocaleString()}–${d.src.end.toLocaleString()}`
    : d.src.contig ? `${d.src.contig} (source position unavailable)` : 'no source correspondence';
  const target = d.t_start === d.t_end ? `${chrom}:${d.t_start.toLocaleString()}|${(d.t_start + 1).toLocaleString()} (insertion boundary)`
    : `${chrom}:${(d.t_start + 1).toLocaleString()}–${d.t_end.toLocaleString()}`;
  return `${d.hap_label} · ${d.kind.replace(/_/g, ' ')} · ${differenceSize(d).toLocaleString()} bp · ${d.source === 'reads' ? 'read-only event' : 'assembly difference'}\n`
    + `GRCh38 ${target}\nHG002 ${locus}\n`
    + `GRCh38: ${d.grch38 ?? 'unknown'} · HG002: ${d.alt ?? 'unknown'}${d.alt !== null && d.alt_truncated ? `… (${d.alt_bp.toLocaleString()} bp)` : ''}\n`
    + `${BADGE_REASONS[d.reason] ?? d.reason.replace(/_/g, ' ')}`
    + (d.read_support ? `\nmatches ${d.read_support.carriers} native reads' ${d.kind}` : '');
}
