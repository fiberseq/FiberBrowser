/** Wheel devices report pixels, lines or pages. Keep fractional trackpad motion. */
export function wheelDelta(e: { deltaY: number; deltaX: number; deltaMode: number; shiftKey: boolean }, pageHeight = 800): number {
  const delta = e.shiftKey && Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  const pixels = delta * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? pageHeight : 1);
  return Number.isFinite(pixels) ? pixels : 0;
}

/** Positive delta widens the genomic window; a single mouse notch stays gentle. */
export function wheelLogFactor(delta: number): number {
  return Math.max(-0.18, Math.min(0.18, delta * 0.002));
}
