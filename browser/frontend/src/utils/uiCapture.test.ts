import { describe, expect, it } from 'vitest';
import { boxIsBlank, drawUntilComplete, probeDrawn, UI_CAPTURE_MAX_DRAWS, type ProbeMarks, type UiCaptureDeps, type UiCaptureProbe } from './uiCapture';

const WHITE = 0xffffffff;
const CHROME = 0xff444444;
const READ_GREEN = 0xff2ca033;

/**
 * A stand-in canvas holding a W x H image. The fake rasterizer paints into `pixels`;
 * drawImage (the fallback copy) fills the target box with the source's colour.
 */
interface FakeCanvas { width: number; height: number; pixels: Uint32Array; copies: number; ops: string[]; getContext: () => unknown }
function fakeCanvas(): FakeCanvas {
  const c: FakeCanvas = {
    width: 0, height: 0, pixels: new Uint32Array(0), copies: 0, ops: [],
    getContext: () => ({
      clearRect: () => { c.pixels = new Uint32Array(c.width * c.height); },
      fillRect: () => { c.pixels.fill(WHITE); },
      set fillStyle(_v: string) { /* the background */ },
      save: () => c.ops.push('save'), restore: () => c.ops.push('restore'),
      translate: (x: number) => c.ops.push(`translate ${x}`), scale: (x: number) => c.ops.push(`scale ${x}`),
      drawImage: (_src: unknown, _sx: number, _sy: number, _sw: number, _sh: number, dx: number, dy: number, dw: number, dh: number) => {
        c.copies++;
        for (let y = Math.floor(dy); y < dy + dh; y++) for (let x = Math.floor(dx); x < dx + dw; x++) c.pixels[y * c.width + x] = READ_GREEN;
      },
    }),
  };
  return c;
}

/** The window: chrome along the top, a read track (every other row a read) below. */
function paintWindow(c: FakeCanvas, withReads: boolean) {
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    c.pixels[y * c.width + x] = y < c.height / 4 ? CHROME : withReads && y % 2 === 0 ? READ_GREEN : WHITE;
  }
}

/** The read track's box (CSS px) in a 40 x 30 window. */
const READ_BOX = { x: 0, y: 10, w: 40, h: 20 };
const probes: UiCaptureProbe[] = [{ box: READ_BOX, source: {} as CanvasImageSource, sourceBox: { x: 0, y: 0, w: 40, h: 20 } }];

/** A rasterizer whose reads appear from draw `readsFrom` on (WebKit: 2; never: Infinity). */
function deps(readsFrom: number): UiCaptureDeps & { draws: () => number; canvas: () => FakeCanvas } {
  let n = 0;
  let made: FakeCanvas | null = null;
  return {
    draw: async (_url, canvas) => { n++; paintWindow(canvas as unknown as FakeCanvas, n >= readsFrom); },
    // At pixelRatio 1 the fingerprint is the canvas itself.
    fingerprint: canvas => (canvas as unknown as FakeCanvas).pixels.slice(),
    wait: async () => {},
    createCanvas: () => (made = fakeCanvas()) as unknown as HTMLCanvasElement,
    draws: () => n,
    canvas: () => made!,
  };
}

function readInk(c: FakeCanvas): number {
  let ink = 0, total = 0;
  for (let y = READ_BOX.y; y < READ_BOX.y + READ_BOX.h; y++) for (let x = 0; x < c.width; x++) { total++; if (c.pixels[y * c.width + x] === READ_GREEN) ink++; }
  return ink / total;
}

