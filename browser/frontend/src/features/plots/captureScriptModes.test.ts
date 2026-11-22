/** The Plots screenshot recipe (scripts/capture-plots-screenshots.mjs) selects only compare modes that exist
 *  (3.1.0 LOW: it selected `rest`, which no select offers, so the reset after the compare shot did nothing). */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMPARE_MODES } from './compare';

describe('capture-plots-screenshots compare modes', () => {
  it('every plots-compare-mode selection is a real mode', () => {
    const script = readFileSync(path.resolve(__dirname, '../../../scripts/capture-plots-screenshots.mjs'), 'utf8');
    const picked = [...script.matchAll(/getByTestId\('plots-compare-mode'\)\.selectOption\('([^']+)'\)/g)].map(m => m[1]);
    expect(picked.length).toBeGreaterThan(0);
    const modes = COMPARE_MODES.map(m => m.value as string);
    expect(picked.filter(v => !modes.includes(v))).toEqual([]);
  });
});
