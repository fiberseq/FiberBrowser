/**
 * Accessibility (preview): an NFR card's sequence, to copy or save as FASTA: the NFR window and each variant's span,
 * from the reference the run's datasets use (/nfrs/{id}/sequence; an alt-allele dataset's own synthetic contig).
 * FASTA headers carry 1-based inclusive coordinates (chr3L:15040001-15040200).
 */
import { getNfrSequence, type VariantSequence } from './api';
import type { SavedNfr } from './savedNfrVariants';

/** Flank the request asks for: the window must hold the NFR and every variant (the server adds it around both). */
const FLANK = 0;
const cache = new Map<string, Promise<VariantSequence>>();

/** The run's sequence of an NFR (once per run and NFR; a failure is asked again next time). */
export function loadNfrSequence(jobId: string, nfrId: string): Promise<VariantSequence> {
  const key = `${jobId}|${nfrId}`;
  let p = cache.get(key);
  if (!p) {
    p = getNfrSequence(jobId, nfrId, FLANK);
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

export function clearNfrSequenceCache(): void { cache.clear(); }

/** The bases of [start, end) (0-based half-open) from the answer, clipped to the reference (positions past a contig
 * end are blanks in the answer: the span is narrowed, never padded or shortened in the middle); null when the answer
 * has no bases, does not cover the span, or has none there. */
export function sliceSequence(seq: VariantSequence, start: number, end: number): { bases: string; start: number; end: number } | null {
  if (typeof seq.sequence !== 'string') return null;
  const lo = seq.window[0];
  const a = Math.round(start) - lo, b = Math.round(end) - lo;
  if (a < 0 || b > seq.sequence.length || b <= a) return null;
  const raw = seq.sequence.slice(a, b);
  const lead = raw.length - raw.trimStart().length;
  const bases = raw.trim();
  if (!bases || /\s/.test(bases)) return null;
  return { bases, start: Math.round(start) + lead, end: Math.round(start) + lead + bases.length };
}

export interface SequencePart { label: string; start: number; end: number }

/** The NFR window, or one variant's span. */
export function sequencePart(entry: SavedNfr, variant?: string): SequencePart | null {
  if (!variant) return { label: entry.name || entry.nfrId, start: entry.nfrStart, end: entry.nfrEnd };
  const v = entry.variants.find(x => x.name === variant);
  return v ? { label: `${entry.name || entry.nfrId}_${v.name}`, start: v.start, end: v.end } : null;
}

const wrap = (s: string, n = 60) => s.match(new RegExp(`.{1,${n}}`, 'g'))?.join('\n') ?? '';

/** One FASTA record: '>N5 chr3L:15040001-15040200 NFR window' then the bases, 60 a line; the coordinates are
 * those of the bases given (clipped to the reference). */
export function fastaRecord(entry: SavedNfr, seq: VariantSequence, part: SequencePart, what: string):
  { text: string; bases: string; start: number; end: number; chrom: string } | null {
  const got = sliceSequence(seq, part.start, part.end);
  if (got == null) return null;
  const chrom = seq.chrom || entry.chrom;
  const id = part.label.replace(/\s+/g, '_');
  return { ...got, chrom, text: `>${id} ${chrom}:${got.start + 1}-${got.end} ${what}\n${wrap(got.bases)}\n` };
}

export const fastaFileName = (entry: SavedNfr, part: SequencePart, start = part.start, end = part.end) =>
  `${part.label.replace(/\W+/g, '_')}_${(entry.chrom || 'chr').replace(/\W+/g, '_')}_${Math.round(start) + 1}-${Math.round(end)}.fa`;
