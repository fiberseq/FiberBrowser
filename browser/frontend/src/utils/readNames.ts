/**
 * Read names typed or pasted into a locus box (fb-r4-clicks).
 *
 * A locus box takes coordinates (chr2L:1,000-2,000), gene names (roX1, CG12345,
 * "roX1 +/- 5kb") and now read names: one, or several separated by commas,
 * semicolons, spaces or new lines. Read names are recognised by the shapes the
 * sequencers give them, so a gene or a contig is never taken for one:
 *
 * - PacBio: movie/zmw/ccs (m64011_190830_220126/1234/ccs, m84046_..._s1/240062573/ccs),
 *   subreads movie/zmw/start_end;
 * - Oxford Nanopore: a UUID (3c8f6d2a-1b7e-4f0a-9c55-0d2e7a9b1f34);
 * - Illumina: instrument:run:flowcell:lane:tile:x:y (Casava 1.8+), or the older
 *   HWUSI-EAS100R:6:73:941:1973#0/1;
 * - SRA: SRR1234567.1;
 * - DAF amplicon runs (a lab's own demultiplexed names): <number>_<barcode>_<number>,
 *   e.g. 4741_FP64DJ_3 (the barcode in capitals and digits, with a letter);
 * - any other name containing "/" and a digit (no spaces), e.g. a split
 *   read's segment ``name_2``;
 * - anything after "read:" (``read: my_read_7``), for names of no known shape.
 */

const PACBIO = /^m[0-9A-Za-z]+(?:_[0-9A-Za-z]+)*\/\d+\/(?:ccs|subreads|\d+_\d+)(?:\/[A-Za-z0-9_]+)?(?:_\d+)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:_\d+)?$/i;
const ILLUMINA = /^[A-Za-z0-9_.-]+:\d+:[A-Za-z0-9-]+:\d+:\d+:\d+:\d+(?:_\d+)?$/;
const ILLUMINA_OLD = /^[A-Za-z0-9_.-]+:\d+:\d+:\d+:\d+(?:#[0-9ACGTNacgtn]+)?(?:\/[12])?$/;
const SRA = /^[SED]RR\d+\.\d+(?:\.[12])?$/;
// 4741_FP64DJ_3: a number, a capitals-and-digits barcode (a letter in it, 4+ long), a number.
const LAB_AMPLICON = /^\d+_(?=[A-Z0-9]*[A-Z])[A-Z0-9]{4,}_\d+$/;
// Some other naming with a slash (a lab's own pipeline); never a "+/-" window.
const SLASHED = /^[A-Za-z0-9][^\s/]*\/[^\s]+$/;
const EXPLICIT = /^\s*reads?\s*:\s*/i;
const SEPARATORS = /[\s,;]+/;

/** Whether one token has a read name's shape (see the module comment). */
export function isReadName(token: string): boolean {
  const t = token.trim().replace(/^@/, '');
  if (!t || t.length > 512) return false;
  if (PACBIO.test(t) || UUID.test(t) || ILLUMINA.test(t) || ILLUMINA_OLD.test(t) || SRA.test(t) || LAB_AMPLICON.test(t)) return true;
  return SLASHED.test(t) && /\d/.test(t) && !t.includes('+/') && !t.includes('://');
}

/**
 * The read names in a locus box's text, or null when it is not (only) read
 * names: coordinates, a gene, a gene with a window, or a mix.
 */
export function parseReadNames(input: string): string[] | null {
  if (!input) return null;
  const explicit = EXPLICIT.test(input);
  const body = explicit ? input.replace(EXPLICIT, '') : input;
  const tokens = body.split(SEPARATORS).map(t => t.trim().replace(/^@/, '')).filter(Boolean);
  if (tokens.length === 0) return null;
  if (!explicit && !tokens.every(isReadName)) return null;
  return [...new Set(tokens)];
}

/** Several names as one text for the clipboard or a file (one per line). */
export function formatReadNameList(names: Iterable<string>): string {
  return [...new Set(names)].join('\n');
}

/** A short label for the names (status lines): the first and how many more. */
export function describeReadNames(names: string[]): string {
  if (names.length === 0) return 'no reads';
  if (names.length === 1) return names[0];
  return `${names[0]} and ${names.length - 1} more`;
}

/**
 * Pasted text for a one-line box: a list on several lines becomes
 * comma separated (a text input drops line breaks, which would glue names together).
 */
export function flattenPastedList(text: string): string {
  if (!/[\r\n]/.test(text)) return text;
  return text.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean).join(', ');
}
