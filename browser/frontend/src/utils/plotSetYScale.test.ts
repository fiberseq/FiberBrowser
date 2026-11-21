import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PLOT_SET_Y_SCALE, baselineReference, domainOf, enrichProfile, flankMean, isDefaultPlotSetYScale, meanOf,
  normalizePlotSetYScale, plotSetDomains, pooledProfile, sharedGroupKey, valueAxisLabel, yScaleSummary,
  type PlotSetMember, type PlotSetYScale,
} from './plotSetYScale';
import {
  averageBaselines, baselineNote, channelBaseline, clusterAxisLabel, clusterRefLine, clusterShownValues,
  coveredExtent, datasetChannelProfile, overviewBaseline,
} from '../components/controls/cluster-detail/clusterYScale';
import { normalizeOverlay } from '../features/hub/overlayTypes';
import { signalProfileTop } from '../components/charts/SignalProfileChart';
import { DEFAULT_CLUSTER_VIEW_SETTINGS, normalizeClusterViewSettings } from './clusterViewSettings';
import { REG_SCORE_CHANNEL, PATCH_SHARE_CHANNEL } from './clusterViewChannels';
import { useBrowserStore } from '../stores/browserStore';
import { serializeState } from '../stores/historySlice';

const s = (patch: Partial<PlotSetYScale> = {}): PlotSetYScale => ({ ...DEFAULT_PLOT_SET_Y_SCALE, ...patch });
const member = (id: string, dataset: string, channel: string, values: number[][], reads?: number[], unit = 'fraction'): PlotSetMember => ({
  id, dataset, channel, unit, series: values.map((v, i) => ({ values: v, reads: reads?.[i] })),
});

describe('settings', () => {
  it('default to today\'s look: own y per plot, raw values', () => {
    expect(DEFAULT_PLOT_SET_Y_SCALE).toMatchObject({ mode: 'perPlot', value: 'raw', baseline: 'region', form: 'percent', scope: 'dataset' });
    expect(isDefaultPlotSetYScale(normalizePlotSetYScale(undefined))).toBe(true);
  });
  it('normalise malformed and partial values field by field', () => {
    const n = normalizePlotSetYScale({ mode: 'shared', value: 'bogus', baseline: 'flank', form: 'log2', scope: 'all', flankFraction: 9, minBaselineFraction: -1, smallReads: 3.6 });
    expect(n).toMatchObject({ mode: 'shared', value: 'raw', baseline: 'flank', form: 'log2', scope: 'all', flankFraction: 0.45, minBaselineFraction: 0, smallReads: 4 });
    expect(normalizePlotSetYScale('nonsense')).toEqual(DEFAULT_PLOT_SET_Y_SCALE);
  });
});

describe('shared vs per-plot ranges', () => {
  const members = [
    member('a:nuc', 'a', 'nuc', [[0.1, 0.4], [0.2, 0.3]]),
    member('a:m6a', 'a', 'm6a', [[0.05, 0.1]]),
    member('b:nuc', 'b', 'nuc', [[0.2, 0.8]]),
  ];
  it('per plot: each plot its own max (holding 0)', () => {
    const d = plotSetDomains(members, s());
    expect(d.byId['a:nuc']).toEqual({ min: 0, max: 0.4 });
    expect(d.byId['a:m6a']).toEqual({ min: 0, max: 0.1 });
    expect(d.byId['b:nuc']).toEqual({ min: 0, max: 0.8 });
  });
  it('shared per dataset: one range per channel within a dataset', () => {
    const d = plotSetDomains([...members, member('a:nuc2', 'a', 'nuc', [[0.6]])], s({ mode: 'shared' }));
    expect(d.byId['a:nuc']).toEqual({ min: 0, max: 0.6 });
    expect(d.byId['a:nuc2']).toEqual({ min: 0, max: 0.6 });
    expect(d.byId['b:nuc']).toEqual({ min: 0, max: 0.8 });
    expect(d.byId['a:m6a']).toEqual({ min: 0, max: 0.1 });
  });
  it('shared across all datasets', () => {
    const d = plotSetDomains(members, s({ mode: 'shared', scope: 'all' }));
    expect(d.byId['a:nuc']).toEqual({ min: 0, max: 0.8 });
    expect(d.byId['a:m6a']).toEqual({ min: 0, max: 0.1 });
  });
  it('shared across channels of one unit, never across units', () => {
    const d = plotSetDomains([...members, member('a:reg', 'a', REG_SCORE_CHANNEL, [[-1, 2]], undefined, 'log2 score')],
      s({ mode: 'shared', shareChannels: true }));
    expect(d.byId['a:m6a']).toEqual({ min: 0, max: 0.4 });
    expect(d.byId['a:reg']).toEqual({ min: -1, max: 2 });
    expect(sharedGroupKey({ dataset: 'a', channel: 'nuc', unit: 'fraction' }, { scope: 'all', shareChannels: true })).toBe('unit:fraction');
  });
  it('series from few reads are drawn but do not set a shared range (unless every series is small)', () => {
    const d = plotSetDomains([member('x', 'a', 'nuc', [[0.2], [5]], [100, 2]), member('y', 'a', 'nuc', [[0.3]], [50])], s({ mode: 'shared', smallReads: 5 }));
    expect(d.byId.x.max).toBe(0.3);
    const allSmall = plotSetDomains([member('x', 'a', 'nuc', [[0.2], [5]], [1, 2])], s({ mode: 'shared', smallReads: 5 }));
    expect(allSmall.byId.x.max).toBe(5);
  });
  it('domains ignore gaps and fall back to 0..1 when there is nothing', () => {
    expect(domainOf([[NaN, Infinity]])).toEqual({ min: 0, max: 1 });
    expect(domainOf([[-2, NaN, 1]])).toEqual({ min: -2, max: 1 });
  });
});

