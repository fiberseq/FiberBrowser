import { useEffect, useRef, useCallback } from 'react';
import { useBrowserStore } from '../stores/browserStore';
import { useShallow } from 'zustand/react/shallow';
import { getAnnotationsForRegion } from '../api/annotations';
import { logFrontendDiagnostic } from '../utils/diagnostics';
import { annotationViewportKey, type AnnotationViewportOverlays } from '../stores/annotationSlice';
import type { PanelConfig } from '../types';

/**
 * Viewports of dataset panels at their own locus (not the main view), as a
 * stable string so the fetch re-runs only when one of them moves.
 */
export function otherPanelViewportsKey(panels: PanelConfig[], chrom: string, start: number, end: number): string {
  const keys = new Set<string>();
  const main = annotationViewportKey(chrom, start, end);
  for (const p of panels) {
    const v = p.contentType === 'dataset' ? p.viewportOverride : undefined;
    if (!v || v.end <= v.start) continue;
    const key = annotationViewportKey(v.chrom, v.start, v.end);
    if (key !== main) keys.add(JSON.stringify([v.chrom, v.start, v.end]));
  }
  return JSON.stringify([...keys].sort());
}

/**
 * Fetches annotation overlays when any annotation type is enabled and viewport changes.
 * Makes a single request using the first dataset's working set for read-name filtering.
 * Debounced at 500ms to reduce API calls during rapid pan/zoom.
 */
export function useAnnotationFetch() {
  const { chrom, start, end, datasets, analysisSampleSeed, panelViewportsKey } = useBrowserStore(useShallow(s => ({
    chrom: s.chrom,
    start: s.start,
    end: s.end,
    datasets: s.datasets,
    analysisSampleSeed: s.analysisSampleSeed,
    panelViewportsKey: otherPanelViewportsKey(s.panels, s.chrom, s.start, s.end),
  })));

  const {
    annotationFiles,
    enabledAnnotationTypes,
    setAnnotationOverlays,
    setAnnotationViewportOverlays,
    clearAnnotationOverlays,
  } = useBrowserStore(useShallow(s => ({
    annotationFiles: s.annotationFiles,
    enabledAnnotationTypes: s.enabledAnnotationTypes,
    setAnnotationOverlays: s.setAnnotationOverlays,
    setAnnotationViewportOverlays: s.setAnnotationViewportOverlays,
    clearAnnotationOverlays: s.clearAnnotationOverlays,
  })));

  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Check if any annotations are active
  const hasActive = annotationFiles.some(f => f.active) &&
    Object.values(enabledAnnotationTypes).some(v => v);

  const fetchAnnotations = useCallback(async () => {
    if (!hasActive || !chrom || end <= start || datasets.length === 0) {
      // A request still in flight would bring the overlays back.
      abortRef.current?.abort();
      clearAnnotationOverlays();
      return;
    }

    // Abort previous fetch
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const activeFileIds = annotationFiles.filter(f => f.active).map(f => f.id);

    try {
      // Single request: use all dataset IDs so backend builds a combined read name set
      const datasetIds = datasets.map(ds => ds.id);

      // Panels at their own locus get their own overlays: positions are
      // relative to the view they were fetched for.
      const others = (JSON.parse(panelViewportsKey) as string[]).map(v => JSON.parse(v) as [string, number, number]);
      const [result, ...otherResults] = await Promise.all([
        getAnnotationsForRegion(
          chrom, start, end, datasetIds, activeFileIds, analysisSampleSeed,
          { signal: controller.signal },
        ),
        ...others.map(([c, s0, e0]) => getAnnotationsForRegion(
          c, s0, e0, datasetIds, activeFileIds, analysisSampleSeed,
          { signal: controller.signal },
        ).catch(() => null)),
      ]);

      if (controller.signal.aborted) return;

      const byViewport: Record<string, AnnotationViewportOverlays> = {};
      others.forEach(([c, s0, e0], i) => {
        const other = otherResults[i];
        if (other) byViewport[annotationViewportKey(c, s0, e0)] = {
          annotations: other.annotations || {}, byDataset: other.annotations_by_dataset || {},
        };
      });
      setAnnotationViewportOverlays(byViewport);

      const readCount = Object.keys(result.annotations || {}).length;
      const annCount = Object.values(result.annotations || {}).reduce((s, a) => s + a.length, 0);
      if (readCount > 0) {
        logFrontendDiagnostic(`[annotations] ${annCount} annotations for ${readCount} reads, ${(result.types || []).length} types`);
        setAnnotationOverlays(result.annotations, result.annotations_by_dataset, annotationViewportKey(chrom, start, end));
      } else {
        logFrontendDiagnostic('[annotations] no annotations returned');
        // Only the main view's: panels elsewhere keep theirs.
        setAnnotationOverlays({}, {}, annotationViewportKey(chrom, start, end));
      }

      // Update type colors from server response
      if (result.types) {
        const store = useBrowserStore.getState();
        const newColors = { ...store.annotationColors };
        let changed = false;
        for (const t of result.types) {
          if (t.color && !newColors[t.name]) {
            newColors[t.name] = t.color;
            changed = true;
          }
        }
        if (changed) {
          useBrowserStore.setState({ annotationColors: newColors });
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('Failed to fetch annotations:', err);
      }
    }
  }, [hasActive, chrom, start, end, datasets, annotationFiles, enabledAnnotationTypes, analysisSampleSeed, panelViewportsKey, setAnnotationOverlays, setAnnotationViewportOverlays, clearAnnotationOverlays]);

  // Debounced fetch on viewport/type changes
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(fetchAnnotations, 500);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      // Its answer is for the old view/files (e.g. a file just deactivated).
      abortRef.current?.abort();
    };
  }, [fetchAnnotations]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);
}
