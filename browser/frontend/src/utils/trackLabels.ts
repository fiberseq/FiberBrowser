/** How a track draws its label and hints over the data (see TrackLabelsProvider). */
export interface TrackLabelOptions {
  /** Clean view: draw no labels or hints over the data. */
  clean: boolean;
  /** Draw shown labels on a small translucent pill so they separate from the data under them. */
  pill: boolean;
}

function fontPx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? Number(m[1]) : 10;
}

/**
 * Draw a track label (or a hint such as "No genes in region") at (x, y), the
 * text baseline, in the context's current font, fill colour and alignment.
 * Nothing in Clean view; on a translucent pill when `pill` is set.
 */
export function drawTrackLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, opts: TrackLabelOptions): void {
  if (opts.clean || !text) return;
  if (opts.pill) {
    const size = fontPx(ctx.font);
    const w = ctx.measureText(text).width;
    const align = ctx.textAlign;
    const left = align === 'center' ? x - w / 2 : align === 'right' || align === 'end' ? x - w : x;
    const padX = 3;
    const top = y - size + 0.5 - 1.5;
    const h = size + 3;
    const ink = ctx.fillStyle;
    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const r = 3;
    const bx = left - padX;
    const bw = w + padX * 2;
    if (typeof ctx.roundRect === 'function') ctx.roundRect(bx, top, bw, h, r);
    else ctx.rect(bx, top, bw, h);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = ink;
  }
  ctx.fillText(text, x, y);
}
