import { describe, expect, it, vi } from 'vitest';
import { captureUiCanvas, drawUntilStable, UI_CAPTURE_MAX_DRAWS, type UiCaptureDraw } from './uiCapture';

vi.mock('html-to-image', () => ({
  toSvg: vi.fn(async () => 'data:image/svg+xml;charset=utf-8,<svg/>'),
}));

const WHITE = 0xffffffff;
const READ_GREEN = 0xff33a02c;

/** A stand-in canvas: a width x height RGBA image whose pixels getImageData returns. */
function fakeCanvas(width: number, height: number, fill: (x: number, y: number) => number): HTMLCanvasElement {
  const data = new Uint32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = fill(x, y);
  return {
    width, height,
    getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(data.buffer.slice(0)) }) }),
  } as unknown as HTMLCanvasElement;
}

/** The fraction of pixels that are read colour in the read track's box (the lower half). */
function readInk(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext('2d')!;
  const px = new Uint32Array(ctx.getImageData(0, 0, canvas.width, canvas.height).data.buffer);
  let ink = 0, total = 0;
  for (let y = Math.floor(canvas.height / 2); y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) { total++; if (px[y * canvas.width + x] === READ_GREEN) ink++; }
  }
  return ink / total;
}

/** The window: chrome on top, a read track (every other row a read) below. */
const windowPixels = (withReads: boolean) => (_x: number, y: number) => (y < 10 ? 0xff444444 : withReads && y % 2 === 0 ? READ_GREEN : WHITE);

/** WebKit: the SVG's nested canvas images are not decoded on the first draw, so the read track is blank. */
function webkitRasterizer(): { draw: UiCaptureDraw; calls: () => number } {
  let n = 0;
  const draw: UiCaptureDraw = async (_url, width, height, options) => {
    n++;
    return fakeCanvas(width * options.pixelRatio, height * options.pixelRatio, windowPixels(n > 1));
  };
  return { draw, calls: () => n };
}

describe('full UI capture', () => {
  it('draws the reads where the first WebKit draw leaves them blank', async () => {
    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { value: 40 });
    Object.defineProperty(root, 'clientHeight', { value: 30 });
    const { draw, calls } = webkitRasterizer();
    const canvas = await captureUiCanvas(root, { pixelRatio: 2, backgroundColor: '#ffffff' }, draw);
    expect(canvas.width).toBe(80);
    expect(canvas.height).toBe(60);
    expect(readInk(canvas)).toBeGreaterThan(0.4);
    // Blank, drawn, drawn again (stable).
    expect(calls()).toBe(3);
  });

  it('stops after one extra draw when the first is complete (Chromium)', async () => {
    let n = 0;
    const draw: UiCaptureDraw = async (_url, w, h) => { n++; return fakeCanvas(w, h, windowPixels(true)); };
    const canvas = await drawUntilStable('svg', 20, 20, { pixelRatio: 1 }, draw);
    expect(readInk(canvas)).toBeGreaterThan(0.4);
    expect(n).toBe(2);
  });

  it('gives up after the draw limit and returns the last draw', async () => {
    let n = 0;
    const draw: UiCaptureDraw = async (_url, w, h) => { n++; return fakeCanvas(w, h, () => 0xff000000 + n); };
    await drawUntilStable('svg', 4, 4, { pixelRatio: 1 }, draw);
    expect(n).toBe(UI_CAPTURE_MAX_DRAWS);
  });
});
