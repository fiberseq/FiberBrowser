import { describe, expect, it } from 'vitest';
import { coaccMatrixSize } from '../CoAccessibilityPanel';

describe('co-accessibility matrix size (L14)', () => {
  it('takes the panel width instead of a 400 px cap', () => {
    // An 830 px panel at 1728 px: the matrix fills it (it was 400 px).
    expect(coaccMatrixSize(830)).toBe(760);
    expect(coaccMatrixSize(600)).toBe(592);
    expect(coaccMatrixSize(480)).toBe(472);
  });
  it('never shrinks below a readable size, and per-dataset matrices are smaller', () => {
    expect(coaccMatrixSize(100)).toBe(160);
    expect(coaccMatrixSize(830, { perDataset: true })).toBe(480);
    expect(coaccMatrixSize(1400, { fullView: true })).toBe(1000);
  });
  it('a single matrix also fits the window height (seen whole without scrolling)', () => {
    expect(coaccMatrixSize(830, { viewportHeight: 1080 })).toBe(740);
    expect(coaccMatrixSize(600, { viewportHeight: 800 })).toBe(460);
    expect(coaccMatrixSize(600, { viewportHeight: 500 })).toBe(320);
  });
});
