import { useEffect, Component, ReactNode, ErrorInfo } from 'react';
import { SkipLinks } from './components/ui/SkipLinks';
import { Browser } from './components/Browser';
import { useBrowserStore } from './stores/browserStore';
import { autoSaveNow } from './hooks/useAutoSave';
import { getChromosomes, getGenomes, loadGenome, loadFasta } from './api/reference';
import { getGenomeCheck } from './api/genomeCheck';
import { getStatus } from './api/status';
import { fetchApiResponse } from './api/sharedFetch';
import { registerAnalysisPanel } from './plugins';
import { PythonPluginPanel } from './components/controls/PythonPluginPanel';
import { openTourTab } from './utils/tourTab';
import { genomeLoadHasFasta, pickAutoloadGenome, startupGenomeAutoload } from './utils/genomeAutoload';
import { installPlasmidLinkWatcher } from './utils/plasmidLoader';
import { SessionLinkHost } from './components/controls/SessionLinkDialog';
import { LiveLiftDialog } from './features/liveLift/LiveLiftDialog';
import { LiveLiftSettingsDialog } from './features/liveLift/LiveLiftSettingsDialog';
import { LinkExpiryBanner } from './components/controls/LinkExpiryBanner';
import { STARTUP_LINK_REQUEST, isSessionLinkValue, startupLinkOutcome } from './utils/sessionLinks';
import { UI_THEME, roundedPanels } from './theme/uiTheme';
import { usePerformanceStore } from './stores/performanceStore';

declare global {
  interface Window {
    __FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD?: boolean;
    __FIBERBROWSER_E2E_EXPOSE_STORE?: boolean;
    __FIBERBROWSER_STORE__?: typeof useBrowserStore;
    __FIBERBROWSER_TOUR_TAB__?: { openTourTab: typeof openTourTab };
  }
}

if (typeof window !== 'undefined' && window.__FIBERBROWSER_E2E_EXPOSE_STORE) {
  window.__FIBERBROWSER_STORE__ = useBrowserStore;
  window.__FIBERBROWSER_TOUR_TAB__ = { openTourTab };
}

// Error boundary to prevent white screen crashes
interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

/** Heuristic: detect "your cached bundle references chunks the server no
 *  longer has" errors from Vite's code-split `React.lazy()` imports. These
 *  fire when a user keeps a tab open across a rebuild/restart; the tab
 *  still runs the old `index-<hash>.js`, which then tries to import a now-
 *  absent `FooPanel-<hash>.js`. The only real fix is a hard reload to
 *  fetch the new manifest.
 */
