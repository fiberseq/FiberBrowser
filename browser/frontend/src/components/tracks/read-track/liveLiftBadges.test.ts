/**
 * Per-read insertion badges (owner feedback 19 Oct): in a split MAT panel with more rows than its PAT sibling,
 * "fill height" made rows under 7 px, where labels are culled, and the remaining notch was a sliver. Badges are now a
 * display option (off / ticks / labelled ticks, default ticks) and always keep a visible minimum notch.
 */
import { describe, expect, it } from 'vitest';
import { BADGE_MIN_NOTCH, drawLiveLiftMarks, liveLiftBadgeGeometry, liveLiftHitAt } from './liveLiftCanvas';

const ll = { segments: [[0, 1000, 0, '+', true]], connectors: [], badges: [[500, 'source_insertion', 2353, 2353, 'right']] } as never;
const at = (rowHeight: number, badgeMode?: 'off' | 'ticks' | 'labels') => ({ y: 0, rowHeight, linkedOffset: 0, regionWidth: 1000, toX: (r: number) => r, badgeMode });

describe('per-read insertion badges', () => {
  it('keep a visible notch on rows a few px tall, in ticks and labels modes', () => {
    for (const mode of ['ticks', 'labels'] as const) for (const h of [2, 5, 6.5]) {
      const [b] = liveLiftBadgeGeometry(ll, at(h, mode));
      expect(b.notch.w).toBeGreaterThanOrEqual(BADGE_MIN_NOTCH.w);
      expect(b.notch.h).toBeGreaterThanOrEqual(BADGE_MIN_NOTCH.h);
      expect(liveLiftHitAt(ll, 500, 1, at(h, mode))?.badge).toBeDefined();
    }
  });
  it('label only in labels mode, on rows of 7 px or more', () => {
    expect(liveLiftBadgeGeometry(ll, at(12, 'labels'))[0].label?.text).toBe('+2.4 kb');
    expect(liveLiftBadgeGeometry(ll, at(6.5, 'labels'))[0].label).toBeNull();
    expect(liveLiftBadgeGeometry(ll, at(12, 'ticks'))[0].label).toBeNull();
  });
  it('off draws and hits nothing (the Differences row still has them)', () => {
    expect(liveLiftBadgeGeometry(ll, at(12, 'off'))).toEqual([]);
    expect(liveLiftHitAt(ll, 500, 1, at(12, 'off'))?.badge).toBeUndefined();
    const calls: string[] = [];
    const ctx = new Proxy({}, { get: (_t, k) => (typeof k === 'string' && ['fillText'].includes(k) ? () => calls.push(k) : () => undefined), set: () => true }) as never;
    drawLiveLiftMarks(ctx, ll, { ...at(12, 'off'), isReversed: false, backgroundColor: '#fff' });
    drawLiveLiftMarks(ctx, ll, { ...at(12, 'ticks'), isReversed: false, backgroundColor: '#fff' });
    expect(calls).toEqual([]);
    drawLiveLiftMarks(ctx, ll, { ...at(12, 'labels'), isReversed: false, backgroundColor: '#fff' });
    expect(calls).toEqual(['fillText']);
  });
});
