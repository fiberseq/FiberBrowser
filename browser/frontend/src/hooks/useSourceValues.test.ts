import { describe, expect, it } from 'vitest';
import { selectSourceValueSlots, sourceValueSlotsToValues } from './useSourceValues';
import type { SourceRef } from '../types/dataset';

function baseState(overrides = {}) {
  return {
    catalog: [],
    orthogonalTracks: [],
    orthogonalTrackData: {},
    datasetProfiles: {},
    datasets: [],
    ...overrides,
  } as Parameters<typeof selectSourceValueSlots>[0];
}

describe('selectSourceValueSlots', () => {
  it('selects only the referenced orthogonal data array', () => {
    const valuesA = [1, 2, 3];
    const valuesB = [4, 5, 6];
    const refs: SourceRef[] = [{ kind: 'bigwig', catalogEntryId: 'a' }];
    const slots = selectSourceValueSlots(baseState({
      catalog: [{ id: 'a', source: 'local', kind: 'bigwig', label: 'A', path: '/a.bw', loaded: true, trackIndex: 0 }],
      orthogonalTracks: [
        { index: 0, label: 'A', path: '/a.bw', renderMode: 'signal' },
        { index: 1, label: 'B', path: '/b.bw', renderMode: 'signal' },
      ],
      orthogonalTrackData: {
        0: { values: valuesA },
        1: { values: valuesB },
      },
    }), refs);

    expect(slots).toEqual([valuesA, true, 'A']);
    expect(sourceValueSlotsToValues(slots)).toEqual([{ values: valuesA, ready: true, fallbackLabel: 'A' }]);
  });

  it('preserves shallow slot equality when unrelated tracks refresh', () => {
    const valuesA = [1, 2, 3];
    const refs: SourceRef[] = [{ kind: 'bigwig', catalogEntryId: 'a' }];
    const shared = {
      catalog: [{ id: 'a', source: 'local', kind: 'bigwig', label: 'A', path: '/a.bw', loaded: true, trackIndex: 0 }],
      orthogonalTracks: [
        { index: 0, label: 'A', path: '/a.bw', renderMode: 'signal' },
        { index: 1, label: 'B', path: '/b.bw', renderMode: 'signal' },
      ],
    };
    const before = selectSourceValueSlots(baseState({
      ...shared,
      orthogonalTrackData: {
        0: { values: valuesA },
        1: { values: [4, 5, 6] },
      },
    }), refs);
    const after = selectSourceValueSlots(baseState({
      ...shared,
      orthogonalTrackData: {
        0: { values: valuesA },
        1: { values: [7, 8, 9] },
      },
    }), refs);

    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i++) {
      expect(after[i]).toBe(before[i]);
    }
  });

  it('uses first matching path semantics for legacy catalog entries', () => {
    const first = [1];
    const second = [2];
    const slots = selectSourceValueSlots(baseState({
      catalog: [{ id: 'dup', source: 'local', kind: 'bigwig', label: 'Duplicate', path: '/dup.bw', loaded: true }],
      orthogonalTracks: [
        { index: 10, label: 'First', path: '/dup.bw', renderMode: 'signal' },
        { index: 11, label: 'Second', path: '/dup.bw', renderMode: 'signal' },
      ],
      orthogonalTrackData: {
        10: { values: first },
        11: { values: second },
      },
    }), [{ kind: 'bigwig', catalogEntryId: 'dup' }]);

    expect(slots).toEqual([first, true, 'First']);
  });

  it('resolves metaprofile aliases from dataset profiles', () => {
    const mod = [0.1, 0.2];
    const slots = selectSourceValueSlots(baseState({
      datasets: [{ id: 'dataset-a', label: 'Dataset A', color: '#000000', source_path: '/a.bam', available_layers: {} }],
      datasetProfiles: {
        'dataset-a': {
          mod,
          layers: {},
          rules: {},
        },
      },
    }), [{ kind: 'metaprofile', ruleId: 'mod' }], 'dataset-a');

    expect(sourceValueSlotsToValues(slots)).toEqual([{ values: mod, ready: true, fallbackLabel: undefined }]);
  });

  it('a copy at another site reads its own profile, and no main-view track data', () => {
    const state = baseState({
      datasetProfiles: {
        ds1: { mod: [], fire: [], rules: {}, layers: { nuc: [0.1] } },
        'panel-copy': { mod: [], fire: [], rules: {}, layers: { nuc: [0.9] } },
      },
      catalog: [{ id: 'a', source: 'local', kind: 'bigwig', label: 'A', path: '/a.bw', loaded: true, trackIndex: 0 }],
      orthogonalTracks: [{ index: 0, label: 'A', path: '/a.bw', renderMode: 'signal' }],
      orthogonalTrackData: { 0: { values: [5] } },
    });
    const refs: SourceRef[] = [{ kind: 'metaprofile', ruleId: 'nuc' }, { kind: 'bigwig', catalogEntryId: 'a' }];
    const main = sourceValueSlotsToValues(selectSourceValueSlots(state, refs, 'ds1'));
    const copy = sourceValueSlotsToValues(selectSourceValueSlots(state, refs, 'ds1', { stateKey: 'panel-copy', ownView: true }));
    expect(main.map(v => v.values)).toEqual([[0.1], [5]]);
    expect(copy.map(v => v.values)).toEqual([[0.9], []]);
  });

  it('a copy at another site draws no other dataset\'s (main-view) profile', () => {
    const state = baseState({ datasetProfiles: { ds2: { mod: [], fire: [], rules: {}, layers: { nuc: [0.7] } } } });
    const refs: SourceRef[] = [{ kind: 'metaprofile', ruleId: 'nuc', datasetId: 'ds2' }];
    expect(sourceValueSlotsToValues(selectSourceValueSlots(state, refs, 'ds1'))[0].values).toEqual([0.7]);
    expect(sourceValueSlotsToValues(selectSourceValueSlots(state, refs, 'ds1', { ownView: true }))[0].values).toEqual([]);
  });
});
