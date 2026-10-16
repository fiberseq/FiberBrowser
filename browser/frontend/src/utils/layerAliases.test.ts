import { describe, expect, it } from 'vitest';
import {
  normalizeAnnotationLayer,
  normalizeLayerList,
  normalizeLayerToggleMap,
  normalizeQualityFilterLayers,
} from './layerAliases';

describe('layerAliases', () => {
  it('normalizes legacy and UI layer aliases', () => {
    expect(normalizeAnnotationLayer('msp')).toBe('fire');
    expect(normalizeAnnotationLayer('msp-layer')).toBe('fire');
    expect(normalizeAnnotationLayer('tf_layer')).toBe('tf');
    expect(normalizeAnnotationLayer('nucleosomes')).toBe('nuc');
    expect(normalizeAnnotationLayer('all')).toBeNull();
    expect(normalizeAnnotationLayer('custom_layer')).toBe('custom_layer');
  });

  it('normalizes and de-duplicates layer lists', () => {
    expect(normalizeLayerList(['tf', 'msp', 'fire', 'all', 'nuc_layer'])).toEqual(['tf', 'fire', 'nuc']);
    expect(normalizeLayerList('tf,msp,fire')).toEqual(['tf', 'fire']);
  });

  it('normalizes toggle maps and quality-filter layers', () => {
    expect(normalizeLayerToggleMap({
      msp: true,
      tf_layer: false,
      deam_opportunity: true,
    })).toEqual({ fire: true, tf: false });
    expect(normalizeQualityFilterLayers([
      { layer: 'msp', qualityName: 'aq', minValue: 230, enabled: true },
      { layer: '*', qualityName: 'nq', minValue: 200, enabled: true },
    ])).toEqual([
      { layer: 'fire', qualityName: 'aq', minValue: 230, enabled: true },
      { layer: '*', qualityName: 'nq', minValue: 200, enabled: true },
    ]);
  });
});
