import { expect, it } from 'vitest';
import { svCorrespondences, updateSvCorrespondences } from './svCorrespondence';
import { useBrowserStore } from '../stores/browserStore';
import { validateMatchedState } from './matchedRegions';

it('builds the correspondence as the insertion opens and preserves it through session geometry validation', () => {
  const s = useBrowserStore.getState();
  const panel = { id: 'carrier', contentType: 'dataset', datasetId: 'alt', genome: 'alt-ref', readSubset: { groupId: 'split' },
    altAllele: { cluster: { datasetId: 'bam' }, layout: { chrom: 'chr1', ref: 1000, flank_left: 100, flank_right: 200,
      name: 'insert', insert_len: 50, insert_start: 100, insert_end: 150, length: 350 } } };
  const reference = { id: 'ref', contentType: 'dataset', datasetId: 'bam', readSubset: { groupId: 'split' } };
  const input = { ...s, chrom: 'chr1', panels: [panel, reference], svSplits: {} } as unknown as typeof s;
  const maps = svCorrespondences(input);
  expect(maps).toHaveLength(1);
  expect(maps[0].regions.map(p => p.match!.blocks)).toEqual([
    [{ frame: [0, 100], genomic: [0, 100] }, { frame: [100, 300], genomic: [150, 350] }],
    [{ frame: [0, 100], genomic: [900, 1000] }, { frame: [100, 300], genomic: [1000, 1200] }],
  ]);
  try {
    s.upsertMatchedGroup(maps[0]);
    const saved = useBrowserStore.getState();
    const restored = validateMatchedState({ peakRules: JSON.parse(JSON.stringify(saved.peakRules)), peaksByRule: JSON.parse(JSON.stringify(saved.peaksByRule)) });
    expect(restored.peaksByRule![maps[0].id!]).toHaveLength(2);
    saved.updatePeakRule(maps[0].id!, { name: 'My flanks', color: '#123456' });
    const rules = useBrowserStore.getState().peakRules;
    updateSvCorrespondences({ ...useBrowserStore.getState(), ...input, peakRules: rules,
      peaksByRule: useBrowserStore.getState().peaksByRule });
    expect(useBrowserStore.getState().peakRules).toBe(rules);
    expect(useBrowserStore.getState().peakRules.find(r => r.id === maps[0].id!)).toMatchObject({ name: 'My flanks', color: '#123456' });
  } finally { useBrowserStore.setState(s, true); }
  expect(svCorrespondences({ ...s, panels: [panel] } as never)).toEqual([]);
});

it('excludes a deletion from same-reference carrier and reference flanks', () => {
  const s = useBrowserStore.getState();
  const panels = [{ id: 'source', stateKey: 'key', collapsed: true }, ...['a', 'b'].map(id => ({ id, datasetId: 'bam', contentType: 'dataset', readSubset: { groupId: 'g', sourcePanelId: 'source' } }))];
  const maps = svCorrespondences({ ...s, panels, svSplits: { key: { t: 'D', ref: 100, end: 150, len: 50, viewStart: 0, viewEnd: 200, chrom: 'chr1' } } } as never);
  expect(maps[0].regions.every(p => JSON.stringify(p.match!.blocks) === JSON.stringify([
    { frame: [0, 100], genomic: [0, 100] }, { frame: [150, 200], genomic: [150, 200] },
  ]))).toBe(true);
});
