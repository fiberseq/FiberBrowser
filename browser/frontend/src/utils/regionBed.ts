import type { RegionCatalog, RegionCategory, RegionEntry } from '../types/regions';
import type { ChromInfo } from '../types';
import { findChromInfo } from './chromAliases';

/**
 * Regions as BED, both ways, keeping the catalog's categories.
 *
 * Written: one `track name="<category>"` line before each category's regions
 * (a subheading as `track name="<parent> / <child>"`), then BED6 rows:
 * chrom, start (0-based), end, name (the label), score (0 when none), strand
 * ('.' when none). Read back, track lines become the categories again.
 *
 * Read: BED3 and up (tab-separated; whitespace when a file has no tabs).
 * `#` comments and `browser` lines are skipped. The name column is the label;
 * a name written `Category | label` files the region under that category (for
 * files made elsewhere: only where no track line names the category, so a
 * label that contains a pipe survives export and re-import). Without either, regions go in
 * the category the caller names (the file's name). Score and strand are kept.
 */

export const BED_HELP = 'BED: one region per line (chrom, start, end, name, score, strand). '
  + 'A track line (track name="Enhancers") starts a category; "Parent / Child" makes a subheading. '
  + 'A name written "Category | label" files the region under that category when no track line names one. Export writes track lines.';

export interface ParsedBedRegion {
  chrom: string;
  start: number;
  end: number;
  label: string;
  /** The category path from the track line or the name ("Parent / Child"), if any. */
  categoryPath?: string[];
  score?: number;
  strand?: string;
}

export interface ParsedBed {
  regions: ParsedBedRegion[];
  skipped: number;
  /** First few problems, for the user. */
  problems: string[];
}

function trackName(line: string): string | null {
  const quoted = line.match(/\bname=(?:"([^"]*)"|'([^']*)')/);
  if (quoted) return (quoted[1] ?? quoted[2] ?? '').trim() || null;
  const bare = line.match(/\bname=(\S+)/);
  return bare ? bare[1].trim() || null : null;
}

/** "Parent / Child" → ['Parent', 'Child'] (one level of nesting kept). */
export function categoryPath(name: string): string[] {
  const parts = name.split(' / ').map(p => p.trim()).filter(Boolean);
  if (parts.length <= 1) return parts.length ? parts : [];
  return [parts[0], parts.slice(1).join(' / ')];
}

export function parseRegionBed(text: string): ParsedBed {
  const regions: ParsedBedRegion[] = [];
  const problems: string[] = [];
  let skipped = 0;
  let current: string[] | undefined;
  const lines = text.split(/\r?\n/);
  const useTabs = text.includes('\t');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('browser')) continue;
    if (/^track(\s|$)/.test(line)) {
      const name = trackName(line);
      current = name ? categoryPath(name) : undefined;
      continue;
    }
    const cols = useTabs ? raw.split('\t').map(c => c.trim()) : line.split(/\s+/);
    if (cols.length < 3) {
      skipped += 1;
      if (problems.length < 5) problems.push(`Line ${i + 1}: fewer than 3 columns`);
      continue;
    }
    const start = Number(cols[1]);
    const end = Number(cols[2]);
    if (!cols[0] || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
      skipped += 1;
      if (problems.length < 5) problems.push(`Line ${i + 1}: not chrom, start, end`);
      continue;
    }
    let label = (cols[3] ?? '').trim();
    let path = current;
    // "Category | label" only where no track line names the category (a label may contain a pipe).
    const pipe = current ? -1 : label.indexOf(' | ') >= 0 ? label.indexOf(' | ') : label.indexOf('|');
    if (pipe > 0) {
      const sep = label.slice(pipe, pipe + 3) === ' | ' ? 3 : 1;
      path = categoryPath(label.slice(0, pipe).trim());
      label = label.slice(pipe + sep).trim();
    }
    if (!label || label === '.') label = `${cols[0]}:${start.toLocaleString()}-${end.toLocaleString()}`;
    const region: ParsedBedRegion = { chrom: cols[0], start, end, label };
    if (path && path.length) region.categoryPath = path;
    if (cols[4] !== undefined && cols[4] !== '.' && cols[4] !== '') {
      const score = Number(cols[4]);
      if (Number.isFinite(score)) region.score = score;
    }
    if (cols[5] === '+' || cols[5] === '-') region.strand = cols[5];
    regions.push(region);
  }
  return { regions, skipped, problems };
}

