import type { ColorRule, ColorRuleColorMode, ColorRuleGradient, ColorRuleGradientScale } from '../types';

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export const COLOR_RULE_GRADIENT_SCALE_OPTIONS: Array<{
  value: ColorRuleGradientScale;
  label: string;
}> = [
  { value: 'linear', label: 'Linear' },
  { value: 'sqrt', label: 'Sqrt' },
  { value: 'log', label: 'Log' },
  { value: 'square', label: 'Square' },
];

export const RECENT_RULE_COLORS_STORAGE_KEY = 'fiberbrowser_recent_rule_colors';
export const RECENT_RULE_COLORS_UPDATED_EVENT = 'fiberbrowser:recent-rule-colors-updated';
const RECENT_RULE_COLOR_LIMIT = 14;

export function normalizeRuleHexColor(value: unknown, fallback = '#888888'): string {
  return typeof value === 'string' && HEX_COLOR_RE.test(value) ? value.toLowerCase() : fallback;
}

export function normalizeRuleColorMode(value: unknown): ColorRuleColorMode {
  return value === 'size_gradient' || value === 'gradient' ? 'size_gradient' : 'solid';
}

export function normalizeRuleGradientScale(value: unknown): ColorRuleGradientScale {
  return COLOR_RULE_GRADIENT_SCALE_OPTIONS.some(option => option.value === value)
    ? value as ColorRuleGradientScale
    : 'linear';
}

export function normalizeRuleGradient(
  value: unknown,
  fallbackColor: string,
  fallbackSizeMin?: number | null,
  fallbackSizeMax?: number | null,
): ColorRuleGradient {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const normalizeGradientSize = (rawValue: unknown, fallback: number | null | undefined, present: boolean): number | null => {
    if (!present) return fallback == null ? null : Math.max(0, Number(fallback) || 0);
    if (rawValue == null || rawValue === '' || rawValue === '∞') {
      return null;
    }
    const numeric = typeof rawValue === 'number' ? rawValue : Number(rawValue);
    if (!Number.isFinite(numeric)) return fallback == null ? null : Math.max(0, Number(fallback) || 0);
    return Math.max(0, numeric);
  };
  const hasSizeMin = Object.prototype.hasOwnProperty.call(raw, 'sizeMin')
    || Object.prototype.hasOwnProperty.call(raw, 'size_min');
  const hasSizeMax = Object.prototype.hasOwnProperty.call(raw, 'sizeMax')
    || Object.prototype.hasOwnProperty.call(raw, 'size_max');
  return {
    startColor: normalizeRuleHexColor(raw.startColor ?? raw.start_color, fallbackColor),
    endColor: normalizeRuleHexColor(raw.endColor ?? raw.end_color, fallbackColor),
    sizeMin: normalizeGradientSize(raw.sizeMin ?? raw.size_min, fallbackSizeMin, hasSizeMin),
    sizeMax: normalizeGradientSize(raw.sizeMax ?? raw.size_max, fallbackSizeMax, hasSizeMax),
    scale: normalizeRuleGradientScale(raw.scale),
  };
}

