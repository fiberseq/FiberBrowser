import { describe, expect, it } from 'vitest';
import { assignmentsByDataset, assignmentsForPanel } from './panelAssignments';

describe('panel cluster assignments', () => {
  const stateKeyToDs = { 'ds1:fwd': 'ds1', 'ds1:rev': 'ds1', ds2: 'ds2' };
  const clusterAssignments = {
    'ds1:fwd': { a: 0, b: 1 },
    'ds1:rev': { c: 1, d: 2 },
    ds2: { e: 0 },
  };

  it('sends the union of panels sharing a dataset', () => {
    expect(assignmentsByDataset(['ds1:fwd', 'ds1:rev', 'ds2'], stateKeyToDs, clusterAssignments)).toEqual({
      ds1: { a: 0, b: 1, c: 1, d: 2 },
      ds2: { e: 0 },
    });
  });

  it('gives each panel back only its own reads', () => {
    const merged = { a: 0, b: 0, c: 0, d: 2 };
    expect(assignmentsForPanel(merged, clusterAssignments['ds1:fwd'])).toEqual({ a: 0, b: 0 });
    expect(assignmentsForPanel(merged, clusterAssignments['ds1:rev'])).toEqual({ c: 0, d: 2 });
  });
});
