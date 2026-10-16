/** Parse primer pairs from user-supplied files.
 *
 *  Accepts two formats:
 *
 *  1. FiberBrowser's own "Full TSV" export — roundtrip-clean. Recognised by
 *     the header row `Name<TAB>Chrom<TAB>Target_Start<TAB>...`.
 *
 *  2. BED6+ where column 4 (name) contains a primer-pair identifier with a
 *     direction suffix. Supported suffixes (case-insensitive):
 *       _F / _R   _fwd / _rev   _fw / _rv   _forward / _reverse   F / R
 *     Rows with matching base names (everything before the suffix) are paired.
 *     Column 6 (strand) disambiguates when the suffix is absent: + = fwd,
 *     - = rev. An optional 7th column may carry the primer sequence; if
 *     omitted, fwd_seq / rev_seq will be empty strings (position-only
 *     records are still valid for tracking).
 *
 *  Returns SavedPrimer entries with source='tsv' for the TSV format and
 *  source='bed' for BED inputs — both are excluded from export by default
 *  so users don't re-order primers they already have.
 */
import { sameChrom } from './chromAliases';
import type { PrimerPair, SavedPrimer } from '../types/primer';

export interface PrimerImportResult {
  primers: SavedPrimer[];
  errors: string[];
}

const FWD_SUFFIXES = ['_f', '_fwd', '_fw', '_forward', '-f', '.f'];
const REV_SUFFIXES = ['_r', '_rev', '_rv', '_reverse', '-r', '.r'];

function stripSuffix(name: string): { base: string; direction: 'fwd' | 'rev' | null } {
  const lower = name.toLowerCase();
  for (const s of FWD_SUFFIXES) {
    if (lower.endsWith(s)) return { base: name.slice(0, -s.length), direction: 'fwd' };
  }
  for (const s of REV_SUFFIXES) {
    if (lower.endsWith(s)) return { base: name.slice(0, -s.length), direction: 'rev' };
  }
  // Bare trailing F / R with no separator
  const last = name[name.length - 1];
  if (last === 'F' || last === 'f') return { base: name.slice(0, -1), direction: 'fwd' };
  if (last === 'R' || last === 'r') return { base: name.slice(0, -1), direction: 'rev' };
  return { base: name, direction: null };
}

/** Parse our own Full TSV export. Each row is one complete PrimerPair. */
function parseFullTsv(text: string, filename: string): PrimerImportResult {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { primers: [], errors: ['TSV has no data rows'] };
  const header = lines[0].split('\t').map(h => h.trim());
  const col = (name: string) => header.indexOf(name);
  const required = ['Name', 'Chrom', 'Fwd_Seq', 'Fwd_Start', 'Fwd_End', 'Rev_Seq', 'Rev_Start', 'Rev_End'];
  for (const r of required) {
    if (col(r) < 0) return { primers: [], errors: [`TSV missing required column: ${r}`] };
  }

  const primers: SavedPrimer[] = [];
  const errors: string[] = [];
  const nowBase = Date.now();
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split('\t');
    try {
      const pair: PrimerPair = {
        fwd_seq: row[col('Fwd_Seq')],
        fwd_start: Number(row[col('Fwd_Start')]),
        fwd_end: Number(row[col('Fwd_End')]),
        fwd_tm: Number(row[col('Fwd_Tm')] ?? 0) || 0,
        fwd_len: row[col('Fwd_Seq')].length,
        rev_seq: row[col('Rev_Seq')],
        rev_start: Number(row[col('Rev_Start')]),
        rev_end: Number(row[col('Rev_End')]),
        rev_tm: Number(row[col('Rev_Tm')] ?? 0) || 0,
        rev_len: row[col('Rev_Seq')].length,
        product_size: Number(row[col('Product_Size')] ?? 0) || 0,
        tm_diff: Number(row[col('Tm_Diff')] ?? 0) || 0,
        g_count: Number(row[col('G_Count')] ?? 0) || 0,
      };
      primers.push({
        name: row[col('Name')] || `Imported_${i}`,
        pair,
        chrom: row[col('Chrom')],
        targetStart: Number(row[col('Target_Start')] ?? pair.fwd_start) || pair.fwd_start,
        targetEnd: Number(row[col('Target_End')] ?? pair.rev_end) || pair.rev_end,
        addedAt: nowBase + i,
        source: 'tsv',
        loadedFromFile: filename,
      });
    } catch (e) {
      errors.push(`Row ${i}: ${(e as Error).message}`);
    }
  }
  return { primers, errors };
}

