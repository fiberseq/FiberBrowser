import { describe, expect, it } from 'vitest';
import type { Dataset } from '../types';
import { consensusChemistry, datasetsMissingConsensusChemistry } from './datasetChemistry';

describe('datasetsMissingConsensusChemistry', () => {
  it('selects only targeted datasets missing an assay type', () => {
    const datasets = [
      { id: 'a', family_scan_chemistry: null },
      { id: 'b', consensus_chemistry: 'ddda' },
      { id: 'c', family_scan_chemistry: null },
    ] as unknown as Dataset[];
    expect(datasetsMissingConsensusChemistry(datasets, ['a', 'b']).map(d => d.id)).toEqual(['a']);
  });
  it('reads the legacy family_scan_chemistry name from older servers', () => {
    const datasets = [{ id: 'a', family_scan_chemistry: 'dddb' }] as unknown as Dataset[];
    expect(consensusChemistry(datasets[0])).toBe('dddb');
    expect(datasetsMissingConsensusChemistry(datasets, ['a'])).toEqual([]);
  });
});
