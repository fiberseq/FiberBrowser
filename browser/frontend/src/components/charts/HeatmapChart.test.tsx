import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeatmapChart } from './HeatmapChart';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('HeatmapChart labels (L25)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fonts: string[] = [];
  const rotate = vi.fn();
  beforeEach(() => {
    fonts.length = 0; rotate.mockReset();
    const ctx = new Proxy({ measureText: (t: string) => ({ width: t.length * 6 }), rotate } as Record<string, unknown>, {
      get: (target, key) => (key in target ? target[key as string] : vi.fn()),
      set: (target, key, value) => { if (key === 'font') fonts.push(String(value)); target[key as string] = value; return true; },
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx as never);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

  const m = [[1, 0.5, 0.2], [0.5, 1, 0.3], [0.2, 0.3, 1]];
  const labels = ['Pause', 'PIC', 'Elong.'];

  it('writes short column labels level, at 11 px, when they fit over their columns', async () => {
    await act(async () => root.render(<HeatmapChart matrix={m} colormap="red-blue" rowLabels={labels} colLabels={labels} showValues width={340} height={280} />));
    expect(rotate).not.toHaveBeenCalled();
    expect(fonts).toContain('11px sans-serif');
    expect(fonts).not.toContain('9px sans-serif');
  });

  it('slants them only when they do not fit', async () => {
    const long = ['A long state name', 'Another long one', 'Third long name'];
    await act(async () => root.render(<HeatmapChart matrix={m} colormap="red-blue" rowLabels={labels} colLabels={long} width={200} height={200} />));
    expect(rotate).toHaveBeenCalled();
  });
});
