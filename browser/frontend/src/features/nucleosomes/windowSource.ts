/**
 * Window mode's window, anchor and background anchors (NUC §3.7, §6.2), resolved from the panel's settings and the
 * browser state: the view, the first selected peak, the first selected hub hit, typed coordinates or a hand-off. A
 * peak's, hit's or hand-off's window is its span widened to its anchor ± the flank, so the window metrics and the
 * phasing see the nucleosomes around it. Background anchors (the dephasing readout) are the other selected hub hits.
 */
import type { HubSelected } from '../hub/hubState';
import type { NucAnchorSettings, NucPanelState, NucWindow, NucWindowSource } from './types';

export const DEFAULT_FLANK = 1000;

export interface WindowInputs {
  chrom: string;
  start: number;
  end: number;
  /** Selected peaks (getAllPeaks filtered to the selection). */
  peaks: Array<{ chrom?: string; start: number; end: number; index: number }>;
  hubSelected: HubSelected[];
}

export interface ResolvedWindow {
  window: { chrom: string; start: number; end: number };
  label: string;
  anchor: { pos: number; orientation: number } | null;
  background: Array<{ chrom: string; pos: number; orientation: number }>;
}

export type WindowResolution = ResolvedWindow | { error: string };

const strandOf = (s?: '+' | '-') => (s === '+' ? 1 : s === '-' ? -1 : 0);
const loc = (c: string, s: number, e: number) => `${c}:${(s + 1).toLocaleString()}-${e.toLocaleString()}`;

/** Parse "chr1:1,000-2,000" (1-based, inclusive) into a half-open window, or null. */
export function parseCoordinates(text: string): { chrom: string; start: number; end: number } | null {
  const m = text.trim().replace(/,/g, '').match(/^([^:\s]+):(\d+)\s*[-–]\s*(\d+)$/);
  if (!m) return null;
  const start = Number(m[2]) - 1;
  const end = Number(m[3]);
  return end > start && start >= 0 ? { chrom: m[1], start, end } : null;
}

/** Hub hits on this genome's coordinates (a scan of another assembly keeps its source frame; a graph hit its nodes). */
export const placeableHits = (hits: HubSelected[]) => hits.filter(h => !h.frame || h.frame.kind === 'linear' || h.frame.kind === 'lifted');

export function resolveWindow(settings: NucPanelState, inputs: WindowInputs): WindowResolution {
  const source: NucWindowSource = settings.windowSource ?? 'view';
  const flank = Math.max(0, Math.round(settings.flank ?? DEFAULT_FLANK));
  const anchorSettings: NucAnchorSettings = settings.anchor ?? { kind: source === 'view' || source === 'coordinates' ? 'none' : 'feature', orientation: 'feature' };
  let chrom = '', start = 0, end = 0, label = '';
  let featureAnchor: number | null = null;
  let featureStrand: '+' | '-' | undefined;
  const hits = placeableHits(inputs.hubSelected);
  let used: HubSelected | null = null;
  const widen = (s: number, e: number, a: number) => [Math.max(0, Math.min(s, a - flank)), Math.max(e, a + flank)] as const;
  if (source === 'view') {
    if (!inputs.chrom || inputs.end <= inputs.start) return { error: 'No view' };
    ({ chrom, start, end } = inputs);
    label = `View ${loc(chrom, start, end)}`;
  } else if (source === 'peak') {
    const p = inputs.peaks[0];
    if (!p) return { error: 'Select a peak (click it above the reads)' };
    chrom = p.chrom ?? inputs.chrom;
    featureAnchor = Math.floor((p.start + p.end) / 2);
    [start, end] = widen(p.start, p.end, featureAnchor);
    label = `Peak ${loc(chrom, p.start, p.end)}${flank ? ` ± ${flank} bp` : ''}`;
  } else if (source === 'hub') {
    used = hits[0] ?? null;
    if (!used) return { error: inputs.hubSelected.length ? 'The selected hub hits are not on this genome\'s coordinates' : 'Select a hit in the Feature hub' };
    chrom = used.chrom;
    featureAnchor = used.anchor;
    featureStrand = used.strand;
    [start, end] = widen(used.start, used.end, used.anchor);
    label = `${used.label || used.typeId} ${loc(chrom, used.start, used.end)}${flank ? ` ± ${flank} bp` : ''}`;
  } else {
    const w: NucWindow | null | undefined = settings.window;
    if (!w) return { error: source === 'coordinates' ? 'Type coordinates (chr:start-end)' : 'Send a window here from another panel' };
    chrom = w.chrom;
    if (w.anchor != null) {
      featureAnchor = w.anchor;
      featureStrand = w.strand;
      [start, end] = source === 'handoff' ? widen(w.start, w.end, w.anchor) : [w.start, w.end];
    } else {
      [start, end] = [w.start, w.end];
    }
    label = source === 'handoff' && flank && w.anchor != null ? `${w.label} ± ${flank} bp` : w.label;
  }
  let anchor: ResolvedWindow['anchor'] = null;
  const orient = (strand?: '+' | '-') => (anchorSettings.orientation === 'feature' ? strandOf(strand) : anchorSettings.orientation);
  if (anchorSettings.kind === 'feature') {
    const pos = featureAnchor ?? Math.floor((start + end) / 2);
    anchor = { pos, orientation: orient(featureStrand) };
  } else if (anchorSettings.kind === 'centre') {
    anchor = { pos: Math.floor((start + end) / 2), orientation: orient(featureStrand) };
  } else if (anchorSettings.kind === 'position' && anchorSettings.pos != null && Number.isFinite(anchorSettings.pos)) {
    anchor = { pos: Math.round(anchorSettings.pos), orientation: orient(featureStrand) };
  }
  const background = anchor && settings.background === 'hub'
    ? hits.filter(h => h !== used).map(h => ({ chrom: h.chrom, pos: h.anchor, orientation: orient(h.strand) }))
    : [];
  return { window: { chrom, start, end }, label, anchor, background };
}
