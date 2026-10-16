/**
 * The cluster palette (fb-n1-bugs 2): clusters 0 and 9 were both red
 * (#e63946 / #dc3545) and two blue and two purple slots were near pairs.
 * The checks below are what the palette was chosen for: pairwise CIEDE2000
 * differences as drawn, as the projection map's translucent dots on the light
 * and dark surfaces, and under simulated colour-vision deficiencies.
 */
import { describe, expect, it } from 'vitest';
import { CLUSTER_COLORS, UNASSIGNED_CLUSTER_COLOR, UNASSIGNED_CLUSTER_ID, getClusterColor } from './constants';

type Rgb = [number, number, number];
type Lab = [number, number, number];

const hexToRgb = (hex: string): Rgb => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function rgbToLab(rgb: Rgb): Lab {
  const [r, g, b] = rgb.map(toLinear);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 (Sharma, Wu & Dalal 2005). */
function deltaE2000([L1, a1, b1]: Lab, [L2, a2, b2]: Lab): number {
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const ap1 = (1 + G) * a1, ap2 = (1 + G) * a2;
  const Cp1 = Math.hypot(ap1, b1), Cp2 = Math.hypot(ap2, b2);
  const hue = (b: number, a: number) => { if (a === 0 && b === 0) return 0; const h = Math.atan2(b, a) / rad; return h < 0 ? h + 360 : h; };
  const hp1 = hue(b1, ap1), hp2 = hue(b2, ap2);
  const dL = L2 - L1, dC = Cp2 - Cp1;
  let dh = 0;
  if (Cp1 * Cp2 !== 0) { dh = hp2 - hp1; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360; }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh * rad) / 2);
  const Lbar = (L1 + L2) / 2, Cpbar = (Cp1 + Cp2) / 2;
  let hbar = hp1 + hp2;
  if (Cp1 * Cp2 !== 0) {
    hbar = Math.abs(hp1 - hp2) > 180 ? (hp1 + hp2 < 360 ? (hp1 + hp2 + 360) / 2 : (hp1 + hp2 - 360) / 2) : (hp1 + hp2) / 2;
  }
  const T = 1 - 0.17 * Math.cos((hbar - 30) * rad) + 0.24 * Math.cos(2 * hbar * rad)
    + 0.32 * Math.cos((3 * hbar + 6) * rad) - 0.2 * Math.cos((4 * hbar - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbar - 275) / 25) ** 2));
  const RC = 2 * Math.sqrt(Cpbar ** 7 / (Cpbar ** 7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lbar - 50) ** 2) / Math.sqrt(20 + (Lbar - 50) ** 2);
  const SC = 1 + 0.045 * Cpbar, SH = 1 + 0.015 * Cpbar * T;
  const RT = -Math.sin(2 * dTheta * rad) * RC;
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}

/** Machado, Oliveira & Fernandes (2009), severity 1.0, applied in linear RGB. */
const CVD: Record<string, number[][]> = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
const simulate = (rgb: Rgb, m: number[][]): Rgb => {
  const lin = rgb.map(toLinear);
  return m.map(row => fromLinear(Math.min(1, Math.max(0, row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2])))) as Rgb;
};
const over = (rgb: Rgb, bg: Rgb, alpha: number): Rgb => rgb.map((c, i) => alpha * c + (1 - alpha) * bg[i]) as Rgb;

const LIGHT_SURFACE = '#ffffff';
const DARK_SURFACE = '#111827'; // the app's dark panels (gray-900)
const PRIMARY = CLUSTER_COLORS.slice(0, 12);

function minPairwise(colors: string[], toLab: (hex: string) => Lab) {
  let worst = { de: Infinity, pair: ['', ''] };
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      const de = deltaE2000(toLab(colors[i]), toLab(colors[j]));
      if (de < worst.de) worst = { de, pair: [colors[i], colors[j]] };
    }
  }
  return worst;
}

