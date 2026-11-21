/**
 * The mini read strip under the Plots header (mock "1 · Main"): a few rows of molecules of the first dataset over
 * three times the view, downsampled, each drawn as its footprints (nucleosome-green) and the accessible gaps between
 * them (MSP orange), with the view as a box. Drag the reads to pan, drag the box to move it, drag either edge of the box
 * to zoom (the other edge stays), click to jump there (the view keeps its width). The view moves once, on release
 * (Follow plots then wait their delay). Moves the shared locus, so the browser and every Follow plot go with it.
 *
 * Reads come from /api/reads/compact (a display sample: `max_reads`), fetched straight, not through the read
 * track's region cache, so the strip never changes what the read panels hold. Intervals are [start, end, signed
 * length] relative to the requested start: a positive length is a footprint, a negative one an accessible gap.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { fetchJson } from '../../api/sharedFetch';
import { findChromInfo } from '../../utils/chromAliases';
import { getLayerColor } from '../../utils/layerColors';
import { useLayerColorVersion } from '../layerColours/state';
import { formatLocus } from './plotModel';
import { GeneTrack } from '../../components/tracks/GeneTrack';
import { getStatus } from '../../api/status';

/** Height of the gene line under the strip (only when a GTF / annotation is loaded). */
export const STRIP_GENES_HEIGHT = 26;

/** Whether the server has gene annotation (a GTF), asked again when the data refreshes. */
function useHasGenes(): boolean {
  const refresh = useBrowserStore(s => s.refreshGeneration);
  const [has, setHas] = useState(false);
  useEffect(() => {
    let live = true;
    getStatus(false).then(r => { if (live) setHas(Boolean((r as { has_gtf?: boolean }).has_gtf)); }).catch(() => { if (live) setHas(false); });
    return () => { live = false; };
  }, [refresh]);
  return has;
}

/** Reads asked for (a display sample) and rows drawn. */
export const STRIP_MAX_READS = 60;
export const STRIP_ROWS = 8;
const ROW_H = 4;
const ROW_GAP = 1;
/** A press that moves less than this is a click (px). */
const CLICK_SLOP = 3;
/** The narrowest and widest view the box's edges can make (bp). */
export const STRIP_MIN_WIDTH = 50;
export const STRIP_MAX_WIDTH = 5_000_000;

export type StripDragMode = 'pan' | 'move' | 'left' | 'right';

/**
 * The view after a strip drag of `dxBp` (bp; the pointer's move in genome units). pan: the reads follow the pointer
 * (the view moves the other way); move: the box follows it; left / right: that edge follows it, the other stays,
 * the width kept between `min` and `max` and the view inside the chromosome.
 */
export function stripDragResult(mode: StripDragMode, start: number, end: number, dxBp: number,
  o: { min?: number; max?: number; chromSize?: number } = {}): { start: number; end: number } {
  const min = o.min ?? STRIP_MIN_WIDTH;
  const size = o.chromSize ?? Number.POSITIVE_INFINITY;
  const max = Math.min(o.max ?? STRIP_MAX_WIDTH, size);
  const w = end - start;
  if (mode === 'pan' || mode === 'move') {
    let s = Math.round(start + (mode === 'pan' ? -dxBp : dxBp));
    s = Math.max(0, Number.isFinite(size) ? Math.min(s, size - w) : s);
    return { start: s, end: s + w };
  }
  if (mode === 'left') {
    let s = Math.round(start + dxBp);
    s = Math.min(s, end - min);
    s = Math.max(s, end - max, 0);
    return { start: s, end };
  }
  let e = Math.round(end + dxBp);
  e = Math.max(e, start + min);
  e = Math.min(e, start + max, size);
  return { start, end: e };
}

export function stripWindow(start: number, end: number, chromSize = Number.POSITIVE_INFINITY): { start: number; end: number } {
  const w = Math.max(1, end - start);
  let s = Math.max(0, Math.round(start - w));
  let e = Math.round(end + w);
  if (Number.isFinite(chromSize) && e > chromSize) { e = chromSize; s = Math.max(0, e - 3 * w); }
  return { start: s, end: Math.max(s + 1, e) };
}

export interface StripRead {
  /** Genomic, 0-based. */
  start: number;
  end: number;
  /** [start, end, isFootprint] genomic. */
  parts: Array<[number, number, boolean]>;
}

interface CompactRead { intervals?: number[][]; aligned_blocks?: number[][] }

