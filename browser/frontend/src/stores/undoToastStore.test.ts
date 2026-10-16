import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNDO_TOAST_MIN_AFTER_PAUSE_MS, UNDO_TOAST_MS, useUndoToastStore } from './undoToastStore';

// Usability round 2, N24: the undo message waits while the pointer is on it or focus is in it.
describe('undo toast timer', () => {
  beforeEach(() => { vi.useFakeTimers(); useUndoToastStore.getState().dismiss(); });
  afterEach(() => { useUndoToastStore.getState().dismiss(); vi.useRealTimers(); });
  const s = () => useUndoToastStore.getState();

  it('hides after 8 s untouched', () => {
    s().show('footprints', 'Removed S1', () => {});
    vi.advanceTimersByTime(UNDO_TOAST_MS - 1);
    expect(s().toast).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(s().toast).toBeNull();
  });

  it('pause holds it however long; resume runs the rest (at least 2 s)', () => {
    s().show('footprints', 'Removed S1', () => {});
    const id = s().toast!.id;
    vi.advanceTimersByTime(3000);
    s().pause(id);
    vi.advanceTimersByTime(60_000);
    expect(s().toast?.id).toBe(id);
    s().resume(id);
    vi.advanceTimersByTime(UNDO_TOAST_MS - 3000 - 1);
    expect(s().toast?.id).toBe(id);
    vi.advanceTimersByTime(1);
    expect(s().toast).toBeNull();
    // Paused with almost nothing left: the pointer leaving still leaves time to reach Undo.
    s().show('footprints', 'Removed S2', () => {});
    const id2 = s().toast!.id;
    vi.advanceTimersByTime(UNDO_TOAST_MS - 100);
    s().pause(id2);
    s().resume(id2);
    vi.advanceTimersByTime(UNDO_TOAST_MIN_AFTER_PAUSE_MS - 1);
    expect(s().toast?.id).toBe(id2);
    vi.advanceTimersByTime(1);
    expect(s().toast).toBeNull();
  });

  it("a stale message's pause or resume does nothing to the current one", () => {
    s().show('footprints', 'Removed S1', () => {});
    const old = s().toast!.id;
    s().show('footprints', 'Removed S2', () => {});
    s().pause(old);
    vi.advanceTimersByTime(UNDO_TOAST_MS);
    expect(s().toast).toBeNull();
  });
});
