/**
 * Colour distance for palette checks: CIE76 ΔE in CIELAB (D65), the measure the extra-layer palette was chosen with
 * (utils/layerColors EXTRA_LAYER_PALETTE: every pair ≥ ~26 apart), plus the same under simulated deuteranopia and
 * protanopia (Viénot 1999), so two layers that only a colour-blind viewer would confuse are caught too.
 */
type Rgb = [number, number, number];

function hexRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255) as Rgb;
}

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function labOfLinear([r, g, b]: Rgb): Rgb {
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIELAB of a #rrggbb colour (null when it is not one). */
export function hexToLab(hex: string): Rgb | null {
  const rgb = hexRgb(hex);
  return rgb ? labOfLinear(rgb.map(lin) as Rgb) : null;
}

/** CIE76 ΔE between two #rrggbb colours (Infinity when either is not one). */
export function deltaE(a: string, b: string): number {
  const la = hexToLab(a), lb = hexToLab(b);
  if (!la || !lb) return Infinity;
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}

export type ColorVision = 'normal' | 'deuteranopia' | 'protanopia';

// Viénot, Brettel & Mollon (1999) dichromat simulation, in linear RGB.
const SIM: Record<Exclude<ColorVision, 'normal'>, number[]> = {
  protanopia: [0.11238, 0.88762, 0, 0.11238, 0.88762, 0, 0.00401, -0.00401, 1],
  deuteranopia: [0.29275, 0.70725, 0, 0.29275, 0.70725, 0, -0.02234, 0.02234, 1],
};

function simulate(hex: string, vision: ColorVision): Rgb | null {
  const rgb = hexRgb(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map(lin);
  if (vision === 'normal') return labOfLinear([r, g, b]);
  const m = SIM[vision];
  const c = (v: number) => Math.max(0, Math.min(1, v));
  return labOfLinear([c(m[0] * r + m[1] * g + m[2] * b), c(m[3] * r + m[4] * g + m[5] * b), c(m[6] * r + m[7] * g + m[8] * b)]);
}

/** The smallest ΔE between two colours over normal vision and the simulated dichromacies, and where it falls. */
export function worstDeltaE(a: string, b: string, visions: readonly ColorVision[] = ['normal', 'deuteranopia', 'protanopia']): { deltaE: number; vision: ColorVision } {
  let worst = { deltaE: Infinity, vision: 'normal' as ColorVision };
  for (const vision of visions) {
    const la = simulate(a, vision), lb = simulate(b, vision);
    if (!la || !lb) continue;
    const d = Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
    if (d < worst.deltaE) worst = { deltaE: d, vision };
  }
  return worst;
}

export interface SimilarColorPair<K extends string = string> {
  a: K;
  b: K;
  deltaE: number;
  vision: ColorVision;
}

/**
 * Pairs of entries whose colours are nearly identical (ΔE below `threshold` for normal vision, or below
 * `dichromatThreshold` under a simulated dichromacy). Defaults: 10 and 6 — well under the palette's own spacing
 * (≥ 26 normal, ≥ 16 simulated), so only genuinely confusable choices are flagged.
 */
export function similarColorPairs<K extends string>(
  entries: ReadonlyArray<{ key: K; color: string }>,
  { threshold = 10, dichromatThreshold = 6 }: { threshold?: number; dichromatThreshold?: number } = {},
): SimilarColorPair<K>[] {
  const out: SimilarColorPair<K>[] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i], b = entries[j];
      const normal = worstDeltaE(a.color, b.color, ['normal']);
      if (normal.deltaE < threshold) { out.push({ a: a.key, b: b.key, ...normal }); continue; }
      const cvd = worstDeltaE(a.color, b.color, ['deuteranopia', 'protanopia']);
      if (cvd.deltaE < dichromatThreshold) out.push({ a: a.key, b: b.key, ...cvd });
    }
  }
  return out;
}
