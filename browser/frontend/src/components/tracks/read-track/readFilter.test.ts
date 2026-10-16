import { describe, expect, it } from 'vitest';
import {
  clusterAssignmentForRead,
  clusteredReadIdSet,
  filterReadsByBranchScope,
  filterReadsByReadIdSet,
} from './readFilter';

const reads = [
  { id: 'read-a' },
  { id: 'read-b' },
  { id: 'read-c_2' },
];

describe('clusterAssignmentForRead', () => {
  it('resolves segment rows against exact or base-read assignments', () => {
    expect(clusterAssignmentForRead({ read: 2 }, 'read_0')).toBe(2);
    expect(clusterAssignmentForRead({ read: 2, read_0: 3 }, 'read_0')).toBe(3);
    expect(clusterAssignmentForRead({ read: 2 }, 'other_0')).toBeUndefined();
  });
});

describe('clusteredReadIdSet', () => {
  it('treats every assignment as the stable clustered cohort without requiring focus', () => {
    expect(clusteredReadIdSet({ 'read-b': 1, 'read-a': 0 })).toEqual(
      new Set(['read-b', 'read-a']),
    );
    expect(clusteredReadIdSet({})).toBeNull();
  });
});

describe('filterReadsByReadIdSet', () => {
  it('keeps exact read ID matches in viewer order', () => {
    expect(filterReadsByReadIdSet(reads, new Set(['read-b', 'read-a']))).toEqual([
      { id: 'read-a' },
      { id: 'read-b' },
    ]);
  });

  it('returns an empty set when a normal read-ID filter has no matches', () => {
    expect(filterReadsByReadIdSet(reads, new Set(['other-read']))).toEqual([]);
  });

  it('matches segment-suffixed filter IDs against base read IDs', () => {
    expect(filterReadsByReadIdSet(reads, new Set(['read-a_1', 'read-c']))).toEqual([
      { id: 'read-a' },
      { id: 'read-c_2' },
    ]);
  });

  it('matches base cohort IDs against segment-suffixed payload rows', () => {
    expect(filterReadsByReadIdSet(reads, new Set(['read-c']))).toEqual([
      { id: 'read-c_2' },
    ]);
  });
});

describe('filterReadsByBranchScope', () => {
  it('leaves reads unchanged when no child branch is active', () => {
    expect(filterReadsByBranchScope(reads, false, new Set(['read-a']))).toBe(reads);
  });

  it('keeps only child branch reads when a child branch is active', () => {
    expect(filterReadsByBranchScope(reads, true, new Set(['read-b']))).toEqual([
      { id: 'read-b' },
    ]);
  });

  it('shows no reads for an active child branch with no scoped assignments', () => {
    expect(filterReadsByBranchScope(reads, true, new Set())).toEqual([]);
    expect(filterReadsByBranchScope(reads, true, null)).toEqual([]);
  });
});