function clean(text: string): string {
  return text.replace(/[\t\r\n]+/g, ' ').trim();
}

function quoted(text: string): string {
  return `"${clean(text).replace(/"/g, "'")}"`;
}

/** The categories in display order with their full names ("Parent / Child"). */
export function categoryOrder(catalog: Pick<RegionCatalog, 'categories'>): Array<{ category: RegionCategory; path: string }> {
  const out: Array<{ category: RegionCategory; path: string }> = [];
  const byId = new Map(catalog.categories.map(c => [c.id, c]));
  for (const top of catalog.categories.filter(c => !c.parent || !byId.has(c.parent))) {
    out.push({ category: top, path: top.name });
    for (const child of catalog.categories.filter(c => c.parent === top.id)) {
      out.push({ category: child, path: `${top.name} / ${child.name}` });
    }
  }
  return out;
}

/**
 * BED text of these entries (all, or a selection), grouped by category in
 * display order, with a track line per category so a re-import restores them.
 */
export function regionsToBed(catalog: RegionCatalog, entries: RegionEntry[] = catalog.entries): string {
  const lines = [`# FiberBrowser regions (${clean(catalog.genome)}). ${BED_HELP}`];
  const wanted = new Set(entries.map(e => e.id));
  const byCategory = new Map<string, RegionEntry[]>();
  for (const entry of catalog.entries) {
    if (!wanted.has(entry.id)) continue;
    const list = byCategory.get(entry.category) ?? [];
    list.push(entry);
    byCategory.set(entry.category, list);
  }
  const emit = (path: string | null, list: RegionEntry[]) => {
    if (!list.length) return;
    if (path) lines.push(`track name=${quoted(path)}`);
    for (const e of list) {
      // Whole scores as integers (BED); a fractional one is kept (to 3 decimals) so a re-import gives it back.
      const score = Number.isFinite(e.score) ? Number((e.score as number).toFixed(3)) : 0;
      lines.push([e.chrom, e.start, e.end, clean(e.label) || '.', score, e.strand === '+' || e.strand === '-' ? e.strand : '.'].join('\t'));
    }
  };
  const known = new Set<string>();
  for (const { category, path } of categoryOrder(catalog)) {
    known.add(category.id);
    emit(path, byCategory.get(category.id) ?? []);
  }
  // Entries whose category is gone (should not happen): last, without a track line.
  emit('Uncategorized', [...byCategory.entries()].filter(([id]) => !known.has(id)).flatMap(([, list]) => list));
  return `${lines.join('\n')}\n`;
}

/** A reference's chromosomes, for checking a BED file against it. */
export interface ReferenceChroms {
  key: string;
  chroms: Array<{ name: string; size: number }>;
}

export interface BedReferenceFit {
  key: string;
  /** Regions on a chromosome of this reference, inside its length. */
  fits: number;
  /** Chromosomes of the file this reference doesn't have (first few). */
  missing: string[];
}

/** How well a BED file's regions fit each reference (chr1 / 1 alike); best first, ties in the given order. */
export function bedReferenceFit(regions: Array<Pick<ParsedBedRegion, 'chrom' | 'end'>>, references: ReferenceChroms[]): BedReferenceFit[] {
  const fit = references.map(ref => {
    const sizeOf = new Map<string, number | null>();
    let fits = 0;
    const missing: string[] = [];
    for (const r of regions) {
      let size = sizeOf.get(r.chrom);
      if (size === undefined) {
        size = findChromInfo(ref.chroms as ChromInfo[], r.chrom)?.size ?? null;
        sizeOf.set(r.chrom, size);
      }
      if (size != null && r.end <= size) fits += 1;
      else if (size == null && !missing.includes(r.chrom) && missing.length < 4) missing.push(r.chrom);
    }
    return { key: ref.key, fits, missing };
  });
  return fit.map((f, i) => ({ f, i })).sort((a, b) => b.f.fits - a.f.fits || a.i - b.i).map(x => x.f);
}
