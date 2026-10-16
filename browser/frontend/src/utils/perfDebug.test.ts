import { afterEach, describe, expect, it, vi } from 'vitest';
import { logPerfTiming } from './perfDebug';

// 2026-09-30 UI audit L17: every read draw printed a "[perf] read.draw" warning.
describe('perf timings are debug output only', () => {
  afterEach(() => {
    window.localStorage.removeItem('fiberbrowser_perf_debug');
    vi.restoreAllMocks();
  });

  it('a slow draw prints nothing unless perf debugging is on', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    logPerfTiming('read.draw', 120, { reads: 500 }, 16);
    logPerfTiming('read.fetch', 5);
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('with the debug flag, slow timings warn and fast ones are info', () => {
    window.localStorage.setItem('fiberbrowser_perf_debug', '1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    logPerfTiming('read.draw', 120, { reads: 500 }, 16);
    logPerfTiming('read.fetch', 5);
    expect(warn).toHaveBeenCalledWith('[perf] read.draw', { ms: 120, reads: 500 });
    expect(info).toHaveBeenCalledWith('[perf] read.fetch', { ms: 5 });
  });
});
