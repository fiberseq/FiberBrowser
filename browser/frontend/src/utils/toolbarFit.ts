/**
 * Which read-operations toolbar groups go to the More menu. Pure: the toolbar
 * measures, this decides.
 *
 * Only the groups' folded widths count: a group the user opens shows its
 * controls in the row and may wrap it onto a second line (their choice), but
 * never sends another group to More. When even the folded groups don't fit
 * one row, the least used go to More, in `overflowOrder`.
 */
export interface ToolbarFitInput {
  /** Width the row may use. */
  available: number;
  /** Gap between groups. */
  gap: number;
  /** Width of the More button (kept free when something overflows). */
  moreWidth: number;
  /** Each group's folded width, in display order. */
  widths: number[];
  /** Indices in the order they go to More (first = first to go). Groups not listed never overflow. */
  overflowOrder: number[];
}

export interface ToolbarFit {
  /** Indices of the groups in the More menu, in display order. */
  overflow: number[];
}

export function fitToolbar(input: ToolbarFitInput): ToolbarFit {
  const { available, gap, moreWidth, widths, overflowOrder } = input;
  const span = (ids: number[]) => ids.reduce((sum, i) => sum + widths[i], 0) + gap * Math.max(0, ids.length - 1);
  const all = widths.map((_, i) => i);
  // No layout (jsdom, hidden): show everything as it is.
  if (available <= 0) return { overflow: [] };
  if (span(all) <= available) return { overflow: [] };
  const room = available - moreWidth - gap;
  const hidden = new Set<number>();
  for (const i of overflowOrder) {
    if (span(all.filter(k => !hidden.has(k))) <= room) break;
    hidden.add(i);
  }
  return { overflow: all.filter(i => hidden.has(i)) };
}

/**
 * The height the reads keep, whatever the UI size and however many toolbar
 * groups are open: half the window, and never less than 300 px (audit H5).
 */
export function readsMinHeight(windowHeight: number): number {
  return Math.max(300, Math.round(windowHeight * 0.5));
}

/**
 * The next open group to fold while the toolbar leaves the reads too little
 * height: the least used first (lowest `overflowRank`), never the group the
 * user has just opened, and never one already in the More menu. Null: none left.
 */
export function nextGroupToFold(input: {
  groups: { id: string; overflowRank: number }[];
  open: (id: string) => boolean;
  folded: ReadonlySet<string>;
  inMore: ReadonlySet<string>;
  keep: string | null;
}): string | null {
  const { groups, open, folded, inMore, keep } = input;
  const order = groups
    .map((g, i) => ({ g, i }))
    .sort((a, b) => (a.g.overflowRank - b.g.overflowRank) || (a.i - b.i));
  for (const { g } of order) {
    if (g.id === keep || folded.has(g.id) || inMore.has(g.id) || !open(g.id)) continue;
    return g.id;
  }
  return null;
}
