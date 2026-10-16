/**
 * Keeping drags on the track area from turning into text selections.
 *
 * Reads and the other tracks are drag surfaces (pan, region select). A press
 * that the browser treats as the start of a text selection sweeps across the
 * whole panel instead (every canvas in the range is painted selected), which
 * looks like the read panel itself got "selected". WebKit (the desktop app's
 * web view) starts such a selection even from elements styled
 * ``user-select: none``.
 */

const DRAG_CLASS = 'fb-pointer-drag';
let activeDrags = 0;

/** While a pointer drag runs, nothing on the page can be selected (index.css). */
export function beginPointerDrag(): void {
  activeDrags += 1;
  if (typeof document !== 'undefined') document.documentElement.classList.add(DRAG_CLASS);
}

export function endPointerDrag(): void {
  activeDrags = Math.max(0, activeDrags - 1);
  if (activeDrags === 0 && typeof document !== 'undefined') {
    document.documentElement.classList.remove(DRAG_CLASS);
  }
}

/** Drop the page's text selection (a press on a drag surface replaces it). */
export function clearDocumentSelection(): void {
  if (typeof window === 'undefined') return;
  const selection = window.getSelection?.();
  if (selection && !selection.isCollapsed) selection.removeAllRanges();
}

const TEXT_ENTRY = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

/**
 * Whether a selection starting at ``target`` should be refused: it starts
 * inside the track area (``areaSelector``) on an element rather than on text,
 * i.e. on a canvas, a gutter or the blank space between tracks. A press on
 * actual text (a label, a notice, coordinates) still selects it.
 */
export function refusesSelectionStart(target: EventTarget | null, areaSelector: string): boolean {
  if (!target || typeof (target as Node).nodeType !== 'number') return false;
  const node = target as Node;
  if (node.nodeType === 3 /* TEXT_NODE */) return false;
  if (node.nodeType !== 1 /* ELEMENT_NODE */) return false;
  const element = node as Element;
  if (!element.closest(areaSelector)) return false;
  return !element.closest(TEXT_ENTRY);
}

let guardInstalled = false;

/** Install (once) the document-level guard for ``refusesSelectionStart``. */
export function installTrackSelectionGuard(areaSelector = '[data-testid="tracks-region"]'): void {
  if (guardInstalled || typeof document === 'undefined') return;
  guardInstalled = true;
  document.addEventListener('selectstart', event => {
    if (refusesSelectionStart(event.target, areaSelector)) event.preventDefault();
  }, true);
}

/** Tests only. */
export function resetPointerDragForTests(): void {
  activeDrags = 0;
  guardInstalled = false;
  if (typeof document !== 'undefined') document.documentElement.classList.remove(DRAG_CLASS);
}
