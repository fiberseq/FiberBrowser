/**
 * The update check in the window: the quiet check at startup (once per page; nothing when it is turned off in
 * Settings), its one-line banner, and the update dialog (version, notes, download with sha256 check, open the
 * installer). The app never replaces itself: the person runs the DMG or the installer.
 */
import { useEffect } from 'react';
import type { UpdateCheck } from '../../api/appUpdate';
import { AlertTriangle, Download, ExternalLink, X } from '../ui/Icons';
import { updatesAvailableHere, useAppUpdateStore } from './appUpdateStore';

function formatBytes(n: number | null | undefined): string {
  if (!n) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} kB`;
}

/** The one line a check's answer is summed up in. */
export function updateSummary(check: UpdateCheck | null): string {
  if (!check) return '';
  switch (check.status) {
    case 'update_available':
      return `FiberBrowser ${check.latest}${check.latest === check.current && check.latest_build ? ` (build ${check.latest_build})` : ''} is available (you have ${check.current}).`;
    case 'up_to_date':
      return `FiberBrowser ${check.current} is up to date (${check.channel} channel).`;
    default:
      return check.message || 'The update check could not answer.';
  }
}

const BANNER_STATUSES = new Set(['update_available', 'auth_required', 'auth_invalid']);

export function AppUpdateBanner() {
  const { check, bannerDismissed, dialogOpen, openDialog, dismissBanner } = useAppUpdateStore();
  if (!check || bannerDismissed || dialogOpen || !BANNER_STATUSES.has(check.status)) return null;
  const update = check.status === 'update_available';
  return (
    <div
      role="status"
      data-testid="app-update-banner"
      className="fixed bottom-3 right-3 z-[90] flex max-w-sm items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-[12px] text-gray-700 shadow-lg dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
    >
      {update ? <Download size={14} /> : <AlertTriangle size={14} />}
      <span className="min-w-0 flex-1">{update ? updateSummary(check) : check.message}</span>
      <button type="button" className="fb-btn-secondary px-2 py-0.5 text-[11px]" onClick={() => openDialog(false)}>
        {update ? 'View' : 'Settings'}
      </button>
      <button type="button" className="fb-icon-btn h-5 w-5" aria-label="Dismiss" onClick={dismissBanner}>
        <X size={12} />
      </button>
    </div>
  );
}

export function AppUpdateDialog() {
  const {
    dialogOpen, closeDialog, check, checking, error, runCheck, download, startDownload, cancelDownload,
    openDownload, openError,
  } = useAppUpdateStore();
  useEffect(() => {
    if (!dialogOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeDialog(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialogOpen, closeDialog]);
  if (!dialogOpen) return null;
  const file = check?.download;
  // A download of another file (an earlier offer) is not this one: offer this one afresh.
  const thisFile = !!file && download.name === file.name && (!download.sha256 || download.sha256 === file.sha256);
  const state = download.state === 'idle' || thisFile ? download.state : 'idle';
  const busy = state === 'downloading' || state === 'verifying';
  const progress = download.total ? Math.min(100, Math.round(((download.received ?? 0) / download.total) * 100)) : null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={closeDialog}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-update-title"
        data-testid="app-update-dialog"
        onClick={e => e.stopPropagation()}
        className="relative mx-4 w-full max-w-md rounded-lg bg-white shadow-xl dark:bg-gray-800"
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-white/10">
          <h2 id="app-update-title" className="text-sm font-semibold text-gray-700 dark:text-gray-200">Software update</h2>
          <button type="button" className="fb-icon-btn h-6 w-6" aria-label="Close software update" onClick={closeDialog}>
            <X size={14} />
          </button>
        </div>
        <div className="space-y-3 px-4 py-3 text-[13px] text-gray-700 dark:text-gray-300">
          {checking && !check && <p>Checking for updates…</p>}
          {error && <p className="text-rose-700 dark:text-rose-400">Couldn't check: {error}</p>}
          {check && (
            <>
              <p data-testid="app-update-summary" className={check.status === 'update_available' ? 'font-medium' : ''}>
                {updateSummary(check)}
              </p>
              {check.status === 'update_available' && (
                <>
                  {check.notes && (
                    <p className="whitespace-pre-wrap rounded bg-gray-50 px-2 py-1.5 text-[12px] dark:bg-white/5">{check.notes}</p>
                  )}
                  {check.notes_url && (
                    <a href={check.notes_url} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[12px] text-teal-700 hover:underline dark:text-teal-400">
                      Release notes <ExternalLink size={11} />
                    </a>
                  )}
                  {check.message && <p className="text-[12px] text-gray-500 dark:text-gray-400">{check.message}</p>}
                  {check.pip_command && (
                    <code className="block select-all rounded bg-gray-100 px-2 py-1 font-mono text-[11px] dark:bg-white/10">{check.pip_command}</code>
                  )}
                  {file && (
                    <div className="space-y-1.5">
                      <div className="text-[12px] text-gray-500 dark:text-gray-400">
                        {file.name}{file.size ? ` · ${formatBytes(file.size)}` : ''} · checked against its sha256 before it opens
                      </div>
                      {state === 'idle' || state === 'error' || state === 'cancelled' ? (
                        <button type="button" className="fb-btn-primary inline-flex items-center gap-1.5 px-3 py-1 text-[12px]"
                          onClick={() => void startDownload()} data-testid="app-update-download">
                          <Download size={13} /> Download {check.latest}
                        </button>
                      ) : null}
                      {busy && (
                        <div className="flex items-center gap-2 text-[12px]">
                          <span>{state === 'verifying' ? 'Checking sha256…' : `Downloading… ${progress !== null ? `${progress}%` : formatBytes(download.received)}`}</span>
                          <button type="button" className="fb-btn-secondary px-2 py-0.5 text-[11px]" onClick={() => void cancelDownload()}>Cancel</button>
                        </div>
                      )}
                      {state === 'done' && (
                        <div className="space-y-1">
                          <div className="text-[12px] text-emerald-700 dark:text-emerald-400">Downloaded and verified: {download.path}</div>
                          <button type="button" className="fb-btn-primary px-3 py-1 text-[12px]" onClick={() => void openDownload()}
                            data-testid="app-update-open">
                            {file.kind === 'installer' ? 'Run the installer' : file.kind === 'dmg' ? 'Open the disk image' : 'Open it'}
                          </button>
                          <div className="text-[11px] text-gray-500 dark:text-gray-400">
                            Quit FiberBrowser, then {file.kind === 'dmg' ? 'drag the new FiberBrowser to Applications' : 'finish the installer'}. Your settings, sessions and Library stay.
                          </div>
                        </div>
                      )}
                      {(state === 'error' || state === 'cancelled') && download.error && (
                        <div className="text-[12px] text-rose-700 dark:text-rose-400">{download.error}</div>
                      )}
                      {openError && <div className="text-[12px] text-rose-700 dark:text-rose-400">{openError}</div>}
                    </div>
                  )}
                </>
              )}
              <p className="text-[11px] text-gray-400 dark:text-gray-500">
                Channel: {check.channel} · {check.where}{check.token_source ? ` · signed in with ${check.token_source}` : ''}
              </p>
            </>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="fb-btn-secondary px-3 py-1 text-[12px]" disabled={checking}
              onClick={() => void runCheck({ force: true })}>
              {checking ? 'Checking…' : 'Check again'}
            </button>
            <button type="button" className="fb-btn-secondary px-3 py-1 text-[12px]" onClick={closeDialog}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Mounted once in the window (plugins/browserHosts.tsx, registered from core in main.tsx). */
let startupCheckDone = false;

/** The quiet check at startup waits for the page to settle. */
export const STARTUP_CHECK_DELAY_MS = 4000;

export function AppUpdateHost() {
  const runCheck = useAppUpdateStore(s => s.runCheck);
  useEffect(() => {
    if (startupCheckDone || !updatesAvailableHere()) return;
    // Once per page; the backend fetches nothing when the check at startup is turned off.
    const timer = setTimeout(() => {
      startupCheckDone = true;
      void runCheck({ startup: true });
    }, STARTUP_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [runCheck]);
  return (
    <>
      <AppUpdateBanner />
      <AppUpdateDialog />
    </>
  );
}

/** Tests: let the startup check run again. */
export function resetStartupCheckForTests(): void {
  startupCheckDone = false;
}
