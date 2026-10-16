import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyPerformanceInfo, initializePerformanceMode, type PerformanceInfo, usePerformanceStore } from './performanceStore';
import { useBrowserStore } from './browserStore';
import { getBrowserPerformanceProfile, performanceModeTitle, resetBrowserPerformanceProfileForTests } from '../utils/performanceProfile';
import { getCanvasRenderScale } from '../utils/canvasUtils';
import { readRegionDiagnostics } from '../api/loadedReadRegion';
import { readExpansionDiagnostics } from '../api/readBinary';
import * as sandbox from '../utils/sandbox';
import * as publicFlag from '../utils/publicServerFlag';
import * as sharedFetch from '../api/sharedFetch';

const info = (effective: PerformanceInfo['effective']): PerformanceInfo => ({
  mode: effective, effective, hardware: { total_memory_bytes: 64 * 1024 ** 3, cores: 16 },
  client_cohort_bytes: effective === 'low' ? 128 * 1024 ** 2 : 3 * 1024 ** 3,
  client_expansion_bytes: effective === 'low' ? 16 * 1024 ** 2 : 128 * 1024 ** 2,
  margin_fraction: effective === 'low' ? 0 : 0.5, max_working_reads: effective === 'low' ? 2000 : 0,
  sample_target: 1000, workers: 1, numeric_threads: 1, decode_workers: 1, prefetch_multiplier: 1, caches: {},
});

afterEach(() => { vi.restoreAllMocks(); applyPerformanceInfo(info('standard')); resetBrowserPerformanceProfileForTests(); usePerformanceStore.setState({ info: null }); });

describe('performance mode application', () => {
  it.each(['sandbox', 'public'])('does not request host settings from a %s tab', async kind => {
    vi.spyOn(sandbox, 'isSandboxPage').mockReturnValue(kind === 'sandbox');
    vi.spyOn(publicFlag, 'isPublicServerPage').mockReturnValue(kind === 'public');
    const fetch = vi.spyOn(sharedFetch, 'fetchJson');
    await initializePerformanceMode();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('switches caches, sampling and existing canvases immediately', () => {
    useBrowserStore.setState({ loadAllReads: { deep: true }, readDisplayMode: 'all', cachedLayerTypes: { m6a: true } });
    const generation = useBrowserStore.getState().refreshGeneration;
    applyPerformanceInfo(info('low'));
    expect(getBrowserPerformanceProfile().tier).toBe('low');
    expect(getCanvasRenderScale()).toBe(1);
    expect(useBrowserStore.getState().readDisplayMode).toBe('sample');
    expect(useBrowserStore.getState().loadAllReads).toEqual({});
    expect(useBrowserStore.getState().cachedLayerTypes).toEqual({});
    expect(useBrowserStore.getState().refreshGeneration).toBe(generation + 1);
    expect(readRegionDiagnostics().budget).toBe(128 * 1024 ** 2);
    expect(readExpansionDiagnostics().budget).toBe(16 * 1024 ** 2);
    applyPerformanceInfo(info('high'));
    expect(getCanvasRenderScale()).toBe(2);
    expect(useBrowserStore.getState().allReadsDisplayCap).toBe(2000);
    expect(performanceModeTitle()).toContain('High performance');
  });

  it('shows the effective mode when Auto is selected', () => {
    applyPerformanceInfo({ ...info('low'), mode: 'auto' });
    expect(performanceModeTitle()).toBe('Performance mode: Auto (Low memory).');
  });
});

it('applies the initial mode before reads without a redundant refresh', async () => {
  const generation = useBrowserStore.getState().refreshGeneration;
  const fetch = vi.spyOn(sharedFetch, 'fetchJson').mockResolvedValue({ ...info('high'), mode: 'auto' });
  await initializePerformanceMode();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(useBrowserStore.getState().refreshGeneration).toBe(generation);
  expect(useBrowserStore.getState().allReadsDisplayCap).toBe(2000);
});
