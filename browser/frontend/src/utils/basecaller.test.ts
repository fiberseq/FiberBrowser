import { describe, expect, it } from 'vitest';
import { basecallerLabel, basecallerTitle, shortModbase, shortModel } from './basecaller';

const MODEL = 'dna_r10.4.1_e8.2_400bps_sup@v5.2.0';

describe('basecaller provenance in words', () => {
  it('shortens dorado model names', () => {
    expect(shortModel(MODEL)).toBe('sup v5.2.0');
    expect(shortModel('dna_r10.4.1_e8.2_400bps_hac@v4.3.0')).toBe('hac v4.3.0');
    expect(shortModel('m_override')).toBe('m_override');
    expect(shortModbase(`${MODEL}_6mA@v1`, MODEL)).toBe('6mA v1');
    expect(shortModbase(`${MODEL}_5mCG_5hmCG@v2`, null)).toBe('5mCG_5hmCG v2');
    expect(shortModbase('6mA', MODEL)).toBe('6mA');
  });

  it('reads one line, with unknown and none kept apart', () => {
    expect(basecallerLabel({ available: true, program: 'dorado', version: '2.0.1', basecall_model: MODEL,
      modbase_models: [`${MODEL}_6mA@v1`] })).toBe('dorado 2.0.1 · sup v5.2.0 · 6mA v1');
    expect(basecallerLabel({ available: true, program: 'dorado', version: '2.0.1', basecall_model: MODEL, modbase_models: [] }))
      .toBe('dorado 2.0.1 · sup v5.2.0 · no modbase model');
    expect(basecallerLabel({ available: true, basecall_model: MODEL, modbase_models: null }))
      .toBe('basecaller unknown · sup v5.2.0 · modbase model unknown');
    expect(basecallerLabel({ available: false })).toBe('unknown');
    expect(basecallerLabel(undefined)).toBe('unknown');
  });

  it('names the full models and their sources in the tooltip', () => {
    const title = basecallerTitle({ available: true, program: 'dorado', version: '0.9.6', basecall_model: MODEL, modbase_models: [],
      sources: { program: 'override', basecall_model: 'rg_ds' }, source: 'outputs.json' });
    expect(title).toContain(`Basecall model: ${MODEL}`);
    expect(title).toContain('Modification model: none');
    expect(title).toContain('program: given with --basecaller-info / --modbase-model');
    expect(title).toContain('Read from outputs.json');
    expect(basecallerTitle(null)).toContain('--basecaller-info');
  });
});
