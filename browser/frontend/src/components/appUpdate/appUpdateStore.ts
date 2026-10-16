/**
 * The update check's state in the page: the last answer, the dialog, the download.
 * Opened by the app menu's "Check for Updates…" (command `check-updates`), the About/Settings button, or the
 * banner the quiet check at startup shows.
 */
import { create } from 'zustand';
import {
  cancelUpdateDownload, checkForUpdates, getUpdateDownload, openUpdateDownload, startUpdateDownload,
  type DownloadStatus, type UpdateCheck,
} from '../../api/appUpdate';
import { isSandboxPage } from '../../utils/sandbox';
import { isLabServerPage } from '../../utils/labServer';
import { useBrowserStore } from '../../stores/browserStore';

interface AppUpdateState {
  dialogOpen: boolean;
  checking: boolean;
  check: UpdateCheck | null;
  error: string | null;
  download: DownloadStatus;
  openError: string | null;
  /** The banner of the startup check was closed (this page). */
  bannerDismissed: boolean;
  runCheck: (options?: { startup?: boolean; force?: boolean }) => Promise<UpdateCheck | null>;
  openDialog: (force?: boolean) => void;
  closeDialog: () => void;
  dismissBanner: () => void;
  startDownload: () => Promise<void>;
  cancelDownload: () => Promise<void>;
  openDownload: () => Promise<void>;
}

/** Only the owner's own FiberBrowser checks (never a public server, a lab server or a tour tab). */
export function updatesAvailableHere(): boolean {
  return !useBrowserStore.getState().publicMode && !isLabServerPage() && !isSandboxPage();
}

const POLL_MS = 500;
let polling: ReturnType<typeof setTimeout> | null = null;

export const useAppUpdateStore = create<AppUpdateState>((set, get) => ({
  dialogOpen: false,
  checking: false,
  check: null,
  error: null,
  download: { state: 'idle' },
  openError: null,
  bannerDismissed: false,

  runCheck: async ({ startup = false, force = false } = {}) => {
    set({ checking: true, error: null });
    try {
      const check = await checkForUpdates({ startup, force });
      set({ check, checking: false });
      return check;
    } catch (error) {
      set({ checking: false, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  },

  openDialog: (force = true) => {
    set({ dialogOpen: true, openError: null });
    void get().runCheck({ force });
    void getUpdateDownload().then(download => set({ download })).catch(() => {});
  },

  closeDialog: () => set({ dialogOpen: false }),

  dismissBanner: () => set({ bannerDismissed: true }),

  startDownload: async () => {
    set({ openError: null });
    try {
      set({ download: await startUpdateDownload() });
    } catch (error) {
      set({ download: { state: 'error', error: error instanceof Error ? error.message : String(error) } });
      return;
    }
    const poll = async () => {
      polling = null;
      try {
        const download = await getUpdateDownload();
        set({ download });
        if (download.state === 'downloading' || download.state === 'verifying') polling = setTimeout(poll, POLL_MS);
      } catch { /* the server went away: leave the last state */ }
    };
    if (polling) clearTimeout(polling);
    polling = setTimeout(poll, POLL_MS);
  },

  cancelDownload: async () => {
    try { set({ download: await cancelUpdateDownload() }); } catch { /* ignore */ }
  },

  openDownload: async () => {
    set({ openError: null });
    try {
      await openUpdateDownload();
    } catch (error) {
      set({ openError: error instanceof Error ? error.message : String(error) });
    }
  },
}));

export function openUpdateDialog(): boolean {
  if (!updatesAvailableHere()) return false;
  useAppUpdateStore.getState().openDialog(true);
  return true;
}
