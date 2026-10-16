import { useEffect, useRef } from 'react';
import { useBrowserStore } from '../stores/browserStore';
import { isPublicServerPage } from '../utils/publicServerFlag';
import { isCopilotIncluded } from '../utils/copilotIncluded';
import { getActivityLog, logActivity, logError } from '../utils/activityLog';
import { readStoredFlag, writeStoredFlag } from '../utils/copilotSettings';

// State keys whose changes we treat as user actions worth logging. Excludes
// transient/derived fields (loading, error, panOffset, crosshair) and
// server-derived data (chroms, genes, firePeaks, clusterAssignments,
// orthogonalTracks — those arrive via API responses and are already logged
// by sharedFetch or represented through catalog/composite metadata).
export const ACTIVITY_WATCHED_KEYS = [
  'panels', 'hiddenStripPanels', 'analysisStripCollapsed',
  'peaksLocked', 'peakRules', 'selectedPeaks',
  'clusterFocus', 'clusterMethod', 'clusterK', 'subnucleosomalThreshold', 'accessibilityThreshold',
  'clusterPreparationCount', 'clusterPreparationSamples', 'analysisSampleCount', 'analysisSampleSeed',
  'spanningOnly', 'allReadsDisplayCap', 'backgroundReadCap', 'readDisplayMode', 'downsampleCount',
  'transcriptionStateFilters', 'footprintGroups',
  'editMode', 'showRelativeCoords', 'relativeTSS',
  'currentGenome', 'uiScale', 'sessionName',
  'savedClusters', 'savedTracks', 'compositeTracks',
  'enabledMetaProfiles', 'enabledModTypes',
  'activeColormap',
] as const;

// Hard cap on per-event payload size — keeps activity-log events small enough
// that 500 entries stay under ~1 MB even if the user has lots of selections.
const MAX_ARRAY_ITEMS = 30;

function _cap<T>(arr: T[], n: number = MAX_ARRAY_ITEMS): { items: T[]; truncated: number } {
  if (arr.length <= n) return { items: arr, truncated: 0 };
  return { items: arr.slice(0, n), truncated: arr.length - n };
}

function _summarizeArrayFallback(value: unknown[]): unknown {
  return { len: value.length };
}

function _enabledKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
}

/** Per-key extractor: produces a training-useful summary for the keys we care
 * about (panels, selectedPeaks, clusterFocus, etc.). Anything not handled
 * falls back to the lossy {len}/{keys, sample} default. Output is intentionally
 * a plain object so the server-side anonymizer can walk it via its existing
 * key-name rules (`gene`, `dataset_id`, `motif`, `start/end/position`, …). */
