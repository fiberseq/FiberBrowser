import { useEffect } from 'react';
import { useAccessibilityStore } from './accessibilityStore';
import { sameFeature, useFeatureStore } from '../../stores/featureStore';
import { nfrRef, variantRef } from './NfrFeatureTrack';

/**
 * The two-way hover between the NFR channel over the reads (stores/featureStore `hovered`, feat/fb-n11-features)
 * and the Accessibility (preview) panel (stores/accessibilityStore `hoveredElement`, feat/fb-n11-nfrux):
 * hovering a variant or NFR in either brings it forward in the other. Mounted once, next to useNfrRuns.
 */
export function useNfrFeatureBridge(): void {
  useEffect(() => {
    // channel -> panel
    const a = useFeatureStore.subscribe((s, prev) => {
      if (s.hovered === prev.hovered) return;
      const h = s.hovered;
      const job = useAccessibilityStore.getState().jobId;
      const id = h && h.source === job && (h.kind === 'nfr-variant' || h.kind === 'nfr') ? h.id : null;
      if (useAccessibilityStore.getState().hoveredElement !== id) useAccessibilityStore.getState().setHoveredElement(id);
    });
    // panel -> channel
    const b = useAccessibilityStore.subscribe((s, prev) => {
      if (s.hoveredElement === prev.hoveredElement && s.result === prev.result && s.jobId === prev.jobId) return;
      if (s.jobId !== prev.jobId) {
        // Another run (or none): the previous run's hover goes, in both stores; it never carries over by id.
        const cur = useFeatureStore.getState().hovered;
        if (cur && prev.jobId && cur.source === prev.jobId && (cur.kind === 'nfr-variant' || cur.kind === 'nfr')) useFeatureStore.getState().setHover(null);
        if (s.hoveredElement !== null) { s.setHoveredElement(null); return; }
        return;
      }
      const id = s.hoveredElement;
      const run = s.result && s.jobId ? { jobId: s.jobId, result: s.result } : null;
      const cur = useFeatureStore.getState().hovered;
      if (!id || !run) {
        if (cur && cur.source === s.jobId && (cur.kind === 'nfr-variant' || cur.kind === 'nfr')) useFeatureStore.getState().setHover(null);
        return;
      }
      const n = run.result.nfrs.find(x => x.id === id.split(':')[0]);
      const v = n?.variants.find(x => x.id === id);
      const ref = v ? variantRef(run, v) : n && !id.includes(':') ? nfrRef(run, n) : null;
      if (ref && !sameFeature(ref, cur)) useFeatureStore.getState().setHover(ref);
    });
    return () => { a(); b(); };
  }, []);
}
