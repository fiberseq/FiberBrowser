import { describe, expect, it } from 'vitest';
import type { CompactRead } from '../components/tracks/read-track/types';
import {
  GEOMETRY_NONE_COLOR, MAP_COLOR_GEOMETRY, PATCH_SHARE_CHANNEL, REG_PERIOD_CHANNEL, REG_SCORE_CHANNEL, channelLabel,
  channelPayloadLayer, clusterProfileChannelOptions, clusterViewPayloadLayers,
  layerStateAt, mapColorOptions, mapPointColors, resampleTrack, resolveProfileChannels, summarizeMolecule, PATCH_SHARE_LOW_CHANNEL, MAP_COLOR_GEOMETRY_LOW } from './clusterViewChannels';
import { DEFAULT_CLUSTER_VIEW_SETTINGS, normalizeClusterViewSettings } from './clusterViewSettings';
import { nucGeoColor, nucRegScoreFromByte } from './nucLayers';

const read = (over: Partial<CompactRead> = {}): CompactRead => ({
  id: 'r1',
  intervals: [[0, 1000, -1]],
  ...over,
});

describe('metaprofile channels', () => {
  it('come from the layer registry, drop per-call/tile/scalar groups, and add regularity for BAM data', () => {
    const opts = clusterProfileChannelOptions([{
      data_type: 'bam',
      available_layers: { nuc: true, tf: true, msp: true, m6a: true, nucsz: true, nucseg: true, nucreg: true, nucmol: true, nucpatch: true },
    }]);
    const keys = opts.map(o => o.key);
    expect(keys.slice(0, 4)).toEqual(['nuc', 'tf', 'fire', 'm6a']);
    // A layer added later (a scan's custom layer) appears without a code change.
    const custom = clusterProfileChannelOptions([{ data_type: 'bam', available_layers: { nuc: true, myscan: true } as never }]).map(o => o.key);
    expect(custom).toContain('myscan');
    // nucpatch is drawn on its own canvas from the geometry analysis: not a presence channel, but Patch share is.
    for (const k of ['nucsz', 'nucseg', 'nucreg', 'nucmol', 'nucpatch', 'msp']) expect(keys).not.toContain(k);
    expect(keys.slice(-4)).toEqual([REG_SCORE_CHANNEL, REG_PERIOD_CHANNEL, PATCH_SHARE_CHANNEL, PATCH_SHARE_LOW_CHANNEL]);
    expect(channelLabel(PATCH_SHARE_CHANNEL)).toBe('High patch share');
    expect(channelLabel(PATCH_SHARE_LOW_CHANNEL)).toBe('Low patch share');
    expect(channelPayloadLayer(PATCH_SHARE_CHANNEL)).toBeNull();
    expect(channelPayloadLayer(PATCH_SHARE_LOW_CHANNEL)).toBeNull();
  });

  it('offer no regularity for table-only (BigBed) data', () => {
    const keys = clusterProfileChannelOptions([{ data_type: 'bigbed', available_layers: { nuc: true } }]).map(o => o.key);
    expect(keys).toEqual(['nuc']);
  });

  it('default to the metaprofile layers enabled in Tracks, in their order', () => {
    const enabled = { nuc: true, fire: false, m6a: true };
    expect(resolveProfileChannels(null, enabled)).toEqual(['nuc', 'm6a']);
    expect(resolveProfileChannels([], enabled)).toEqual(['nuc', 'm6a']);
    expect(resolveProfileChannels(['tf', REG_SCORE_CHANNEL], enabled)).toEqual(['tf', REG_SCORE_CHANNEL]);
    expect(channelLabel(REG_PERIOD_CHANNEL)).toBe('Regularity period');
  });

  it('ask the reads for nothing extra with the defaults', () => {
    expect(clusterViewPayloadLayers(DEFAULT_CLUSTER_VIEW_SETTINGS)).toEqual([]);
    expect(clusterViewPayloadLayers({ profileChannels: ['tf', REG_SCORE_CHANNEL, 'nuc'], mapColorBy: 'cluster' })).toEqual(['nuc', 'tf']);
    // Regularity colours come from /api/nuc/regularity (per molecule), never a tile refetch.
    expect(clusterViewPayloadLayers({ profileChannels: null, mapColorBy: 'reg.median' })).toEqual([]);
    expect(clusterViewPayloadLayers({ profileChannels: null, mapColorBy: 'm6a' })).toEqual([]);
    expect(clusterViewPayloadLayers({ profileChannels: null, mapColorBy: 'state' })).toEqual([]);
  });
});

