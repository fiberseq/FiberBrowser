/** The graph helper's status and the registered packages, shared by every graph panel (one request at a time). */
import { create } from 'zustand';
import { getGraphStatus, registerGraphPackage, GraphRequestError } from './api';
import type { GraphStatus } from './types';

interface GraphStatusState {
  status: GraphStatus | null;
  loading: boolean;
  error: string | null;
  load: (force?: boolean) => Promise<void>;
  register: (packageDir: string) => Promise<string | null>;
}

let inflight: Promise<void> | null = null;

export const useGraphStatusStore = create<GraphStatusState>((set, get) => ({
  status: null,
  loading: false,
  error: null,
  load: (force = false) => {
    if (inflight) return inflight;
    if (get().status && !force) return Promise.resolve();
    set({ loading: true });
    inflight = getGraphStatus()
      .then(status => set({ status, error: null }))
      .catch(err => set({ error: err instanceof Error ? err.message : String(err) }))
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
