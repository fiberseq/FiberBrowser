import { useEffect } from 'react';
import { useBrowserStore } from '../stores/browserStore';
import { runGuidedTour } from '../utils/guidedTour';
import { clearTourRequestFromUrl, isSandboxTab, tourRequestFromUrl } from '../utils/tourTab';

/** Longest wait for the page to have its chromosomes before the tour starts anyway. */
const READY_TIMEOUT_MS = 5000;

/**
 * A tour tab (`?sandbox=<id>&tour=1[&step=<id>]`, from openTourTab) starts the
 * guided tour once the page is up. Only sandbox tabs: a plain `?tour=1` link
 * never starts a tour on the user's own session.
 */
export function useTourTabAutostart(): void {
  useEffect(() => {
    if (!isSandboxTab()) return;
    const request = tourRequestFromUrl();
    if (!request.tour) return;
    let cancelled = false;
    const started = Date.now();
    const start = () => {
      // A reload of the tab after this doesn't start the tour over.
      clearTourRequestFromUrl();
      void runGuidedTour(request.stepId ? { stepId: request.stepId } : {});
    };
    const timer = window.setInterval(() => {
      if (cancelled) return;
      const ready = useBrowserStore.getState().chroms.length > 0;
      if (!ready && Date.now() - started < READY_TIMEOUT_MS) return;
      window.clearInterval(timer);
      start();
    }, 200);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
}
