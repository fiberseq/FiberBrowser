import { describe, expect, it } from 'vitest';
import {
  DATASET_PANEL_MIN_WIDTH, SIDE_PANEL_MIN_WIDTH, DOCKED_DATASET_PANEL_MIN_WIDTH, DOCKED_SIDE_PANEL_MIN_WIDTH,
  DRAWER_MAX_WIDTH, DRAWER_MIN_WIDTH, OVERLAY_PANEL_WIDTH, clampDrawerWidth, columnsLeftInDrawer, drawerRoom, drawerRightOffset, flowResizePairs, headerInsetsUnderDrawer, overlayAllowed, overlayDropTarget, planRowLayout,
} from './panelRowLayout';

const ds = { analysis: false }, side = { analysis: true };

describe('planRowLayout', () => {
  it('wide windows: equal columns as before', () => {
    expect(planRowLayout([ds, side], 1400)).toEqual({ mode: 'flow', widths: [700, 700], overlayWidth: 480, overlay: [false, false] });
  });

  it('a side panel squeezed below its minimum takes it from the dataset panels', () => {
    const plan = planRowLayout([{ analysis: false, fraction: 0.7 }, { analysis: true, fraction: 0.3 }], 1000, { allowOverlay: true });
    expect(plan.mode).toBe('flow');
    expect(plan.widths).toEqual([1000 - SIDE_PANEL_MIN_WIDTH, SIDE_PANEL_MIN_WIDTH]);
    expect(plan.widths[0]).toBeGreaterThanOrEqual(DATASET_PANEL_MIN_WIDTH);
  });

  it('too narrow for both: the side panels slide over the reads, datasets keep the row', () => {
    const plan = planRowLayout([ds, ds, side], 1028, { allowOverlay: true, gap: 8 });
    expect(plan.mode).toBe('overlay');
    expect(plan.widths[2]).toBe(0);
    expect(plan.widths[0] + plan.widths[1]).toBeLessThanOrEqual(1036);
    expect(plan.overlayWidth).toBe(480);
  });

  // Audit M7: with two side panels the reads were left ~370 px (1280) or ~180 px (1024).
  it('the reads keep at least 480 px; below that the side panels go to the drawer', () => {
    expect(DATASET_PANEL_MIN_WIDTH).toBe(480);
    // 1280-px window: two side panels at their minimum would leave the reads 360 px.
    const two = planRowLayout([ds, side, side], 1200, { allowOverlay: true, gap: 8 });
    expect(two.mode).toBe('overlay');
    expect(two.widths[0]).toBeGreaterThanOrEqual(1200);
    // One side panel fits beside them.
    expect(planRowLayout([ds, side], 1200, { allowOverlay: true }).widths).toEqual([600, 600]);
    // Side panels the user made wide no longer squeeze the reads: they shrink first...
    const wide = planRowLayout([{ analysis: false, fraction: 0.2 }, { analysis: true, fraction: 0.8 }], 1200, { allowOverlay: true });
    expect(wide).toMatchObject({ mode: 'flow', widths: [780, 420] });
    // ...and go to the drawer when even that leaves the reads under their minimum.
    const squeezed = planRowLayout([{ analysis: false, fraction: 0.2 }, { analysis: true, fraction: 0.4 }, { analysis: true, fraction: 0.4 }], 1200, { allowOverlay: true });
    expect(squeezed.mode).toBe('overlay');
  });

  it('in drawer mode a saved small fraction still leaves each dataset its minimum', () => {
    const plan = planRowLayout([{ analysis: false, fraction: 0.1 }, { analysis: false, fraction: 0.3 }, { analysis: true, fraction: 0.6 }], 1300, { allowOverlay: true });
    expect(plan.mode).toBe('overlay');
    expect(Math.min(plan.widths[0], plan.widths[1])).toBeGreaterThanOrEqual(DATASET_PANEL_MIN_WIDTH);
    expect(plan.widths[1]).toBeGreaterThan(plan.widths[0]);
  });

  // Audit M19: a pinned drawer covered the form of a side panel docked beside the reads.
  it('the drawer sits over the dataset panels only, left of side panels docked beside them', () => {
    const cols = [ds, side, { analysis: true, pinned: true }];
    const plan = planRowLayout(cols, 1000, { allowOverlay: true, gap: 8 });
    expect(plan.overlay).toEqual([false, false, true]);
    expect(drawerRightOffset(plan, cols, 8)).toBe(8 + plan.widths[1] + 8);
    // Only datasets in the flow: the drawer is at the row's right edge.
    const alone = planRowLayout([ds, { analysis: true, pinned: true }], 1000, { allowOverlay: true, gap: 8 });
    expect(drawerRightOffset(alone, [ds, { analysis: true, pinned: true }], 8)).toBe(8);
  });

  it('several side panels in a narrow window all go to the overlay', () => {
    const plan = planRowLayout([ds, side, side, side], 1000, { allowOverlay: true });
    expect(plan.mode).toBe('overlay');
    expect(plan.widths.slice(1)).toEqual([0, 0, 0]);
  });

  it('keeps a side panel the user made wider, and saved fractions for the datasets', () => {
    const plan = planRowLayout([{ analysis: false, fraction: 0.5 }, { analysis: false, fraction: 0.3 }, { analysis: true, fraction: 0.2 }], 1500);
    expect(plan.mode).toBe('flow');
    expect(plan.widths[2]).toBe(SIDE_PANEL_MIN_WIDTH);
    expect(plan.widths[0]).toBeGreaterThan(plan.widths[1]);
  });

  it('without overlay (figure renders) it never removes a panel from the row', () => {
    expect(planRowLayout([ds, ds, side], 800).mode).toBe('flow');
  });

  it('exports and figure renders keep side panels in the flow; only the screen uses the overlay', () => {
    expect(overlayAllowed({ renderMode: false, exporting: false, fullView: false })).toBe(true);
    expect(overlayAllowed({ renderMode: false, exporting: true, fullView: false })).toBe(false);
    expect(overlayAllowed({ renderMode: true, exporting: false, fullView: false })).toBe(false);
    expect(overlayAllowed({ renderMode: false, exporting: false, fullView: true })).toBe(false);
  });

  it('dataset / side / dataset in overlay mode: the two datasets get a resize handle between them', () => {
    const cols = [ds, side, ds];
    const overlay = planRowLayout(cols, 1000, { allowOverlay: true });
    expect(overlay.mode).toBe('overlay');
    expect(flowResizePairs(overlay, cols)).toEqual([[0, 2]]);
    const flow = planRowLayout(cols, 2400, { allowOverlay: true });
    expect(flow.mode).toBe('flow');
    expect(flowResizePairs(flow, cols)).toEqual([[0, 1], [1, 2]]);
  });

  it('a panel dropped over the overlay lands with the side panels, not on the reads underneath', () => {
    // Columns 1 and 3 are side panels in the overlay; the overlay is 600 px tall.
    expect(overlayDropTarget(590, 600, [1, 3], 0, 40)).toEqual({ rowIndex: 0, insertBefore: 0, stackColumnIndex: 3 });
    expect(overlayDropTarget(100, 600, [1, 3], 0, 40)).toEqual({ rowIndex: 0, insertBefore: 4 });
  });

  it('a side panel pinned by the user is a drawer over the reads even in a wide window', () => {
    const pinnedSide = { analysis: true, pinned: true };
    const plan = planRowLayout([ds, side, pinnedSide], 2400, { allowOverlay: true, gap: 8 });
    expect(plan.overlay).toEqual([false, false, true]);
    expect(plan.widths[2]).toBe(0);
    // The others share the whole row, the pinned column's gap included.
    expect(plan.widths[0] + plan.widths[1]).toBe(2408);
    expect(flowResizePairs(plan, [ds, side, pinnedSide])).toEqual([[0, 1]]);
  });

  it('pinning keeps the narrow-window fallback for the unpinned side panels', () => {
    const plan = planRowLayout([ds, side, { analysis: true, pinned: true }], 700, { allowOverlay: true });
    expect(plan.overlay).toEqual([false, true, true]);
  });

  it('figure renders, exports and full view ignore pins; a row of only pinned panels keeps them', () => {
    expect(planRowLayout([ds, { analysis: true, pinned: true }], 2400).overlay).toEqual([false, false]);
    expect(planRowLayout([{ analysis: true, pinned: true }], 2400, { allowOverlay: true }).overlay).toEqual([false]);
  });

  it('with a pin, columns without a saved width keep the default share used by the resize handles', () => {
    // Three datasets, the first resized to 0.5; an analysis column pinned.
    const cols = [{ analysis: false, fraction: 0.5 }, ds, ds, { analysis: true, pinned: true }];
    const plan = planRowLayout(cols, 1600, { allowOverlay: true });
    // The unsized ones take 1/4 each (n = 4 columns), in proportion to 0.5.
    expect(plan.widths[1]).toBe(plan.widths[2]);
    expect(plan.widths[0] / plan.widths[1]).toBeCloseTo(2, 1);
  });
});

