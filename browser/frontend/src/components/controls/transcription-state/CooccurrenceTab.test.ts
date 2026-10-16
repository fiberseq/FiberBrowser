import { describe, expect, it } from 'vitest';
import { formatTranscriptionCooccurrenceTsv } from './CooccurrenceTab';

describe('transcription co-occurrence export', () => {
  it('includes color values, raw counts, the 2x2 table, and adjusted inference', () => {
    const tsv = formatTranscriptionCooccurrenceTsv('ds1', {
      matrix: [[1, 0.5], [0.5, 0.8]],
      rawMatrix: [[10, 4], [4, 8]],
      totalReads: 20,
    }, [{ datasetId: 'ds1', stateI: 0, stateJ: 1, oddsRatio: 2, pValue: 0.03, qValue: 0.06 }]);
    expect(tsv).toContain('cell\tds1\t20\tPause\tPIC\t0.5\t4');
    expect(tsv).toContain('test\tds1\t20\tPause\tPIC\t\t\t4\t6\t4\t6\t2\t0.03\t0.06');
  });
});
