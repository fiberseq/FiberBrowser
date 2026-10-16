import { describe, expect, it } from 'vitest';
import { offscreenPanels, panelCountLabel, scrollForOpened, scrollToReveal, sideOf, type PanelSpan } from './panelRowScroll';

/** Columns side by side from x = 8 with 8-px gaps (as the row lays them out). */
function row(...widths: Array<[string, number]>): PanelSpan[] {
  let x = 8;
  return widths.map(([id, w]) => {
    const span = { id, left: x, right: x + w };
    x += w + 8;
    return span;
  });
}
const contentWidth = (spans: PanelSpan[]) => spans[spans.length - 1].right + 8;

describe('offscreenPanels', () => {
  const spans = row(['reads', 480], ['side', 420], ['fp', 420], ['coacc', 420]);
  const v = { clientWidth: 1400, scrollWidth: contentWidth(spans) };

  it('counts what is cut off on each side, not panels a gap away from wholly visible', () => {
    expect(offscreenPanels(spans, { ...v, scrollLeft: 0 })).toEqual({ left: [], right: [spans[3]] });
    const end = v.scrollWidth - v.clientWidth;
    expect(offscreenPanels(spans, { ...v, scrollLeft: end })).toEqual({ left: [spans[0]], right: [] });
    // 4 px cut off (within the tolerance): in view.
    expect(offscreenPanels(spans, { ...v, scrollLeft: 12 }).left).toEqual([]);
  });

  it('a pinned drawer over the row hides what is under it', () => {
    const off = offscreenPanels(spans, { ...v, scrollLeft: 0, rightInset: 480 });
    expect(off.right.map(s => s.id)).toEqual(['fp', 'coacc']);
  });
});

describe('scrollToReveal', () => {
  const spans = row(['a', 480], ['b', 480], ['c', 480], ['d', 480], ['e', 480]);
  const v = { clientWidth: 1000, scrollWidth: contentWidth(spans) };

  it('brings the nearest hidden panel on that side wholly into view, moving as little as possible', () => {
    // View 0..1000: a, b in view; c (984..1464) cut off at the right.
    expect(scrollToReveal(spans, { ...v, scrollLeft: 0 }, 'right')).toBe(1464 + 8 - 1000);
    expect(scrollToReveal(spans, { ...v, scrollLeft: 0 }, 'left')).toBeNull();
    // From the far right, the left cue shows the panel just left of the view, at the left edge.
    const end = v.scrollWidth - v.clientWidth;
    const hiddenLeft = offscreenPanels(spans, { ...v, scrollLeft: end }).left;
    const nearest = hiddenLeft[hiddenLeft.length - 1];
    expect(scrollToReveal(spans, { ...v, scrollLeft: end }, 'left')).toBe(nearest.left - 8);
  });
});

