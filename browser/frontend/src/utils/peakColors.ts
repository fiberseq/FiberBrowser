// Peak rule color utilities — generate layer-shaded colors from a base hex color

export interface LayerColor {
  fill: string;   // rgba fill
  stroke: string;  // hex stroke
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

function hexToHsl(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map(v => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * Math.max(0, Math.min(1, color)));
  };
  return `#${[f(0), f(8), f(4)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

function hexToRgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Generate 4 layer colors from a base hex color.
 * If useGradient is true, produces dark→light lightness steps.
 * If false, all layers get the same color at the given opacity.
 */
export function generateLayerColors(baseHex: string, opacity: number, useGradient: boolean): LayerColor[] {
  if (!useGradient) {
    const fill = hexToRgba(baseHex, opacity);
    return Array(4).fill({ fill, stroke: baseHex });
  }

  const [h, s, l] = hexToHsl(baseHex);
  const steps = [
    { opacityMult: 0.85, lightnessShift: -10 },  // darkest (strong)
    { opacityMult: 0.70, lightnessShift: 0 },     // base (medium)
    { opacityMult: 0.55, lightnessShift: 15 },    // lighter (weak)
    { opacityMult: 0.40, lightnessShift: 25 },    // lightest (rare)
  ];

  return steps.map(({ opacityMult, lightnessShift }) => {
    const newL = Math.max(0, Math.min(1, l + lightnessShift / 100));
    const strokeHex = hslToHex(h, s, newL);
    return {
      fill: hexToRgba(strokeHex, opacity * opacityMult),
      stroke: strokeHex,
    };
  });
}
