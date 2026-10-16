/**
 * Viridis colormap lookup table and helper.
 * 256 entries interpolated from 10 control points (matching server.py).
 */

const CONTROL_POINTS: [number, number, number][] = [
  [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142],
  [38, 130, 142], [31, 158, 137], [53, 183, 121], [110, 206, 88],
  [181, 222, 43], [253, 231, 37],
];

function buildLUT(): [number, number, number][] {
  const lut: [number, number, number][] = [];
  const n = CONTROL_POINTS.length;
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const idx = Math.min(Math.floor(t * (n - 1)), n - 2);
    const frac = t * (n - 1) - idx;
    const c0 = CONTROL_POINTS[idx];
    const c1 = CONTROL_POINTS[idx + 1];
    lut.push([
      Math.round(c0[0] + frac * (c1[0] - c0[0])),
      Math.round(c0[1] + frac * (c1[1] - c0[1])),
      Math.round(c0[2] + frac * (c1[2] - c0[2])),
    ]);
  }
  return lut;
}

export const VIRIDIS_LUT: [number, number, number][] = buildLUT();

/** Map a value in [0,1] to an RGB tuple via the viridis colormap. */
export function viridisRgb(t: number): [number, number, number] {
  const idx = Math.max(0, Math.min(255, Math.round(t * 255)));
  return VIRIDIS_LUT[idx];
}
