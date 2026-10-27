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
