/**
 * The cluster metaprofile cards draw the set's full legend: a layer one cluster lacks stays in that card's legend
 * (hollow, "no <layer> in this cluster"), so every card's legend is the same and the plot areas line up.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { OverviewTabContent, type ClusterSummary } from './OverviewTabContent';
import { ProfilesTabContent } from './ProfilesTabContent';
import { drawOverlayProfile } from '../../charts/OverlayProfileChart';
import { fullSetLegend } from '../../../utils/plotSetLegend';
import { channelLabel } from '../../../utils/clusterViewChannels';
import { getLayerColor } from '../../../utils/layerColors';
import { registerLayerColours, setLayerColorOverride } from '../../../features/layerColours/state';

registerLayerColours();

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** A 2D context that measures labels at 5 px a character and records the plot clip and the legend swatches. */
function fakeContext() {
  const clips: { x: number; w: number }[] = [];
  const filled: { x: number; color: string }[] = [];
  const hollow: { x: number; color: string }[] = [];
  const ctx: any = {
    fillStyle: '', strokeStyle: '', font: '', textAlign: 'left', textBaseline: '', lineWidth: 1, globalAlpha: 1,
    clearRect() {}, beginPath() {}, closePath() {}, fill() {}, stroke() {}, save() {}, restore() {}, translate() {}, rotate() {},
    setLineDash() {}, setTransform() {}, moveTo() {}, lineTo() {}, clip() {}, fillText() {},
    rect(x: number, _y: number, w: number) { clips.push({ x, w }); },
    fillRect(x: number, _y: number, w: number, h: number) { if (w === 8 && h === 8) filled.push({ x, color: ctx.fillStyle }); },
    strokeRect(x: number) { hollow.push({ x, color: ctx.strokeStyle }); },
    measureText(text: string) { return { width: text.length * 5 }; },
  };
  return { ctx: ctx as CanvasRenderingContext2D, clips, filled, hollow };
}

const flat = (v: number, n = 40) => Array.from({ length: n }, () => v);
const clusters: ClusterSummary[] = [
  { cluster: 0, color: '#ef4444', counts: [10], totalCount: 10 },
  { cluster: 1, color: '#14b8a6', counts: [12], totalCount: 12 },
  { cluster: 2, color: '#6366f1', counts: [14], totalCount: 14 },
];
// Cluster 0 has no accessibility (msp) profile; the others have both channels.
const combined: Record<number, Record<string, number[]>> = {
  0: { nuc: flat(0.4) },
  1: { nuc: flat(0.5), msp: flat(0.3) },
  2: { nuc: flat(0.6), msp: flat(0.2) },
};

describe('drawOverlayProfile with a set legend', () => {
  it('keeps the plot the same width whichever entries have data, and draws a missing one hollow', () => {
    const items = (missing: boolean) => fullSetLegend(
      [{ key: 'nuc', label: 'Nuc', color: '#16a34a' }, { key: 'msp', label: 'Accessibility', color: '#ea580c' }],
      k => !(missing && k === 'msp'), l => `no ${l} in this cluster`);
    const both = fakeContext();
    drawOverlayProfile(both.ctx, 300, 36, [{ label: 'Nuc', color: '#16a34a', data: flat(1) }, { label: 'Accessibility', color: '#ea580c', data: flat(2) }],
      true, false, undefined, undefined, true, undefined, undefined, undefined, false, items(false));
    const one = fakeContext();
    drawOverlayProfile(one.ctx, 300, 36, [{ label: 'Nuc', color: '#16a34a', data: flat(1) }],
      true, false, undefined, undefined, true, undefined, undefined, undefined, false, items(true));
    expect(one.clips).toEqual(both.clips);
    expect(both.filled.map(f => f.color)).toEqual(['#16a34a', '#ea580c']);
    expect(one.filled.map(f => f.color)).toEqual(['#16a34a']);
    expect(one.hollow).toEqual([{ x: expect.any(Number), color: '#ea580c' }]);
    // Without a set legend, a single series still draws no legend and takes the whole width (unchanged).
    const bare = fakeContext();
    drawOverlayProfile(bare.ctx, 300, 36, [{ label: 'Nuc', color: '#16a34a', data: flat(1) }], true, false, undefined, undefined, true, undefined);
    expect(bare.filled).toHaveLength(0);
    expect(bare.clips[0].w).toBeGreaterThan(one.clips[0].w);
  });
});

