/**
 * A search's hits as a temporary annotation track: the server holds the intervals (an in-memory BED track,
 * POST /api/sequence_search/jobs/{id}/track); here it is registered in the catalog and shown as a one-source
 * track like any BED annotation (utils/trackLoader). Sessions do not save it (the server leaves it out of the
 * session; a restored catalog entry for it shows as unavailable).
 */
import { useBrowserStore } from '../../stores/browserStore';
import { ensureCompositeFor } from '../../utils/trackLoader';

export function registerBackendBedTrack(opts: { trackIndex: number; path: string; label: string }): string {
  const store = useBrowserStore.getState();
  const catalogEntryId = store.addCatalogEntry({
    source: 'local',
    kind: 'bigbed',
    label: opts.label,
    path: opts.path,
    loaded: true,
    trackIndex: opts.trackIndex,
    meta: { format: 'sequence-search' },
  });
  const compositeId = ensureCompositeFor(catalogEntryId, { label: opts.label, source: 'local', kind: 'bigbed' });
  store.triggerRefresh();
  return compositeId;
}
