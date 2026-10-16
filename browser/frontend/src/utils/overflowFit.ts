/**
 * Which items of a row (tabs, strip chips) fit in the width there is, and
 * which go to a "More" menu. Pure: the components measure, this decides.
 *
 * Items keep their order. When not everything fits, room is kept for the More
 * button, and the pinned items (the active tab) always stay visible, taking
 * the place of the last ones that would otherwise show.
 */
export function fitRow(
  widths: number[],
  available: number,
  options: { gap?: number; moreWidth?: number; pinned?: number[] } = {},
): { visible: number[]; overflow: number[] } {
  const gap = options.gap ?? 0;
  const moreWidth = options.moreWidth ?? 0;
  const pinned = new Set((options.pinned ?? []).filter(i => i >= 0 && i < widths.length));
  const all = widths.map((_, i) => i);
  const span = (ids: number[]) => ids.reduce((sum, i) => sum + widths[i], 0) + gap * Math.max(0, ids.length - 1);
  if (widths.length === 0 || span(all) <= available) return { visible: all, overflow: [] };

  const room = available - moreWidth - gap;
  const visible: number[] = [];
  // Pinned items first claim their room, then the others in order.
  const pinnedIds = all.filter(i => pinned.has(i));
  const used = () => span([...pinnedIds, ...visible]);
  for (const i of all) {
    if (pinned.has(i)) continue;
    visible.push(i);
    if (used() > room) { visible.pop(); break; }
  }
  const shown = [...pinnedIds, ...visible].sort((a, b) => a - b);
  const shownSet = new Set(shown);
  return { visible: shown, overflow: all.filter(i => !shownSet.has(i)) };
}