describe('resampleTrack', () => {
  it('maps reference bins onto equal view bins and keeps missing bins as gaps', () => {
    // Bins 1000-1250 (2), 1250-1500 (none), 1500-1750 (4); view 1000-1750 in 6 bins.
    const out = resampleTrack([1000, 1250, 1500, 1750], [2, null, 4], 1000, 1750, 6);
    expect(out).toHaveLength(6);
    expect(out.slice(0, 2)).toEqual([2, 2]);
    expect(out.slice(4)).toEqual([4, 4]);
    expect(Number.isNaN(out[2]) && Number.isNaN(out[3])).toBe(true);
    // [5, null, 5] never becomes [5, 5, 5]
    expect(Number.isNaN(resampleTrack([0, 1, 2, 3], [5, null, 5], 0, 3, 3)[1])).toBe(true);
  });

  it('is empty without any value, and never extends past the track', () => {
    expect(resampleTrack([0, 10], [null], 0, 10, 4)).toEqual([]);
    const out = resampleTrack([100, 200], [5], 0, 400, 4);
    expect(out[1]).toBe(5);
    expect([out[0], out[2], out[3]].every(Number.isNaN)).toBe(true);
  });
});

describe('per-molecule summaries', () => {
  const regLayer = (scores: number[]) => ({
    intervals: scores.map((_, i) => [i * 250, (i + 1) * 250, 250] as [number, number, number]),
    qualities: [scores, scores.map(() => 90)],
  });

  it('give span, m6A per kb, layer shares in view and regularity median / max', () => {
    const r = read({
      intervals: [[0, 2000, -1]],
      methyl_m6a: [10, 20, 30, 40],
      layers: {
        nuc: { intervals: [[0, 500, 500], [600, 900, 300]] },
        tf: { intervals: [[520, 560, 40]] },
        msp: { intervals: [[1000, 1500, 500]] },
        nucsz: { intervals: [[0, 500, 500]] },
        nucreg: regLayer([100, 200, 150]),
      },
    });
    const s = summarizeMolecule(r, 1000);
    expect(s.span).toBe(2000);
    expect(s.m6aPerKb).toBeCloseTo(2);
    expect(s.frac.nuc).toBeCloseTo(0.8);
    expect(s.frac.tf).toBeCloseTo(0.04);
    expect(s.frac.fire ?? 0).toBe(0);
    expect(s.frac.nucsz).toBeUndefined();
    expect(s.regMedian).toBeCloseTo(nucRegScoreFromByte(150)!);
    expect(s.regMax).toBeCloseTo(nucRegScoreFromByte(200)!);
  });

  it('name the layer at a position (footprints first), a linker, or nothing off the read', () => {
    const r = read({
      intervals: [[100, 900, -1]],
      layers: { nuc: { intervals: [[100, 300, 200]] }, tf: { intervals: [[400, 420, 20]] }, msp: { intervals: [[500, 700, 200]] } },
    });
    expect(layerStateAt(r, 150)).toBe('nuc');
    expect(layerStateAt(r, 410)).toBe('tf');
    expect(layerStateAt(r, 600)).toBe('fire');
    expect(layerStateAt(r, 350)).toBe('linker');
    expect(layerStateAt(r, 50)).toBeNull();
  });
});

