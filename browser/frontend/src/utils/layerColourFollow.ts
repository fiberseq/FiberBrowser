/**
 * The colormap as drawn, with the user's layer colours (utils/layerColors getLayerColorOverride) applied to the
 * built-in rules and the TF overlay that still hold their stock colour: the default footprint (Nucleosome) rule
 * follows the nucleosome layer's colour, the Accessibility rule the accessibility layer's, and the Subnucleosome rule
 * (the default colour of TF-layer calls, 1-89 bp) and the TF overlay the TF layer's. A rule or overlay whose colour the user changed keeps it. The stored colormap is never changed (presets,
 * sessions and Reset keep their own colours); every canvas that paints from the colormap reads it through here.
 */
import { DEFAULT_COLORMAP, type Colormap, type ColorRule } from '../types';
import { getLayerColorOverride, normalizeLayerHex } from './layerColors';

/** Built-in rule id → the layer whose colour it follows while it keeps its stock colour. */
export const RULE_LAYER_FOLLOW: Readonly<Record<string, string>> = { nuc: 'nuc', fire: 'fire', subnuc: 'tf' };

export interface LayerColourFollowOptions {
  /** Built-in rules (by id) that follow a layer colour. */
  ruleLayers?: Readonly<Record<string, string>>;
  /** Whether the TF overlay follows the TF layer's colour. */
  followTfOverlay?: boolean;
}

const stockRuleColor = (id: string): string | null => {
  const rule = DEFAULT_COLORMAP.rules.find(r => r.id === id);
  return rule ? normalizeLayerHex(rule.color) : null;
};

/** The layer a rule follows (its stock colour unchanged, solid), or null. */
export function ruleFollowedLayer(rule: Pick<ColorRule, 'id' | 'color' | 'colorMode'>, ruleLayers = RULE_LAYER_FOLLOW): string | null {
  const layer = ruleLayers[rule.id];
  if (!layer || (rule.colorMode ?? 'solid') !== 'solid') return null;
  const stock = stockRuleColor(rule.id);
  return stock && normalizeLayerHex(rule.color) === stock ? layer : null;
}

/** A rule's colour as drawn: the followed layer's override, else its own. */
export function displayRuleColor(rule: Pick<ColorRule, 'id' | 'color' | 'colorMode'>, ruleLayers = RULE_LAYER_FOLLOW): string {
  const layer = ruleFollowedLayer(rule, ruleLayers);
  return (layer && getLayerColorOverride(layer)) || rule.color;
}

/** The TF overlay's colour as drawn: the TF layer's override while it keeps its stock colour. */
export function displayTfOverlayColor(color: string | null | undefined): string | null | undefined {
  if (normalizeLayerHex(color) !== normalizeLayerHex(DEFAULT_COLORMAP.tfOverlay.color)) return color;
  return getLayerColorOverride('tf') ?? color;
}

const cache = new WeakMap<Colormap, { key: string; out: Colormap }>();

/** The colormap with followed colours applied (the same object when nothing changes). */
export function withLayerColours(colormap: Colormap, options: LayerColourFollowOptions = {}): Colormap {
  const ruleLayers = options.ruleLayers ?? RULE_LAYER_FOLLOW;
  const followTf = options.followTfOverlay ?? true;
  const rules = colormap.rules.map(rule => {
    const color = displayRuleColor(rule, ruleLayers);
    return color === rule.color ? rule : { ...rule, color };
  });
  const tfColor = followTf ? displayTfOverlayColor(colormap.tfOverlay?.color) : colormap.tfOverlay?.color;
  const rulesChanged = rules.some((r, i) => r !== colormap.rules[i]);
  const tfChanged = !!colormap.tfOverlay && tfColor !== colormap.tfOverlay.color;
  if (!rulesChanged && !tfChanged) return colormap;
  const key = JSON.stringify([rules.map(r => r.color), tfColor, options.ruleLayers ?? null, followTf]);
  const hit = cache.get(colormap);
  if (hit && hit.key === key) return hit.out;
  const out: Colormap = {
    ...colormap,
    rules: rulesChanged ? rules : colormap.rules,
    ...(tfChanged ? { tfOverlay: { ...colormap.tfOverlay, color: tfColor as string } } : {}),
  };
  cache.set(colormap, { key, out });
  return out;
}

/** A colour a fraction of the way to black (the deep-teal strand shade of a recoloured deamination layer). */
function darken(hex: string, amount: number): string {
  const v = normalizeLayerHex(hex);
  if (!v) return hex;
  const rgb = [1, 3, 5].map(i => Math.round(parseInt(v.slice(i, i + 2), 16) * (1 - amount)));
  return `#${rgb.map(c => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The per-base mark colours (read-track MOD_COLORS) with the user's layer colours applied: m6A, 5mC, the
 * accessibility layer, TF, the nucleosome layer, and deamination (its CT strand a darker shade of the chosen colour).
 * The opportunity rugs and the observed-event black keep their fixed colours.
 */
export function effectiveModColors<T extends Record<string, string>>(base: T): T {
  const out: Record<string, string> = { ...base };
  const set = (keys: string[], layer: string) => {
    const color = getLayerColorOverride(layer);
    if (color) for (const k of keys) if (k in out) out[k] = color;
  };
  set(['m6a', 'mod'], 'm6a');
  set(['m5c'], 'm5c');
  set(['msp', 'fire'], 'fire');
  set(['tf'], 'tf');
  set(['nuc', 'footprint'], 'nuc');
  const deam = getLayerColorOverride('deam');
  if (deam) {
    for (const k of ['deam', 'deam_r']) if (k in out) out[k] = deam;
    if ('deam_y' in out) out.deam_y = darken(deam, 0.55);
  }
  return out as T;
}
