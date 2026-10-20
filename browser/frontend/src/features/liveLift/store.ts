/** Live-lift UI state: whether the server's flag is on, and the add dialog. */
import { create } from 'zustand';
import { liveLiftEnabled } from './api';

interface LiveLiftUiState {
  /** The server's flag (FIBERBROWSER_LIVE_LIFT); null until asked. */
  enabled: boolean | null;
  dialogOpen: boolean;
  setDialogOpen: (open: boolean) => void;
  /** Source BAM(s) the dialog opens with ("View on another assembly (live lift)…" on a loaded BAM). */
  prefillBams: string[] | null;
  openFor: (paths: string[]) => void;
  check: () => Promise<boolean>;
}

export const useLiveLiftStore = create<LiveLiftUiState>((set, get) => ({
  enabled: null,
  dialogOpen: false,
  setDialogOpen: open => set(open ? { dialogOpen: true } : { dialogOpen: false, prefillBams: null }),
  prefillBams: null,
  openFor: paths => set({ dialogOpen: true, prefillBams: paths }),
  check: async () => {
    if (get().enabled !== null) return Boolean(get().enabled);
    const on = await liveLiftEnabled();
    set({ enabled: on });
    return on;
  },
}));
