import { useEffect, useState, useRef } from 'react';
import { useBrowserStore } from '../stores/browserStore';
import { useDafcStore } from '../stores/dafcStore';
import { getLinkedSession } from '../api/dafc';
import { FRONTEND_DIAGNOSTICS } from '../utils/diagnostics';

const DEBUG = FRONTEND_DIAGNOSTICS;

/**
 * Manages linked DAF-C session polling.
 * Checks URL for session param on mount, then polls for updates at 1s intervals.
 */
export function useDafcPolling() {
  const isRenderMode = typeof window !== 'undefined' && window.__FIBERBROWSER_RENDER_MODE;
  const [linkedSessionId, setLinkedSessionId] = useState<string | null>(null);
  // The version applied last (a ref, so polls never compare against a stale copy).
  const linkedSessionVersionRef = useRef(0);
  const linkedSessionPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Check for linked session in URL params on mount
  useEffect(() => {
    if (isRenderMode) return;
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session');
    if (sessionId) {
      setLinkedSessionId(sessionId);
      if (DEBUG) console.log(`Linked to DAF-C session: ${sessionId}`);
    }
  }, [isRenderMode]);

  // Poll linked session for updates
  useEffect(() => {
    if (isRenderMode) return;
    if (!linkedSessionId) return;

    // One poll at a time, and none applied after cleanup: an older response
    // landing late would roll the linked state back.
    let cancelled = false;
    let inFlight = false;
    const pollSession = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const session = await getLinkedSession(linkedSessionId);
        if (cancelled) return;

        // Check if version changed (new reads sent)
        if (session.version > linkedSessionVersionRef.current) {
          linkedSessionVersionRef.current = session.version;
          const splitViewMode = session.split_view_mode
            ?? (session.contact_mode === 'microc' ? 'region_independent' : 'molecule_linked');
          const isMoleculeLinked = splitViewMode === 'molecule_linked';
          if (DEBUG) {
            console.log(`Linked session updated: ${session.n_reads} reads, mode=${splitViewMode}, contact=${session.contact_mode}`);
            console.log(`  Linked reads: ${session.linked_reads?.length || 0}`);
            console.log(`  X segments: ${session.x_segment_names?.length || 0}`);
            console.log(`  Y segments: ${session.y_segment_names?.length || 0}`);
          }

          // Set split view mode from explicit semantics, with contact_mode as legacy fallback.
          useDafcStore.getState().setSplitViewMode(splitViewMode);
          useDafcStore.getState().setContactMode(session.contact_mode);

          // Store segment names in dafcStore for filtering only when rows are molecule-linked.
          if (isMoleculeLinked && session.x_segment_names && session.y_segment_names) {
            useDafcStore.getState().setLinkedSegments(session.x_segment_names, session.y_segment_names);
          }

          // Store regions and set up viewports
          if (session.regions) {
            const { chrom: regionChrom, x_start, x_end, y_start, y_end } = session.regions;
            const xPadding = Math.floor((x_end - x_start) * 0.2);
            const yPadding = Math.floor((y_end - y_start) * 0.2);

            useDafcStore.getState().setLinkedState(session.regions, session.n_reads, session.version);
            useDafcStore.getState().setXViewport(x_start - xPadding, x_end + xPadding);
            useDafcStore.getState().setYViewport(y_start - yPadding, y_end + yPadding);

            useBrowserStore.getState().setViewMode('linkedSplit');
          }
        }
      } catch (err) {
        console.error('Error polling linked session:', err);
      } finally {
        inFlight = false;
      }
    };

    // Initial poll
    pollSession();

    // Set up polling interval
    linkedSessionPollRef.current = setInterval(pollSession, 1000);

    return () => {
      cancelled = true;
      if (linkedSessionPollRef.current) {
        clearInterval(linkedSessionPollRef.current);
      }
    };
  }, [linkedSessionId, isRenderMode]);
}
