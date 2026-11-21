import { describe, expect, it } from 'vitest';
import { drawNucPatchLane, notchY } from './nucPatchCanvas';

function ctxSpy() {
  const rects: Array<[number, number, number, number, string]> = [];
  const ctx = { fillStyle: '', globalAlpha: 1, save() {}, restore() {},
    fillRect(x: number, y: number, w: number, h: number) { rects.push([x, y, w, h, String(this.fillStyle)]); } };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, rects };
}
const patch = (o: Partial<any>) => ({ start: 0, end: 100, kind: 'high', root: 0, openStart: false, openEnd: false, ...o }) as any;

describe('nucPatch lane notches', () => {
  it('no notch where the view cuts the patch, only at the read end', () => {
    const { ctx, rects } = ctxSpy();
    drawNucPatchLane(ctx, [patch({ start: -50, end: 80, openStart: true, openEnd: true })],
      { y: 10, bodyH: 10, linkedOffset: 0, regionWidth: 200, toX: v => v, withRegLane: true });
    const notches = rects.filter(r => r[2] === 2 && r[3] === 1);
    expect(notches).toHaveLength(1);
    expect(notches[0][0]).toBe(78);           // the right (read) end only
  });

  it('the notch stays inside the row without the regularity strip', () => {
    const { ctx, rects } = ctxSpy();
    drawNucPatchLane(ctx, [patch({ start: 10, end: 80, openStart: true })],
      { y: 10, bodyH: 10, linkedOffset: 0, regionWidth: 200, toX: v => v, withRegLane: false });
    const n = rects.find(r => r[2] === 2 && r[3] === 1)!;
    expect(n[1]).toBeGreaterThanOrEqual(10);
    expect(n[1]).toBeLessThan(20);
    expect(notchY({ y: 10, h: 3 }, 10, 3)).toBeNull();
  });
});
