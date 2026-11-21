/**
 * Find sequence in genome: the pure parts (browser/services/sequence_search.py keeps the same rules).
 *
 * - `parseSequence`: pasted text as IUPAC DNA (FASTA header, spaces and numbers dropped, U read as T), or why not;
 * - `looksLikeSequence`: whether the locus box should offer "Find this sequence in the genome";
 * - `plannedMode`: which search a query gets (exact / IUPAC scan, or BLAST), as the server decides it;
 * - `hitsToBed`, `hitLocus`, `hitWindow`: hits for export and navigation.
 */

export type SearchMode = 'auto' | 'exact' | 'blast';
export type BlastTask = 'auto' | 'megablast' | 'blastn' | 'blastn-short';

export interface SearchSettings {
  mode: SearchMode;
  /** Auto: shorter queries (and any with IUPAC codes) use the exact scan. */
  exact_max_length: number;
  /** Exact scan: mismatches allowed per hit. */
  max_mismatches: number;
  /** BLAST: hits at or below this e-value. */
  evalue: number;
  /** Hits listed (the total is always counted). */
  max_hits: number;
  /** Shortest query searched. */
  min_length: number;
  blast_task: BlastTask;
}

/** The server's defaults (GET /api/sequence_search/status sends its own; these are used until it answers). */
export const DEFAULT_SETTINGS: SearchSettings = {
  mode: 'auto', exact_max_length: 30, max_mismatches: 0, evalue: 0.01, max_hits: 500, min_length: 12, blast_task: 'auto',
};

export const SETTING_LIMITS: Record<'exact_max_length' | 'max_mismatches' | 'evalue' | 'max_hits' | 'min_length', [number, number]> = {
  exact_max_length: [8, 10_000],
  max_mismatches: [0, 5],
  evalue: [1e-200, 1000],
  max_hits: [1, 10_000],
  min_length: [6, 1_000],
};

export const MAX_QUERY = 100_000;
export const EXACT_HARD_MAX = 10_000;
/** The locus box offers a search for pasted DNA of at least this many bases. */
export const LOCUS_BOX_MIN_BASES = 12;

const IUPAC_RE = /^[ACGTRYSWKMBDHVN]+$/;

/** Bit masks (A=1, C=2, G=4, T=8; a code is the union of its bases): a query base matches a reference base when they share a bit. */
export const IUPAC_MASKS: Record<string, number> = {
  A: 1, C: 2, G: 4, T: 8, R: 5, Y: 10, S: 6, W: 9, K: 12, M: 3, B: 14, D: 13, H: 11, V: 7, N: 15,
};

export interface SequenceHit {
  chrom: string;
  /** 0-based, end exclusive. */
  start: number;
  end: number;
  /** '+', '-', or '.' (a query that is its own reverse complement: both strands). */
  strand: '+' | '-' | '.';
  mismatches: number | null;
  identity: number;
  evalue: number | null;
  bitscore: number | null;
  qstart: number;
  qend: number;
  /** The reference bases on the hit's strand (reads like the query). */
  matched: string;
  matched_truncated?: boolean;
}

export interface SearchResult {
  schema: string;
  mode: 'exact' | 'blast';
  query: string;
  query_length: number;
  genome: string | null;
  reference_id: string;
  settings: SearchSettings;
  notes: string[];
  hits: SequenceHit[];
  total: number;
  total_is_lower_bound?: boolean;
  palindrome?: boolean;
  task?: string;
}

export type ParsedSequence = { ok: true; seq: string } | { ok: false; error: string };

/** Pasted text as upper-case IUPAC DNA, or why it isn't (same rules as the server's normalize_query). */
export function parseSequence(text: string, minLength = DEFAULT_SETTINGS.min_length): ParsedSequence {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { ok: false, error: 'Paste a DNA sequence to search for.' };
  const lines = trimmed.split(/\r?\n/);
  const headers = lines.filter(l => l.trimStart().startsWith('>'));
  if (headers.length > 1) return { ok: false, error: 'Paste one sequence at a time (this text has several FASTA records).' };
  const seq = lines.filter(l => !l.trimStart().startsWith('>')).join('').replace(/[\s\d]+/g, '').toUpperCase().replace(/U/g, 'T');
  if (!seq) return { ok: false, error: 'Paste a DNA sequence to search for.' };
  if (!IUPAC_RE.test(seq)) {
    const bad = [...new Set(seq.replace(/[ACGTRYSWKMBDHVN]/g, ''))].slice(0, 6).map(c => `'${c}'`).join(' ');
    return { ok: false, error: `Not DNA: ${bad}. Use A, C, G, T (and IUPAC codes such as N, R, Y).` };
  }
  if (seq.length > MAX_QUERY) return { ok: false, error: `The sequence is ${seq.length.toLocaleString()} bases; the longest searched is ${MAX_QUERY.toLocaleString()}.` };
  if (seq.length < minLength) return { ok: false, error: `The sequence is ${seq.length} bases; search at least ${minLength} (shorter ones match too many places).` };
  const defined = seq.replace(/[^ACGT]/g, '').length;
  if (defined < Math.max(6, Math.floor(seq.length / 2))) {
    return { ok: false, error: 'The sequence is mostly ambiguous bases (N and other IUPAC codes); give at least half of it as A, C, G or T.' };
  }
  return { ok: true, seq };
}

/**
 * Text the locus box should offer to find in the genome: pure DNA / IUPAC (spaces, line breaks and a FASTA header
 * allowed), at least LOCUS_BOX_MIN_BASES bases, mostly A/C/G/T. Coordinates, gene names and read names never are
 * (a gene named only with IUPAC letters and 12+ long does not exist in practice).
 */