describe('full UI capture', () => {
  it('has the reads where the first WebKit draw leaves them blank', async () => {
    const d = deps(2);
    await drawUntilComplete('svg', 40, 30, { pixelRatio: 1 }, probes, d);
    expect(readInk(d.canvas())).toBeGreaterThan(0.4);
    // Blank, drawn, drawn again (stable); nothing copied in.
    expect(d.draws()).toBe(3);
    expect(d.canvas().copies).toBe(0);
  });

  it('does not stop on two blank draws in a row', async () => {
    const d = deps(4);
    await drawUntilComplete('svg', 40, 30, { pixelRatio: 1 }, probes, d);
    expect(readInk(d.canvas())).toBeGreaterThan(0.4);
    expect(d.draws()).toBe(5);
  });

  it('stops after one extra draw when the first is complete (Chromium)', async () => {
    const d = deps(1);
    await drawUntilComplete('svg', 40, 30, { pixelRatio: 1 }, probes, d);
    expect(readInk(d.canvas())).toBeGreaterThan(0.4);
    expect(d.draws()).toBe(2);
  });

  it('copies a canvas in from the page when it never draws', async () => {
    const d = deps(Infinity);
    await drawUntilComplete('svg', 40, 30, { pixelRatio: 1 }, probes, d);
    expect(d.draws()).toBe(UI_CAPTURE_MAX_DRAWS);
    expect(d.canvas().copies).toBe(1);
    expect(readInk(d.canvas())).toBe(1);
  });

  it('tells a flat box from one with marks', () => {
    const px = new Uint32Array(4 * 4).fill(WHITE);
    expect(boxIsBlank(px, 4, { x: 0, y: 0, w: 4, h: 4 })).toBe(true);
    px[5] = READ_GREEN;
    expect(boxIsBlank(px, 4, { x: 0, y: 0, w: 4, h: 4 })).toBe(false);
    expect(boxIsBlank(px, 4, { x: 2, y: 2, w: 2, h: 2 })).toBe(true);
  });

  it('flips a mirrored canvas when it copies it in', async () => {
    const d = deps(Infinity);
    await drawUntilComplete('svg', 40, 30, { pixelRatio: 1 }, [{ ...probes[0], mirror: true }], d);
    expect(d.canvas().ops).toEqual(['save', 'translate 40', 'scale -1', 'restore']);
  });
});

describe('a canvas shows in the image', () => {
  // A 40 x 20 read track at (0, 10) of a 40 x 30 window: reads on even rows, on screen.
  const W = 40, H = 30;
  const box = { x: 0, y: 10, w: 40, h: 20 };
  // The canvas's own grid (1 cell per CSS px): marks on even rows.
  const mark = new Uint8Array(40 * 20).map((_, i) => (Math.floor(i / 40) % 2 === 0 ? 1 : 0));
  const marks: ProbeMarks = { cols: 40, rows: 20, mark, contrast: 200 };
  const probe: UiCaptureProbe = { box, marks };
  const image = (row: (y: number, x: number) => number) => {
    const px = new Uint32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px[y * W + x] = y < 10 ? CHROME : row(y - 10, x);
    return px;
  };
  const reads = (y: number) => (y % 2 === 0 ? READ_GREEN : WHITE);

  it('with its reads', () => {
    expect(probeDrawn(image(reads), W, probe)).toBe(true);
  });

  it('not when blank, even with an HTML label or guide line over it', () => {
    expect(probeDrawn(image(() => WHITE), W, probe)).toBe(false);
    // A dark vertical guide line and a label across the top row.
    expect(probeDrawn(image((y, x) => (x === 20 || (y === 0 && x < 30) ? CHROME : WHITE)), W, probe)).toBe(false);
  });

  it('with a highlight wash over its reads', () => {
    // 35% yellow over the reads and the background.
    const wash = (p: number) => {
      const mix = (c: number, y: number) => Math.round(0.65 * c + 0.35 * y);
      const r = mix(p & 255, 0xfd), g = mix((p >>> 8) & 255, 0xe0), b = mix((p >>> 16) & 255, 0x47);
      return (0xff << 24 | b << 16 | g << 8 | r) >>> 0;
    };
    expect(probeDrawn(image(y => wash(reads(y))), W, probe)).toBe(true);
  });
});