function isStaleChunkError(err: Error | null): boolean {
  if (!err) return false;
  const m = err.message || '';
  return (
    m.includes('Failed to fetch dynamically imported module') ||
    m.includes('Importing a module script failed') ||
    // Browser-specific variants we've seen in the wild
    m.includes('Loading chunk') ||
    m.includes('Loading CSS chunk')
  );
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  // Session-storage key so the stale-chunk auto-reload only fires once
  // per tab. If reloading didn't clear the error (rare — would mean the
  // dist really is missing the chunk), we surface the normal UI instead of
  // infinite-looping reload.
  static RELOAD_MARKER = 'fiberhmm_stale_chunk_reload';

  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Error boundary caught error:', error, errorInfo);

    // Stale chunk from a rebuild while the tab was open — auto-reload
    // instead of showing the user a scary stack trace. The session-
    // storage guard ensures we don't loop if the chunk really is missing.
    if (isStaleChunkError(error)) {
      try {
        const alreadyReloaded = sessionStorage.getItem(ErrorBoundary.RELOAD_MARKER);
        if (!alreadyReloaded) {
          sessionStorage.setItem(ErrorBoundary.RELOAD_MARKER, '1');
          // Save the page for crash recovery first (a comparison frame, an open card, unsaved work: the reload
          // offers them back), then reload; never wait more than 2 s for the save.
          let reloaded = false;
          const reload = () => { if (!reloaded) { reloaded = true; window.location.reload(); } };
          void autoSaveNow().catch(() => undefined).finally(reload);
          setTimeout(reload, 2000);
          return;
        }
      } catch {
        // sessionStorage unavailable (private mode / SSR) — fall through
        // to the normal error UI.
      }
    }
    this.setState({ errorInfo });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-8 bg-red-50 dark:bg-red-950 min-h-screen">
          <h1 className="text-2xl font-bold text-red-700 dark:text-red-400 mb-4">Something went wrong</h1>
          <p className="text-red-600 dark:text-red-400 mb-4">
            {this.state.error?.message || 'An unexpected error occurred'}
          </p>
          <details className="bg-white dark:bg-dark-surface p-4 rounded border border-red-200 dark:border-red-800">
            <summary className="cursor-pointer text-red-700 dark:text-red-400 font-medium">Error details</summary>
            <pre className="mt-2 text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap overflow-auto">
              {this.state.error?.stack}
              {this.state.errorInfo?.componentStack}
            </pre>
          </details>
          <div className="mt-4 flex gap-3">
            <button
              onClick={() => this.setState({ hasError: false, error: null, errorInfo: null })}
              className="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700"
            >
              Try Again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

function App() {
  useEffect(() => {
    const refresh = () => { if (usePerformanceStore.getState().info) void usePerformanceStore.getState().refresh(); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  // If we got here cleanly, the tab successfully fetched the current
  // bundle — clear the stale-chunk reload marker so future mismatches can
  // auto-recover.
  try { sessionStorage.removeItem(ErrorBoundary.RELOAD_MARKER); } catch {}

  const setChroms = useBrowserStore(state => state.setChroms);
  const setError = useBrowserStore(state => state.setError);
  const darkMode = useBrowserStore(state => state.darkMode);

  // A BAM linked to a plasmid map when it loaded (any load path): refresh the
  // chromosomes and say why a plasmid BAM did not match.
  useEffect(() => installPlasmidLinkWatcher(), []);

  // Sync dark mode class to <html> and color-scheme meta tag
  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute('content', darkMode ? 'dark' : 'light');
  }, [darkMode]);

  // The header tone and panel shape of the theme (src/theme/uiTheme.ts), for the CSS.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.fbHeader = UI_THEME.headerTone;
    root.dataset.fbPanels = roundedPanels() ? 'rounded' : 'square';
  }, []);

  useEffect(() => {
    getChromosomes()
      .then(res => setChroms(res.chroms))
      .catch(err => setError(`Failed to connect to backend: ${err.message}`));
  }, [setChroms, setError]);

  // Auto-load last-used reference on mount. Priority order:
  //   1. A previously-loaded local FASTA path (fiberhmm_last_fasta_path) —
  //      restored by re-calling loadFasta(). Lets users with custom genomes
  //      (e.g. non-model organisms, masked builds) keep their setup across
  //      reloads instead of being yanked back to hg38 every time.
  //   2. A previously-picked registry genome (fiberhmm_last_genome).
  //   3. hg38 default fallback.
  // Skipped entirely if the store already has currentGenome/hasFasta — that
  // means session restore beat us to the punch.
  useEffect(() => {
    if (!startupGenomeAutoload()) return;

    // Opened with a session link: its genome (once confirmed) wins; the usual
    // auto-load runs only if the link loaded no reference.
    if (STARTUP_LINK_REQUEST) {
      let cancelled = false;
      startupLinkOutcome.then(outcome => {
        if (!cancelled && !outcome.genomeLoaded) runAutoLoad();
      });
      return () => { cancelled = true; };
    }

    // Defer the auto-load to the next microtask so Browser.tsx's /api/status
    // hydration (currentGenome, hasFasta) lands first. Without this defer we
    // race against it and can double-load or bail out early.
    const timer = setTimeout(() => runAutoLoad(), 50);
    return () => clearTimeout(timer);

    function runAutoLoad() {
    const state = useBrowserStore.getState();
    // Skip only when BOTH the genome name and the FASTA are already known to
    // the frontend — that means /api/status has hydrated a backend-loaded
    // genome and there's nothing to do. If only hasFasta is set (e.g. from a
    // stale session), we still want the localStorage-based re-picker to run
    // so the user's last genome is restored by name.
    if (state.currentGenome && state.hasFasta) return;

    // Check if a catalog is configured — if so, skip the localStorage-based
    // auto-restore because the CatalogSection handles genome loading and we
    // don't want a stale hg38 from a previous local session overriding it.
    // Ask the server itself: under load its /api/status answer to Browser.tsx can come after the defer
    // above, and a reference it already has (--fasta, a loaded genome) must never be replaced by the
    // remembered or default genome (integ/fb35 smoke: a --fasta dm6 was swapped for the remote dm6).
    getStatus(false).then(st => {
      if (st.has_fasta || st.current_genome) return;
      checkCatalog();
    }).catch(() => checkCatalog());
    function checkCatalog() {
    fetchApiResponse('/api/catalog').then(r => r.json()).then(res => {
      if (res.catalog) return; // catalog handles genome loading
      doAutoLoad();
    }).catch(() => doAutoLoad());
    }
    function doAutoLoad() {
      const s = useBrowserStore.getState();
      if (s.currentGenome || s.hasFasta) return;

    // 1. Try restoring a stored local FASTA first.
    let lastFastaPath: string | null = null;
    try { lastFastaPath = localStorage.getItem('fiberhmm_last_fasta_path'); } catch {}
    if (lastFastaPath) {
      loadFasta(lastFastaPath)
        .then(res => {
          if (res.success) {
            const s = useBrowserStore.getState();
            s.setHasFasta(true);
            s.setFastaPath(lastFastaPath!);
            // Don't set currentGenome — local FASTAs aren't registry genomes.
            useBrowserStore.getState().triggerRefresh();
            getStatus().then(statusRes => {
              if (statusRes.initial_position) {
                useBrowserStore.getState().setViewport(
                  statusRes.initial_position.chrom,
                  statusRes.initial_position.start,
                  statusRes.initial_position.end,
                );
              }
            }).catch(() => {});
          } else {
            // Stored path is stale (e.g. file moved) — clear it and fall back.
            try { localStorage.removeItem('fiberhmm_last_fasta_path'); } catch {}
            autoLoadGenomeFallback();
          }
        })
        .catch(() => {
          try { localStorage.removeItem('fiberhmm_last_fasta_path'); } catch {}
          autoLoadGenomeFallback();
        });
      return;
    }

    autoLoadGenomeFallback();

    // 2/3. Registry genome (last used) → hg38 fallback.
    function autoLoadGenomeFallback() {
      let targetId: string | null = null;
      try { targetId = localStorage.getItem('fiberhmm_last_genome'); } catch {}
      if (!targetId) targetId = 'hg38';
      const remembered = targetId;
      // The data's chromosome names decide the species: hg38 (or a remembered
      // genome) is not loaded under a fly BAM, whose chr2R it doesn't have.
      Promise.all([getGenomes(), getChromosomes().catch(() => ({ chroms: [] })), getGenomeCheck().catch(() => null)])
        .then(([res, chromRes, check]) => {
          // The assembly the data's contig lengths name (hg19 vs hg38, mm10
          // vs mm39) wins over the remembered genome and the species guess.
          const fromData = check?.suggestion?.confidence === 'high' ? check.suggestion.genome_id : null;
          const genomeId = fromData && res.genomes.some((g: { id: string }) => g.id === fromData) ? fromData : pickAutoloadGenome(
            remembered,
            chromRes.chroms.map((c: { name: string }) => c.name),
            res.genomes.map((g: { id: string }) => g.id),
          );
          const genome = res.genomes.find((g: { id: string }) => g.id === genomeId);
          if (genome) {
            loadGenome(genome.id).then(loadRes => {
              if (loadRes.success) {
                const s = useBrowserStore.getState();
                // Only a loaded FASTA gives the sequence track bases to ask for.
                s.setHasFasta(genomeLoadHasFasta(loadRes));
                // IMPORTANT: pass null, not genome.name. Persisting
                // genome.name as `fiberhmm_last_fasta_path` makes the next
                // reload take the local-FASTA branch (which only calls
                // loadFasta, never loadGenome → GTF never re-downloads).
                s.setFastaPath(null);
                s.setCurrentGenome(genome.id);
                useBrowserStore.getState().triggerRefresh();
                getStatus().then(statusRes => {
                  if (statusRes.initial_position) {
                    useBrowserStore.getState().setViewport(
                      statusRes.initial_position.chrom,
                      statusRes.initial_position.start,
                      statusRes.initial_position.end,
                    );
                  }
                }).catch(() => {});
              }
            }).catch(() => {});
          }
        })
        .catch(() => {});
    } // end doAutoLoad
    }  // end inner block from catalog check
    }  // end runAutoLoad
  }, []);

  // Discover external plugins on boot
  useEffect(() => {
    fetchApiResponse('/api/plugins/registry')
      .then(res => res.json())
      .then(data => {
        for (const manifest of data.plugins || []) {
          const apiPrefix = manifest.api_prefix;
          registerAnalysisPanel({
            contentType: manifest.name,
            label: manifest.label || manifest.name,
            headerColor: manifest.header_color || manifest.headerColor || '#6366f1',
            description: manifest.description,
            singleton: true,
            component: (props) => <PythonPluginPanel {...props} apiPrefix={apiPrefix} />,
          });
        }
      })
      .catch(() => {}); // Silently ignore if no plugins
  }, []);

  // Shutdown server when tab/window is closed (only from main browser, not DAF-C window or linked session).
  // Disabled entirely in public mode — the server injects a synchronous flag into
  // index.html so we know BEFORE any async status fetch completes.
  const publicMode = useBrowserStore(state => state.publicMode)
    || typeof window !== 'undefined' && (window as any).__FIBERHMM_PUBLIC__ === true;
  useEffect(() => {
    if (publicMode) return;
    // A linked window (?session=<id>) is not the main browser; a session link
    // (?session=<URL>) is, and the link dialog takes it out of the address bar.
    const sessionParam = new URLSearchParams(window.location.search).get('session');
    const hasSessionParam = sessionParam !== null && !isSessionLinkValue(sessionParam);
    const hasSharedParam = window.location.search.includes('shared=');
    if (hasSessionParam || hasSharedParam) return;

    // On mount: if we're coming back from a reload, cancel the pending shutdown
    const wasReloading = sessionStorage.getItem('fiberhmm_reloading');
    if (wasReloading) {
      sessionStorage.removeItem('fiberhmm_reloading');
      fetchApiResponse('/api/cancel_shutdown', { method: 'POST' }).catch(() => {});
    }

    // Each tab checks in; the server only shuts down when the last one closes.
    // A fresh id per page load: duplicated tabs copy sessionStorage, and a
    // reload must not be mistaken for the page that just closed.
    const tabId = Math.random().toString(36).slice(2, 12);
    const heartbeat = () => {
      fetchApiResponse(`/api/tabs/heartbeat?tab=${tabId}`, { method: 'POST' }).catch(() => {});
    };
    heartbeat();
    const heartbeatTimer = window.setInterval(heartbeat, 10_000);

    const handleUnload = () => {
      // Mark that we're unloading — if we come back (reload), we'll cancel
      sessionStorage.setItem('fiberhmm_reloading', '1');
      navigator.sendBeacon(`/api/shutdown?tab=${tabId}`, '');
    };

    window.addEventListener('beforeunload', handleUnload);
    return () => {
      window.clearInterval(heartbeatTimer);
      window.removeEventListener('beforeunload', handleUnload);
    };
  }, [publicMode]);

  // Main browser
  return (
    <ErrorBoundary>
      <div className="w-full h-full">
        {/* First in the tab order: jump past the toolbar to the reads or the side panels (N13). */}
        <SkipLinks />
        <Browser />
        <SessionLinkHost />
        <LiveLiftDialog />
        <LiveLiftSettingsDialog />
        <LinkExpiryBanner />
      </div>
    </ErrorBoundary>
  );
}

export default App;
