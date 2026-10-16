import { beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { DEFAULT_PEAK_RULES } from '../types';
import { importPeakEntriesToBrowser } from './peakImport';

beforeEach(() => {
  useBrowserStore.setState({
    chrom: '2R',
    peakRules: DEFAULT_PEAK_RULES.map(rule => ({ ...rule })),
    peaksByRule: {},
    peakSignalCache: {},
    selectedPeaks: new Set(),
    peakModes: {},
    peaksLocked: false,
    clusterAssignments: {},
    filteredReadIds: {},
    clusterFocus: {},
  });
});

describe('importPeakEntriesToBrowser', () => {
  it('imports current-chromosome peaks as selected locked custom peaks', () => {
    const result = importPeakEntriesToBrowser({
      entries: [
        { chrom: '2R', start: 100, end: 150, name: 'peak_a', ruleId: 'rule-a', ruleName: 'TF', mode: 'tf_layer' },
        { chrom: '3R', start: 200, end: 250, name: 'peak_b' },
      ],
    });

    const state = useBrowserStore.getState();
    const importedRule = state.peakRules.find(rule => rule.id.startsWith('imported-'));
    expect(result).toEqual({ imported: 1, skipped: 1, chrom: '2R', locked: true });
    expect(importedRule?.name).toBe('TF imported');
    expect(state.peaksLocked).toBe(true);
    expect(state.selectedPeaks.size).toBe(1);
    expect(Object.values(state.peaksByRule)[0][0]).toMatchObject({
      start: 100,
      end: 150,
      chrom: '2R',
      sourceLabel: 'peak_a',
      isCustom: true,
    });
  });

  it('imports peaks named with a chromosome alias, stored under the browser\'s name', () => {
    const result = importPeakEntriesToBrowser({ entries: [{ chrom: 'chr2R', start: 100, end: 150, name: 'p' }] });
    expect(result.imported).toBe(1);
    expect(Object.values(useBrowserStore.getState().peaksByRule)[0][0].chrom).toBe('2R');
  });

  it('replaces prior imported peak rules when requested', () => {
    importPeakEntriesToBrowser({
      entries: [{ chrom: '2R', start: 100, end: 150, name: 'first' }],
    });
    importPeakEntriesToBrowser({
      entries: [{ chrom: '2R', start: 300, end: 360, name: 'second' }],
      replaceExisting: true,
    });

    const state = useBrowserStore.getState();
    const importedRules = state.peakRules.filter(rule => rule.id.startsWith('imported-'));
    expect(importedRules).toHaveLength(1);
    expect(Object.values(state.peaksByRule)).toHaveLength(1);
    expect(Object.values(state.peaksByRule)[0][0].sourceLabel).toBe('second');
  });
});

it('keeps replacement import selection and modes when a durable group moves off its index', async () => {
  const { rigidMatchedRegions } = await import('./matchedRegions');
  importPeakEntriesToBrowser({ entries: [{ chrom: '2R', start: 10, end: 20 }] });
  const s = useBrowserStore.getState();
  s.upsertMatchedGroup({ id: 'g', name: 'Group', regions: rigidMatchedRegions([{ index: 0, chrom: '2R', start: 50, end: 100 }], '2R') });
  s.selectMatchedGroup('g');
  s.setPeakMode(30000, 'modification');
  importPeakEntriesToBrowser({ entries: [{ chrom: '2R', start: 300, end: 360, mode: 'tf_layer' }], replaceExisting: true });
  const now = useBrowserStore.getState();
  expect(now.peaksByRule.g[0].index).toBe(20000);
  expect([...now.selectedPeaks].sort()).toEqual([20000, 30000]);
  expect(now.peakModes).toMatchObject({ 20000: 'modification', 30000: 'tf_layer' });
});
