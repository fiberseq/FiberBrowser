/** A PNG export with more than the screen (a relative x-axis strip under a cluster profile) is drawn through drawFn
 *  at the export size, not copied from the canvas on screen (release audit 3.1.1). */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChartSaveButton } from './ChartSaveButton';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => { vi.restoreAllMocks(); });

function renderAndSavePng(props: Partial<Parameters<typeof ChartSaveButton>[0]>) {
  const screen = document.createElement('canvas');
  screen.width = 300; screen.height = 120;
  const drawn: HTMLCanvasElement[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) { drawn.push(this); return { setTransform() {} } as never; });
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement) { drawn.push(this); });
  const box = document.createElement('div');
  document.body.appendChild(box);
  const root = createRoot(box);
  act(() => root.render(<ChartSaveButton canvasRef={{ current: screen }} filename="p" {...props} />));
  act(() => { (box.querySelector('[data-testid="chart-save"]') as HTMLButtonElement).click(); });
  act(() => { (box.querySelector('[data-testid="chart-save-png"]') as HTMLButtonElement).click(); });
  act(() => root.unmount());
  box.remove();
  return { screen, drawn };
}

describe('ChartSaveButton PNG', () => {
  it('pngFromDrawFn: drawn at the export size (2x), with the footer height', () => {
    const drawFn = vi.fn();
    const { screen, drawn } = renderAndSavePng({ drawFn, width: 300, height: 144, pngFromDrawFn: true });
    expect(drawFn).toHaveBeenCalledTimes(1);
    expect(drawFn.mock.calls[0].slice(1)).toEqual([300, 144]);
    const out = drawn[drawn.length - 1];
    expect(out).not.toBe(screen);
    expect([out.width, out.height]).toEqual([600, 288]);
  });
  it('otherwise the canvas on screen is copied, as before', () => {
    const drawFn = vi.fn();
    const { screen, drawn } = renderAndSavePng({ drawFn, width: 300, height: 120 });
    expect(drawFn).not.toHaveBeenCalled();
    expect(drawn[drawn.length - 1]).toBe(screen);
  });
});
