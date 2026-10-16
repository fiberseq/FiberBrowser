import { describe, expect, it } from 'vitest';
import {
  computeEffectiveReadIdsByStateKey,
  flattenScopedReadIds,
  flattenScopedReadIdsForDataset,
  hasActiveClusterFocus,
  mapScopedReadIdsToDatasetIds,
  readIdSetForClusterRenderScope,
  readIdsForClusterFocus,
  readScopeSignature,
} from './readScopes';

describe('read scope helpers', () => {
  it('treats only non-empty cluster focus sets as active', () => {
    expect(hasActiveClusterFocus(null)).toBe(false);
    expect(hasActiveClusterFocus(undefined)).toBe(false);
    expect(hasActiveClusterFocus(new Set())).toBe(false);
    expect(hasActiveClusterFocus(new Set([2]))).toBe(true);
  });

  it('derives read IDs from active cluster focus without activating empty focus sets', () => {
    const assignments = { readA: 1, readB: 2, readC: 2 };

    expect(readIdsForClusterFocus(assignments, null)).toBeNull();
    expect(readIdsForClusterFocus(assignments, new Set())).toBeNull();
    expect(readIdsForClusterFocus(assignments, new Set([2]))).toEqual(['readB', 'readC']);
    expect(readIdsForClusterFocus(assignments, new Set([9]))).toEqual([]);
  });

  it('uses focused clusters for render scope before falling back to child branch scope', () => {
    const assignments = { readA: 1, readB: -1, readC: 2 };

    expect(readIdSetForClusterRenderScope(assignments, new Set([2]), true)).toEqual(new Set(['readC']));
    expect(readIdSetForClusterRenderScope(assignments, new Set([-1]), true)).toEqual(new Set(['readB']));
    expect(readIdSetForClusterRenderScope(assignments, null, true)).toEqual(new Set(['readA', 'readB', 'readC']));
    expect(readIdSetForClusterRenderScope(assignments, null, false)).toBeNull();
  });

  it('intersects cluster focus and read filters per state key', () => {
    const scoped = computeEffectiveReadIdsByStateKey(
      ['panel-a', 'panel-b', 'panel-c'],
      {
        'panel-a': new Set(['r1', 'r2', 'r3']),
        'panel-b': new Set(['r9']),
      },
      {
        'panel-a': new Set(['r2', 'r4']),
        'panel-c': new Set(['r7']),
      },
    );

    expect(scoped).toEqual({
      'panel-a': ['r2'],
      'panel-b': ['r9'],
      'panel-c': ['r7'],
    });
  });

  it('flattens read scopes globally and per dataset without leaking across panels', () => {
    const scoped = {
      'panel-a': ['shared', 'a-only'],
      'panel-b': ['shared', 'b-only'],
      'panel-c': ['c-only'],
    };
    const stateKeyMap = {
      ds1: ['panel-a', 'panel-b'],
      ds2: ['panel-c'],
    };

    expect(flattenScopedReadIds(scoped, ['panel-a', 'panel-b', 'panel-c'])).toEqual([
      'shared',
      'a-only',
      'b-only',
      'c-only',
    ]);
    expect(flattenScopedReadIdsForDataset(scoped, stateKeyMap, 'ds1')).toEqual([
      'shared',
      'a-only',
      'b-only',
    ]);
    expect(flattenScopedReadIdsForDataset(scoped, stateKeyMap, 'ds2')).toEqual(['c-only']);
  });

  it('can preserve explicit empty scopes for backend requests', () => {
    const scoped = { 'panel-a': [] };
    const stateKeyMap = { ds1: ['panel-a'] };

    expect(flattenScopedReadIds(scoped, ['panel-a'])).toBeUndefined();
    expect(flattenScopedReadIds(scoped, ['panel-a'], { preserveEmptyScope: true })).toEqual([]);
    expect(flattenScopedReadIdsForDataset(scoped, stateKeyMap, 'ds1', { preserveEmptyScope: true })).toEqual([]);
  });

  it('maps state-key scopes to dataset IDs without overwriting duplicate panels', () => {
    const scoped = {
      'panel-a': ['shared', 'a-only'],
      'panel-b': ['shared', 'b-only'],
      ds2: ['ds2-read'],
    };
    const stateKeyMap = {
      ds1: ['panel-a', 'panel-b'],
    };

    expect(mapScopedReadIdsToDatasetIds(scoped, stateKeyMap)).toEqual({
      ds1: ['shared', 'a-only', 'b-only'],
      ds2: ['ds2-read'],
    });
  });

  it('keeps explicit empty dataset scopes when requested', () => {
    expect(mapScopedReadIdsToDatasetIds(
      { 'panel-a': [] },
      { ds1: ['panel-a'] },
    )).toEqual({ ds1: [] });

    expect(mapScopedReadIdsToDatasetIds(
      { 'panel-a': [] },
      { ds1: ['panel-a'] },
      { preserveEmptyScope: false },
    )).toBeNull();
  });

  it('signatures change when scoped read identities change at the same count', () => {
    expect(readScopeSignature({
      'panel-b': ['r3'],
      'panel-a': ['r2', 'r1'],
    })).toBe(readScopeSignature({
      'panel-a': ['r1', 'r2'],
      'panel-b': ['r3'],
    }));
    expect(readScopeSignature({ 'panel-a': ['r1', 'r2'] }))
      .not.toBe(readScopeSignature({ 'panel-a': ['r1', 'r9'] }));
  });

  it('keeps explicit empty scoped sets distinct from no scope', () => {
    expect(readScopeSignature({ 'panel-a': [] })).not.toBe(readScopeSignature(null));
    expect(readScopeSignature({ 'panel-a': [] })).not.toBe(readScopeSignature({}));
  });
});

describe('an applied filter that matched nothing', () => {
  it('scopes to no reads, while no filter (null) is no scope', () => {
    expect(computeEffectiveReadIdsByStateKey(['a'], {}, { a: new Set<string>() })).toEqual({ a: [] });
    expect(computeEffectiveReadIdsByStateKey(['a'], {}, { a: null })).toBeNull();
  });
});
