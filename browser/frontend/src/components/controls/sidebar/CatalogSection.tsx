import { useEffect, useState, useCallback } from 'react';
import { getCatalog, catalogLoad, catalogLoadFailure, catalogUnload, catalogTrackLoad, catalogTrackUnload, type Catalog, type CatalogGroup, type CatalogTrack } from '../../../api/catalog';
import { getDatasets } from '../../../api/datasets';
import { loadGenome } from '../../../api/reference';
import { getTracks } from '../../../api/tracks';
import { useBrowserStore } from '../../../stores/browserStore';
import { CatalogDatasetGroups } from './catalog/CatalogDatasetGroups';
import { CatalogReferenceTracks } from './catalog/CatalogReferenceTracks';
import { genomeLoadHasFasta } from '../../../utils/genomeAutoload';

/** The catalog's genome was applied (or deliberately skipped) this page load. */
let catalogGenomeInitialized = false;

export function CatalogSection() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [groups, setGroups] = useState<CatalogGroup[]>([]);
  const [tracks, setTracks] = useState<CatalogTrack[]>([]);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showTracks, setShowTracks] = useState(false);

  const refreshDatasets = useCallback(() => {
    getDatasets().then(res => {
      const store = useBrowserStore.getState();
      store.setDatasets(res.datasets);
      store.initModTypeDefaults();
      store.toggleModType('footprint' as any, true);
      store.toggleModType('nuc' as any, true);
      if (res.datasets.some((d: any) => d.available_layers?.tf)) {
        store.toggleModType('tf' as any, true);
      }
    }).catch(() => {});
  }, []);

  const refreshTracks = useCallback(() => {
    getTracks().then(res => {
      if (res.tracks) useBrowserStore.getState().setOrthogonalTracks(res.tracks as any);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    getCatalog().then(res => {
      if (res.catalog) {
        setCatalog(res.catalog);
        setGroups(res.catalog.groups);
        setTracks(res.catalog.tracks || []);
        const store = useBrowserStore.getState();
        const catalogGenome = res.catalog.genome;
        // The catalog's reference is a startup default: set once per page, and
        // only when no reference is loaded. Reopening this section (a remount)
        // must not replace a genome or FASTA the user chose since.
        const firstMount = !catalogGenomeInitialized;
        catalogGenomeInitialized = true;
        if (catalogGenome && firstMount && !store.hasFasta && !store.currentGenome) {
          loadGenome(catalogGenome).then(loadRes => {
            if (loadRes.success) {
              const s = useBrowserStore.getState();
              s.setHasFasta(genomeLoadHasFasta(loadRes));
              s.setCurrentGenome(catalogGenome);
              s.triggerRefresh();
            }
          }).catch(() => {});
        }
      }
    }).catch(() => {});
  }, []);

  const handleGroupToggle = useCallback(async (index: number, currentlyLoaded: boolean) => {
    setLoading(prev => ({ ...prev, [`g${index}`]: true }));
    try {
      if (currentlyLoaded) {
        const res = await catalogUnload(index);
        if (res.success) {
          setGroups(prev => prev.map((g, i) => i === index ? { ...g, loaded: false } : g));
          refreshDatasets();
          useBrowserStore.getState().triggerRefresh();
        }
      } else {
        const res = await catalogLoad(index);
        if (res.success) {
          setGroups(prev => prev.map((g, i) => i === index ? { ...g, loaded: true } : g));
          refreshDatasets();
          useBrowserStore.getState().triggerRefresh();
        }
        // A file that could not be opened (missing object or index, refused
        // access) is named; it used to fail without a word.
        const failure = catalogLoadFailure(res);
        if (failure) useBrowserStore.getState().setError(failure);
      }
    } catch (err) {
      useBrowserStore.getState().setError(err instanceof Error ? err.message : 'Could not load the catalog group');
    }
    setLoading(prev => ({ ...prev, [`g${index}`]: false }));
  }, [refreshDatasets]);

  const handleTrackToggle = useCallback(async (index: number, currentlyLoaded: boolean) => {
    setLoading(prev => ({ ...prev, [`t${index}`]: true }));
    try {
      if (currentlyLoaded) {
        await catalogTrackUnload(index);
        setTracks(prev => prev.map((t, i) => i === index ? { ...t, loaded: false } : t));
      } else {
        await catalogTrackLoad(index);
        setTracks(prev => prev.map((t, i) => i === index ? { ...t, loaded: true } : t));
      }
      refreshTracks();
      useBrowserStore.getState().triggerRefresh();
    } catch {}
    setLoading(prev => ({ ...prev, [`t${index}`]: false }));
  }, [refreshTracks]);

  if (!catalog) return null;

  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium text-gray-500 dark:text-gray-400 px-1">
        {catalog.name}
      </div>

      <CatalogDatasetGroups
        groups={groups}
        loading={loading}
        expandedIndex={expanded}
        onExpandedChange={setExpanded}
        onGroupToggle={handleGroupToggle}
      />

      <CatalogReferenceTracks
        tracks={tracks}
        loading={loading}
        open={showTracks}
        onOpenChange={setShowTracks}
        onTrackToggle={handleTrackToggle}
      />
    </div>
  );
}
