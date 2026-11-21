/**
 * Follow / Pin for Plots (PLOTS_PANEL_PLAN.md §Follow): a Follow plot recomputes `delayMs` after the browser's view
 * stops moving; meanwhile it says "Updating…" and never shows the previous locus's numbers as current.
 *
 * - FollowController: the debounce, with an injectable timer so tests drive it with fake time.
 * - plotFreshness: the stale-state guard. A plot is current only when the result on screen was computed for the
 *   target the plot wants now and no move is waiting; otherwise it is updating (old cells greyed, counts "—").
 */
import { useEffect, useRef, useState } from 'react';

export interface FollowTimer {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const WINDOW_TIMER: FollowTimer = {
  set: (fn, ms) => globalThis.setTimeout(fn, ms),
  clear: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Commits a target `delayMs` after the last `update` that changed it (by `keyOf`). An update back to the committed
 * target cancels the wait. `pending` is true while a different target waits.
 */
export class FollowController<T> {
  private committed: T;
  private wanted: T;
  private handle: unknown = null;
  private readonly timer: FollowTimer;

  constructor(
    initial: T,
    private readonly keyOf: (t: T) => string,
    private readonly onCommit: (t: T) => void,
    private delayMs: number,
    timer: FollowTimer = WINDOW_TIMER,
  ) {
    this.committed = initial;
    this.wanted = initial;
    this.timer = timer;
  }

  get pending(): boolean { return this.handle !== null; }
  get current(): T { return this.committed; }
  get target(): T { return this.wanted; }

  setDelay(ms: number): void { this.delayMs = Math.max(0, ms); }

  update(next: T): void {
    this.wanted = next;
    if (this.handle !== null) { this.timer.clear(this.handle); this.handle = null; }
    if (this.keyOf(next) === this.keyOf(this.committed)) return;
    if (this.delayMs <= 0) { this.commit(next); return; }
    this.handle = this.timer.set(() => { this.handle = null; this.commit(this.wanted); }, this.delayMs);
  }

  /** Commit the waiting target now (Pin mid-update, Enter). */
  flush(): void {
    if (this.handle === null) return;
    this.timer.clear(this.handle);
    this.handle = null;
    this.commit(this.wanted);
  }

  /** Commit `t` at once, dropping any wait (a pinned locus, a jump from inside Plots). */
  jump(t: T): void {
    this.wanted = t;
    if (this.handle !== null) { this.timer.clear(this.handle); this.handle = null; }
    this.commit(t);
  }

  dispose(): void {
    if (this.handle !== null) this.timer.clear(this.handle);
    this.handle = null;
  }

  private commit(t: T): void {
    this.committed = t;
    this.onCommit(t);
  }
}

/**
 * The target a plot computes for: `live` debounced by `delayMs` while `follow`, or `pinned` (at once) when not.
 * `pending`: a move is waiting (the plot is updating).
 */
export function useFollowedTarget<T>(live: T, pinned: T | null, keyOf: (t: T) => string, delayMs: number): { target: T; pending: boolean } {
  const want = pinned ?? live;
  const [target, setTarget] = useState<T>(want);
  const keyRef = useRef(keyOf);
  keyRef.current = keyOf;
  const ctl = useRef<FollowController<T> | null>(null);
  if (!ctl.current) ctl.current = new FollowController<T>(want, t => keyRef.current(t), setTarget, delayMs);
  const liveRef = useRef(live);
  liveRef.current = live;
  const liveKey = keyOf(live);
  const pinnedKey = pinned ? keyOf(pinned) : null;
  useEffect(() => { ctl.current!.setDelay(delayMs); }, [delayMs]);
  useEffect(() => {
    const c = ctl.current!;
    if (pinned) c.jump(pinned); else c.update(liveRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey, pinnedKey]);
  useEffect(() => () => ctl.current?.dispose(), []);
  // Updating until the computed-for target is the one wanted now.
  return { target, pending: keyOf(target) !== keyOf(want) };
}

export type PlotFreshness = 'current' | 'updating' | 'error' | 'empty';

/**
 * The stale-state guard. `resultKey`: the request the result on screen answers (null: none yet). `wantKey`: the
 * request the plot needs now. `pending`: the view moved and the recompute waits for it to settle.
 * Only 'current' may show its numbers as the plot's; 'updating' shows the previous result greyed with its counts
 * blanked, or nothing.
 */
export function plotFreshness(p: { resultKey: string | null; wantKey: string; pending: boolean; loading: boolean; error: string | null }): {
  state: PlotFreshness; showResult: boolean; stale: boolean;
} {
  if (p.error && !p.pending && !p.loading) return { state: 'error', showResult: false, stale: false };
  if (!p.pending && p.resultKey !== null && p.resultKey === p.wantKey) return { state: 'current', showResult: true, stale: false };
  if (p.pending || p.loading || p.resultKey !== p.wantKey) {
    return { state: 'updating', showResult: p.resultKey !== null, stale: p.resultKey !== null };
  }
  return { state: 'empty', showResult: false, stale: false };
}
