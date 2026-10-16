import type { FootprintGroup } from '../../../types';

/** Tab keys for the FootprintAnalysisPanel: States (find states, filter,
 *  pick what to compare), Saved (saved definitions) and Co-occupancy. */
export type TabKey = 'states' | 'saved' | 'co-occ';

export const FOOTPRINT_ANALYSIS_TAB_STORAGE_KEY = 'fiberbrowser_footprint_analysis_tab';

// Older builds, sessions and other panels still request these names.
const LEGACY_TABS: Record<string, TabKey> = {
  cart: 'saved',
  families: 'states', define: 'states', setup: 'states', comparison: 'states',
  tracks: 'states', transcription: 'states', filters: 'states', sequence: 'states',
  overlap: 'states', sizes: 'states', profiles: 'states', vplot: 'states',
};

export function normalizeFootprintAnalysisTab(
  tab: string | null | undefined,
  fallback: TabKey = 'states',
): TabKey {
  if (!tab) return fallback;
  if (tab === 'states' || tab === 'saved' || tab === 'co-occ') return tab;
  return LEGACY_TABS[tab] ?? fallback;
}

export const BASE_COLORS: Record<string, string> = {
  A: '#22a559',
  C: '#2563eb',
  G: '#d97706',  // deep amber — visible on white
  T: '#dc2626',
};

// Palette for auto-assigning group colors — high-contrast on white
export const GROUP_PALETTE = ['#3b82f6', '#ef4444', '#10b981', '#8b5cf6', '#ec4899', '#06b6d4', '#0e7490', '#d63384'];

// Palette for motif annotation colors — high-contrast on white
export const MOTIF_PALETTE = ['#6366f1','#ec4899','#14b8a6','#0e7490','#8b5cf6','#06b6d4','#059669','#f43f5e','#3b82f6','#a21caf'];

export const TRACK_COLORS = ['#2563eb', '#dc2626', '#059669', '#7c3aed', '#d63384', '#0891b2'];

export function assignMotifColors(names: string[]): Map<string, string> {
  const map = new Map<string, string>();
  [...new Set(names)].sort().forEach((n, i) => map.set(n, MOTIF_PALETTE[i % MOTIF_PALETTE.length]));
  return map;
}

export function nextGroupColor(existing: FootprintGroup[]): string {
  const used = new Set(existing.map(g => g.color));
  return GROUP_PALETTE.find(c => !used.has(c)) ?? GROUP_PALETTE[existing.length % GROUP_PALETTE.length];
}
