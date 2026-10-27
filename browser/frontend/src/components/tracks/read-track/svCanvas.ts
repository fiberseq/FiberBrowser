/**
 * Canvas drawing of SVs (fb-n9-sv): the summary band above a panel's reads
 * and the per-read marks (deletion connector, insertion flag, clip marker).
 * The decisions are in svDrawing.ts; this only paints. Everything goes
 * through the read canvas, so figure/SVG/PDF exports draw it the same way.
 */
import type { SvSummary } from './types';
import {
  SV_COLORS,
  arcHeight,
  clusterPixelSpan,
  clusterSupportLabel,
  formatSvSize,
  isMinorCluster,
  labelFits,
  placeSvLabels,
  type SvLabelCandidate,
  rowLabelFontPx,
  svBandMetrics,
  type ReadSvDraw,
} from './svDrawing';

type Ctx = CanvasRenderingContext2D;

export interface SvBandOptions {
  top: number;
  height: number;
  width: number;
  sidebarWidth: number;
  viewStart: number;
  toX: (rel: number) => number;
  selectedId?: string | null;
  /** Clusters in the feature selection (shift-click; utils/svFeatures.ts): drawn as selected too. */
  isFeatureSelected?: (c: { t: 'D' | 'I'; ref: number; len: number }) => boolean;
  /** The cluster under the pointer: drawn with a halo. */
  hoverId?: string | null;
  isReversed: boolean;
  /** Painted behind labels so they stay legible over arcs. */
  backgroundColor: string;
  /** The display is a sample of the reads in view (counts still cover them all). */
  sampled?: boolean;
}

