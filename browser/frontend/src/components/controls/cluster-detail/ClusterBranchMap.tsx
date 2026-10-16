import type { ClusterTreeNode } from '../../../types';
import { AnalysisButton } from '../shared';

type Props = {
  nodes: Record<string, ClusterTreeNode>;
  rootIds: string[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
};

function nodeReadCount(node: ClusterTreeNode): number {
  return Object.values(node.assignments)
    .reduce((sum, assignments) => sum + Object.keys(assignments).length, 0);
}

function nodeClusterCount(node: ClusterTreeNode): number {
  return new Set(Object.values(node.assignments).flatMap(assignments => Object.values(assignments))).size;
}

function formatNodeDetail(node: ClusterTreeNode): string {
  const reads = nodeReadCount(node).toLocaleString();
  const clusters = nodeClusterCount(node);
  const source = node.sourceLabel ? `${node.sourceLabel} · ` : '';
  return `${source}${clusters} cluster${clusters === 1 ? '' : 's'} · ${reads} reads`;
}

/** More than one branch to choose between: a subcluster, or several roots. */
export function hasClusterBranches(nodes: Record<string, ClusterTreeNode>, rootIds: string[]): boolean {
  const roots = rootIds.filter(id => !!nodes[id]);
  if (roots.length > 1) return true;
  return Object.values(nodes).some(node => !!node.parentId && !!nodes[node.parentId]);
}

export function ClusterBranchMap({ nodes, rootIds, activeId, onSelect, onDelete, onRename }: Props) {
  const childrenByParent = Object.values(nodes).reduce<Record<string, ClusterTreeNode[]>>((acc, node) => {
    if (!node.parentId) return acc;
    acc[node.parentId] = [...(acc[node.parentId] ?? []), node]
      .sort((a, b) => a.createdAt - b.createdAt);
    return acc;
  }, {});

  const renderNode = (node: ClusterTreeNode, depth: number) => {
    const active = node.id === activeId;
    const children = childrenByParent[node.id] ?? [];
    return (
      <div key={node.id} className="space-y-1">
        <div
          className="flex min-w-0 items-center gap-1"
          style={{ paddingLeft: depth * 14 }}
        >
          <div className="h-6 w-3 border-l border-b border-gray-200 dark:border-white/10" />
          <div
            onClick={() => onSelect(node.id)}
            role="button"
            tabIndex={0}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(node.id);
              }
            }}
            className={`min-w-0 flex-1 rounded border px-2 py-1 text-left transition-colors ${
              active
                ? 'border-cyan-400 bg-cyan-50 text-cyan-900 dark:border-cyan-700 dark:bg-cyan-950/40 dark:text-cyan-100'
                : 'border-gray-200 bg-white hover:border-cyan-300 dark:border-white/10 dark:bg-gray-950 dark:hover:border-cyan-800'
            }`}
            title={formatNodeDetail(node)}
          >
            <input
              value={node.name}
              onChange={event => onRename(node.id, event.target.value)}
              onFocus={() => onSelect(node.id)}
              onKeyDown={event => event.stopPropagation()}
              className="block w-full min-w-0 truncate rounded bg-transparent px-0 text-[11px] font-semibold outline-none focus:bg-white/70 focus:px-1 focus:ring-1 focus:ring-cyan-400 dark:focus:bg-gray-900"
              placeholder={node.parentId ? 'Subcluster' : 'All reads'}
              aria-label="Cluster branch name"
            />
            <div className="truncate text-[11px] text-gray-500 dark:text-gray-400">
              {formatNodeDetail(node)}
            </div>
          </div>
          {node.parentId && (
            <AnalysisButton
              onClick={() => onDelete(node.id)}
              variant="dangerOutline"
              size="sm"
              className="px-1.5 py-0.5 text-[11px]"
              title="Delete this subcluster branch and its children"
            >
              Delete
            </AnalysisButton>
          )}
        </div>
        {children.map(child => renderNode(child, depth + 1))}
      </div>
    );
  };

  const roots = rootIds
    .map(id => nodes[id])
    .filter((node): node is ClusterTreeNode => !!node)
    .sort((a, b) => a.createdAt - b.createdAt);

  if (roots.length === 0) return null;

  return (
    <div
      className="rounded border border-gray-200 bg-gray-50 px-2 py-1.5 dark:border-white/10 dark:bg-gray-950/60"
      data-copilot-anchor="cluster-branch-map"
    >
      <div className="mb-1 text-[11px] font-semibold text-gray-500 dark:text-gray-400">
        Cluster branches
      </div>
      <div className="space-y-1">
        {roots.map(root => renderNode(root, 0))}
      </div>
    </div>
  );
}
