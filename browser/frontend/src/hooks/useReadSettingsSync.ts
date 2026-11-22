import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { fetchApiResponse } from '../api/sharedFetch';
import { useBrowserStore } from '../stores/browserStore';

/** The workspace read settings the server confirmed it composes reads with: legacy-layer inference (``legacy``:
 *  JSON [enabled, nuc_min_size]) and the read-end footprint cutoff (``readEnd``: hide_short). ``revision`` counts the
 *  confirmations that changed the server's settings. Reads keyed on these settings (the graph panel) reload on the
 *  confirmed values and revision, not on the local edit: a load sent before the settings POST applied would answer
 *  with the old rows and be cached as current (same mechanism as useConfirmedQualityFilters). */
export const useConfirmedReadSettings = create<{ legacy: string | null; readEnd: boolean | null; revision: number }>(
  () => ({ legacy: null, readEnd: null, revision: 0 }));

/** Sync legacy-layer inference to the server; confirm the applied values (useConfirmedReadSettings). */
export function useLegacyLayerInferenceSync(enabled: boolean, nucMinSize: number, active: boolean): void {
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const key = JSON.stringify([enabled, nucMinSize]);
    sent.current = key;
    fetchApiResponse('/api/legacy_layer_inference', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, nuc_min_size: nucMinSize }),
    }).then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }).then((body: { changed?: boolean; enabled?: boolean; nuc_min_size?: number }) => {
      // An answer for a superseded edit: the later POST's answer confirms (and counts) the server's change.
      if (sent.current !== key) return;
      const legacy = typeof body?.enabled === 'boolean' && typeof body?.nuc_min_size === 'number'
        ? JSON.stringify([body.enabled, body.nuc_min_size]) : key;
      useConfirmedReadSettings.setState(s => {
        const changed = typeof body?.changed === 'boolean' ? body.changed : s.legacy !== legacy;
        return { legacy, revision: s.revision + (changed ? 1 : 0) };
      });
    }).catch(err => console.error('Failed to sync legacy layer inference settings:', err));
  }, [enabled, nucMinSize, active]);
}

/** Sync the read-end footprint setting to the server; confirm the applied value. Reads (whose URL carries
 *  appliedHideShortEndFootprints) are fetched again under the confirmed setting, analyses through the refresh
 *  generation, graph rows through useConfirmedReadSettings. */
export function useReadEndFootprintsSync(hideShort: boolean, active: boolean): void {
  const sent = useRef<boolean | null>(null);
  useEffect(() => {
    if (!active) return;
    sent.current = hideShort;
    fetchApiResponse('/api/read_end_footprints', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hide_short: hideShort }),
    }).then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }).then((body: { changed?: boolean; hide_short?: boolean }) => {
      const store = useBrowserStore.getState();
      const confirmed = typeof body?.hide_short === 'boolean' ? body.hide_short : null;
      if (confirmed !== null) store.setAppliedHideShortEndFootprints(confirmed);
      if (body?.changed) store.triggerRefresh();
      if (sent.current !== hideShort) return;
      const readEnd = confirmed ?? hideShort;
      useConfirmedReadSettings.setState(s => {
        const changed = typeof body?.changed === 'boolean' ? body.changed : s.readEnd !== readEnd;
        return { readEnd, revision: s.revision + (changed ? 1 : 0) };
      });
    }).catch(err => console.error('Failed to sync the read-end footprint setting:', err));
  }, [hideShort, active]);
}
