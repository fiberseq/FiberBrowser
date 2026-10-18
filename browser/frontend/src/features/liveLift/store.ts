/** Live-lift UI state: whether the server's flag is on, and the add dialog. */
import { create } from 'zustand';
import { liveLiftEnabled } from './api';

interface LiveLiftUiState {
  /** The server's flag (FIBERBROWSER_LIVE_LIFT); null until asked. */
  enabled: boolean | null;
  dialogOpen: boolean;
  setDialogOpen: (open: boolean) => void;
  check: () => Promise<boolean>;
}

export const useLiveLiftStore = create<LiveLiftUiState>((set, get) => ({
  enabled: null,
  dialogOpen: false,
  setDialogOpen: open => set({ dialogOpen: open }),
  check: async () => {
    if (get().enabled !== null) return Boolean(get().enabled);
    const on = await liveLiftEnabled();
    set({ enabled: on });
    return on;
  },
}));
