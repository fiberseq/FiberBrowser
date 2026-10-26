import type { CompactRead, SvEvent } from '../components/tracks/read-track/types';

export interface SvConflictOptions {
  enabled: boolean;
  max_distance: number;
  min_mapq: number;
  min_overlap: number;
  min_clip_fraction: number;
}
export interface SvConflictReason {
  code: 'clip_elsewhere'; chrom: string; pos: number; end: number; mapq: number;
  overlap: number; clip_fraction: number; distance: number | null; message: string;
}
export const DEFAULT_SV_CONFLICT_OPTIONS: SvConflictOptions = {
  enabled: true, max_distance: 100_000, min_mapq: 0, min_overlap: 500, min_clip_fraction: 0.5,
};
export function normalizeSvConflictOptions(input?: unknown): SvConflictOptions {
  const value = input && typeof input === 'object' ? input as Partial<SvConflictOptions> : undefined;
  const out = { ...DEFAULT_SV_CONFLICT_OPTIONS, enabled: value?.enabled !== false };
  for (const [key, lo, hi] of [['max_distance', 0, 1e9], ['min_mapq', 0, 255], ['min_overlap', 1, 1e6],
    ['min_clip_fraction', 0, 1]] as const) {
    const n = Number(value?.[key] ?? out[key]);
    if (Number.isFinite(n)) out[key] = Math.max(lo, Math.min(hi, key === 'min_clip_fraction' ? n : Math.trunc(n)));
  }
  return out;
}

/** Mirrors services.sv_conflicts: intervals are in the supporting alignment's full-query frame. */
export function clipConflict(read: Pick<CompactRead, 'sv_segments'>, clip: Extract<SvEvent, { t: 'S' }>,
  ref: number, end: number, chrom?: string, options?: SvConflictOptions): SvConflictReason | null {
  const p = normalizeSvConflictOptions(options);
  if (!p.enabled) return null;
  const segments = read.sv_segments ?? [];
  const reasons: SvConflictReason[] = [];
  const keys = ['chrom', 'pos', 'cigar_ref_len', 'strand', 'q_start', 'q_end', 'query_length'] as const;
  const anchors = segments.filter(s => s.t !== 'SA' && (!chrom || s.chrom === chrom)
    && (clip.side === 'L' ? s.pos : s.pos + s.cigar_ref_len) === clip.ref
    && (clip.side === 'L' ? s.q_start : s.query_length - s.q_end) === clip.len
    && (!clip.anchor || keys.every(k => s[k] === clip.anchor![k])));
  // Legacy clips without an origin must identify a single query frame.
  if (!anchors.length || anchors.some(s => keys.some(k => s[k] !== anchors[0][k]))) return null;
  for (const anchor of anchors) {
    const total = anchor.query_length;
    const [a, b] = clip.side === 'L' ? [0, anchor.q_start] : [anchor.q_end, total];
    if (b <= a) continue;
    for (const s of segments) {
      if (s === anchor || s.query_length !== total || s.mapq < p.min_mapq) continue;
      const blocks = (s.query_blocks ?? []).map(([start, stop]) => {
        const [x, y] = s.strand === anchor.strand ? [start, stop] : [total - stop, total - start];
        return [Math.max(a, x), Math.min(b, y)];
      }).filter(([x, y]) => y > x).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      let overlap = 0, coveredEnd = a;
      for (const [x, y] of blocks) {
        overlap += Math.max(0, y - Math.max(x, coveredEnd));
        coveredEnd = Math.max(coveredEnd, y);
      }
      const fraction = overlap / (b - a);
      if (overlap < p.min_overlap || fraction < p.min_clip_fraction) continue;
      const elsewhere = s.chrom !== anchor.chrom;
      const distance = Math.max(0, s.pos - end, ref - s.pos - s.cigar_ref_len);
      if (!elsewhere && distance <= p.max_distance) continue;
      reasons.push({ code: 'clip_elsewhere', chrom: s.chrom, pos: s.pos, end: s.pos + s.cigar_ref_len,
        mapq: s.mapq, overlap, clip_fraction: fraction, distance: elsewhere ? null : distance,
        message: `Supporting clip aligns elsewhere (${s.chrom}:${(s.pos + 1).toLocaleString('en-US')}; ${overlap.toLocaleString('en-US')} bp, ${(fraction * 100).toFixed(0)}% of clip; MAPQ ${s.mapq})` });
    }
  }
  reasons.sort((a, b) => b.overlap - a.overlap || b.mapq - a.mapq || (a.chrom < b.chrom ? -1 : a.chrom > b.chrom ? 1 : 0) || a.pos - b.pos);
  return reasons[0] ?? null;
}

export const SV_CONFLICT_EXPLANATION = 'Conflicting: a substantial part of the supporting clip aligns elsewhere; excluded from default carriers.';
