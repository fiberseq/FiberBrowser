const POINTS_PER_PIXEL = 1.5;
const STEPPED_POINT_DENSITY = 0.75;

function finiteValue(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function signalPointLimit(pixelWidth: number): number {
  const width = Number.isFinite(pixelWidth) ? pixelWidth : 1;
  return Math.max(2, Math.ceil(Math.max(1, width) * POINTS_PER_PIXEL));
}

export function shouldDrawSteppedSignal(pointCount: number, pixelWidth: number): boolean {
  const width = Number.isFinite(pixelWidth) ? pixelWidth : 1;
  return pointCount > 0 && pointCount < Math.max(1, width) * STEPPED_POINT_DENSITY;
}

export function reduceSignalValues(values: number[], maxPoints: number, reversed = false): number[] {
  const len = values.length;
  if (len === 0) return [];

  const limit = Number.isFinite(maxPoints) ? Math.max(1, Math.floor(maxPoints)) : len;
  if (len <= limit) {
    if (!reversed) return values;
    const out = new Array<number>(len);
    for (let i = 0; i < len; i++) {
      out[i] = finiteValue(values[len - 1 - i]);
    }
    return out;
  }

  const out = new Array<number>(limit);
  const sourcePerOutput = len / limit;
  for (let i = 0; i < limit; i++) {
    const start = Math.floor(i * sourcePerOutput);
    const end = Math.max(start + 1, Math.min(len, Math.floor((i + 1) * sourcePerOutput)));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      const sourceIndex = reversed ? (len - 1 - j) : j;
      sum += finiteValue(values[sourceIndex]);
      count++;
    }
    out[i] = count > 0 ? sum / count : 0;
  }
  return out;
}
