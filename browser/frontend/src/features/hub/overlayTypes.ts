/**
 * The overlaid patch view (DESIGN §8, hub V1): settings and result shapes, and their session form.
 *
 * For a mark layer (nucleosome segments and events, footprint calls) and a set of loci (hub hits, an anchor set, the
 * nucleosome panel's patches), each locus is aligned at its anchor (with strand), its left or right edge, or scaled
 * to unit length; the backend pools every molecule measured at each aligned position, per observation (a dataset
 * panel, a haplotype, a graph path): density = molecules with the mark / molecules measured there.
 */

export type OverlayAlign = 'anchor' | 'left' | 'right' | 'scaled';
export type OverlayLayer = 'regular' | 'disordered' | 'undetermined' | 'low_information' | 'undersized' | 'missing' | 'nucleosome' | 'tf';

export const OVERLAY_LAYERS: Array<{ key: OverlayLayer; label: string }> = [
  { key: 'regular', label: 'Regular arrays (nucseg)' },
  { key: 'disordered', label: 'Disordered arrays (nucseg)' },
  { key: 'undetermined', label: 'Undetermined segments (nucseg)' },
  { key: 'low_information', label: 'Low-information segments (nucseg)' },
  { key: 'undersized', label: 'Undersized runs (nucseg events)' },
  { key: 'missing', label: 'Missing nucleosomes (nucseg events)' },
  { key: 'nucleosome', label: 'Nucleosome footprints (nucsz)' },
  { key: 'tf', label: 'TF footprints (nucsz)' },
];

export interface OverlayLocus {
  key: string;
  chrom: string; start: number; end: number; anchor: number; strand?: '+' | '-';
  label?: string; hitId?: string; setId?: string;
  /** Graph columns' per-path statuses (graph mode: carriers only). */
  paths?: Record<string, { status: string; hap?: string; datasets?: string[] }>;
  /** It sits at an insertion's junction on this genome (its sequence is inside the insertion). */
  insertion?: boolean;
  /** A hit of another assembly: its source coordinates (on its haplotype's contig). */
  source?: { chrom: string; start: number; end: number; anchor: number; hap?: string; strand?: '+' | '-'; datasetId?: string };
}

export interface OverlaySeries {
  obsId: string; label: string; datasetId?: string; kind: string; hap?: string;
  /** Absent on an observation that failed (error). */
  x: number[];
  num: number[];
  den: number[];
  loci: number;
  lociSkipped?: Record<string, number>;
  molecules: number;
  notComputed?: number;
  error?: string;
}

export interface OverlayPileRow {
  obsId: string; locus: string; molecule: string; marks: Array<[number, number]>; measured: Array<[number, number]>; length: number;
}

export interface OverlayResult {
  layer: OverlayLayer; align: OverlayAlign; flank: number; binBp: number; scaledBins?: number;
  /** The axis: bin centres (bp, or 0–1 inside a scaled patch with flanks as -bp and 1 + bp). */
  x?: number[];
  xLabel: string;
  series: OverlaySeries[];
  pile: OverlayPileRow[];
  pileTotal: number;
  loci: number;
  graphMode?: boolean;
  notes?: string[];
}

export interface OverlayState {
  loci: 'selection' | 'set' | 'anchors' | 'patches';
  setId?: string;
  anchorSetId?: string;
  layer: OverlayLayer;
  align: OverlayAlign;
  flank: number;
  view: 'profile' | 'facets' | 'pile';
  pileSort: 'length' | 'group';
  /** The loci a hand-off sent (the nucleosome panel's patch list). */
  handed?: OverlayLocus[];
  result?: OverlayResult | null;
}

export const DEFAULT_OVERLAY: OverlayState = { loci: 'selection', layer: 'regular', align: 'left', flank: 1000, view: 'profile', pileSort: 'length' };

const ALIGNS: OverlayAlign[] = ['anchor', 'left', 'right', 'scaled'];
const LOCI = ['selection', 'set', 'anchors', 'patches'] as const;

export function normalizeOverlay(value: unknown): OverlayState {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const layer = OVERLAY_LAYERS.some(l => l.key === v.layer) ? v.layer as OverlayLayer : DEFAULT_OVERLAY.layer;
  const result = v.result && typeof v.result === 'object' && Array.isArray((v.result as OverlayResult).series) ? v.result as OverlayResult : null;
  return {
    loci: LOCI.includes(v.loci as typeof LOCI[number]) ? v.loci as OverlayState['loci'] : 'selection',
    ...(typeof v.setId === 'string' ? { setId: v.setId } : {}),
    ...(typeof v.anchorSetId === 'string' ? { anchorSetId: v.anchorSetId } : {}),
    layer, align: ALIGNS.includes(v.align as OverlayAlign) ? v.align as OverlayAlign : DEFAULT_OVERLAY.align,
    flank: typeof v.flank === 'number' && Number.isFinite(v.flank) ? Math.max(0, Math.min(20_000, v.flank)) : DEFAULT_OVERLAY.flank,
    view: v.view === 'facets' || v.view === 'pile' ? v.view : 'profile',
    pileSort: v.pileSort === 'group' ? 'group' : 'length',
    ...(Array.isArray(v.handed) ? { handed: (v.handed as OverlayLocus[]).filter(l => l && typeof l.chrom === 'string').slice(0, 5000) } : {}),
    ...(result ? { result } : {}),
  };
}
