import { describe, expect, it } from 'vitest';
import { idsKey, largeRequestFilterIds, requestFilterParamFromSets } from './useReadTrackData';

const names = (n: number, prefix = 'm84021_250101_000000_s1/123456789/ccs/fwd/') => new Set(Array.from({ length: n }, (_, i) => `${prefix}${i}`));

describe('a read filter too large for filter_ids goes as a registered read set', () => {
  it('small filters stay in filter_ids; large ones give the intersection for filter_set', () => {
    expect(largeRequestFilterIds(new Set(['a', 'b']))).toBeNull();
    const big = names(1500);
    expect(requestFilterParamFromSets(big)).toBe('');           // past the query-string cap
    const ids = largeRequestFilterIds(big, new Set([...big].slice(0, 1200)));
    expect(ids).toHaveLength(1200);
    expect(largeRequestFilterIds(null, undefined)).toBeNull();
  });
  it('the key follows the content', () => {
    expect(idsKey(['a', 'b'])).toBe(idsKey(['a', 'b']));
    expect(idsKey(['a', 'b'])).not.toBe(idsKey(['a', 'c']));
  });
});