describe('cluster cards with a layer one cluster lacks', () => {
  let container: HTMLDivElement;
  let root: Root;
  let drawn: ReturnType<typeof fakeContext>;

  beforeEach(() => {
    localStorage.clear();
    drawn = fakeContext();
    const { ctx } = drawn;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ctx) as any);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({ _historyStack: [], _historyFuture: [], _historyBaseline: null } as any);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    setLayerColorOverride('msp', null);
    container.remove();
    vi.restoreAllMocks();
  });

  const geometry = (cards: Element[]) => cards.map(card => {
    const chart = card.querySelector('[data-plot-left]') as HTMLElement;
    expect(chart).toBeTruthy();
    return { legend: chart.dataset.legend, left: chart.dataset.plotLeft, width: chart.dataset.plotWidth };
  });

  const renderOverview = () => act(async () => {
      root.render(
        <OverviewTabContent
          clusterData={clusters}
          datasetIds={['ds1']}
          multiDs={false}
          clusterFocus={{}}
          setClusterFocus={vi.fn()}
          clusterOrder={{ ds1: [0, 1, 2] }}
          setClusterOrder={vi.fn()}
          selectedClusters={{}}
          setClusterSelection={vi.fn()}
          toggleClusterSelection={vi.fn()}
          clearClusterSelection={vi.fn()}
          mergeSelectedClusters={vi.fn(() => 0)}
          combinedProfiles={combined}
          enabledMetaProfiles={{ nuc: true, msp: true }}
          proportions={null}
          chartWidth={300}
          containerWidth={300}
          profileHeight={36}
          isReversed={false}
          dissolving={null}
          onDissolve={vi.fn()}
          getDatasetLabel={id => id}
        />,
      );
    });

  it('Overview: every card draws the same full legend and the same plot area', async () => {
    await renderOverview();
    const cards = Array.from(container.querySelectorAll('[data-testid="cluster-overview-profile"]'));
    expect(cards.map(c => c.getAttribute('data-cluster'))).toEqual(['0', '1', '2']);
    const g = geometry(cards);
    expect(g[0].legend).toBe(`${channelLabel('nuc')}|${channelLabel('msp')}`);
    expect(new Set(g.map(x => x.legend)).size).toBe(1);
    expect(new Set(g.map(x => `${x.left}:${x.width}`)).size).toBe(1);
    // The lacking card marks the layer (hover note); the others mark nothing.
    const missing = cards.map(c => Array.from(c.querySelectorAll('[data-testid="plot-legend-missing"]')).map(m => m.getAttribute('title')));
    expect(missing).toEqual([[`no ${channelLabel('msp')} in this cluster`], [], []]);
    expect(cards.map(c => c.querySelectorAll('[data-testid="plot-legend-item"]').length)).toEqual([1, 2, 2]);
  });

  it('Overview: the legend takes its colours from the layer colour resolver (a user colour applies, hollow too)', async () => {
    act(() => { setLayerColorOverride('msp', '#123456'); });
    expect(getLayerColor('msp')).toBe('#123456');
    await renderOverview();
    expect(drawn.hollow.map(h => h.color)).toContain('#123456');
    expect(drawn.filled.map(f => f.color)).toContain('#123456');
  });

  it('Profiles: a channel chart missing a cluster keeps every cluster in its legend', async () => {
    const profiles = { ds1: combined };
    await act(async () => {
      root.render(
        <ProfilesTabContent
          datasetIds={['ds1']}
          multiDs={false}
          visibleClusterData={clusters}
          clusterProfiles={profiles}
          enabledMetaProfiles={{ nuc: true, msp: true }}
          chartWidth={300}
          isReversed={false}
          getDatasetLabel={id => id}
          getDatasetColor={() => '#000000'}
        />,
      );
    });
    const charts = Array.from(container.querySelectorAll('[data-testid="cluster-profile-chart"]'));
    expect(charts.map(c => c.getAttribute('data-layer'))).toEqual(['nuc', 'msp']);
    // data-series stays "the clusters drawn"; the legend is every cluster on show.
    expect(charts.map(c => c.getAttribute('data-series'))).toEqual(['C0,C1,C2', 'C1,C2']);
    const g = geometry(charts);
    expect(g[0].legend).toBe('C0|C1|C2');
    expect(new Set(g.map(x => x.legend)).size).toBe(1);
    expect(new Set(g.map(x => `${x.left}:${x.width}`)).size).toBe(1);
    expect(charts[1].querySelector('[data-testid="plot-legend-missing"]')?.getAttribute('title')).toBe(`no ${channelLabel('msp')} in this cluster`);
  });
});
