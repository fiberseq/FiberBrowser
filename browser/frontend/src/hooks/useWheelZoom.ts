import { useCallback, useEffect, useRef } from 'react';
import type { WheelEvent } from 'react';
import { useBrowserStore } from '../stores/browserStore';
import { sameHistoryState, seedHistoryBaseline, serializeState } from '../stores/historySlice';
import { linkGroupPeers } from '../utils/panelNavigation';
import { wheelDelta, wheelLogFactor } from '../utils/wheel';

export const WHEEL_SETTLE_MS = 160;
let burstId = 0;

/** Scale the loaded drawing while a wheel burst accumulates. Navigation (and therefore data loading) happens
 * once after the pause. The callback receives the first pointer position in logical canvas pixels. */
interface Options {
  panelId?: string | null;
  left?: number;
  dataWidth: number;
  onCommitted?: (snapshotId: number | undefined) => void;
}

export function useWheelZoom(key: string, onZoom: (px: number, factor: number) => void,
  { panelId, left = 0, dataWidth, onCommitted }: Options) {
  const latest = useRef({ key, onZoom, onCommitted });
  latest.current = { key, onZoom, onCommitted };
  const pending = useRef<{ key: string; px: number; log: number; timer: ReturnType<typeof setTimeout> | undefined;
    frame: number | null; restore: () => void; paint: (factor: number) => void } | null>(null);
  const cancel = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    if (p.frame != null) cancelAnimationFrame(p.frame);
    p.restore();
    pending.current = null;
  }, []);
  useEffect(() => cancel, [key, cancel]);

  return useCallback((e: WheelEvent<HTMLElement>, px: number) => {
    if (!(e.metaKey || e.ctrlKey)) return false;
    e.preventDefault();
    e.stopPropagation();
    const delta = wheelDelta(e, e.currentTarget.clientHeight || 800);
    if (!delta) return true;
    if (pending.current?.key !== key) cancel();
    if (!pending.current) {
      const source = e.currentTarget;
      const s = useBrowserStore.getState();
      const sourcePanel = s.panels.find(p => p.id === panelId);
      const standalone = sourcePanel?.contentType === 'graph-view';
      const follows = standalone && sourcePanel.graphView?.linkMode === 'follow';
      const panel = follows ? s.panels.find(p => p.id === sourcePanel.graphView?.initiatingPanelId) : sourcePanel;
      const ids = new Set(panel ? linkGroupPeers(s.panels, panel, s.navigationMode) : []);
      if (panelId) ids.add(panelId);
      // Preview the same main-view and site-locked panels that ordinary navigation moves, including graphs
      // following one of those panels. Actual bounds and cross-reference mappings remain navigation's job.
      const main = !(standalone && !follows) && !panel?.viewportOverride;
      for (const peer of s.panels) {
        if ((main && !peer.viewportOverride && peer.contentType === 'dataset')
          || ((main || panel?.siteLocked) && peer.siteLocked)) ids.add(peer.id);
      }
      for (const peer of s.panels) if (peer.graphView?.linkMode === 'follow'
        && (peer.graphView.initiatingPanelId ? ids.has(peer.graphView.initiatingPanelId) : main)) ids.add(peer.id);
      const roots = [...document.querySelectorAll<HTMLElement>('[data-panel-id], [data-graph-panel-id]')]
        .filter(el => ids.has(el.dataset.panelId ?? el.dataset.graphPanelId!));
      const canvases = new Set<HTMLCanvasElement>(roots.flatMap(el => [...el.querySelectorAll('canvas')]));
      if (source instanceof HTMLCanvasElement) canvases.add(source);
      else source.querySelectorAll('canvas').forEach(c => canvases.add(c));
      const fraction = Math.max(0, Math.min(1, (px - left) / Math.max(1, dataWidth)));
      const saved = [...canvases].map(canvas => {
        const gutter = Number(canvas.dataset.wheelGutter) || 0;
        const right = Number(canvas.dataset.wheelRightPad) || 0;
        const canvasWidth = canvas.clientWidth || Number(canvas.getAttribute('width'));
        return { canvas, transform: canvas.style.transform, origin: canvas.style.transformOrigin,
          x: gutter + fraction * Math.max(1, canvasWidth - gutter - right) };
      });
      pending.current = { key, px, log: 0, timer: undefined, frame: null,
        restore: () => saved.forEach(({ canvas, transform, origin }) => { canvas.style.transform = transform; canvas.style.transformOrigin = origin; }),
        paint: factor => saved.forEach(({ canvas, x }) => { canvas.style.transformOrigin = `${x}px 0`; canvas.style.transform = `scaleX(${1 / factor})`; }),
      };
    }
    const p = pending.current;
    p.log = Math.max(-6, Math.min(6, p.log + wheelLogFactor(delta)));
    if (p.frame == null) p.frame = requestAnimationFrame(() => {
      p.frame = null;
      if (pending.current === p) p.paint(Math.exp(p.log));
    });
    clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      if (latest.current.key !== p.key) { cancel(); return; }
      const { px: anchor, log } = p;
      cancel();
      if (!log) return;
      const before = serializeState(useBrowserStore.getState());
      seedHistoryBaseline(useBrowserStore.getState(), 'Before wheel zoom', 'navigation');
      // The burst owns its history step, including paths that normally record panel navigation themselves.
      const paused = useBrowserStore.getState()._historyPaused;
      useBrowserStore.setState({ _historyPaused: true });
      try { latest.current.onZoom(anchor, Math.exp(log)); }
      finally { useBrowserStore.setState({ _historyPaused: paused }); }
      const s = useBrowserStore.getState();
      const after = serializeState(s);
      if (sameHistoryState(before, after)) return;
      // Avoid a duplicate if a navigation adapter recorded the same state.
      const top = s._historyStack[s._historyPointer];
      if (!top || !sameHistoryState(top.state, after)) s.pushSnapshot('Zoom genomic region', {
        kind: 'navigation', coalesceKey: `wheel-navigation:${++burstId}`, coalesceMs: 0, explicit: true,
      });
      const recorded = useBrowserStore.getState();
      latest.current.onCommitted?.(recorded._historyStack[recorded._historyPointer]?.id);
    }, WHEEL_SETTLE_MS);
    return true;
  }, [key, panelId, left, dataWidth, cancel]);
}
