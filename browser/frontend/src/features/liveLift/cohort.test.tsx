import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { clusterAssignmentForRead, filterReadsByReadIdSet } from '../../components/tracks/read-track/readFilter';
import { clusterWindows } from '../../utils/clusterTargets';
import { splitReadFilter } from '../../stores/splitPanelStore';
import { splitAway } from '../../utils/splitLocus';
import { liftHaplotypeGrouping } from './grouping';
import { CohortSettingsFields } from './CohortSettingsFields';
import type { LiftSettings } from './api';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

it('folded display rows match cohort assignments and filters', () => {
  const rows = [{ id: 'name', analysis_id: 'group|name|primary' }, { id: 'name', analysis_id: 'group|name|primary' },
    { id: 'name', analysis_id: 'other|name|primary' }];
  expect(filterReadsByReadIdSet(rows, new Set(['group|name|primary']))).toEqual(rows.slice(0, 2));
  expect(rows.slice(0, 2).map(r => clusterAssignmentForRead({ 'group|name|primary': 3 }, r.analysis_id))).toEqual([3, 3]);
});

it('rule splits cluster without stored IDs and preserve an explicit user filter after panning', () => {
  const panel: any = { id: 'mat', stateKey: 'mat', datasetId: 'lift', contentType: 'dataset', collapsed: false,
    liftHap: 'MAT', readSubset: { rule: { liftHap: 'MAT' }, locus: { chrom: 'chr1', start: 0, end: 10 } } };
  const state: any = { panels: [panel], selectedDatasets: new Set(), filteredReadIds: {}, chrom: 'chr2', start: 100, end: 200 };
  expect(clusterWindows(state, ['lift'])[0]).toMatchObject({ lift_hap: 'MAT', result_key: 'mat', read_ids: undefined });
  expect(splitAway(panel.readSubset, state)).toBe(false);
  const user = new Set(['cohort-id']);
  expect(splitReadFilter({ state: 'ready', ids: new Set() }, user, panel.readSubset.rule)).toBe(user);
  state.filteredReadIds.mat = user;
  expect(clusterWindows(state, ['lift'])[0].read_ids).toEqual(['cohort-id']);
});

it('pooled grouping derives assignments from loaded cohort identities', () => {
  const info: any = { haplotypes: ['m', 'p'], haplotype_labels: { m: 'MAT', p: 'PAT' }, key: 'key' };
  const rows: any = [{ id: 'name', analysis_id: 'mat-cohort', live_lift: { hap_label: 'MAT' } },
    { id: 'name', analysis_id: 'pat-cohort', live_lift: { hap_label: 'PAT' } }];
  const grouped = liftHaplotypeGrouping('lift', info, rows, { chrom: 'chr1', start: 0, end: 10 });
  expect(grouped.assignments).toEqual({ 'mat-cohort': 0, 'pat-cohort': 1 });
  expect(grouped.groups.map(g => g.count)).toEqual([1, 1]);
});

it('advanced cohort policies can be changed independently of display policies', async () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  let current: LiftSettings = { alternatives: false, supplementary_display: 'hide' };
  function Probe() {
    const [s, set] = useState(current); current = s;
    return <CohortSettingsFields settings={s} onChange={set} paths={['library.bam']} />;
  }
  try {
    await act(async () => root.render(<Probe />));
    const select = host.querySelectorAll('select');
    await act(async () => { select[0].value = 'all_records'; select[0].dispatchEvent(new Event('change', { bubbles: true }));
      select[1].value = 'include'; select[1].dispatchEvent(new Event('change', { bubbles: true })); });
    const fold = Array.from(host.querySelectorAll('label')).find(l => l.textContent?.includes("Fold a molecule's"))!.querySelector('input')!;
    await act(async () => fold.click());
    expect(current).toMatchObject({ supplementary_display: 'hide', cohort_supplementaries: 'all_records',
      alternatives: false, cohort_alternatives: 'include', fold_molecule: true });
    expect(host.textContent).toContain('provenance');
    expect(host.textContent).toContain('Both copies are kept by default');
  } finally { await act(async () => root.unmount()); host.remove(); }
});
