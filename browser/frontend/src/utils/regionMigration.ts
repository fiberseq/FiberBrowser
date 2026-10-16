import { useBrowserStore } from '../stores/browserStore';
import { addRegionsToCategory, saveRegionCatalogNow, useRegionCatalogStore } from '../stores/regionCatalogStore';
import { saveBookmarksToStorage } from '../stores/utils';
import { mainGenomeKey } from './regionNavigation';

/**
 * One list of saved regions (fb-r4-regions). Before 3.0 the app had three:
 * Export › Bookmarks (localStorage `fiberhmm_bookmarks`, also in sessions),
 * the Regions panel's "Saved regions" (Add View: navigatorRegions with source
 * 'navigator' or 'manual'), and now the region catalog. The first two become
 * catalog categories ("Bookmarks", "Saved views") on the main genome.
 *
 * The old lists are emptied only once the catalog holding them is saved to
 * the user's file (a failed save loses nothing: they are moved again next
 * time). Ids are kept, so moving them twice adds nothing. Contact-map and
 * haplotype regions stay where they are: those comparisons add and remove
 * them with their panels.
 */
let running: Promise<{ bookmarks: number; views: number }> | null = null;

export function migrateLegacyRegions(): Promise<{ bookmarks: number; views: number }> {
  if (!running) running = migrate().finally(() => { running = null; });
  return running;
}

async function migrate(): Promise<{ bookmarks: number; views: number }> {
  const none = { bookmarks: 0, views: 0 };
  const s = useBrowserStore.getState();
  // Before a reference is loaded they would be filed under 'none' (the BAM's own
  // contigs): they wait (still in the old lists) until a genome or FASTA is.
  if (!s.chroms.length || !(s.currentGenome || s.fastaPath)) return none;
  const userMade = (source: string) => source === 'navigator' || source === 'manual';
  const bookmarks = s.bookmarks;
  const views = s.navigatorRegions.filter(r => userMade(r.source));
  if (!bookmarks.length && !views.length) return none;
  const genome = mainGenomeKey(s);
  await useRegionCatalogStore.getState().ensureLoaded(genome);
  // Nowhere to keep them for next time (a public server, the file unreadable): leave them be.
  if (useRegionCatalogStore.getState().sync[genome] !== 'ready') return none;
  if (bookmarks.length) {
    addRegionsToCategory(genome, 'Bookmarks', bookmarks.map(b => ({
      id: `bm-${b.id}`, chrom: b.chrom, start: b.start, end: b.end, label: b.name, source: 'bookmark' as const, created: b.created,
    })), { source: 'bookmarks' });
  }
  if (views.length) {
    addRegionsToCategory(genome, 'Saved views', views.map(r => ({
      id: `nav-${r.id}`, chrom: r.chrom, start: r.start, end: r.end, label: r.label || 'View', source: 'navigator' as const,
    })), { source: 'saved' });
  }
  if (!(await saveRegionCatalogNow(genome))) return none;
  const moved = new Set(bookmarks.map(b => b.id));
  const movedViews = new Set(views.map(r => r.id));
  saveBookmarksToStorage(useBrowserStore.getState().bookmarks.filter(b => !moved.has(b.id)));
  useBrowserStore.setState(state => ({
    bookmarks: state.bookmarks.filter(b => !moved.has(b.id)),
    navigatorRegions: state.navigatorRegions.filter(r => !movedViews.has(r.id)),
  }));
  return { bookmarks: bookmarks.length, views: views.length };
}
