import { useEffect } from 'react';
import { useBrowserStore } from '../stores/browserStore';
import { useCoaccStore } from '../stores/coaccStore';
import { useDafcStore } from '../stores/dafcStore';
import { usePanelLauncherStore } from '../stores/panelLauncherStore';
import { collectFrontendState } from '../api/session';
import { fetchApiResponse } from '../api/sharedFetch';
import { AUTO_SAVE_WATCHED_KEYS } from './useAutoSave';
import { extensionKeys } from '../stores/storeExtensions';

const PUSH_DEBOUNCE_MS = 1500;
const WATCHED_KEYS = [
  ...AUTO_SAVE_WATCHED_KEYS,
  'chrom', 'start', 'end', 'datasets', 'orthogonalTracks', 'slotOrder',
  'enabledCigarTypes', 'svDisplayEnabled', 'svMinLen', 'svMinSupport', 'svConflictOptions', 'svSplits', 'clusterGroupLabels', 'readRowHeight', 'fillReadHeight', 'showCoverageHistogram',
  'isReversed', 'collapsedRows', 'uiScale', 'darkMode', 'fullViewPanelId', 'readScrollOffsets',
] as const;

/** Track-area size without the analysis strip, which figure renders leave out. */
function trackAreaSize(): { width: number; height: number } | null {
  const container = document.querySelector('[data-export-container]') as HTMLElement | null;
  if (!container) return null;
  const rect = container.getBoundingClientRect();
  const strip = container.querySelector('[data-testid="analysis-strip"], [data-testid="analysis-strip-collapsed"]');
  const stripHeight = strip ? strip.getBoundingClientRect().height : 0;
  return { width: Math.round(rect.width), height: Math.round(rect.height - stripHeight) };
}

/**
 * Keeps the server's copy of what this browser shows, so the API can render
 * "the current view" (/api/render/figure) exactly as it looks here: same
 * panels, clusters, colors, layers and track size. With several tabs open,
 * the one the user is looking at wins: hidden tabs don't push, and a tab
 * pushes again when it becomes visible.
 */
export function useLiveFigureState() {
  useEffect(() => {
    if (typeof window === 'undefined' || window.__FIBERBROWSER_RENDER_MODE) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let pending = false;
    const push = () => {
      const state = useBrowserStore.getState();
      if (state.publicMode || state.datasets.length === 0) return;
      if (document.visibilityState === 'hidden') return;
      if (inFlight) { pending = true; return; } // keep uploads in order
      inFlight = true;
      const body = {
        viewport: { chrom: state.chrom, start: state.start, end: state.end },
        frontend_state: collectFrontendState(),
        layout: trackAreaSize(),
      };
      fetchApiResponse('/api/render/live_state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(() => { /* best effort; the next change retries */ })
        .finally(() => {
          inFlight = false;
          if (pending) { pending = false; schedule(); }
        });
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(push, PUSH_DEBOUNCE_MS);
    };
    const unsubBrowser = useBrowserStore.subscribe((state, prev) => {
      const s = state as unknown as Record<string, unknown>;
      const p = prev as unknown as Record<string, unknown>;
      if (WATCHED_KEYS.some(key => s[key] !== p[key])
        || extensionKeys().some(key => (s as unknown as Record<string, unknown>)[key] !== (p as unknown as Record<string, unknown>)[key])) schedule();
    });
    // Contact-map and co-accessibility settings live in their own stores.
    const unsubDafc = useDafcStore.subscribe(schedule);
    const unsubCoacc = useCoaccStore.subscribe(schedule);
    // The strip comes and goes with Analysis panels: Strip/Sidebar rail (the track area's height changes).
    const unsubLauncher = usePanelLauncherStore.subscribe((state, prev) => { if (state.mode !== prev.mode) schedule(); });
    const onVisible = () => { if (document.visibilityState === 'visible') schedule(); };
    window.addEventListener('resize', schedule);
    window.addEventListener('focus', schedule);
    document.addEventListener('visibilitychange', onVisible);
    schedule();
    return () => {
      if (timer) clearTimeout(timer);
      unsubBrowser();
      unsubDafc();
      unsubCoacc();
      unsubLauncher();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('focus', schedule);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
}
