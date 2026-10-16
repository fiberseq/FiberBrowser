import { describe, expect, it } from 'vitest';
import { readStatsChromOf, readStatsRequestLoci } from './readLocus';
import { viewFileStem } from '../../../utils/panelScope';

describe('Read Stats request loci (audit M2)', () => {
  const loci = {
    main: { chrom: 'chr19', start: 47_514_037, end: 47_519_435 },
    readIdsByDataset: { napa: ['h1'] },
    extraRegions: [{ chrom: 'chr2L', start: 6_356_793, end: 6_357_648, read_ids_by_dataset: { flyamp: ['fly1'] } }],
  };
  it('a read is on the chromosome it was requested at', () => {
    expect(readStatsChromOf({ dataset_id: 'flyamp', read_id: 'fly1' }, loci)).toBe('chr2L');
    expect(readStatsChromOf({ dataset_id: 'napa', read_id: 'h1' }, loci)).toBe('chr19');
  });
  it('file names name the loci looked at, not the stale main locus alone', () => {
    expect(viewFileStem(readStatsRequestLoci({ ...loci, readIdsByDataset: {} }))).toBe('chr2L_6356793-6357648');
    expect(viewFileStem(readStatsRequestLoci(loci))).toBe('chr19_47514037-47519435_plus1');
  });
});