/** Reads of a compact response as genomic spans with their footprints and gaps. */
export function stripReads(reads: CompactRead[], requestStart: number): StripRead[] {
  const out: StripRead[] = [];
  for (const r of reads) {
    const parts: Array<[number, number, boolean]> = [];
    for (const iv of r.intervals ?? []) {
      if (iv.length < 3 || !(iv[1] > iv[0])) continue;
      parts.push([requestStart + iv[0], requestStart + iv[1], iv[2] > 0]);
    }
    const blocks = r.aligned_blocks ?? [];
    const start = blocks.length ? Math.min(...blocks.map(b => b[0])) : parts.length ? parts[0][0] : NaN;
    const end = blocks.length ? Math.max(...blocks.map(b => b[1])) : parts.length ? parts[parts.length - 1][1] : NaN;
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) out.push({ start, end, parts });
  }
  return out;
}

/** Pack reads into `rows` lanes, first fit by start (reads that fit nowhere are left out: a downsample). */
export function packStripReads(reads: StripRead[], rows = STRIP_ROWS, gapBp = 0): StripRead[][] {
  const lanes: StripRead[][] = Array.from({ length: rows }, () => []);
  const ends = new Array<number>(rows).fill(-Infinity);
  for (const r of [...reads].sort((a, b) => a.start - b.start || b.end - a.end)) {
    const i = ends.findIndex(e => e + gapBp <= r.start);
    if (i < 0) continue;
    lanes[i].push(r);
    ends[i] = r.end;
  }
  return lanes;
}

