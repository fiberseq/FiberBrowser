import { useCallback, useEffect, useRef } from 'react';
import type { WheelEvent } from 'react';
import { useBrowserStore } from '../stores/browserStore';
import { nextReadRowHeight } from '../components/tracks/read-track/layout';
import { wheelDelta } from '../utils/wheel';

/** One shared numeric height, including graph bands. Batch redraws to an animation frame. */
export function useReadRowWheel(autoFitHeight: number) {
  const pending = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  useEffect(() => () => { if (frame.current != null) cancelAnimationFrame(frame.current); }, []);
  return useCallback((e: WheelEvent<HTMLElement>) => {
    if (!e.shiftKey || e.ctrlKey || e.metaKey) return false;
    e.preventDefault();
    e.stopPropagation();
    const delta = wheelDelta(e, e.currentTarget.clientHeight || 800);
    if (!delta) return true;
    const s = useBrowserStore.getState();
    pending.current = nextReadRowHeight(pending.current ?? (s.fillReadHeight ? autoFitHeight : s.readRowHeight), autoFitHeight, delta);
    if (frame.current == null) frame.current = requestAnimationFrame(() => {
      const height = pending.current!;
      pending.current = null;
      frame.current = null;
      useBrowserStore.setState(s => ({ readRowHeight: height, fillReadHeight: false, readScrollOffsets: {},
        panels: s.panels.map(p => p.graphView ? { ...p, graphView: { ...p.graphView,
          reads: { ...(p.graphView.reads ?? { show: true, datasets: null }), rowHeight: height } } } : p),
      }));
    });
    return true;
  }, [autoFitHeight]);
}
