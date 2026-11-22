/**
 * The quantification window on a metaprofile: a shaded band over the plot area, in genomic bp (shared by every plot
 * in the set: the store's window). Drag across the plot to make one (`armed`: always on the cluster profiles; with
 * Shift on the main metaprofile track, whose plain drag zooms), drag the band to move it, its edges to resize, × to
 * clear. Pixels map to bp as the charts draw bins (x of bin i = left + i / (n − 1) · width; reversed: right to left).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { logicalOffset } from '../../utils/scaledCoordinates';
import { relText, windowGenomic, type QuantWindow } from './spec';
import { useAxisAnchor } from './AxisControls';
import { genomicToRelative } from './axisFrame';

export interface BandGeometry { left: number; width: number; top: number; height: number }

export function pxToBp(px: number, g: Pick<BandGeometry, 'left' | 'width'>, view: { start: number; end: number }, reversed: boolean): number {
  const t = Math.min(1, Math.max(0, (px - g.left) / Math.max(1, g.width)));
  return Math.round(reversed ? view.end - t * (view.end - view.start) : view.start + t * (view.end - view.start));
}

export function bpToPx(bp: number, g: Pick<BandGeometry, 'left' | 'width'>, view: { start: number; end: number }, reversed: boolean): number {
  const t = (bp - view.start) / Math.max(1, view.end - view.start);
  return g.left + (reversed ? 1 - t : t) * g.width;
}

type Drag = { mode: 'new' | 'move' | 'left' | 'right'; x0: number; from: number; to: number };

export function WindowBand({ geom, view, reversed, armed, testId = 'quant-window-band' }: {
  geom: BandGeometry; view: { chrom: string; start: number; end: number }; reversed: boolean; armed: boolean; testId?: string;
}) {
  const win = useBrowserStore(s => s.windowQuant?.window ?? null);
  const setWindow = useBrowserStore(s => s.setQuantWindow);
  const [draft, setDraftState] = useState<QuantWindow | null>(null);
  const draftRef = useRef<QuantWindow | null>(null);
  const setDraft = (d: QuantWindow | null) => { draftRef.current = d; setDraftState(d); };
  const drag = useRef<Drag | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const { frame, anchor } = useAxisAnchor(view);
  const selecting = useBrowserStore(s => s.quantSelecting);
  const setSelecting = useBrowserStore(s => s.setQuantSelecting);
  const g = windowGenomic(win, view.chrom, anchor);
  const shown = draft ?? (g ? { chrom: view.chrom, from: g[0], to: g[1] } : null);
  /** Store the window: relative to the anchor while the axis is relative (it then means the same when the view moves). */
  const commit = (d: QuantWindow) => {
    if (frame.mode === 'relative' && anchor) { const [from, to] = genomicToRelative(d.from, d.to, anchor); setWindow({ chrom: view.chrom, from, to, relative: true }); }
    else setWindow(d);
    if (selecting) setSelecting(false);
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;

  // CSS px inside the plot, undoing any UI scale (as the tracks' own pointer handlers do: logicalOffset).
  const localX = (clientX: number) => {
    const el = host.current;
    if (!el) return clientX;
    const r = el.getBoundingClientRect();
    return logicalOffset(clientX - r.left, el.clientWidth, r.width);
  };
  const span = (a: number, b: number): QuantWindow | null => {
    const from = Math.max(view.start, Math.min(a, b)), to = Math.min(view.end, Math.max(a, b));
    return to - from >= 1 ? { chrom: view.chrom, from, to } : null;
  };

  const onMove = useCallback((e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const bp = pxToBp(localX(e.clientX), geom, view, reversed);
    const bp0 = pxToBp(d.x0, geom, view, reversed);
    if (d.mode === 'new') setDraft(span(bp0, bp));
    else if (d.mode === 'move') {
      const len = d.to - d.from;
      let from = d.from + (bp - bp0);
      from = Math.max(view.start, Math.min(view.end - len, from));
      setDraft({ chrom: view.chrom, from, to: from + len });
    } else {
      // Edges follow the screen: on a reversed view the left edge is the window's end.
      const edgeIsFrom = (d.mode === 'left') !== reversed;
      setDraft(edgeIsFrom ? span(bp, d.to) : span(d.from, bp));
    }
  }, [geom, view, reversed]);   // eslint-disable-line react-hooks/exhaustive-deps

  const onUp = useCallback(() => {
    drag.current = null;
    const d = draftRef.current;
    setDraft(null);
    if (d) commitRef.current(d);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  }, [onMove, setWindow]);

  useEffect(() => () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); }, [onMove, onUp]);

  const start = (mode: Drag['mode'], e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    drag.current = { mode, x0: localX(e.clientX), from: shown?.from ?? 0, to: shown?.to ?? 0 };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const x0 = shown ? bpToPx(reversed ? shown.to : shown.from, geom, view, reversed) : 0;
  const x1 = shown ? bpToPx(reversed ? shown.from : shown.to, geom, view, reversed) : 0;
  return (
    <div ref={host} className="pointer-events-none absolute inset-0" data-testid={testId} data-window={shown ? `${shown.from}-${shown.to}` : ''}>
      {(armed || selecting) && (
        <div className="pointer-events-auto absolute cursor-crosshair" data-testid={`${testId}-capture`}
          style={{ left: geom.left, width: geom.width, top: geom.top, height: geom.height }}
          title="Drag to set the quantification window"
          onPointerDown={e => start('new', e)} />
      )}
      {shown && x1 > x0 && (
        <div className="pointer-events-auto absolute border-x-2 border-amber-500/80 bg-amber-300/25 dark:bg-amber-400/20" data-testid={`${testId}-shade`}
          style={{ left: x0, width: Math.max(2, x1 - x0), top: geom.top, height: geom.height, cursor: 'grab' }}
          title={`Window ${shown.chrom}:${shown.from.toLocaleString('en-US')}–${shown.to.toLocaleString('en-US')} (${(shown.to - shown.from).toLocaleString('en-US')} bp)${anchor && frame.mode === 'relative' ? `, ${relText(...genomicToRelative(shown.from, shown.to, anchor))} from the ${anchor.name}` : ''}: drag to move, drag an edge to resize`}
          onPointerDown={e => start('move', e)}>
          <div className="absolute inset-y-0 -left-1 w-2 cursor-ew-resize" data-testid={`${testId}-left`} onPointerDown={e => start('left', e)} />
          <div className="absolute inset-y-0 -right-1 w-2 cursor-ew-resize" data-testid={`${testId}-right`} onPointerDown={e => start('right', e)} />
          {!draft && (
            <button type="button" aria-label="Clear the window" data-testid={`${testId}-clear`}
              className="absolute -top-0.5 right-0.5 rounded px-0.5 text-[10px] leading-none text-amber-900 hover:bg-amber-200 dark:text-amber-100 dark:hover:bg-amber-800"
              onPointerDown={e => e.stopPropagation()} onClick={() => setWindow(null)}>×</button>
          )}
        </div>
      )}
    </div>
  );
}
