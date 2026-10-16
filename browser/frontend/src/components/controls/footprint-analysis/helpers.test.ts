import { describe, expect, it } from 'vitest';
import { groupMotifHits } from './helpers';
import type { MotifHit } from '../../../api/footprints';

const hit = (motif_name: string, rel_score: number): MotifHit => ({
  motif_id: motif_name, motif_name, start: 0, end: 6, strand: '+', rel_score, matched_seq: 'ACGTAC',
});

describe('groupMotifHits', () => {
  it('groups motifs named like Object properties', () => {
    const grouped = groupMotifHits([hit('constructor', 0.8), hit('toString', 0.9), hit('__proto__', 0.7), hit('constructor', 0.95)]);
    expect(grouped.map(g => g.name)).toEqual(['constructor', 'toString', '__proto__']);
    expect(grouped[0].best.rel_score).toBe(0.95);
    expect(grouped[0].others).toHaveLength(1);
  });
});

describe('motif hits under p-value scoring', () => {
  it('rank by p-value when the hits carry one, and show it', async () => {
    const { groupMotifHits, hitStrength } = await import('./helpers');
    const a = { ...hit('A', 0.99), p: 1e-5 }, b = { ...hit('B', 0.8), p: 1e-7 };
    expect(groupMotifHits([a, b]).map(g => g.name)).toEqual(['B', 'A']);
    expect(hitStrength(b)).toBe('p 1e−7');
    expect(hitStrength(hit('C', 0.87))).toBe('87%');
  });
});
