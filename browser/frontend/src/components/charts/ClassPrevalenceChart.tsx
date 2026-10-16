import { useCallback, useEffect, useRef } from 'react';
import { ChartSaveButton } from './ChartSaveButton';

export interface ClassPrevalenceBar {
  channel: string;
  color: string;
  core: number | null;
  edge: number | null;
  loose: number | null;
  supported: boolean;
}
export interface ClassPrevalenceGroup { label: string; color: string; bars: ClassPrevalenceBar[] }

interface Props {
  groups: ClassPrevalenceGroup[];
  channels: { label: string; color: string }[];
  width: number;
  height?: number;
  title?: string;
  filename?: string;
  dataTsv?: () => string;
}

/**
 * Footprint-class prevalence per class and channel: a solid bar for the core estimate, a lighter extension to
 * "+ one edge" and a faint one to "+ other shapes" (conservative to loose). Unsupported channels are hatched.
 */
export function ClassPrevalenceChart({ groups, channels, width, height = 260, title = 'Class prevalence', filename = 'class_prevalence', dataTsv }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawFn = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const left = 38, right = 8, top = 40, bottom = 52;
    const pw = w - left - right, ph = h - top - bottom;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
    ctx.font = '600 11px system-ui, sans-serif'; ctx.fillStyle = '#17202A'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(title, left, 14);
    // y axis 0-100%
    ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of [0, 25, 50, 75, 100]) {
      const y = top + ph * (1 - v / 100);
      ctx.strokeStyle = v === 0 ? '#94a3b8' : '#e5e7eb'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(left, Math.round(y) + .5); ctx.lineTo(left + pw, Math.round(y) + .5); ctx.stroke();
      ctx.fillStyle = '#64748b'; ctx.fillText(`${v}`, left - 4, y);
    }
    ctx.save(); ctx.translate(10, top + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText('Prevalence (%)', 0, 0); ctx.restore();
    const n = Math.max(groups.length, 1), gw = pw / n, nb = Math.max(channels.length, 1);
    const bw = Math.max(2, Math.min(18, (gw * .8) / nb));
    const Y = (v: number) => top + ph * (1 - Math.max(0, Math.min(1, v)));
    groups.forEach((g, gi) => {
      const x0 = left + gi * gw + (gw - bw * nb) / 2;
      g.bars.forEach((b, bi) => {
        if (b.core == null) return;
        const x = x0 + bi * bw;
        const seg = (from: number, to: number, alpha: number) => {
          if (to <= from) return;
          ctx.globalAlpha = alpha; ctx.fillStyle = b.color; ctx.fillRect(x + .5, Y(to), bw - 1, Y(from) - Y(to));
        };
        seg(0, b.core, b.supported ? .95 : .35);
        seg(b.core, b.edge ?? b.core, b.supported ? .45 : .2);
        seg(b.edge ?? b.core, b.loose ?? b.edge ?? b.core, b.supported ? .18 : .1);
        ctx.globalAlpha = 1;
        if (!b.supported && b.core > 0) {             // hatch: not supported on this channel
          ctx.save(); ctx.beginPath(); ctx.rect(x + .5, Y(b.core), bw - 1, Y(0) - Y(b.core)); ctx.clip();
          ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1;
          for (let t = -ph; t < ph; t += 4) { ctx.beginPath(); ctx.moveTo(x + t, Y(0)); ctx.lineTo(x + t + ph, Y(0) - ph); ctx.stroke(); }
          ctx.restore();
        }
      });
      // class label
      ctx.save(); ctx.translate(left + gi * gw + gw / 2, top + ph + 6); ctx.rotate(-Math.PI / 4);
      ctx.fillStyle = g.color; ctx.fillRect(-10, -3, 6, 6);
      ctx.fillStyle = '#17202A'; ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(g.label, -13, 0); ctx.restore();
    });
    // legend: channels, then tiers
    ctx.font = '10px system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    let lx = left; const items: [string, string, number][] = [
      ...channels.map(c => [c.label, c.color, .95] as [string, string, number]),
      ['+ edge', '#64748b', .45], ['+ overlap', '#64748b', .18]];
    let ly = 26;
    for (const [label, color, alpha] of items) {
      const tw = ctx.measureText(label).width;
      if (lx + tw + 14 > left + pw && lx > left) { lx = left; ly += 12; }
      ctx.globalAlpha = alpha; ctx.fillStyle = color; ctx.fillRect(lx, ly - 4, 9, 9); ctx.globalAlpha = 1;
      ctx.fillStyle = '#334155'; ctx.fillText(label, lx + 12, ly + 1); lx += tw + 22;
    }
  }, [groups, channels, title]);

  useEffect(() => {
    const canvas = canvasRef.current; const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr; canvas.height = height * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawFn(ctx, width, height);
  }, [drawFn, width, height]);

  return (
    <div className="relative group" data-testid="class-prevalence-chart">
      <canvas ref={canvasRef} style={{ width, height }} />
      <ChartSaveButton canvasRef={canvasRef} filename={filename} drawFn={drawFn} width={width} height={height} dataTsv={dataTsv} />
    </div>
  );
}
