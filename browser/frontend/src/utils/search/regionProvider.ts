import { categoryShown, useRegionCatalogStore } from '../../stores/regionCatalogStore';
import type { RegionCatalog, RegionEntry } from '../../types/regions';
import { genomeKeyFor, goToRegion, shownEntriesOf } from '../regionNavigation';
import { orderedCategories } from '../regionCatalog';
import { SEARCH_SCORE, type SearchContext, type SearchProvider, type SearchSuggestion } from './providers';
import { textMatchScore as matchScore } from './textMatch';
import { contextReference } from './navigationIntent';

/**
 * Saved regions in the locus boxes and the command palette: type part of a
 * region's label, its category's name, or its nearest gene, and the region is
 * offered. Only regions on the box's own reference; recently visited ones
 * first among equals. Categories are offered too (going to their first region).
 *
 * Scores (SEARCH_SCORE's scale): a region named exactly so 700 (+ up to 11 for
 * a recent visit / the box's chromosome), so it is a strong hit but always
 * below the gene named exactly so (900); a prefix, word or fuzzy match lower
 * (4 × the text match: at most ~400).
 */

/** The text match (0–100, + small bonuses) on the shared scale. */
export function regionScore(raw: number): number {
  return raw >= 100 ? SEARCH_SCORE.regionExact + Math.min(raw - 100, 50) : raw * 4;
}

const MAX_REGIONS = 8;
const MAX_CATEGORIES = 3;

function locusText(e: Pick<RegionEntry, 'chrom' | 'start' | 'end'>): string {
  return `${e.chrom}:${e.start.toLocaleString()}-${e.end.toLocaleString()}`;
}

/** Ranked region and category suggestions for one reference's catalog. */
export function searchRegionCatalog(
  catalog: RegionCatalog,
  query: string,
  options: { fingerprints?: Record<string, string>; recent?: string[]; ctx?: Partial<SearchContext> } = {},
): SearchSuggestion[] {
  const { fingerprints = {}, recent = [], ctx = {} } = options;
  const boxChrom = ctx.viewport?.chrom;
  const genome = catalog.genome;
  // Coordinates on the searching box's reference, exactly (not just the catalog's file-name key): refused on another.
  const reference = options.ctx ? contextReference(ctx) : undefined;
  const shownCats = orderedCategories(catalog).filter(({ category }) => {
    if (!categoryShown(category, fingerprints)) return false;
    const parent = category.parent ? catalog.categories.find(c => c.id === category.parent) : undefined;
    return !parent || categoryShown(parent, fingerprints);
  });
  const catName = new Map(shownCats.map(({ category, path }) => [category.id, path]));
  const recentRank = new Map(recent.map((id, i) => [id, i]));
  const scored: Array<{ entry: RegionEntry; score: number }> = [];
  for (const entry of catalog.entries) {
    const path = catName.get(entry.category);
    if (path === undefined) continue;
    let score = matchScore(entry.label, query);
    if (entry.gene) score = Math.max(score, matchScore(entry.gene, query) - 5);
    if (entry.autoLabel && entry.autoLabel !== entry.label) score = Math.max(score, matchScore(entry.autoLabel, query) - 10);
    if (score < 40) score = Math.max(score, Math.round(matchScore(path, query) * 0.6));
    if (score <= 0) continue;
    const r = recentRank.get(entry.id);
    if (r !== undefined) score += Math.max(1, 10 - r);
    if (boxChrom && entry.chrom === boxChrom) score += 1;
    scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const out: SearchSuggestion[] = scored.slice(0, MAX_REGIONS).map(({ entry, score }) => ({
    id: `region:${genome}:${entry.id}`,
    kind: 'region',
    label: entry.label,
    detail: `${catName.get(entry.category)} · ${locusText(entry)}${entry.reads != null ? ` · ${entry.reads.toLocaleString()} reads` : ''}`,
    score: regionScore(score),
    reference,
    run: (runCtx: SearchContext) => goToRegion(genome, entry, { navigate: runCtx.navigate }),
  }));
  const cats = shownCats
    .map(({ category, path }) => ({ category, path, score: matchScore(category.name, query) }))
    .filter(c => c.score >= 40)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CATEGORIES);
  for (const { category, path, score } of cats) {
    const list = shownEntriesOf(catalog, category.id, fingerprints);
    if (!list.length) continue;
    out.push({
      id: `category:${genome}:${category.id}`,
      kind: 'category',
      label: path,
      detail: `${list.length} region${list.length === 1 ? '' : 's'} · go to the first; N / P step through`,
      score: regionScore(score - 15),
      reference,
      run: (runCtx: SearchContext) => {
        const problem = goToRegion(genome, list[0], { navigate: runCtx.navigate });
        useRegionCatalogStore.getState().setActive(genome, category.id, list[0].id);
        return problem;
      },
    });
  }
  return out;
}

export const regionSearchProvider: SearchProvider = {
  id: 'regions',
  kind: 'region',
  label: 'Regions',
  order: 30,
  search: (query, ctx) => {
    const regions = useRegionCatalogStore.getState();
    const genome = genomeKeyFor(ctx.genome);
    return searchRegionCatalog(regions.catalogFor(genome), query, { fingerprints: regions.fingerprints, recent: regions.recent, ctx });
  },
  // A rename, an import or a dataset's amplicons: the open lists ask again.
  subscribe: onChange => useRegionCatalogStore.subscribe((s, prev) => {
    if (s.catalogs !== prev.catalogs || s.fingerprints !== prev.fingerprints) onChange();
  }),
};
