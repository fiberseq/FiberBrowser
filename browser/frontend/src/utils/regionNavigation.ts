import { useBrowserStore } from '../stores/browserStore';
import { categoryShown, useRegionCatalogStore } from '../stores/regionCatalogStore';
import type { PanelConfig } from '../types';
import type { RegionCatalog, RegionEntry } from '../types/regions';
import { findChromInfo } from './chromAliases';
import { isPlasmidChrom } from './plasmidLoader';
import { entriesOf, orderedCategories } from './regionCatalog';
import { supersedeNavigationIntents } from './search/navigationIntent';
import { activePanelId, mainGenomeKey, visibleDatasetPanels } from './panelScope';

export { mainGenomeKey };

/**
 * Going to saved regions (fb-r4-regions).
 *
 * Regions are coordinates on a reference: the main genome (its registry id,
 * else its FASTA's file name) or a panel's own reference (PanelConfig.genome).
 * A region opens where that reference is shown: the panel the user is working
 * in (utils/panelScope's active panel, as search and the cluster charts use)
 * when it is on that reference, else a selected panel on it, else the main
 * view (Linked navigation), else the first panel on that reference with its
 * own locus (Per panel, or a dataset on another assembly). Only panels on
 * screen count (not minimized, not in a collapsed row).
 */

type Store = ReturnType<typeof useBrowserStore.getState>;

/** A panel's reference: its own (another assembly), else the main genome's. */
export function panelGenomeKey(panel: Pick<PanelConfig, 'genome'> | null | undefined, s: Pick<Store, 'currentGenome' | 'fastaPath'>): string {
  return panel?.genome || mainGenomeKey(s);
}

/** A panel box's reference key (`genome`: a panel's own reference, null/undefined: the main genome). */
export function genomeKeyFor(genome: string | null | undefined, s: Pick<Store, 'currentGenome' | 'fastaPath'> = useBrowserStore.getState()): string {
  return genome || mainGenomeKey(s);
}

/** The dataset panels on screen (utils/panelScope: not minimized, not in a collapsed row; only a maximized one). */
const datasetPanels = (s: Store) => visibleDatasetPanels(s);

/** The panel the user is working in (utils/panelScope.activePanelId), when it is on screen. */
const activePanel = (s: Store): PanelConfig | undefined => {
  const id = activePanelId(s);
  return id ? datasetPanels(s).find(p => p.id === id) : undefined;
};

/** The reference the region tools act on: the active panel's (as search and the cluster charts), else the main genome. */
export function targetGenome(s: Store = useBrowserStore.getState()): string {
  const active = activePanel(s);
  return active ? panelGenomeKey(active, s) : mainGenomeKey(s);
}

/**
 * The reference N / P and the Regions panel's ‹ › step through (one context
 * for both): the catalog the Regions panel shows while it is open; else the
 * reference last stepped or gone to, while a panel still shows it; else the
 * targeted panel's (targetGenome).
 */
export function stepGenome(s: Store = useBrowserStore.getState()): string {
  const regions = useRegionCatalogStore.getState();
  const shown = shownGenomes(s);
  if (regions.shown && shown.includes(regions.shown)) return regions.shown;
  if (regions.active && shown.includes(regions.active.genome)) return regions.active.genome;
  return targetGenome(s);
}

