import { create } from 'zustand';
import { fetchJson } from '../api/sharedFetch';
import { setReadRegionBudget } from '../api/loadedReadRegion';
import { setReadExpansionBudget } from '../api/readBinary';
import { setReadPrefetchMargin } from '../api/readOperations';
import { applyBrowserPerformanceMode, inferBrowserPerformanceProfile, type BrowserPerformanceTier, type PerformanceMode } from '../utils/performanceProfile';
import { setCanvasRenderScale } from '../utils/canvasUtils';
import { useBrowserStore } from './browserStore';
import { isSandboxPage } from '../utils/sandbox';
import { isPublicServerPage } from '../utils/publicServerFlag';

export interface PerformanceInfo {
  mode: PerformanceMode;
  effective: BrowserPerformanceTier;
  hardware: { total_memory_bytes: number; cores: number };
  client_cohort_bytes: number;
  client_expansion_bytes: number;
  margin_fraction: number;
  max_working_reads: number;
  sample_target: number;
  workers: number;
  numeric_threads: number;
  decode_workers: number;
  prefetch_multiplier: number;
  caches: Record<string, { budget_bytes: number; retained_bytes: number; entries: number }>;
  shared_caches?: Array<{ group: string; budget_bytes: number; retained_bytes: number; entries: number }>;
}

/** Machine preferences are independent of sessions and undo snapshots. */
export function applyPerformanceInfo(info: PerformanceInfo, refresh = true): void {
  const profile = applyBrowserPerformanceMode(info.mode, info.effective);
  setReadPrefetchMargin(info.margin_fraction, info.prefetch_multiplier);
  setReadRegionBudget(info.client_cohort_bytes);
  setReadExpansionBudget(info.client_expansion_bytes);
  setCanvasRenderScale(profile.interactiveCanvasScale);
  useBrowserStore.setState(s => ({
    allReadsDisplayCap: profile.defaultAllReadsDisplayCap,
    backgroundReadCap: profile.defaultBackgroundReadCap,
    maxRegionForReads: profile.defaultMaxRegionForReads,
    ...(info.effective === 'low' ? { readDisplayMode: 'sample' as const, loadAllReads: {}, cachedLayerTypes: {} } : {}),
    refreshGeneration: s.refreshGeneration + (refresh ? 1 : 0),
  }));
  usePerformanceStore.setState({ info, error: null });
}

interface PerformanceState {
  info: PerformanceInfo | null;
  busy: boolean;
  error: string | null;
  setMode: (mode: PerformanceMode) => Promise<void>;
  refresh: () => Promise<void>;
}

export const usePerformanceStore = create<PerformanceState>((set) => ({
  info: null, busy: false, error: null,
  setMode: async mode => {
    set({ busy: true, error: null });
    try {
      applyPerformanceInfo(await fetchJson<PerformanceInfo>('/api/app/performance', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, browser_tier: inferBrowserPerformanceProfile().tier }),
      }));
    } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); }
    finally { set({ busy: false }); }
  },
  refresh: async () => {
    try {
      const info = await fetchJson<PerformanceInfo>('/api/app/performance');
      const previous = usePerformanceStore.getState().info;
      if (previous && (previous.mode !== info.mode || previous.effective !== info.effective)) applyPerformanceInfo(info);
      else set({ info });
    }
    catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); }
  },
}));

export async function initializePerformanceMode(): Promise<void> {
  if (isSandboxPage() || isPublicServerPage()) return;
  try {
    let info = await fetchJson<PerformanceInfo>('/api/app/performance');
    if (info.mode === 'auto') {
      info = await fetchJson<PerformanceInfo>('/api/app/performance', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'auto', browser_tier: inferBrowserPerformanceProfile().tier, persist: false }),
      });
    }
    applyPerformanceInfo(info, false);
  } catch { /* A shared server keeps its operator's limits. */ }
}
