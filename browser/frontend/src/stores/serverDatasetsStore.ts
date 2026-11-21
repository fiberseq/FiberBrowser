/**
 * The server's loaded-datasets key, from the tab heartbeat (routers/utility.py `datasets_key`): it changes when a
 * dataset is added, removed or replaced on the server, also by another tab or a script, so views that read
 * server-side dataset state (the graph view's read bindings) can refresh without polling a listing.
 *
 * A page that shows no dataset yet (the Welcome card) takes the server's datasets the way it does when it opens,
 * once their key has held for two heartbeats in a row (so an open this page started itself, still on its way to
 * the page, is never taken twice) and no session restore, launch decision or open is under way.
 */
import { create } from 'zustand';

interface ServerDatasetsState {
  key: string | null;
  /** How many heartbeats in a row reported this key. */
  steady: number;
  setKey: (key: string | null | undefined) => void;
}

export const useServerDatasetsStore = create<ServerDatasetsState>(set => ({
  key: null,
  steady: 0,
  setKey: key => set(s => (!key ? s : key !== s.key ? { key, steady: 1 } : { steady: s.steady + 1 })),
}));

export interface AdoptionContext {
  /** Datasets the page shows. */
  pageDatasets: number;
  /** A session restore, launch decision or dataset open is under way. */
  busy: boolean;
  steady: number;
}

/** Whether an empty page should take the server's datasets now. */
export function shouldAdoptServerDatasets(c: AdoptionContext): boolean {
  return c.pageDatasets === 0 && !c.busy && c.steady >= 2;
}
