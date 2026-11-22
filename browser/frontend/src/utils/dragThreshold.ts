/**
 * Start a drag only once the pointer has really moved: a press that moves less than `thresholdPx` (a click, a hand's
 * tremor) never starts a drag-to-zoom or a pan, so it never reloads the view. Returns a function that cancels.
 */
export const DRAG_THRESHOLD_PX = 4;

export function armAfterMovement(startClientX: number, startClientY: number, onArm: () => void, thresholdPx = DRAG_THRESHOLD_PX,
  target: Pick<Document, 'addEventListener' | 'removeEventListener'> = document): () => void {
  const move = (ev: MouseEvent) => {
    if (Math.hypot(ev.clientX - startClientX, ev.clientY - startClientY) < thresholdPx) return;
    cancel();
    onArm();
  };
  const cancel = () => {
    target.removeEventListener('mousemove', move as EventListener);
    target.removeEventListener('mouseup', cancel);
  };
  target.addEventListener('mousemove', move as EventListener);
  target.addEventListener('mouseup', cancel);
  return cancel;
}
