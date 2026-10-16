import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDafcStore } from '../stores/dafcStore';

const calls = vi.hoisted(() => [] as Array<(version: number) => void>);

vi.mock('../api/dafc', () => ({
  getLinkedSession: vi.fn(() => new Promise(resolve => {
    calls.push(version => resolve({
      version,
      n_reads: version,
      contact_mode: 'dafc',
      split_view_mode: 'region_independent',
      regions: { chrom: 'chr1', x_start: 0, x_end: 100, y_start: 0, y_end: 100 },
    }));
  })),
}));

import { useDafcPolling } from './useDafcPolling';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useDafcPolling', () => {
  afterEach(() => {
    vi.useRealTimers();
    window.history.replaceState(null, '', '/');
  });

  it('never rolls the linked state back to an older version answered late', async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, '', '/?session=s1');
    const applied: number[] = [];
    const unsubscribe = useDafcStore.subscribe((state, prev) => {
      if (state.linkedVersion !== prev.linkedVersion) applied.push(state.linkedVersion);
    });
    function Host() { useDafcPolling(); return null; }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(<Host />));

    // The first poll is slow; a tick passes while it is pending.
    act(() => { vi.advanceTimersByTime(1_000); });
    // Answer any newer poll first with version 2, then the slow one with version 1.
    for (let i = calls.length - 1; i >= 1; i -= 1) await act(async () => { calls[i](2); });
    await act(async () => { calls[0](1); });
    // Later polls report version 2.
    for (let n = 0; n < 3; n += 1) {
      act(() => { vi.advanceTimersByTime(1_000); });
      for (const answer of calls.splice(0)) await act(async () => { answer(2); });
    }

    expect(applied).toEqual([...applied].sort((a, b) => a - b));
    expect(useDafcStore.getState().linkedVersion).toBe(2);
    unsubscribe();
    act(() => root.unmount());
  });
});
