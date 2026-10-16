/**
 * Stacked or side by side (UI audit M17): where a dataset panel goes in its row.
 *
 * Panels in a row sharing a `layoutColumn` stack vertically (TrackContainer's
 * groupByColumns); a panel without one has a column of its own, in array
 * order. These helpers are pure: they take and return the panel list.
 */
import type { PanelConfig } from '../types';

export type PanelArrangement = 'stack' | 'side';

/**
 * New dataset panels (a dataset opened, Add a copy) always open side by side;
 * the panel's ⋯ menu stacks one (Stack below) or puts it back (Side by side),
 * for that panel only. Stacking by default was tried and rejected (owner, 1 Oct).
 */

const rowOf = (p: PanelConfig) => p.layoutRow ?? 0;
const shownInRow = (p: PanelConfig, row: number) => !p.collapsed && p.dock !== 'side' && rowOf(p) === row;

/** A row's columns, left to right, each with its panels top to bottom. */
export function rowColumns(panels: PanelConfig[], row: number): PanelConfig[][] {
  const columns: PanelConfig[][] = [];
  const byColumn = new Map<number, number>();
  for (const p of panels) {
    if (!shownInRow(p, row)) continue;
    const col = p.layoutColumn;
    if (col != null && byColumn.has(col)) {
      columns[byColumn.get(col)!].push(p);
    } else {
      if (col != null) byColumn.set(col, columns.length);
      columns.push([p]);
    }
  }
  return columns;
}

/** The panel shares its column with another (it is stacked). */
export function isStacked(panels: PanelConfig[], panelId: string): boolean {
  const panel = panels.find(p => p.id === panelId);
  if (!panel) return false;
  return rowColumns(panels, rowOf(panel)).some(col => col.length > 1 && col.some(p => p.id === panelId));
}

/**
 * The dataset panel to stack this one below: the bottom of the column to its
 * left (or, for the first column, to its right). Null when it has no
 * neighbour column with a dataset panel.
 */
export function stackTarget(panels: PanelConfig[], panelId: string): PanelConfig | null {
  const panel = panels.find(p => p.id === panelId);
  if (!panel) return null;
  const columns = rowColumns(panels, rowOf(panel));
  const at = columns.findIndex(col => col.some(p => p.id === panelId));
  if (at < 0) return null;
  const bottomDataset = (col: PanelConfig[] | undefined) =>
    [...(col ?? [])].reverse().find(p => p.contentType === 'dataset' && p.id !== panelId) ?? null;
  return bottomDataset(columns[at - 1]) ?? bottomDataset(columns[at + 1]);
}

/** `panelId` moved into `targetId`'s column, right below it (and the panels below it). */
export function stackBelow(panels: PanelConfig[], panelId: string, targetId: string): PanelConfig[] {
  const panel = panels.find(p => p.id === panelId);
  const target = panels.find(p => p.id === targetId);
  if (!panel || !target || panelId === targetId) return panels;

  const targetRow = rowOf(target);
  // Every panel in the target's row gets an explicit column (implicit ones in
  // array order), so the moved panel can share the target's. Minimized ones
  // too: a stale column number would stack one with an unrelated panel when
  // it is restored.
  const rowPanels = panels.filter(p => rowOf(p) === targetRow && p.id !== panelId);
  const columnAssignments = new Map<string, number>();
  let nextCol = 0;
  const seenCols = new Map<number, number>();
  for (const p of rowPanels) {
    if (p.layoutColumn != null) {
      if (!seenCols.has(p.layoutColumn)) seenCols.set(p.layoutColumn, nextCol++);
      columnAssignments.set(p.id, seenCols.get(p.layoutColumn)!);
    } else {
      columnAssignments.set(p.id, nextCol++);
    }
  }
  const targetCol = columnAssignments.get(target.id) ?? 0;
  columnAssignments.set(panelId, targetCol);

  // Right after the target and anything already stacked below it.
  const without = panels.filter(p => p.id !== panelId);
  let insertAt = without.findIndex(p => p.id === targetId) + 1;
  while (insertAt < without.length) {
    const p = without[insertAt];
    if (rowOf(p) !== targetRow) break;
    if ((columnAssignments.get(p.id) ?? p.layoutColumn) !== targetCol) break;
    insertAt++;
  }
  without.splice(insertAt, 0, { ...panel, layoutRow: targetRow, layoutColumn: targetCol });
  return without.map(p => (p.id !== panelId && columnAssignments.has(p.id)
    ? { ...p, layoutColumn: columnAssignments.get(p.id)! }
    : p));
}

/** `panelId` taken out of its stack into a column of its own, right after the one it was in. */
export function sideBySide(panels: PanelConfig[], panelId: string): PanelConfig[] {
  const panel = panels.find(p => p.id === panelId);
  if (!panel || !isStacked(panels, panelId)) return panels;
  const column = rowColumns(panels, rowOf(panel)).find(col => col.some(p => p.id === panelId))!;
  const lastOfColumn = [...column].reverse().find(p => p.id !== panelId)!;
  const without = panels.filter(p => p.id !== panelId);
  const insertAt = without.findIndex(p => p.id === lastOfColumn.id) + 1;
  without.splice(insertAt, 0, { ...panel, layoutColumn: undefined });
  return without;
}
