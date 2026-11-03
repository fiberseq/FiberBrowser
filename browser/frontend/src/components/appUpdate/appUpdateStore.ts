/**
 * The update check's state in the page: the last answer, the dialog, the download.
 * Opened by the app menu's "Check for Updates…" (command `check-updates`), the About/Settings button, or the
 * banner the quiet check at startup shows.
 */
import { create } from 'zustand';
import {
  cancelUpdateDownload, checkForUpdates, getUpdateDownload, openUpdateDownload, startUpdateDownload,
  startUpdateInstall, restartUpdateInstall, quitForUpdate,
  type DownloadStatus, type UpdateCheck,
} from '../../api/appUpdate';
import { isSandboxPage } from '../../utils/sandbox';
import { isLabServerPage } from '../../utils/labServer';
import { useBrowserStore } from '../../stores/browserStore';
import { autoSaveNow } from '../../hooks/useAutoSave';
import { markUpdateRestart } from '../../utils/launchSession';

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
  startDownload: (install?: boolean) => Promise<void>;
  finishInstall: () => Promise<void>;
  cancelDownload: () => Promise<void>;
  openDownload: () => Promise<void>;
}

/** Only the owner's own FiberBrowser checks (never a public server, a lab server or a tour tab). */
export function updatesAvailableHere(): boolean {
  return !useBrowserStore.getState().publicMode && !isLabServerPage() && !isSandboxPage();
}

const POLL_MS = 500;
let polling: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;
let finishing = false;

function followProgress(current: number): void {
  if (polling) clearTimeout(polling);
  polling = setTimeout(async () => {
    polling = null;
    if (current !== attempt) return;
    try {
      const download = await getUpdateDownload();
      if (current !== attempt) return;
      useAppUpdateStore.setState({ download });
      if (download.state === 'downloading' || download.state === 'verifying') followProgress(current);
      if (download.state === 'ready') await useAppUpdateStore.getState().finishInstall();
    } catch (error) {
      useAppUpdateStore.setState({ openError: `Could not read update progress: ${error instanceof Error ? error.message : String(error)}` });
    }
  }, POLL_MS);
}

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
    void getUpdateDownload().then(download => {
      set({ download });
      if (download.state === 'downloading' || download.state === 'verifying') followProgress(attempt);
      if (download.state === 'ready') void get().finishInstall();
    }).catch(() => {});
  },

  closeDialog: () => set({ dialogOpen: false }),

  dismissBanner: () => set({ bannerDismissed: true }),

  startDownload: async (install = false) => {
    const current = ++attempt;
    set({ openError: null });
    try {
      set({ download: await (install ? startUpdateInstall() : startUpdateDownload()) });
    } catch (error) {
      set({ openError: error instanceof Error ? error.message : String(error) });
      return;
    }
    followProgress(current);
  },

  cancelDownload: async () => {
    ++attempt;
    if (polling) clearTimeout(polling);
    polling = null;
    try {
      const download = await cancelUpdateDownload();
      set({ download });
      // Verification may be finishing; continue polling until cancellation is acknowledged.
      if (download.state === 'downloading' || download.state === 'verifying') followProgress(attempt);
    } catch (error) { set({ openError: String(error) }); }
  },

  finishInstall: async () => {
    if (finishing || !['ready', 'restarting'].includes(get().download.state)) return;
    finishing = true;
    const current = attempt;
    let handedOff = get().download.state === 'restarting';
    try {
      set({ openError: null });
      if (!handedOff) {
        await autoSaveNow({ required: true });
        if (current !== attempt) return;
        await markUpdateRestart(true);
        if (current !== attempt) { await markUpdateRestart(false); return; }
        // Cancellation ends at handoff; verification is checked again by the backend.
        set({ download: { ...get().download, state: 'restarting' } });
        set({ download: await restartUpdateInstall() });
        handedOff = true;
      }
      const result = await quitForUpdate();
      if (!result.success) throw new Error('The app refused to quit. Quit FiberBrowser to finish the update.');
    } catch (error) {
      if (!handedOff) await markUpdateRestart(false).catch(() => {});
      set({ openError: `Could not restart: ${error instanceof Error ? error.message : String(error)}` });
      try { set({ download: await getUpdateDownload() }); } catch { /* keep the last known state */ }
    } finally { finishing = false; }
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
