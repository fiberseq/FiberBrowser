// Coverage 3.1.1 (session migration): a Plots card saved by 3.1.0 keeps its pooled summary when a session or the
// Gallery reloads it through normalizePlot; a 3.1.1 card keeps the curve summary across a save and reload.
import { describe, expect, it } from 'vitest';
import { newPlot, normalizePlot } from './plotModel';

// What 3.1.0 wrote for a metaprofile card's summary (no `statistic` field yet).
const SUMMARY_310 = { on: true, chart: 'bar', from: -200, to: 200, sizeFrom: 0, sizeTo: 90, ci: 'auto', resamples: 1000, bootSeed: null, unit: 'regions' };

describe('summary statistic across a session reload', () => {
  it('a 3.1.0 card reloads pooled, with its window and settings kept', () => {
    const raw = JSON.parse(JSON.stringify({ ...newPlot({ type: 'metaprofile' } as never), summary: SUMMARY_310 }));
    const plot = normalizePlot(raw);
    expect(plot.summary.statistic).toBe('pooled');
    expect([plot.summary.on, plot.summary.from, plot.summary.to]).toEqual([true, -200, 200]);
  });

  it('a 3.1.0 card whose summary was never turned on still reloads pooled (the object was saved)', () => {
    const plot = normalizePlot(JSON.parse(JSON.stringify({ ...newPlot(), summary: { ...SUMMARY_310, on: false } })));
    expect(plot.summary.statistic).toBe('pooled');
  });

  it('a new 3.1.1 card is the curve summary, and stays so after a save and reload', () => {
    const fresh = newPlot();
    expect(fresh.summary.statistic).toBe('curve');
    expect(normalizePlot(JSON.parse(JSON.stringify(fresh))).summary.statistic).toBe('curve');
    const pooled = { ...fresh, summary: { ...fresh.summary, statistic: 'pooled' as const } };
    expect(normalizePlot(JSON.parse(JSON.stringify(pooled))).summary.statistic).toBe('pooled');
  });

  it('a card with no summary at all starts from the curve', () => {
    const { summary: _drop, ...noSummary } = newPlot() as unknown as Record<string, unknown>;
    expect(normalizePlot(JSON.parse(JSON.stringify(noSummary))).summary.statistic).toBe('curve');
  });
});
