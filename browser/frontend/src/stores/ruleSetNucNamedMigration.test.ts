import { beforeEach, describe, expect, it } from 'vitest';
import {
  ANALYSIS_FILTER_RULESETS_STORAGE_KEY, ANALYSIS_SORT_RULESETS_STORAGE_KEY, CLUSTER_FEATURE_RULESETS_STORAGE_KEY,
  loadAnalysisFilterRuleSetsFromStorage, loadAnalysisSortRuleSetsFromStorage, loadClusterFeatureRuleSetsFromStorage,
} from './utils';

// agy audit (final 3.1.0, LOW): saved cluster / sort / filter rule sets whose rule snapshots carry a named-class
// condition are written back without it, so the "Named nucleosome classes were removed" notice is shown once, not on
// every load (and not twice when the set is the default).
const snapshot = { id: 'nucs', name: 'Nucs', enabled: true, color: '#33a040', targetLayers: ['nuc'], nucNamed: [2] };
const ruleSet = (rules: unknown[]) => JSON.stringify([{ name: 'Mine', savedAt: 1, rules }]);

describe('rule sets saved with named nucleosome classes', () => {
  beforeEach(() => localStorage.clear());

  it.each([
    [CLUSTER_FEATURE_RULESETS_STORAGE_KEY, loadClusterFeatureRuleSetsFromStorage],
    [ANALYSIS_SORT_RULESETS_STORAGE_KEY, loadAnalysisSortRuleSetsFromStorage],
    [ANALYSIS_FILTER_RULESETS_STORAGE_KEY, loadAnalysisFilterRuleSetsFromStorage],
  ].flatMap(([key, load]) => [[key, load, 'nucNamed'], [key, load, 'nuc_named']] as const))('%s (%s) is saved back without the condition', (key, load, spelling) => {
    const { nucNamed: _drop, ...plain } = snapshot;
    const rule = { ...plain, [spelling as string]: [2] };
    localStorage.setItem(key as string, ruleSet([{ id: 't', enabled: true, terms: [{ rule, ruleId: 'nucs' }] }]));
    const first = (load as () => unknown[])();
    expect(first).toHaveLength(1);
    expect(localStorage.getItem(key as string)).not.toContain(spelling as string);
    const stored = localStorage.getItem(key as string);
    expect((load as () => unknown[])()).toHaveLength(1);
    expect(localStorage.getItem(key as string)).toBe(stored);   // nothing left to migrate: not written again
  });
});
