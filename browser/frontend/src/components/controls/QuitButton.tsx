import { useEffect, useRef, useState } from 'react';
import { autoSaveNow } from '../../hooks/useAutoSave';
import { createPortal } from 'react-dom';
import { downloadSession } from '../../api/session';
import { fetchApiResponse } from '../../api/sharedFetch';
import { useBrowserStore } from '../../stores/browserStore';
import { Power } from '../ui/Icons';
import { isLabServerPage } from '../../utils/labServer';

type Phase = 'idle' | 'confirm' | 'saving' | 'stopping' | 'stopped' | 'error';

/** Quit is offered on a local server only (not in public mode or on a shared lab server). */
export function useQuitAvailable(): boolean {
  const publicMode = useBrowserStore(s => s.publicMode);
  return !publicMode && !isLabServerPage();
}

/**
 * Stop the FiberBrowser server from the page (closing the last tab also does).
 * With `requestOpen` it has no button of its own: the toolbar's More menu opens
 * the confirmation by bumping the number, and it anchors under the menu button.
 */
export function QuitButton({ requestOpen }: { requestOpen?: number } = {}) {
  const publicMode = useBrowserStore(s => s.publicMode);
  const sessionName = useBrowserStore(s => s.sessionName);
  const hasDatasets = useBrowserStore(s => s.datasets.length > 0);
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  // Bumped by Cancel: a save that finishes afterwards must not quit.
  const attemptRef = useRef(0);

  useEffect(() => {
    if (phase !== 'confirm' && phase !== 'error') return;
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setPhase('idle');
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setPhase('idle'); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [phase]);

  useEffect(() => {
    if (requestOpen) setPhase(current => (current === 'saving' || current === 'stopping' ? current : 'confirm'));
  }, [requestOpen]);

  // A lab server keeps running for everyone else.
  if (publicMode || isLabServerPage()) return null;

  const cancel = () => {
    attemptRef.current += 1;
    setPhase('idle');
  };

  const quit = async (save: boolean) => {
    const attempt = ++attemptRef.current;
    try {
      if (save) {
        setPhase('saving');
        await downloadSession(sessionName);
        if (attempt !== attemptRef.current) return; // cancelled while saving
      }
      setPhase('stopping');
      // The next launch offers this session back as it is now (CrashRecoveryBanner).
      await autoSaveNow().catch(() => undefined);
      const response = await fetchApiResponse('/api/quit', { method: 'POST' });
      if (!response.ok) throw new Error(`The server refused to stop (${response.status})`);
      setPhase('stopped');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not stop the server');
      setPhase('error');
    }
  };

  return (
    <div ref={rootRef} className={requestOpen === undefined ? 'relative' : 'absolute right-0 top-full'}>
      {requestOpen === undefined && <button
        type="button"
        onClick={() => {
          if (phase === 'saving' || phase === 'stopping') return;
          if (phase === 'confirm' || phase === 'error') cancel();
          else setPhase('confirm');
        }}
        className="fb-icon-btn hover:!text-red-600 dark:hover:!text-red-400"
        title="Quit FiberBrowser (stop the server)"
        aria-label="Quit FiberBrowser"
        aria-expanded={phase === 'confirm'}
        data-testid="quit-button"
      >
        <Power size={15} />
      </button>}
      {(phase === 'confirm' || phase === 'saving' || phase === 'error') && (
        <div
          role="dialog"
          aria-label="Quit FiberBrowser"
          className={`absolute right-0 ${requestOpen === undefined ? 'top-full' : 'top-0'} z-50 mt-1 w-64 rounded-lg border border-gray-200 bg-white p-3 text-[13px] shadow-lg dark:border-white/10 dark:bg-gray-800`}
          data-testid="quit-confirm"
        >
          <div className="font-medium text-gray-800 dark:text-gray-100">Quit FiberBrowser?</div>
          <p className="mt-1 text-[12px] text-gray-500 dark:text-gray-400">
            Stops the server for every open tab. Unsaved analysis can be restored next time you open it.
          </p>
          {phase === 'error' && <p className="mt-1 text-[12px] text-red-600 dark:text-red-400">{message}</p>}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {hasDatasets && (
              <button type="button" disabled={phase === 'saving'} onClick={() => void quit(true)}
                className="fb-btn-primary"
                data-testid="quit-save">
                {phase === 'saving' ? 'Saving…' : 'Save session & quit'}
              </button>
            )}
            <button type="button" disabled={phase === 'saving'} onClick={() => void quit(false)}
              className="rounded bg-red-600 px-2 py-1 text-[12px] font-medium text-white hover:bg-red-700 disabled:opacity-50"
              data-testid="quit-now">
              Quit
            </button>
            <button type="button" onClick={cancel}
              className="rounded px-2 py-1 text-[12px] text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10">
              Cancel
            </button>
          </div>
        </div>
      )}
      {(phase === 'stopping' || phase === 'stopped') && createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-white/95 dark:bg-gray-900/95" data-testid="quit-stopped">
          <div className="text-center">
            <div className="text-lg font-semibold text-gray-800 dark:text-gray-100">
              {phase === 'stopping' ? 'Stopping FiberBrowser…' : 'FiberBrowser has stopped'}
            </div>
            {phase === 'stopped' && (
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">You can close this tab. Run <code>python browser.py</code> again to reopen.</p>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
