import { describe, expect, it } from 'vitest';
import { COMPLEMENT } from './SequenceTrack';

describe('reverse-view complement', () => {
  it('complements IUPAC ambiguity codes, in either case', () => {
    const rc = (seq: string) => [...seq].reverse().map(b => COMPLEMENT[b] ?? b).join('');
    expect(rc('ACGR')).toBe('YCGT');
    expect(rc('KMBVDHSWN')).toBe('NWSDHBVKM');
    expect(rc('acgr')).toBe('ycgt');
  });
});
