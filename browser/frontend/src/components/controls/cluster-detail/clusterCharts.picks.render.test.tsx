/**
 * fb-n5-charts: Composition shows with one dataset (Bar / Pie / Line), the
 * V-plot switches between Midpoint and Full footprint, and picking clusters
 * (on a chart's names, or anywhere else through the shared selection) filters
 * Profiles, Composition and the V-plots.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { CompositionTabContent, compositionPieSegments, compositionProportions } from './CompositionTabContent';
import { ProfilesTabContent } from './ProfilesTabContent';
import { VPlotTabContent, vplotModeCaption } from './VPlotTabContent';
import { pickedClusterData, pickedClusterIds, togglePick } from './clusterPicks';
import type { ClusterSummary } from './OverviewTabContent';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../charts/VPlotChart', () => ({
  VPlotChart: ({ filename }: { filename: string }) => <div data-testid="vplot">{filename}</div>,
}));
vi.mock('../../charts/OverlayProfileChart', () => ({
  OverlayProfileChart: ({ series }: { series: Array<{ label: string }> }) => (
    <div data-testid="profile">{series.map(s => s.label).join(',')}</div>
  ),
}));
vi.mock('./ClusterCharts', () => ({
  ClusterBarChart: ({ clusterIds, datasetLabels, proportions }: { clusterIds: number[]; datasetLabels: string[]; proportions: Map<number, number[]> }) => (
    <div data-testid="bar">{datasetLabels.join('|')}:{clusterIds.map(c => `${c}=${proportions.get(c)?.map(v => v.toFixed(2)).join('/')}`).join(',')}</div>
  ),
  ClusterLineChart: ({ clusterIds }: { clusterIds: number[] }) => <div data-testid="line">{clusterIds.join(',')}</div>,
}));
vi.mock('../../charts/DonutChart', () => ({
  DonutChart: ({ segments }: { segments: Array<{ label: string; value: number }> }) => (
    <div data-testid="pie">{segments.map(s => `${s.label}=${s.value}`).join(',')}</div>
  ),
}));

const c = (cluster: number, counts: number[]): ClusterSummary => ({
  cluster, color: `#00000${cluster}`, counts, totalCount: counts.reduce((a, b) => a + b, 0),
});
const clusters = [c(0, [30]), c(1, [50]), c(2, [20])];

describe('cluster picks (pure)', () => {
  it('unions the selection over the panels and draws every cluster when nothing is picked', () => {
    const picked = pickedClusterIds({ a: new Set([1]), b: new Set([2]), other: new Set([0]) }, ['a', 'b']);
    expect([...picked].sort()).toEqual([1, 2]);
    expect(pickedClusterData(clusters, new Set()).map(x => x.cluster)).toEqual([0, 1, 2]);
    expect(pickedClusterData(clusters, picked).map(x => x.cluster)).toEqual([1, 2]);
    // A pick of hidden clusters only: still draw what is on show.
    expect(pickedClusterData(clusters, new Set([9])).map(x => x.cluster)).toEqual([0, 1, 2]);
    expect([...togglePick(new Set([1]), 1)]).toEqual([]);
    expect([...togglePick(new Set([1]), 2)]).toEqual([1, 2]);
  });

  it('keeps every assigned read as the composition denominator', () => {
    const one = compositionProportions(clusters, [clusters[1]], 1);
    expect(one.datasetTotals).toEqual([100]);
    expect(one.proportions.get(1)).toEqual([0.5]);
    expect(one.clusterIds).toEqual([1]);
    expect(one.comparisonClusterIds).toEqual([0, 1, 2]);
    expect(compositionPieSegments(clusters, [clusters[1]], 0).map(s => [s.label, s.value]))
      .toEqual([['C1', 50], ['Other clusters', 50]]);
  });

  it('says what each V-plot mode shows', () => {
    expect(vplotModeCaption('span', true)).toMatch(/Full footprint.*every position it covers.*enriched/);
    expect(vplotModeCaption('midpoint', false)).toMatch(/Midpoint.*centre.*count/);
  });
});

describe('cluster charts render', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    useBrowserStore.setState({ selectedClusters: {} });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useBrowserStore.setState({ selectedClusters: {} });
  });
  const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const button = (name: string) => [...container.querySelectorAll('button')].find(b => b.textContent === name) as HTMLButtonElement;

  it('shows the Composition bars with one dataset and toggles Bar / Pie (Line needs two datasets)', () => {
    act(() => root.render(
      <CompositionTabContent datasetIds={['napa']} multiDs={false} visibleClusterData={clusters}
        allClusterData={clusters} chartWidth={300} getDatasetLabel={() => 'napa_ddda'} />,
    ));
    expect(q('cluster-composition')?.dataset.compositionMode).toBe('bar');
    expect(q('bar')?.textContent).toBe('napa_ddda:0=0.30,1=0.50,2=0.20');
    expect(button('Line').disabled).toBe(true);
    act(() => button('Pie').click());
    expect(q('bar')).toBeNull();
    expect(q('pie')?.textContent).toBe('C0=30,C1=50,C2=20');
  });

  it('offers Lines with two datasets', () => {
    const two = [c(0, [30, 10]), c(1, [70, 30])];
    act(() => root.render(
      <CompositionTabContent datasetIds={['a', 'b']} multiDs visibleClusterData={two}
        allClusterData={two} chartWidth={300} getDatasetLabel={sk => sk} />,
    ));
    expect(button('Line').disabled).toBe(false);
    act(() => button('Line').click());
    expect(q('line')?.textContent).toBe('0,1');
  });

  it('a name clicked in Profiles picks that cluster for every chart and the read panel', () => {
    const profiles = { ds: { 0: { nuc: [1, 2] }, 1: { nuc: [2, 1] }, 2: { nuc: [3, 3] } } };
    act(() => root.render(
      <ProfilesTabContent datasetIds={['ds']} multiDs={false} visibleClusterData={clusters}
        clusterProfiles={profiles} enabledMetaProfiles={{ nuc: true }} chartWidth={300}
        isReversed={false} getDatasetLabel={sk => sk} getDatasetColor={() => '#000'} />,
    ));
    expect(q('profile')?.textContent).toBe('C0,C1,C2');
    act(() => q('profiles-picks-chip-1')!.click());
    expect(q('profile')?.textContent).toBe('C1');
    expect([...useBrowserStore.getState().selectedClusters.ds!]).toEqual([1]);
    act(() => q('profiles-picks-chip-2')!.click());
    expect(q('profile')?.textContent).toBe('C1,C2');
    // Clicking a picked name unpicks it; All shows every cluster again.
    act(() => q('profiles-picks-chip-1')!.click());
    expect(q('profile')?.textContent).toBe('C2');
    act(() => q('profiles-picks-all')!.click());
    expect(q('profile')?.textContent).toBe('C0,C1,C2');
    expect(useBrowserStore.getState().selectedClusters.ds).toBeUndefined();
  });

  it('says when the picked clusters are all hidden and keeps All available', () => {
    useBrowserStore.getState().setClusterSelection('ds', [7]);
    const profiles = { ds: { 0: { nuc: [1, 2] }, 1: { nuc: [2, 1] } } };
    act(() => root.render(
      <ProfilesTabContent datasetIds={['ds']} multiDs={false} visibleClusterData={clusters.slice(0, 2)}
        clusterProfiles={profiles} enabledMetaProfiles={{ nuc: true }} chartWidth={300}
        isReversed={false} getDatasetLabel={sk => sk} getDatasetColor={() => '#000'} />,
    ));
    expect(q('profile')?.textContent).toBe('C0,C1');
    expect(q('profiles-picks')?.textContent).toContain('picked clusters are hidden');
    expect((q('profiles-picks-all') as HTMLButtonElement).disabled).toBe(false);
    act(() => q('profiles-picks-all')!.click());
    expect(useBrowserStore.getState().selectedClusters.ds).toBeUndefined();
  });

  it('follows a cluster picked elsewhere (the read panel) in Composition and the V-plot', () => {
    useBrowserStore.getState().setClusterSelection('ds', [2]);
    act(() => root.render(
      <CompositionTabContent datasetIds={['ds']} multiDs={false} visibleClusterData={clusters}
        allClusterData={clusters} chartWidth={300} getDatasetLabel={() => 'ds'} />,
    ));
    expect(q('bar')?.textContent).toBe('ds:2=0.20');
    act(() => root.unmount());
    root = createRoot(container);
    const noop = () => {};
    const vp = { matrix: [[1]], size_min: 10, size_max: 300, size_bin: 10, pos_bin: 10 } as any;
    const setMode = vi.fn();
    const setRowNorm = vi.fn();
    act(() => root.render(
      <VPlotTabContent
        vplotData={{ ds: { 0: vp, 1: vp, 2: vp } }}
        vplotLoading={false} showVplotSettings={false} setShowVplotSettings={noop} vplotSettingsSummary=""
        vplotSizeBin={10} setVplotSizeBin={noop} vplotPosBin={10} setVplotPosBin={noop}
        vplotSizeMin={10} setVplotSizeMin={noop} vplotSizeMax={300} setVplotSizeMax={noop}
        vplotLog setVplotLog={noop} vplotSmooth={1} setVplotSmooth={noop}
        vplotNormalize="per_cluster" setVplotNormalize={noop} vplotLayer={null} setVplotLayer={noop}
        vplotMode="midpoint" setVplotMode={setMode} vplotRowNormalize={false} setVplotRowNormalize={setRowNorm}
        start={0} end={100} datasetIds={['ds']} multiDs={false} visibleClusterData={clusters}
        chartWidth={300} getDatasetLabel={sk => sk} getDatasetColor={() => '#000'}
      />,
    ));
    expect([...container.querySelectorAll('[data-testid="vplot"]')].map(e => e.textContent)).toEqual(['vplot_midpoint_c2']);
    // The toggle asks for the full-footprint plot (counts; per-size-row enrichment is a setting).
    act(() => button('Full footprint').click());
    expect(setMode).toHaveBeenCalledWith('span');
    expect(setRowNorm).not.toHaveBeenCalled();
    expect(q('vplot-caption')?.textContent).toMatch(/Midpoint/);
  });
});
