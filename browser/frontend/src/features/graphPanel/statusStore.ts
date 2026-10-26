/** The graph helper's status and the registered packages, shared by every graph panel (one request at a time). */
import { create } from 'zustand';
import { getGraphStatus, registerGraphPackage, GraphRequestError } from './api';
import type { GraphStatus } from './types';
import { isPublicMode } from '../../utils/publicMode';
import { isSandboxPage } from '../../utils/sandbox';

interface GraphStatusState {
  status: GraphStatus | null;
  loading: boolean;
  error: string | null;
  /** The server refuses graph routes here (a public server, a tour tab, a lab member): asked once, not again. */
  refused: boolean;
  load: (force?: boolean) => Promise<void>;
  register: (packageDir: string) => Promise<string | null>;
}

let inflight: Promise<void> | null = null;

/** Errors saying the package changed, went missing or is no longer registered (any graph route). */
export const PACKAGE_ERRORS = ['package_changed', 'unknown_registration', 'stale_revision'];

/** After such an error, from any request: the status is read again, so every panel and inspector of that package
 * shows it unavailable (with its relink) instead of trusting what it last had. */
export function onPackageError(code: string | null | undefined): boolean {
  if (!code || !PACKAGE_ERRORS.includes(code)) return false;
  void useGraphStatusStore.getState().load(true);
  return true;
}

export const useGraphStatusStore = create<GraphStatusState>((set, get) => ({
  status: null,
  loading: false,
  error: null,
  refused: false,
  load: (force = false) => {
    if (inflight) return inflight;
    if (get().status && !force) return Promise.resolve();
    // Graph mode is off on public servers and in tour tabs (public-mode rules): no request, no console error.
    if (isPublicMode() || isSandboxPage()) {
      if (!get().refused) set({ refused: true, error: 'Graph mode is not available on this server.' });
      return Promise.resolve();
    }
    if (get().refused && !force) return Promise.resolve();
    set({ loading: true });
    inflight = getGraphStatus()
      .then(status => set({ status, error: null, refused: false }))
      .catch(err => set({ error: err instanceof Error ? err.message : String(err),
        ...(err instanceof GraphRequestError && err.status === 403 ? { refused: true } : {}) }))
      .finally(() => { inflight = null; set({ loading: false }); });
    return inflight;
  },
  register: async (packageDir: string) => {
    try {
      await registerGraphPackage(packageDir);
    } catch (err) {
      return err instanceof GraphRequestError ? err.error.message : String(err);
    }
    await get().load(true);
    return null;
  },
}));
