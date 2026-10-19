import { describe, expect, it } from 'vitest';
import { getTrackLabel } from './SubTrackMenu';

describe('sub-track labels', () => {
  it('names the peaks row Peaks (as it draws), and the new rows', () => {
    expect(getTrackLabel('fire')).toBe('Peaks');
    expect(getTrackLabel('sv')).toBe('Differences');
    expect(getTrackLabel('coverage')).toBe('Coverage');
  });
});
