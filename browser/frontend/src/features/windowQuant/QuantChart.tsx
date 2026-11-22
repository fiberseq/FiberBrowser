/**
 * The quantification as grouped bars (groups along x, one bar per measure, 95% whiskers) or lines across the groups
 * (ordered groups: datasets or time points), one panel per unit so a share and a fraction never share an axis.
 * Groups with too few reads are drawn grey with their n (never hidden). Clicking a bar picks its measure × group (the
 * link back to the reads). PNG / SVG / PDF and TSV export.
 */
import { useCallback, useMemo, useRef } from 'react';
import { formatTick, niceTicks } from '../../utils/niceTicks';
import { ChartSaveButton } from '../../components/charts/ChartSaveButton';
import { wrapLabel } from '../plots/SummaryChart';
import { quantOrder, shownOf, type QuantMeasureInfo, type QuantResult } from './engine';
import type { QuantSpec } from './spec';
import { axisLabelOf, measureColor, referenceOf } from './labels';
import { useLayerColorVersion } from '../layerColours/state';

const PAD = { l: 56, r: 12, t: 18, b: 46 };
/** Measures without a colour of their own (families) take these, in panel order. */
const MEASURE_PALETTE = ['#2563eb', '#d97706', '#059669', '#db2777', '#7c3aed', '#0891b2', '#65a30d', '#dc2626'];
const PANEL_H = 190;

export interface BarHit { measure: string; group: string; x0: number; x1: number; y0: number; y1: number }

/** Panels: the measures that share one axis (same displayed unit). */
export function quantPanels(r: QuantResult, spec: QuantSpec): Array<{ key: string; label: string; measures: QuantMeasureInfo[] }> {
  const order = quantOrder(r, spec).measures;
  const out: Array<{ key: string; label: string; measures: QuantMeasureInfo[] }> = [];
  for (const id of order) {
    const m = r.measures.find(x => x.id === id)!;
    const label = axisLabelOf(m, spec);
    const p = out.find(x => x.label === label);
    if (p) p.measures.push(m); else out.push({ key: label, label, measures: [m] });
  }
  return out;
}

