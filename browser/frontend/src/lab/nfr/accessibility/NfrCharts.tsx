/**
 * Accessibility (preview): the saved-variant charts. Canvas charts drawn by one function, so the app's chart buttons
 * export them as PNG / vector SVG / PDF (ChartSaveButton) and open them larger (ChartMaximizeButton), as every other
 * analysis chart does.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { MotifFamily, NfrPrevalenceRow, NfrShape, SiteLayer, VariantSequence } from '../api';
import { variantColor } from '../accessibilityView';
import { ChartSaveButton } from '../../../components/charts/ChartSaveButton';
import { ChartMaximizeButton } from '../../../components/charts/ChartMaximizeButton';

type Draw = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

const INK = '#8b93a1';          // axis text: readable on light and dark panels (and on exported white)
const GRID = 'rgba(139,147,161,0.25)';
const OTHER = '#9ca3af';

function NfrCanvas({ draw, width, height, filename, title, dataTsv, testId }: {
  draw: Draw; width: number; height: number; filename: string; title: string; dataTsv?: () => string; testId?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr; canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, width, height);
  }, [draw, width, height]);
  return (
    <div className="group relative" data-testid={testId}>
      <canvas ref={ref} style={{ width, height }} role="img" aria-label={title} />
      <ChartSaveButton canvasRef={ref} filename={filename} drawFn={draw} width={width} height={height} dataTsv={dataTsv} />
      <ChartMaximizeButton title={title} filename={filename}
        renderChart={(w, h) => <NfrCanvas draw={draw} width={w} height={h} filename={filename} title={title} dataTsv={dataTsv} />} />
    </div>
  );
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
function niceTicks(lo: number, hi: number, n = 4): number[] {
  const span = Math.max(1, hi - lo);
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map(m => m * mag).find(s => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
  return out;
}

function axes(ctx: CanvasRenderingContext2D, box: { l: number; t: number; w: number; h: number }, x: [number, number], y: [number, number] | null,
  xLabel: string, yLabel: string, xFmt: (v: number) => string = fmt, yFmt: (v: number) => string = fmt) {
  ctx.strokeStyle = GRID; ctx.fillStyle = INK; ctx.lineWidth = 1; ctx.font = '10px sans-serif';
  ctx.strokeRect(box.l, box.t, box.w, box.h);
  ctx.textAlign = 'center';
  for (const v of niceTicks(x[0], x[1])) {
    const px = box.l + ((v - x[0]) / (x[1] - x[0])) * box.w;
    ctx.beginPath(); ctx.moveTo(px, box.t + box.h); ctx.lineTo(px, box.t + box.h + 3); ctx.stroke();
    ctx.fillText(xFmt(v), px, box.t + box.h + 13);
  }
  ctx.fillText(xLabel, box.l + box.w / 2, box.t + box.h + 25);
  if (y) {
    ctx.textAlign = 'right';
    for (const v of niceTicks(y[0], y[1])) {
      const py = box.t + box.h - ((v - y[0]) / (y[1] - y[0])) * box.h;
      ctx.beginPath(); ctx.moveTo(box.l - 3, py); ctx.lineTo(box.l, py); ctx.stroke();
      ctx.fillText(yFmt(v), box.l - 5, py + 3);
    }
    ctx.save(); ctx.translate(11, box.t + box.h / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText(yLabel, 0, 0); ctx.restore();
  }
}

/** Opening widths per variant on one axis (violins of the width histogram, median and quartiles), 'other' last. */
export function WidthPlot({ shape, names: shown, width, fileStem }: { shape: NfrShape; names: string[]; width: number; fileStem: string }) {
  const names = [...shown, 'other'].filter(n => shape.sizes.variants[n]?.summary);
  const height = 30 + names.length * 30;
  const draw = useCallback<Draw>((ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const { lo, hi, step } = shape.sizes;
    const box = { l: 46, t: 4, w: w - 58, h: h - 32 };
    const x: [number, number] = [lo, hi];
    const px = (v: number) => box.l + ((v - lo) / Math.max(1, hi - lo)) * box.w;
    axes(ctx, box, x, null, 'opening width (bp)', '');
    const row = box.h / Math.max(1, names.length);
    names.forEach((n, i) => {
      const s = shape.sizes.variants[n];
      const cy = box.t + row * (i + 0.5);
      const max = Math.max(1, ...s.hist);
      const color = n === 'other' ? OTHER : variantColor(n);
      ctx.fillStyle = color; ctx.globalAlpha = n === 'other' ? 0.3 : 0.5;
      ctx.beginPath();
      s.hist.forEach((c, j) => { const xx = px(lo + j * step + step / 2); const hh = (c / max) * row * 0.42; if (j === 0) ctx.moveTo(xx, cy - hh); else ctx.lineTo(xx, cy - hh); });
      for (let j = s.hist.length - 1; j >= 0; j--) { const xx = px(lo + j * step + step / 2); ctx.lineTo(xx, cy + (s.hist[j] / max) * row * 0.42); }
      ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
      const q = s.summary!;
      ctx.strokeStyle = color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(px(q.q1), cy); ctx.lineTo(px(q.q3), cy); ctx.stroke();
      ctx.fillStyle = '#ffffff'; ctx.strokeStyle = color; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(px(q.median), cy, 3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = n === 'other' ? INK : color; ctx.font = `${n === 'other' ? '' : 'bold '}10px sans-serif`; ctx.textAlign = 'right';
      ctx.fillText(n, box.l - 6, cy + 3);
      ctx.textAlign = 'left'; ctx.fillStyle = INK;
      ctx.fillText(`${fmt(q.median)} bp · n ${q.n}`, Math.min(px(q.p95) + 4, box.l + box.w - 70), cy - row * 0.22);
    });
  }, [shape, names.join('|')]);
  const tsv = () => ['variant\tn\tp5\tq1\tmedian\tq3\tp95', ...names.map(n => { const q = shape.sizes.variants[n].summary!; return [n, q.n, q.p5, q.q1, q.median, q.q3, q.p95].join('\t'); })].join('\n');
  return <NfrCanvas draw={draw} width={width} height={height} filename={`nfr-widths-${fileStem}`} title="Opening widths" dataTsv={tsv} testId="nfr-width-plot" />;
}

/** The boundary nucleosomes of each variant's openings: -1 (ends at the left edge) and +1 (starts at the right
 * edge), their dyads' quartiles around the variant's span, one row per variant. */
export function BoundaryPlot({ shape, names: shown, width, fileStem }: { shape: NfrShape; names: string[]; width: number; fileStem: string }) {
  const b = shape.boundary ?? {};
  const names = shown.filter(n => b[n] && (b[n].minus1 || b[n].plus1));
  const height = 34 + names.length * 22;
  const draw = useCallback<Draw>((ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const vals = names.flatMap(n => [b[n].minus1?.p5, b[n].plus1?.p95].filter((v): v is number => v != null));
    if (!vals.length) return;
    const x: [number, number] = [Math.min(...vals) - 40, Math.max(...vals) + 40];
    const box = { l: 46, t: 4, w: w - 58, h: h - 32 };
    const px = (v: number) => box.l + ((v - x[0]) / (x[1] - x[0])) * box.w;
    axes(ctx, box, x, null, 'dyad position of the -1 and +1 nucleosomes (bp)', '');
    const row = box.h / Math.max(1, names.length);
    names.forEach((n, i) => {
      const cy = box.t + row * (i + 0.5);
      const color = variantColor(n);
      const span = shape.edges.centres[n];
      if (span) { ctx.fillStyle = color; ctx.globalAlpha = 0.18; ctx.fillRect(px(span[0]), cy - 4, px(span[1]) - px(span[0]), 8); ctx.globalAlpha = 1; }
      for (const q of [b[n].minus1, b[n].plus1]) {
        if (!q) continue;
        ctx.strokeStyle = color; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(px(q.p5), cy); ctx.lineTo(px(q.p95), cy); ctx.stroke();
        ctx.fillStyle = color; ctx.globalAlpha = 0.7;
        ctx.fillRect(px(q.q1), cy - 5, Math.max(2, px(q.q3) - px(q.q1)), 10); ctx.globalAlpha = 1;
        ctx.fillStyle = '#ffffff'; ctx.fillRect(px(q.median) - 1, cy - 5, 2, 10);
      }
      ctx.fillStyle = color; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'right';
      ctx.fillText(n, box.l - 6, cy + 3);
    });
  }, [shape, names.join('|')]);
  const tsv = () => ['variant\tnucleosome\tn\tp5\tq1\tmedian\tq3\tp95', ...names.flatMap(n => (['minus1', 'plus1'] as const).map(k => { const q = b[n][k]; return q ? [n, k === 'minus1' ? '-1' : '+1', q.n, q.p5, q.q1, q.median, q.q3, q.p95].join('\t') : ''; }).filter(Boolean))].join('\n');
  return <NfrCanvas draw={draw} width={width} height={height} filename={`nfr-boundary-${fileStem}`} title="Boundary nucleosomes" dataTsv={tsv} testId="nfr-boundary-plot" />;
}

export interface PrevalenceGroupRow { label: string; swatch?: string; callable: number; variants: NfrPrevalenceRow['variants'] }

/** Prevalence of each variant per read group or dataset (a grouped forest plot, 0-100%): one row per group, one
 * point with its interval per variant, in the variant's colour. */
export function PrevalencePlot({ rows, names, width, title = 'Prevalence by group', filename = 'nfr-prevalence-by-group' }: {
  rows: PrevalenceGroupRow[]; names: string[]; width: number; title?: string; filename?: string;
}) {
  const sub = Math.max(5, Math.min(9, 26 / Math.max(1, names.length)));
  const rowH = Math.max(20, names.length * sub + 8);
  const height = 34 + rows.length * rowH;
  const draw = useCallback<Draw>((ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.font = '10px sans-serif';
    const labelW = Math.min(160, Math.max(60, ...rows.map(r => ctx.measureText(r.label).width + 18)));
    const box = { l: labelW, t: 4, w: w - labelW - 70, h: h - 32 };
    const px = (v: number) => box.l + v * box.w;
    axes(ctx, box, [0, 1], null, 'prevalence among callable reads', '', v => `${Math.round(v * 100)}%`);
    rows.forEach((r, i) => {
      const top = box.t + i * rowH;
      const cy = top + rowH / 2;
      ctx.font = '10px sans-serif'; ctx.textAlign = 'right'; ctx.fillStyle = INK;
      ctx.fillText(r.label, box.l - 8, cy + 3);
      if (r.swatch) { ctx.fillStyle = r.swatch; ctx.fillRect(box.l - 6 - ctx.measureText(r.label).width - 10, cy - 3, 6, 6); }
      if (i > 0) { ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(box.l, top); ctx.lineTo(box.l + box.w, top); ctx.stroke(); }
      names.forEach((n, k) => {
        const v = r.variants[n];
        if (!v || v.prevalence == null) return;
        const y = top + 4 + sub * (k + 0.5);
        const color = variantColor(n);
        ctx.strokeStyle = color; ctx.lineWidth = 1.5;
        if (v.ci) { ctx.beginPath(); ctx.moveTo(px(v.ci[0]), y); ctx.lineTo(px(v.ci[1]), y); ctx.stroke(); }
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(px(v.prevalence), y, 3, 0, Math.PI * 2); ctx.fill();
      });
      ctx.textAlign = 'left'; ctx.fillStyle = INK;
      ctx.fillText(`n ${r.callable.toLocaleString()}`, box.l + box.w + 6, cy + 3);
    });
  }, [rows, names.join('|'), rowH, sub]);
  const tsv = () => ['group\tcallable\tvariant\tprevalence\tstrict\tci_lo\tci_hi',
    ...rows.flatMap(r => names.map(n => { const v = r.variants[n]; return [r.label, r.callable, n, v?.prevalence ?? '', v?.strict ?? '', v?.ci?.[0] ?? '', v?.ci?.[1] ?? ''].join('\t'); }))].join('\n');
  return <NfrCanvas draw={draw} width={width} height={height} filename={filename} title={title} dataTsv={tsv} testId="nfr-prevalence-plot" />;
}

/** Motif family label: the JASPAR name with its common name where they differ ("vfl (Zelda)"). */
export function motifLabel(r: Pick<MotifFamily, 'name' | 'common'>): string {
  return r.common ? `${r.name} (${r.common})` : r.name;
}

/** GC% (50-bp windows) over the window with the shown variants' spans and the poly(dA:dT) tracts marked. */
export function GcTrack({ seq, names, width, fileStem }: { seq: VariantSequence; names: string[]; width: number; fileStem: string }) {
  const height = 96;
  const draw = useCallback<Draw>((ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const win = seq.window;
    const box = { l: 46, t: 6, w: w - 58, h: h - 40 };
    const px = (v: number) => box.l + ((v - win[0]) / Math.max(1, win[1] - win[0])) * box.w;
    const py = (v: number) => box.t + box.h - v * box.h;
    names.forEach((n, i) => {
      const f = seq.variants[n];
      if (!f) return;
      const lane = Math.max(3, Math.min(6, box.h / Math.max(1, names.length) / 3));
      ctx.fillStyle = variantColor(n); ctx.globalAlpha = 0.08;
      ctx.fillRect(px(f.span[0]), box.t, px(f.span[1]) - px(f.span[0]), box.h);
      ctx.globalAlpha = 0.85;
      ctx.fillRect(px(f.span[0]), box.t + i * (lane + 1), px(f.span[1]) - px(f.span[0]), lane); ctx.globalAlpha = 1;
    });
    axes(ctx, box, win, [0, 1], 'position (bp)', 'GC', fmt, v => `${Math.round(v * 100)}%`);
    ctx.strokeStyle = INK; ctx.lineWidth = 1.3; ctx.beginPath();
    let started = false;
    seq.gc_track.x.forEach((x, i) => {
      const v = seq.gc_track.gc[i];
      if (v == null) { started = false; return; }
      if (!started) { ctx.moveTo(px(x), py(v)); started = true; } else ctx.lineTo(px(x), py(v));
    });
    ctx.stroke();
    ctx.fillStyle = '#0f766e';
    for (const t of seq.tracts) ctx.fillRect(px(t.start), box.t + box.h - 4, Math.max(2, px(t.end) - px(t.start)), 4);
  }, [seq, names.join('|')]);
  const tsv = () => ['position\tgc', ...seq.gc_track.x.map((x, i) => `${x}\t${seq.gc_track.gc[i] ?? ''}`)].join('\n');
  return <NfrCanvas draw={draw} width={width} height={height} filename={`nfr-gc-${fileStem}`} title="GC and poly(dA:dT)" dataTsv={tsv} testId="nfr-gc-track" />;
}

/** One variant's layers at a site, as a stacked bar: closed (grey) / open, not footprinted (light) / open and
 * footprinted (full colour); the open share's interval as a whisker. */
export function LayerBar({ layer, name, width = 84, fluid = false }: {
  layer: SiteLayer | undefined; name: string; width?: number;
  /** Fill the cell (at most `width`), shrinking with a narrow card (N18). */
  fluid?: boolean;
}) {
  if (!layer || layer.p_open == null || !layer.stack) return <span className="text-[10px] text-ink-secondary">no data</span>;
  const c = variantColor(name);
  const st = layer.stack;
  const open = layer.p_open;
  const fp = st.open_footprinted;
  const title = `${name}: open ${Math.round(open * 100)}% of ${layer.reads} reads${layer.ci_open ? ` [${Math.round(layer.ci_open[0] * 100)}–${Math.round(layer.ci_open[1] * 100)}]` : ''}`
    + (layer.p_fp_given_open != null ? `; footprinted in ${Math.round(layer.p_fp_given_open * 100)}% of ${layer.labelled} labelled open reads${layer.ci_fp_given_open ? ` [${Math.round(layer.ci_fp_given_open[0] * 100)}–${Math.round(layer.ci_fp_given_open[1] * 100)}]` : ''}` : '; no footprint class here')
    + (layer.unlabelled_open ? `; ${layer.unlabelled_open} open reads unlabelled (class run abstained)` : '')
    + (layer.excluded_members && (layer.excluded_members.nucleosome + layer.excluded_members.linker)
      ? `; ${layer.excluded_members.nucleosome + layer.excluded_members.linker} class members not open here (nucleosome / linker protection, left out)` : '');
  return (
    <svg width={fluid ? '100%' : width} height={12} viewBox={`0 0 ${width} 12`} preserveAspectRatio="none" style={fluid ? { maxWidth: width, display: 'block' } : undefined}
      role="img" aria-label={title} data-testid="nfr-layer-bar" data-variant={name}>
      <title>{title}</title>
      <rect x={0} y={2} width={width} height={8} fill={OTHER} opacity={0.35} />
      <rect x={0} y={2} width={width * open} height={8} fill={c} opacity={0.35} />
      {fp != null && <rect x={0} y={2} width={width * fp} height={8} fill={c} />}
      {layer.ci_open && <line x1={width * layer.ci_open[0]} x2={width * layer.ci_open[1]} y1={11} y2={11} stroke={c} strokeWidth={1} />}
    </svg>
  );
}

/** The panel's canvas chart frame (save / maximise buttons) for charts drawn elsewhere. */
export const NfrCanvasExport = NfrCanvas;
