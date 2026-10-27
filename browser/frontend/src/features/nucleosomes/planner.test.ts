import { describe, expect, it } from 'vitest';
import { nucObservations, observationDatasets, observationsKey, observationViews } from './planner';
import type { PanelConfig } from '../../types';

const panel = (o: Partial<PanelConfig> & { id: string }): PanelConfig => ({
  contentType: 'dataset', datasetId: 'native', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...o,
} as unknown as PanelConfig);

const lifted = { id: 'lifted', label: 'Sample A (lifted)', data_type: 'bam_livelift', color: '#111111',
  live_lift: { haplotypes: ['H#1', 'H#2'], haplotype_labels: { 'H#1': 'MAT', 'H#2': 'PAT' } } };
const native = { id: 'native', label: 'Sample A (GRCh38)', data_type: 'bam', color: '#2563eb' };
const daf = { id: 'daf', label: 'DAF', data_type: 'bam', color: '#dc2626' };

function state(panels: PanelConfig[], extra: Record<string, unknown> = {}) {
  return {
    panels, datasets: [lifted, native, daf] as never, selectedDatasets: new Set<string>(), chrom: 'chr3', start: 1000,
    end: 9000, currentGenome: 'hg38', filteredReadIds: {}, selectedPeaks: new Set<number>(), peakModes: {},
    clusterPeakMode: 'accessibility', clusterFeatureRules: [], selectedGenes: new Set(), selectedFeatures: [],
    getAllPeaks: () => [], ...extra,
  } as never;
}

