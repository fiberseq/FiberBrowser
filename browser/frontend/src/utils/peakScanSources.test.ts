import { describe, expect, it } from 'vitest';
import { serverScanSource } from './peakScanSources';

describe('serverScanSource', () => {
  it('keeps built-in read sources', () => {
    expect(serverScanSource('accessibility')).toBe('accessibility');
    expect(serverScanSource('tf_layer')).toBe('tf_layer');
    expect(serverScanSource('m5c')).toBe('m5c');
  });

  it('scans any other interval layer as layer:<name>', () => {
    expect(serverScanSource('ctcf')).toBe('layer:ctcf');
    expect(serverScanSource('ddda_mcg')).toBe('layer:ddda_mcg');
    expect(serverScanSource('layer:tf_cr')).toBe('layer:tf_cr');
  });

  it('leaves browser-side sources to the browser', () => {
    for (const source of ['custom', 'fire_signal', 'track:2', 'annot:CTCF', 'profile:rule:r1', 'profile:mod']) {
      expect(serverScanSource(source)).toBeNull();
    }
  });
});
