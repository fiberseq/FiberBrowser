import { useBrowserStore } from '../stores/browserStore';
import type { RegionEntry } from '../types/regions';
import { genomeKeyFor, mainGenomeKey, panelGenomeKey } from './regionNavigation';
import { panelView, shownPanelViews } from './panelScope';

/**
 * Highlight actions for anyone to call (the toolbar's Highlight group, the
 * Regions panel, the read menu's "Highlight this read's region", the command
 * palette): each adds one undoable highlight shown in every panel on that
 * reference. They return the new highlights' ids ([] when there was nothing
 * to highlight).
 */

export interface HighlightRequest {
  chrom: string;
  start: number;
  end: number;
  /** The panel's own reference (PanelConfig.genome); omitted: the main genome. */
  genome?: string | null;
  label?: string;
  color?: string;
}

/** Highlight a region (0-based start, end exclusive). */
export function highlightRegion(request: HighlightRequest): string[] {
  const s = useBrowserStore.getState();
  return s.addHighlights([{ chrom: request.chrom, start: request.start, end: request.end, genome: genomeKeyFor(request.genome, s), ...(request.label ? { label: request.label } : {}), ...(request.color ? { color: request.color } : {}) }]);
}

/**
 * Highlight what the panels show (utils/panelScope): with `panelId`, that
 * panel's view; without, every view on screen (one highlight per reference and
 * locus: in "Each panel navigates" the main locus is stale), only the selected
 * panels' when panels are selected. One undo step.
 */
export function highlightView(panelId?: string): string[] {
  const s = useBrowserStore.getState();
  const panel = panelId ? s.panels.find(p => p.id === panelId && p.contentType === 'dataset') : undefined;
  const views = panel ? [panelView(s, panel)] : shownPanelViews(s);
  return s.addHighlights(views.map(v => ({ chrom: v.chrom, start: v.start, end: v.end, genome: v.genomeKey })));
}

/** Highlight the selected peaks (each its own highlight). */
export function highlightSelectedPeaks(): string[] {
  const s = useBrowserStore.getState();
  const seen = new Set<string>();
  const list: Array<{ chrom: string; start: number; end: number; genome: string }> = [];
  for (const peaks of Object.values(s.peaksByRule ?? {})) {
    for (const peak of peaks ?? []) {
      if (!s.selectedPeaks.has(peak.index)) continue;
      const chrom = peak.chrom ?? s.chrom;
      const key = `${peak.genome ?? ''}|${chrom}:${peak.start}-${peak.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ chrom, start: peak.start, end: peak.end, genome: genomeKeyFor(peak.genome, s) });
    }
  }
  return list.length ? s.addHighlights(list) : [];
}

/** Highlight saved regions (the Regions panel's selection), labelled as they are. */
export function highlightRegionEntries(genome: string, entries: RegionEntry[]): string[] {
  if (!entries.length) return [];
  return useBrowserStore.getState().addHighlights(entries.map(e => ({ chrom: e.chrom, start: e.start, end: e.end, genome, label: e.label })));
}

/** Highlight the span of a read (the read menu): `panelId` is the panel it was clicked in. */
export function highlightReadRegion(read: { chrom?: string; start: number; end: number; id?: string; name?: string }, panelId?: string): string[] {
  const s = useBrowserStore.getState();
  const panel = panelId ? s.panels.find(p => p.id === panelId) : undefined;
  const chrom = read.chrom ?? panel?.viewportOverride?.chrom ?? s.chrom;
  return s.addHighlights([{ chrom, start: read.start, end: read.end, genome: panel ? panelGenomeKey(panel, s) : mainGenomeKey(s), label: read.name ?? read.id }]);
}

/**
 * The palette and the menu bar reach these through the app command bus
 * (utils/appCommands: highlight-view, highlight-peaks, toggle-highlight-mode,
 * clear-highlights; next-region / previous-region for N / P).
 */
