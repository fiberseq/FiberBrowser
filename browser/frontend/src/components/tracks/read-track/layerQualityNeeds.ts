import type { Colormap } from '../../../types';

/** 'msp' is stored under that key but shown (and configured) as FIRE. */
export const qualityLayerKey = (layer: string | null | undefined): string | null => {
  if (!layer) return null;
  return layer === 'msp' ? 'fire' : layer;
};

export const layerSetIncludes = (layers: Set<string>, layer: string | null | undefined): boolean => {
  const key = qualityLayerKey(layer);
  if (!key) return false;
  return layers.has(key) || (key === 'fire' && layers.has('msp'));
};

// Mirrors ReadTrackCanvas drawLayerOverlays.
const PRIMARY_LAYERS = new Set(['nuc', 'footprint']);
const BACKGROUND_LAYERS = new Set(['ddda_mcg', 'ddda_mcg_hemi', 'deam_ct', 'deam_ga']);
const FAMILY_LAYERS = new Set(['tf_consensus', 'tf_cross_consensus']);

type OverlayColormap = Pick<Colormap, 'tfOverlay' | 'layerOpacities'>;

/**
 * Whether the read canvas shades this overlay layer by its quality: an overlay
 * call's body is drawn at an opacity between the layer's min and max, by its
 * first quality dim (tq for TF calls, aq for FIRE), and TF calls under
 * ``minTq`` are hidden. Without the qualities every call is drawn at the max,
 * i.e. darker than the same call drawn with them.
 */
export function overlayShadesByQuality(layer: string, colormap: OverlayColormap): boolean {
  if (PRIMARY_LAYERS.has(layer) || FAMILY_LAYERS.has(layer)) return false;
  const display = layer === 'msp' ? 'fire' : layer;
  const isTf = layer === 'tf';
  const isBackground = BACKGROUND_LAYERS.has(layer);
  const tfCfg = colormap.tfOverlay;
  const fallbackMax = isBackground ? 0.35 : isTf && tfCfg ? tfCfg.maxOpacity : 0.65;
  const rawMax = colormap.layerOpacities?.[display] ?? colormap.layerOpacities?.[layer] ?? fallbackMax;
  const max = Math.max(0, Math.min(1, rawMax));
  const min = Math.min(isBackground ? 0.15 : isTf && tfCfg ? tfCfg.minOpacity : 0.25, max);
  return min < max || (isTf && !!tfCfg && tfCfg.minTq > 0);
}

type QualityColormap = Pick<Colormap, 'qualityShading' | 'qualityFilters' | 'rules' | 'tfOverlay' | 'layerOpacities'>;

/**
 * Whether reads of ``layers`` must ship their per-layer quality arrays for the
 * current colormap. Whatever the canvas draws from a quality has to be
 * requested: the cached and the direct read loaders differ in what they send
 * when it isn't, and a call must look the same from both (e.g. with terminal
 * gaps shown, which loads reads directly).
 */
export function layerQualitiesNeeded(layers: string[], colormap: QualityColormap): boolean {
  if (layers.length === 0) return false;
  const requestedLayerSet = new Set(layers.map(layer => qualityLayerKey(layer) ?? layer));
  // q0/q1/q2 are part of the first-class strand-consensus display (body
  // support plus left/right boundary evidence), not an optional analysis
  // add-on. Always retain them when a rescue shadow payload is present.
  if (
    requestedLayerSet.has('nuc_sr')
    || requestedLayerSet.has('tf_sr')
    || requestedLayerSet.has('tf_consensus')
    || requestedLayerSet.has('tf_cross_consensus')
  ) return true;
  if (colormap.qualityShading?.enabled && colormap.qualityShading.mode === 'quality') return true;
  if (layers.some(layer => overlayShadesByQuality(layer, colormap))) return true;
  if ((colormap.qualityFilters ?? []).some(filter => (
    filter.enabled && filter.minValue > 0 && layerSetIncludes(requestedLayerSet, filter.layer)
  ))) return true;
  return colormap.rules.some(rule => {
    if (!rule.enabled || (rule.qualityGates?.length ?? 0) === 0) return false;
    const targets = rule.targetLayers ?? [];
    if (targets.length === 0) return requestedLayerSet.size > 0;
    return targets.some(target => layerSetIncludes(requestedLayerSet, target));
  });
}
