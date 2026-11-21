/** ClassLanes: exports are not black (fills survive without the page's stylesheet) and open-end chevrons and labels
 * stay inside the drawing. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClassLanes, CLASS_LANES_INSET, labelWidth, type ClassLane } from './ClassLanes';
import { standaloneSvg } from '../../utils/svgChartExport';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('ClassLanes', () => {
  let box: HTMLDivElement; let root: Root;
  beforeEach(() => { box = document.createElement('div'); document.body.appendChild(box); root = createRoot(box); });
  afterEach(() => { act(() => root.unmount()); box.remove(); document.head.querySelectorAll('style[data-t]').forEach(s => s.remove()); });

  const lanes: ClassLane[] = [
    { id: 'G1', name: 'G1', L: 1000, R: 9000, color: '#e11d48', openLeft: true, openRight: true },
    { id: 'G2', name: 'G2 ⊂ G1', L: 5000, R: 9000, color: '#2563eb', nested: true },
  ];
  const render = (width = 300) => act(() => root.render(
    <ClassLanes lanes={lanes} width={width} region={{ start: 1000, end: 9000 }} ariaLabel="map" format={String}
      tintClassName="fill-emerald-50" />));

  it('every shape keeps a non-black fill in a standalone export', () => {
    render();
    const svg = box.querySelector('svg')!;
    const { text } = standaloneSvg(svg);
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const shapes = Array.from(doc.querySelectorAll('rect, text')).slice(1);   // the first rect: the white background
    for (const el of shapes) {
      const fill = (el as SVGElement).style.getPropertyValue('fill') || el.getAttribute('fill');
      expect(fill, el.outerHTML).toBeTruthy();
    }
    expect(doc.querySelector('[class]')).toBeNull();
  });

  it('a stylesheet class paint is inlined on the export', () => {
    const style = document.createElement('style');
    style.setAttribute('data-t', '');
    style.textContent = '.fill-emerald-50 { fill: rgb(236, 253, 245); }';
    document.head.appendChild(style);
    render();
    const { text } = standaloneSvg(box.querySelector('svg')!);
    expect(text).toMatch(/fill:\s*rgb\(236, 253, 245\)/);
  });

  it('chevrons of a window-spanning class are inside the drawing, the long label fits', () => {
    const width = 300;
    render(width);
    const l = box.querySelector('[data-testid="class-lanes-open-left"]')!;
    const r = box.querySelector('[data-testid="class-lanes-open-right"]')!;
    // "‹" is anchored at its end: it occupies [x - ~5, x]; "›" starts at x.
    expect(Number(l.getAttribute('x')) - 5).toBeGreaterThanOrEqual(0);
    expect(Number(r.getAttribute('x')) + 5).toBeLessThanOrEqual(width);
    expect(CLASS_LANES_INSET).toBeGreaterThanOrEqual(6);
    const labels = Array.from(box.querySelectorAll('text')).filter(t => t.textContent === 'G2 ⊂ G1');
    const t = labels[0];
    const x = Number(t.getAttribute('x'));
    const w = labelWidth('G2 ⊂ G1');
    if (t.getAttribute('text-anchor') === 'end') expect(x - w).toBeGreaterThanOrEqual(0);
    else expect(x + w).toBeLessThanOrEqual(width);
  });
});
