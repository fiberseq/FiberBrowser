/**
 * How one layout row shares its width between dataset panels and analysis
 * (side) panels, so a side panel is never squeezed until its content clips.
 */

/** A side (analysis) panel narrower than this squeezes its controls. */
export const SIDE_PANEL_MIN_WIDTH = 420;
/**
 * The reads keep at least this much beside side panels; below it the side
 * panels go to the drawer over the reads (one visible at a time, in tabs).
 * At 320 two side panels left the reads about 180-370 px wide (audit M7).
 */
export const DATASET_PANEL_MIN_WIDTH = 480;
/** The widest a side panel gets when it slides over the reads (until the user resizes the drawer). */
export const OVERLAY_PANEL_WIDTH = 480;
/**
 * A side panel the user docked beside the reads on purpose (the drawer's dock
 * button or a tab's Pop out) keeps its column down to these tighter minimums:
 * the comfortable ones above decide only when a side panel goes to the drawer
 * by itself. With them as a veto, docking failed even in a full-screen window
 * whenever two datasets or three side panels shared the row (owner, 1 Oct).
 * Since the scroll policy (nothing goes to the drawer by itself on screen) the
 * dock button only lifts the pin and no longer marks a panel 'beside' (usability
 * round 3, B1): these apply to panels a session saved as docked.
 */
export const DOCKED_SIDE_PANEL_MIN_WIDTH = 320;
export const DOCKED_DATASET_PANEL_MIN_WIDTH = 360;
/**
 * The scroll policy's floors (usability audit Top 10, X-1): on screen nothing goes to the drawer by itself any more;
 * when the row's panels don't fit even at the docked minimums, each keeps its floor and the row scrolls sideways.
 * Read panels: 480 px beside side panels (360 beside one docked on purpose), 240 px in a row of read panels only
 * (five or six split panels still share a laptop window); side panels: 420 px (320 docked on purpose), or their
 * plugin's minUsableWidth when larger.
 */
export const DATASET_PANEL_FLOOR = 240;
export const SIDE_PANEL_FLOOR = DOCKED_SIDE_PANEL_MIN_WIDTH;
/** The drawer's width range when the user resizes it (the window may cap it lower). */
export const DRAWER_MIN_WIDTH = 320;
export const DRAWER_MAX_WIDTH = 1200;

export interface RowColumn {
  /** Every panel in the column is an analysis panel. */
  analysis: boolean;
  /** The column's saved width fraction, if it was resized. */
  fraction?: number | null;
  /** An analysis column the user pinned to the side: always a drawer over the reads (on screen). */
  pinned?: boolean;
  /**
   * An analysis column the user docked beside the reads on purpose: it keeps its
   * column down to the DOCKED_* minimums, and only an automatic side column goes
   * to the drawer to make room for it.
   */
  docked?: boolean;
  /** The narrowest its side panels are usable (plugin minUsableWidth): never docked narrower. */
  minWidth?: number;
}

interface Minimums { side: number; dataset: number }
const COMFORTABLE: Minimums = { side: SIDE_PANEL_MIN_WIDTH, dataset: DATASET_PANEL_MIN_WIDTH };
const DOCKED: Minimums = { side: DOCKED_SIDE_PANEL_MIN_WIDTH, dataset: DOCKED_DATASET_PANEL_MIN_WIDTH };

export interface RowLayout {
  /**
   * 'flow': every column side by side (widths per column).
   * 'overlay': the analysis columns slide over the reads at the right (width 0 in
   * the flow; `overlayWidth` each, stacked), the dataset columns share the row.
   */
  mode: 'flow' | 'overlay';
  widths: number[];
  overlayWidth: number;
  /** Per column: drawn in the drawer over the reads (pinned, or the narrow-window fallback). */
  overlay: boolean[];
  /**
   * The scroll policy only: the columns' total width (gaps not included) when it is wider than the row; the row
   * then scrolls sideways instead of squeezing a panel below its floor or putting it in the drawer.
   */
  scrollWidth?: number;
}

