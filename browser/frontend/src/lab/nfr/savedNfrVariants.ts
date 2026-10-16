/**
 * Accessibility (preview): starred NFRs, one entry per NFR (N1, N2, ...) holding its variants (the Footprints cart's
 * counterpart). The panel shows one list of NFR cards; a star keeps a card (its name, note, colour and ticked
 * variants) and the "Starred" filter shows those. Entries were called "saved" before the list was unified, and are
 * stored as they were: the same store key, session field and localStorage key, so every saved entry is a starred
 * card (nothing to convert).
 *
 * An entry describes itself (locus, every variant's geometry and prevalence when saved, the run it came from), so it
 * outlives the run: sessions keep only the last few runs, and a run whose files changed is not restored. The analysis
 * views need the run; without it the entry still shows what was saved and offers to find variants again there.
 * Saving any variant saves its NFR (with all of its variants, the saved ones ticked); unticking hides a variant from
 * the entry's views. Persisted like footprint carts: the browser store (sessions, undo) and localStorage. Entries of
 * the older per-variant format (sessions, localStorage) are merged into per-NFR entries when they are read.
 */
import type { AccessibilityResult, NfrRegionResult } from './api';
import { nfrColor, variantColor } from './accessibilityView';

export const SAVED_NFR_VARIANTS_STORAGE_KEY = 'fiberhmm_saved_nfr_variants';
export const MAX_SAVED_NFRS = 200;

export interface SavedNfrVariantRef {
  /** The variant's id in the run ('N2:V1') and its name ('V1'). */
  variantId: string;
  name: string;
  /** Left / right edge centres. */
  start: number;
  end: number;
  relation: string;
  depth: string;
  width: number;
  /** Prevalence when saved: EM, strict (>= 0.9) and the conditional bootstrap interval. */
  prevalence: number;
  strict: number;
  ci: [number, number] | null;
  /** Ticked: shown in the entry's views. */
  shown: boolean;
}

export interface SavedNfr {
  /** Stable id of the saved entry. */
  id: string;
  name: string;
  color: string;
  /** The run (Accessibility job) and the NFR's id there ('N2'). */
  jobId: string;
  nfrId: string;
  chrom: string;
  nfrStart: number;
  nfrEnd: number;
  /** The run's window (where Find variants looked). */
  region: { chrom: string; start: number; end: number };
  datasetIds: string[];
  variants: SavedNfrVariantRef[];
  callable: number;
  reads: number;
  stringency: number | null;
  savedAt: number;
  note?: string;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const variantNumber = (name: string) => Number(name.replace(/\D/g, '')) || 0;
const byVariant = (a: { name: string }, b: { name: string }) => variantNumber(a.name) - variantNumber(b.name) || a.name.localeCompare(b.name);
const ciOf = (v: unknown): [number, number] | null => (Array.isArray(v) && v.length === 2 && v.every(isNum) ? [v[0], v[1]] : null);

function normalizeRef(raw: unknown): SavedNfrVariantRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.variantId !== 'string' || !isNum(v.start) || !isNum(v.end)) return null;
  return {
    variantId: v.variantId,
    name: str(v.name) || v.variantId.split(':')[1] || v.variantId,
    start: v.start,
    end: v.end,
    relation: str(v.relation),
    depth: str(v.depth),
    width: isNum(v.width) ? v.width : v.end - v.start,
    prevalence: isNum(v.prevalence) ? v.prevalence : 0,
    strict: isNum(v.strict) ? v.strict : 0,
    ci: ciOf(v.ci),
    shown: v.shown !== false,
  };
}

function header(e: Record<string, unknown>, nfrId: string, chrom: string, fallback: { start: number; end: number }) {
  const region = (e.region && typeof e.region === 'object' ? e.region : {}) as Record<string, unknown>;
  return {
    jobId: e.jobId as string,
    nfrId,
    chrom,
    nfrStart: isNum(e.nfrStart) ? e.nfrStart : fallback.start,
    nfrEnd: isNum(e.nfrEnd) ? e.nfrEnd : fallback.end,
    region: {
      chrom: typeof region.chrom === 'string' ? region.chrom : chrom,
      start: isNum(region.start) ? region.start : fallback.start,
      end: isNum(region.end) ? region.end : fallback.end,
    },
    datasetIds: Array.isArray(e.datasetIds) ? e.datasetIds.filter((d): d is string => typeof d === 'string') : [],
    callable: isNum(e.callable) ? e.callable : 0,
    reads: isNum(e.reads) ? e.reads : 0,
    stringency: isNum(e.stringency) ? e.stringency : null,
    savedAt: isNum(e.savedAt) ? e.savedAt : 0,
  };
}