export function MiniReadStrip({ datasetId, label }: { datasetId: string | null; label: string }) {
  // Redraw key for the user's layer colours (Labels → Layer colours).
  const layerColorVersion = useLayerColorVersion();
  const { chrom, start, end, chroms, setViewport } = useBrowserStore(useShallow(s => ({ chrom: s.chrom, start: s.start, end: s.end, chroms: s.chroms, setViewport: s.setViewport })));
  const chromSize = findChromInfo(chroms, chrom)?.size ?? Number.POSITIVE_INFINITY;
  const win = useMemo(() => stripWindow(start, end, chromSize), [start, end, chromSize]);
  const [data, setData] = useState<{ key: string; chrom: string; start: number; end: number; lanes: StripRead[][]; total: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  const [drag, setDrag] = useState<{ mode: StripDragMode; x0: number; dx: number } | null>(null);
  const key = `${datasetId}|${chrom}:${win.start}-${win.end}`;

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(Math.max(50, Math.round(el.clientWidth))));
    ro.observe(el);
    setWidth(Math.max(50, Math.round(el.clientWidth)));
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!datasetId || !chrom) return;
    const controller = new AbortController();
    const at = { ...win };
    const t = window.setTimeout(() => {
      const params = new URLSearchParams({ chrom, start: String(at.start), end: String(at.end), dataset_id: datasetId, max_reads: String(STRIP_MAX_READS) });
      fetchJson<{ reads?: CompactRead[]; total?: number }>(`/api/reads/compact?${params}`, { signal: controller.signal })
        .then(r => {
          const reads = stripReads(r.reads ?? [], at.start);
          const gap = Math.round((at.end - at.start) / 200);
          setData({ key, chrom, start: at.start, end: at.end, lanes: packStripReads(reads, STRIP_ROWS, gap), total: r.total ?? reads.length });
        })
        .catch(() => { /* the strip keeps what it drew */ });
    }, 150);
    return () => { controller.abort(); window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const span = win.end - win.start;
  const height = STRIP_ROWS * (ROW_H + ROW_GAP) + 2;
  // The last reads drawn where they were fetched: they slide with the view until the new window's arrive.
  const shown = data && data.chrom === chrom ? data : null;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!shown) return;
    const x = (g: number) => ((g - win.start) / span) * width;
    const nuc = getLayerColor('nuc');
    const msp = getLayerColor('msp');
    shown.lanes.forEach((lane, row) => {
      const y = 1 + row * (ROW_H + ROW_GAP);
      for (const r of lane) {
        const x0 = x(r.start), x1 = x(r.end);
        if (x1 < 0 || x0 > width) continue;
        ctx.fillStyle = 'rgba(148,163,184,0.55)';
        ctx.fillRect(x0, y + ROW_H / 2 - 0.5, Math.max(1, x1 - x0), 1);
        for (const [a, b, fp] of r.parts) {
          ctx.fillStyle = fp ? nuc : msp;
          ctx.fillRect(x(a), y, Math.max(0.6, x(b) - x(a)), ROW_H);
        }
      }
    });
  }, [shown, width, height, win.start, span, layerColorVersion]);

  const pct = (g: number) => `${((g - win.start) / span) * 100}%`;
  const bpPerPx = () => span / Math.max(1, ref.current?.getBoundingClientRect().width || width);
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const handle = (e.target as HTMLElement).closest('[data-strip-handle]')?.getAttribute('data-strip-handle') as StripDragMode | null;
    (e.currentTarget as HTMLDivElement).setPointerCapture?.(e.pointerId);
    setDrag({ mode: handle ?? 'pan', x0: e.clientX, dx: 0 });
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => { if (drag) setDrag({ ...drag, dx: e.clientX - drag.x0 }); };
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const rect = ref.current?.getBoundingClientRect();
    setDrag(null);
    if (!rect || rect.width <= 0) return;
    const bp = span / rect.width;
    const w = end - start;
    if (Math.abs(drag.dx) < CLICK_SLOP) {
      if (drag.mode !== 'pan') return;
      // Click on the reads: centre the view here.
      const at = win.start + (e.clientX - rect.left) * bp;
      const s = Math.max(0, Math.round(at - w / 2));
      setViewport(chrom, s, s + w);
      return;
    }
    const next = stripDragResult(drag.mode, start, end, drag.dx * bp, { chromSize });
    setViewport(chrom, next.start, next.end);
  };
  // While dragging: where the view will be (the box), and the reads moving with a pan.
  const preview = drag && Math.abs(drag.dx) >= CLICK_SLOP && drag.mode !== 'pan'
    ? stripDragResult(drag.mode, start, end, drag.dx * bpPerPx(), { chromSize }) : { start, end };
  const readsShift = drag?.mode === 'pan' ? drag.dx : 0;
  const reads = shown ? shown.lanes.reduce((n, l) => n + l.length, 0) : 0;
  const hasGenes = useHasGenes();

  return (
    <div className="flex items-center gap-2 border-b border-line/70 px-3 py-1 dark:border-white/10" data-testid="plots-mini-strip">
      <span className="w-28 shrink-0 truncate text-[10px] text-ink-secondary" title={`${label}: ${reads} of ${shown?.total ?? 0} reads drawn (a sample)`}>Reads · {label}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-px">
      <div ref={ref} role="slider" aria-label="Mini read strip: drag to pan, click to jump" aria-valuetext={formatLocus({ chrom, start, end })}
        aria-valuemin={win.start} aria-valuemax={win.end} aria-valuenow={Math.round((start + end) / 2)} tabIndex={-1}
        className="relative cursor-grab touch-none select-none overflow-hidden rounded bg-gray-50 active:cursor-grabbing dark:bg-white/5"
        style={{ height }} data-testid="plots-mini-strip-track" data-reads={reads} data-window={`${win.start}-${win.end}`}
        data-drawn={shown ? `${shown.start}-${shown.end}` : ''}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDrag(null)}>
        <canvas ref={canvasRef} className="absolute inset-y-0 left-0" aria-hidden="true"
          style={{ width, height, transform: `translateX(${(shown ? ((shown.start - win.start) / span) * width : 0) + readsShift}px)` }} />
        {/* The view: drag the box to move it, an edge to zoom (the other edge stays). */}
        <div className="absolute inset-y-0 cursor-move rounded-sm border-2 border-amber-600 bg-amber-500/5" data-strip-handle="move"
          style={{ left: pct(preview.start), width: `${((preview.end - preview.start) / span) * 100}%` }} data-testid="plots-mini-strip-view"
          title="Drag to move the view; drag an edge to zoom">
          <div data-strip-handle="left" data-testid="plots-mini-strip-left" title="Drag to zoom (the right edge stays)"
            className="absolute -left-1.5 inset-y-0 w-3 cursor-ew-resize"><div className="mx-auto mt-[30%] h-[40%] w-1 rounded-full bg-amber-600" /></div>
          <div data-strip-handle="right" data-testid="plots-mini-strip-right" title="Drag to zoom (the left edge stays)"
            className="absolute -right-1.5 inset-y-0 w-3 cursor-ew-resize"><div className="mx-auto mt-[30%] h-[40%] w-1 rounded-full bg-amber-600" /></div>
        </div>
        {shown && reads === 0 && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] text-ink-secondary">No reads here</span>
        )}
      </div>
      {/* Genes over the same window (the browser's gene track, its own fetch), when an annotation is loaded. */}
      {hasGenes && (
        <div className="overflow-hidden rounded bg-white/60 dark:bg-white/5" style={{ height: STRIP_GENES_HEIGHT }} data-testid="plots-mini-strip-genes">
          <GeneTrack width={width} height={STRIP_GENES_HEIGHT} overrideChrom={chrom} overrideStart={win.start} overrideEnd={win.end} />
        </div>
      )}
      </div>
      <span className="shrink-0 font-mono text-[10px] text-ink-secondary">{Math.round(win.start + 1).toLocaleString('en-US')} – {Math.round(win.end).toLocaleString('en-US')}</span>
    </div>
  );
}
