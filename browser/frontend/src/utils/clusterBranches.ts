import type { ClusterTreeNode } from '../types';

const RECORD_SEPARATOR = '\u0001';
const FIELD_SEPARATOR = '\u0002';

export function isClusterBranchAtViewport(
  node: ClusterTreeNode | null | undefined,
  chrom: string,
  start: number,
  end: number,
): boolean {
  return !!node && node.chrom === chrom && node.start === start && node.end === end;
}

export function clusterBranchDynamicScopeKey(node: ClusterTreeNode | null | undefined): string {
  if (!node) return 'none';
  const parts = [
    node.id,
    node.parentId ?? '',
    node.chrom,
    String(node.start),
    String(node.end),
  ];

  if (node.parentId && node.readScope) {
    const scope = Object.entries(node.readScope)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([stateKey, ids]) => `${stateKey}:${[...ids].sort().join(FIELD_SEPARATOR)}`)
      .join(RECORD_SEPARATOR);
    parts.push(scope);
  }

  return parts.join('|');
}
