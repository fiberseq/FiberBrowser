import { describe, expect, it } from 'vitest';
import {
  MAX_VECTOR_OPS, beginVectorCapture, endVectorCapture, getCanvasRecording, isVectorUsable,
  replayRecording, wrapForVectorCapture,
} from './vectorCapture';

function fakeCtx() {
  const drawn: string[] = [];
  const ctx: Record<string, unknown> = { fillStyle: '#000' };
  for (const name of ['fillRect', 'fillText', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'drawImage', 'clip', 'measureText']) {
    ctx[name] = (...args: unknown[]) => { drawn.push(name); return name === 'measureText' ? { width: 1 } : undefined; };
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, drawn };
}

describe('vector capture', () => {
  it('draws on screen and records what it can replay', () => {
    beginVectorCapture();
    const canvas = {} as HTMLCanvasElement;
    const { ctx, drawn } = fakeCtx();
    const wrapped = wrapForVectorCapture(canvas, ctx);
    wrapped.fillStyle = '#ff0000';
    wrapped.fillRect(1, 2, 3, 4);
    wrapped.measureText('x');
    wrapped.clip();
    endVectorCapture();
    expect(drawn).toEqual(['fillRect', 'measureText', 'clip']);
    const recording = getCanvasRecording(canvas);
    expect(isVectorUsable(recording)).toBe(true);
    const replayed: unknown[] = [];
    replayRecording(recording!, { fillRect: (...a: unknown[]) => replayed.push(a), set fillStyle(v: unknown) { replayed.push(v); } });
    expect(replayed).toEqual(['#ff0000', [1, 2, 3, 4]]);
  });

  it('falls back to an image for unsupported drawing or too many shapes', () => {
    beginVectorCapture();
    const imageCanvas = {} as HTMLCanvasElement;
    const a = wrapForVectorCapture(imageCanvas, fakeCtx().ctx);
    a.drawImage({} as CanvasImageSource, 0, 0);
    const busyCanvas = {} as HTMLCanvasElement;
    const b = wrapForVectorCapture(busyCanvas, fakeCtx().ctx);
    for (let i = 0; i <= MAX_VECTOR_OPS; i++) b.fillRect(i, 0, 1, 1);
    endVectorCapture();
    expect(isVectorUsable(getCanvasRecording(imageCanvas))).toBe(false);
    expect(isVectorUsable(getCanvasRecording(busyCanvas))).toBe(false);
  });

  it('leaves contexts alone outside an export', () => {
    const { ctx } = fakeCtx();
    expect(wrapForVectorCapture({} as HTMLCanvasElement, ctx)).toBe(ctx);
  });
});

describe('replayRecording', () => {
  it("never pops the caller's state and shortens clipped labels", async () => {
    const { SvgRenderer } = await import('./vectorRenderers');
    const r = new SvgRenderer(200, 100);
    const target = r as unknown as Parameters<typeof replayRecording>[1];
    const calls: string[] = [];
    const spy = new Proxy(target, { get(t, p) {
      const v = Reflect.get(t, p);
      return typeof v === 'function' ? (...a: unknown[]) => { calls.push(String(p)); return (v as (...x: unknown[]) => unknown).apply(t, a); } : v;
    } });
    replayRecording({ unsupported: false, overflow: false, ops: [
      { kind: 'call', name: 'restore', args: [] },                         // unmatched
      { kind: 'call', name: 'save', args: [] },
      { kind: 'call', name: 'beginPath', args: [] },
      { kind: 'call', name: 'rect', args: [10, 0, 20, 10] },
      { kind: 'call', name: 'clip', args: [] },
      { kind: 'call', name: 'fillText', args: ['a very long motif name', 12, 8] },
    ] }, spy);
    expect(calls.filter(c => c === 'restore')).toEqual(['restore']);    // only the save it opened
    const svg = r.toSvg();
    expect(svg).not.toContain('a very long motif name');
  });

  it('scales text and strokes with the transform (UI zoom, PDF points)', async () => {
    const { SvgRenderer } = await import('./vectorRenderers');
    const r = new SvgRenderer(100, 100);
    r.scale(2, 2);
    r.font = '10px sans-serif';
    r.fillText('x', 1, 1);
    r.lineWidth = 1;
    r.strokeRect(0, 0, 5, 5);
    const svg = r.toSvg();
    expect(svg).toContain('font-size="20"');
    expect(svg).toContain('stroke-width="2"');
  });
  it('cuts shapes and labels at the canvas edge, like the screen does', async () => {
    const { SvgRenderer } = await import('./vectorRenderers');
    const r = new SvgRenderer(400, 100);
    r.translate(50, 0); // the track's place in the figure
    const op = (name: string, ...args: unknown[]) => ({ kind: 'call' as const, name, args });
    replayRecording({ unsupported: false, overflow: false, ops: [
      op('fillRect', 80, 10, 100, 10),           // peak running off the right edge
      op('strokeRect', -20, 30, 50, 10),         // and off the left edge
      op('fillRect', 150, 10, 10, 10),           // entirely off screen
      op('beginPath'), op('moveTo', 90, 50), op('lineTo', 300, 50), op('stroke'),
      op('fillText', 'hidden label', 250, 60),
    ] }, r as unknown as Parameters<typeof replayRecording>[1], { x: 0, y: 0, w: 100, h: 100 });
    const svg = r.toSvg();
    const xs = [...svg.matchAll(/[ML] (-?[\d.]+) /g)].map(m => Number(m[1]));
    expect(Math.max(...xs)).toBeLessThanOrEqual(150);  // right edge: 50 + 100
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(50); // left edge
    expect(svg).not.toContain('hidden label');
    // The cut side of the stroked box isn't outlined.
    expect(svg).not.toMatch(/M 50 30 L 50 40|M 50 40 L 50 30/);
  });
  it('adds a path op once after a clipped stroke', async () => {
    const { SvgRenderer } = await import('./vectorRenderers');
    const r = new SvgRenderer(100, 100);
    let curves = 0;
    const target = new Proxy(r, { get(t, p) {
      const v = Reflect.get(t, p);
      if (p === 'quadraticCurveTo') return (...a: unknown[]) => { curves += 1; return (v as (...x: unknown[]) => unknown).apply(t, a); };
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    } }) as unknown as Parameters<typeof replayRecording>[1];
    const op = (name: string, ...args: unknown[]) => ({ kind: 'call' as const, name, args });
    replayRecording({ unsupported: false, overflow: false, ops: [
      op('beginPath'), op('moveTo', -10, 5), op('lineTo', 50, 5), op('stroke'),
      op('quadraticCurveTo', 60, 20, 70, 5), op('stroke'),
      op('setTransform'), op('fillRect', 0, 0, 1, 1),
    ] }, target, { x: 0, y: 0, w: 100, h: 100 });
    expect(curves).toBe(1);
    expect(r.toSvg()).not.toContain('NaN');
  });
});
