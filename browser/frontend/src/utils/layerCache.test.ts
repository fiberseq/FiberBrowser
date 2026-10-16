import { describe, expect, it } from 'vitest';
import { isLayerCachedByDefault, isLayerCacheEnabled } from './layerCache';

describe('layer cache defaults', () => {
  it('caches base HMM intervals by default only', () => {
    expect(isLayerCachedByDefault('nuc')).toBe(true);
    expect(isLayerCachedByDefault('footprint')).toBe(true);
    expect(isLayerCachedByDefault('tf')).toBe(false);
    expect(isLayerCachedByDefault('fire')).toBe(false);
    expect(isLayerCachedByDefault('m6a')).toBe(false);
  });

  it('respects explicit cache choices for optional layers', () => {
    expect(isLayerCacheEnabled('fire', {})).toBe(false);
    expect(isLayerCacheEnabled('fire', { fire: true })).toBe(true);
    expect(isLayerCacheEnabled('nuc', { nuc: false })).toBe(true);
  });
});
