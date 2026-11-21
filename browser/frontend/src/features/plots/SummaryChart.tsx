/**
 * A summary across groups (summary.ts): one value per group as bars or a line in panel order, with 95% whiskers,
 * the group colours (the line palette), a "what it measures" header, PNG / SVG / PDF and TSV export.
 */
import { formatTick, niceTicks } from '../../utils/niceTicks';
import { useCallback, useMemo } from 'react';
import { ChartSaveButton } from '../../components/charts/ChartSaveButton';
import { summaryTsv, type SummaryValue } from './summary';

const W = 560, H = 220, PAD = { l: 52, r: 12, t: 14, b: 54 };

export function drawSummary(ctx: CanvasRenderingContext2D, w: number, h: number, values: SummaryValue[], o: { chart: 'bar' | 'line'; yLabel: string; dark?: boolean; reference?: number }) {
  const ref0 = o.reference ?? 0;
  ctx.fillStyle = o.dark ? '#1f1f1e' : '#ffffff';
  ctx.fillRect(0, 0, w, h);
  const ink = o.dark ? '#c3c2b7' : '#52514e';
  const vals = values.flatMap(v => [v.value, v.lo, v.hi]).filter((x): x is number => x != null && Number.isFinite(x));
  let lo = Math.min(ref0, ...vals), hi = Math.max(ref0, ...vals);
  if (hi <= lo) hi = lo + 1;
  hi += (hi - lo) * 0.05;
  const plotW = w - PAD.l - PAD.r, plotH = h - PAD.t - PAD.b;
  const n = Math.max(1, values.length);
  const xOf = (i: number) => PAD.l + ((i + 0.5) / n) * plotW;
  const yOf = (v: number) => PAD.t + plotH - ((v - lo) / (hi - lo)) * plotH;
  ctx.strokeStyle = o.dark ? 'rgba(240,239,236,0.15)' : 'rgba(31,31,30,0.12)';
  ctx.font = '9px sans-serif'; ctx.fillStyle = ink; ctx.textAlign = 'right';
  const yt = niceTicks(lo, hi, plotH, 45);
  for (const v of yt.major) {
    ctx.beginPath(); ctx.moveTo(PAD.l, yOf(v)); ctx.lineTo(PAD.l + plotW, yOf(v)); ctx.stroke();
    ctx.fillText(formatTick(v, yt.step), PAD.l - 3, yOf(v) + 3);
  }
  ctx.save(); ctx.translate(10, PAD.t + plotH / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText(o.yLabel, 0, 0); ctx.restore();
  // The reference (0 for log2 enrichment, 1 for a ratio): bars grow from it, a dashed line marks it.
  ctx.save(); ctx.strokeStyle = o.dark ? 'rgba(240,239,236,0.55)' : 'rgba(31,31,30,0.5)'; ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(PAD.l, yOf(ref0)); ctx.lineTo(PAD.l + plotW, yOf(ref0)); ctx.stroke(); ctx.restore();
  const bw = Math.min(40, (plotW / n) * 0.6);
  if (o.chart === 'line') {
    ctx.strokeStyle = ink; ctx.lineWidth = 1.5; ctx.beginPath();
    let pen = false;
    values.forEach((v, i) => { if (v.value == null) { pen = false; return; } if (!pen) { ctx.moveTo(xOf(i), yOf(v.value)); pen = true; } else ctx.lineTo(xOf(i), yOf(v.value)); });
    ctx.stroke();
  }
  values.forEach((v, i) => {
    const x = xOf(i);
    if (v.value != null) {
      ctx.fillStyle = v.color ?? '#52514e';
      if (o.chart === 'bar') ctx.fillRect(x - bw / 2, Math.min(yOf(ref0), yOf(v.value)), bw, Math.max(1, Math.abs(yOf(v.value) - yOf(ref0))));
      else { ctx.beginPath(); ctx.arc(x, yOf(v.value), 3.5, 0, Math.PI * 2); ctx.fill(); }
    }
    if (v.lo != null && v.hi != null) {
      ctx.strokeStyle = o.dark ? '#f0efec' : '#1f1f1e'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, yOf(v.lo)); ctx.lineTo(x, yOf(v.hi)); ctx.moveTo(x - 4, yOf(v.lo)); ctx.lineTo(x + 4, yOf(v.lo)); ctx.moveTo(x - 4, yOf(v.hi)); ctx.lineTo(x + 4, yOf(v.hi)); ctx.stroke();
    }
    // The group's name under its bar, horizontal, wrapped to the slot (two lines at most), never past the canvas.
    ctx.save(); ctx.fillStyle = ink; ctx.textAlign = 'center'; ctx.font = '9px sans-serif';
    const slot = Math.max(30, plotW / n - 6);
    wrapLabel(ctx, v.title, slot, 2).forEach((line, li) => ctx.fillText(line, Math.min(w - slot / 2 - 2, Math.max(slot / 2 + 2, x)), PAD.t + plotH + 14 + li * 11));
    ctx.restore();
  });
}

export function SummaryChart({ values, chart, yLabel, measures, filename, dark = false, reference = 0, note = null }: {
  values: SummaryValue[]; chart: 'bar' | 'line'; yLabel: string; measures: string; filename: string; dark?: boolean;
  /** The value bars grow from and a dashed line marks (0; 1 for a ratio). */
  reference?: number;
  /** Shown instead of the chart: the summary is constant by construction (pick a window). */
  note?: string | null;
}) {
  const draw = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => drawSummary(ctx, w, h, values, { chart, yLabel, dark, reference }), [values, chart, yLabel, dark, reference]);
  const ref = useCallback((c: HTMLCanvasElement | null) => {
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = W * dpr; c.height = H * dpr;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, W, H);
  }, [draw]);
  const tsv = useMemo(() => () => summaryTsv(values, measures), [values, measures]);
  return (
    <div className="flex flex-col gap-1" data-testid="plots-summary" data-groups={values.length} data-values={JSON.stringify(values.map(v => (v.value == null ? null : +v.value.toPrecision(6))))}
      data-intervals={JSON.stringify(values.map(v => (v.lo == null || v.hi == null ? null : [+v.lo.toPrecision(6), +v.hi.toPrecision(6)])))}>
      <div className="text-[11px] font-medium text-ink-primary dark:text-gray-100" data-testid="plots-summary-measures">{measures}</div>
      {note ? <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100" role="status" data-testid="plots-summary-note">{note}</div> : (
      <div className="relative">
        <canvas ref={ref} style={{ width: W, height: H }} data-testid="plots-summary-chart" />
        <ChartSaveButton filename={filename} drawFn={draw} width={W} height={H} dataTsv={tsv} />
      </div>
      )}
    </div>
  );
}

/** Words of `text` in lines no wider than `width` (at most `max`; the last ends with … when cut). */
export function wrapLabel(ctx: CanvasRenderingContext2D, text: string, width: number, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width <= width || !cur) cur = next;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  const out = lines.slice(0, max);
  if (lines.length > max || ctx.measureText(out[out.length - 1] ?? '').width > width) {
    let last = out[out.length - 1] ?? '';
    while (last.length > 1 && ctx.measureText(`${last}…`).width > width) last = last.slice(0, -1);
    out[out.length - 1] = `${last}…`;
  }
  return out.map(l => { let t = l; while (t.length > 1 && ctx.measureText(t).width > width) t = `${t.slice(0, -2)}…`; return t; });
}
