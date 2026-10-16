import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { CrashRecoveryBanner, autoSaveHasWork } from './CrashRecoveryBanner';

vi.mock('../../stores/historyStorage', () => ({
  loadAutoSave: vi.fn(async () => ({
    state: { datasets: [{ id: 'ds1' }], chrom: 'chr1', start: 0, end: 100, clusterAssignments: { ds1: { r1: 0 } } },
    timestamp: Date.now(),
  })),
  clearAutoSave: vi.fn(async () => undefined),
  markRestoredWork: vi.fn(),
}));
// The server had ds1 when the page opened (a CLI launch).
vi.mock('../../api/datasets', () => ({
  getDatasets: vi.fn(async () => ({ datasets: [{ id: 'ds1' }] })),
  addDataset: vi.fn(),
}));

import { clearAutoSave, loadAutoSave } from '../../stores/historyStorage';
import { launchOfferHidesWelcome, useLaunchUiStore } from '../../utils/launchSession';
import { getDatasets } from '../../api/datasets';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('CrashRecoveryBanner visibility', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({ datasets: [{ id: 'ds1' }], _historyStack: [] } as any);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('stays up while you work and hides once a new dataset is loaded', async () => {
    await act(async () => {
      root.render(<CrashRecoveryBanner />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Restore');

    // Working or moving around doesn't hide it.
    act(() => useBrowserStore.setState({ _historyStack: [{ label: 'Cluster', kind: 'clustering', timestamp: 0, state: {} }] } as any));
    expect(container.textContent).toContain('Restore');

    // A dataset the server didn't have at startup: a new session.
    act(() => useBrowserStore.setState({ datasets: [{ id: 'ds1' }, { id: 'ds2' }] } as any));
    expect(container.textContent).not.toContain('Restore');
  });

  it('keeps the saved copy and the banner when restoring fails', async () => {
    await act(async () => {
      root.render(<CrashRecoveryBanner />);
      await Promise.resolve();
      await Promise.resolve();
    });
    vi.mocked(clearAutoSave).mockClear();
    vi.mocked(getDatasets).mockRejectedValueOnce(new Error('server unavailable'));
    const restore = [...container.querySelectorAll('button')].find(b => b.textContent === 'Restore')!;
    await act(async () => {
      restore.click();
      await new Promise(r => setTimeout(r, 0));
    });
    expect(clearAutoSave).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Restore');
    expect(useBrowserStore.getState().error).toContain('server unavailable');
  });

  // M10: the Welcome card stays away while the offer is being decided or is
  // up (one first choice, not two), and comes back once it is dismissed.
  it('keeps the Welcome card away while the offer is decided and up', async () => {
    let resolveSave: (v: unknown) => void = () => undefined;
    vi.mocked(loadAutoSave).mockImplementationOnce(() => new Promise(r => { resolveSave = r; }) as any);
    await act(async () => {
      root.render(<CrashRecoveryBanner />);
      await Promise.resolve();
    });
    expect(launchOfferHidesWelcome(useLaunchUiStore.getState())).toBe(true);  // deciding
    await act(async () => {
      resolveSave({ state: { datasets: [{ id: 'ds1' }], chrom: 'chr1', start: 0, end: 100, clusterAssignments: { ds1: { r1: 0 } } }, timestamp: Date.now() });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Restore');
    expect(useLaunchUiStore.getState()).toMatchObject({ deciding: false, offerShown: true });
    const dismiss = [...container.querySelectorAll('button')].find(b => b.textContent === 'Dismiss')!;
    act(() => dismiss.click());
    expect(launchOfferHidesWelcome(useLaunchUiStore.getState())).toBe(false);
  });

  it('storage that never answers holds the Welcome card back for a few seconds only', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(loadAutoSave).mockImplementationOnce(() => new Promise(() => undefined) as any);
      await act(async () => {
        root.render(<CrashRecoveryBanner />);
        await Promise.resolve();
      });
      expect(launchOfferHidesWelcome(useLaunchUiStore.getState())).toBe(true);
      act(() => { vi.advanceTimersByTime(3_500); });
      expect(launchOfferHidesWelcome(useLaunchUiStore.getState())).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('nothing to offer: the Welcome card is not held back', async () => {
    vi.mocked(loadAutoSave).mockResolvedValueOnce(null as any);
    await act(async () => {
      root.render(<CrashRecoveryBanner />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(launchOfferHidesWelcome(useLaunchUiStore.getState())).toBe(false);
  });

  // fb-n4-tour: nothing to offer was decided before the page had listed the
  // datasets the server started with, and the Welcome card flashed over them.
  it('nothing to offer on a CLI launch: the card waits until the page lists its datasets', async () => {
    useBrowserStore.setState({ datasets: [] } as any);
    vi.mocked(loadAutoSave).mockResolvedValueOnce(null as any);
    await act(async () => {
      root.render(<CrashRecoveryBanner />);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(launchOfferHidesWelcome(useLaunchUiStore.getState())).toBe(true);
    await act(async () => {
      useBrowserStore.setState({ datasets: [{ id: 'ds1' }] } as any);
      for (let i = 0; i < 3; i++) await Promise.resolve();
    });
    expect(launchOfferHidesWelcome(useLaunchUiStore.getState())).toBe(false);
  });

  it('nothing to offer and nothing open: the card is not held back', async () => {
    useBrowserStore.setState({ datasets: [] } as any);
    vi.mocked(loadAutoSave).mockResolvedValueOnce(null as any);
    vi.mocked(getDatasets).mockResolvedValueOnce({ datasets: [] } as any);
    await act(async () => {
      root.render(<CrashRecoveryBanner />);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(launchOfferHidesWelcome(useLaunchUiStore.getState())).toBe(false);
  });

  it('only counts autosaves with analysis worth restoring', () => {
    expect(autoSaveHasWork({ clusterAssignments: { ds1: {} }, selectedPeaks: [] } as any)).toBe(false);
    expect(autoSaveHasWork({ selectedPeaks: [2] } as any)).toBe(true);
  });
});
