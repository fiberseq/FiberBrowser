/** The plot's read sampling: random N per dataset by stable keys over the whole scope (any order, any split into
 *  windows or regions), counts used / dropped; the random-reads selection per contig; the seed in the settings. */
import { describe, expect, it } from 'vitest';
import { sampleCountsText, sampleScope } from './useProfileData';
import { selectRandom } from './randomReads';
import { newPlot, normalizePlot, normalizeSampling, samplingText } from './plotModel';
import { stableKey } from '../../utils/stableSample';

const reads = (ds: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${ds}_r${i}`, dataset: ds, k: i }));

describe('random N reads in scope', () => {
  const all = [...reads('d1', 100), ...reads('d2', 30)];
  const s = normalizeSampling({ mode: 'random', n: 20, seed: 1 });
  it('keeps N per dataset by key; the same reads whatever the order or split; counts used and dropped', () => {
    const a = sampleScope(all, s);
    expect(a.counts).toEqual({ d1: { used: 20, total: 100 }, d2: { used: 20, total: 30 } });
    const ids = new Set(a.reads.map(r => r.id));
    expect(new Set(sampleScope([...all].reverse(), s).reads.map(r => r.id))).toEqual(ids);
    // A read present twice (two windows) is kept or dropped in both.
    const twice = sampleScope([...all, ...all.slice(0, 50)], s).reads.map(r => r.id);
    expect(new Set(twice)).toEqual(ids);
    const d1 = [...ids].filter(x => x.startsWith('d1'));
    const best = reads('d1', 100).map(r => r.id).sort((x, y) => (stableKey(1, 'd1', x) < stableKey(1, 'd1', y) ? -1 : 1)).slice(0, 20);
    expect(new Set(d1)).toEqual(new Set(best));
    expect(sampleCountsText(a.counts, s)).toBe('Reads used: d1 20 of 100 · d2 20 of 30 (random 20 per dataset, seed 1; 90 dropped)');
  });
  it('another seed picks other reads; all keeps everything', () => {
    expect(new Set(sampleScope(all, { ...s, seed: 2 }).reads.map(r => r.id))).not.toEqual(new Set(sampleScope(all, s).reads.map(r => r.id)));
    expect(sampleScope(all, normalizeSampling({})).reads).toHaveLength(130);
  });
  it('the seed lives in the plot (default 1; old BED seeds kept) and is printed', () => {
    expect(newPlot().sampling).toEqual({ mode: 'all', n: 10000, seed: 1 });
    expect(normalizePlot({ bed: { seed: 7 } }).sampling.seed).toBe(7);
    expect(samplingText(normalizeSampling({ mode: 'random', n: 10000, seed: 1 }))).toBe('10,000 random reads per dataset, seed 1');
    expect(samplingText(normalizeSampling({ n: 500, seed: 3 }), true)).toBe('500 random reads per dataset (whole file), seed 3');
  });
});

describe('whole-file random reads selection', () => {
  it('keeps each contig\'s share of the smallest keys, whatever the order of the scan chunks', () => {
    const job = (contig: string, share: number, c: Array<[string, string, number]>) => ({ dataset: 'd1', contig, share, mapped: 100, candidates: c });
    const a = [job('chrA', 2, [['x', '30', 5], ['y', '10', 9]]), job('chrA', 2, [['z', '20', 1]]), job('chrB', 1, [['w', '99', 3], ['v', '18446744073709551615', 4]])];
    const sel = selectRandom(a);
    expect(sel).toEqual([{ dataset: 'd1', contig: 'chrA', names: ['z', 'y'], starts: [1, 9] }, { dataset: 'd1', contig: 'chrB', names: ['w'], starts: [3] }]);
    expect(selectRandom([...a].reverse())).toEqual(sel);
  });
});
