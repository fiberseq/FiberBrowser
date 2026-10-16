import type { PanelConfig } from '../types';
import { formatCoordinates } from './coordinates';

/**
 * The regions an exported figure shows: the main view's, and each panel's own
 * locus (another locus, or another assembly). A figure of panels on two
 * assemblies names each reference, since their chromosome names can be the
 * same (fb-r2-integ).
 */
interface FigureState {
  panels: PanelConfig[];
  chrom: string;
  start: number;
  end: number;
  fullViewPanelId?: string | null;
  collapsedRows?: Set<number>;
}

/**
 * Distinct regions of the dataset panels in the figure (left to right; a
 * maximized panel alone; minimized ones left out). `referenceLabel(key)`: a
 * reference's short name (`null`: the main genome). Labels are added only when
 * the figure shows more than one reference.
 */
export function figureRegions(st: FigureState, referenceLabel: (key: string | null) => string | null): string[] {
  const datasetPanels = st.panels.filter(p => p.contentType === 'dataset' && p.datasetId);
  const maximized = st.fullViewPanelId ? datasetPanels.filter(p => p.id === st.fullViewPanelId) : [];
  // On screen: the maximized panel alone, else those not minimized nor in a folded row.
  const shown = maximized.length ? maximized
    : datasetPanels.filter(p => !p.collapsed && !st.collapsedRows?.has(p.layoutRow ?? 0));
  const regions: Array<{ key: string | null; chrom: string; start: number; end: number }> = [];
  const seen = new Set<string>();
  const add = (key: string | null, chrom: string, start: number, end: number) => {
    const id = `${key ?? ''}|${chrom}:${start}-${end}`;
    if (seen.has(id)) return;
    seen.add(id);
    regions.push({ key, chrom, start, end });
  };
  for (const p of shown) {
    const v = p.viewportOverride;
    if (v) add(p.genome ?? null, v.chrom, v.start, v.end);
    else add(null, st.chrom, st.start, st.end);
  }
  if (regions.length === 0) add(null, st.chrom, st.start, st.end);
  const references = new Set(regions.map(r => r.key));
  const labelled = references.size > 1;
  return regions.map(r => {
    const where = formatCoordinates(r.chrom, r.start, r.end);
    const name = labelled ? (referenceLabel(r.key) ?? (r.key === null ? 'main genome' : r.key)) : null;
    return name ? `${name} ${where}` : where;
  });
}

/** The figure's default title: its region, or its regions (a count when there are many). */
export function figureTitleText(regions: string[]): string {
  if (regions.length <= 1) return regions[0] ?? '';
  return regions.length <= 3 ? regions.join('  |  ') : `${regions.length} regions`;
}

/** The figure's footer: every region it shows. */
export function figureFooterText(regions: string[]): string {
  return regions.join('  ·  ');
}

/** What a panel's location bar says in a figure: its reference (another assembly), its name, its locus. */
export function panelFigureLocus(parts: { reference?: string | null; name?: string | null; chrom: string; start: number; end: number }): string {
  return [parts.reference, parts.name, formatCoordinates(parts.chrom, parts.start, parts.end)].filter(Boolean).join(' · ');
}

/** The main genome's short name: its registry id, else its FASTA's file name. */
export function mainReferenceLabel(st: { currentGenome?: string | null; fastaPath?: string | null }): string | null {
  if (st.currentGenome) return st.currentGenome;
  const base = st.fastaPath?.split(/[\\/]/).pop()?.split('?')[0];
  return base ? base.replace(/\.(fa|fasta|fna)(\.gz)?$/i, '') : null;
}
