import { useEffect, useCallback, useState, useRef } from 'react';
import { useBrowserStore } from '../stores/browserStore';
import { FRONTEND_DIAGNOSTICS } from '../utils/diagnostics';

const DEBUG = FRONTEND_DIAGNOSTICS;

/**
 * Syncs viewport position to/from URL query parameters.
 * - On mount: reads ?chr=&start=&end= from URL and sets viewport
 * - On viewport change: updates URL via replaceState
 * - Provides handleCopyLink to copy shareable URL
 */
/** The page's query parameters with the given view in them. */
function viewportUrlParams(chrom: string, start: number, end: number): URLSearchParams {
  const params = new URLSearchParams(window.location.search);
  params.set('chr', chrom);
  params.set('start', start.toString());
  params.set('end', end.toString());
  return params;
}

function writeViewportToUrl(chrom: string, start: number, end: number): void {
  window.history.replaceState(null, '', `${window.location.pathname}?${viewportUrlParams(chrom, start, end).toString()}`);
}

export function useUrlSync() {
  const chrom = useBrowserStore(s => s.chrom);
  const start = useBrowserStore(s => s.start);
  const end = useBrowserStore(s => s.end);

  const initialPositionSet = useRef(false);
  const urlSyncEnabled = useRef(true);
  const suppressViewportSnapshotKey = useRef<string | null>(null);

  const [linkCopied, setLinkCopied] = useState(false);

  // Parse URL params on mount for coordinate sharing
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlChrom = params.get('chr');
    const urlStart = params.get('start');
    const urlEnd = params.get('end');

    if (urlChrom && urlStart && urlEnd) {
      const startNum = parseInt(urlStart, 10);
      const endNum = parseInt(urlEnd, 10);
      if (!isNaN(startNum) && !isNaN(endNum) && endNum > startNum) {
        // Disable URL sync temporarily to avoid immediate overwrite
        urlSyncEnabled.current = false;
        initialPositionSet.current = true;  // Prevent server initial position from overriding
        const targetKey = `${urlChrom}:${startNum}-${endNum}`;
        const current = useBrowserStore.getState();
        suppressViewportSnapshotKey.current = `${current.chrom}:${current.start}-${current.end}` === targetKey ? null : targetKey;
        useBrowserStore.getState().setViewport(urlChrom, startNum, endNum);
        if (DEBUG) console.log(`Loaded position from URL: ${urlChrom}:${startNum}-${endNum}`);
        // Re-enable URL sync after a short delay
        setTimeout(() => {
          urlSyncEnabled.current = true;
          // A move made meanwhile was skipped: write where the view is now.
          const now = useBrowserStore.getState();
          writeViewportToUrl(now.chrom, now.start, now.end);
        }, 500);
      }
    }
  }, []);

  // Sync viewport to URL (without reload) using replaceState
  useEffect(() => {
    if (!urlSyncEnabled.current) return;
    writeViewportToUrl(chrom, start, end);
  }, [chrom, start, end]);

  // Copy current URL to clipboard (with shared=1 so recipient doesn't trigger shutdown)
  const handleCopyLink = useCallback(() => {
    // The view as it is now, not as the address bar last recorded it.
    const now = useBrowserStore.getState();
    const params = viewportUrlParams(now.chrom, now.start, now.end);
    params.set('shared', '1');
    // A tour tab's link is to the place, not to its sandbox.
    for (const key of ['sandbox', 'tour', 'step']) params.delete(key);
    const url = `${window.location.origin}${window.location.pathname}?${params.toString()}`;
    const copied = () => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    };
    const fallback = () => {
      // Select and copy (plain-HTTP pages off localhost have no Clipboard API).
      const input = document.createElement('input');
      input.value = url;
      document.body.appendChild(input);
      input.select();
      try { document.execCommand('copy'); } catch { /* nothing more to try */ }
      document.body.removeChild(input);
      copied();
    };
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clipboard?.writeText) {
      fallback();
      return;
    }
    clipboard.writeText(url).then(copied).catch(fallback);
  }, []);

  return { handleCopyLink, linkCopied, initialPositionSet, suppressViewportSnapshotKey };
}
