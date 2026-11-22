/**
 * The quantification window on a metaprofile row (the default metaprofile composite row and the legacy MetaTrack):
 *
 * - top right: the x-axis chip (Genome, or the anchor: a popover with the gene picker) and the Select window toggle;
 * - while selecting: the cursor is a crosshair over the plot, a hint says what to do, a drag sets the window and never
 *   zooms or pans; Esc or the toggle leaves (Shift + drag is a shortcut any time; a plain drag still zooms);
 * - once a window is set here: the band with its handles, and a small bar with the typed start / end, Clear and
 *   Quantify window;
 * - on a relative axis: the tick strip.
 * Hidden while a figure or panel is exported.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useBrowserStore } from '../../stores/browserStore';
import { WindowBand } from './WindowBand';
import { AxisFrameControl, AxisStrip, SELECT_HINT, SelectWindowButton, useAxisAnchor } from './AxisControls';
import { WindowFields } from './QuantifyCard';
import { windowGenomic } from './spec';

export function TrackWindowOverlay({ width, height, sidebarWidth, view, reversed }: {
  width: number; height: number; sidebarWidth: number; view: { chrom: string; start: number; end: number }; reversed: boolean;
}) {
  const [shiftDown, setShiftDown] = useState(false);
  useEffect(() => {
    const on = (e: KeyboardEvent) => setShiftDown(e.shiftKey);
    const blur = () => setShiftDown(false);
    window.addEventListener('keydown', on); window.addEventListener('keyup', on); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', on); window.removeEventListener('keyup', on); window.removeEventListener('blur', blur); };
  }, []);
  const win = useBrowserStore(s => s.windowQuant?.window ?? null);
  const openIn = useBrowserStore(s => s.windowQuant?.openIn ?? null);
  const setOpen = useBrowserStore(s => s.setQuantOpen);
  const selecting = useBrowserStore(s => !!s.quantSelecting);
  const exporting = useBrowserStore(s => s.exportInProgress);
  const { frame, anchor } = useAxisAnchor(view);
  const [axisOpen, setAxisOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!axisOpen) return;
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') setAxisOpen(false); };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [axisOpen]);
  if (exporting || !setOpen) return null;
  const here = !!windowGenomic(win, view.chrom, anchor);
  const plotW = Math.max(1, width - sidebarWidth);
  const axisWord = frame.mode === 'relative' ? (anchor ? `x: ${anchor.name}` : 'x: relative (no anchor)') : 'x: genome';
  return (
    <>
      <WindowBand geom={{ left: sidebarWidth, width: plotW, top: 0, height }} view={view} reversed={reversed} armed={shiftDown || selecting} testId="quant-track-band" />
      {frame.mode === 'relative' && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 opacity-80"><AxisStrip left={sidebarWidth} width={plotW} view={view} reversed={reversed} anchor={anchor} testId="quant-track-axis" compact /></div>
      )}
      {selecting && (
        <div className="pointer-events-none absolute left-1/2 top-1 z-10 -translate-x-1/2 rounded bg-amber-100/95 px-2 py-0.5 text-[10px] font-medium text-amber-950 shadow-sm dark:bg-amber-900/90 dark:text-amber-50"
          data-testid="quant-track-select-hint">{SELECT_HINT}</div>
      )}
      <div className="absolute right-7 top-0.5 z-20 flex items-center gap-1" data-testid="quant-track-tools" onMouseDown={e => e.stopPropagation()}>
        <span className="relative">
          <button type="button" ref={chipRef} data-testid="quant-track-axis-chip" aria-expanded={axisOpen}
            className="rounded border border-gray-300 bg-white/90 px-1 text-[10px] text-gray-700 hover:bg-cyan-50 dark:border-gray-600 dark:bg-gray-900/80 dark:text-gray-200"
            title="The metaprofiles' x-axis: genome coordinates, or the distance from a gene's start or end, the view centre or a position"
            onClick={() => setAxisOpen(o => !o)}>{axisWord} ▾</button>
          {axisOpen && chipRef.current && createPortal(
            // On the page, not in the row: the row clips what overflows it.
            <div className="fixed z-[1000] w-[440px] rounded-md border border-gray-200 bg-white p-2 shadow-lg dark:border-gray-700 dark:bg-gray-900" data-testid="quant-track-axis-popover"
              style={popoverPos(chipRef.current)} onMouseDown={e => e.stopPropagation()}>
              <AxisFrameControl view={view} testId="quant-track-axis-frame" />
              <div className="mt-1 flex justify-end"><button type="button" className="text-[10px] underline" onClick={() => setAxisOpen(false)}>Done</button></div>
            </div>, document.body)}
        </span>
        <SelectWindowButton testId="quant-track-select" compact />
      </div>
      {here && openIn !== 'track' && !selecting && (
        <div className="absolute left-1 top-0.5 z-20 flex items-center gap-1 rounded bg-white/90 px-1 shadow-sm dark:bg-gray-900/85" style={{ left: sidebarWidth + 4 }}
          data-testid="quant-track-window-bar" onMouseDown={e => e.stopPropagation()}>
          <WindowFields view={view} compact testId="quant-track-window-fields" />
          <button type="button" data-testid="quant-track-open" className="rounded border border-amber-400 bg-amber-50 px-1 text-[10px] font-medium text-amber-900 hover:bg-amber-100 dark:bg-amber-950/70 dark:text-amber-100"
            title="Quantify each layer in the window per dataset or cluster, with intervals" onClick={() => setOpen('track')}>Quantify window</button>
        </div>
      )}
    </>
  );
}

/** Under the chip, right-aligned to it, kept on screen. */
function popoverPos(el: HTMLElement): { top: number; left: number } {
  const r = el.getBoundingClientRect();
  const w = 440;
  return { top: Math.round(r.bottom + 4), left: Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))) };
}