/**
 * The scroll policy for one row's columns (none pinned): the comfortable minimums when they fit (with a column the
 * user docked on purpose, the docked ones as before), else every column at its floor and the row scrolls. Nothing
 * goes to the drawer.
 */
function planScroll(columns: RowColumn[], available: number): { widths: number[]; overlayWidth: number; scrollWidth?: number } {
  const mixed = columns.some(c => c.analysis) && columns.some(c => !c.analysis);
  const anyDocked = columns.some(c => c.analysis && c.docked);
  // The floors: the comfortable minimums (the docked ones beside a panel docked on purpose), read panels 240 px in a
  // row of read panels only; a side panel never below its own usable width.
  const floors = columns.map(c => (c.analysis
    ? Math.max(c.docked ? SIDE_PANEL_FLOOR : SIDE_PANEL_MIN_WIDTH, c.minWidth ?? 0)
    : !mixed ? DATASET_PANEL_FLOOR : anyDocked ? DOCKED.dataset : DATASET_PANEL_MIN_WIDTH));
  let overlayWidth = 0;
  for (const min of anyDocked ? [COMFORTABLE, DOCKED] : [COMFORTABLE]) {
    const plan = planFlow(columns, available, { allowOverlay: true }, min);
    overlayWidth = plan.overlayWidth;
    if (plan.mode === 'flow') {
      // A row of only side or only dataset panels shares the row without minimums: check the floors here.
      if (plan.widths.every((w, i) => w >= floors[i])) return { widths: plan.widths, overlayWidth };
      break;
    }
  }
  const widths = floors;
  const total = widths.reduce((a, b) => a + b, 0);
  if (total <= available) {
    // Fits at the floors (only side, or only dataset columns): the spare width goes by the columns' shares.
    const extra = share(columns.map(c => c.fraction ?? 1), available - total);
    return { widths: widths.map((w, i) => w + extra[i]), overlayWidth };
  }
  return { widths, overlayWidth, scrollWidth: total };
}

function share(fractions: number[], total: number): number[] {
  const sum = fractions.reduce((a, b) => a + b, 0) || 1;
  return fractions.map(f => Math.floor(total * (f / sum)));
}

/**
 * Widths for the columns of one row. `available` is the width left for the
 * columns themselves (gaps already taken off). Side panels get at least
 * SIDE_PANEL_MIN_WIDTH when the dataset panels can keep DATASET_PANEL_MIN_WIDTH;
 * otherwise (`allowOverlay`) the side panels slide over the reads instead.
 */
