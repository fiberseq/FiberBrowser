/**
 * Tests for the per-key activity-log summarizer. The summarizer is what turns a
 * raw Zustand value (e.g. an array of panel configs) into the small object that
 * lands in the on-disk session log. Each test covers one watched store key and
 * pins the shape we ship to disk — drift here breaks every downstream training
 * pipeline that walks the activity_log.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  _summarizeValue,
  ACTIVITY_WATCHED_KEYS,
  readShareOptIn,
  writeShareOptIn,
  readShareFullDetails,
  writeShareFullDetails,
  SHARE_OPT_IN_KEY,
  SHARE_FULL_DETAILS_KEY,
  flushSessionNow,
} from './useSessionLog';

describe('_summarizeValue — null + missing handling', () => {
  it('returns null for null', () => {
    expect(_summarizeValue('panels', null)).toBeNull();
  });
  it('returns undefined for undefined', () => {
    expect(_summarizeValue('panels', undefined)).toBeUndefined();
  });
});

describe('_summarizeValue — panels', () => {
  it('emits contentType + datasetId per item', () => {
    const panels = [
      { id: 'a', contentType: 'cluster-detail', datasetId: 'ds1', collapsed: false },
      { id: 'b', contentType: 'colormap', stateKey: 'ds2-x', collapsed: true },
    ];
    const out = _summarizeValue('panels', panels) as Record<string, unknown>;
    expect(out.len).toBe(2);
    expect(out.items).toEqual([
      { contentType: 'cluster-detail', dataset_id: 'ds1', stateKey: null, collapsed: false },
      { contentType: 'colormap', dataset_id: null, stateKey: 'ds2-x', collapsed: true },
    ]);
    expect(out).not.toHaveProperty('truncated');
  });
  it('truncates panels above the cap', () => {
    const panels = Array.from({ length: 40 }, (_, i) => ({ contentType: `t-${i}` }));
    const out = _summarizeValue('panels', panels) as Record<string, unknown>;
    expect(out.len).toBe(40);
    expect((out.items as unknown[]).length).toBe(30);
    expect(out.truncated).toBe(10);
  });
});

describe('_summarizeValue — selectedPeaks', () => {
  it('emits chrom/start/end/position per peak', () => {
    const peaks = [
      { chrom: '2R', start: 9_977_000, end: 9_977_200, position: 9_977_100, source: 'fire' },
      { chrom: '2L', position: 1_000_000 },
    ];
    const out = _summarizeValue('selectedPeaks', peaks) as Record<string, unknown>;
    expect(out.len).toBe(2);
    expect((out.items as Array<Record<string, unknown>>)[0]).toEqual({
      chrom: '2R', start: 9_977_000, end: 9_977_200, position: 9_977_100, source: 'fire',
    });
    expect((out.items as Array<Record<string, unknown>>)[1]).toEqual({
      chrom: '2L', start: null, end: null, position: 1_000_000, source: null,
    });
  });
});

describe('_summarizeValue — clusterFocus', () => {
  it('expands Set values to arrays per stateKey', () => {
    const focus = { 'ds1': new Set([0, 2, 5]), 'ds2-extra': [1, 3] };
    const out = _summarizeValue('clusterFocus', focus) as Record<string, number[]>;
    expect(new Set(out['ds1'])).toEqual(new Set([0, 2, 5]));
    expect(out['ds2-extra']).toEqual([1, 3]);
  });
  it('returns empty object when value is empty', () => {
    expect(_summarizeValue('clusterFocus', {})).toEqual({});
  });
});

describe('_summarizeValue — activeColormap', () => {
  it('lifts rule fields the anonymizer can find', () => {
    const cmap = {
      name: 'eve-rules',
      rules: [
        {
          color: '#22c55e',
          colorName: 'green',
          layer: 'tf',
          regionLabel: 'eve TSS -100',
          gene: 'eve',
          offsetBp: -100,
          sizeMin: 1,
          sizeMax: 80,
        },
      ],
    };
    const out = _summarizeValue('activeColormap', cmap) as Record<string, unknown>;
    expect(out.name).toBe('eve-rules');
    expect(out.rule_count).toBe(1);
    const rule = (out.rules as Array<Record<string, unknown>>)[0];
    expect(rule.color).toBe('#22c55e');
    expect(rule.color_name).toBe('green');
    expect(rule.layer).toBe('tf');
    expect(rule.gene).toBe('eve');
    expect(rule.offset_bp).toBe(-100);
    expect(rule.region_label).toBe('eve TSS -100');
    expect(rule.size_min).toBe(1);
    expect(rule.size_max).toBe(80);
  });
});

describe('_summarizeValue — footprintGroups', () => {
  it('captures size window + color + dataset', () => {
    const groups = [
      { name: 'TF-size', color: '#3b82f6', sourceIndex: 0, sizeMin: 80, sizeMax: 200, enabled: true },
      { name: 'Nucleosomal', color: '#ef4444', sourceIndex: 1, sizeMin: 120, sizeMax: 250, overlapFraction: 0.5, enabled: false },
    ];
    const out = _summarizeValue('footprintGroups', groups) as Record<string, unknown>;
    expect(out.len).toBe(2);
    expect((out.items as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: 'TF-size', color: '#3b82f6', source_index: 0, size_min: 80, size_max: 200, enabled: true,
    });
    expect((out.items as Array<Record<string, unknown>>)[1].overlap_fraction).toBe(0.5);
  });
});

describe('_summarizeValue — track collections', () => {
  it.each(['compositeTracks', 'savedTracks', 'orthogonalTracks'])('summarizes %s', (key) => {
    const tracks = [
      { kind: 'metaprofile', label: 'metaprofile', sources: [{}, {}], datasetId: 'ds-1' },
      { type: 'bigwig', label: 'h3k27ac' },
    ];
    const out = _summarizeValue(key, tracks) as Record<string, unknown>;
    expect(out.len).toBe(2);
    const items = out.items as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ kind: 'metaprofile', label: 'metaprofile', dataset_id: 'ds-1', source_count: 2 });
    expect(items[1]).toMatchObject({ kind: 'bigwig', label: 'h3k27ac' });
  });
});

describe('_summarizeValue — savedClusters', () => {
  it('lifts viewport + clustering config', () => {
    const saved = [
      {
        name: 'eve-promoter',
        viewport: { chrom: '2R', start: 9_974_000, end: 9_984_000 },
        config: { method: 'kmeans', k: 5 },
      },
    ];
    const out = _summarizeValue('savedClusters', saved) as Record<string, unknown>;
    expect((out.items as Array<Record<string, unknown>>)[0]).toEqual({
      name: 'eve-promoter', chrom: '2R', start: 9_974_000, end: 9_984_000, method: 'kmeans', k: 5,
    });
  });
});

describe('_summarizeValue — bool-map watchers (transcriptionStateFilters / enabledMetaProfiles / enabledModTypes)', () => {
  it.each([
    'transcriptionStateFilters', 'enabledMetaProfiles', 'enabledModTypes',
  ])('extracts only the enabled keys for %s', (key) => {
    const value = { pause: true, pic: false, elongating: true };
    const out = _summarizeValue(key, value);
    expect(new Set(out as string[])).toEqual(new Set(['pause', 'elongating']));
  });
});

describe('_summarizeValue — peakRules', () => {
  it('emits compact rule shape', () => {
    const rules = [
      { name: 'nuc', layer: 'nuc', sizeMin: 100, sizeMax: 200 },
      { name: 'tf', layer: 'tf' },
    ];
    const out = _summarizeValue('peakRules', rules) as Record<string, unknown>;
    expect((out.items as Array<Record<string, unknown>>)).toEqual([
      { name: 'nuc', layer: 'nuc', size_min: 100, size_max: 200 },
      { name: 'tf', layer: 'tf', size_min: null, size_max: null },
    ]);
  });
});

describe('_summarizeValue — scalar / unknown keys fall through to the legacy summary', () => {
  it('passes scalars through unchanged', () => {
    expect(_summarizeValue('peaksLocked', true)).toBe(true);
    expect(_summarizeValue('clusterK', 5)).toBe(5);
    expect(_summarizeValue('currentGenome', 'dm6')).toBe('dm6');
    expect(_summarizeValue('uiScale', 1.25)).toBe(1.25);
  });
  it('hiddenStripPanels uses the panels extractor (mapped panel-shape)', () => {
    expect(_summarizeValue('hiddenStripPanels', [{}, {}, {}])).toEqual({ len: 3, items: [
      { contentType: null, dataset_id: null, stateKey: null, collapsed: null },
      { contentType: null, dataset_id: null, stateKey: null, collapsed: null },
      { contentType: null, dataset_id: null, stateKey: null, collapsed: null },
    ] });
  });
  it('uses the lossy fallback for unrecognized object keys', () => {
    const out = _summarizeValue('relativeTSS', { a: 1, b: 2, c: 3 }) as Record<string, unknown>;
    expect(out.keys).toBe(3);
    expect((out.sample as string[]).length).toBeLessThanOrEqual(4);
  });
});

describe('_summarizeValue — privacy posture: anonymizer-friendly key names', () => {
  // The server-side anonymizer in browser/routers/natural_language.py keys on
  // specific field names: `gene`, `dataset_id`, `start/end/position/offset_bp`,
  // `motif`. Emitting *these exact names* in the summary means the existing
  // anonymizer redacts everything correctly with no extra wiring. This test
  // pins the contract so a future refactor doesn't silently rename them.
  it('panels uses dataset_id (anonymizer-friendly), not datasetId', () => {
    const out = _summarizeValue('panels', [{ contentType: 'x', datasetId: 'leak-me' }]) as Record<string, unknown>;
    const item = (out.items as Array<Record<string, unknown>>)[0];
    expect(item.dataset_id).toBe('leak-me');
    expect(item).not.toHaveProperty('datasetId');
  });
  it('activeColormap rules expose gene + offset_bp under anonymizer keys', () => {
    const out = _summarizeValue('activeColormap', {
      rules: [{ gene: 'eve', offsetBp: -100, color: '#22c55e' }],
    }) as Record<string, unknown>;
    const rule = (out.rules as Array<Record<string, unknown>>)[0];
    expect(rule.gene).toBe('eve');
    expect(rule.offset_bp).toBe(-100);
  });
});

describe('ACTIVITY_WATCHED_KEYS — every key has a callable summarizer', () => {
  it.each(ACTIVITY_WATCHED_KEYS)('summarizes "%s" without throwing on a representative value', (key) => {
    // We don't enforce a specific output shape here — only that each watched
    // key has *some* summary path, even if it's the lossy fallback. This
    // guards against `_summarizeValue` regressing to throw on a value type
    // we forgot about.
    const reps: unknown[] = [
      null,
      undefined,
      true,
      0,
      1.5,
      'string',
      [],
      [{ contentType: 'cluster-detail' }, { contentType: 'colormap' }],
      { a: 1, b: 2 },
      { rules: [{ color: '#fff', layer: 'tf' }] },
      { ds1: new Set([0, 1]) },
    ];
    for (const v of reps) {
      expect(() => _summarizeValue(key, v)).not.toThrow();
    }
  });
});

describe('localStorage opt-in flags', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  it('readShareOptIn defaults to false', () => {
    expect(readShareOptIn()).toBe(false);
  });
  it('writeShareOptIn persists + clears', () => {
    writeShareOptIn(true);
    expect(window.localStorage.getItem(SHARE_OPT_IN_KEY)).toBe('1');
    expect(readShareOptIn()).toBe(true);
    writeShareOptIn(false);
    expect(window.localStorage.getItem(SHARE_OPT_IN_KEY)).toBeNull();
    expect(readShareOptIn()).toBe(false);
  });
  it('readShareFullDetails / writeShareFullDetails round-trip', () => {
    expect(readShareFullDetails()).toBe(false);
    writeShareFullDetails(true);
    expect(window.localStorage.getItem(SHARE_FULL_DETAILS_KEY)).toBe('1');
    expect(readShareFullDetails()).toBe(true);
  });
});

describe('session-log saves', () => {
  it('a manual save is a plain request, never keepalive (browsers refuse keepalive bodies over 64 KiB)', async () => {
    const calls: RequestInit[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      await flushSessionNow();
    } finally {
      globalThis.fetch = original;
    }
    expect(calls.length).toBe(1);
    expect(calls[0].keepalive).toBeUndefined();
  });
});