/** Parse BED6+ with paired fwd/rev rows. Tolerant of comments and blank lines. */
function parseBed(text: string, filename: string): PrimerImportResult {
  const primers: SavedPrimer[] = [];
  const errors: string[] = [];
  type Entry = { chrom: string; start: number; end: number; name: string; strand: string; seq: string };
  // A pair is its name on one chromosome: the same name on two chromosomes is two pairs.
  const byBase = new Map<string, { base: string; chrom: string; fwd?: Entry; rev?: Entry }>();

  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('track') || line.startsWith('browser')) continue;
    const fields = line.split(/\t|\s+/);
    if (fields.length < 3) continue;
    const chrom = fields[0];
    const start = Number(fields[1]);
    const end = Number(fields[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const name = fields[3] ?? '';
    const strand = (fields[5] ?? '').trim();
    const seq = fields[6] ?? '';  // our extension: sequence in col 7

    const { base, direction } = stripSuffix(name);
    // Direction precedence: name suffix → strand column
    const dir: 'fwd' | 'rev' | null =
      direction ?? (strand === '+' ? 'fwd' : strand === '-' ? 'rev' : null);
    if (dir === null) {
      errors.push(`Skipping ${name || `${chrom}:${start}-${end}`}: no F/R suffix and no strand (+/-)`);
      continue;
    }

    const pairBase = base || `${chrom}:${start}`;
    const key = `${pairBase}\u0000${chrom}`;
    const entry: Entry = { chrom, start, end, name, strand, seq };
    const group = byBase.get(key) ?? { base: pairBase, chrom };
    if (group[dir]) {
      errors.push(`Pair "${pairBase}" on ${chrom} has more than one ${dir === 'fwd' ? 'forward' : 'reverse'} primer; keeping the first`);
      continue;
    }
    group[dir] = entry;
    byBase.set(key, group);
  }
  const chromsByBase = new Map<string, Set<string>>();
  for (const group of byBase.values()) {
    if (!chromsByBase.has(group.base)) chromsByBase.set(group.base, new Set());
    chromsByBase.get(group.base)!.add(group.chrom);
  }

  const nowBase = Date.now();
  let idx = 0;
  for (const group of byBase.values()) {
    const { fwd, rev } = group;
    const onSeveral = (chromsByBase.get(group.base)?.size ?? 0) > 1;
    const base = onSeveral ? `${group.base}_${group.chrom}` : group.base;
    if (!fwd || !rev) {
      errors.push(`Pair "${group.base}"${onSeveral ? ` on ${group.chrom}` : ''} missing ${!fwd ? 'forward' : 'reverse'} primer`);
      continue;
    }
    const pair: PrimerPair = {
      fwd_seq: fwd.seq,
      fwd_start: fwd.start,
      fwd_end: fwd.end,
      fwd_tm: 0,
      fwd_len: fwd.seq.length || (fwd.end - fwd.start),
      rev_seq: rev.seq,
      rev_start: rev.start,
      rev_end: rev.end,
      rev_tm: 0,
      rev_len: rev.seq.length || (rev.end - rev.start),
      product_size: Math.max(fwd.end, rev.end) - Math.min(fwd.start, rev.start),
      tm_diff: 0,
      g_count: 0,
    };
    primers.push({
      name: base || `Imported_${idx + 1}`,
      pair,
      chrom: fwd.chrom,
      targetStart: Math.min(fwd.start, rev.start),
      targetEnd: Math.max(fwd.end, rev.end),
      addedAt: nowBase + (idx++),
      source: 'bed',
      loadedFromFile: filename,
    });
  }

  return { primers, errors };
}

/** Top-level entry point. Picks the parser based on file extension or
 *  content inspection — a header line starting with "Name\tChrom" routes
 *  to TSV; everything else is parsed as BED. */
export function parsePrimerFile(filename: string, text: string): PrimerImportResult {
  const lower = filename.toLowerCase();
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  if (lower.endsWith('.tsv') || firstLine.startsWith('Name\tChrom')) {
    return parseFullTsv(text, filename);
  }
  return parseBed(text, filename);
}

/** Similarity test for "already in cart" badging on fresh design results.
 *  Strict match: same chromosome AND (exact fwd+rev sequence match
 *  OR fwd_start AND rev_start within `tolBp`). The seq match catches
 *  cases where the user imported a BED that doesn't carry sequences; the
 *  position match catches cases where bp drifts by 1-2 between runs. */
export function isDuplicateOfSaved(
  pair: PrimerPair,
  chrom: string,
  saved: SavedPrimer[],
  tolBp = 5,
): SavedPrimer | null {
  for (const sp of saved) {
    if (!sameChrom(sp.chrom, chrom)) continue;
    const seqMatch = pair.fwd_seq && sp.pair.fwd_seq === pair.fwd_seq
                     && pair.rev_seq && sp.pair.rev_seq === pair.rev_seq;
    const posMatch =
      Math.abs(pair.fwd_start - sp.pair.fwd_start) <= tolBp
      && Math.abs(pair.rev_start - sp.pair.rev_start) <= tolBp;
    if (seqMatch || posMatch) return sp;
  }
  return null;
}
