import { beforeEach, describe, expect, it } from 'vitest';
import { LIVE_LIFT_EXTRA_HAPLOTYPE_PALETTE, LIVE_LIFT_HAPLOTYPE_PALETTE, liveLiftHaplotypeColor, registerHaplotypeLabels, resetHaplotypeColours } from './palette';
import { useBrowserStore } from '../../stores/browserStore';
import { registerLiveLift } from './register';

const all = (dark: boolean) => [LIVE_LIFT_HAPLOTYPE_PALETTE.MAT, LIVE_LIFT_HAPLOTYPE_PALETTE.PAT, LIVE_LIFT_HAPLOTYPE_PALETTE.neutral,
  ...LIVE_LIFT_EXTRA_HAPLOTYPE_PALETTE].map(p => p[dark ? 'dark' : 'light']);

describe('haplotype colours', () => {
  beforeEach(() => resetHaplotypeColours());
  it('keeps MAT and PAT fixed and gives a single strain haplotype a colour of its own, not neutral', () => {
    expect(liveLiftHaplotypeColor('MAT')).toBe(LIVE_LIFT_HAPLOTYPE_PALETTE.MAT.light);
    expect(liveLiftHaplotypeColor('PAT', true)).toBe(LIVE_LIFT_HAPLOTYPE_PALETTE.PAT.dark);
    expect(liveLiftHaplotypeColor('ISO1')).toBe(LIVE_LIFT_EXTRA_HAPLOTYPE_PALETTE[0].light);
    expect(liveLiftHaplotypeColor('ISO1')).not.toBe(LIVE_LIFT_HAPLOTYPE_PALETTE.neutral.light);
    expect(liveLiftHaplotypeColor(null)).toBe(LIVE_LIFT_HAPLOTYPE_PALETTE.neutral.light);
  });
  it('colours more than two haplotypes distinctly in map order, stably for the session', () => {
    registerHaplotypeLabels(['MAT', 'PAT', 'H3', 'H4', 'H5']);
    const colours = ['MAT', 'PAT', 'H3', 'H4', 'H5'].map(h => liveLiftHaplotypeColor(h));
    expect(new Set(colours).size).toBe(5);
    expect(liveLiftHaplotypeColor('H3')).toBe(LIVE_LIFT_EXTRA_HAPLOTYPE_PALETTE[0].light);
    // A later map listing them differently doesn't recolour them.
    registerHaplotypeLabels(['H5', 'H3', 'H6']);
    expect(liveLiftHaplotypeColor('H3')).toBe(colours[2]);
    expect(liveLiftHaplotypeColor('H5')).toBe(colours[4]);
    expect(liveLiftHaplotypeColor('H6')).toBe(LIVE_LIFT_EXTRA_HAPLOTYPE_PALETTE[3].light);
  });
  it('the palette has no duplicates, in either theme', () => {
    for (const dark of [false, true]) expect(new Set(all(dark)).size).toBe(all(dark).length);
  });
  it('a lifted dataset registers its haplotypes in its map order when it opens', () => {
    registerLiveLift();
    useBrowserStore.setState({ datasets: [{ id: 'fly', path: '/f.bam', label: 'fly', color: '#000', data_type: 'bam_livelift',
      live_lift: { haplotypes: ['strainA#1', 'strainB#1'], haplotype_labels: { 'strainA#1': 'ISO1', 'strainB#1': 'OreR' } } } as never] });
    expect(liveLiftHaplotypeColor('OreR')).toBe(LIVE_LIFT_EXTRA_HAPLOTYPE_PALETTE[1].light);
    expect(liveLiftHaplotypeColor('ISO1')).toBe(LIVE_LIFT_EXTRA_HAPLOTYPE_PALETTE[0].light);
  });
});
