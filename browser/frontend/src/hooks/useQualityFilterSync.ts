import { useEffect, useRef } from 'react';
import { fetchApiResponse } from '../api/sharedFetch';
import { useBrowserStore } from '../stores/browserStore';
import type { LayerQualityFilter } from '../types';

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
      if (synced.current === key && body.changed !== false) useBrowserStore.getState().triggerRefresh();
    }).catch(error => console.error('Failed to sync quality filters:', error))
      .finally(() => initial.current?.resolve());
  }, [enabled, key]);
  return initial.current.promise;
}
