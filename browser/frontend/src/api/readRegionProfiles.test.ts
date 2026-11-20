import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readRegionProfiles } from './readRegionProfiles';
import { decodeReadBinary } from './readBinary';
import { projectLoadedReads } from './loadedReadRegion';

it('bins signal and coverage half-open, as the server does', () => {
  // [10, 20) at 2 bp per bin covers bins 5-9: its end base 20 is not in it (services/read_metrics.py).
  const reads = [{ id: 'one', intervals: [[0, 1000, 1000]] as [number, number, number][],
    layers: { tf: { intervals: [[10, 20, 10]] as [number, number, number][] } } }];
  const profile = readRegionProfiles(reads, 1000, ['tf']);
  expect(profile.layers?.tf.slice(4, 12)).toEqual([0, 1, 1, 1, 1, 1, 0, 0]);
});

it('ends a call at the bin before ceil(end / bin) when bins are fractional, like ReadTrack', () => {
  // 1001 bp over 500 bins: [2, 3) reaches past 2.002, so it shows in bins 0 and 1 (ReadTrack's addRange).
  const reads = [{ id: 'one', intervals: [[0, 1001, 1001]] as [number, number, number][],
    layers: { tf: { intervals: [[2, 3, 1]] as [number, number, number][] } } }];
  const profile = readRegionProfiles(reads, 1001, ['tf']);
  expect(profile.layers?.tf.slice(0, 3)).toEqual([1, 1, 0]);
});

it('counts a read once in a bin its calls share and covers a call past its intervals, as the server does', () => {
  // 4000 bp over 500 bins of 8 bp: two nucleosomes with a 1 bp linker share the bin 240-248.
  const reads = [
    { id: 'a', intervals: [[0, 4000, 4000]] as [number, number, number][],
      layers: { nuc: { intervals: [[100, 245, 145], [246, 391, 145]] as [number, number, number][] } } },
    { id: 'c', intervals: [[1000, 2000, 1000]] as [number, number, number][],
      layers: { nuc: { intervals: [[2000, 2600, 600]] as [number, number, number][] } } },
  ];
  const nuc = readRegionProfiles(reads, 4000, ['nuc']).layers!.nuc;
  expect(Math.max(...nuc)).toBeLessThanOrEqual(1);
  expect(nuc[30]).toBe(1);    // read a once (alone covers it), not 2
  expect(nuc[270]).toBe(0.5); // read c's call past its intervals is covered by it: 1 of 2 reads, not 1 of 1
});

it('uses the server rounding rule for exact half-millionths', () => {
  const reads = Array.from({ length: 128 }, (_, i) => ({ id: String(i),
    intervals: [[0, 1000, 1000]] as [number, number, number][],
    layers: { tf: { intervals: (i < 117 ? [[10, 20, 10]] : []) as [number, number, number][] } },
  }));
  expect(readRegionProfiles(reads, 1000, ['tf']).layers?.tf[5]).toBe(0.914062);
});

const fixtureDir = process.env.FIBERBROWSER_PROJECTION_FIXTURES;
it.skipIf(!fixtureDir)('matches fresh molecule geometry, marks, profiles and structural summaries', () => {
  const views: [number, number][] = JSON.parse(readFileSync(`${fixtureDir}/views.json`, 'utf8'));
  const bytes = readFileSync(`${fixtureDir}/loaded.bin`);
  const loaded = decodeReadBinary(Uint8Array.from(bytes).buffer);
  const normalize = (reads: any[]) => JSON.parse(JSON.stringify(reads.map(read => ({ ...read,
    ...(read.layers ? { layers: Object.fromEntries(Object.entries(read.layers).filter(([, layer]: any) => layer.intervals?.length)) } : {}),
  })).sort((a, b) => a.id.localeCompare(b.id))));
  for (const [start, end] of views.slice(1)) {
    const projected = projectLoadedReads(loaded, start - views[0][0], end - start, views[0][0]);
    expect(projected).toBeDefined();
    const fresh = JSON.parse(readFileSync(`${fixtureDir}/${start}-${end}.json`, 'utf8'));
    expect(normalize(projected!.reads)).toEqual(normalize(fresh.reads));
    expect(projected!.total_overlapping).toBe(fresh.total_overlapping);
    expect(projected!.total_spanning).toBe(fresh.total_spanning);
    expect(readRegionProfiles(projected!.reads, end - start, ['nuc', 'tf'])).toEqual(fresh.metaprofile);
    expect(projected!.sv_summary).toEqual(fresh.sv_summary);
  }
});
