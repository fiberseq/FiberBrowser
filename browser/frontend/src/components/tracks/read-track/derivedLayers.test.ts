import { describe, expect, it } from 'vitest';
import type { CompactRead } from './types';
import { hydrateDerivedReadLayers } from './derivedLayers';

describe('hydrateDerivedReadLayers', () => {
  it('reconstructs duplicated nuc layers from primary positive intervals', () => {
    const read: CompactRead = {
      id: 'r1',
      intervals: [[0, 40, 40], [40, 60, -20], [60, 120, 60]],
      layers: { tf: { intervals: [[70, 90, 20]] } },
      derived_layers: ['nuc'],
    };

    const hydrated = hydrateDerivedReadLayers([read]);

    expect(hydrated[0]).not.toBe(read);
    expect(hydrated[0].layers?.tf.intervals).toEqual([[70, 90, 20]]);
    expect(hydrated[0].layers?.nuc.intervals).toEqual([[0, 40, 40], [60, 120, 60]]);
  });

  it('preserves read identity when no layers need hydration', () => {
    const reads: CompactRead[] = [{
      id: 'r1',
      intervals: [[0, 40, 40]],
      layers: { nuc: { intervals: [[0, 40, 40]] } },
      derived_layers: ['nuc'],
    }];

    expect(hydrateDerivedReadLayers(reads)).toBe(reads);
  });
});

it('reuses the hydrated cohort and its expanded columns on a warm return', () => {
  const reads: CompactRead[] = [{ id: 'r1', intervals: [[0, 40, 40]], derived_layers: ['nuc'] }];
  const hydrated = hydrateDerivedReadLayers(reads);
  expect(hydrateDerivedReadLayers(reads)).toBe(hydrated);
  expect(hydrated[0].layers?.nuc.intervals).toEqual([[0, 40, 40]]);
  expect(reads[0].layers).toBeUndefined();
});
