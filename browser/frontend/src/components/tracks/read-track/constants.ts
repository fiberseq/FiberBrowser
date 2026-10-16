import { clusterGroupLabel } from '../../../utils/clusterGroupLabels';
// Colors
export const COLOR_WHITE = '#ffffff';
export const COLOR_GAP = '#f5f5f5';
export const COLOR_SUBNUC = '#8c8c8c';
export const COLOR_NUC = '#33a040';
export const COLOR_POL2 = '#ff69b4';
export const COLOR_TF = '#87ceeb';

/**
 * Cluster colours (cluster id -> colour), the one palette for the read panel's
 * cluster bar, the projection map, cluster charts, legends and exports (the
 * Python renderers mirror it: browser/utils/colors.py).
 *
 * The first 12 are a categorical set chosen for these checks (constants
 * tested in clusterPalette.test.ts): every pair differs by CIEDE2000 ΔE ≥ 20
 * as drawn (≥ 15 as the map's 75%-opaque dots on white or on the dark
 * surface), ≥ 10 under protan, deutan and tritan simulation (Machado 2009),
 * each stands off the white and dark surfaces and the unassigned grey, and
 * none is a data-track landmark (nucleosome green, TF sky-blue / fuchsia).
 * The 12 after them (clusters 12-23) are as far from all the others as the
 * colour space allows, without that guarantee.
 */
export const CLUSTER_COLORS = [
  // Primary set (12): distinct for full colour vision and the common colour-vision deficiencies.
  '#ef3a7d', '#0f46e1', '#c3b503', '#057558', '#8c418b', '#46d6d1',
  '#bd854d', '#963d3b', '#acb8fe', '#6c760a', '#f8a49e', '#2c94b0',
  // Extended set (12 more for 24 total).
  '#05e857', '#fb86fc', '#7a4800', '#f13e18', '#83a777', '#7577ac',
  '#055f73', '#a543ff', '#1387fe', '#b682a6', '#fcb02b', '#ae7167',
];
export const UNASSIGNED_CLUSTER_ID = -1;
export const UNASSIGNED_CLUSTER_COLOR = '#9ca3af';

export function getClusterColor(cluster: number): string {
  if (cluster === UNASSIGNED_CLUSTER_ID) return UNASSIGNED_CLUSTER_COLOR;
  return CLUSTER_COLORS[((cluster % CLUSTER_COLORS.length) + CLUSTER_COLORS.length) % CLUSTER_COLORS.length];
}

export function getClusterLabel(cluster: number, compact = false): string {
  if (cluster === UNASSIGNED_CLUSTER_ID) return compact ? 'Unassigned' : 'Unassigned (no overlap)';
  // A group source's own name (the SV allele split's "Carriers" ...).
  const named = clusterGroupLabel(cluster);
  if (named) return named;
  return compact ? `C${cluster}` : `Cluster ${cluster}`;
}

export const SIDEBAR_WIDTH = 16;  // Cluster sidebar width
export const MAX_REGION_FOR_READS = 100_000; // 100 KB — skip read fetch when zoomed out beyond this

// Modification type colors. Must match utils/layerColors.ts KNOWN_COLORS.
export const MOD_COLORS = {
  m6a: '#6b21a8',   // purple (m6A methylation)
  mod: '#6b21a8',   // purple (back-compat alias for m6a)
  m5c: '#dc2626',   // red (5mC methylation)
  // Deam paints in two shades so the user can distinguish deamination
  // direction at a glance: R (GA-strand) is a bright teal, Y (CT-strand) is
  // a deep teal. Wider value gap than before so the two strands read
  // clearly on both light and dark canvases without shifting hue.
  deam: '#2dd4bf',       // bright teal, default / R / GA-dea (blockMod 0)
  deam_r: '#2dd4bf',     // bright teal (teal-400)
  deam_y: '#115e59',     // deep teal (teal-800) / Y / CT-dea (blockMod 1)
  deam_observed: '#111827', // black/slate observed event when opportunity rugs are visible
  deam_possible_ct: '#0d9488', // possible C site, short top tick
  deam_possible_ga: '#d97706', // possible G site, short bottom tick
  msp: '#ea580c',   // internal legacy key; displayed as FIRE
  fire: '#ea580c',  // orange (FIRE regulatory elements)
  footprint: '#16a34a', // green
  tf: '#e040fb',    // fuchsia (HMM-called TF footprints)
  nuc: '#16a34a',   // green (nucleosome layer — same as footprint default)
} as const;

// CIGAR event colors
export const CIGAR_COLORS = {
  // Mismatch colors by base
  A: '#22c55e',  // green
  T: '#ef4444',  // red
  G: '#f97316',  // orange
  C: '#3b82f6',  // blue
  N: '#6b7280',  // gray
  // Event type colors
  insertion: '#a855f7', // purple
  deletion: '#374151',  // dark gray
} as const;

// Stable empty references to prevent unnecessary re-renders
export const EMPTY_OBJECT: Record<string, number> = {};
export const EMPTY_STRING_ARRAY: string[] = [];
export const EMPTY_NUMBER_ARRAY: number[] = [];
