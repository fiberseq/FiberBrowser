import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VPlotTabContent } from './VPlotTabContent';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../charts/VPlotChart', () => ({
  VPlotChart: ({ matrix }: { matrix: number[][] }) => <div data-testid="vplot">{matrix[0][0]}</div>,
}));

const vp = (value: number) => ({ matrix: [[value]], size_min: 10, size_max: 300, size_bin: 10, pos_bin: 10 } as any);

describe('VPlotTabContent', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows each panel its own V-plots when two panels share a dataset', () => {
    const noop = () => {};
    act(() => root.render(
      <VPlotTabContent
        vplotData={{ ds: { 0: vp(1) }, copy: { 0: vp(2) } }}
        vplotLoading={false} showVplotSettings={false} setShowVplotSettings={noop} vplotSettingsSummary=""
        vplotSizeBin={10} setVplotSizeBin={noop} vplotPosBin={10} setVplotPosBin={noop}
        vplotSizeMin={10} setVplotSizeMin={noop} vplotSizeMax={300} setVplotSizeMax={noop}
        vplotLog setVplotLog={noop} vplotSmooth={1} setVplotSmooth={noop}
        vplotNormalize="per_cluster" setVplotNormalize={noop} vplotLayer={null} setVplotLayer={noop}
        start={0} end={100} datasetIds={['ds', 'copy']} multiDs
        visibleClusterData={[{ cluster: 0, color: '#f00', counts: [1, 1], totalCount: 2 }]}
        chartWidth={200} getDatasetLabel={sk => sk} getDatasetColor={() => '#000'}
      />,
    ));
    expect([...container.querySelectorAll('[data-testid="vplot"]')].map(e => e.textContent)).toEqual(['1', '2']);
  });
});
