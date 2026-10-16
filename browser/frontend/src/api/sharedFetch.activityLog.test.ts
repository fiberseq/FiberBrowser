import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIVITY_LOG_BODY_MAX_CHARS, fetchApiResponse } from './sharedFetch';
import { clearActivityLog, getActivityLog } from '../utils/activityLog';

// The activity log keeps 2,000 request bodies. It parsed and kept each one
// whole: the live figure-state push (every view change) carries the full
// frontend state, so with a 50,000-region catalog every navigation added
// ~10 MB of heap (~200 MB after 20 navigations of two deep datasets).
describe('activity log of API requests', () => {
  beforeEach(() => {
    clearActivityLog();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response));
  });
  afterEach(() => vi.unstubAllGlobals());

  const settle = () => new Promise(resolve => setTimeout(resolve, 20)); // the log module loads lazily

  it('records a large body by its size, not its content', async () => {
    const big = JSON.stringify({ catalog: Array.from({ length: 2_000 }, (_, i) => ({ id: `e${i}`, label: `region ${i}` })) });
    expect(big.length).toBeGreaterThan(ACTIVITY_LOG_BODY_MAX_CHARS);
    await fetchApiResponse('/api/regions/catalog', { method: 'PUT', body: big });
    await settle();
    const entry = getActivityLog().find(e => e.path === '/api/regions/catalog');
    expect(entry?.body).toBe(`<${big.length} characters>`);
  });

  it('still records a small body parsed', async () => {
    await fetchApiResponse('/api/cluster_all?chrom=chr2R', { method: 'POST', body: JSON.stringify({ method: 'kmeans' }) });
    await settle();
    expect(getActivityLog().find(e => e.path?.startsWith('/api/cluster_all'))?.body).toEqual({ method: 'kmeans' });
  });

  it('does not log the figure-state push', async () => {
    await fetchApiResponse('/api/render/live_state', { method: 'POST', body: JSON.stringify({ frontend_state: {} }) });
    await settle();
    expect(getActivityLog().some(e => e.path?.startsWith('/api/render/live_state'))).toBe(false);
  });
});
