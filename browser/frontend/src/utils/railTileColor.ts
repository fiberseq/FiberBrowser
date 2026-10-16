/**
 * The sidebar rail's launcher tiles are filled with their panel's colour and
 * carry a white icon. Some panel colours are too light for a white icon
 * (Footprints #10b981 is 2.5:1), so a tile takes the colour darkened just
 * enough for 4.5:1: the hue (the landmark) stays, only the shade moves. The
 * same shade serves both themes (white-on-tile contrast doesn't depend on the
 * page); in dark mode a hairline ring keeps the darkest tiles off the rail.
 */

function channels(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1];
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast of white on this colour (1–21). */
export function whiteContrast(hex: string): number {
  const c = channels(hex);
  if (!c) return 1;
  return 1.05 / (luminance(c) + 0.05);
}

const toHex = (c: [number, number, number]) => `#${c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** The colour, darkened in 2 % steps until white on it reaches `min` (4.5:1 by default). */
export function railTileColor(hex: string, min = 4.5): string {
  const c = channels(hex);
  if (!c) return '#475569';
  for (let f = 0; f <= 1.0001; f += 0.02) {
    const shade = c.map(v => Math.round(v * (1 - f))) as [number, number, number];
    if (1.05 / (luminance(shade) + 0.05) >= min) return toHex(shade);
  }
  return '#000000';
}
