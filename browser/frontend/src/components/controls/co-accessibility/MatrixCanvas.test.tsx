import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCoaccMetadata, getCoaccMatrixImageUrl } from '../../../api/coaccessibility';
import { MatrixCanvas } from './MatrixCanvas';

vi.mock('../../../api/coaccessibility', () => ({
  getCoaccMatrixImageUrl: vi.fn(() => '/api/coacc/matrix.png'),
  getCoaccMetadata: vi.fn(),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const baseProps = {
  chrom: 'chr2R',
  start: 100,
  end: 200,
  datasetIds: ['ds1'],
  normalization: 'correlation',
  scaling: 'linear',
  colormap: 'fall',
  minCoverage: 20,
  binSize: 10,
  signalType: 'accessibility',
  layer: null,
  maxSize: 200,
  genes: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createCanvasContextMock(): CanvasRenderingContext2D {
  return {
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    restore: vi.fn(),
    rotate: vi.fn(),
    save: vi.fn(),
    scale: vi.fn(),
    translate: vi.fn(),
    set fillStyle(_value: string | CanvasGradient | CanvasPattern) {},
    set font(_value: string) {},
    set globalAlpha(_value: number) {},
    set imageSmoothingEnabled(_value: boolean) {},
    set textAlign(_value: CanvasTextAlign) {},
    set textBaseline(_value: CanvasTextBaseline) {},
  } as unknown as CanvasRenderingContext2D;
}

describe('MatrixCanvas request lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;
  let getContextSpy: { mockRestore: () => void };

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(createCanvasContextMock());
    vi.mocked(getCoaccMetadata).mockReset();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    getContextSpy.mockRestore();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('invalidates cached requests when only the panel reference changes', async () => {
    vi.mocked(getCoaccMetadata).mockResolvedValue({ n_bins: 0 } as never);
    await act(async () => { root.render(<MatrixCanvas {...baseProps} genome="first" reversed />); });
    await act(async () => { vi.advanceTimersByTime(451); });
    expect(getCoaccMetadata).toHaveBeenLastCalledWith('chr2R', 100, 200, expect.objectContaining({ panelGenome: 'first' }));
    await act(async () => { root.render(<MatrixCanvas {...baseProps} genome="second" reversed />); });
    await act(async () => { vi.advanceTimersByTime(451); });
    expect(getCoaccMetadata).toHaveBeenLastCalledWith('chr2R', 100, 200, expect.objectContaining({ panelGenome: 'second' }));
    expect(getCoaccMatrixImageUrl).toHaveBeenLastCalledWith('chr2R', 100, 200, expect.objectContaining({ panelGenome: 'second' }));
  });

  it('clears the loading indicator after an empty matrix response', async () => {
    const metadata = deferred<any>();
    vi.mocked(getCoaccMetadata).mockReturnValueOnce(metadata.promise);

    await act(async () => {
      root.render(<MatrixCanvas {...baseProps} />);
    });
    await act(async () => {
      vi.advanceTimersByTime(451);
    });

    expect(container.textContent).toContain('Computing matrix');

    await act(async () => {
      metadata.resolve({ n_reads: 0, n_bins: 0, bin_size: 10 });
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain('Computing matrix');
    expect(container.textContent).toContain('No reads');
    // No empty matrix-sized box under the message (L25/L14: datasets without reads).
    expect((container.querySelector('canvas') as HTMLCanvasElement).style.display).toBe('none');
  });

  it('does not let stale metadata responses update request state', async () => {
    const firstMetadata = deferred<any>();
    const secondMetadata = deferred<any>();
    const onRequestState = vi.fn();
    vi.mocked(getCoaccMetadata)
      .mockReturnValueOnce(firstMetadata.promise)
      .mockReturnValueOnce(secondMetadata.promise);

    await act(async () => {
      root.render(<MatrixCanvas {...baseProps} onRequestState={onRequestState} />);
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {
      root.render(<MatrixCanvas {...baseProps} start={150} end={250} onRequestState={onRequestState} />);
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    await act(async () => {
      firstMetadata.resolve({ n_reads: 0, n_bins: 0, bin_size: 10 });
      await Promise.resolve();
    });
    expect(onRequestState).not.toHaveBeenCalled();

    await act(async () => {
      secondMetadata.resolve({ n_reads: 0, n_bins: 0, bin_size: 10 });
      await Promise.resolve();
    });

    expect(onRequestState).toHaveBeenCalledTimes(1);
    expect(onRequestState).toHaveBeenCalledWith({ phase: 'empty', message: 'No reads' });
  });
  it('draws a large matrix at the screen pixel density, labels inside the canvas (L14)', async () => {
    const ctx = createCanvasContextMock();
    (ctx as any).setTransform = vi.fn();
    getContextSpy.mockRestore();
    getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
    const dpr = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      crossOrigin = '';
      set src(_v: string) { setTimeout(() => this.onload?.(), 0); }
    }
    vi.stubGlobal('Image', FakeImage);
    vi.mocked(getCoaccMetadata).mockResolvedValueOnce({ n_reads: 10, n_bins: 200, bin_size: 50 } as any);
    try {
      await act(async () => {
        root.render(<MatrixCanvas {...baseProps} start={47513807} end={47523807} maxSize={720}
          genes={[{ id: 'g', name: 'NAPA', start: 47514000, end: 47520000, strand: '-' } as any]} />);
      });
      await act(async () => { vi.advanceTimersByTime(300); await Promise.resolve(); await Promise.resolve(); });
      await act(async () => { vi.advanceTimersByTime(10); await Promise.resolve(); });
      const canvas = container.querySelector('canvas') as HTMLCanvasElement;
      expect(canvas.style.width).toBe('720px');
      expect(canvas.width).toBe(1440);
      expect(canvas.height).toBe(1440);
      expect((ctx as any).setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
      // No coordinate label is drawn at the corner (where top and left labels collide).
      const calls = vi.mocked(ctx.fillText).mock.calls;
      const top = calls.filter(([, , y]) => y === 1);
      expect(top.length).toBe(3);
      expect(Math.min(...top.map(([, x]) => x))).toBeGreaterThan(150);
      // The gene name along the bottom sits inside the canvas, above its line.
      const gene = calls.find(([text]) => String(text).includes('NAPA'))!;
      expect(gene[2]).toBe(720 - 3 - 2);
    } finally {
      vi.unstubAllGlobals();
      Object.defineProperty(window, 'devicePixelRatio', { value: dpr, configurable: true });
    }
  });
});