describe('CIEDE2000 implementation', () => {
  it('matches the published test pairs (Sharma et al. 2005)', () => {
    expect(deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 4);
    expect(deltaE2000([50, 2.5, 0], [73, 25, -18])).toBeCloseTo(27.1492, 4);
    expect(deltaE2000([2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514])).toBeCloseTo(0.9082, 4);
  });
});

describe('cluster palette', () => {
  it('is 6-digit lowercase hex without repeats (the read panel appends an alpha byte)', () => {
    for (const c of [...CLUSTER_COLORS, UNASSIGNED_CLUSTER_COLOR]) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(CLUSTER_COLORS).size).toBe(CLUSTER_COLORS.length);
    expect(CLUSTER_COLORS.length).toBeGreaterThanOrEqual(12);
  });

  it('first 12: every pair differs by ΔE2000 ≥ 20 as drawn', () => {
    const worst = minPairwise(PRIMARY, hex => rgbToLab(hexToRgb(hex)));
    expect(worst.de, worst.pair.join(' vs ')).toBeGreaterThanOrEqual(20);
  });

  it('first 12: ΔE2000 ≥ 15 as the projection map\'s 75%-opaque dots on the light and the dark surface', () => {
    for (const surface of [LIGHT_SURFACE, DARK_SURFACE]) {
      const worst = minPairwise(PRIMARY, hex => rgbToLab(over(hexToRgb(hex), hexToRgb(surface), 0.75)));
      expect(worst.de, `${surface}: ${worst.pair.join(' vs ')}`).toBeGreaterThanOrEqual(15);
    }
  });

  it('first 12: ΔE2000 ≥ 10 under protanopia, deuteranopia and tritanopia', () => {
    for (const [name, m] of Object.entries(CVD)) {
      const worst = minPairwise(PRIMARY, hex => rgbToLab(simulate(hexToRgb(hex), m)));
      expect(worst.de, `${name}: ${worst.pair.join(' vs ')}`).toBeGreaterThanOrEqual(10);
    }
  });

  it('every colour stands off both surfaces and the unassigned grey', () => {
    for (const c of CLUSTER_COLORS) {
      const lab = rgbToLab(hexToRgb(c));
      expect(deltaE2000(lab, rgbToLab(hexToRgb(LIGHT_SURFACE))), `${c} on light`).toBeGreaterThanOrEqual(25);
      expect(deltaE2000(lab, rgbToLab(hexToRgb(DARK_SURFACE))), `${c} on dark`).toBeGreaterThanOrEqual(25);
      expect(deltaE2000(lab, rgbToLab(hexToRgb(UNASSIGNED_CLUSTER_COLOR))), `${c} vs unassigned`).toBeGreaterThanOrEqual(14);
    }
  });

  it('keeps clear of the data-track landmarks (nucleosome green, TF sky-blue and fuchsia)', () => {
    const landmarks = ['#33a040', '#16a34a', '#87ceeb', '#e040fb'];
    for (const c of CLUSTER_COLORS) {
      for (const l of landmarks) {
        expect(deltaE2000(rgbToLab(hexToRgb(c)), rgbToLab(hexToRgb(l))), `${c} vs ${l}`).toBeGreaterThanOrEqual(10);
      }
    }
  });

  it('the extended colours stay apart from every other colour', () => {
    const worst = minPairwise([...CLUSTER_COLORS], hex => rgbToLab(hexToRgb(hex)));
    expect(worst.de, worst.pair.join(' vs ')).toBeGreaterThanOrEqual(15);
  });

  it('getClusterColor maps ids onto the palette (unassigned grey, wraps after the last)', () => {
    expect(getClusterColor(0)).toBe(CLUSTER_COLORS[0]);
    expect(getClusterColor(9)).toBe(CLUSTER_COLORS[9]);
    expect(getClusterColor(0)).not.toBe(getClusterColor(9));
    expect(getClusterColor(UNASSIGNED_CLUSTER_ID)).toBe(UNASSIGNED_CLUSTER_COLOR);
    expect(getClusterColor(CLUSTER_COLORS.length)).toBe(CLUSTER_COLORS[0]);
  });
});