export function normalizeRuleColorVisuals(
  raw: Partial<ColorRule> & Record<string, unknown>,
  fallbackColor = '#888888',
): Pick<ColorRule, 'color' | 'colorMode' | 'gradient'> {
  const color = normalizeRuleHexColor(raw.color, fallbackColor);
  const rawGradient = raw.gradient && typeof raw.gradient === 'object'
    ? raw.gradient as unknown as Record<string, unknown>
    : undefined;
  const legacyGradientEnabled = rawGradient?.enabled === true || raw.useGradient === true || raw.use_gradient === true;
  const colorMode = normalizeRuleColorMode(raw.colorMode ?? raw.color_mode ?? (legacyGradientEnabled ? 'size_gradient' : undefined));
  const sizeMin = raw.sizeMin ?? raw.size_min;
  const sizeMax = raw.sizeMax ?? raw.size_max;
  const gradient = normalizeRuleGradient(
    raw.gradient,
    color,
    sizeMin == null ? undefined : Number(sizeMin),
    sizeMax == null || sizeMax === '' ? null : Number(sizeMax),
  );

  return {
    color,
    colorMode,
    ...((colorMode === 'size_gradient' || rawGradient) ? { gradient } : {}),
  };
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function scaleGradientValue(value: number, scale: ColorRuleGradientScale): number {
  const t = clampUnit(value);
  if (scale === 'sqrt') return Math.sqrt(t);
  if (scale === 'log') return Math.log1p(9 * t) / Math.log(10);
  if (scale === 'square') return t * t;
  return t;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = normalizeRuleHexColor(hex);
  return [
    parseInt(normalized.slice(1, 3), 16),
    parseInt(normalized.slice(3, 5), 16),
    parseInt(normalized.slice(5, 7), 16),
  ];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map(channel => (
    Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0')
  )).join('')}`;
}

function interpolateRgbColor(
  start: [number, number, number],
  end: [number, number, number],
  value: number,
): string {
  const t = clampUnit(value);
  return rgbToHex([
    start[0] + (end[0] - start[0]) * t,
    start[1] + (end[1] - start[1]) * t,
    start[2] + (end[2] - start[2]) * t,
  ]);
}

export function interpolateHexColor(startColor: string, endColor: string, value: number): string {
  const start = hexToRgb(startColor);
  const end = hexToRgb(endColor);
  return interpolateRgbColor(start, end, value);
}

export function buildRuleColorResolver(rule: ColorRule): (size: number) => string {
  const color = normalizeRuleHexColor(rule.color);
  if ((rule.colorMode ?? 'solid') !== 'size_gradient') {
    return () => color;
  }

  const gradient = normalizeRuleGradient(rule.gradient, color, rule.sizeMin, rule.sizeMax);
  const min = Number(gradient.sizeMin ?? rule.sizeMin);
  const max = gradient.sizeMax == null ? null : Number(gradient.sizeMax);
  const startColor = normalizeRuleHexColor(gradient.startColor, color);
  const startRgb = hexToRgb(startColor);
  const endRgb = hexToRgb(gradient.endColor);
  const scale = gradient.scale;

  if (!Number.isFinite(min) || max == null || !Number.isFinite(max) || max <= min) {
    return () => startColor;
  }

  return (size: number) => {
    if (!Number.isFinite(size)) return startColor;
    const rawT = (size - min) / (max - min);
    const scaledT = scaleGradientValue(rawT, scale);
    return interpolateRgbColor(startRgb, endRgb, scaledT);
  };
}

export function getRuleColorForSize(rule: ColorRule, size: number): string {
  return buildRuleColorResolver(rule)(size);
}

export function loadRecentRuleColors(): string[] {
  try {
    const stored = localStorage.getItem(RECENT_RULE_COLORS_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(color => normalizeRuleHexColor(color, ''))
      .filter((color): color is string => HEX_COLOR_RE.test(color))
      .slice(0, RECENT_RULE_COLOR_LIMIT);
  } catch {
    return [];
  }
}

export function saveRecentRuleColor(color: string): string[] {
  const normalized = normalizeRuleHexColor(color, '');
  if (!HEX_COLOR_RE.test(normalized)) return loadRecentRuleColors();
  const next = [
    normalized,
    ...loadRecentRuleColors().filter(existing => existing !== normalized),
  ].slice(0, RECENT_RULE_COLOR_LIMIT);
  try {
    localStorage.setItem(RECENT_RULE_COLORS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Color history is a convenience; ignore storage failures.
  }
  try {
    window.dispatchEvent(new CustomEvent(RECENT_RULE_COLORS_UPDATED_EVENT, { detail: next }));
  } catch {
    // No window in some test environments.
  }
  return next;
}
