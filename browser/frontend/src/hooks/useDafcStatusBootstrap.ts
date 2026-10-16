import { useEffect } from 'react';
import { getDafcStatus } from '../api/dafc';
import { useBrowserStore } from '../stores/browserStore';
import { useDafcStore } from '../stores/dafcStore';
import type { DAFCStatus } from '../types/dafc';
import { selectMatrixResolution } from '../utils/contactMatrixMath';
import { sameChrom } from '../utils/chromAliases';

export const selectContactResolution = selectMatrixResolution;

export function applyDafcStatusToStores(status: DAFCStatus, pad = 50_000) {
  const dafc = useDafcStore.getState();
  dafc.setDafcLoaded(status.loaded);

  if (!status.loaded) return;

  dafc.setDafcResolutions(status.resolutions);
  if (status.chroms.length === 0) {
    dafc.setDafcResolution(status.current_resolution);
    return;
  }

  const browser = useBrowserStore.getState();
  // Contact files and the browser often disagree on the "chr" prefix (as the
  // loader handles): the map's own name for the browser's chromosome.
  const chromInfo = status.chroms.find(c => c.name === browser.chrom)
    ?? status.chroms.find(c => sameChrom(c.name, browser.chrom));
  if (chromInfo && browser.end > browser.start) {
    const viewStart = Math.max(0, browser.start - pad);
    const viewEnd = Math.min(chromInfo.size, browser.end + pad);
    dafc.setDafcViewport(chromInfo.name, viewStart, viewEnd);
    dafc.setDafcResolution(selectContactResolution(viewEnd - viewStart, status.resolutions));
    return;
  }

  const first = status.chroms[0];
  const defaultEnd = Math.min(first.size, 500_000);
  dafc.setDafcViewport(first.name, 0, defaultEnd);
  dafc.setDafcResolution(selectContactResolution(defaultEnd, status.resolutions));
}

export function useDafcStatusBootstrap(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    getDafcStatus()
      .then(status => {
        if (!cancelled) applyDafcStatusToStores(status);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [enabled]);
}
