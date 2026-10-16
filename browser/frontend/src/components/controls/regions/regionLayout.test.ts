import { describe, expect, it } from 'vitest';
import { formatTick, mergeTranscripts, niceStep, packLanes, ticks } from './regionLayout';

describe('regions map layout', () => {
  it('picks round tick steps and labels them at that precision', () => {
    expect(niceStep(100_000, 5)).toBe(20_000);
    expect(ticks(47_466_640, 47_566_640, 20_000)).toEqual([47_480_000, 47_500_000, 47_520_000, 47_540_000, 47_560_000]);
    expect(formatTick(47_480_000, 20_000)).toBe('47.48 Mb');
    expect(formatTick(58_000_000, 10_000_000)).toBe('58 Mb');
    expect(formatTick(12_500, 500)).toBe('12.5 kb');
    expect(formatTick(850, 50)).toBe('850 bp');
  });

  it('merges a gene\'s transcripts into one span', () => {
    const merged = mergeTranscripts([
      { id: 'a', name: 'NAPA', start: 100, end: 900, strand: '-' },
      { id: 'b', name: 'NAPA', start: 120, end: 950, strand: '-' },
      { id: 'c', name: 'KPTN', start: 1000, end: 1500, strand: '-' },
    ]);
    expect(merged.map(g => [g.name, g.start, g.end])).toEqual([['NAPA', 100, 950], ['KPTN', 1000, 1500]]);
  });

  it('packs genes and their names into lanes without overlap, counting what does not fit', () => {
    const genes = [
      { name: 'A', start: 0, end: 100 },
      { name: 'B', start: 50, end: 150 },
      { name: 'C', start: 60, end: 70 },
      { name: 'D', start: 72, end: 90 },
      { name: 'E', start: 400, end: 500 },
    ];
    const { placed, hidden, lanes } = packLanes(genes, bp => bp, { maxLanes: 3 });
    expect(lanes).toBe(3);
    expect(hidden).toBe(1);
    const byLane = new Map<number, typeof placed>();
    for (const p of placed) byLane.set(p.lane, [...(byLane.get(p.lane) ?? []), p]);
    for (const row of byLane.values()) {
      for (let i = 1; i < row.length; i++) expect(row[i].x1).toBeGreaterThanOrEqual(row[i - 1].x2);
    }
    expect(placed.find(p => p.item.name === 'E')!.lane).toBe(0);
  });
});
