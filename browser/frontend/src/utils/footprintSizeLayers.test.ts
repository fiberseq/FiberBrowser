/** Footprint size plots: the source choices are "All footprints" plus the Layers toolbar's interval layers. */
import { describe, expect, it } from 'vitest';
import {
  ALL_FOOTPRINTS, DEFAULT_FOOTPRINT_SIZE_SETTINGS, footprintSizeLayerLabel, footprintSizeLayerOptions,
} from './footprintSizeSettings';
import { sizeMatrixTsv } from './footprintSizeMatrix';
import { getCanonicalLayerEntries, getLayerColor, getLayerLabel } from './layerColors';

const fiberhmm = { available_layers: { nuc: true, tf: true, fire: true, m6a: true } };

describe('footprint size sources', () => {
  it('offers All footprints first, then the toolbar layers with its labels and colours; no mark layers', () => {
    const opts = footprintSizeLayerOptions([fiberhmm]);
    expect(opts.map(o => o.value)).toEqual([ALL_FOOTPRINTS, 'nuc', 'fire', 'tf']);
    const toolbar = Object.fromEntries(getCanonicalLayerEntries([fiberhmm]).map(e => [e.key, e.label]));
    expect(opts.slice(1).map(o => o.label)).toEqual([toolbar.nuc, toolbar.fire, toolbar.tf]);
    expect(opts[0].label).toBe('All footprints');
    expect(opts.find(o => o.value === 'tf')!.color).toBe(getLayerColor('tf'));
    // No "HMM calls" any more.
    expect(opts.some(o => /HMM calls/.test(o.label))).toBe(false);
  });

  it('lists footprint-class and other interval layers the toolbar lists; Nuc is FP without a TF layer', () => {
    const opts = footprintSizeLayerOptions([{ available_layers: { nuc: true, tf: true, tf_cr: true, pol2: true, deam: true } }]);
    expect(opts.map(o => o.value)).toEqual(expect.arrayContaining(['nuc', 'tf', 'tf_cr', 'pol2']));
    expect(opts.map(o => o.value)).not.toContain('deam');
    const legacy = footprintSizeLayerOptions([{ available_layers: { footprint: true, msp: true } }]);
    expect(legacy.map(o => o.value)).toEqual([ALL_FOOTPRINTS, 'nuc', 'fire']);
    expect(legacy[1].label).toBe('FP');
  });

  it('keeps a saved source the loaded data lacks, so the choice is visible', () => {
    const opts = footprintSizeLayerOptions([{ available_layers: { nuc: true } }], 'tf');
    expect(opts.at(-1)).toMatchObject({ value: 'tf', label: getLayerLabel('tf') });
  });

  it('names the source in the TSV header the way the toolbar does', () => {
    expect(footprintSizeLayerLabel(ALL_FOOTPRINTS)).toBe('All footprints');
    expect(footprintSizeLayerLabel('fire')).toBe(getLayerLabel('fire'));
    const meta = { sizeMin: 10, sizeMax: 30, sizeBin: 10, posBin: 10, nReads: 1, nFootprints: 2 };
    const all = sizeMatrixTsv([[1]], meta, DEFAULT_FOOTPRINT_SIZE_SETTINGS, { title: 'A', chrom: 'chrT', start: 0 });
    expect(all).toMatch(/^# source: All footprints \(Nuc \+ TF layers, each footprint once\)$/m);
    const nuc = sizeMatrixTsv([[1]], meta, { ...DEFAULT_FOOTPRINT_SIZE_SETTINGS, layer: 'nuc' }, { title: 'A', chrom: 'chrT', start: 0 });
    expect(nuc).toMatch(/^# source: Nuc layer \(nuc\)$/m);
  });
});