/**
 * Saved entries from untrusted input (sessions, localStorage, undo snapshots): per-NFR entries as they are, and
 * entries of the older per-variant format merged into one entry per (run, NFR); a renamed or annotated old entry
 * keeps its name and note in the merged entry's note.
 */
export function normalizeSavedNfrVariants(value: unknown): SavedNfr[] {
  if (!Array.isArray(value)) return [];
  const out: SavedNfr[] = [];
  const seen = new Set<string>();
  const byNfr = new Map<string, SavedNfr>();
  const notes = new Map<string, string[]>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.id !== 'string' || seen.has(e.id) || typeof e.jobId !== 'string' || typeof e.chrom !== 'string') continue;
    if (Array.isArray(e.variants)) {
      // per-NFR entry
      if (typeof e.nfrId !== 'string') continue;
      const refs = e.variants.map(normalizeRef).filter((r): r is SavedNfrVariantRef => !!r)
        .filter((r, i, all) => all.findIndex(x => x.variantId === r.variantId) === i).sort(byVariant);
      if (!refs.length) continue;
      const key = `${e.jobId}\u0000${e.nfrId}`;
      const existing = byNfr.get(key);
      if (existing) { mergeRefs(existing, refs); continue; }
      if (out.length >= MAX_SAVED_NFRS) continue;             // full: only entries of NFRs already kept still merge
      seen.add(e.id);
      const lo = Math.min(...refs.map(r => r.start)), hi = Math.max(...refs.map(r => r.end));
      const entry: SavedNfr = {
        id: e.id, name: str(e.name).trim() || e.nfrId, color: typeof e.color === 'string' ? e.color : nfrColor(e.nfrId),
        ...header(e, e.nfrId, e.chrom, { start: lo, end: hi }), variants: refs,
        ...(typeof e.note === 'string' && e.note ? { note: e.note } : {}),
      };
      byNfr.set(key, entry);
      out.push(entry);
    } else if (typeof e.variantId === 'string') {
      // older per-variant entry: merged into its NFR's entry
      const ref = normalizeRef({ ...e, name: String(e.variantId).split(':')[1], shown: true });
      if (!ref) continue;
      const nfrId = typeof e.nfrId === 'string' ? e.nfrId : e.variantId.split(':')[0];
      const key = `${e.jobId}\u0000${nfrId}`;
      if (!byNfr.has(key) && out.length >= MAX_SAVED_NFRS) continue;
      seen.add(e.id);
      const defaultName = `${nfrId} ${ref.name} ${ref.relation}`.trim();
      const custom = [str(e.name).trim() && str(e.name).trim() !== defaultName ? str(e.name).trim() : '', str(e.note).trim()].filter(Boolean).join(': ');
      if (custom) notes.set(key, [...(notes.get(key) ?? []), `${ref.name}: ${custom}`]);
      const existing = byNfr.get(key);
      if (existing) { mergeRefs(existing, [ref]); continue; }
      const entry: SavedNfr = {
        id: e.id, name: nfrId, color: nfrColor(nfrId), ...header(e, nfrId, e.chrom, { start: ref.start, end: ref.end }), variants: [ref],
      };
      byNfr.set(key, entry);
      out.push(entry);
    }
  }
  for (const [key, lines] of notes) {
    const entry = byNfr.get(key);
    if (entry) entry.note = [entry.note, ...lines].filter(Boolean).join(' · ');
  }
  return out;
}

function mergeRefs(entry: SavedNfr, refs: SavedNfrVariantRef[]) {
  for (const r of refs) {
    const at = entry.variants.findIndex(x => x.variantId === r.variantId);
    if (at < 0) entry.variants.push(r);
    else if (r.shown && !entry.variants[at].shown) entry.variants[at] = { ...entry.variants[at], shown: true };
  }
  entry.variants.sort(byVariant);
}

export function loadSavedNfrVariants(): SavedNfr[] {
  try {
    const stored = localStorage.getItem(SAVED_NFR_VARIANTS_STORAGE_KEY);
    return stored ? normalizeSavedNfrVariants(JSON.parse(stored)) : [];
  } catch {
    return [];
  }
}

export function storeSavedNfrVariants(entries: SavedNfr[]): void {
  try {
    localStorage.setItem(SAVED_NFR_VARIANTS_STORAGE_KEY, JSON.stringify(entries));
  } catch { /* private mode / quota: the store still has them */ }
}