describe('enrichment maths', () => {
  it('per-position baseline, as % / ratio / log2', () => {
    expect(enrichProfile([0.2, 0.5], [0.4, 0.5], 'percent').values).toEqual([50, 100]);
    expect(enrichProfile([0.2, 0.5], [0.4, 0.5], 'ratio').values).toEqual([0.5, 1]);
    expect(enrichProfile([0.2, 1], [0.4, 0.5], 'log2').values).toEqual([-1, 1]);
    expect(baselineReference('percent')).toBe(100);
    expect(baselineReference('ratio')).toBe(1);
    expect(baselineReference('log2')).toBe(0);
  });
  it('scalar baseline', () => {
    expect(enrichProfile([0.1, 0.3], 0.2, 'percent').values.map(v => +v.toFixed(9))).toEqual([50, 150]);
  });
  it('zero, missing and empty baselines leave gaps, never divide by zero', () => {
    const z = enrichProfile([0.2, 0.3, 0.4], [0, NaN, 0.5], 'percent');
    expect(Number.isNaN(z.values[0])).toBe(true);
    expect(Number.isNaN(z.values[1])).toBe(true);
    expect(z.values[2]).toBe(80);
    expect(z.gaps).toBe(2);
    expect(z.emptyBaseline).toBe(false);
    for (const base of [0, null, undefined, [0, 0], [] as number[]]) {
      const e = enrichProfile([0.2, 0.3], base as number[] | number | null, 'ratio');
      expect(e.values.every(v => Number.isNaN(v))).toBe(true);
      expect(e.emptyBaseline).toBe(true);
    }
  });
  it('a baseline below the minimum share of its maximum is a gap', () => {
    const e = enrichProfile([0.01, 0.5], [0.001, 0.5], 'percent', 0.01);
    expect(Number.isNaN(e.values[0])).toBe(true);
    expect(e.values[1]).toBe(100);
  });
  it('zero signal on a valid baseline is 0% but a log2 gap', () => {
    expect(enrichProfile([0], [0.5], 'percent').values[0]).toBe(0);
    expect(Number.isNaN(enrichProfile([0], [0.5], 'log2').values[0])).toBe(true);
  });
  it('flank mean and pooled profile', () => {
    expect(flankMean([1, 0, 0, 0, 0, 0, 0, 0, 0, 3], 0.1)).toBe(2);
    expect(flankMean([], 0.1)).toBeNull();
    expect(meanOf([NaN, 2, 4])).toBe(3);
    expect(pooledProfile([{ data: [0.2, NaN], weight: 3 }, { data: [0.6, 0.4], weight: 1 }]).map(v => +v.toFixed(9))).toEqual([0.3, 0.4]);
    expect(pooledProfile([])).toEqual([]);
  });
});