describe('scrollForOpened', () => {
  it('Co-accessibility opening beside Footprints: only as far as needed, the working panel stays', () => {
    const spans = row(['reads', 480], ['side', 420], ['fp', 420], ['coacc', 420]);
    const v = { scrollLeft: 0, clientWidth: 1400, scrollWidth: contentWidth(spans) };
    // Working in Footprints: the row moves just enough for Co-accessibility (its right edge at the view's).
    expect(scrollForOpened([spans[3]], spans[2], v)).toBe(spans[3].right + 8 - 1400);
    // Working in the reads, which can't stay beside it: the new panel still shows whole.
    expect(scrollForOpened([spans[3]], spans[0], v)).toBe(spans[3].right + 8 - 1400);
  });

  it('a panel opening right of the working one never pushes it off the left edge when both fit', () => {
    // Carriers, Reference, Variants; the lens opens at the end while the user works in Carriers.
    const spans = row(['carriers', 480], ['reference', 480], ['variants', 420], ['lens', 420]);
    const v = { scrollLeft: 0, clientWidth: 1400, scrollWidth: contentWidth(spans) };
    // Carriers + lens span 1828 px > 1400: they can't both show; the lens shows whole.
    expect(scrollForOpened([spans[3]], spans[0], v)).toBe(spans[3].right + 8 - 1400);
    // Working in Variants (beside the lens): both fit; Variants stays wholly in view.
    const target = scrollForOpened([spans[3]], spans[2], v)!;
    expect(spans[2].left).toBeGreaterThanOrEqual(target);
    expect(spans[3].right).toBeLessThanOrEqual(target + 1400);
  });

  // Round 3, R2c: a split is one opening. Too wide for the view: its start (first group, and its strip) at the left
  // edge; the working side panel goes past the right edge (its chip pulses: sideOf).
  it('split panels replacing the reads: the set starts at the left edge; the working panel goes right', () => {
    const spans = row(['s1', 480], ['s2', 480], ['s3', 480], ['s4', 480], ['s5', 480], ['side', 420], ['fp', 420], ['coacc', 420]);
    const v = { scrollLeft: 380, clientWidth: 1400, scrollWidth: contentWidth(spans) };
    const target = scrollForOpened(spans.slice(0, 5), spans[5], v);
    expect(target).toBe(0);
    expect(offscreenPanels(spans, { ...v, scrollLeft: 0 }).left).toEqual([]);
    expect(sideOf(spans[5], v, 0)).toBe('right');
  });

  it('no scroll when what was asked for is in view already; with no working panel, the first opened panel shows', () => {
    const spans = row(['a', 480], ['b', 420], ['c', 420]);
    const v = { scrollLeft: 0, clientWidth: 1400, scrollWidth: 1400 };
    expect(scrollForOpened([spans[2]], spans[0], v)).toBeNull();
    const wide = row(['a', 480], ['b', 480], ['c', 480], ['d', 480]);
    const w = { scrollLeft: 900, clientWidth: 1000, scrollWidth: contentWidth(wide) };
    expect(scrollForOpened(wide.slice(0, 2), null, w)).toBe(0);
  });
});

it('panelCountLabel', () => {
  expect(panelCountLabel(1)).toBe('1 panel');
  expect(panelCountLabel(3)).toBe('3 panels');
});

// Codex review: a visible panel asked for again never scrolls (the rail then closes it); a panel wider than the view
// never stalls the right cue.
describe('review fixes', () => {
  it('scrollForOpened: the asked-for panel wholly in view moves nothing, even with the working panel off-screen', () => {
    const spans = row(['a', 480], ['b', 480], ['c', 480]);
    const v = { scrollLeft: 500, clientWidth: 1000, scrollWidth: contentWidth(spans) };
    expect(scrollForOpened([spans[2]], spans[0], v)).toBeNull();
  });

  it('scrollToReveal: right clicks advance past a panel wider than the view', () => {
    const spans = row(['a', 480], ['b', 480], ['c', 480]);
    let v = { scrollLeft: 0, clientWidth: 400, scrollWidth: contentWidth(spans) };
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      const t = scrollToReveal(spans, v, 'right');
      if (t == null) break;
      expect(t).toBeGreaterThan(v.scrollLeft);
      seen.push(t);
      v = { ...v, scrollLeft: t };
    }
    expect(v.scrollLeft).toBe(v.scrollWidth - v.clientWidth);
    expect(offscreenPanels(spans, v).right).toEqual([]);
    // And back: left clicks reach the start.
    for (let i = 0; i < 8; i++) {
      const t = scrollToReveal(spans, v, 'left');
      if (t == null) break;
      expect(t).toBeLessThan(v.scrollLeft);
      v = { ...v, scrollLeft: t };
    }
    expect(v.scrollLeft).toBe(0);
    expect(seen.length).toBeGreaterThan(1);
  });
});

