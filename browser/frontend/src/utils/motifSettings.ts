/**
 * Motif scoring settings shared by the analysis panels (Footprints, and plugin packs' motif views): the scoring mode
 * and its thresholds, and the user's own matrices. Kept in the browser store (sessions, undo) and in localStorage (a
 * per-viewer preference); validated whenever they are read.
 *
 * Scoring modes:
 * - 'p' (default): a site passes at p <= the threshold for its own matrix (exact score distribution), so short and long
 *   matrices are held to the same false-positive rate; comparable across motifs.
 * - 'relative': the older behaviour, a share of each matrix's score range (motifThreshold, 0.5-1); not comparable
 *   across motifs. A session saved before the toggle existed restores in this mode.
 */

export type MotifScoreMode = 'p' | 'relative';
export const DEFAULT_MOTIF_P = 1e-4;
export const MOTIF_P_MIN = 1e-8;
export const MOTIF_P_MAX = 1e-2;

export interface CustomMotif { name: string; counts: Record<'A' | 'C' | 'G' | 'T', number[]> }

const KEY_CUSTOM = 'fiberhmm_custom_motifs';
const KEY_SCORING = 'fiberhmm_motif_scoring';
export const MAX_CUSTOM_MOTIFS = 50;

export const num = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;

export function clampMotifP(v: unknown): number {
  return num(v, MOTIF_P_MIN, MOTIF_P_MAX, DEFAULT_MOTIF_P);
}

export function normalizeScoreMode(v: unknown): MotifScoreMode {
  return v === 'relative' ? 'relative' : 'p';
}

export function normalizeCustomMotifs(value: unknown): CustomMotif[] {
  if (!Array.isArray(value)) return [];
  const out: CustomMotif[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim().slice(0, 60) : '';
    const c = (r.counts && typeof r.counts === 'object' ? r.counts : {}) as Record<string, unknown>;
    const cols = (['A', 'C', 'G', 'T'] as const).map(b => (Array.isArray(c[b]) ? (c[b] as unknown[]).map(Number) : []));
    const L = cols[0].length;
    if (!name || seen.has(name.toLowerCase()) || L < 3 || L > 60 || cols.some(x => x.length !== L || x.some(y => !Number.isFinite(y) || y < 0))) continue;
    seen.add(name.toLowerCase());
    out.push({ name, counts: { A: cols[0], C: cols[1], G: cols[2], T: cols[3] } });
    if (out.length >= MAX_CUSTOM_MOTIFS) break;
  }
  return out;
}

export function load<T>(key: string, normalize: (v: unknown) => T): T {
  try {
    const raw = localStorage.getItem(key);
    return normalize(raw ? JSON.parse(raw) : undefined);
  } catch {
    return normalize(undefined);
  }
}
export function store(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode / quota */ }
}

export const loadCustomMotifs = () => load(KEY_CUSTOM, normalizeCustomMotifs);
export const storeCustomMotifs = (v: CustomMotif[]) => store(KEY_CUSTOM, v);
export const loadMotifScoring = () => load(KEY_SCORING, v => {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return { mode: normalizeScoreMode(r.mode), p: clampMotifP(r.p) };
});
export const storeMotifScoring = (v: { mode: MotifScoreMode; p: number }) => store(KEY_SCORING, v);

/** "3.2e-5" (two significant digits). */
export function formatP(p: number): string {
  if (!Number.isFinite(p)) return '–';
  return p >= 1e-3 ? String(Number(p.toPrecision(2))) : p.toExponential(1).replace('e-', 'e−');
}

/** A typed p ("3.2e-5", "0.0001", "1e−4") or null. */
export function parseP(text: string): number | null {
  const v = Number(text.trim().replace('−', '-').replace(/\s+/g, ''));
  return Number.isFinite(v) && v > 0 ? clampMotifP(v) : null;
}

/** The request fields the motif endpoints take, from the shared settings. */
export function motifRequestOptions(mode: MotifScoreMode, p: number, relative: number) {
  return mode === 'relative' ? { mode, relative } : { mode, p };
}
