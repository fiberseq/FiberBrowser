/**
 * The pinned key-factor motifs, per species ('fly', 'human', ...): always reported in the motif views (Footprints'
 * class inspection, and plugin packs' motif views). A species without an entry uses the server's defaults (Zelda, GAF,
 * CLAMP, ... for fly; CTCF, AP-1, SP/KLF, ... for human and mouse). Persisted in the browser store (sessions) and in
 * localStorage (and on the server: utils/analysisPreferences.ts).
 */
export const PINNED_MOTIFS_STORAGE_KEY = 'fiberhmm_pinned_motifs';
export const MAX_PINNED_MOTIFS = 100;

export type PinnedMotifs = Record<string, string[]>;

export function normalizePinnedMotifs(value: unknown): PinnedMotifs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: PinnedMotifs = {};
  for (const [species, list] of Object.entries(value as Record<string, unknown>)) {
    if (!species || !Array.isArray(list)) continue;
    const seen = new Set<string>();
    const names: string[] = [];
    for (const raw of list) {
      if (typeof raw !== 'string') continue;
      const name = raw.trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      names.push(name);
      if (names.length >= MAX_PINNED_MOTIFS) break;
    }
    out[species] = names;
  }
  return out;
}

export function loadPinnedMotifs(): PinnedMotifs {
  try {
    const stored = localStorage.getItem(PINNED_MOTIFS_STORAGE_KEY);
    return stored ? normalizePinnedMotifs(JSON.parse(stored)) : {};
  } catch {
    return {};
  }
}

export function storePinnedMotifs(value: PinnedMotifs): void {
  try {
    localStorage.setItem(PINNED_MOTIFS_STORAGE_KEY, JSON.stringify(value));
  } catch { /* private mode / quota: the store still has them */ }
}
