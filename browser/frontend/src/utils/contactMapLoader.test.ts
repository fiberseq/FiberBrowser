import { describe, expect, it } from 'vitest';
import { contactMapErrorMessage, pickContactResolution } from './contactMapLoader';

describe('contactMapLoader', () => {
  it('picks the finest resolution that keeps the view near 800 bins', () => {
    expect(pickContactResolution([50000, 5000, 10000], 4_000_000)).toBe(5000);
    expect(pickContactResolution([50000, 5000, 10000], 20_000_000)).toBe(50000);
    expect(pickContactResolution([5000, 10000], 1_000_000_000)).toBe(10000);
    expect(pickContactResolution([], 1000)).toBe(10000);
  });

  it('turns a missing cooler install into an actionable message', () => {
    expect(contactMapErrorMessage('API error 500: cooler not installed')).toMatch(/pip install cooler h5py/);
    expect(contactMapErrorMessage('File not found: x.mcool')).toBe('File not found: x.mcool');
  });
});
