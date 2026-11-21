/** The maximized projection keeps the molecule colours (Colour by: regularity, geometry, m6A). */
import { act, isValidElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ render: null as null | ((w: number, h: number) => unknown) }));
vi.mock('./ChartMaximizeButton', () => ({
  ChartMaximizeButton: ({ renderChart }: { renderChart: (w: number, h: number) => unknown }) => { captured.render = renderChart; return null; },
}));

import { ScatterChart } from './ScatterChart';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('ScatterChart maximize', () => {
  it('forwards pointColors to the enlarged chart', () => {
    const box = document.createElement('div');
    const root = createRoot(box);
    const pointColors = ['#ff0000', null];
    act(() => root.render(<ScatterChart coordsX={[0, 1]} coordsY={[0, 1]} labels={[0, 1]} clusterColors={{ 0: '#000', 1: '#111' } as never}
      pointColors={pointColors} />));
    expect(captured.render).toBeTruthy();
    const el = captured.render!(800, 600) as ReactElement<{ pointColors?: unknown }>;
    expect(isValidElement(el)).toBe(true);
    expect(el.props.pointColors).toBe(pointColors);
    act(() => root.unmount());
  });
});