/** Every reference shown now (main first). */
export function shownGenomes(s: Store = useBrowserStore.getState()): string[] {
  const keys = [mainGenomeKey(s)];
  for (const p of datasetPanels(s)) {
    const key = panelGenomeKey(p, s);
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

export type RegionTarget = { kind: 'main' } | { kind: 'panel'; panelId: string };

/** Where a region of `genome` opens (null: no panel shows that reference). */
export function regionTarget(genome: string, s: Store = useBrowserStore.getState(), panelId?: string): RegionTarget | null {
  const panels = datasetPanels(s);
  const onGenome = (p: PanelConfig) => panelGenomeKey(p, s) === genome;
  const asTarget = (p: PanelConfig): RegionTarget => (p.viewportOverride ? { kind: 'panel', panelId: p.id } : { kind: 'main' });
  const explicit = panelId ? panels.find(p => p.id === panelId && onGenome(p)) : undefined;
  if (explicit) return asTarget(explicit);
  const active = activePanel(s);
  if (active && onGenome(active)) return asTarget(active);
  const selected = panels.find(p => s.selectedDatasets.has(p.id) && onGenome(p));
  if (selected) return asTarget(selected);
  if (mainGenomeKey(s) === genome && (s.navigationMode !== 'perPanel' || !panels.some(p => p.viewportOverride && onGenome(p)))) {
    return { kind: 'main' };
  }
  const own = panels.find(p => onGenome(p) && p.viewportOverride);
  if (own) return { kind: 'panel', panelId: own.id };
  return mainGenomeKey(s) === genome ? { kind: 'main' } : null;
}

/**
 * The view the region tools act on for a reference: the active panel's when it
 * is on it, else a selected panel's on it, else the first panel's on it with a
 * locus of its own, else the main view when it is the main genome; null when
 * nothing on screen shows that reference.
 */
export function viewOnGenome(genome: string, s: Store = useBrowserStore.getState(), datasetId?: string): { chrom: string; start: number; end: number; panelGenome: string | null } | null {
  const main = { chrom: s.chrom, start: s.start, end: s.end, panelGenome: null };
  const panels = datasetPanels(s).filter(p => panelGenomeKey(p, s) === genome && (!datasetId || p.datasetId === datasetId));
  const at = (p: PanelConfig) => (p.viewportOverride ? { ...p.viewportOverride, panelGenome: p.genome ?? null } : main);
  const active = activePanel(s);
  if (active && panels.includes(active)) return at(active);
  const selected = panels.find(p => s.selectedDatasets.has(p.id));
  if (selected) return at(selected);
  if (mainGenomeKey(s) === genome && (s.navigationMode !== 'perPanel' || !panels.some(p => p.viewportOverride))) {
    if (!datasetId || panels.some(p => !p.viewportOverride)) return main;
  }
  const own = panels.find(p => p.viewportOverride);
  if (own) return at(own);
  return mainGenomeKey(s) === genome ? main : null;
}

/**
 * How the Regions catalog names its reference. Plasmid maps load as extra
 * contigs of the main genome, so their regions are kept in its catalog: when
 * a plasmid is shown (the targeted view first, then the main view and the
 * panels on that genome) the catalog names it too ("N1 and hg38"; the plasmid
 * alone when no genome is loaded) instead of only the genome.
 */
export function catalogReferenceLabel(genome: string, s: Store = useBrowserStore.getState()): string {
  const base = genome === 'none' ? null : genome;
  if (genome === mainGenomeKey(s)) {
    const shown = [viewOnGenome(genome, s)?.chrom, s.chrom,
      ...datasetPanels(s).filter(p => panelGenomeKey(p, s) === genome).map(p => p.viewportOverride?.chrom)];
    const plasmids: string[] = [];
    for (const chrom of shown) {
      const contig = chrom ? findChromInfo(s.chroms, chrom) : undefined;
      if (contig && isPlasmidChrom(contig) && !plasmids.includes(contig.name)) plasmids.push(contig.name);
    }
    if (plasmids.length) return base ? `${plasmids.join(', ')} and ${base}` : plasmids.join(', ');
  }
  return base ?? 'this reference';
}

/** The window shown for a region: found regions get a margin; saved ones are shown as saved. */
export function regionWindow(entry: Pick<RegionEntry, 'start' | 'end' | 'source'>): { start: number; end: number } {
  if (entry.source === 'auto' || entry.source === 'top') {
    const pad = Math.max(20, Math.round((entry.end - entry.start) * 0.05));
    return { start: Math.max(0, entry.start - pad), end: entry.end + pad };
  }
  return { start: entry.start, end: Math.max(entry.end, entry.start + 3) };
}

export interface GoToRegionOptions {
  /** A panel box's own navigation (its locus box): go there instead. */
  navigate?: (chrom: string, start: number, end: number) => void;
  panelId?: string;
}

/**
 * Which panel a Go to a region of `genome` moves, when that is not obvious:
 * several panels on that reference navigate on their own (Per panel) and none
 * of them is selected. null otherwise.
 */
export function regionGoNote(genome: string, s: Store = useBrowserStore.getState()): string | null {
  const target = regionTarget(genome, s);
  if (target?.kind !== 'panel') return null;
  if (s.selectedDatasets.has(target.panelId)) return null;
  const others = datasetPanels(s).filter(p => p.id !== target.panelId && p.viewportOverride && panelGenomeKey(p, s) === genome);
  if (!others.length) return null;
  const panel = s.panels.find(p => p.id === target.panelId);
  const name = s.datasets.find(d => d.id === panel?.datasetId)?.label || panel?.datasetId || 'the first panel';
  return `Shown in ${name}. To show it in another ${genome} panel, select that panel first.`;
}

/** Show a region; returns why it can't be shown, or null. */
export function goToRegion(genome: string, entry: RegionEntry, options: GoToRegionOptions = {}): string | null {
  const s = useBrowserStore.getState();
  const { start, end } = regionWindow(entry);
  const regions = useRegionCatalogStore.getState();
  regions.setActive(genome, entry.category, entry.id);
  regions.noteVisited(entry.id);
  if (options.navigate) {
    options.navigate(entry.chrom, start, end);
    return null;
  }
  const target = regionTarget(genome, s, options.panelId);
  if (!target) return `No panel shows ${genome}: open a dataset on it first.`;
  // A Go to (from search, the Regions panel or N / P), even to where that view
  // already is: answers still pending for it are stale (search/navigationIntent).
  supersedeNavigationIntents(target.kind === 'panel' ? { panelId: target.panelId } : 'main');
  if (target.kind === 'panel') {
    s.navigatePanel(target.panelId, entry.chrom, start, end);
  } else {
    if (s.chroms.length && !findChromInfo(s.chroms, entry.chrom)) return `${entry.chrom} is not on the loaded genome.`;
    s.setViewport(findChromInfo(s.chroms, entry.chrom)?.name ?? entry.chrom, start, end);
  }
  return null;
}

/** The regions next/previous steps through: the active category's (with its subheadings), shown ones only. */
/**
 * A category's regions with its subheadings', leaving out a subheading that
 * is hidden (a closed dataset's amplicons moved under a user category): what
 * the Regions panel shows, and so what search, N / P and the step label use.
 */
export function shownEntriesOf(catalog: RegionCatalog, categoryId: string, fingerprints: Record<string, string>): RegionEntry[] {
  const category = catalog.categories.find(c => c.id === categoryId);
  if (category && !categoryShown(category, fingerprints)) return [];
  const ids = new Set([categoryId]);
  for (const c of catalog.categories) if (c.parent === categoryId && categoryShown(c, fingerprints)) ids.add(c.id);
  return entriesOf(catalog, categoryId, true).filter(e => ids.has(e.category));
}

export function stepList(catalog: RegionCatalog, categoryId: string, fingerprints: Record<string, string> = useRegionCatalogStore.getState().fingerprints): RegionEntry[] {
  return shownEntriesOf(catalog, categoryId, fingerprints);
}

/** The category to step through on this reference: the active one, else the first shown one with regions. */
export function stepCategory(genome: string): string | null {
  const regions = useRegionCatalogStore.getState();
  const catalog = regions.catalogFor(genome);
  const shown = orderedCategories(catalog).filter(({ category }) => {
    if (!categoryShown(category, regions.fingerprints)) return false;
    const parent = category.parent ? catalog.categories.find(c => c.id === category.parent) : undefined;
    return !parent || categoryShown(parent, regions.fingerprints);
  });
  if (regions.active?.genome === genome && shown.some(x => x.category.id === regions.active!.category)) return regions.active.category;
  return shown.find(x => shownEntriesOf(catalog, x.category.id, regions.fingerprints).length > 0)?.category.id ?? null;
}

/** Go to the next (+1) or previous (-1) region of the current category; returns a message for the user. */
export function stepRegion(delta: 1 | -1, genome: string = stepGenome()): string | null {
  const regions = useRegionCatalogStore.getState();
  const categoryId = stepCategory(genome);
  if (!categoryId) return 'No saved regions on this reference.';
  const list = stepList(regions.catalogFor(genome), categoryId, regions.fingerprints);
  if (!list.length) return 'This category has no regions.';
  const current = regions.active?.genome === genome && regions.active.category === categoryId ? regions.active.entry : null;
  const at = current ? list.findIndex(e => e.id === current) : -1;
  const next = at < 0 ? (delta > 0 ? 0 : list.length - 1) : (at + delta + list.length) % list.length;
  const entry = list[next];
  const problem = goToRegion(genome, entry);
  // Stepping keeps the category even when the region sits in a subheading.
  regions.setActive(genome, categoryId, entry.id);
  return problem;
}
