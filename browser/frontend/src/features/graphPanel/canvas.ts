/**
 * Drawing the graph panel: its own ruler (true target coordinates through the scene's target map) and the joint
 * layout scene (scene.ts). The canvas is set up in screen coordinates, so no linear panel's insertion expansion,
 * highlight or pan offset reaches it. Like FiberBrowser's other track canvases it stays light in both themes; the
 * haplotype inks are the live-lift palette's (MAT orange, PAT blue, further paths their own colours).
 */
import { liveLiftHaplotypeColor } from '../liveLift/palette';
import { TRACK_BACKGROUND } from '../../components/tracks/TrackContainerConstants';
import { formatBp, type GraphViewport } from './coordinates';
import type { LayoutRow } from './layout';
import { xForTarget, type Prim, type Scene } from './scene';

export const GRAPH_GUTTER = 52;
export const GRAPH_RULER_HEIGHT = 30;
export const GRAPH_LANE_HEIGHT = 28;
export const GRAPH_LANE_GAP = 4;
export const GRAPH_RIGHT_PAD = 6;
const TARGET_INK = '#334155';

export function laneColor(row: Pick<LayoutRow, 'role' | 'label'>, dark = false): string {
  return row.role === 'target' ? (dark ? '#cbd5e1' : TARGET_INK) : liveLiftHaplotypeColor(row.label, dark);
}

export function laneTop(index: number, laneHeight = GRAPH_LANE_HEIGHT): number {
  return GRAPH_RULER_HEIGHT + GRAPH_LANE_GAP + index * (laneHeight + GRAPH_LANE_GAP);
}

/** Round tick positions about every `spacing` px of the window's average density. */
function tickStep(bp: number, width: number, spacing = 90): number {
  const target = Math.max(1, Math.min(10, Math.floor(width / spacing)));
  const raw = bp / target;
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(1, raw))));
  const n = raw / magnitude;
  return (n <= 1.5 ? 1 : n <= 3 ? 2 : n <= 7 ? 5 : 10) * magnitude;
}

