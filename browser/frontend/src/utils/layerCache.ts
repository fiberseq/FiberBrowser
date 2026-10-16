const DEFAULT_CACHED_LAYERS = new Set(['nuc', 'footprint']);

export function isLayerCachedByDefault(layer: string): boolean {
  return DEFAULT_CACHED_LAYERS.has(layer);
}

export function isLayerCacheEnabled(layer: string, cachedLayerTypes: Record<string, boolean>): boolean {
  if (isLayerCachedByDefault(layer)) return true;
  return Object.prototype.hasOwnProperty.call(cachedLayerTypes, layer)
    ? cachedLayerTypes[layer]
    : false;
}
