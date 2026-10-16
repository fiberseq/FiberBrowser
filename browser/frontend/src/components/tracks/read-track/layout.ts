export interface ReadTrackLayout {
  trackHeight: number;
  autoRowHeight: number;
  rowHeight: number;
  rowGap: number;
  totalContentHeight: number;
  needsScroll: boolean;
  maxScrollOffset: number;
  clampedScrollOffset: number;
  scrollAdjust: number;
}

export type ReadSeparatorMode = 'auto' | 'fixed' | 'off';

export function computeReadRowGap(
  rowHeight: number,
  separatorMode: ReadSeparatorMode = 'auto',
  separatorMinHeight: number = 3,
  separatorWidth: number = 1,
): number {
  if (separatorMode === 'off') return 0;
  if (rowHeight < Math.max(0, Number(separatorMinHeight) || 0)) return 0;
  if (separatorMode === 'fixed') {
    return Math.max(0, Math.min(10, Math.max(0, rowHeight - 0.5), Number(separatorWidth) || 0));
  }
  if (rowHeight < 3) return 0.5;
  if (rowHeight < 6) return 0.5;
  if (rowHeight < 9) return 1;
  if (rowHeight < 12) return 1.5;
  if (rowHeight < 16) return 2;
  return 3;
}

export function shouldDrawReadBoundaryLines(
  readCount: number,
  rowHeight: number,
  separatorMode: ReadSeparatorMode,
): boolean {
  return readCount <= 50 && rowHeight >= 6 && separatorMode !== 'off';
}

/**
 * The row height one Cmd/Ctrl-wheel step leads to. Zooming out returns to
 * automatic sizing only once it reaches the height automatic sizing would fit
 * (`autoFitHeight`, from an 'auto' layout), so a fixed height can be eased
 * down step by step instead of snapping to auto on the first step.
 */
export function nextReadRowHeight(
  current: number | 'auto',
  autoFitHeight: number,
  deltaY: number,
): number | 'auto' {
  const from = current === 'auto' ? autoFitHeight : current;
  const next = from * (deltaY > 0 ? 0.85 : 1.18);
  if (deltaY > 0 && next <= autoFitHeight) return 'auto';
  return Math.max(1, Math.min(99, next));
}

export function computeReadTrackLayout(
  n: number,
  height: number,
  headerHeight: number,
  histogramHeight: number,
  fillReadHeight: boolean,
  storeReadRowHeight: number | 'auto',
  readScrollOffset: number,
  separatorMode: ReadSeparatorMode = 'auto',
  separatorMinHeight: number = 3,
  separatorWidth: number = 1,
): ReadTrackLayout {
  const trackHeight = Math.max(0, height - headerHeight - histogramHeight);
  const safeN = Math.max(1, n);

  if (storeReadRowHeight === 'auto') {
    const fittedRowHeight = trackHeight > 0 ? trackHeight / safeN : 1;
    const maxAutoRowHeight = fillReadHeight ? Number.POSITIVE_INFINITY : 5;
    const autoRowHeight = Math.max(0.5, Math.min(maxAutoRowHeight, fittedRowHeight));
    const totalContentHeight = n * autoRowHeight;
    // At the minimum row height more reads than fit: scroll to the rest.
    const needsScroll = totalContentHeight > trackHeight + 1e-7;
    const maxScrollOffset = needsScroll ? totalContentHeight - trackHeight : 0;
    const clampedScrollOffset = Math.min(Math.max(0, readScrollOffset), maxScrollOffset);
    return {
      trackHeight,
      autoRowHeight,
      rowHeight: autoRowHeight,
      rowGap: 0,
      totalContentHeight,
      needsScroll,
      maxScrollOffset,
      clampedScrollOffset,
      scrollAdjust: needsScroll ? clampedScrollOffset : 0,
    };
  }

  const baseRowHeight = Math.max(0.5, Number(storeReadRowHeight) || 1);
  let rowHeight = baseRowHeight;
  if (fillReadHeight && n > 0 && trackHeight > 0) {
    const baseRowGap = computeReadRowGap(baseRowHeight, separatorMode, separatorMinHeight, separatorWidth);
    const baseTotalContentHeight = n * (baseRowHeight + baseRowGap);
    if (baseTotalContentHeight < trackHeight) {
      // Gap sizes jump at row-height thresholds. Fixed-point iteration can
      // oscillate across those jumps and finish with MORE than the available
      // space. Search monotonically, retaining only a known-fitting lower bound.
      let lo = baseRowHeight;
      let hi = trackHeight / safeN;
      for (let i = 0; i < 48; i++) {
        const mid = (lo + hi) / 2;
        const gap = computeReadRowGap(mid, separatorMode, separatorMinHeight, separatorWidth);
        if (n * (mid + gap) <= trackHeight) lo = mid;
        else hi = mid;
      }
      rowHeight = lo;
    }
  }
  const rowGap = computeReadRowGap(rowHeight, separatorMode, separatorMinHeight, separatorWidth);
  const totalContentHeight = n * (rowHeight + rowGap);
  const needsScroll = totalContentHeight > trackHeight + 1e-7;
  const maxScrollOffset = Math.max(0, totalContentHeight - trackHeight);
  const clampedScrollOffset = Math.min(Math.max(0, readScrollOffset), maxScrollOffset);
  const scrollAdjust = needsScroll ? clampedScrollOffset : 0;

  return {
    trackHeight,
    autoRowHeight: rowHeight,
    rowHeight,
    rowGap,
    totalContentHeight,
    needsScroll,
    maxScrollOffset,
    clampedScrollOffset,
    scrollAdjust,
  };
}