// Codex integration review (fb24, M2): datasets stack by default; in a narrow window the
// drawer covered the lower panel's Clean view and ⋯ Panel actions.
describe('headerInsetsUnderDrawer', () => {
  const gap = 8;

  it('a column under the drawer keeps its lower header controls left of it', () => {
    const plan = planRowLayout([ds, side, side], 1024 - gap * 4, { allowOverlay: true, gap });
    expect(plan.mode).toBe('overlay');
    const right = drawerRightOffset(plan, [ds, side, side], gap);
    const drawerLeft = 1024 - right - plan.overlayWidth;
    const insets = headerInsetsUnderDrawer(plan, gap, { left: drawerLeft, right: 1024 - right });
    // The dataset column ends at gap + width; the drawer covers its right end (plus room).
    expect(insets[0]).toBe(gap + plan.widths[0] - drawerLeft + 8);
    expect(insets[0]).toBeGreaterThan(plan.overlayWidth - gap);
    // Controls left of the drawer: what stays uncovered is the column's left part.
    expect(gap + plan.widths[0] - insets[0]).toBeLessThan(drawerLeft);
    expect(insets.slice(1)).toEqual([0, 0]);
  });

  it('no drawer showing (tucked away, or wide windows): nothing to keep clear', () => {
    const plan = planRowLayout([ds, side, side], 1016, { allowOverlay: true, gap });
    expect(headerInsetsUnderDrawer(plan, gap, null)).toEqual([0, 0, 0]);
    const wide = planRowLayout([ds, side], 1800, { allowOverlay: true, gap });
    expect(headerInsetsUnderDrawer(wide, gap, null)).toEqual([0, 0]);
  });

  it('a dataset column clear of the drawer (left of another) is left alone', () => {
    const plan = { mode: 'overlay' as const, widths: [300, 600, 0], overlayWidth: 480, overlay: [false, false, true] };
    const insets = headerInsetsUnderDrawer(plan, gap, { left: 1024 - gap - 480, right: 1024 - gap });
    expect(insets[0]).toBe(0);
    expect(insets[1]).toBe(gap + 300 + gap + 600 - (1024 - gap - 480) + 8);
  });

  it('a side panel pinned right of the drawer (its own column) is not under it', () => {
    // Dataset column, then a pinned side column; the drawer sits left of the pinned one.
    const plan = { mode: 'overlay' as const, widths: [560, 420, 0], overlayWidth: 480, overlay: [false, false, true] };
    const drawer = { left: gap + 560 - 480, right: gap + 560 };
    const insets = headerInsetsUnderDrawer(plan, gap, drawer);
    expect(insets[0]).toBe(480 + 8);
    expect(insets[1]).toBe(0);
  });
});

