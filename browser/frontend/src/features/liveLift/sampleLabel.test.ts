import { describe, expect, it } from 'vitest';
import { pansnSample, sourceHapLabel, sourceSampleLabel, sourceSampleName, targetReferenceLabel } from './sampleLabel';

const lifted = (live_lift: Record<string, unknown>) => ({ live_lift: { haplotypes: [], haplotype_labels: {}, manifest: 'm', map_label: 'm',
  settings: {}, key: 'k', ...live_lift } }) as never;

describe('source sample and target reference labels', () => {
  it('reads PanSN names', () => {
    expect(pansnSample('NA12878#1#chr3')).toBe('NA12878');
    expect(pansnSample('HG002_MAT#1')).toBe('HG002');
    expect(pansnSample('')).toBeNull();
  });
  it('uses the server field, else the map haplotype keys, else "source assembly"', () => {
    expect(sourceSampleLabel(lifted({ source_sample: 'NA12878' }))).toBe('NA12878');
    expect(sourceSampleName(lifted({ available_haplotypes: { 'strainA#0': 'strainA#0' } }))).toBe('strainA');
    expect(sourceSampleName(lifted({ haplotypes: ['NA19240#1', 'NA19240#2'] }))).toBe('NA19240');
    // Several samples, or keys without PanSN: no single name.
    expect(sourceSampleLabel(lifted({ available_haplotypes: { 'A#1': 'MAT', 'B#1': 'PAT' } }))).toBe('source assembly');
    expect(sourceSampleLabel(lifted({ haplotypes: ['H1'] }))).toBe('source assembly');
    expect(sourceSampleLabel(null)).toBe('source assembly');
    expect(sourceHapLabel(lifted({ source_sample: 'NA12878' }), 'MAT')).toBe('NA12878 MAT');
    expect(sourceHapLabel(lifted({}), 'PAT')).toBe('PAT');
    expect(sourceHapLabel(lifted({ source_sample: 'strainA' }), 'strainA#0')).toBe('strainA#0');
  });
  it('names the target reference when the map does', () => {
    expect(targetReferenceLabel(lifted({ target_reference: 'CHM13' }))).toBe('CHM13');
    expect(targetReferenceLabel(lifted({}), 'Reference')).toBe('Reference');
  });
});