describe('cluster baselines', () => {
  const dp = { mod: [0.1, 0.1], fire: [], rules: {}, layers: { footprint: [0.4, 0.2], tf: [0.1, 0.3] } };
  it('region baseline = the dataset metaprofile (footprint serves nuc)', () => {
    expect(datasetChannelProfile(dp, 'nuc')).toEqual([0.4, 0.2]);
    expect(datasetChannelProfile(dp, 'mod')).toEqual([0.1, 0.1]);
    const b = channelBaseline('nuc', dp, []);
    expect(b).toMatchObject({ region: [0.4, 0.2], pooledFromClusters: false });
    expect(b.datasetMean).toBeCloseTo(0.3);
    const shown = clusterShownValues('nuc', [0.8, 0.1], s({ value: 'enrichment' }), b);
    expect(shown.enriched).toBe(true);
    expect(shown.values).toEqual([200, 50]);
  });
  it('dataset baseline = the region mean; flank = the plot\'s own flanks', () => {
    const b = channelBaseline('nuc', dp, []);
    expect(clusterShownValues('nuc', [0.3, 0.6], s({ value: 'enrichment', baseline: 'dataset', form: 'ratio' }), b).values.map(v => +v.toFixed(6))).toEqual([1, 2]);
    expect(clusterShownValues('nuc', [0.2, 0.9, 0.9, 0.2], s({ value: 'enrichment', baseline: 'flank', flankFraction: 0.25 }), b).values).toEqual([100, 450, 450, 100]);
  });
  it('a channel the metaprofile lacks pools the clusters by their reads', () => {
    const b = channelBaseline(PATCH_SHARE_CHANNEL, dp, [{ data: [0.1, 0.2], reads: 3 }, { data: [0.5, 0.6], reads: 1 }]);
    expect(b.pooledFromClusters).toBe(true);
    expect(b.region!.map(v => +v.toFixed(6))).toEqual([0.2, 0.3]);
    const none = channelBaseline(PATCH_SHARE_CHANNEL, null, []);
    expect(none.region).toBeNull();
    const shown = clusterShownValues(PATCH_SHARE_CHANNEL, [0.2], s({ value: 'enrichment' }), none);
    expect(shown.emptyBaseline).toBe(true);
    expect(baselineNote([shown], s({ value: 'enrichment' }))).toMatch(/Baseline empty/);
  });
  it('across-dataset average for the Overview cards', () => {
    const avg = averageBaselines([
      { region: [0.2, 0.4], datasetMean: 0.3, pooledFromClusters: false },
      { region: [0.4, 0.6], datasetMean: 0.5, pooledFromClusters: false },
    ]);
    expect(avg.region!.map(v => +v.toFixed(6))).toEqual([0.3, 0.5]);
    expect(avg.datasetMean).toBeCloseTo(0.4);
  });
  it('regularity stays raw, with its own label and no reference line', () => {
    const on = s({ value: 'enrichment' });
    const shown = clusterShownValues(REG_SCORE_CHANNEL, [-1, 2], on, { region: [1, 1], datasetMean: 1, pooledFromClusters: false });
    expect(shown).toMatchObject({ enriched: false, values: [-1, 2] });
    expect(clusterAxisLabel(REG_SCORE_CHANNEL, on, 'Regularity score')).toBe('Regularity score');
    expect(clusterRefLine(REG_SCORE_CHANNEL, on)).toBeUndefined();
    expect(clusterAxisLabel('nuc', on, 'Nucleosome')).toBe('% of region baseline');
    expect(clusterRefLine('nuc', on)).toBe(100);
  });
});

describe('covered extent (positions no read covers are 0 in a metaprofile)', () => {
  it('is where any channel is above zero', () => {
    expect(coveredExtent({ nuc: [0, 0, 0.5, 0.2, 0], tf: [0, 0.1, 0, 0, 0] })).toEqual([1, 3]);
    expect(coveredExtent({ nuc: [0, 0] })).toBeNull();
  });
  it('the flank is taken inside it and enriched values outside it are gaps', () => {
    const data = [0, 0, 0.2, 0.8, 0.8, 0.2, 0];
    const shown = clusterShownValues('nuc', data, s({ value: 'enrichment', baseline: 'flank', flankFraction: 0.25 }),
      { region: null, datasetMean: null, pooledFromClusters: false }, coveredExtent({ nuc: data }));
    expect(shown.values.slice(2, 6)).toEqual([100, 400, 400, 100]);
    expect([0, 1, 6].every(i => Number.isNaN(shown.values[i]))).toBe(true);
  });
  it('the dataset mean leaves uncovered positions out', () => {
    const b = channelBaseline('nuc', { mod: [], fire: [], rules: {}, layers: { footprint: [0, 0.2, 0.4, 0] } }, []);
    expect(b.datasetMean).toBeCloseTo(0.3);
  });
});