describe('map colours', () => {
  const summaries = new Map([
    ['a', { span: 1000, m6aPerKb: 10, frac: { nuc: 0.5 }, regMedian: 4, regMax: 5 }],
    ['b', { span: 3000, m6aPerKb: 30, frac: { nuc: 0.9 }, regMedian: null, regMax: null }],
  ]);
  const base = {
    readIds: ['a', 'b', 'c'],
    datasetIds: ['d1', 'd1', 'd2'],
    summaries: (_ds: string, rid: string) => summaries.get(rid),
    datasetColor: (ds: string) => (ds === 'd1' ? '#111111' : '#222222'),
    datasetLabel: (ds: string) => ds.toUpperCase(),
  };

  it('leave cluster colours to the map by default', () => {
    expect(mapPointColors('cluster', base)).toEqual({ colors: null, legend: { kind: 'none' } });
  });

  it('colour numbers on a ramp with missing values grey (null), and datasets by their colour', () => {
    const m6a = mapPointColors('m6a', base);
    expect(m6a.colors?.[0]).toMatch(/^rgb\(/);
    expect(m6a.colors?.[0]).not.toBe(m6a.colors?.[1]);
    expect(m6a.colors?.[2]).toBeNull();
    expect(m6a.legend).toMatchObject({ kind: 'ramp', missing: 1, min: 10, max: 30 });
    const reg = mapPointColors('reg.median', base);
    expect(reg.colors?.filter(Boolean)).toHaveLength(1);
    expect(reg.legend).toMatchObject({ kind: 'ramp', missing: 2 });
    const ds = mapPointColors('dataset', base);
    expect(ds.colors).toEqual(['#111111', '#111111', '#222222']);
    expect(ds.legend).toMatchObject({ kind: 'categories', items: [{ key: 'd1', count: 2 }, { key: 'd2', count: 1 }] });
  });

  it('colour the layer at a position by the layer colours', () => {
    const states = mapPointColors('state', { ...base, states: (_ds, rid) => ({ a: 'nuc', b: 'linker' } as Record<string, string>)[rid] ?? null });
    expect(states.colors?.[0]).toBe('#16a34a');
    expect(states.colors?.[2]).toBeNull();
    expect(states.legend).toMatchObject({ kind: 'categories', missing: 1 });
  });

  it('offer each loaded layer share', () => {
    const ids = mapColorOptions(['nuc', 'tf']).map(o => o.id);
    expect(ids[0]).toBe('cluster');
    expect(ids).toEqual(expect.arrayContaining(['dataset', 'reg.median', 'reg.max', 'frac:nuc', 'frac:tf', 'm6a', 'span', 'state']));
  });
});

describe('settings', () => {
  it('normalise stored values, falling back to the defaults', () => {
    expect(normalizeClusterViewSettings(undefined)).toEqual(DEFAULT_CLUSTER_VIEW_SETTINGS);
    expect(normalizeClusterViewSettings({ profileChannels: [] })).toEqual(DEFAULT_CLUSTER_VIEW_SETTINGS);
    expect(normalizeClusterViewSettings({ profileChannels: ['tf', 'tf', 3, 'nuc'], mapColorBy: 'reg.max', mapColorPos: 12.6, mapFeatureMode: 'nuc' }))
      .toEqual({ profileChannels: ['tf', 'nuc'], mapColorBy: 'reg.max', mapColorPos: 13, mapFeatureMode: 'nuc', yScale: DEFAULT_CLUSTER_VIEW_SETTINGS.yScale });
  });
});

describe('geometry carried (map colour)', () => {
  it('colours each molecule by its root geometry, grey for none, and leaves molecules without patches out', () => {
    expect(mapColorOptions([]).map(o => o.id)).toContain(MAP_COLOR_GEOMETRY);
    const groups: Record<string, number | null> = { a: 1, b: 2, c: 0, d: null };
    const out = mapPointColors(MAP_COLOR_GEOMETRY, {
      readIds: ['a', 'b', 'c', 'd'], datasetIds: ['x', 'x', 'x', 'x'],
      summaries: () => undefined, geometries: (_ds, rid) => groups[rid],
      datasetColor: () => undefined, datasetLabel: d => d,
    });
    expect(out.colors).toEqual([nucGeoColor(1), nucGeoColor(2), GEOMETRY_NONE_COLOR, null]);
    expect(out.legend).toMatchObject({ kind: 'categories', label: 'High-regularity geometry carried', missing: 1 });
    expect(out.legend.kind === 'categories' && out.legend.items.map(i => i.label)).toEqual(['G1', 'G2', 'None']);
    // low-regularity geometries: their own colour option, L numbers, the cool palette
    expect(mapColorOptions([]).map(o => o.id)).toContain(MAP_COLOR_GEOMETRY_LOW);
    const low = mapPointColors(MAP_COLOR_GEOMETRY_LOW, {
      readIds: ['a', 'b', 'c', 'd'], datasetIds: ['x', 'x', 'x', 'x'],
      summaries: () => undefined, geometries: (_ds, rid) => groups[rid],
      datasetColor: () => undefined, datasetLabel: d => d,
    });
    expect(low.colors).toEqual([nucGeoColor(1, 'low'), nucGeoColor(2, 'low'), GEOMETRY_NONE_COLOR, null]);
    expect(low.legend.kind === 'categories' && low.legend.items.map(i => i.label)).toEqual(['L1', 'L2', 'None']);
  });
});
