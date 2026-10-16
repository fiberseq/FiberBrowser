import { describe, expect, it } from 'vitest';
import { mergeClusterOrder } from './clusterOrder';

describe('mergeClusterOrder', () => {
  it('keeps the existing order when navigation reassigns reads', () => {
    expect(mergeClusterOrder([2, 0, 1], [[0, 500], [1, 10], [2, 30]])).toBeNull();
  });
  it('appends clusters that are new (largest first), after the existing ones', () => {
    expect(mergeClusterOrder([2, 0, 1], [[0, 5], [1, 5], [2, 5], [-1, 40], [7, 90]])).toEqual([2, 0, 1, 7, -1]);
  });
  it('orders by size when there is no order yet', () => {
    expect(mergeClusterOrder(undefined, [[0, 5], [1, 50], [2, 20]])).toEqual([1, 2, 0]);
    expect(mergeClusterOrder([], [])).toBeNull();
  });
});
