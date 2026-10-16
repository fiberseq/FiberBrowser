import type { PanelConfig } from '../types';

/**
 * Panels a split folded away whose split has no panel left (its panels closed one by one, or its
 * Carriers panel's alt dataset closed): shown again, as closing the split does (utils/splitPanels.ts).
 * A source that another split still open came from stays folded, held by that split now (usability round 3, R16:
 * closing one of two splits from the same source showed the source again beside the other split).
 */
export function restoreOrphanSplitSources(panels: PanelConfig[]): PanelConfig[] {
  const live = new Set(panels.filter(p => p.readSubset).map(p => p.readSubset!.groupId));
  let changed = false;
  const out = panels.map(p => {
    if (!p.collapsedBySplitGroup || live.has(p.collapsedBySplitGroup)) return p;
    changed = true;
    const other = openSplitFrom(panels, p.id);
    if (other) return { ...p, collapsedBySplitGroup: other };
    const { collapsedBySplitGroup: _gone, ...rest } = p;
    return { ...rest, collapsed: false };
  });
  return changed ? out : panels;
}

/** A split still open whose panels came from `sourceId` (its group id), else null. */
export function openSplitFrom(panels: PanelConfig[], sourceId: string): string | null {
  return panels.find(p => p.readSubset?.sourcePanelId === sourceId)?.readSubset?.groupId ?? null;
}
