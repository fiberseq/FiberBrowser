import { describe, expect, it } from 'vitest';
import { batchReadDatasets } from './datasetKinds';

describe('batchReadDatasets', () => {
  const datasets = [
    { id: 'native-a', data_type: 'bam' as const },
    { id: 'lifted', data_type: 'bam_livelift' as const },
    { id: 'bed', data_type: 'bigbed' as const },
    { id: '', data_type: 'bam' as const },
    { id: 'native-b', data_type: 'bam' as const },
  ];
  it('leaves other live-lift datasets out of a panel\'s combined request', () => {
    expect(batchReadDatasets(datasets, 'native-a').map(d => d.id)).toEqual(['native-a', 'bed', 'native-b']);
  });
  it('keeps a pooled live-lift panel\'s own dataset', () => {
    expect(batchReadDatasets(datasets, 'lifted').map(d => d.id)).toEqual(['native-a', 'lifted', 'bed', 'native-b']);
  });
  it('is every dataset in a native-only session', () => {
    const native = datasets.filter(d => d.data_type !== 'bam_livelift' && d.id);
    expect(batchReadDatasets(native, 'native-b')).toEqual(native);
  });
});