/** A saved entry for one NFR of a run: every variant, those in ``shownIds`` ticked (all when omitted). */
export function savedFromNfr(
  jobId: string, result: AccessibilityResult, nfr: NfrRegionResult, datasetIds: string[], shownIds?: string[],
): Omit<SavedNfr, 'id' | 'savedAt'> {
  return {
    name: nfr.id,
    color: nfrColor(nfr.id),
    jobId,
    nfrId: nfr.id,
    chrom: result.region.chrom,
    nfrStart: nfr.start,
    nfrEnd: nfr.end,
    region: { ...result.region },
    datasetIds: [...datasetIds],
    variants: nfr.variants.map(v => ({
      variantId: v.id, name: v.name, start: Math.round(v.L), end: Math.round(v.R), relation: v.relation, depth: v.depth, width: v.width,
      prevalence: v.prevalence, strict: v.strict, ci: v.ci, shown: !shownIds || shownIds.includes(v.id),
    })).sort(byVariant),
    callable: nfr.callable,
    reads: nfr.reads,
    stringency: typeof result.parameters?.stringency === 'number' ? result.parameters.stringency as number : null,
  };
}

/** Same NFR of the same run: saving it again ticks the newly saved variants in the existing entry. */
export function sameSavedNfr(a: Pick<SavedNfr, 'jobId' | 'nfrId'>, b: Pick<SavedNfr, 'jobId' | 'nfrId'>): boolean {
  return a.jobId === b.jobId && a.nfrId === b.nfrId;
}

/** Variants of an entry that are ticked (shown in its views). */
export const shownVariants = (e: SavedNfr): SavedNfrVariantRef[] => e.variants.filter(v => v.shown);

/** Ticked variant ids of starred entries of a run ('N1:V2'). */
export function savedVariantIds(entries: SavedNfr[], jobId: string | null | undefined): Set<string> {
  return new Set(entries.filter(e => e.jobId === jobId).flatMap(e => shownVariants(e).map(v => v.variantId)));
}

/** BED6+ of the ticked variants of saved NFRs (0-based half-open; score = EM prevalence x 1000; the variant's colour). */
export function savedVariantsBed(entries: SavedNfr[]): string {
  const lines = ['track name="NFR variants" description="FiberBrowser Accessibility (preview) saved NFR variants" itemRgb="On"'];
  for (const e of entries) {
    for (const v of shownVariants(e)) {
      const name = `${e.name}_${v.name}${v.relation ? `_${v.relation}` : ''}`.replace(/\s+/g, '_');
      const start = Math.max(0, Math.round(v.start)), end = Math.round(v.end);
      lines.push([e.chrom, start, end, name, Math.round(Math.max(0, Math.min(1, v.prevalence)) * 1000), '.', start, end, hexToRgb(variantColor(v.name))].join('\t'));
    }
  }
  return lines.join('\n') + '\n';
}

function hexToRgb(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return '0,0,0';
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

/** The key of an NFR card in the panel's one list: '<run>|<NFR>' (a starred entry and the run's card share it). */
export const cardKey = (jobId: string, nfrId: string): string => `${jobId}|${nfrId}`;

/**
 * The list's two parts: the starred entries of the run the panel shows (merged onto their NFR's card, by card key) and
 * the earlier ones (another run: other windows, or runs a reloaded session no longer has), kept with their stored
 * numbers in a collapsed group. Each keeps the saved order.
 */
export function starredSplit(saved: SavedNfr[], jobId: string | null): { here: Map<string, SavedNfr>; earlier: SavedNfr[] } {
  const here = new Map<string, SavedNfr>();
  const earlier: SavedNfr[] = [];
  for (const e of saved) {
    if (jobId && e.jobId === jobId) here.set(cardKey(e.jobId, e.nfrId), e);
    else earlier.push(e);
  }
  return { here, earlier };
}

/** The entry an NFR card of the shown run works on: its starred entry, else one made from the run (not stored), with
 * the variants unticked on the card left out of its views. */
export function cardEntry(jobId: string, result: AccessibilityResult, nfr: NfrRegionResult, starred: SavedNfr | undefined,
  unticked: string[] = []): SavedNfr {
  if (starred) return starred;
  const ids = nfr.variants.map(v => v.id).filter(id => !unticked.includes(id));
  return { ...savedFromNfr(jobId, result, nfr, result.datasets.map(d => d.dataset_id), ids), id: cardKey(jobId, nfr.id), savedAt: 0 };
}
