import type { PanelConfig } from '../types';
import { sameChrom } from './chromAliases';

export interface Region { chrom: string; start: number; end: number }

/** The region a panel draws: its own view, or the main view. */
export function panelRegion(panel: PanelConfig, main: Region): Region {
  return panel.viewportOverride ?? main;
}

function sameRegion(a: Region, b: Region): boolean {
  return sameChrom(a.chrom, b.chrom) && a.start === b.start && a.end === b.end;
}

function showsAxis(panel: PanelConfig): boolean {
  return panel.contentType === 'dataset' && panel.subTracks.some(t => t.type === 'axis' && t.visible);
}

/**
 * Whether a dataset panel's coordinate ruler would only repeat the one just
 * above it. Panels stacked in one column share its width, so a panel showing
 * the same region and orientation as the dataset panel directly above it has the same
 * coordinates at the same x: its ruler is dropped and the column keeps one at
 * the top. A panel at another region (haplotype or region views, Locus X/Y,
 * an unlinked copy) keeps its own, as does the top panel of every column
 * (columns side by side have their own widths).
 *
 * `column` is the column's panels top to bottom, as laid out.
 */
export function rulerRepeatsAbove(
  column: PanelConfig[],
  index: number,
  main: Region | ((panel: PanelConfig) => Region),
  reversed: (panel: PanelConfig) => boolean = panel => panel.reversed ?? false,
): boolean {
  const panel = column[index];
  const above = index > 0 ? column[index - 1] : undefined;
  if (!panel || !above || panel.contentType !== 'dataset' || !showsAxis(above)) return false;
  const regionOf = typeof main === 'function' ? main : (p: PanelConfig) => panelRegion(p, main);
  return reversed(panel) === reversed(above) && sameRegion(regionOf(panel), regionOf(above));
}

/**
 * Ids of the panels with their own view that sit exactly on the main view,
 * joined into a string: a store selector that changes only when that set
 * does, not on every pan of the main view.
 */
export function panelsAtMainKey(panels: PanelConfig[], main: Region): string {
  return panels
    .filter(p => p.viewportOverride && sameRegion(p.viewportOverride, main))
    .map(p => p.id)
    .join('\n');
}

const MAIN: Region = { chrom: '\0main', start: 0, end: 0 };

/** Region resolver for rulerRepeatsAbove from panelsAtMainKey's result. */
export function regionResolver(atMainKey: string): (panel: PanelConfig) => Region {
  const atMain = new Set(atMainKey ? atMainKey.split('\n') : []);
  return panel => (panel.viewportOverride && !atMain.has(panel.id) ? panel.viewportOverride : MAIN);
}
