/**
 * Per-dataset settings of the FiberHMM variant layers on the read rows (off until turned on), kept in the browser
 * store through the extension point plugin packs use, so sessions, undo steps and crash recovery keep them.
 */
import { useBrowserStore } from '../../stores/browserStore';
import { registerStoreExtension } from '../../stores/storeExtensions';
import { DEFAULT_LAYER_SETTINGS, type FiberhmmLayerSettings } from './model';

export interface FiberhmmLayerState {
  fiberhmmLayerSettings: Record<string, FiberhmmLayerSettings>;
}

declare module '../../stores/browserStore' {
  interface BrowserState extends FiberhmmLayerState {}
}

export const SETTINGS_KEY = 'fiberhmmLayerSettings';

/** Saved settings, cleaned: unknown fields dropped, numbers clamped. */
export function restoreLayerSettings(saved?: Record<string, unknown>): FiberhmmLayerState {
  const raw = saved?.[SETTINGS_KEY];
  const out: Record<string, FiberhmmLayerSettings> = {};
  if (raw && typeof raw === 'object') {
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const v = value as Partial<FiberhmmLayerSettings>;
      out[id] = {
        sv: v.sv === true, var: v.var === true,
        minMapq: Math.max(0, Math.min(255, Math.round(Number(v.minMapq) || 0))),
        hideSupplementary: v.hideSupplementary === true, linkSplit: v.linkSplit !== false,
        // The server's lift is not part of a session: a restored dataset draws its layers as stored.
        lift: null,
      };
    }
  }
  return { fiberhmmLayerSettings: out };
}

let registered = false;

export function registerFiberhmmLayerState(): void {
  if (registered) return;
  registered = true;
  registerStoreExtension({
    id: 'features.fiberhmmLayers', keys: [SETTINGS_KEY],
    create: () => ({ fiberhmmLayerSettings: {} }),
    serialize: s => ({ [SETTINGS_KEY]: s.fiberhmmLayerSettings ?? {} }),
    restoreSnapshot: saved => ({ ...restoreLayerSettings(saved) }),
    importSession: frontend => ({ ...restoreLayerSettings(frontend) }),
  });
}

export function layerSettingsFor(state: Partial<FiberhmmLayerState>, datasetId: string | null | undefined): FiberhmmLayerSettings {
  return (datasetId && state.fiberhmmLayerSettings?.[datasetId]) || DEFAULT_LAYER_SETTINGS;
}

export function useLayerSettings(datasetId: string | null | undefined): FiberhmmLayerSettings {
  return useBrowserStore(s => layerSettingsFor(s, datasetId));
}

export function setLayerSettings(datasetId: string, patch: Partial<FiberhmmLayerSettings>): void {
  useBrowserStore.setState(s => ({
    fiberhmmLayerSettings: { ...(s.fiberhmmLayerSettings ?? {}), [datasetId]: { ...layerSettingsFor(s, datasetId), ...patch } },
  }));
}
