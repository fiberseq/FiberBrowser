import { describe, expect, it } from 'vitest';
import { geneTss } from './coordinates';

describe('geneTss', () => {
  it('is start on +, and the last base (end - 1) on - for half-open genes', () => {
    expect(geneTss({ start: 100, end: 200, strand: '+' })).toBe(100);
    expect(geneTss({ start: 100, end: 200, strand: '-' })).toBe(199);
  });
});
