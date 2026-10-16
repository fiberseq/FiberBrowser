import { describe, expect, it, afterEach } from 'vitest';
import {
  CANVAS_SCALE,
  getCanvasRenderScale,
  normalizeCanvasRenderScale,
  setCanvasRenderScale,
} from './canvasUtils';

describe('canvas render scale utilities', () => {
  afterEach(() => {
    setCanvasRenderScale(CANVAS_SCALE);
  });

  it('normalizes export render scales to a bounded finite value', () => {
    expect(normalizeCanvasRenderScale(Number.NaN)).toBe(CANVAS_SCALE);
    expect(normalizeCanvasRenderScale(0)).toBe(1);
    expect(normalizeCanvasRenderScale(3.456)).toBe(3.46);
    expect(normalizeCanvasRenderScale(99)).toBe(6);
  });

  it('tracks the active canvas source render scale for high-res export', () => {
    expect(getCanvasRenderScale()).toBe(CANVAS_SCALE);

    setCanvasRenderScale(4);
    expect(getCanvasRenderScale()).toBe(4);

    setCanvasRenderScale(CANVAS_SCALE);
    expect(getCanvasRenderScale()).toBe(CANVAS_SCALE);
  });
});
