import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { OverviewTabContent, type ClusterSummary } from './OverviewTabContent';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const clusters: ClusterSummary[] = [
  { cluster: 0, color: '#ef4444', counts: [10], totalCount: 10 },
  { cluster: 1, color: '#14b8a6', counts: [10], totalCount: 10 },
  { cluster: 2, color: '#6366f1', counts: [10], totalCount: 10 },
];

describe('OverviewTabContent cluster visibility', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({
      _historyStack: [],
      _historyFuture: [],
      _historyBaseline: null,
    } as any);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('hides selected clusters without unhiding clusters that were already hidden', async () => {
    const setClusterFocus = vi.fn();

    await act(async () => {
      root.render(
        <OverviewTabContent
          clusterData={clusters}
          datasetIds={['ds1']}
          multiDs={false}
          clusterFocus={{ ds1: new Set([0, 1]) }}
          setClusterFocus={setClusterFocus}
          clusterOrder={{ ds1: [0, 1, 2] }}
          setClusterOrder={vi.fn()}
          selectedClusters={{ ds1: new Set([1]) }}
          setClusterSelection={vi.fn()}
          toggleClusterSelection={vi.fn()}
          clearClusterSelection={vi.fn()}
          mergeSelectedClusters={vi.fn(() => 0)}
          combinedProfiles={{}}
          enabledMetaProfiles={{}}
          proportions={null}
          chartWidth={300}
          containerWidth={300}
          profileHeight={80}
          isReversed={false}
          dissolving={null}
          onDissolve={vi.fn()}
          getDatasetLabel={id => id}
        />,
      );
    });

    const hideButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.trim() === 'Hide') as HTMLButtonElement | undefined;
    expect(hideButton).toBeTruthy();

    await act(async () => {
      hideButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(setClusterFocus).toHaveBeenCalledTimes(1);
    expect(setClusterFocus.mock.calls[0][0]).toBe('ds1');
    expect(setClusterFocus.mock.calls[0][1]).toEqual(new Set([0]));
  });
});
