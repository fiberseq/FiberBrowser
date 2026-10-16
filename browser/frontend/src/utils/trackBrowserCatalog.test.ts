import { describe, expect, it } from 'vitest';
import {
  filterUcscTrackGroups,
  getDefaultExpandedUcscGroups,
  supportsEncodeGenome,
} from './trackBrowserCatalog';
import type { UcscTrack } from '../api/externalTracks';

function track(id: string, label: string, overrides: Partial<UcscTrack> = {}): UcscTrack {
  return {
    id,
    label,
    url: `https://example.com/${id}.bb`,
    type: 'bigBed',
    loadable: true,
    loaded: false,
    ...overrides,
  };
}

describe('track browser catalog helpers', () => {
  it('detects ENCODE-supported genomes', () => {
    expect(supportsEncodeGenome('hg38')).toBe(true);
    expect(supportsEncodeGenome('dm6')).toBe(true);
    expect(supportsEncodeGenome('sacCer3')).toBe(false);
    expect(supportsEncodeGenome(null)).toBe(false);
  });

  it('expands only UCSC groups with loadable tracks by default', () => {
    const groups = {
      Regulation: [track('tfbs', 'TFBS')],
      Mapping: [track('chain', 'Chains', { loadable: false })],
    };

    expect([...getDefaultExpandedUcscGroups(groups)]).toEqual(['Regulation']);
  });

  it('filters UCSC groups by label, id, type, description, or group name', () => {
    const groups = {
      Regulation: [
        track('tfbs', 'TFBS', { description: 'transcription factor binding' }),
        track('dnase', 'DNase'),
      ],
      Repeats: [
        track('rmsk', 'RepeatMasker', { type: 'rmsk' }),
      ],
    };

    expect(Object.keys(filterUcscTrackGroups(groups, 'factor'))).toEqual(['Regulation']);
    expect(filterUcscTrackGroups(groups, 'rmsk').Repeats).toHaveLength(1);
    expect(Object.keys(filterUcscTrackGroups(groups, 'missing'))).toEqual([]);
  });
});
