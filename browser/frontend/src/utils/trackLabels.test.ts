import { describe, expect, it, vi } from 'vitest';
import { drawTrackLabel } from './trackLabels';

function fakeCtx() {
  return {
    font: '10px sans-serif', textAlign: 'left' as CanvasTextAlign, fillStyle: '#666', strokeStyle: '#000', lineWidth: 1,
    measureText: vi.fn(() => ({ width: 30 })),
    fillText: vi.fn(), fill: vi.fn(), stroke: vi.fn(), beginPath: vi.fn(), roundRect: vi.fn(), rect: vi.fn(),
    save: vi.fn(), restore: vi.fn(),
  };
}

describe('drawTrackLabel', () => {
  it('draws nothing in Clean view', () => {
    const ctx = fakeCtx();
    drawTrackLabel(ctx as never, 'Peaks', 4, 11, { clean: true, pill: true });
    expect(ctx.fillText).not.toHaveBeenCalled();
    expect(ctx.fill).not.toHaveBeenCalled();
  });

  it('draws the label on a translucent pill, text in its own colour', () => {
    const ctx = fakeCtx();
    drawTrackLabel(ctx as never, 'Peaks', 6, 11, { clean: false, pill: true });
    expect(ctx.roundRect).toHaveBeenCalledWith(3, 0, 36, 13, 3);
    expect(ctx.fill).toHaveBeenCalledTimes(1);
    expect(ctx.fillText).toHaveBeenCalledWith('Peaks', 6, 11);
    expect(ctx.fillStyle).toBe('#666');
  });

  it('draws plain text without a pill (exports, figure renders, hints)', () => {
    const ctx = fakeCtx();
    drawTrackLabel(ctx as never, 'No genes in region', 50, 20, { clean: false, pill: false });
    expect(ctx.fill).not.toHaveBeenCalled();
    expect(ctx.fillText).toHaveBeenCalledWith('No genes in region', 50, 20);
  });
});
