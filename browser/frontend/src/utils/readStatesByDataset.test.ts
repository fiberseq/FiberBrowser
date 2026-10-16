import { describe, expect, it } from 'vitest';
import { countElongatingInRange, readStatesByDataset } from './readStatesByDataset';
import { clusterCohorts } from './readStatesByDataset';
import { classifiedTotal } from '../components/controls/transcription-state/FiltersTab';

describe('readStatesByDataset', () => {
  const states = { r1: 'paused', r2: 'elongating' };

  it("unions two panels' focused reads of one dataset instead of keeping the last", () => {
    const out = readStatesByDataset(['ds', 'copy'], { ds: 'ds', copy: 'ds' },
      { ds: states, copy: states }, { ds: new Set(['r1']), copy: new Set(['r2']) });
    expect(Object.keys(out)).toEqual(['ds']);
    expect([...(out.ds.focus ?? [])].sort()).toEqual(['r1', 'r2']);
    expect(out.ds.states).toEqual(states);
  });

  it('has no focus when any panel of the dataset shows every read', () => {
    const out = readStatesByDataset(['ds', 'copy'], { ds: 'ds', copy: 'ds' },
      { ds: states, copy: states }, { ds: new Set(['r1']), copy: null });
    expect(out.ds.focus).toBeNull();
  });
});

describe('countElongatingInRange', () => {
  // Eight reads with one elongating Pol II, two with two.
  const states: Record<string, { elongating_count: number }> = {};
  for (let i = 0; i < 8; i += 1) states[`a${i}`] = { elongating_count: 1 };
  states.b0 = { elongating_count: 2 };
  states.b1 = { elongating_count: 2 };

  it('counts the exact minimum and maximum, not the >=1/3/5 buckets', () => {
    expect(countElongatingInRange({ ds: { states, focus: null } }, 2, null)).toBe(2);
    expect(countElongatingInRange({ ds: { states, focus: null } }, 1, 1)).toBe(8);
    expect(countElongatingInRange({ ds: { states, focus: new Set(['a0', 'b0']) } }, 1, null)).toBe(2);
    expect(countElongatingInRange({}, 1, null)).toBeNull();
  });
});

describe('classifiedTotal', () => {
  it('rates use the classified reads, not the reads passing the applied filter', () => {
    // A pause-only filter passed 2 of 10 classified reads, all 10 elongating.
    expect(classifiedTotal({ overlapping_genes: 10, total_matching: 2 })).toBe(10);
    expect(classifiedTotal({ total_matching: 4 })).toBe(4);
  });
});

describe('clusterCohorts', () => {
  it('counts panels with the same clusters once and keeps an independently clustered copy apart', () => {
    const cohorts = clusterCohorts(
      ['ds1', 'copy', 'same', 'ds2'],
      { ds1: 'ds1', copy: 'ds1', same: 'ds1', ds2: 'ds2' },
      {
        ds1: { a: 1, b: 1 },
        copy: { a: 0, b: 1 },
        same: { b: 1, a: 1 },
        ds2: { c: 0 },
      },
    );
    expect(cohorts).toEqual([
      { datasetId: 'ds1', stateKey: 'ds1', copyIndex: 0 },
      { datasetId: 'ds1', stateKey: 'copy', copyIndex: 1 },
      { datasetId: 'ds2', stateKey: 'ds2', copyIndex: 0 },
    ]);
  });
});
