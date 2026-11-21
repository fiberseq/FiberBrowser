import { useEffect, useState } from 'react';
import { checkSessionFiles, importSession, type SessionFileCheck } from '../../../../api/session';
import { useBrowserStore } from '../../../../stores/browserStore';
import { buildSessionManifest } from '../../../../utils/sessionManifest';
import { setSessionRestoreHandler, type SessionRestoreOutcome } from '../../../../utils/sessionRestore';
import { SessionRelinkDialog } from './SessionRelinkDialog';
import { ensureClusterRefsConnected } from '../../../../utils/connectCluster';
import { previewSessionNote } from '../../../../utils/previewFeatures';

export const CLUSTER_NOT_CONNECTED =
  'Not connected to the cluster, so the session was not restored (what is open now is unchanged). '
  + 'Use Connect to cluster… and restore it again.';

async function restore(session: Record<string, unknown>, pathMapping?: Record<string, string>): Promise<SessionRestoreOutcome> {
  const setError = useBrowserStore.getState().setError;
  try {
    const result = await importSession(session, pathMapping);
    const importResults = result.results as any;
    const failedDatasets = importResults?.datasets_failed?.length ?? 0;
    const failedOverlays = importResults?.overlays_failed?.length ?? 0;
    const failedAnnotations = importResults?.annotations_failed?.length ?? 0;
    // Parts of the session written by plugin packs this build doesn't have (api/sessionPacks.ts): one line.
    const packNote = typeof result.pack_note === 'string' ? result.pack_note : '';
    if (failedDatasets || failedOverlays || failedAnnotations || importResults?.fasta_error || importResults?.contact_map_error || packNote) {
      setError([
        failedDatasets ? `${failedDatasets} dataset${failedDatasets === 1 ? '' : 's'} failed` : '',
        // Live lift turned off on this server: say how to open them (services/lift/registration.py).
        ...((importResults?.datasets_failed ?? []) as Array<{ error?: string }>)
          .map(f => f.error ?? '').filter(e => e.includes('FIBERBROWSER_LIVE_LIFT')).slice(0, 1),
        failedOverlays ? `${failedOverlays} overlay${failedOverlays === 1 ? '' : 's'} failed` : '',
        failedAnnotations ? `${failedAnnotations} annotation file${failedAnnotations === 1 ? '' : 's'} failed` : '',
        importResults?.fasta_error ? `FASTA: ${importResults.fasta_error}` : '',
        importResults?.contact_map_error ? `Contact map: ${importResults.contact_map_error}` : '',
        packNote,
      ].filter(Boolean).join('; '));
    }
    const warnings = buildSessionManifest(useBrowserStore.getState()).warnings;
    // Preview features the session uses while previews are off: kept, and said in one line (utils/previewFeatures).
    const previewNote = previewSessionNote(useBrowserStore.getState() as never);
    const notes = [packNote, previewNote].filter(Boolean).join(' ');
    // TODO: report read loading through completion; tracks keep loading locally in useReadTrackData, not the browser loading flag.
    return {
      restored: true,
      message: notes ? `Session restored. ${notes}` : warnings.length === 0
        ? 'Session restored.'
        : `Session restored with ${warnings.length} warning${warnings.length === 1 ? '' : 's'} (see Save session in the sidebar).`,
    };
  } catch (error: any) {
    setError(error?.message || 'Failed to restore session');
    return { restored: false };
  }
}

/** Mounted once: restores sessions requested anywhere, via the relink dialog when files moved. */
export function SessionRestoreHost() {
  const [pending, setPending] = useState<{
    session: Record<string, unknown>;
    check: SessionFileCheck;
    resolve: (outcome: SessionRestoreOutcome) => void;
  } | null>(null);

  useEffect(() => {
    setSessionRestoreHandler(async session => {
      // Check the session's files before touching current state, so a session
      // saved on another computer can be relinked instead of half-restoring.
      let check: SessionFileCheck | null = null;
      try {
        check = await checkSessionFiles(session);
      } catch {
        check = null;
      }
      // Files on a cluster: connect to their host first (the dialog opens
      // prefilled with the host and folders). Closing the dialog cancels the
      // restore and keeps what is open now, like opening from the Library.
      if (check?.remote && check.remote.disconnected > 0) {
        const connected = await ensureClusterRefsConnected(check.remote.refs.map(r => r.ref), 'This session');
        if (!connected) {
          return { restored: false, message: CLUSTER_NOT_CONNECTED };
        }
      }
      if (check && (check.missing > 0 || check.changed > 0)) {
        // A newer restore supersedes one still waiting in the relink dialog: the older one is settled (not restored),
        // never left pending (its count would block other work for good).
        return new Promise<SessionRestoreOutcome>(resolve => setPending(prev => {
          prev?.resolve({ restored: false });
          return { session, check: check!, resolve };
        }));
      }
      return restore(session);
    });
    return () => setSessionRestoreHandler(null);
  }, []);

  if (!pending) return null;
  return (
    <SessionRelinkDialog
      session={pending.session}
      initialCheck={pending.check}
      onCancel={() => {
        pending.resolve({ restored: false });
        setPending(null);
      }}
      onRestore={mapping => {
        const { session, resolve } = pending;
        setPending(null);
        void restore(session, mapping).then(resolve);
      }}
    />
  );
}
