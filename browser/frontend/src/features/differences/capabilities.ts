export interface AlternateGeometry { ref_bp: number; alt_bp: number }
export const ALTERNATE_LAYOUT_VERSION = 'boundary-aligned:v1';
export function expandableAltBlock(g: AlternateGeometry): boolean {
  const { ref_bp: r, alt_bp: a } = g;
  return a >= 50 && a <= 50_000 && (r === 0 || a > r && (a - r >= 50 || r <= Math.min(50, .25 * a)));
}