describe('nucleosome observation planner', () => {
  it('haplotype pop-outs, strand splits and a linked locus are columns of their own (never one per dataset)', () => {
    const st = state([
      panel({ id: 'mat', datasetId: 'lifted', stateKey: 'lifted:MAT', liftHap: 'MAT' }),
      panel({ id: 'pat', datasetId: 'lifted', stateKey: 'lifted:PAT', liftHap: 'PAT' }),
      panel({ id: 'ct', datasetId: 'daf', stateKey: 'daf:CT', strand: 'CT' }),
      panel({ id: 'ga', datasetId: 'daf', stateKey: 'daf:GA', strand: 'GA' }),
      panel({ id: 'nat' }),
      panel({ id: 'away', stateKey: 'native~away', viewportOverride: { chrom: 'chr3', start: 50_000, end: 60_000 } }),
    ]);
    const obs = nucObservations(st);
    expect(obs.map(o => o.obsId)).toEqual(['lifted:MAT', 'lifted:PAT', 'daf:CT', 'daf:GA', 'native', 'native~away']);
    expect(obs.find(o => o.obsId === 'lifted:PAT')).toMatchObject({ datasetId: 'lifted', liftHap: 'PAT', kind: 'linear', chrom: 'chr3', start: 1000, end: 9000 });
    expect(obs.find(o => o.obsId === 'daf:GA')?.strand).toBe('GA');
    expect(obs.find(o => o.obsId === 'native~away')).toMatchObject({ start: 50_000, end: 60_000 });
    expect(observationDatasets(obs)).toEqual(['lifted', 'daf', 'native']);
  });

  it('haplotype columns name their haplotype', () => {
    const obs = nucObservations(state([panel({ id: 'mat', datasetId: 'lifted', stateKey: 'lifted:MAT', liftHap: 'MAT' }),
      panel({ id: 'pat', datasetId: 'lifted', stateKey: 'lifted:PAT', liftHap: 'PAT' })]));
    expect(obs.map(o => [o.liftHap, o.label])).toEqual([['MAT', 'Sample A (lifted) · MAT'], ['PAT', 'Sample A (lifted) · PAT']]);
  });

  it('a filtered panel sends its kept reads; an empty filter sends none', () => {
    const st = state([panel({ id: 'nat' }), panel({ id: 'mat', datasetId: 'lifted', stateKey: 'lifted:MAT', liftHap: 'MAT' })],
      { filteredReadIds: { native: new Set(['r1', 'r2']), 'lifted:MAT': new Set() } });
    const obs = nucObservations(st);
    expect(obs.find(o => o.obsId === 'native')?.readIds?.sort()).toEqual(['r1', 'r2']);
    expect(obs.find(o => o.obsId === 'lifted:MAT')?.readIds).toEqual([]);
    expect(observationsKey(obs)).not.toBe(observationsKey(nucObservations(state([panel({ id: 'nat' })]))));
  });

  it('a dataset panel drawing its graph gives one column per haplotype path; folded members are not columns', () => {
    const host = panel({ id: 'host', datasetId: 'lifted', stateKey: 'lifted', viewMode: 'graph',
      graphView: { role: 'host', registrationId: 'reg', targetBinding: 'grch38', members: [] } } as never);
    const folded = panel({ id: 'm1', datasetId: 'lifted', stateKey: 'lifted:MAT', liftHap: 'MAT', collapsed: true, graphMemberOf: 'host' } as never);
    const obs = nucObservations(state([host, folded, panel({ id: 'nat' })]));
    expect(obs.map(o => o.obsId)).toEqual(['lifted:graph:MAT', 'lifted:graph:PAT', 'native']);
    expect(obs[0]).toMatchObject({ kind: 'graph', liftHap: 'MAT', graph: { hap: 'MAT' }, datasetId: 'lifted' });
  });

  it('a graph host gives a column per member it draws, another dataset\'s folded member included', () => {
    const host = panel({ id: 'host', datasetId: 'native', stateKey: 'native', viewMode: 'graph',
      graphView: { role: 'host', registrationId: 'reg', targetBinding: 'grch38',
        members: [{ panelId: 'host', binding: null }, { panelId: 'm1', binding: 'mat' }] } } as never);
    const member = panel({ id: 'm1', datasetId: 'lifted', stateKey: 'lifted:MAT', liftHap: 'MAT', collapsed: true, graphMemberOf: 'host' } as never);
    const obs = nucObservations(state([host, member]));
    expect(obs.map(o => o.obsId)).toEqual(['native:graph', 'lifted:MAT:graph:MAT']);
    expect(obs[1]).toMatchObject({ datasetId: 'lifted', liftHap: 'MAT', kind: 'graph', chrom: 'chr3', start: 1000, end: 9000 });
  });

  it('a pooled graph host leaves a haplotype to the member that owns it, as the graph draws its bands', () => {
    const host = panel({ id: 'host', datasetId: 'lifted', stateKey: 'lifted', viewMode: 'graph',
      graphView: { role: 'host', registrationId: 'reg', targetBinding: 'grch38',
        members: [{ panelId: 'host', binding: null }, { panelId: 'mat', binding: 'mat' }] } } as never);
    const mat = panel({ id: 'mat', datasetId: 'lifted', stateKey: 'lifted:MAT', liftHap: 'MAT', collapsed: true, graphMemberOf: 'host' } as never);
    expect(nucObservations(state([host, mat])).map(o => o.obsId)).toEqual(['lifted:graph:PAT', 'lifted:MAT:graph:MAT']);
  });

  it('the refresh key follows the whole read membership, not its size and first ids', () => {
    const a = nucObservations(state([panel({ id: 'nat' })], { filteredReadIds: { native: new Set(['r1', 'r2', 'r3', 'r4']) } }));
    const b = nucObservations(state([panel({ id: 'nat' })], { filteredReadIds: { native: new Set(['r1', 'r2', 'r3', 'r5']) } }));
    expect(observationsKey(a)).not.toBe(observationsKey(b));
    expect(observationViews([...a, ...a])).toEqual([{ datasetId: 'native', chrom: 'chr3', start: 1000, end: 9000 }]);
  });

  it('skips panels of datasets the module cannot read', () => {
    const st = state([panel({ id: 'bb', datasetId: 'bigbed' })]);
    (st as { datasets: unknown[] }).datasets.push({ id: 'bigbed', label: 'bb', data_type: 'bigbed' });
    expect(nucObservations(st)).toEqual([]);
  });
});
