/**
 * "Unsaved session found… Restore" only after a crash, not in a new tab next to a live one (3.0.0 audit LOW-3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SerializedState } from '../stores/historySlice';
import { decideLaunchOffer, type LaunchInfo } from './launchSession';
import { BEAT_MS, STALE_MS, otherTabLive, startTabHeartbeat, stopTabHeartbeat, watchOtherTabs } from './tabPresence';

const OTHER = 'fiberbrowser.liveTab.other-tab';
const hasWork = () => true;
const launch: LaunchInfo = { boot_id: 'run-2', previous_exit: 'crash', previous_boot_id: 'run-1' };
const entry = (bootId: string | null) => ({ state: { datasets: [{ id: 'd' }] } as unknown as SerializedState, timestamp: 1, bootId });

beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
afterEach(() => { stopTabHeartbeat(); vi.useRealTimers(); });

describe('tab presence', () => {
  it('sees another open page of this run, not its own, not an older run, not a stale beat', () => {
    expect(otherTabLive('run-2')).toBe(false);
    startTabHeartbeat('run-2');
    expect(otherTabLive('run-2')).toBe(false);          // only this page
    localStorage.setItem(OTHER, JSON.stringify({ bootId: 'run-1', at: Date.now() }));
    expect(otherTabLive('run-2')).toBe(false);          // a page of the run before
    localStorage.setItem(OTHER, JSON.stringify({ bootId: 'run-2', at: Date.now() }));
    expect(otherTabLive('run-2')).toBe(true);
    expect(otherTabLive('run-2', Date.now() + STALE_MS + 1)).toBe(false);  // it stopped beating (crashed)
    localStorage.setItem(OTHER, JSON.stringify({ bootId: 'run-2', at: Date.now(), closed: true }));
    expect(otherTabLive('run-2')).toBe(false);          // it went normally
  });

  it('beats while open and clears its beat when the page goes', () => {
    startTabHeartbeat('run-2');
    const own = () => Object.keys(localStorage).filter(k => k.startsWith('fiberbrowser.liveTab.'));
    expect(own()).toHaveLength(1);
    const first = JSON.parse(localStorage.getItem(own()[0])!).at;
    vi.advanceTimersByTime(BEAT_MS + 10);
    expect(JSON.parse(localStorage.getItem(own()[0])!).at).toBeGreaterThan(first);
    window.dispatchEvent(new Event('pagehide'));
    expect(JSON.parse(localStorage.getItem(own()[0])!).closed).toBe(true);   // gone normally, not live
    expect(otherTabLive('run-2')).toBe(false);
  });
});

describe('the launch offer with another page open', () => {
  it('a save from this run while another page of it is open: nothing offered', () => {
    expect(decideLaunchOffer(entry('run-2'), launch, { hasWork, otherTabLive: true })).toBeNull();
  });
  it('a save from this run with no other page open (reload, a closed or crashed tab): crash recovery as before', () => {
    expect(decideLaunchOffer(entry('run-2'), launch, { hasWork, otherTabLive: false })).toBe('recover');
  });
  it('a save from an earlier run (the server crashed or quit) is offered whatever pages are still open', () => {
    expect(decideLaunchOffer(entry('run-1'), launch, { hasWork, otherTabLive: true })).toBe('recover');
    expect(decideLaunchOffer(entry('run-1'), { ...launch, previous_exit: 'clean' }, { hasWork, otherTabLive: true })).toBe('reopen');
  });
});

describe('a page opened right after another page crashed (Codex MED, fb62)', () => {
  it('is told once the other page\'s beat expires', () => {
    localStorage.setItem(OTHER, JSON.stringify({ bootId: 'run-2', at: Date.now() }));   // its last beat, then the crash
    expect(otherTabLive('run-2')).toBe(true);
    const ended = vi.fn();
    watchOtherTabs('run-2', ended);
    vi.advanceTimersByTime(STALE_MS - BEAT_MS);
    expect(ended).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2 * BEAT_MS + 10);
    expect(ended).toHaveBeenCalledWith('crashed');
  });

  it('a page that keeps beating is never reported; one that closes normally is reported as closed', () => {
    localStorage.setItem(OTHER, JSON.stringify({ bootId: 'run-2', at: Date.now() }));
    const ended = vi.fn();
    const stop = watchOtherTabs('run-2', ended);
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(BEAT_MS);
      localStorage.setItem(OTHER, JSON.stringify({ bootId: 'run-2', at: Date.now() }));
    }
    expect(ended).not.toHaveBeenCalled();
    localStorage.setItem(OTHER, JSON.stringify({ bootId: 'run-2', at: Date.now(), closed: true }));
    vi.advanceTimersByTime(BEAT_MS + 10);
    expect(ended).toHaveBeenCalledWith('closed');
    stop();
  });
});