function planFlow(columns: RowColumn[], available: number, options: { allowOverlay?: boolean; gap?: number } = {}, min: Minimums = COMFORTABLE): Omit<RowLayout, 'overlay'> {
  const n = columns.length;
  const overlayWidth = Math.max(0, Math.min(OVERLAY_PANEL_WIDTH, available - 48));
  if (n === 0) return { mode: 'flow', widths: [], overlayWidth };
  const hasExplicit = columns.some(c => c.fraction != null);
  const fractions = columns.map(c => (hasExplicit ? c.fraction ?? 1 / n : 1));
  const widths = share(fractions, available);

  const analysis = columns.map((c, i) => (c.analysis ? i : -1)).filter(i => i >= 0);
  const datasets = columns.map((c, i) => (c.analysis ? -1 : i)).filter(i => i >= 0);
  if (analysis.length === 0 || datasets.length === 0) return { mode: 'flow', widths, overlayWidth };
  // Each side column's minimum: the row's, or its panel's own usable minimum when larger.
  const sideMin = (i: number) => Math.max(min.side, columns[i].minWidth ?? 0);
  if (analysis.every(i => widths[i] >= sideMin(i)) && datasets.every(i => widths[i] >= min.dataset)) {
    return { mode: 'flow', widths, overlayWidth };
  }

  // Give each side panel its minimum (or more, if it had more and the reads can
  // spare it) and the dataset panels the rest, never less than their minimum.
  const needData = datasets.length * min.dataset;
  let sideWidths = analysis.map(i => Math.max(widths[i], sideMin(i)));
  if (available - sideWidths.reduce((a, b) => a + b, 0) < needData) sideWidths = analysis.map(i => sideMin(i));
  const rest = available - sideWidths.reduce((a, b) => a + b, 0);
  if (rest >= needData) {
    const datasetWidths = share(datasets.map(i => fractions[i]), rest);
    const next = [...widths];
    analysis.forEach((i, k) => { next[i] = sideWidths[k]; });
    datasets.forEach((i, k) => { next[i] = datasetWidths[k]; });
    // A saved fraction can still leave one dataset under its minimum: each gets the
    // minimum, and what is left goes by their fractions.
    if (datasets.some(i => next[i] < min.dataset)) {
      const extra = share(datasets.map(i => fractions[i]), rest - needData);
      datasets.forEach((i, k) => { next[i] = min.dataset + extra[k]; });
    }
    return { mode: 'flow', widths: next, overlayWidth };
  }
  if (!options.allowOverlay) return { mode: 'flow', widths, overlayWidth };

  // Too narrow for both: the dataset panels take the row, the side panels slide over it.
  const gap = options.gap ?? 0;
  const flowAvailable = available + gap * analysis.length; // their gaps come back to the flow
  // Each dataset keeps its minimum where the row allows, the rest by saved fractions.
  const minimum = Math.min(DATASET_PANEL_MIN_WIDTH, Math.floor(flowAvailable / datasets.length));
  const extra = share(datasets.map(i => fractions[i]), flowAvailable - minimum * datasets.length);
  const next = columns.map(() => 0);
  datasets.forEach((i, k) => { next[i] = minimum + extra[k]; });
  return { mode: 'overlay', widths: next, overlayWidth };
}

/**
 * Widths for the columns of one row. `available` is the width left for the
 * columns themselves (gaps already taken off). Columns the user pinned to the
 * side always go to the drawer over the reads (on screen); the others share
 * the row: side panels get at least SIDE_PANEL_MIN_WIDTH when the dataset
 * panels can keep DATASET_PANEL_MIN_WIDTH, otherwise (`allowOverlay`) they
 * slide over the reads too.
 */
