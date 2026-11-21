/**
 * On a meta-locus (chrom `meta:<pool>`) the default metaprofile stays (metaHiddenTrack), follows the active layers,
 * and its extra layers take the 3.0.7 palette colours, as on any locus.
 */
import { describe, expect, it } from 'vitest';
import { createTestStore } from '../../stores/__tests__/helpers';
import { DEFAULT_METAPROFILE_ID } from '../../types/dataset';
import { EXTRA_LAYER_PALETTE, getLayerColor } from '../../utils/layerColors';
import { isMetaChrom, metaHiddenTrack } from './metaChrom';

const META = 'meta:promoters_tss';
const ds = { id: 'a', label: 'a', path: '/tmp/a.bam', color: '#111111', data_type: 'bam',
  available_layers: { nuc: true, tf: true, tf2: true, tf3: true } } as any;

describe('meta-locus: metaprofile and layer colours', () => {
  it('keeps the default metaprofile row and hides the rows that need a real position', () => {
    expect(isMetaChrom(META)).toBe(true);
    expect(metaHiddenTrack(`composite-${DEFAULT_METAPROFILE_ID}`, true)).toBe(false);
    expect(metaHiddenTrack('composite-some-annotation', false)).toBe(true);
    expect(metaHiddenTrack('sequence')).toBe(true);
  });

  it('follows the layers switched on and gives extra layers distinct palette colours', () => {
    const store = createTestStore();
    store.setState({ chrom: META, start: 0, end: 20_000, datasets: [ds] } as any);
    store.getState().initModTypeDefaults();
    store.getState().seedDefaultMetaprofile();
    const track = () => store.getState().compositeTracks.find(c => c.id === DEFAULT_METAPROFILE_ID)!;
    const src = (k: string) => track().sources.find(s => (s.ref as any).ruleId === k)!;
    expect(track().followActiveLayers).not.toBe(false);
    store.getState().toggleModType('tf' as any, true);
    expect(src('tf').visible).toBe(true);
    store.getState().toggleModType('tf' as any, false);
    expect(src('tf').visible).toBe(false);
    expect(src('tf2').color).toBe(getLayerColor('tf2'));
    expect(src('tf3').color).toBe(getLayerColor('tf3'));
    expect(src('tf2').color).not.toBe(src('tf3').color);
    expect(EXTRA_LAYER_PALETTE).toContain(src('tf2').color);
    expect(src('tf2').autoColor).toBe(true);
  });
});