export function looksLikeSequence(text: string): boolean {
  const trimmed = (text ?? '').trim();
  if (!trimmed || trimmed.includes(':')) return false;
  const parsed = parseSequence(trimmed, LOCUS_BOX_MIN_BASES);
  if (!parsed.ok) return false;
  // Without spaces/numbers to drop, a single word must itself be all DNA letters (no digits).
  return !/\d/.test(trimmed) || /\s/.test(trimmed);
}

/**
 * Multi-line clipboard text for the one-line locus box that is a DNA sequence: the sequence alone (FASTA header,
 * line breaks, spaces and numbers dropped), or null for anything else (a list of read or gene names is flattened as
 * before). Without a FASTA header every line must be plain A/C/G/T/U/N (numbers and spaces allowed, as in a GenBank
 * listing), so a list of gene names written in IUPAC letters (ATM, ATR, MYC, ...) is never taken for DNA.
 */
export function pastedSequence(text: string): string | null {
  if (!/[\r\n]/.test(text ?? '')) return null;
  const lines = text.split(/\r?\n|\r/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const header = lines[0].startsWith('>');
  const body = header ? lines.slice(1) : lines;
  if (!body.length || body.some(l => l.startsWith('>'))) return null;
  if (!header && !body.every(l => /^[ACGTUN\d\s]+$/i.test(l))) return null;
  const parsed = parseSequence(body.join('\n'), LOCUS_BOX_MIN_BASES);
  return parsed.ok ? parsed.seq : null;
}

export const hasIupac = (seq: string) => /[^ACGT]/.test(seq);

/** Which search the server will run for `seq` ('exact' | 'blast'), BLAST availability given. */
export function plannedMode(seq: string, settings: SearchSettings, blastAvailable: boolean): { mode: 'exact' | 'blast'; fallback: boolean } {
  let wanted: 'exact' | 'blast' = settings.mode === 'auto'
    ? (hasIupac(seq) || seq.length < settings.exact_max_length ? 'exact' : 'blast')
    : settings.mode;
  let fallback = false;
  if (wanted === 'blast' && !blastAvailable) { wanted = 'exact'; fallback = true; }
  return { mode: wanted, fallback };
}

/** Clamp one numeric setting to its limits (NaN keeps the default). */
export function clampSetting<K extends keyof typeof SETTING_LIMITS>(key: K, value: number): number {
  const [low, high] = SETTING_LIMITS[key];
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS[key];
  const clamped = Math.min(Math.max(value, low), high);
  return key === 'evalue' ? clamped : Math.round(clamped);
}

/** "chr1:1,001-1,017" (1-based, inclusive, as the locus box shows places). */
export function hitLocus(hit: Pick<SequenceHit, 'chrom' | 'start' | 'end'>): string {
  return `${hit.chrom}:${(hit.start + 1).toLocaleString()}-${hit.end.toLocaleString()}`;
}

/** The view shown for a hit: the hit with context either side (at least 100 bp, 1.5x its length). */
export function hitWindow(hit: Pick<SequenceHit, 'start' | 'end'>, chromLength?: number | null): { start: number; end: number } {
  const len = Math.max(1, hit.end - hit.start);
  const pad = Math.max(100, Math.round(len * 1.5));
  const start = Math.max(0, hit.start - pad);
  const end = chromLength ? Math.min(chromLength, hit.end + pad) : hit.end + pad;
  return { start, end: Math.max(end, start + 1) };
}

export function hitName(hit: Pick<SequenceHit, 'mismatches'>, index: number): string {
  return `hit${index + 1}${hit.mismatches ? `_mm${hit.mismatches}` : ''}`;
}

/** The hits as BED6 (score: identity x 10; strand '.' for a palindromic query). */
export function hitsToBed(hits: SequenceHit[], trackName = 'sequence_search'): string {
  const lines = [`track name="${trackName.replace(/"/g, "'")}" description="FiberBrowser sequence search"`];
  hits.forEach((h, i) => {
    const score = Math.round(Math.min(1000, Math.max(0, (h.identity ?? 0) * 10)));
    lines.push([h.chrom, h.start, h.end, hitName(h, i), score, h.strand || '.'].join('\t'));
  });
  return `${lines.join('\n')}\n`;
}

/** "1.2e-45", "0.003", "—". */
export function formatEvalue(e: number | null | undefined): string {
  if (e == null || !Number.isFinite(e)) return '—';
  if (e === 0) return '0';
  return e < 0.001 ? e.toExponential(1) : String(Number(e.toPrecision(2)));
}

/** "2 mismatches", "exact", "98.5% identity". */
export function hitMatchText(hit: SequenceHit): string {
  if (hit.mismatches === 0) return 'exact';
  if (hit.mismatches != null) return `${hit.mismatches} mismatch${hit.mismatches === 1 ? '' : 'es'}`;
  return `${hit.identity}% identity`;
}

/** The result's headline: "2 hits (exact search, both strands)", "Showing 500 of 12,345 hits". */
export function resultSummary(result: Pick<SearchResult, 'hits' | 'total' | 'total_is_lower_bound' | 'mode' | 'task'>): string {
  const shown = result.hits.length;
  const how = result.mode === 'blast' ? `BLAST${result.task ? ` ${result.task}` : ''}` : 'exact search, both strands';
  if (!result.total) return `No hits (${how})`;
  if (result.total > shown) {
    return `Showing ${shown.toLocaleString()} of ${result.total_is_lower_bound ? 'at least ' : ''}${result.total.toLocaleString()} hits (${how})`;
  }
  return `${result.total.toLocaleString()} hit${result.total === 1 ? '' : 's'} (${how})`;
}
