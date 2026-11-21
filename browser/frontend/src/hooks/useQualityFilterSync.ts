import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { fetchApiResponse } from '../api/sharedFetch';
import { useBrowserStore } from '../stores/browserStore';
import type { LayerQualityFilter } from '../types';

/** The quality filters the server confirmed it applies (``key``: the synced settings; ``revision``: counts the
 *  confirmations that changed the server's settings). Reads keyed on the settings (the graph panel) reload on the
 *  revision, not on the local edit: a load sent before the settings POST applied would answer with the old rows and
 *  never be asked again. (A revision, not the key: A → B → A changes the server twice with the same final key.) */
export const useConfirmedQualityFilters = create<{ key: string | null; revision: number }>(() => ({ key: null, revision: 0 }));

/** Keep read construction in sync without invalidating it for identical settings. */
export function useQualityFilterSync(filters: LayerQualityFilter[], enabled: boolean): Promise<void> {
  const synced = useRef<string | null>(null);
  const initial = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);
  if (!initial.current) {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    initial.current = { promise, resolve };
  }
  const key = JSON.stringify(filters.filter(f => f.enabled && f.minValue > 0)
    .map(f => ({ layer: f.layer, quality_name: f.qualityName, min_value: f.minValue })));
  useEffect(() => {
    if (!enabled) { initial.current?.resolve(); return; }
    if (synced.current === key) return;
    synced.current = key;
    fetchApiResponse('/api/quality_filters', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filters: JSON.parse(key) }),
    }).then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }).then(body => {
      // This also covers the first sync: child tracks may have started their
      // reads before the parent's effect invalidated the cache generation.
      if (synced.current !== key) return;
      const changed = body.changed !== false;
      useConfirmedQualityFilters.setState(s => ({ key, revision: s.revision + (changed ? 1 : 0) }));
      if (changed) useBrowserStore.getState().triggerRefresh();
    }).catch(error => console.error('Failed to sync quality filters:', error))
      .finally(() => initial.current?.resolve());
  }, [enabled, key]);
  return initial.current.promise;
}
