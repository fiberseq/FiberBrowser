/**
 * Accessibility (preview): which ChIP-Atlas experiments the NFR panel's peak check takes, per assembly (dm6, hg38, ...):
 * cell type classes and cell types (ChIP-Atlas' tissue / developmental stage / cell line names). Kept in the browser
 * store (chipAtlasSelections: sessions carry it) and by the server on this computer (utils/analysisPreferences.ts),
 * localStorage as the fallback; without a remembered choice, the cell types named in the datasets' labels or file
 * names, else all.
 */
import type { ChipAtlasSelection } from './api';

export const CHIPATLAS_SELECTION_STORAGE_KEY = 'fiberhmm_chipatlas_selection';
export const ALL_EXPERIMENTS: ChipAtlasSelection = { cellTypeClasses: [], cellTypes: [] };

const names = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && !!x.trim()))].slice(0, 200) : []);

export function normalizeChipAtlasSelections(value: unknown): Record<string, ChipAtlasSelection> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, ChipAtlasSelection> = {};
  for (const [genome, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!genome || !raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    out[genome] = { cellTypeClasses: names(r.cellTypeClasses), cellTypes: names(r.cellTypes) };
  }
  return out;
}

/** Every assembly's choice this browser stored itself (the fallback, and what moves to the server once). */
export function loadStoredChipAtlasSelections(): Record<string, ChipAtlasSelection> {
  try {
    const raw = localStorage.getItem(CHIPATLAS_SELECTION_STORAGE_KEY);
    return raw ? normalizeChipAtlasSelections(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

export function storeStoredChipAtlasSelections(value: Record<string, ChipAtlasSelection>): void {
  try {
    localStorage.setItem(CHIPATLAS_SELECTION_STORAGE_KEY, JSON.stringify(value));
  } catch { /* private mode / quota: the store still has them */ }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The cell types whose name is a whole word of a dataset's label or file name ("K562_DddA" -> K562, "S2_rep1" -> S2);
 * an empty list when none is (then every experiment). */
export function cellTypesNamedIn(texts: string[], cellTypes: string[]): string[] {
  const tokens = new Set(texts.flatMap(t => t.split(/[^A-Za-z0-9+]+/)).map(norm).filter(t => t.length >= 2));
  return cellTypes.filter(c => { const n = norm(c); return n.length >= 2 && tokens.has(n); });
}
