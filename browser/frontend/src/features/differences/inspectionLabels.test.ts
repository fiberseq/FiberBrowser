import { describe, expect, it } from 'vitest';
import { AUTO_LOAD_MAX_READS, autoLoadBound } from './autoLoad';
import { expansionDetail, expansionLabel, formatNetBp } from './selectionStore';

describe('difference labels and the inspector auto-load bound', () => {
  it('labels a column by its net size; the detail keeps both spans', () => {
    expect(formatNetBp(2353)).toBe('+2.4 kb');
    expect(formatNetBp(-1200)).toBe('−1.2 kb');
    expect(formatNetBp(80)).toBe('+80 bp');
    expect(formatNetBp(12_400)).toBe('+12 kb');
    const d = { source: 'assembly' as const, hap_label: 'MAT', ref_bp: 0, alt_bp: 2353 };
    expect(expansionLabel(d)).toBe('MAT +2.4 kb');
    expect(expansionDetail(d)).toBe('Assembly MAT · ref 0 → alt 2,353 bp');
    expect(expansionLabel({ source: 'assembly', hap_label: 'PAT', ref_bp: 1500, alt_bp: 300 })).toBe('PAT −1.2 kb');
    expect(expansionLabel({ source: 'reads', hap_label: '', ref_bp: 0, alt_bp: 312 })).toBe('Reads +312 bp');
  });
  it('loads observations by itself only within the bound, and says why otherwise', () => {
    const reads = (n: number) => Array.from({ length: n }, () => ({}));
    expect(autoLoadBound({ reads: reads(AUTO_LOAD_MAX_READS), zoomedOut: false })).toEqual({ auto: true, reason: '' });
    expect(autoLoadBound({ reads: reads(AUTO_LOAD_MAX_READS + 1), zoomedOut: false }).reason).toContain('2,001 reads in view');
    expect(autoLoadBound({ reads: [], zoomedOut: true }).reason).toContain('past the read limit');
    expect(autoLoadBound(undefined).auto).toBe(false);
  });
});
