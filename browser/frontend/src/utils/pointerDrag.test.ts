import { afterEach, describe, expect, it } from 'vitest';
import {
  beginPointerDrag, clearDocumentSelection, endPointerDrag, installTrackSelectionGuard,
  refusesSelectionStart, resetPointerDragForTests,
} from './pointerDrag';

afterEach(() => {
  resetPointerDragForTests();
  document.body.innerHTML = '';
});

function trackArea() {
  document.body.innerHTML = `
    <div data-testid="tracks-region">
      <div class="panel"><span class="label">chr2L:6,356,400</span><canvas></canvas><input value="x"></div>
    </div>
    <p class="outside">outside</p>`;
  return {
    panel: document.querySelector('.panel')!,
    canvas: document.querySelector('canvas')!,
    labelText: document.querySelector('.label')!.firstChild!,
    input: document.querySelector('input')!,
    outside: document.querySelector('.outside')!,
  };
}

describe('refusesSelectionStart', () => {
  const area = '[data-testid="tracks-region"]';
  it('refuses a selection that starts on a canvas or blank panel space', () => {
    const { canvas, panel } = trackArea();
    expect(refusesSelectionStart(canvas, area)).toBe(true);
    expect(refusesSelectionStart(panel, area)).toBe(true);
  });
  it('keeps text, text entry and everything outside the tracks selectable', () => {
    const { labelText, input, outside } = trackArea();
    expect(refusesSelectionStart(labelText, area)).toBe(false);
    expect(refusesSelectionStart(input, area)).toBe(false);
    expect(refusesSelectionStart(outside, area)).toBe(false);
    expect(refusesSelectionStart(null, area)).toBe(false);
  });
  it('the installed guard cancels selectstart on the canvas only', () => {
    const { canvas, labelText } = trackArea();
    installTrackSelectionGuard();
    const onCanvas = new Event('selectstart', { bubbles: true, cancelable: true });
    canvas.dispatchEvent(onCanvas);
    expect(onCanvas.defaultPrevented).toBe(true);
    const onText = new Event('selectstart', { bubbles: true, cancelable: true });
    labelText.dispatchEvent(onText);
    expect(onText.defaultPrevented).toBe(false);
  });
});

describe('pointer drag', () => {
  it('marks the page unselectable while any drag runs', () => {
    beginPointerDrag();
    beginPointerDrag();
    endPointerDrag();
    expect(document.documentElement.classList.contains('fb-pointer-drag')).toBe(true);
    endPointerDrag();
    expect(document.documentElement.classList.contains('fb-pointer-drag')).toBe(false);
  });
  it('clears an existing selection', () => {
    const { panel } = trackArea();
    const range = document.createRange();
    range.selectNodeContents(panel);
    window.getSelection()!.addRange(range);
    expect(window.getSelection()!.isCollapsed).toBe(false);
    clearDocumentSelection();
    expect(window.getSelection()!.rangeCount).toBe(0);
  });
});
