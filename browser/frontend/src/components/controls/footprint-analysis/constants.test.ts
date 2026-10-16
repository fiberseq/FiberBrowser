import { describe, expect, it } from 'vitest';
import { normalizeFootprintAnalysisTab } from './constants';

describe('footprint analysis tab normalization', () => {
  it('keeps current tab keys', () => {
    for (const tab of ['states', 'saved', 'co-occ']) {
      expect(normalizeFootprintAnalysisTab(tab)).toBe(tab);
    }
  });

  it('maps the old Cart tab to Saved', () => {
    expect(normalizeFootprintAnalysisTab('cart')).toBe('saved');
  });

  it('maps every other legacy tab to States', () => {
    for (const tab of ['families', 'define', 'setup', 'comparison', 'tracks', 'transcription',
      'filters', 'sequence', 'overlap', 'sizes', 'profiles', 'vplot']) {
      expect(normalizeFootprintAnalysisTab(tab)).toBe('states');
    }
  });

  it('uses the fallback for unknown or missing tabs', () => {
    expect(normalizeFootprintAnalysisTab(null, 'saved')).toBe('saved');
    expect(normalizeFootprintAnalysisTab('unknown', 'co-occ')).toBe('co-occ');
  });
});
