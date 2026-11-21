import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTO_SCAN_BUDGET_MS, armScanBudget, scanStoppedNote } from './scanBudget';

/** Automatic peak scans stop after 60 s and say so in the Scan control (no longer only on the console). */
describe('an automatic scan past its budget', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('stops after 60 s with the note the Scan control shows', () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const onStop = vi.fn();
    armScanBudget(controller, onStop);
    vi.advanceTimersByTime(AUTO_SCAN_BUDGET_MS - 1);
    expect(onStop).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(controller.signal.aborted).toBe(true);
    expect(scanStoppedNote()).toBe('Scan stopped after 60 s — press Scan to retry');
  });

  it('a scan that finished (disarmed) or was cancelled already says nothing', () => {
    vi.useFakeTimers();
    const done = new AbortController();
    const onDone = vi.fn();
    armScanBudget(done, onDone)();
    const cancelled = new AbortController();
    const onCancelled = vi.fn();
    armScanBudget(cancelled, onCancelled);
    cancelled.abort();
    vi.advanceTimersByTime(AUTO_SCAN_BUDGET_MS * 2);
    expect(onDone).not.toHaveBeenCalled();
    expect(done.signal.aborted).toBe(false);
    expect(onCancelled).not.toHaveBeenCalled();
  });
});