export function planRowLayout(columns: RowColumn[], available: number, options: { allowOverlay?: boolean; gap?: number; scroll?: boolean } = {}): RowLayout {
  const gap = options.gap ?? 0;
  let pinned = columns.map(c => Boolean(options.allowOverlay && c.analysis && c.pinned));
  // Something must stay in the row: with every column pinned, none is.
  if (pinned.length > 0 && pinned.every(Boolean)) pinned = pinned.map(() => false);
  const pinnedCount = pinned.filter(Boolean).length;
  if (options.scroll) {
    // On screen: panels stay where the user put them. Only a pin puts a side panel in the drawer; the rest stay in
    // the row at their minimums, and a row too narrow for them scrolls sideways.
    const n = columns.length;
    const hasExplicit = columns.some(c => c.fraction != null);
    const rest = columns.map((c, i) => ({ c: hasExplicit ? { ...c, fraction: c.fraction ?? 1 / n } : c, i })).filter(({ i }) => !pinned[i]);
    const sub = planScroll(rest.map(({ c }) => c), available + gap * pinnedCount);
    const widths = columns.map(() => 0);
    rest.forEach(({ i }, k) => { widths[i] = sub.widths[k]; });
    return {
      mode: pinnedCount ? 'overlay' : 'flow', widths, overlayWidth: Math.max(0, Math.min(OVERLAY_PANEL_WIDTH, available - 48)),
      overlay: pinned, ...(sub.scrollWidth != null ? { scrollWidth: sub.scrollWidth } : {}),
    };
  }
  if (pinnedCount === 0 && !columns.some(c => c.analysis && c.docked)) {
    const plan = planFlow(columns, available, options);
    return { ...plan, overlay: columns.map(c => plan.mode === 'overlay' && c.analysis) };
  }
  // The pinned columns' gaps go back to the others. A column without a saved
  // width keeps the default share of the whole row (1/n of all columns), the
  // same default the resize handles use, so dragging a divider moves only it.
  const n = columns.length;
  const hasExplicit = columns.some(c => c.fraction != null);
  const withShare = (c: RowColumn) => (hasExplicit ? { ...c, fraction: c.fraction ?? 1 / n } : c);
  const placeFlow = (drawer: boolean[], min: Minimums) => {
    const rest = columns.map((c, i) => ({ c: withShare(c), i })).filter(({ i }) => !drawer[i]);
    const leaving = drawer.filter(Boolean).length;
    const sub = planFlow(rest.map(({ c }) => c), available + gap * leaving, options, min);
    const widths = columns.map(() => 0);
    const overlay = [...drawer];
    rest.forEach(({ c, i }, k) => {
      widths[i] = sub.widths[k];
      if (sub.mode === 'overlay' && c.analysis) overlay[i] = true;
    });
    return { sub, widths, overlay };
  };
  // Everything not pinned beside the reads at the comfortable minimums.
  let placed = placeFlow(pinned, COMFORTABLE);
  if (placed.sub.mode === 'overlay' && options.allowOverlay) {
    // Too narrow for that: the side columns docked on purpose stay beside the reads at
    // the tighter minimums, and the automatic ones go to the drawer to make room.
    const autoToDrawer = columns.map((c, i) => pinned[i] || (c.analysis && !c.docked));
    if (columns.some((c, i) => c.analysis && c.docked && !pinned[i]) && !autoToDrawer.every(Boolean)) {
      const docked = placeFlow(autoToDrawer, DOCKED);
      if (docked.sub.mode === 'flow') placed = docked;
    }
  }
  const mode = placed.overlay.some(Boolean) ? 'overlay' : 'flow';
  return { mode, widths: placed.widths, overlayWidth: placed.sub.overlayWidth, overlay: placed.overlay };
}

/**
 * The side columns that would still be in the drawer if `dock` (default: every
 * side column of the row) were docked beside the reads on purpose (pins
 * lifted): none when they all fit beside the reads at the docked minimums.
 * Docking the drawer moves all of its panels out together, or none of them
 * (owner, 1 Oct: docking one of several drawer tabs left the others stuck);
 * a tab's Pop out asks the same for its own column.
 */
export function columnsLeftInDrawer(columns: RowColumn[], available: number, options: { gap?: number; dock?: number[]; scroll?: boolean } = {}): number[] {
  // The scroll policy: docked panels always fit (the row scrolls).
  if (options.scroll) return [];
  const dock = new Set(options.dock ?? columns.map((c, i) => (c.analysis ? i : -1)).filter(i => i >= 0));
  const plan = planRowLayout(
    columns.map((c, i) => (dock.has(i) && c.analysis ? { ...c, pinned: false, docked: true } : c)),
    available,
    { gap: options.gap, allowOverlay: true },
  );
  return plan.overlay.map((inDrawer, i) => (inDrawer ? i : -1)).filter(i => i >= 0);
}

/**
 * How wide the drawer may get (px): from its right edge (`drawerRight`, from the
 * row's right) to the right edge of the last side panel docked left of the reads
 * (it must never cover one), or `margin` px from the row's left edge.
 */
export function drawerRoom(layout: RowLayout, columns: RowColumn[], gap: number, rowWidth: number, drawerRight: number, margin = 48): number {
  let left = gap;
  let lastDataset = -1;
  const flow = columns.map((_, i) => i).filter(i => !layout.overlay[i]);
  flow.forEach((i, k) => { if (!columns[i].analysis) lastDataset = k; });
  let leftLimit = margin;
  flow.forEach((i, k) => {
    const right = left + layout.widths[i];
    if (k < lastDataset && columns[i].analysis) leftLimit = Math.max(leftLimit, right + gap);
    left = right + gap;
  });
  return Math.max(0, rowWidth - drawerRight - leftLimit);
}