export function _summarizeValue(key: string, value: unknown): unknown {
  if (value == null) return value;

  switch (key) {
    case 'panels':
    case 'hiddenStripPanels': {
      if (!Array.isArray(value)) return _summarizeArrayFallback([]);
      const { items, truncated } = _cap(value as Array<Record<string, unknown>>);
      return {
        len: (value as unknown[]).length,
        items: items.map(p => ({
          contentType: p.contentType ?? null,
          dataset_id: p.datasetId ?? p.dataset_id ?? null,
          stateKey: p.stateKey ?? null,
          collapsed: p.collapsed ?? null,
        })),
        ...(truncated ? { truncated } : {}),
      };
    }

    case 'selectedPeaks': {
      if (!Array.isArray(value)) return _summarizeArrayFallback([]);
      const { items, truncated } = _cap(value as Array<Record<string, unknown>>);
      return {
        len: (value as unknown[]).length,
        items: items.map(p => ({
          chrom: p.chrom ?? null,
          start: p.start ?? null,
          end: p.end ?? null,
          position: p.position ?? p.summit ?? null,
          source: p.source ?? null,
        })),
        ...(truncated ? { truncated } : {}),
      };
    }

    case 'peakRules': {
      if (!Array.isArray(value)) return _summarizeArrayFallback([]);
      const { items, truncated } = _cap(value as Array<Record<string, unknown>>);
      return {
        len: (value as unknown[]).length,
        items: items.map(r => ({
          name: r.name ?? null,
          layer: r.layer ?? null,
          size_min: r.sizeMin ?? r.size_min ?? null,
          size_max: r.sizeMax ?? r.size_max ?? null,
        })),
        ...(truncated ? { truncated } : {}),
      };
    }

    case 'clusterFocus': {
      // Either Record<stateKey, Set<number>> or Record<stateKey, number[]>.
      if (!value || typeof value !== 'object') return null;
      const out: Record<string, number[]> = {};
      for (const [stateKey, v] of Object.entries(value as Record<string, unknown>)) {
        if (v instanceof Set) {
          out[stateKey] = Array.from(v).slice(0, MAX_ARRAY_ITEMS) as number[];
        } else if (Array.isArray(v)) {
          out[stateKey] = (v as number[]).slice(0, MAX_ARRAY_ITEMS);
        }
      }
      return out;
    }

    case 'activeColormap': {
      const cmap = value as Record<string, unknown>;
      const rules = (cmap.rules as Array<Record<string, unknown>> | undefined) ?? [];
      const { items, truncated } = _cap(rules);
      return {
        name: cmap.name ?? null,
        rule_count: rules.length,
        rules: items.map(r => ({
          color: r.color ?? null,
          color_name: r.colorName ?? r.color_name ?? null,
          layer: r.layer ?? null,
          region_label: r.regionLabel ?? r.region_label ?? null,
          gene: r.gene ?? r.geneName ?? r.gene_name ?? null,
          chrom: r.chrom ?? null,
          start: r.start ?? null,
          end: r.end ?? null,
          position: r.position ?? null,
          offset_bp: r.offsetBp ?? r.offset_bp ?? null,
          size_min: r.sizeMin ?? r.size_min ?? null,
          size_max: r.sizeMax ?? r.size_max ?? null,
        })),
        ...(truncated ? { truncated } : {}),
      };
    }

    case 'footprintGroups': {
      if (!Array.isArray(value)) return _summarizeArrayFallback([]);
      const { items, truncated } = _cap(value as Array<Record<string, unknown>>);
      return {
        len: (value as unknown[]).length,
        items: items.map(g => ({
          name: g.name ?? null,
          color: g.color ?? null,
          source_index: g.sourceIndex ?? g.source_index ?? null,
          size_min: g.sizeMin ?? g.size_min ?? null,
          size_max: g.sizeMax ?? g.size_max ?? null,
          overlap_fraction: g.overlapFraction ?? g.overlap_fraction ?? null,
          enabled: g.enabled ?? null,
        })),
        ...(truncated ? { truncated } : {}),
      };
    }

    case 'compositeTracks':
    case 'savedTracks':
    case 'orthogonalTracks': {
      if (!Array.isArray(value)) return _summarizeArrayFallback([]);
      const { items, truncated } = _cap(value as Array<Record<string, unknown>>);
      return {
        len: (value as unknown[]).length,
        items: items.map(t => ({
          kind: t.kind ?? t.type ?? null,
          label: t.label ?? null,
          dataset_id: t.datasetId ?? t.dataset_id ?? null,
          source_count: Array.isArray(t.sources)
            ? (t.sources as unknown[]).length
            : null,
        })),
        ...(truncated ? { truncated } : {}),
      };
    }

    case 'savedClusters': {
      if (!Array.isArray(value)) return _summarizeArrayFallback([]);
      const { items, truncated } = _cap(value as Array<Record<string, unknown>>);
      return {
        len: (value as unknown[]).length,
        items: items.map(c => ({
          name: c.name ?? null,
          chrom: (c.viewport as Record<string, unknown> | undefined)?.chrom ?? null,
          start: (c.viewport as Record<string, unknown> | undefined)?.start ?? null,
          end: (c.viewport as Record<string, unknown> | undefined)?.end ?? null,
          method: (c.config as Record<string, unknown> | undefined)?.method ?? null,
          k: (c.config as Record<string, unknown> | undefined)?.k ?? null,
        })),
        ...(truncated ? { truncated } : {}),
      };
    }

    case 'transcriptionStateFilters':
    case 'enabledMetaProfiles':
    case 'enabledModTypes':
      return _enabledKeys(value);

    default:
      // Lossy fallback for any key we haven't specialized — same shape as before.
      if (Array.isArray(value)) return _summarizeArrayFallback(value);
      if (typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj);
        return { keys: keys.length, sample: keys.slice(0, 4) };
      }
      return value;
  }
}

/**
 * Persist the full browser session — snapshot stack + Copilot command history —
 * on tab close so it can be distilled into organic-usage training data later.
 *
 * Uses navigator.sendBeacon, which is the only reliable way to fire async work
 * during the unload event. The backend writes the dump under
 * data/copilot_dataset/usage_logs/. Files are gitignored (they contain
 * user-specific gene names, dataset paths, etc.).
 *
 * A periodic flush also runs every 5 minutes so a hard crash doesn't lose the
 * session.
 */
