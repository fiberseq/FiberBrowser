import '../testSetup';
import { describe, expect, it } from 'vitest';
import type { VariantSequence } from './api';
import { fastaFileName, fastaRecord, sequencePart, sliceSequence } from './nfrSequence';
import type { SavedNfr } from './savedNfrVariants';

const seq = (sequence: string, lo = 100): VariantSequence => ({ variant: null, window: [lo, lo + sequence.length], chrom: 'chr1', sequence } as VariantSequence);
const entry = { name: 'N2', nfrId: 'N2', chrom: 'chr1', nfrStart: 110, nfrEnd: 130,
  variants: [{ variantId: 'N2:V1', name: 'V1', start: 112, end: 120, relation: 'full' }] } as unknown as SavedNfr;

describe('an NFR card\'s sequence (Copy sequence / Download FASTA)', () => {
  it('slices 0-based half-open spans out of the window and writes 1-based inclusive headers', () => {
    const s = seq('A'.repeat(10) + 'CCCCCGGGGGTTTTTAAAAA' + 'G'.repeat(10));
    expect(sliceSequence(s, 110, 130)).toEqual({ bases: 'CCCCCGGGGGTTTTTAAAAA', start: 110, end: 130 });
    const r = fastaRecord(entry, s, sequencePart(entry)!, 'NFR window')!;
    expect(r.text).toBe('>N2 chr1:111-130 NFR window\nCCCCCGGGGGTTTTTAAAAA\n');
    expect(fastaFileName(entry, sequencePart(entry)!, r.start, r.end)).toBe('N2_chr1_111-130.fa');
    expect(fastaRecord(entry, s, sequencePart(entry, 'V1')!, 'V1 full')!.text.split('\n')[0]).toBe('>N2_V1 chr1:113-120 V1 full');
  });
  it('past a contig end (blanks): the span is clipped and the header says so; none at all, or not covered: null (Codex review)', () => {
    const s = seq('A'.repeat(20) + '          ');                        // the contig ends at 120
    const r = fastaRecord(entry, s, sequencePart(entry)!, 'NFR window')!;
    expect(r.text.split('\n')).toEqual(['>N2 chr1:111-120 NFR window', 'AAAAAAAAAA', '']);
    expect(sliceSequence(s, 121, 130)).toBeNull();
    expect(sliceSequence(s, 90, 110)).toBeNull();                        // outside the window
    expect(sliceSequence({ ...s, sequence: undefined }, 110, 120)).toBeNull();
  });
});
