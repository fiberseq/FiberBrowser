import { describe, expect, it } from 'vitest';
import { panelSpansIn } from './drawerTabsStore';

const rect = (left: number, width: number) => ({ left, right: left + width, width, top: 0, bottom: 10, height: 10, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;

// Codex review (second pass): at a UI size other than 100 %, DOMRects carry the CSS zoom and scrollLeft doesn't.
describe('panelSpansIn', () => {
  it('measures panels in the row\'s logical pixels at any UI size', () => {
    for (const zoom of [1, 1.25]) {
      const scroller = document.createElement('div');
      const a = document.createElement('div'); a.dataset.panelId = 'a';
      const b = document.createElement('div'); b.dataset.analysisPanelId = 'b';
      scroller.append(a, b);
      Object.defineProperty(scroller, 'offsetWidth', { value: 1000 });
      Object.defineProperty(scroller, 'scrollLeft', { value: 100 });
      scroller.getBoundingClientRect = () => rect(50 * zoom, 1000 * zoom);
      // Logical: a at 400..880 in the view (content 500..980), b at 900..1320 (content 1000..1420).
      a.getBoundingClientRect = () => rect((50 + 400) * zoom, 480 * zoom);
      b.getBoundingClientRect = () => rect((50 + 900) * zoom, 420 * zoom);
      const spans = panelSpansIn(scroller).map(s => ({ ...s, left: Math.round(s.left), right: Math.round(s.right) }));
      expect(spans).toEqual([{ id: 'a', left: 500, right: 980 }, { id: 'b', left: 1000, right: 1420 }]);
    }
  });
});
