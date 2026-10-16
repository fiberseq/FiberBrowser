export function normalizeAnnotationLayer(layer: unknown): string | null {
  if (layer == null) return null;
  const raw = String(layer).trim();
  if (!raw) return null;
  const lookup = raw.toLowerCase().replace(/-/g, '_');
  if (lookup === 'none' || lookup === 'null' || lookup === 'default' || lookup === 'all') {
    return null;
  }
  const aliases: Record<string, string> = {
    tf_layer: 'tf',
    nuc_layer: 'nuc',
    nucleosome: 'nuc',
    nucleosomes: 'nuc',
    msp: 'fire',
    msp_layer: 'fire',
    methyl_m6a: 'm6a',
    methyl_m5c: 'm5c',
  };
  return aliases[lookup] ?? raw;
}

export function normalizeLayerList(layers: unknown): string[] {
  const values = typeof layers === 'string'
    ? layers.split(',')
    : Array.isArray(layers)
      ? layers
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const layer = normalizeAnnotationLayer(value);
    if (layer && !seen.has(layer)) {
      out.push(layer);
      seen.add(layer);
    }
  }
  return out;
}

export function normalizeLayerToggleMap<T>(
  layers: Record<string, T> | null | undefined,
): Record<string, T> | null {
  if (!layers || typeof layers !== 'object') return null;
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(layers)) {
    const layer = normalizeAnnotationLayer(key);
    // Retired live-only experiment. Possible C/G sites remain available to
    // explicit static/diagnostic requests, but must not survive imported,
    // crash-recovered, history, or Jupyter layer-toggle state.
    if (layer === 'deam_opportunity') continue;
    if (layer) out[layer] = value;
  }
  return out;
}

export function normalizeQualityFilterLayers<T extends { layer?: unknown }>(filters: T[] | null | undefined): T[] {
  if (!Array.isArray(filters)) return [];
  return filters.map(filter => {
    const rawLayer = filter.layer == null ? '*' : String(filter.layer).trim();
    const layer = rawLayer === '*' ? '*' : normalizeAnnotationLayer(rawLayer);
    return { ...filter, layer: layer ?? '*' };
  });
}