const FLUSH_INTERVAL_MS = 60_000; // 1 min — frequent enough that a hard crash loses ≤60 s of work
const FLUSH_ON_HISTORY_DELAY_MS = 2_000; // debounce post-event flushes so a burst doesn't hammer the backend
export const SHARE_OPT_IN_KEY = 'fiberhmm_copilot_share_usage';
export const SHARE_FULL_DETAILS_KEY = 'fiberhmm_copilot_share_full_details';

export function readShareOptIn(): boolean {
  return readStoredFlag(SHARE_OPT_IN_KEY);
}

export function writeShareOptIn(value: boolean): void {
  writeStoredFlag(SHARE_OPT_IN_KEY, value);
}

export function readShareFullDetails(): boolean {
  return readStoredFlag(SHARE_FULL_DETAILS_KEY);
}

export function writeShareFullDetails(value: boolean): void {
  writeStoredFlag(SHARE_FULL_DETAILS_KEY, value);
}

function buildDumpString(sessionId: string, startedAt: number, explicit = false): string {
  const state = useBrowserStore.getState() as unknown as Record<string, unknown>;
  const snapshots = (state._historyStack as unknown[] | undefined) ?? [];
  const commandHistory = (state.commandHistory as unknown[] | undefined) ?? [];
  const datasets = (state.datasets as unknown[] | undefined) ?? [];
  const panels = (state.panels as Array<{ contentType?: string }> | undefined) ?? [];
  const payload = {
    session_id: sessionId,
    started_at: startedAt,
    share: readShareOptIn(),
    share_full_details: readShareFullDetails(),
    explicit,
    snapshots,
    command_history: commandHistory,
    activity_log: getActivityLog(),
    metadata: {
      user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      genome: (state.currentGenome as string | null) ?? null,
      dataset_count: datasets.length,
      panels: panels.map(p => p.contentType),
      ui_scale: (state.uiScale as number | undefined) ?? null,
      session_name: (state.sessionName as string | null) ?? null,
    },
  };
  return JSON.stringify(payload);
}

// Whether the server keeps local usage logs (FIBERBROWSER_USAGE_LOG=1).
// Unknown until the first status check; treated as off.
let serverUsageLogging = false;

function loggingWanted(explicit: boolean): boolean {
  return explicit || serverUsageLogging || readShareOptIn();
}

/** Browsers refuse a keepalive request whose body (with others in flight) passes 64 KiB. */
const KEEPALIVE_BUDGET_BYTES = 60_000;

function flush(sessionId: string, startedAt: number, useBeacon: boolean, explicit = false): Promise<boolean> {
  // Usage logging is opt-in: automatic saves are skipped unless the user
  // shares logs or the operator enabled local logging.
  if (!loggingWanted(explicit)) return Promise.resolve(false);
  const text = buildDumpString(sessionId, startedAt, explicit);
  // Don't bother flushing empty sessions.
  if (text.length < 200) return Promise.resolve(false);

  // On unload (useBeacon=true): try sendBeacon first if payload fits (it's
  // the most reliable cross-browser unload mechanism), otherwise fall back
  // to fetch+keepalive. For periodic flushes / manual saves, just use fetch.
  // sendBeacon and fetch+keepalive share a 64 KiB budget; a keepalive request
  // over it is refused outright, so only a small unload flush asks for it.
  if (useBeacon && typeof navigator !== 'undefined'
      && typeof navigator.sendBeacon === 'function'
      && text.length < 60_000) {
    const ok = navigator.sendBeacon(
      '/api/nl/log_session',
      new Blob([text], { type: 'application/json' }),
    );
    if (ok) {
      console.log(`[copilot] session-log queued via beacon (${text.length} bytes)`);
      return Promise.resolve(true);
    }
    console.warn('[copilot] sendBeacon refused payload, falling back to fetch+keepalive');
  }

  return fetch('/api/nl/log_session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: text,
    // Past the budget an unload flush goes as a plain request (it may be cut
    // off with the page, but a keepalive one would never be sent at all).
    ...(useBeacon && new Blob([text]).size < KEEPALIVE_BUDGET_BYTES ? { keepalive: true } : {}),
  })
    .then(r => {
      if (!r.ok) {
        console.warn(`[copilot] session-log POST failed: ${r.status}`);
        return false;
      }
      console.log(`[copilot] session-log saved (${text.length} bytes)`);
      return true;
    })
    .catch(err => {
      console.warn('[copilot] session-log POST errored:', err);
      return false;
    });
}

