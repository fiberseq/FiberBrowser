import {describe,it,expect} from 'vitest';
import {crosshairBottomAt,logicalOffset} from './scaledCoordinates';

describe('scaled track coordinates',()=>{
  it.each([.5,1,1.5,2,3,4])('normalizes hits and drag distances at %sx',scale=>{
    expect(logicalOffset(125*scale,800,800*scale)).toBe(125);
    expect(logicalOffset(-40*scale,300,300*scale)).toBe(-40);
  });
  it('handles unmeasured elements',()=>{
    expect(logicalOffset(25,0,0)).toBe(25);
  });
});

describe('crosshairBottomAt (audit L8: the ruler crosshair ran past the panels to the window bottom)', () => {
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  function container() {
    const box = document.createElement('div');
    box.getBoundingClientRect = () => rect(0, 100, 1700, 980);  // to the window's bottom (1080)
    Object.defineProperty(box, 'clientHeight', { value: 980 });
    const panel = (id: string, r: DOMRect) => {
      const el = document.createElement('div');
      el.setAttribute('data-panel-id', id);
      el.getBoundingClientRect = () => r;
      box.appendChild(el);
    };
    panel('a', rect(0, 150, 420, 900));      // ends at 1050
    panel('b', rect(430, 150, 420, 400));    // a row of two: b over c
    panel('c', rect(430, 560, 420, 300));    // ends at 860
    return box;
  }
  it('ends at the bottom of the lowest panel under the pointer, in container pixels', () => {
    expect(crosshairBottomAt(container(), 346)).toBe(950);
    expect(crosshairBottomAt(container(), 500)).toBe(760);
    expect(crosshairBottomAt(container(), 1600)).toBeNull();
  });
});
