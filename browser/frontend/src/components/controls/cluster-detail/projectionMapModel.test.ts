import { describe, expect, it } from 'vitest';
import {
  effectiveOverviewMode,
  focusSummary,
  mapSize,
  nextMapFocus,
  overviewColumns,
  overviewModeOptions,
} from './projectionMapModel';
import { buildPointIndex, nearestPoint, nextPointInDirection } from '../../charts/ScatterChart';

describe('read map focus (click, ⇧-click, legend)', () => {
  const all = [0, 1, 2, 3];
  it('a click focuses that cluster alone; clicking the only focused one clears', () => {
    expect([...nextMapFocus(null, 2, false, all)!]).toEqual([2]);
    expect([...nextMapFocus(new Set([0, 1]), 2, false, all)!]).toEqual([2]);
    expect(nextMapFocus(new Set([2]), 2, false, all)).toBeNull();
  });
  it('⇧ adds and removes; all or none focused is no focus', () => {
    expect([...nextMapFocus(new Set([2]), 3, true, all)!].sort()).toEqual([2, 3]);
    expect([...nextMapFocus(new Set([2, 3]), 3, true, all)!]).toEqual([2]);
    expect(nextMapFocus(new Set([2]), 2, true, all)).toBeNull();
    expect(nextMapFocus(new Set([0, 1, 2]), 3, true, all)).toBeNull();
    expect([...nextMapFocus(null, 1, true, all)!]).toEqual([1]);
  });
  it('says what is focused', () => {
    expect(focusSummary(null, c => `C${c}`)).toBeNull();
    expect(focusSummary(new Set([3, 1]), c => `C${c}`)).toBe('C1, C3 focused');
  });
});

describe('Overview layout: profiles, map or both', () => {
  it('side by side only when the panel is wide enough', () => {
    expect(overviewModeOptions(480)).toEqual(['profiles', 'map']);
    expect(overviewModeOptions(900)).toEqual(['profiles', 'both', 'map']);
    expect(effectiveOverviewMode('both', 480)).toBe('profiles');
    expect(effectiveOverviewMode('both', 900)).toBe('both');
    expect(effectiveOverviewMode('map', 480)).toBe('map');
  });
  it('gives the map the room left by the profile column', () => {
    const { list, map } = overviewColumns(900);
    expect(list).toBeGreaterThanOrEqual(300);
    expect(list + map).toBeLessThanOrEqual(900);
    expect(map).toBeGreaterThan(list);
    const full = overviewColumns(1700);
    expect(full.list).toBe(440);
    expect(full.map).toBeGreaterThan(1200);
  });
  it('a large map, capped in height; side by side shares the width', () => {
    expect(mapSize(1000, false, 680)).toEqual({ width: 1000, height: 680 });
    expect(mapSize(456, false)).toEqual({ width: 456, height: 356 });
    const two = mapSize(1000, true);
    expect(two.width).toBe(496);
  });
});

describe('hit-testing the map', () => {
  it('finds the nearest drawn dot within the radius', () => {
    const index = buildPointIndex([10, 50, 52], [10, 50, 50], [1, 1, 0]);
    expect(nearestPoint(index, 11, 12)).toBe(0);
    expect(nearestPoint(index, 52, 50)).toBe(1); // dot 2 wasn't drawn (off the plot)
    expect(nearestPoint(index, 30, 30)).toBeNull();
    expect(nearestPoint(null, 10, 10)).toBeNull();
  });

  it('arrows step to the nearest dot in that direction (keyboard)', () => {
    const index = buildPointIndex([50, 80, 50, 20], [50, 52, 90, 50], [1, 1, 1, 1]);
    expect(nextPointInDirection(index, null, 'right', [49, 49])).toBe(0);
    expect(nextPointInDirection(index, 0, 'right', [0, 0])).toBe(1);
    expect(nextPointInDirection(index, 0, 'down', [0, 0])).toBe(2);
    expect(nextPointInDirection(index, 0, 'left', [0, 0])).toBe(3);
    expect(nextPointInDirection(index, 0, 'up', [0, 0])).toBeNull();
  });
});
