import { describe, expect, it } from 'vitest';
import { clusterOperationRounds, roundStillCurrent } from './clusterOperationRounds';

describe('clusterOperationRounds', () => {
  it('sends two panels of one dataset in separate rounds, each with its own assignments', () => {
    const a = { r1: 0, r2: 1 };
    const b = { r1: 1, r2: 1 };
    const c = { s1: 0 };
    const rounds = clusterOperationRounds(['ds1', 'copy', 'ds2'], { ds1: 'ds1', copy: 'ds1', ds2: 'ds2' },
      { ds1: a, copy: b, ds2: c });
    expect(rounds).toHaveLength(2);
    expect(rounds[0].keyByDataset).toEqual({ ds1: 'ds1', ds2: 'ds2' });
    expect(rounds[0].assignments).toEqual({ ds1: a, ds2: c });
    expect(rounds[1].keyByDataset).toEqual({ ds1: 'copy' });
    expect(rounds[1].assignments.ds1).toBe(b);
  });

  it('a round is stale once the view moved or its clusters changed', () => {
    const a = { r1: 0 };
    const [round] = clusterOperationRounds(['ds1'], {}, { ds1: a });
    const view = { chrom: 'chr1', start: 0, end: 100 };
    expect(roundStillCurrent(round, view, { ...view, clusterAssignments: { ds1: a } })).toBe(true);
    expect(roundStillCurrent(round, view, { ...view, clusterAssignments: { ds1: { r1: 0 } } })).toBe(false);
    expect(roundStillCurrent(round, view, { ...view, chrom: 'chr2', clusterAssignments: { ds1: a } })).toBe(false);
  });
});
