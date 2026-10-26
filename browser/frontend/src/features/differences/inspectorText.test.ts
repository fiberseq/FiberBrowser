import { describe, expect, it } from 'vitest';
import { callText, reasonText } from './inspectorText';

describe('molecule calls read as plain language (docs review, native inspector)', () => {
  it('never shows "unknown · unknown"; geometry comes first, then the sequence call', () => {
    expect(callText({ assignment: 'unknown', level: null }, 0)).toBe('Carrier by geometry');
    expect(callText({ assignment: 'target', level: 'confirmed' }, 0)).toBe('Carrier by geometry · carries the allele (confirmed)');
    expect(callText({ assignment: 'reference', level: 'putative' })).toBe('reference allele (putative)');
    expect(callText({ assignment: 'unknown', level: null })).toBe('not called');
    expect(callText({ assignment: 'some_new_code', level: null }, 2)).toBe('Not informative by geometry · some new code');
  });
  it('turns reason codes into words, keeping unknown ones readable', () => {
    expect(reasonText(['sequence_not_assessed'])).toMatch(/^sequence not checked/);
    expect(reasonText(['ambiguous_bases', 'brand_new_reason'])).toBe('ambiguous bases in the read; brand new reason');
  });
});