describe('Overview card baselines', () => {
  it('a channel no metaprofile carries (patch share) pools the cards by their reads', () => {
    const dp = { mod: [], fire: [], rules: {}, layers: { footprint: [0.4, 0.2] } };
    const b = overviewBaseline(PATCH_SHARE_CHANNEL, [dp, dp], [{ data: [0.1, 0.2], reads: 3 }, { data: [0.5, 0.6], reads: 1 }]);
    expect(b.pooledFromClusters).toBe(true);
    expect(b.region!.map(v => +v.toFixed(6))).toEqual([0.2, 0.3]);
    const shown = clusterShownValues(PATCH_SHARE_CHANNEL, [0.4, 0.3], s({ value: 'enrichment' }), b);
    expect(shown.emptyBaseline).toBe(false);
    expect(shown.values.map(v => +v.toFixed(6))).toEqual([200, 100]);
  });
  it('a layer channel averages the datasets\' metaprofiles', () => {
    const b = overviewBaseline('nuc', [{ mod: [], fire: [], rules: {}, layers: { footprint: [0.2, 0.4] } }, { mod: [], fire: [], rules: {}, layers: { footprint: [0.4, 0.6] } }], []);
    expect(b.region!.map(v => +v.toFixed(6))).toEqual([0.3, 0.5]);
  });
});

describe('other plot sets', () => {
  it('Hub overlay state keeps a saved y scale and omits it when absent', () => {
    expect(normalizeOverlay({ view: 'facets', yScale: { mode: 'shared' } }).yScale).toMatchObject({ mode: 'shared', value: 'raw' });
    expect('yScale' in normalizeOverlay({ view: 'facets' })).toBe(false);
  });
  it('peak profiles: a plot\'s own top holds the thresholds; the shared top is the largest', () => {
    const thresholds: [number, number, number, number] = [0.5, 0.4, 0.3, 0.2];
    expect(signalProfileTop([0.1, 0.2], thresholds)).toBeCloseTo(0.55);
    expect(signalProfileTop([0.1, 0.9], thresholds)).toBe(0.9);
    expect(Math.max(...[[0.1, 0.2], [0.1, 0.9]].map(sig => signalProfileTop(sig, thresholds)))).toBe(0.9);
  });
});

describe('labels', () => {
  it('say the mode', () => {
    expect(valueAxisLabel(s(), 'Fraction')).toBe('Fraction');
    expect(valueAxisLabel(s({ value: 'enrichment' }), 'Fraction')).toBe('% of region baseline');
    expect(valueAxisLabel(s({ value: 'enrichment', baseline: 'flank', form: 'ratio' }), 'x')).toBe('ratio to own flank mean');
    expect(valueAxisLabel(s({ value: 'enrichment', baseline: 'dataset', form: 'log2' }), 'x')).toBe('log2 vs dataset mean');
    expect(yScaleSummary(s({ mode: 'shared' }), 'fraction')).toBe('Shared y (per dataset) · fraction');
    expect(yScaleSummary(s(), 'fraction')).toBe('Own y per plot · fraction');
  });
});

describe('session round-trip', () => {
  beforeEach(() => useBrowserStore.setState({ clusterViewSettings: DEFAULT_CLUSTER_VIEW_SETTINGS }));
  it('cluster view settings carry the y scale through the session and undo snapshots', async () => {
    const chosen = s({ mode: 'shared', value: 'enrichment', baseline: 'flank', form: 'log2', scope: 'all' });
    useBrowserStore.getState().setClusterViewSettings({ yScale: chosen });
    expect(serializeState(useBrowserStore.getState()).clusterViewSettings?.yScale).toEqual(chosen);
    const { applyImportedState, collectFrontendState } = await import('../api/session');
    const frontend = JSON.parse(JSON.stringify(collectFrontendState()));
    useBrowserStore.setState({ clusterViewSettings: DEFAULT_CLUSTER_VIEW_SETTINGS });
    applyImportedState({ datasets: [], overlays: [], has_fasta: false, frontend, viewport: { chrom: 'chr1', start: 1, end: 2 } });
    expect(useBrowserStore.getState().clusterViewSettings.yScale).toEqual(chosen);
  });
  it('older sessions (no yScale) load with the defaults', async () => {
    expect(normalizeClusterViewSettings({ profileChannels: ['nuc'], mapColorBy: 'cluster' }).yScale).toEqual(DEFAULT_PLOT_SET_Y_SCALE);
    const { applyImportedState } = await import('../api/session');
    useBrowserStore.getState().setClusterViewSettings({ yScale: s({ mode: 'shared' }) });
    applyImportedState({ datasets: [], overlays: [], has_fasta: false, frontend: { clusterViewSettings: { profileChannels: null, mapColorBy: 'cluster' } }, viewport: { chrom: 'chr1', start: 1, end: 2 } });
    expect(useBrowserStore.getState().clusterViewSettings.yScale).toEqual(DEFAULT_PLOT_SET_Y_SCALE);
  });
});
