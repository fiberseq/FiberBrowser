import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CooccurrenceTab, cooccurrenceMatrixSize } from './CooccurrenceTab';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function ctxMock() {
  return new Proxy({ measureText: (t: string) => ({ width: t.length * 6 }) } as Record<string, unknown>, {
    get: (target, key) => (key in target ? target[key as string] : vi.fn()),
    set: (target, key, value) => { target[key as string] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
}

describe('Transcription co-occurrence (L25)', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctxMock());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

  const data = {
    ds1: { matrix: [[1, 0.5, 0.5], [0.5, 1, 0.5], [0.5, 0.5, 1]], rawMatrix: [[42, 28, 39], [28, 294, 100], [39, 100, 214]], totalReads: 361 },
    ds2: { matrix: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], rawMatrix: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], totalReads: 0 },
  };
  const targets = [
    { id: 'ds2', label: 'flyamp_DddB.called', color: '#ef4444' },
    { id: 'ds1', label: 'stage_d_recalled', color: '#22c55e' },
  ];

  it('draws no matrix for a dataset with no reads, says so once, and leaves it out of the tests', async () => {
    await act(async () => root.render(<CooccurrenceTab cooccurrenceByDataset={data} targetDatasets={targets} chartWidth={456} />));
    expect(container.querySelectorAll('canvas').length).toBe(1);
    expect(container.querySelector('[data-testid="tx-cooccur-empty"]')!.textContent).toContain('flyamp_DddB.called');
    expect(container.querySelectorAll('details').length).toBe(1);
    // The one matrix takes the panel width (it was 260 px or less).
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    expect(parseInt(canvas.style.width, 10)).toBe(340);
  });

  it('sizes matrices to the panel: side by side while each is 200 px or more', () => {
    expect(cooccurrenceMatrixSize(456, 1, false)).toEqual({ width: 340, height: 280 });
    expect(cooccurrenceMatrixSize(456, 2, false).width).toBe(222);
    expect(cooccurrenceMatrixSize(300, 2, false).width).toBe(300);
  });
});
