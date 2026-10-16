import { describe, expect, it } from 'vitest';
import type { ClusterTreeNode } from '../../../types';
import { hasClusterBranches } from './ClusterBranchMap';

const node = (id: string, parentId: string | null): ClusterTreeNode => ({ id, parentId, name: id, createdAt: 0 } as unknown as ClusterTreeNode);

describe('Clusters header: the branch tree only when there are branches (M5)', () => {
  it('a lone "All reads" root is not shown (it repeats the header)', () => {
    expect(hasClusterBranches({ root: node('root', null) }, ['root'])).toBe(false);
  });

  it('a subcluster makes it a tree worth showing', () => {
    expect(hasClusterBranches({ root: node('root', null), sub: node('sub', 'root') }, ['root'])).toBe(true);
  });

  it('two separate clusterings are branches too', () => {
    expect(hasClusterBranches({ a: node('a', null), b: node('b', null) }, ['a', 'b'])).toBe(true);
  });
});