function labelWithBackground(ctx: Ctx, text: string, x: number, y: number, align: CanvasTextAlign, fontPx: number, color: string, bg: string) {
  ctx.font = `${fontPx}px sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width;
  const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = bg;
  ctx.fillRect(left - 1.5, y - fontPx / 2 - 1, w + 3, fontPx + 2);
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.textBaseline = 'alphabetic';
}

/**
 * The SV track: deletion arcs, insertion flags, clip pile ticks. Everything
 * scales with the row's height (svBandMetrics): arcs rise to the label room,
 * flags, ticks and labels grow with it. Faint (weak) clusters are drawn lighter
 * but at the same size class, so they stay visible and easy to hover.
 */
export function drawSvBand(ctx: Ctx, summary: SvSummary, o: SvBandOptions): void {
  const { top, height, width, sidebarWidth, viewStart, toX } = o;
  const m = svBandMetrics(height);
  ctx.save();
  ctx.beginPath();
  ctx.rect(sidebarWidth, top, Math.max(0, width - sidebarWidth), height);
  ctx.clip();
  ctx.strokeStyle = SV_COLORS.text;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(sidebarWidth, top + height - 0.5);
  ctx.lineTo(width, top + height - 0.5);
  ctx.stroke();
  ctx.globalAlpha = 1;
  const caption = `Differences${summary.scope === 'loaded' ? ' · in loaded reads' : ''}`;
  const base = top + height - 3;
  const inner = m.inner;
  const maxSupport = Math.max(1, ...summary.clusters.map(c => c.support));
  // Clip piles first (under the arcs): ticks at the baseline, by pile size.
  for (const pile of summary.clips) {
    const x = toX(pile.ref - viewStart);
    const h = Math.min(m.clipMax, 2 + pile.n * (m.clipMax / 8));
    const dir = (pile.side === 'L' ? -1 : 1) * (o.isReversed ? -1 : 1);
    ctx.strokeStyle = SV_COLORS.clip;
    ctx.lineWidth = m.lineWidth;
    ctx.beginPath();
    ctx.moveTo(x, base);
    ctx.lineTo(x, base - h);
    ctx.lineTo(x + dir * Math.max(3, m.flagW / 2), base - h);
    ctx.stroke();
  }
  // Wider arcs first, so narrower ones stay on top; labels go on after all
  // the marks, strongest first and never over one another (placeSvLabels).
  const ordered = [...summary.clusters].sort((a, b) => (b.end - b.ref) - (a.end - a.ref));
  const labels: SvLabelCandidate[] = [];
  for (const c of ordered) {
    const selected = o.selectedId === c.id || Boolean(o.isFeatureSelected?.(c));
    const hovered = o.hoverId === c.id;
    const color = selected ? SV_COLORS.selected : c.t === 'D' ? SV_COLORS.deletion : SV_COLORS.insertion;
    const minor = !selected && !hovered && isMinorCluster(c.support, maxSupport);
    const h = arcHeight(c, maxSupport, inner);
    const text = `${formatSvSize(c.t, c.len)} ${clusterSupportLabel(c)}`;
    const priority = (selected ? 1e12 : 0) + (hovered ? 1e11 : 0) + c.support;
    const lw = selected ? m.lineWidth + 1 : minor ? Math.max(1.25, m.lineWidth - 0.25) : m.lineWidth;
    const path = () => {
      ctx.beginPath();
      if (c.t === 'D') {
        const [x1, x2] = clusterPixelSpan(c, viewStart, toX);
        const apex = base - h;
        if (x2 - x1 < 4) {
          ctx.moveTo(x1, base);
          ctx.lineTo(x1, apex);
        } else {
          ctx.moveTo(x1, base);
          // A cubic arc whose top reaches `apex`.
          ctx.bezierCurveTo(x1, apex - h / 3, x2, apex - h / 3, x2, base);
        }
      } else {
        const x = toX(c.ref - viewStart);
        ctx.moveTo(x, base);
        ctx.lineTo(x, base - h);
      }
    };
    if (hovered) {
      // A halo under the hovered glyph.
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = color;
      ctx.lineWidth = lw + 5;
      path();
      ctx.stroke();
    }
    ctx.globalAlpha = minor ? 0.55 : 1;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = hovered ? lw + 0.75 : lw;
    path();
    ctx.stroke();
    if (c.t === 'D') {
      const [x1, x2] = clusterPixelSpan(c, viewStart, toX);
      const apex = base - h;
      const mid = (x1 + x2) / 2;
      const texts = [
        labelFits(text, x2 - x1, m.labelPx * 0.6) ? text : '',
        labelFits(clusterSupportLabel(c), Math.max(x2 - x1, 28), m.labelPx * 0.6) ? clusterSupportLabel(c) : '',
      ];
      if (!minor) labels.push({ texts, x: mid, y: Math.max(top + m.labelPx / 2 + 1, apex - m.labelPx / 2 - 1), align: 'center', priority, color });
    } else {
      const x = toX(c.ref - viewStart);
      const flagTop = base - h;
      const dir = o.isReversed ? -1 : 1;
      ctx.beginPath();
      ctx.moveTo(x, flagTop);
      ctx.lineTo(x + dir * m.flagW, flagTop + m.flagH / 2);
      ctx.lineTo(x, flagTop + m.flagH);
      ctx.closePath();
      ctx.fill();
      if (!minor) {
        labels.push({ texts: [text, clusterSupportLabel(c)], x: x + dir * (m.flagW + 2), y: flagTop + m.flagH / 2, align: dir > 0 ? 'left' : 'right', priority, color });
      }
    }
  }
  ctx.globalAlpha = 1;
  ctx.font = `${m.labelPx}px sans-serif`;
  const measure = (t: string) => ctx.measureText(t).width;
  // The caption's corner is taken.
  const captionWidth = (() => { ctx.font = `${m.captionPx}px sans-serif`; const w = ctx.measureText(caption).width; ctx.font = `${m.labelPx}px sans-serif`; return w; })();
  const captionY = top + m.captionPx / 2 + 2;
  labels.push({ texts: [caption], x: sidebarWidth + 3, y: captionY, align: 'left', priority: 1e15, color: '' });
  for (const l of placeSvLabels(labels, t => (t === caption ? captionWidth : measure(t)), m.labelPx)) {
    if (l.text === caption && !l.color) continue;
    labelWithBackground(ctx, l.text, l.x, l.y, l.align, m.labelPx, l.color, o.backgroundColor);
  }
  labelWithBackground(ctx, caption, sidebarWidth + 3, captionY, 'left', m.captionPx, SV_COLORS.text, o.backgroundColor);
  ctx.restore();
}

export interface ReadSvMarkOptions {
  y: number;
  rowHeight: number;
  toX: (rel: number) => number;
  isReversed: boolean;
  /** Behind labels on the read body (insertions). */
  backgroundColor: string;
  /** Behind labels in a deleted span (the panel's empty background). */
  gapColor?: string;
}

/** A read's SV marks, over its (already broken) body. */
export function drawReadSvMarks(ctx: Ctx, sv: ReadSvDraw, o: ReadSvMarkOptions): void {
  const { y, rowHeight, toX } = o;
  if (rowHeight <= 0) return;
  const midY = y + rowHeight / 2;
  const fontPx = rowLabelFontPx(rowHeight);
  for (const d of sv.deletions) {
    const xa = toX(d.start);
    const xb = toX(d.end);
    const x1 = Math.min(xa, xb);
    const x2 = Math.max(xa, xb);
    ctx.strokeStyle = SV_COLORS.connector;
    ctx.lineWidth = rowHeight >= 6 ? 1 : 0.75;
    ctx.beginPath();
    ctx.moveTo(x1, midY);
    ctx.lineTo(x2, midY);
    ctx.stroke();
    const text = formatSvSize('D', d.len);
    if (fontPx > 0 && labelFits(text, x2 - x1, fontPx * 0.56)) {
      labelWithBackground(ctx, text, (x1 + x2) / 2, midY, 'center', fontPx, SV_COLORS.connector, o.gapColor ?? o.backgroundColor);
    }
  }
  for (const ins of sv.insertions) {
    const x = toX(ins.pos);
    ctx.fillStyle = SV_COLORS.insertion;
    ctx.fillRect(x - 1, y, 2, rowHeight);
    if (rowHeight >= 5) {
      const dir = o.isReversed ? -1 : 1;
      const fh = Math.min(5, rowHeight / 2);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + dir * 5, y + fh / 2);
      ctx.lineTo(x, y + fh);
      ctx.closePath();
      ctx.fill();
      if (fontPx > 0) {
        labelWithBackground(ctx, formatSvSize('I', ins.len), x + dir * 6, midY, dir > 0 ? 'left' : 'right', fontPx, SV_COLORS.insertion, o.backgroundColor);
      }
    }
  }
  for (const clip of sv.clips) {
    const x = toX(clip.pos);
    const dir = (clip.side === 'L' ? -1 : 1) * (o.isReversed ? -1 : 1);
    ctx.strokeStyle = SV_COLORS.clip;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + rowHeight);
    if (rowHeight >= 4) {
      ctx.moveTo(x, y + rowHeight / 2);
      ctx.lineTo(x + dir * 4, y + rowHeight / 2);
    }
    ctx.stroke();
  }
}
