import { describe, expect, it } from 'vitest';
import { deriveModeOptions } from './ClusterPanel';

describe('deriveModeOptions', () => {
  it('uses the FIRE layer mode instead of exposing internal MSP/accessibility mismatch', () => {
    const options = deriveModeOptions([
      { available_layers: { nuc: true, tf: true, msp: true, deam: true } },
    ]);

    expect(options).toContainEqual({ id: 'fire', label: 'Accessibility' });
    expect(options).toContainEqual({ id: 'nuc', label: 'Nuc' });
    expect(options).toContainEqual({ id: 'tf', label: 'TF' });
    expect(options.some(option => option.id === 'msp')).toBe(false);
    expect(options.some(option => option.id === 'accessibility')).toBe(false);
  });

  it('keeps the legacy accessibility option for footprint-only datasets', () => {
    const options = deriveModeOptions([
      { available_layers: { footprint: true } },
    ]);

    expect(options).toContainEqual({ id: 'accessibility', label: 'Accessibility' });
    expect(options).toContainEqual({ id: 'nuc', label: 'FP' });
  });

  it('includes derived layer labels from the shared canonical layer catalog', () => {
    const options = deriveModeOptions([
      {
        available_layers: { nuc: true, short_tf: true },
        derived_layers: {
          short_tf: { label: 'Short TF near eve', source_layer: 'tf' },
        },
      },
    ]);

    expect(options).toContainEqual({ id: 'short_tf', label: 'Short TF near eve' });
  });
});
