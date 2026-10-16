import { describe, expect, it } from 'vitest';
import { latticeIdentities } from './useNativeLattice';

describe('latticeIdentities', () => {
  it('sends each BAM read\'s alignment identity, skipping reads without one', () => {
    expect(latticeIdentities([
      { id: 'r', library_id: '/a.bam', reference_start: 10, reference_end: 90, alignment_orientation: 'forward' },
      { id: 'bb' },
    ])).toEqual({ r: { library_id: '/a.bam', reference_start: 10, reference_end: 90, alignment_orientation: 'forward' } });
  });
  it('leaves a name shown on two rows unpinned', () => {
    expect(latticeIdentities([
      { id: 'r', library_id: '/a.bam', reference_start: 10 },
      { id: 'r', library_id: '/b.bam', reference_start: 10 },
    ])).toEqual({});
  });
});
