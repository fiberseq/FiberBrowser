import { describe, expect, it } from 'vitest';
import { remapDatasetIds } from '../historySlice';

describe('saved hub dataset ID remapping', () => {
  it.each([
    { sample: 'sample_1', sample_1: 'sample' },
    { sample: 'reopened-a', sample_1: 'reopened-b' },
  ])('remaps hub descriptors and graph paths once without changing identities: %j', idMap => {
    const hit = {
      setId: 'sample_1', hitId: 'sample_1', label: 'sample_1', datasets: ['sample_1'],
      stateSpec: { kind: 'snp', datasetId: 'sample_1', reads: ['sample_1'] },
      graph: { paths: { sample_1: { status: 'present', hap: 'sample_1', datasets: ['sample', 'sample_1'] } } },
    };
    const saved = {
      datasets: [{ id: 'sample', label: 'sample', paths: ['/a/sample.bam'] },
        { id: 'sample_1', label: 'sample_1', paths: ['/b/sample.bam'] }],
      panels: [{ datasetId: 'sample_1' }],
      featureHub: {
        selected: [hit],
        pinned: [{ hubHit: hit }],
        selectedFeatures: [{ kind: 'snp', hubHit: hit }],
        assocRuns: [{ definition: { datasets: ['sample_1'], a: { hits: [{ hubHit: hit }] } } }],
        overlay: { result: { graph: hit.graph } },
      },
      selectedFeatures: [{ hubHit: hit }],
      // Historical content identities have their own deliberate relink operation.
      differencesSession: { datasets: ['sample_1'], hubHit: hit },
    };
    const original = structuredClone(saved);
    const restored = remapDatasetIds(saved, idMap);
    const expectedHit = { ...hit, datasets: [idMap.sample_1],
      stateSpec: { ...hit.stateSpec, datasetId: idMap.sample_1 },
      graph: { paths: { sample_1: { status: 'present', hap: 'sample_1', datasets: [idMap.sample, idMap.sample_1] } } } };

    expect(restored.datasets.map(d => d.id)).toEqual([idMap.sample, idMap.sample_1]);
    expect(restored.datasets.map(d => d.paths)).toEqual(saved.datasets.map(d => d.paths));
    expect(restored.panels[0].datasetId).toBe(idMap.sample_1);
    expect(restored.featureHub.selected).toEqual([expectedHit]);
    expect(restored.featureHub.pinned[0].hubHit).toEqual(expectedHit);
    expect(restored.featureHub.selectedFeatures[0].hubHit).toEqual(expectedHit);
    expect(restored.selectedFeatures[0].hubHit).toEqual(expectedHit);
    expect(restored.featureHub.assocRuns[0].definition.datasets).toEqual([idMap.sample_1]);
    expect(restored.featureHub.assocRuns[0].definition.a.hits[0].hubHit).toEqual(expectedHit);
    expect(restored.featureHub.overlay.result.graph).toEqual(expectedHit.graph);
    expect(restored.differencesSession).toEqual(saved.differencesSession);
    expect(saved).toEqual(original);
  });
});