export function drawRuler(ctx: CanvasRenderingContext2D, scene: Scene | null, view: GraphViewport, width: number, reversed: boolean): void {
  ctx.fillStyle = TRACK_BACKGROUND.axis;
  ctx.fillRect(0, 0, width, GRAPH_RULER_HEIGHT);
  ctx.strokeStyle = '#d4d4d8';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(GRAPH_GUTTER, GRAPH_RULER_HEIGHT - 0.5);
  ctx.lineTo(width - GRAPH_RIGHT_PAD, GRAPH_RULER_HEIGHT - 0.5);
  ctx.stroke();
  const region = `${view.contig}:${view.start.toLocaleString('en-US')}-${view.end.toLocaleString('en-US')}${reversed ? " ◄ 3'→5'" : ''}`;
  const size = formatBp(view.end - view.start);
  ctx.font = 'bold 10px sans-serif';
  const regionRight = GRAPH_GUTTER + 4 + ctx.measureText(region).width;
  ctx.font = '9px sans-serif';
  const sizeLeft = width - 4 - ctx.measureText(size).width;
  if (scene) {
    // Compressed stretches and insertion slots: a light band on the ruler where its scale is schematic.
    for (const m of scene.targetMap) {
      if (m.kind !== 'slot' && m.kind !== 'gap') continue;
      ctx.fillStyle = m.kind === 'slot' ? 'rgba(148,163,184,0.18)' : 'rgba(148,163,184,0.28)';
      ctx.fillRect(Math.min(m.x0, m.x1), GRAPH_RULER_HEIGHT - 5, Math.abs(m.x1 - m.x0), 4);
    }
    const step = tickStep(view.end - view.start, scene.dataWidth);
    ctx.fillStyle = '#666';
    ctx.textAlign = 'center';
    let lastRight = -Infinity, lastLeft = Infinity;
    for (let pos = Math.ceil(view.start / step) * step; pos < view.end; pos += step) {
      const x = xForTarget(scene.targetMap, pos, 'end', scene.reversed);
      if (x == null || x < GRAPH_GUTTER + 2 || x > width - GRAPH_RIGHT_PAD - 2) continue;
      ctx.strokeStyle = '#a1a1aa';
      ctx.beginPath();
      ctx.moveTo(x, GRAPH_RULER_HEIGHT - 6);
      ctx.lineTo(x, GRAPH_RULER_HEIGHT - 1);
      ctx.stroke();
      const label = pos.toLocaleString('en-US');
      const half = ctx.measureText(label).width / 2;
      if (x - half < regionRight + 6 || x + half > sizeLeft - 6) continue;
      // Compression can pack ticks: skip a label that would touch the last one.
      if (!reversed ? x - half < lastRight + 8 : x + half > lastLeft - 8) continue;
      ctx.fillText(label, x, GRAPH_RULER_HEIGHT - 10);
      lastRight = x + half;
      lastLeft = x - half;
    }
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = '#333';
  ctx.font = 'bold 10px sans-serif';
  ctx.fillText(region, GRAPH_GUTTER + 4, 12);
  ctx.textAlign = 'right';
  ctx.font = '9px sans-serif';
  ctx.fillStyle = '#666';
  ctx.fillText(size, width - 4, 12);
  ctx.textAlign = 'left';
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function hatch(ctx: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number, color: string): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, w, h);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (let x = x0 - h; x < x0 + w; x += 5) {
    ctx.beginPath();
    ctx.moveTo(x, y0 + h);
    ctx.lineTo(x + h, y0);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPrim(ctx: CanvasRenderingContext2D, p: Prim): void {
  switch (p.t) {
    case 'tube': {
      const w = p.x1 - p.x0;
      const pad = 1.5;
      // The node body: a soft outlined tube; inside, one stripe per path walking it.
      ctx.fillStyle = '#ffffff';
      roundRect(ctx, p.x0, p.y - pad, w, p.h + 2 * pad, 3);
      ctx.fill();
      ctx.save();
      roundRect(ctx, p.x0, p.y - pad, w, p.h + 2 * pad, 3);
      ctx.clip();
      for (const s of p.slots) {
        if (p.present.includes(s.key)) {
          ctx.globalAlpha = p.style === 'unresolved' ? 0.45 : 0.92;
          ctx.fillStyle = s.color;
        } else {
          ctx.globalAlpha = 1;
          ctx.fillStyle = '#f1f5f9';
        }
        ctx.fillRect(p.x0, s.y, w, s.h);
      }
      ctx.globalAlpha = 1;
      // Node boundaries: thin cuts across the stripes.
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 1;
      for (const x of p.nodes) {
        ctx.beginPath();
        ctx.moveTo(x, p.y - pad);
        ctx.lineTo(x, p.y + p.h + pad);
        ctx.stroke();
      }
      // A compressed run: a break mark.
      for (const x of p.breaks) {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(x - 3, p.y + p.h + pad);
        ctx.lineTo(x + 0.5, p.y - pad);
        ctx.lineTo(x + 3.5, p.y - pad);
        ctx.lineTo(x, p.y + p.h + pad);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      ctx.strokeStyle = p.style === 'unresolved' ? '#94a3b8' : p.outline;
      ctx.lineWidth = 1;
      if (p.style === 'unresolved') ctx.setLineDash([3, 2]);
      roundRect(ctx, p.x0 + 0.5, p.y - pad + 0.5, Math.max(0, w - 1), p.h + 2 * pad - 1, 3);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }
    case 'stripe': {
      ctx.fillStyle = p.color;
      if (p.style === 'edge') {
        ctx.globalAlpha = 0.92;
        ctx.fillRect(p.x0, p.y, p.x1 - p.x0, p.h);
        ctx.globalAlpha = 1;
      } else if (p.style === 'connector') {
        ctx.globalAlpha = 0.55;
        ctx.fillRect(p.x0, p.y, p.x1 - p.x0, p.h);
        ctx.globalAlpha = 1;
      } else {
        ctx.globalAlpha = 0.7;
        for (let x = p.x0; x < p.x1; x += 5) ctx.fillRect(x, p.y, Math.min(3, p.x1 - x), p.h);
        ctx.globalAlpha = 1;
      }
      return;
    }
    case 'curve': {
      const mid = (p.x0 + p.x1) / 2;
      ctx.strokeStyle = p.color;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = p.w;
      ctx.lineCap = 'butt';
      if (p.dashed) ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.moveTo(p.x0, p.y0);
      ctx.bezierCurveTo(mid, p.y0, mid, p.y1, p.x1, p.y1);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      return;
    }
    case 'text': {
      ctx.font = `${p.bold ? 'bold ' : ''}${p.size}px sans-serif`;
      ctx.textAlign = p.align;
      // A light halo keeps labels legible over stripes.
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeText(p.text, p.x, p.y);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, p.x, p.y);
      ctx.textAlign = 'left';
      return;
    }
    case 'gap': {
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(p.x0, p.y, p.x1 - p.x0, p.h);
      hatch(ctx, p.x0, p.y, p.x1 - p.x0, p.h, '#cbd5e1');
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 1;
      ctx.strokeRect(p.x0 + 0.5, p.y + 0.5, Math.max(0, p.x1 - p.x0 - 1), p.h - 1);
      return;
    }
    case 'mark': {
      ctx.fillStyle = TARGET_INK;
      ctx.fillRect(p.x - 1, p.y - 2, 2, p.h + 4);
      return;
    }
    case 'cap': {
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.stroke();
      return;
    }
    case 'dots': {
      ctx.fillStyle = p.color;
      if (p.x1 - p.x0 < 1) {
        ctx.beginPath();
        ctx.arc(p.x0, p.y, 2.25, 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      for (let x = p.x0; x <= p.x1; x += 4) {
        ctx.beginPath();
        ctx.arc(x, p.y, 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }
    case 'cluster': {
      ctx.fillStyle = 'rgba(217,119,6,0.10)';
      roundRect(ctx, p.x0, p.y, p.x1 - p.x0, p.h, 3);
      ctx.fill();
      ctx.strokeStyle = 'rgba(217,119,6,0.55)';
      ctx.setLineDash([2, 2]);
      ctx.lineWidth = 1;
      roundRect(ctx, p.x0 + 0.5, p.y + 0.5, p.x1 - p.x0 - 1, p.h - 1, 3);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }
    case 'frame': {
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 1.25;
      if (p.dashed) ctx.setLineDash([4, 3]);
      roundRect(ctx, p.x0 + 0.5, p.y0 + 0.5, p.x1 - p.x0 - 1, p.y1 - p.y0 - 1, 5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(217,119,6,0.05)';
      roundRect(ctx, p.x0, p.y0, p.x1 - p.x0, p.y1 - p.y0, 5);
      ctx.fill();
      return;
    }
  }
}

/** The scene's lanes: the compact label in the gutter, then the data (clipped to the data area). */
export function drawScene(ctx: CanvasRenderingContext2D, scene: Scene): void {
  for (const row of scene.rows) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, row.top - GRAPH_LANE_GAP / 2, scene.width, row.height + GRAPH_LANE_GAP);
    if (row.role === 'alternate') {
      // A faint lane guide, so alleles read as belonging to their path.
      ctx.strokeStyle = '#f1f5f9';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(scene.dataLeft, row.center + 0.5);
      ctx.lineTo(scene.dataLeft + scene.dataWidth, row.center + 0.5);
      ctx.stroke();
    }
    // Compact label: a colour key and the path's short name.
    ctx.fillStyle = row.color;
    ctx.beginPath();
    ctx.arc(9, row.center, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(row.label, 16, row.center + 3.5, GRAPH_GUTTER - 20);
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(scene.dataLeft - 1, GRAPH_RULER_HEIGHT, scene.dataWidth + 2, scene.height - GRAPH_RULER_HEIGHT);
  ctx.clip();
  for (const p of scene.prims) drawPrim(ctx, p);
  ctx.restore();
}
