import { beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { useDafcStore } from '../stores/dafcStore';
import type { DAFCStatus } from '../types/dafc';
import { applyDafcStatusToStores, selectContactResolution } from './useDafcStatusBootstrap';

const loadedStatus: DAFCStatus = {
  loaded: true,
  cool_file: '/tmp/example.mcool',
  bigbed_file: null,
  resolutions: [100, 1_000, 10_000],
  current_resolution: 1_000,
  chroms: [
    { name: 'chr2L', size: 10_000_000 },
    { name: 'chr3R', size: 8_000_000 },
  ],
  has_bigbed: false,
  n_linked_sessions: 0,
};

beforeEach(() => {
  useBrowserStore.setState({
    chrom: 'chr2L',
    start: 1_000,
    end: 2_000,
  } as any);

  useDafcStore.setState({
    dafcLoaded: false,
    dafcChrom: 'chr1',
    dafcStart: 0,
    dafcEnd: 10_000_000,
    dafcXStart: 0,
    dafcXEnd: 10_000_000,
    dafcYStart: 0,
    dafcYEnd: 10_000_000,
    dafcResolution: 10_000,
    dafcResolutions: [],
    dafcSelection: null,
  } as any);
});

describe('DAF-C status bootstrap', () => {
  it('selects the smallest resolution that keeps contact matrices bounded', () => {
    expect(selectContactResolution(40_000, [10, 100, 1_000])).toBe(100);
    expect(selectContactResolution(9_000_000, [1_000, 5_000])).toBe(5_000);
    expect(selectContactResolution(10_000, [])).toBe(10_000);
  });

  it('initializes the contact map around the current browser viewport when possible', () => {
    applyDafcStatusToStores(loadedStatus);

    const state = useDafcStore.getState();
    expect(state.dafcLoaded).toBe(true);
    expect(state.dafcChrom).toBe('chr2L');
    expect(state.dafcStart).toBe(0);
    expect(state.dafcEnd).toBe(52_000);
    expect(state.dafcXStart).toBe(0);
    expect(state.dafcXEnd).toBe(52_000);
    expect(state.dafcYStart).toBe(0);
    expect(state.dafcYEnd).toBe(52_000);
    expect(state.dafcResolution).toBe(100);
  });

  it('follows the browser across a chr-prefix difference, using the map\'s own name', () => {
    useBrowserStore.setState({ chrom: '3R', start: 1_000_000, end: 1_002_000 } as any);

    applyDafcStatusToStores(loadedStatus);

    const state = useDafcStore.getState();
    expect(state.dafcChrom).toBe('chr3R');
    expect(state.dafcStart).toBe(950_000);
  });

  it('falls back to the first contact chromosome when the browser chromosome is absent', () => {
    useBrowserStore.setState({ chrom: 'chrX', start: 1_000, end: 2_000 } as any);

    applyDafcStatusToStores(loadedStatus);

    const state = useDafcStore.getState();
    expect(state.dafcChrom).toBe('chr2L');
    expect(state.dafcStart).toBe(0);
    expect(state.dafcEnd).toBe(500_000);
    expect(state.dafcResolution).toBe(1_000);
  });
});
