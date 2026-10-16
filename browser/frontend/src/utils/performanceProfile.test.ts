import { describe, expect, it } from 'vitest';
import { inferBrowserPerformanceProfile, isSafariUserAgent, performanceSamplingNote } from './performanceProfile';

it('names the actual capped analysis count and its denominator', () => {
  expect(performanceSamplingNote({ a: { performance_sampling: { used: 598, total: 10000 } } }))
    .toContain('598 of 10,000 reads');
  expect(performanceSamplingNote({ a: {} })).toBe('');
});

describe('performance profile heuristics', () => {
  it('keeps strong desktop clients on the standard/high quality path', () => {
    const profile = inferBrowserPerformanceProfile({
      hardwareConcurrency: 16,
      deviceMemory: 8,
      userAgent: 'Mozilla/5.0 Chrome/124.0.0.0 Safari/537.36',
    });

    expect(profile.tier).toBe('high');
    expect(profile.interactiveCanvasScale).toBe(2);
    expect(profile.useGpuPanTransforms).toBe(true);
    expect(profile.useContentVisibility).toBe(true);
  });

  it('keeps stock 8-core 8GB clients on the standard path', () => {
    const profile = inferBrowserPerformanceProfile({
      hardwareConcurrency: 8,
      deviceMemory: 8,
      userAgent: 'Mozilla/5.0 Chrome/124.0.0.0 Safari/537.36',
    });

    expect(profile.tier).toBe('standard');
    expect(profile.interactiveCanvasScale).toBe(2);
    expect(profile.defaultAllReadsDisplayCap).toBe(2_000);
    expect(profile.defaultBackgroundReadCap).toBe(1_000);
    expect(profile.defaultMaxRegionForReads).toBe(100_000);
    expect(profile.useGpuPanTransforms).toBe(true);
    expect(profile.useContentVisibility).toBe(true);
  });

  it('uses a low-power path for truly constrained clients', () => {
    const profile = inferBrowserPerformanceProfile({
      hardwareConcurrency: 6,
      deviceMemory: 4,
      userAgent: 'Mozilla/5.0 Chrome/124.0.0.0 Safari/537.36',
    });

    expect(profile.tier).toBe('low');
    expect(profile.interactiveCanvasScale).toBe(1);
    expect(profile.defaultAllReadsDisplayCap).toBe(1_000);
    expect(profile.defaultBackgroundReadCap).toBe(500);
    expect(profile.defaultMaxRegionForReads).toBe(50_000);
    expect(profile.useGpuPanTransforms).toBe(false);
    expect(profile.useContentVisibility).toBe(false);
  });

  it('treats low-core Safari as low power', () => {
    const profile = inferBrowserPerformanceProfile({
      hardwareConcurrency: 8,
      userAgent: 'Mozilla/5.0 Version/17.4 Safari/605.1.15',
    });

    expect(profile.tier).toBe('low');
    expect(profile.reasons.some(reason => reason.includes('safari-low-power'))).toBe(true);
  });

  it('disables content-visibility for Safari even on standard-tier clients', () => {
    const profile = inferBrowserPerformanceProfile({
      hardwareConcurrency: 10,
      userAgent: 'Mozilla/5.0 Version/17.4 Safari/605.1.15',
    });

    expect(isSafariUserAgent('Mozilla/5.0 Version/17.4 Safari/605.1.15')).toBe(true);
    expect(profile.tier).toBe('standard');
    expect(profile.useGpuPanTransforms).toBe(true);
    expect(profile.useContentVisibility).toBe(false);
  });
});