/**
 * The drawer's width: the user's (resized) width, else OVERLAY_PANEL_WIDTH,
 * within DRAWER_MIN_WIDTH and what the row leaves (`room`); never wider than the room.
 */
export function clampDrawerWidth(preferred: number | null | undefined, room: number): number {
  const max = Math.max(0, Math.min(DRAWER_MAX_WIDTH, room));
  const want = preferred != null && Number.isFinite(preferred) ? preferred : OVERLAY_PANEL_WIDTH;
  return Math.max(Math.min(DRAWER_MIN_WIDTH, max), Math.min(max, Math.round(want)));
}

/**
 * Where the drawer sits: over the dataset panels only. Its right edge is the
 * right edge of the last dataset column in the flow, so a side panel docked
 * beside the reads (to their right) is never covered by a pinned drawer
 * (audit M19). Returns the distance from the row's right edge, in px.
 */
export function drawerRightOffset(layout: RowLayout, columns: RowColumn[], gap: number): number {
  const flow = columns.map((_, i) => i).filter(i => !layout.overlay[i]);
  let lastDataset = -1;
  flow.forEach((i, k) => { if (!columns[i].analysis) lastDataset = k; });
  if (lastDataset < 0) return gap;
  return flow.slice(lastDataset + 1).reduce((sum, i) => sum + layout.widths[i] + gap, gap);
}

/**
 * The drawer starts under the top dataset panels' header bars, but a panel
 * stacked lower down has its header bar beside the drawer, which covers the
 * bar's right end (Clean view, ⋯ Panel actions). Each such column's lower
 * headers keep their controls left of the drawer: how many px of the column's
 * right end (plus a little room) the drawer covers, per column (0: not covered).
 * `drawer` is the drawer's left and right edges in the row (null: no drawer
 * showing). A column whose right end is clear of the drawer (left of it, or a
 * side panel pinned right of it) is left alone.
 */
export function headerInsetsUnderDrawer(
  layout: RowLayout,
  gap: number,
  drawer: { left: number; right: number } | null,
  room = 8,
): number[] {
  let left = gap;
  return layout.widths.map((width, i) => {
    if (layout.overlay[i]) return 0;
    const colRight = left + width;
    left += width + gap;
    if (!drawer || colRight <= drawer.left || colRight > drawer.right + 1) return 0;
    return Math.min(width, colRight - drawer.left + room);
  });
}

/** Side panels may slide over the reads only on screen: figure renders and exports keep every panel in the flow. */
export function overlayAllowed(opts: { renderMode: boolean; exporting: boolean; fullView: boolean }): boolean {
  return !opts.renderMode && !opts.exporting && !opts.fullView;
}

/**
 * Column pairs that get a resize handle: neighbours in the flow. In overlay
 * mode the side columns leave the flow, so two dataset columns with a side
 * column between them become neighbours.
 */
export function flowResizePairs(layout: RowLayout, columns: RowColumn[]): Array<[number, number]> {
  const flow = columns.map((_, i) => i).filter(i => !layout.overlay[i]);
  return flow.slice(0, -1).map((left, k) => [left, flow[k + 1]]);
}

/**
 * Where a panel dragged over the side-panel overlay lands: near its bottom it
 * stacks under the last side column; elsewhere it becomes a new column right
 * after the side columns. Never the reads underneath.
 */
export function overlayDropTarget(
  y: number, height: number, overlayColumns: number[], rowIndex: number, stackZone: number,
): { rowIndex: number; insertBefore: number; stackColumnIndex?: number } {
  const last = overlayColumns[overlayColumns.length - 1];
  return y > height - stackZone
    ? { rowIndex, insertBefore: 0, stackColumnIndex: last }
    : { rowIndex, insertBefore: last + 1 };
}