// Owner (1 Oct): docking one of several drawer tabs brought out only that one (or, in a
// narrow window, pinned it and pushed the other out); the rest stayed stuck in the drawer.
describe('columnsLeftInDrawer (docking the whole drawer)', () => {
  const pinned = { analysis: true, pinned: true };
  it('wide enough: every pinned side panel comes out, none stays', () => {
    expect(columnsLeftInDrawer([ds, pinned, pinned], 1700 - 32, { gap: 8 })).toEqual([]);
  });
  it('too narrow for them beside the reads: all of the side columns stay, pinned or not', () => {
    // (At 1100 two side panels now fit at the docked minimums: 900 is too narrow for them.)
    expect(columnsLeftInDrawer([ds, side, side], 900 - 32, { gap: 8 })).toEqual([1, 2]);
    // One beside the reads, one pinned: docking the pinned one would pull the other in too.
    expect(columnsLeftInDrawer([ds, side, pinned], 900 - 32, { gap: 8 })).toEqual([1, 2]);
  });
});

// Owner (1 Oct): "no matter how big the window is, pressing the dock button fails and says to
// widen" it. The check vetoed an explicit dock with the comfortable minimums that only decide
// when a side panel goes to the drawer by itself (480 px per dataset + 420 per side panel):
// with two datasets, or three side panels, even a full-screen 1728 window was "too narrow".
describe('docking on purpose uses the docked minimums', () => {
  const docked = { analysis: true, docked: true };
  // The row's width less the gaps (8 px each), as TrackContainer passes it; window − 40 px of chrome.
  const row = (window: number, columns: number) => window - 40 - 8 * (columns + 1);
  const cases: Array<[number, number, number]> = [
    // [window, datasets, side panels]: all must come out
    [1280, 1, 1], [1280, 1, 2],
    [1728, 1, 1], [1728, 1, 2], [1728, 1, 3], [1728, 2, 1], [1728, 2, 2],
    [2560, 1, 3], [2560, 2, 3], [2560, 3, 3],
  ];
  for (const [window, datasets, sides] of cases) {
    it(`${window} px, ${datasets} dataset(s), ${sides} side panel(s) in the drawer: they all dock`, () => {
      const cols = [...Array(datasets).fill(ds), ...Array(sides).fill(side)];
      expect(columnsLeftInDrawer(cols, row(window, cols.length), { gap: 8 })).toEqual([]);
      // ...and once docked, the layout keeps them beside the reads (no flip back into the drawer).
      const plan = planRowLayout(cols.map(c => (c.analysis ? docked : c)), row(window, cols.length), { allowOverlay: true, gap: 8 });
      expect(plan.overlay.some(Boolean)).toBe(false);
      cols.forEach((c, i) => expect(plan.widths[i]).toBeGreaterThanOrEqual(c.analysis ? DOCKED_SIDE_PANEL_MIN_WIDTH : DOCKED_DATASET_PANEL_MIN_WIDTH));
      expect(plan.widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(row(window, cols.length));
    });
  }
  it('still too narrow at the docked minimums: they stay, and the button says so', () => {
    expect(columnsLeftInDrawer([ds, side, side, side], row(1280, 4), { gap: 8 })).toEqual([1, 2, 3]);
  });
  it('the comfortable minimums still decide when an undocked side panel goes to the drawer', () => {
    const plan = planRowLayout([ds, side, side], row(1280, 3), { allowOverlay: true, gap: 8 });
    expect(plan.overlay).toEqual([false, true, true]);
  });
  it('a docked side panel keeps its column; an automatic one makes room in the drawer', () => {
    const plan = planRowLayout([ds, docked, side], row(1280, 3), { allowOverlay: true, gap: 8 });
    expect(plan.overlay).toEqual([false, false, true]);
    expect(plan.widths[1]).toBeGreaterThanOrEqual(DOCKED_SIDE_PANEL_MIN_WIDTH);
  });
  it('Pop out asks for its own column only: the other tab stays in the drawer', () => {
    expect(columnsLeftInDrawer([ds, side, side], row(1280, 3), { gap: 8, dock: [1] })).toEqual([2]);
    expect(columnsLeftInDrawer([ds, side, side], row(1280, 3), { gap: 8, dock: [2] })).toEqual([1]);
  });
  it('a pin still wins over the docked minimums for the other columns', () => {
    const plan = planRowLayout([ds, docked, { analysis: true, pinned: true }], row(1728, 3), { allowOverlay: true, gap: 8 });
    expect(plan.overlay).toEqual([false, false, true]);
  });
});

describe('clampDrawerWidth (resizing the drawer)', () => {
  it('the default width until resized', () => {
    expect(clampDrawerWidth(null, 2000)).toBe(OVERLAY_PANEL_WIDTH);
  });
  it('the user\'s width, within the minimum and the room the row leaves', () => {
    expect(clampDrawerWidth(700, 2000)).toBe(700);
    expect(clampDrawerWidth(100, 2000)).toBe(DRAWER_MIN_WIDTH);
    expect(clampDrawerWidth(5000, 2000)).toBe(DRAWER_MAX_WIDTH);
    expect(clampDrawerWidth(900, 600)).toBe(600);
  });
  it('never wider than the room, even below the minimum', () => {
    expect(clampDrawerWidth(null, 250)).toBe(250);
    expect(clampDrawerWidth(400, 0)).toBe(0);
  });
});

// Codex review (fb-r3-chrome): the docked minimum must not go under a panel's own usable
// width (Layout: 340), and a resized drawer must not cover a side panel docked left of the reads.
describe('docking respects each panel\'s usable width', () => {
  it('a side panel usable from 340 px is never docked at 320', () => {
    const layout = { analysis: true, minWidth: 340 };
    expect(columnsLeftInDrawer([ds, layout, side], 1000, { gap: 0 })).toEqual([1, 2]);
    expect(columnsLeftInDrawer([ds, layout, side], 1020, { gap: 0 })).toEqual([]);
    const plan = planRowLayout([ds, { ...layout, docked: true }, { analysis: true, docked: true }], 1020, { allowOverlay: true });
    expect(plan.widths[1]).toBeGreaterThanOrEqual(340);
  });
});

describe('drawerRoom', () => {
  it('the row less the drawer\'s right offset and a 48 px margin', () => {
    const plan = planRowLayout([ds, { analysis: true, pinned: true }], 1712, { allowOverlay: true, gap: 8 });
    expect(drawerRoom(plan, [ds, { analysis: true, pinned: true }], 8, 1728, 8)).toBe(1728 - 8 - 48);
  });
  it('stops at a side panel docked left of the reads', () => {
    const cols = [{ analysis: true, docked: true }, ds, { analysis: true, pinned: true }];
    const plan = planRowLayout(cols, 1728 - 32, { allowOverlay: true, gap: 8 });
    expect(plan.overlay).toEqual([false, false, true]);
    const sideRight = 8 + plan.widths[0];
    expect(drawerRoom(plan, cols, 8, 1728, 8)).toBe(1728 - 8 - (sideRight + 8));
  });
});

describe('the scroll policy (usability round 1: panels stay where they are put; narrow rows scroll)', () => {
  const D = { analysis: false };
  const A = { analysis: true };
  it('wide enough: the same widths as before, nothing scrolls', () => {
    const plan = planRowLayout([D, A], 1400, { allowOverlay: true, scroll: true });
    expect(plan.mode).toBe('flow');
    expect(plan.overlay).toEqual([false, false]);
    expect(plan.scrollWidth).toBeUndefined();
    expect(plan.widths).toEqual([700, 700]);
  });
  it('too narrow for the comfortable minimums: each at its floor (reads 480, side 420) and the row scrolls', () => {
    const plan = planRowLayout([D, A, A], 1100, { allowOverlay: true, scroll: true });
    expect(plan.overlay).toEqual([false, false, false]);
    expect(plan.widths).toEqual([480, 420, 420]);
    expect(plan.scrollWidth).toBe(1320);
  });
  it('a side panel docked on purpose keeps the docked minimums (as before), without scrolling while they fit', () => {
    const plan = planRowLayout([D, { analysis: true, docked: true }, { analysis: true, docked: true }], 1100, { allowOverlay: true, scroll: true });
    expect(plan.overlay).toEqual([false, false, false]);
    expect(plan.scrollWidth).toBeUndefined();
    expect(plan.widths[1]).toBeGreaterThanOrEqual(320);
    expect(plan.widths[0]).toBeGreaterThanOrEqual(360);
    const tight = planRowLayout([D, D, { analysis: true, docked: true }], 800, { allowOverlay: true, scroll: true });
    expect(tight.widths).toEqual([360, 360, 320]);
    expect(tight.scrollWidth).toBe(1040);
  });
  it('a side panel usable only from 460 px keeps 460', () => {
    const plan = planRowLayout([D, { analysis: true, minWidth: 460 }], 600, { allowOverlay: true, scroll: true });
    expect(plan.widths).toEqual([480, 460]);
    expect(plan.scrollWidth).toBe(940);
  });
  it('five split panels share a laptop row; seven scroll', () => {
    expect(planRowLayout(Array(5).fill(D), 1400, { allowOverlay: true, scroll: true }).scrollWidth).toBeUndefined();
    expect(planRowLayout(Array(7).fill(D), 1400, { allowOverlay: true, scroll: true }).scrollWidth).toBe(7 * 240);
  });
  it('a pinned side panel is still the drawer the user asked for', () => {
    const plan = planRowLayout([D, { analysis: true, pinned: true }, A], 900, { allowOverlay: true, scroll: true, gap: 8 });
    expect(plan.overlay).toEqual([false, true, false]);
    expect(plan.mode).toBe('overlay');
    expect(plan.widths[1]).toBe(0);
  });
  // Usability round 3, B1: reads + NFRs + Footprints + Co-accessibility at 1440 (row 1400 less the gaps). After a pin is
  // lifted no panel is marked docked, so the row keeps the comfortable widths and scrolls (not 400/320/320/320).
  it('four columns at 1440: 480/420/420/420 and the row scrolls', () => {
    const plan = planRowLayout([D, A, A, A], 1400 - 5 * 8, { allowOverlay: true, gap: 8, scroll: true });
    expect(plan.widths).toEqual([480, 420, 420, 420]);
    expect(plan.overlay).toEqual([false, false, false, false]);
    expect(plan.scrollWidth).toBe(1740);
  });
  it('docking never leaves anything in the drawer under the scroll policy', () => {
    expect(columnsLeftInDrawer([D, { analysis: true, pinned: true }], 500, { scroll: true })).toEqual([]);
  });
});

describe('split-group strips', () => {
  it('a set whose columns were dragged apart gets a strip per run of neighbouring columns', async () => {
    const { splitStripSegments } = await import('../components/tracks/SplitGroupStrip');
    const p = (g: string) => ({ id: g, readSubset: { groupId: g, colour: '#000' } }) as never;
    const segs = splitStripSegments([{ panels: [p('A')] }, { panels: [p('B')] }, { panels: [p('A')] }], [240, 240, 240], [true, true, true], 8);
    expect(segs.map(s => [s.groupId, s.left, s.width])).toEqual([['A', 8, 240], ['B', 256, 240], ['A', 504, 240]]);
    const joined = splitStripSegments([{ panels: [p('A')] }, { panels: [p('A')] }], [240, 240], [true, true], 8);
    expect(joined.map(s => [s.groupId, s.left, s.width])).toEqual([['A', 8, 488]]);
  });
});