// Usability round 3, R2: sets of panels land as one opening.
describe('sets of panels', () => {
  // B8: a two-panel multi-SV split inserted at the row's left while it was scrolled to 440 (Carriers, Reference,
  // Variants and the lens after it). The second new panel was in view, so nothing moved: the first stayed hidden.
  it('B8: a split inserted left of the view shows both its panels', () => {
    const spans = row(['m1', 480], ['m2', 480], ['carriers', 480], ['reference', 480], ['variants', 420], ['lens', 420]);
    const v = { scrollLeft: 440, clientWidth: 1400, scrollWidth: contentWidth(spans) };
    const target = scrollForOpened(spans.slice(0, 2), spans[4], v);
    expect(target).toBe(0);
    const after = { ...v, scrollLeft: target! };
    expect(offscreenPanels(spans, after).left).toEqual([]);
    // Variants (where Split was clicked) can't stay: its chip, on the right, says where it went.
    expect(sideOf(spans[4], v, target!)).toBe('right');
  });

  it('a set that fits shows whole, with the working panel too when that also fits', () => {
    const spans = row(['reads', 900], ['a', 300], ['b', 300], ['side', 420], ['c', 300]);
    const v = { scrollLeft: 0, clientWidth: 1100, scrollWidth: contentWidth(spans) };
    // Working in "side": a + b + side fit in 1100 px.
    const target = scrollForOpened([spans[1], spans[2]], spans[3], v)!;
    for (const s of [spans[1], spans[2], spans[3]]) {
      expect(s.left).toBeGreaterThanOrEqual(target);
      expect(s.right).toBeLessThanOrEqual(target + 1100);
    }
    expect(sideOf(spans[3], v, target)).toBeNull();
  });

  it('reference copies after the split pair: the copies from the first, the lens past the right edge', () => {
    const spans = row(['carriers', 480], ['reference', 480], ['c1', 480], ['c2', 480], ['c3', 480], ['c4', 480], ['variants', 420], ['lens', 420]);
    const v = { scrollLeft: contentWidth(spans) - 1400, clientWidth: 1400, scrollWidth: contentWidth(spans) };
    const target = scrollForOpened(spans.slice(2, 6), spans[7], v)!;
    expect(target).toBe(spans[2].left - 8);
    expect(sideOf(spans[7], v, target)).toBe('right');
  });

  // Codex review: a set in view with the working panel pushed off by it, when all fit: the working panel comes back.
  it('a set in view whose insertion pushed the working panel off: both shown when they fit', () => {
    const spans = [{ id: 'a', left: 496, right: 976 }, { id: 'b', left: 984, right: 1464 }, { id: 'keep', left: 1472, right: 1892 }];
    const v = { scrollLeft: 0, clientWidth: 1600, scrollWidth: 1900 };
    const target = scrollForOpened(spans.slice(0, 2), spans[2], v)!;
    expect(target).toBe(1900 - 1600);
    expect(sideOf(spans[2], v, target)).toBeNull();
    // One panel asked for again, in view: nothing moves.
    expect(scrollForOpened([spans[1]], spans[2], v)).toBeNull();
  });

  it('a set wholly in view moves nothing; the working panel pushed off by the insertion still gets its chip', () => {
    const spans = row(['a', 300], ['b', 300], ['keep', 420], ['far', 600]);
    const v = { scrollLeft: 0, clientWidth: 700, scrollWidth: contentWidth(spans) };
    expect(scrollForOpened([spans[0], spans[1]], spans[2], v)).toBeNull();
    expect(sideOf(spans[2], v, 0)).toBe('right');
    expect(sideOf(null, v, 0)).toBeNull();
  });

  it('the lens opened at the far end: the lens shows, and Carriers\' chip is on the left', () => {
    const spans = row(['carriers', 480], ['reference', 480], ['variants', 420], ['lens', 420]);
    const v = { scrollLeft: 0, clientWidth: 1400, scrollWidth: contentWidth(spans) };
    const target = scrollForOpened([spans[3]], spans[0], v)!;
    expect(target).toBe(spans[3].right + 8 - 1400);
    expect(sideOf(spans[0], v, target)).toBe('left');
  });
});
