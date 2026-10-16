import { describe, expect, it } from 'vitest';
import { describeReadSource } from './readSource';

const ds = (sk: string) => sk.split(':')[0];
const label = (id: string) => ({ a: 'napa_ddda', b: 'flyamp_dddb', c: 'c', d: 'd' } as Record<string, string>)[id] ?? id;

describe('describeReadSource (L24)', () => {
  it('names one dataset, and says how many panels when a copy is stacked', () => {
    expect(describeReadSource(['a'], ds, label)).toBe('napa_ddda');
    expect(describeReadSource(['a', 'a:copy'], ds, label)).toBe('napa_ddda (2 panels)');
  });
  it('names up to three datasets, then counts them', () => {
    expect(describeReadSource(['a', 'b'], ds, label)).toBe('napa_ddda, flyamp_dddb');
    expect(describeReadSource(['a', 'b', 'c', 'd'], ds, label)).toBe('4 datasets');
    expect(describeReadSource([], ds, label)).toBe('');
  });
});
