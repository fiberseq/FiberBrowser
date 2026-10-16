import { afterEach, describe, expect, it, vi } from 'vitest';
import { scrollIntoViewWithin } from './scrollWithin';

afterEach(() => { document.body.innerHTML = ''; });

describe('scrollIntoViewWithin', () => {
  function setup(overflowY = 'auto') {
    const hidden = document.createElement('div');
    hidden.style.overflowY = 'hidden';
    hidden.scrollTop = 36;
    const scroller = document.createElement('div');
    scroller.style.overflowY = overflowY;
    scroller.scrollTop = 20;
    Object.defineProperties(scroller, { clientHeight: { value: 200 }, scrollHeight: { value: 1000 }, clientTop: { value: 2 } });
    scroller.getBoundingClientRect = () => ({ top: 100 } as DOMRect);
    const el = document.createElement('div');
    el.getBoundingClientRect = () => ({ top: 402, height: 40 } as DOMRect);
    hidden.append(scroller); scroller.append(el); document.body.append(hidden);
    return { hidden, scroller, el };
  }

  it.each(['auto', 'scroll'])('moves only the nearest %s scroller, leaving hidden ancestors untouched', overflow => {
    const { hidden, scroller, el } = setup(overflow);
    scrollIntoViewWithin(el, { block: 'center' });
    expect(scroller.scrollTop).toBe(240);
    expect(hidden.scrollTop).toBe(36);
    expect(document.documentElement.scrollTop).toBe(0);
  });

  it('uses smooth scrolling on only the scroller and keeps its horizontal position', () => {
    const { hidden, scroller, el } = setup();
    scroller.scrollTo = vi.fn();
    scrollIntoViewWithin(el, { block: 'start', behavior: 'smooth' });
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 320, behavior: 'smooth' });
    expect(hidden.scrollTop).toBe(36);
  });

  it('leaves a visible element alone with nearest alignment', () => {
    const { scroller, el } = setup();
    el.getBoundingClientRect = () => ({ top: 122, height: 40 } as DOMRect);
    scrollIntoViewWithin(el, { block: 'nearest' });
    expect(scroller.scrollTop).toBe(20);
  });

  it('does not scroll hidden ancestors when there is no scroller', () => {
    const { hidden, scroller, el } = setup('hidden');
    scrollIntoViewWithin(el);
    expect(scroller.scrollTop).toBe(20);
    expect(hidden.scrollTop).toBe(36);
  });
});
