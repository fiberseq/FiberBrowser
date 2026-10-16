import { describe, expect, it } from 'vitest';
import {
  getCanonicalLayerEntries,
  getCanonicalLayerGroups,
  getLayerColor,
  getLayerLabel,
  getMetaprofileSourceEntries,
} from './layerColors';

describe('layer color semantics', () => {
  it('names the per-strand DAF consensus coverage layers', () => {
    expect(getLayerLabel('deam_ct')).toBe('CT strand');
    expect(getLayerLabel('deam_ga')).toBe('GA strand');
    expect(getLayerColor('deam_ct')).toMatch(/^#[0-9a-f]{6}$/);
    expect(getLayerColor('deam_ct')).not.toBe(getLayerColor('deam_ga'));
  });

  it('gives custom layers a deterministic #rrggbb color the canvas can add alpha to', () => {
    const ctcf = getLayerColor('ctcf');
    expect(ctcf).toMatch(/^#[0-9a-f]{6}$/);
    expect(getLayerColor('ctcf')).toBe(ctcf);
    expect(getLayerColor('my_custom_layer')).not.toBe(ctcf);
    expect(`${ctcf}a6`).toMatch(/^#[0-9a-f]{8}$/);
  });

  it('exposes internal msp layers as user-facing FIRE', () => {
    const entries = getCanonicalLayerEntries([
      { available_layers: { nuc: true, tf: true, msp: true } },
    ]);

    expect(entries.some(entry => entry.key === 'msp')).toBe(false);
    expect(entries).toContainEqual(expect.objectContaining({ key: 'fire', label: 'Accessibility' }));
    expect(getMetaprofileSourceEntries([
      { available_layers: { fire: true } },
    ])).toContainEqual(expect.objectContaining({ key: 'fire', label: 'Accessibility' }));
    expect(getLayerLabel('msp')).toBe('Accessibility');
    expect(getLayerColor('msp')).toBe(getLayerColor('fire'));
  });

  it('does not offer the file type as a metaprofile source', () => {
    const keys = getMetaprofileSourceEntries([
      { layer_type: 'bam', available_layers: { nuc: true, tf: true } },
    ]).map(entry => entry.key);
    expect(keys).not.toContain('bam');
    expect(keys).toEqual(expect.arrayContaining(['nuc', 'tf']));
  });

  it('presents FiberHMM DddA mCG spans as named molecular layers', () => {
    const groups = getCanonicalLayerGroups([{
      available_layers: { nuc: true, tf: true, ddda_mcg: true, ddda_mcg_hemi: true },
    }]);

    expect(groups.standard).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'ddda_mcg', label: 'DddA mCG' }),
      expect.objectContaining({ key: 'ddda_mcg_hemi', label: 'DddA hemi-mCG' }),
    ]));
    expect(getLayerColor('ddda_mcg')).toBe('#dc2626');
    expect(getLayerColor('ddda_mcg_hemi')).toBe('#f97316');
  });

  it('separates manifest-backed derived layers from standard/custom layers', () => {
    const groups = getCanonicalLayerGroups([
      {
        available_layers: { nuc: true, tf: true, short_tf_peak: true, caller_custom: true },
        derived_layers: {
          short_tf_peak: {
            id: 'short_tf_peak',
            label: 'Short TF near peak',
            source_layer: 'tf',
            color: '#d95f02',
          },
        },
      },
    ]);

    expect(groups.standard.map(entry => entry.key)).toEqual(expect.arrayContaining(['nuc', 'tf', 'caller_custom']));
    expect(groups.standard.some(entry => entry.key === 'short_tf_peak')).toBe(false);
    expect(groups.derived).toContainEqual(expect.objectContaining({
      key: 'short_tf_peak',
      label: 'Short TF near peak',
      kind: 'derived',
      sourceLayer: 'tf',
    }));

    expect(getCanonicalLayerEntries([
      {
        available_layers: { short_tf_peak: true },
        derived_layers: { short_tf_peak: { id: 'short_tf_peak', label: 'Short TF near peak' } },
      },
    ])).toContainEqual(expect.objectContaining({ key: 'short_tf_peak', kind: 'derived' }));
  });

  it('separates added TF inference layers from baseline and other refinement layers', () => {
    const groups = getCanonicalLayerGroups([
      {
        available_layers: {
          nuc: true,
          tf: true,
          deam: true,
          deam_opportunity: true,
          nuc_sr: true,
          tf_sr: true,
          tf_consensus: true,
          tf_cross_consensus: true,
        },
      },
    ]);

    expect(groups.strandRescue).toEqual([
      expect.objectContaining({ key: 'nuc_sr', label: 'Nuc refined', kind: 'strand-rescue' }),
    ]);
    expect(groups.tfInference).toEqual([
      expect.objectContaining({ key: 'tf_sr', label: 'TF refined', kind: 'tf-inference' }),
      expect.objectContaining({ key: 'tf_consensus', label: 'CR · within dataset', kind: 'tf-inference' }),
      expect.objectContaining({ key: 'tf_cross_consensus', label: 'XCR · cross dataset', kind: 'tf-inference' }),
    ]);
    expect(groups.standard.some(entry => entry.key === 'deam_opportunity')).toBe(false);
    expect(groups.standard.some(entry => entry.key === 'tf_sr')).toBe(false);
    expect(groups.standard.some(entry => entry.key === 'tf_consensus')).toBe(false);
    expect(groups.standard.some(entry => entry.key === 'tf_cross_consensus')).toBe(false);
    expect(getLayerColor('tf_sr')).toBe('#7c3aed');
    expect(getLayerLabel('nuc_sr')).toBe('Nuc refined');
    expect(getMetaprofileSourceEntries([{
      available_layers: {
        nuc: true,
        tf: true,
        deam: true,
        deam_opportunity: true,
        nuc_sr: true,
        tf_sr: true,
        tf_consensus: true,
        tf_cross_consensus: true,
      },
    }]).map(entry => entry.key)).toEqual(['nuc', 'tf', 'deam']);
  });

  it('lists registered native inference layers only once when they have derived metadata', () => {
    const nativeKeys = ['tf_native_replay', 'tf_sr_lattice', 'tf_cr', 'tf_recall',
      'tf_cr_recalled', 'tf_xcr', 'nuc_cr_split', 'cr_split_gap'];
    const registered = {
      available_layers: Object.fromEntries([...nativeKeys, 'tf_cr_manual', 'custom_mask'].map(key => [key, true])),
      derived_layers: Object.fromEntries([...nativeKeys, 'tf_cr_manual', 'custom_mask'].map(key =>
        [key, {id: key, label: `Registered ${key}`, source_layer: 'tf'}])),
    };
    const groups = getCanonicalLayerGroups([registered, registered]);
    expect(groups.tfInference.map(entry => entry.key)).toEqual(nativeKeys);
    expect(groups.derived.map(entry => entry.key)).toEqual(['tf_cr_manual', 'custom_mask']);
    const entries = getCanonicalLayerEntries([registered, registered]);
    expect(new Set(entries.map(entry => entry.key)).size).toBe(entries.length);
    for (const key of nativeKeys) expect(entries.filter(entry => entry.key === key)).toHaveLength(1);
    expect(entries.find(entry => entry.key === 'tf_cr')?.label).toBe('CR · classes');
  });
});
