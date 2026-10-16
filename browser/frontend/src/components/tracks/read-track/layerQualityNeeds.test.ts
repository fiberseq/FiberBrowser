import { describe, expect, it } from 'vitest';
import { DEFAULT_COLORMAP } from '../../../types';
import { layerQualitiesNeeded, overlayShadesByQuality } from './layerQualityNeeds';

describe('layer qualities the read canvas draws from', () => {
  it('requests TF qualities with the default colours (tq sets a TF call opacity)', () => {
    // Without them the direct loader (terminal gaps shown) sent none and small
    // TF/sub-nucleosome calls were drawn at full opacity, darker than the
    // cached loader's (terminal gaps hidden) tq-shaded calls.
    expect(overlayShadesByQuality('tf', DEFAULT_COLORMAP)).toBe(true);
    expect(layerQualitiesNeeded(['nuc', 'tf'], DEFAULT_COLORMAP)).toBe(true);
  });

  it('still skips them when nothing drawn uses them', () => {
    expect(layerQualitiesNeeded([], DEFAULT_COLORMAP)).toBe(false);
    expect(layerQualitiesNeeded(['nuc'], DEFAULT_COLORMAP)).toBe(false);
    expect(overlayShadesByQuality('nuc', DEFAULT_COLORMAP)).toBe(false);
    const flatTf = {
      ...DEFAULT_COLORMAP,
      tfOverlay: { ...DEFAULT_COLORMAP.tfOverlay, minOpacity: 0.9, maxOpacity: 0.9 },
      layerOpacities: { ...DEFAULT_COLORMAP.layerOpacities, tf: 0.9 },
    };
    expect(overlayShadesByQuality('tf', flatTf)).toBe(false);
    expect(layerQualitiesNeeded(['nuc', 'tf'], flatTf)).toBe(false);
    // ...unless TF calls below a tq are hidden.
    expect(overlayShadesByQuality('tf', { ...flatTf, tfOverlay: { ...flatTf.tfOverlay, minTq: 50 } })).toBe(true);
  });

  it('FIRE calls are shaded by aq', () => {
    expect(overlayShadesByQuality('msp', DEFAULT_COLORMAP)).toBe(true);
  });
});
