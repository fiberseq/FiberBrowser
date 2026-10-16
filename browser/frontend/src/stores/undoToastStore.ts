/**
 * One short-lived "Undo" message for an action that removed something (a saved class, Clear all): the action does
 * its work at once and leaves an undo here for a few seconds. A new message replaces the old one (its undo is gone).
 * The time waits while the pointer is on the message or focus is in it (usability round 2, N24): `pause` / `resume`.
 */
import { create } from 'zustand';

export interface UndoToast { id: number; text: string; undo: () => void; scope: string }

interface UndoToastStore {
  toast: UndoToast | null;
  /** Show "text · Undo" in the panels of this scope ('footprints', ...) for `ms` milliseconds. */
  show: (scope: string, text: string, undo: () => void, ms?: number) => void;
  dismiss: (id?: number) => void;
  /** Hold the message's time (hover or focus on it); `resume` lets the rest of it run. */
  pause: (id: number) => void;
  resume: (id: number) => void;
}

export const UNDO_TOAST_MS = 8000;
/** At least this long is left after a pause, so the pointer leaving never hides it at once. */
export const UNDO_TOAST_MIN_AFTER_PAUSE_MS = 2000;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
/** The running message's deadline (epoch ms), or, while paused, the time it had left. */
let deadline = 0;
let remaining: number | null = null;

export const useUndoToastStore = create<UndoToastStore>((set, get) => {
  const arm = (id: number, ms: number) => {
    if (timer) clearTimeout(timer);
    deadline = Date.now() + ms;
    remaining = null;
    timer = setTimeout(() => { timer = null; if (get().toast?.id === id) set({ toast: null }); }, ms);
  };
  return {
    toast: null,
    show: (scope, text, undo, ms = UNDO_TOAST_MS) => {
      const id = ++seq;
      set({ toast: { id, text, undo, scope } });
      // A message that replaces one held under the pointer stays held (the pointer is still on it).
      if (remaining != null) {
        if (timer) clearTimeout(timer);
        timer = null;
        remaining = ms;
      } else arm(id, ms);
    },
    dismiss: id => {
      if (id != null && get().toast?.id !== id) return;
      if (timer) clearTimeout(timer);
      timer = null;
      remaining = null;
      set({ toast: null });
    },
    pause: id => {
      if (get().toast?.id !== id || remaining != null) return;
      if (timer) clearTimeout(timer);
      timer = null;
      remaining = Math.max(0, deadline - Date.now());
    },
    resume: id => {
      if (get().toast?.id !== id || remaining == null) return;
      arm(id, Math.max(UNDO_TOAST_MIN_AFTER_PAUSE_MS, remaining));
    },
  };
});
