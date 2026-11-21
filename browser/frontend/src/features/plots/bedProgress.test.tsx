/**
 * Large BED sets read in chunks: regions done / total advance after each chunk, an abort stops between chunks, and
 * the progress line shows done / total with elapsed time and a Cancel button.
 */
import '../testSetup';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { readRegionChunks } from './bedData';
import { BedProgressLine } from './BedPlot';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const answer = (offset: number, limit: number, total: number) => ({
  success: true, jobs_total: total,
  regions: Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => ({ set: 'a', index: offset + i, reads: {} })),
});

describe('chunked region reads', () => {
  it('reads every region once, reporting done / total after each chunk', async () => {
    const seen: Array<[number, number]> = [];
    const fetchChunk = vi.fn(async (o: number, l: number) => answer(o, l, 620));
    const out = await readRegionChunks(fetchChunk, 250, (d, t) => seen.push([d, t]));
    expect(fetchChunk.mock.calls).toEqual([[0, 250], [250, 250], [500, 250]]);
    expect(seen).toEqual([[250, 620], [500, 620], [620, 620]]);
    expect(out!.map(r => r.index)).toEqual(Array.from({ length: 620 }, (_, i) => i));
  });
  it('an abort stops before the next chunk', async () => {
    const controller = new AbortController();
    const fetchChunk = vi.fn(async (o: number, l: number) => { if (o === 250) controller.abort(); return answer(o, l, 1000); });
    expect(await readRegionChunks(fetchChunk, 250, () => {}, controller.signal)).toBeNull();
    expect(fetchChunk).toHaveBeenCalledTimes(2);
  });
  it('a cancelled answer from the server stops it', async () => {
    expect(await readRegionChunks(async () => ({ success: false, cancelled: true, regions: [] }), 250, () => {})).toBeNull();
  });
});

describe('the progress line', () => {
  it('shows done / total and elapsed seconds; Cancel calls back', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onCancel = vi.fn();
    act(() => { root.render(<BedProgressLine progress={{ done: 250, total: 1000, startedAt: 7_500 }} onCancel={onCancel} />); });
    const el = container.querySelector('[data-testid="plots-bed-progress"]')!;
    expect(el.textContent).toContain('Reading regions 250 / 1,000 · 2.5 s');
    act(() => { vi.advanceTimersByTime(1000); });
    expect(el.textContent).toContain('3.5 s');
    act(() => { (container.querySelector('[data-testid="plots-bed-cancel"]') as HTMLButtonElement).click(); });
    expect(onCancel).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });
});
