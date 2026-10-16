import { useEffect } from 'react';
import { useBrowserStore } from '../stores/browserStore';
import { recentTracksOffered, rememberRecentTrack } from '../api/recentTracks';
import type { CatalogEntry } from '../types/dataset';

/** Pasted matrices and file motifs can't be re-created from their path. */
function isRestorable(entry: CatalogEntry): boolean {
  const where = entry.path ?? entry.url ?? '';
  if (!where) return false;
  if (where.startsWith('motif://')) return where.startsWith('motif://jaspar/') || where.startsWith('motif://sequence/');
  return true;
}

function keyOf(entry: CatalogEntry): string {
  return `${entry.source}|${entry.path ?? entry.url ?? ''}|${[...(entry.filterNames ?? [])].sort().join(',')}`;
}

/**
 * Remember every track source that loads, on the server, so it is offered
 * under "Recent" in later sessions (and other browsers) without finding the
 * file again. Only the location and label are stored.
 */
export function useRecentTracksSync() {
  useEffect(() => {
    if (typeof window === 'undefined' || window.__FIBERBROWSER_RENDER_MODE) return;
    const sent = new Set<string>();
    const sync = (catalog: CatalogEntry[]) => {
      if (!recentTracksOffered(useBrowserStore.getState().publicMode)) return;
      for (const entry of catalog) {
        if (!entry.loaded || entry.unavailable || !isRestorable(entry)) continue;
        const key = keyOf(entry);
        if (sent.has(key)) continue;
        sent.add(key);
        void rememberRecentTrack({
          source: entry.source,
          kind: entry.kind,
          label: entry.label,
          path: entry.path,
          url: entry.url,
          catalogId: entry.catalogId,
          filterNames: entry.filterNames,
          meta: entry.meta,
        }).catch(() => sent.delete(key));
      }
    };
    sync(useBrowserStore.getState().catalog);
    return useBrowserStore.subscribe((state, prev) => {
      if (state.catalog !== prev.catalog) sync(state.catalog);
    });
  }, []);
}