export function drawQuant(ctx: CanvasRenderingContext2D, w: number, h: number, r: QuantResult, spec: QuantSpec, o: { dark?: boolean; selected?: { measure: string; group: string } | null } = {}): BarHit[] {
  const hits: BarHit[] = [];
  ctx.fillStyle = o.dark ? '#1f1f1e' : '#ffffff';
  ctx.fillRect(0, 0, w, h);
  const ink = o.dark ? '#c3c2b7' : '#52514e';
  const panels = quantPanels(r, spec);
  const order = quantOrder(r, spec);
  const groups = order.groups.map(id => r.groups.find(g => g.id === id)!);
  const ph = panels.length ? h / panels.length : h;
  panels.forEach((panel, pi) => {
    const top = pi * ph;
    const plotW = w - PAD.l - PAD.r, plotH = ph - PAD.t - PAD.b;
    const ref = referenceOf(panel.measures[0], spec);
    const cells = panel.measures.flatMap(m => groups.map(g => {
      const c = r.cells.find(x => x.measure === m.id && x.group === g.id);
      return c ? { m, g, c, s: shownOf(c, spec, m) } : null;
    })).filter((x): x is NonNullable<typeof x> => !!x);
    const vals = cells.flatMap(x => [x.s.v, x.s.lo, x.s.hi]).filter((x): x is number => x != null && Number.isFinite(x));
    let lo = Math.min(ref, ...vals), hi = Math.max(ref, ...vals);
    if (hi <= lo) hi = lo + 1;
    hi += (hi - lo) * 0.06;
    if (lo < ref) lo -= (hi - lo) * 0.03;
    const yOf = (v: number) => top + PAD.t + plotH - ((v - lo) / (hi - lo)) * plotH;
    const nG = Math.max(1, groups.length), nM = panel.measures.length;
    const mColor = (m: QuantMeasureInfo, i: number) => measureColor(m) ?? MEASURE_PALETTE[i % MEASURE_PALETTE.length];
    const slot = plotW / nG;
    const xOf = (gi: number) => PAD.l + (gi + 0.5) * slot;
    ctx.font = '9px sans-serif';
    ctx.strokeStyle = o.dark ? 'rgba(240,239,236,0.15)' : 'rgba(31,31,30,0.12)';
    ctx.fillStyle = ink; ctx.textAlign = 'right';
    const yt = niceTicks(lo, hi, plotH, 40);
    for (const v of yt.major) { ctx.beginPath(); ctx.moveTo(PAD.l, yOf(v)); ctx.lineTo(PAD.l + plotW, yOf(v)); ctx.stroke(); ctx.fillText(formatTick(v, yt.step), PAD.l - 3, yOf(v) + 3); }
    ctx.save(); ctx.translate(10, top + PAD.t + plotH / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center';
    wrapLabel(ctx, panel.label, plotH, 2).forEach((line, li) => ctx.fillText(line, 0, li * 10));
    ctx.restore();
    ctx.save(); ctx.strokeStyle = o.dark ? 'rgba(240,239,236,0.55)' : 'rgba(31,31,30,0.5)'; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(PAD.l, yOf(ref)); ctx.lineTo(PAD.l + plotW, yOf(ref)); ctx.stroke(); ctx.restore();
    // Legend: measures (when more than one share the panel).
    if (nM > 1) {
      let lx = PAD.l;
      ctx.textAlign = 'left';
      for (const [mi, m] of panel.measures.entries()) {
        ctx.fillStyle = mColor(m, mi); ctx.fillRect(lx, top + 4, 8, 8);
        ctx.fillStyle = ink; const t = m.label.length > 22 ? `${m.label.slice(0, 21)}…` : m.label;
        ctx.fillText(t, lx + 11, top + 11); lx += 16 + ctx.measureText(t).width;
        if (lx > w - 60) break;
      }
    }
    const bw = Math.min(28, (slot * 0.8) / nM);
    const colorOf = (m: QuantMeasureInfo, g: { color?: string }) => (nM > 1 ? mColor(m, panel.measures.indexOf(m)) : g.color ?? measureColor(m)) ?? '#52514e';
    if (spec.chart === 'line') {
      for (const [mi, m] of panel.measures.entries()) {
        ctx.strokeStyle = mColor(m, mi); ctx.lineWidth = 1.5; ctx.beginPath();
        let pen = false;
        groups.forEach((g, gi) => {
          const c = cells.find(x => x.m.id === m.id && x.g.id === g.id);
          if (!c || c.s.v == null) { pen = false; return; }
          if (!pen) { ctx.moveTo(xOf(gi), yOf(c.s.v)); pen = true; } else ctx.lineTo(xOf(gi), yOf(c.s.v));
        });
        ctx.stroke();
      }
    }
    groups.forEach((g, gi) => {
      panel.measures.forEach((m, mi) => {
        const x = spec.chart === 'line' ? xOf(gi) : xOf(gi) - (nM * bw) / 2 + (mi + 0.5) * bw;
        const cell = cells.find(c => c.m.id === m.id && c.g.id === g.id);
        if (!cell) return;
        const { s, c } = cell;
        const sel = o.selected && o.selected.measure === m.id && o.selected.group === g.id;
        if (s.v != null) {
          ctx.globalAlpha = c.low ? 0.3 : 1;
          ctx.fillStyle = c.low ? '#9a9893' : colorOf(m, g);
          let y0: number, y1: number;
          if (spec.chart === 'bar') {
            y0 = Math.min(yOf(ref), yOf(s.v)); y1 = y0 + Math.max(1, Math.abs(yOf(s.v) - yOf(ref)));
            ctx.fillRect(x - bw / 2 + 1, y0, bw - 2, y1 - y0);
          } else {
            y0 = yOf(s.v) - 4; y1 = yOf(s.v) + 4;
            ctx.beginPath(); ctx.arc(x, yOf(s.v), 3.5, 0, Math.PI * 2); ctx.fill();
          }
          ctx.globalAlpha = 1;
          if (sel) { ctx.strokeStyle = o.dark ? '#f0efec' : '#1f1f1e'; ctx.lineWidth = 2; ctx.strokeRect(x - bw / 2, y0 - 1, bw, y1 - y0 + 2); }
          hits.push({ measure: m.id, group: g.id, x0: x - bw / 2, x1: x + bw / 2, y0: Math.min(y0, top + PAD.t), y1: Math.max(y1, top + PAD.t + plotH) });
        }
        if (s.lo != null && s.hi != null) {
          ctx.strokeStyle = c.low ? '#9a9893' : o.dark ? '#f0efec' : '#1f1f1e'; ctx.lineWidth = 1;
          const cap = Math.min(4, bw / 3);
          ctx.beginPath(); ctx.moveTo(x, yOf(s.lo)); ctx.lineTo(x, yOf(s.hi)); ctx.moveTo(x - cap, yOf(s.lo)); ctx.lineTo(x + cap, yOf(s.lo)); ctx.moveTo(x - cap, yOf(s.hi)); ctx.lineTo(x + cap, yOf(s.hi)); ctx.stroke();
        }
      });
      // Group name and, for few reads, its n.
      ctx.fillStyle = ink; ctx.textAlign = 'center'; ctx.font = '9px sans-serif';
      const lines = wrapLabel(ctx, g.title, Math.max(30, slot - 6), 2);
      lines.forEach((line, li) => ctx.fillText(line, xOf(gi), top + PAD.t + plotH + 12 + li * 10));
      const lowN = cells.filter(c => c.g.id === g.id && c.c.low).map(c => c.c.n ?? 0);
      if (lowN.length) { ctx.fillStyle = '#9a6b00'; ctx.fillText(`few reads (n=${Math.min(...lowN)})`, xOf(gi), top + PAD.t + plotH + 12 + lines.length * 10); }
    });
  });
  return hits;
}

export function QuantChart({ result, spec, width, dark = false, filename, tsv, selected, onPick }: {
  result: QuantResult; spec: QuantSpec; width: number; dark?: boolean; filename: string; tsv: () => string;
  selected?: { measure: string; group: string } | null; onPick?: (measure: string, group: string) => void;
}) {
  const panels = useMemo(() => quantPanels(result, spec), [result, spec]);
  const W = Math.max(320, width), H = Math.max(1, panels.length) * PANEL_H;
  const hits = useRef<BarHit[]>([]);
  // Layer measures take the user's layer colours (Labels → Layer colours): redraw when they change.
  const layerColorVersion = useLayerColorVersion();
  const draw = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => drawQuant(ctx, w, h, result, spec, { dark, selected }), [result, spec, dark, selected, layerColorVersion]);   // eslint-disable-line react-hooks/exhaustive-deps
  const ref = useCallback((c: HTMLCanvasElement | null) => {
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = W * dpr; c.height = H * dpr;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    hits.current = draw(ctx, W, H);
  }, [draw, W, H]);
  const shown = result.cells.map(c => { const m = result.measures.find(x => x.id === c.measure)!; return shownOf(c, spec, m); });
  return (
    <div className="relative" data-testid="quant-chart" data-chart={spec.chart} data-panels={panels.length}
      data-values={JSON.stringify(shown.map(s => (s.v == null ? null : +s.v.toPrecision(6))))}
      data-intervals={JSON.stringify(shown.map(s => (s.lo == null || s.hi == null ? null : [+s.lo.toPrecision(6), +s.hi.toPrecision(6)])))}
      data-low={JSON.stringify(result.cells.map(c => c.low))} data-cells={JSON.stringify(result.cells.map(c => `${c.measure}|${c.group}`))}
      data-n={JSON.stringify(result.cells.map(c => c.n))}>
      <canvas ref={ref} style={{ width: W, height: H, cursor: onPick ? 'pointer' : undefined }} data-testid="quant-chart-canvas"
        onClick={e => {
          if (!onPick) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - rect.left, y = e.clientY - rect.top;
          const hit = hits.current.find(b => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
          if (hit) onPick(hit.measure, hit.group);
        }} />
      <ChartSaveButton filename={filename} drawFn={(ctx, w, h) => { draw(ctx, w, h); }} width={W} height={H} dataTsv={tsv} />
    </div>
  );
}
