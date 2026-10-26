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
/** Whether an inspected row carries the difference: an assembly difference's carriers have its assembly allele; a
 * read-supported edit (no assembly allele: its alternate is what the reads show) is carried by rows with its bases. */
export function carriesDifference(d: Pick<Difference, 'source' | 'kind' | 'alt'> | null | undefined,
  row: Pick<DifferenceInspection, 'allele' | 'read_bases' | 'carries_insertion' | 'carries_deletion'>): boolean {
  if (d?.source !== 'reads') return row.allele === 'hg002' || !!row.carries_insertion || !!row.carries_deletion;
  if (d.kind === 'deletion') return row.allele === 'deleted' || !!row.carries_deletion;
  if (d.alt) return (row.read_bases ?? '').toUpperCase() === d.alt.toUpperCase();
  return row.allele === 'other' || row.allele === 'grch38';
}

/** Carrier rows as a read highlight: their display rows (analysis ids) in `datasetId` when every row has one, so
 * the same QNAME in another dataset or library is not outlined; their names otherwise. */
export function carrierHighlight(rows: Pick<DifferenceInspection, 'id' | 'row_id'>[], datasetId: string): { ids: string[]; scopedRows?: Record<string, Set<string>> } {
  const ids = [...new Set(rows.map(r => r.id))];
  return rows.length && rows.every(r => r.row_id) ? { ids, scopedRows: { [datasetId]: new Set(rows.map(r => r.row_id!)) } } : { ids };
}

export function inspectionModel(rows: DifferenceInspection[], preferredHap?: string | null,
  difference?: Pick<Difference, 'source' | 'kind' | 'alt'> | null) {
  const ordered = [...rows].sort((a, b) => Number(b.hap_label === preferredHap) - Number(a.hap_label === preferredHap));
  const summary: Record<string, Record<string, number>> = {};
  for (const r of ordered) { const hap = summary[r.hap_label] ??= {}; hap[r.allele] = (hap[r.allele] ?? 0) + 1; }
  const carrierRows = rows.filter(r => carriesDifference(difference, r));
  return { rows: ordered, summary, misphased: rows.filter(r => r.allele === 'grch38'),
    carriers: carrierRows.map(r => r.id), carrierRows };
}
/** `reference`: the target assembly's name (sampleLabel.targetReferenceLabel). */
export function haplotypeSummary(alleles: Record<string, number>, reference = 'the reference') {
  return Object.entries(alleles).map(([allele, n]) => allele === 'same_as_grch38'
    ? `no difference here, ${n} ${n === 1 ? 'read agrees' : 'reads agree'} with ${reference}`
    : `${allele.toUpperCase().replace(/_/g, ' ')} ${n}`).join(' · ');
}
/** `names`: the two assemblies as labels name them (sampleLabel.ts; default "Reference" and "Source"). */
export function differenceDescription(d: Difference, chrom: string, names: { source?: string | null; target?: string | null } = {}): string {
  const src = names.source || 'Source', tgt = names.target || 'Reference';
  const locus = d.src.contig && d.src.start !== null && d.src.end !== null
    ? d.src.start === d.src.end ? `${d.src.contig}:${d.src.start.toLocaleString()}|${(d.src.start + 1).toLocaleString()} (source boundary)`
      : `${d.src.contig}:${(d.src.start + 1).toLocaleString()}–${d.src.end.toLocaleString()}`
    : d.src.contig ? `${d.src.contig} (source position unavailable)` : 'no source correspondence';
  const target = d.t_start === d.t_end ? `${chrom}:${d.t_start.toLocaleString()}|${(d.t_start + 1).toLocaleString()} (insertion boundary)`
    : `${chrom}:${(d.t_start + 1).toLocaleString()}–${d.t_end.toLocaleString()}`;
  const size = d.kind === 'replacement' ? `${d.ref_bp.toLocaleString()}→${d.alt_bp.toLocaleString()}` : differenceSize(d).toLocaleString();
  return `${d.hap_label} · ${d.kind.replace(/_/g, ' ')} · ${size} bp · ${d.source === 'reads' ? 'read-only event' : 'assembly difference'}\n`
    + `${tgt} ${target}\n${src} ${locus}\n`
    + `${tgt}: ${d.grch38 ?? 'unknown'}${d.grch38 !== null && d.ref_truncated ? `… (${d.ref_bp.toLocaleString()} bp)` : ''} · ${src}: ${d.alt ?? 'unknown'}${d.alt !== null && d.alt_truncated ? `… (${d.alt_bp.toLocaleString()} bp)` : ''}\n`
    + `${BADGE_REASONS[d.reason] ?? d.reason.replace(/_/g, ' ')}`
    + (d.read_support ? `\nGeometry candidate: ${d.read_support.carriers} native reads' ${d.kind} (sequence comparison unassessed)` : '')
    + ((d.read_candidates?.length ?? 0) > 1 ? ` · ${d.read_candidates!.length} candidate clusters; counts not combined` : '');
}