export async function flushSessionNow(): Promise<boolean> {
  // Manually trigger a session save. Used by the "Save now" button so the
  // user can test/verify without relying on tab-close events.
  const sessionId = (window as any).__fiberhmmSessionId
    ?? `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = (window as any).__fiberhmmSessionStartedAt ?? Date.now() / 1000;
  return flush(sessionId, startedAt, false, true);
}

export function useSessionLog() {
  const sessionIdRef = useRef<string>('');
  const startedAtRef = useRef<number>(Date.now() / 1000);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.__FIBERBROWSER_RENDER_MODE) return;
    // Usage logs are the host's own training data; never collected from public visitors,
    // nor where the Copilot they train is left out (FiberBrowser.app).
    if (isPublicServerPage() || !isCopilotIncluded()) return;
    if (!sessionIdRef.current) {
      // Compact, sortable session id.
      sessionIdRef.current = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    }
    const sessionId = sessionIdRef.current;
    const startedAt = startedAtRef.current;
    fetch('/api/nl/share_status')
      .then(response => (response.ok ? response.json() : null))
      .then(status => { serverUsageLogging = Boolean(status?.local_logging); })
      .catch(() => { /* logging stays off */ });
    // Expose to flushSessionNow() so the manual "Save now" button uses
    // the same id and started_at as the auto-flush.
    (window as any).__fiberhmmSessionId = sessionId;
    (window as any).__fiberhmmSessionStartedAt = startedAt;

    const onUnload = () => flush(sessionId, startedAt, true);
    const onPageHide = () => flush(sessionId, startedAt, true);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush(sessionId, startedAt, true);
    };

    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);

    // Crash / error capture. logError pushes into the same activity buffer
    // that ships in the session dump, so the maintainer can see what the
    // user was doing in the moments before something blew up.
    const onWindowError = (e: ErrorEvent) => {
      logError('window', e.error ?? e.message, {
        filename: e.filename, lineno: e.lineno, colno: e.colno,
      });
      flushSoon();
    };
    const onUnhandledRejection = (e: PromiseRejectionEvent) => {
      logError('unhandledrejection', e.reason);
      flushSoon();
    };
    window.addEventListener('error', onWindowError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);

    const interval = window.setInterval(() => flush(sessionId, startedAt, false), FLUSH_INTERVAL_MS);

    // Debounced flush after meaningful events so a completed Copilot command
    // or a clustering run lands in the log file within ~2 s, not up to 60 s.
    let postEventTimer: ReturnType<typeof setTimeout> | null = null;
    const flushSoon = () => {
      if (postEventTimer) clearTimeout(postEventTimer);
      postEventTimer = setTimeout(() => flush(sessionId, startedAt, false), FLUSH_ON_HISTORY_DELAY_MS);
    };

    // Watch for any "meaningful event" so the flush fires within ~2 s of:
    //   - a completed Copilot command (commandHistory grows), OR
    //   - a clustering / sort / filter / label / scan / navigation
    //     (anything that calls pushSnapshot, which lands in _historyStack).
    // The 60 s interval still catches plain API calls and micro UI changes
    // that don't push a snapshot.
    const meaningfulEventUnsub = useBrowserStore.subscribe((next, prev) => {
      const nextRec = next as unknown as Record<string, unknown>;
      const prevRec = prev as unknown as Record<string, unknown>;
      if (nextRec.commandHistory !== prevRec.commandHistory) return flushSoon();
      if (nextRec._historyStack !== prevRec._historyStack) return flushSoon();
    });

    // Catch-all UI-action logger: subscribe to the store and log diffs on the
    // watched keys. Catches every panel toggle, peak lock, threshold change,
    // sort change, etc. without per-slice instrumentation.
    const unsubscribe = useBrowserStore.subscribe((next, prev) => {
      const nextRec = next as unknown as Record<string, unknown>;
      const prevRec = prev as unknown as Record<string, unknown>;
      for (const key of ACTIVITY_WATCHED_KEYS) {
        if (nextRec[key] !== prevRec[key]) {
          logActivity({
            timestamp: Date.now(),
            kind: 'ui',
            label: `change:${key}`,
            details: { value: _summarizeValue(key, nextRec[key]) },
          });
        }
      }
    });

    return () => {
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('error', onWindowError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      window.clearInterval(interval);
      unsubscribe();
      meaningfulEventUnsub();
      if (postEventTimer) clearTimeout(postEventTimer);
    };
  }, []);
}
