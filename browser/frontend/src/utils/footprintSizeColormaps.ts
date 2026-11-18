/**
 * Colormaps for the footprint size plots (the cells, the colour bar and every export draw through them).
 *
 * Defaults (utils/footprintSizeSettings DEFAULT_FOOTPRINT_SIZE_COLORMAPS): comparative plots (log2 ratios) use the
 * diverging RdBu_r centred on 0 (blue below, red above); single plots use a sequential map, magma for Size
 * enrichment (log2 or linear) and viridis, the colormap V-plots have always used, for the V-plot. Any colormap can
 * be picked for each; a diverging one keeps 0 (1x) at its white middle. Stops are 17 even samples of the
 * matplotlib colormaps of the same names, interpolated linearly.
 */
import { viridisRgb } from '../components/charts/viridis';

export type FootprintSizeColormap = 'viridis' | 'magma' | 'inferno' | 'plasma' | 'cividis' | 'greys' | 'rdbu_r';

export const FOOTPRINT_SIZE_COLORMAPS: readonly FootprintSizeColormap[] = [
  'magma', 'viridis', 'inferno', 'plasma', 'cividis', 'greys', 'rdbu_r',
];

export const FOOTPRINT_SIZE_COLORMAP_LABELS: Record<FootprintSizeColormap, string> = {
  viridis: 'Viridis (classic V-plot)',
  magma: 'Magma',
  inferno: 'Inferno',
  plasma: 'Plasma',
  cividis: 'Cividis',
  greys: 'Greys',
  rdbu_r: 'RdBu (diverging)',
};

export const isFootprintSizeColormap = (v: unknown): v is FootprintSizeColormap =>
  typeof v === 'string' && (FOOTPRINT_SIZE_COLORMAPS as readonly string[]).includes(v);

/** Diverging colormaps: their middle is the centre of the scale (0 on a signed scale), always. */
export const DIVERGING_COLORMAPS: ReadonlySet<FootprintSizeColormap> = new Set<FootprintSizeColormap>(['rdbu_r']);
export const isDivergingColormap = (name: FootprintSizeColormap): boolean => DIVERGING_COLORMAPS.has(name);

const STOPS: Record<Exclude<FootprintSizeColormap, 'viridis'>, string[]> = {
  magma: ['#000004', '#0a0822', '#1d1147', '#36106b', '#51127c', '#6a1c81', '#832681', '#9c2e7f', '#b73779', '#d0416f', '#e75263', '#f56b5c', '#fc8961', '#fea772', '#fec488', '#fde2a3', '#fcfdbf'],
  inferno: ['#000004', '#0b0724', '#210c4a', '#3d0965', '#57106e', '#71196e', '#8a226a', '#a32c61', '#bc3754', '#d24644', '#e45a31', '#f1731d', '#f98e09', '#fcac11', '#f9cb35', '#f2ea69', '#fcffa4'],
  plasma: ['#0d0887', '#310597', '#4c02a1', '#6600a7', '#7e03a8', '#9511a1', '#aa2395', '#bc3587', '#cc4778', '#da5a6a', '#e66c5c', '#f0804e', '#f89540', '#fdac33', '#fdc527', '#f8df25', '#f0f921'],
  cividis: ['#00224e', '#002e6a', '#1a386f', '#32436d', '#434e6c', '#535a6d', '#61656f', '#6f7073', '#7d7c78', '#8c8878', '#9b9476', '#aba072', '#bcae6c', '#cdbb63', '#dec958', '#f0d846', '#fee838'],
  // Low values light, high values dark (matplotlib's Greys).
  greys: ['#ffffff', '#f7f7f7', '#f0f0f0', '#e4e4e4', '#d9d9d9', '#cbcbcb', '#bdbdbd', '#a9a9a9', '#959595', '#848484', '#727272', '#626262', '#515151', '#3a3a3a', '#242424', '#111111', '#000000'],
  rdbu_r: ['#053061', '#175290', '#2a71b2', '#3f8ec0', '#6bacd1', '#9bc9e0', '#c2ddec', '#e0ecf3', '#f7f6f6', '#fbe5d8', '#fbccb4', '#f5aa89', '#e48066', '#d05548', '#ba2832', '#930e26', '#67001f'],
};

type Rgb = [number, number, number];
const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const PARSED: Partial<Record<string, Rgb[]>> = {};

/** A named colormap's colour at u in 0..1 (clamped; NaN is the low end). */
export function colormapRgb(name: FootprintSizeColormap, u: number): Rgb {
  const t = Number.isFinite(u) ? Math.min(1, Math.max(0, u)) : u === Number.POSITIVE_INFINITY ? 1 : 0;
  if (name === 'viridis') return viridisRgb(t);
  const stops = PARSED[name] ?? (PARSED[name] = STOPS[name].map(hex));
  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i], b = stops[i + 1];
  return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)];
}
