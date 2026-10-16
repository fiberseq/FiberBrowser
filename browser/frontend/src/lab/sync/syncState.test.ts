import '../testSetup';
import { beforeEach, expect, it } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { serializeExtensions, storeExtensions, extensionKeys } from '../../stores/storeExtensions';
import { getActiveFrame, restoreSync } from './syncState';
import type { ComparisonFrame } from './model';
const frame: ComparisonFrame = {
  id: 'frame', name: 'A ↔ B', version: 1, status: 'accepted', templatePanelId: 'a', alignedOn: ['sequence'], length: 100,
  windows: ['a', 'b'].map((id, i) => ({ panelId: id, datasetId: id, label: id, genome: i ? 'alt' : null, chrom: 'chr1', start: 100, end: 200, strand: i ? '-' : '+', blocks: [{ frame: [0, 100], genomic: [100, 200] }], provenance: { metric: 'sequence', score: 1, scores: { sequence: 1 }, flags: [] } }))
};
beforeEach(() => useBrowserStore.setState({ comparisonFrames: [], activeComparisonFrameId: null }));
it('keeps several frames, versions updates, and exposes the active frame', () => {
  const s = useBrowserStore.getState();
  s.saveComparisonFrame(frame);
  s.saveComparisonFrame({ ...frame, id: 'second' });
  expect(getActiveFrame()?.id).toBe('second');
  s.saveComparisonFrame({ ...frame, name: 'refined' });
  expect(getActiveFrame()).toMatchObject({ id: 'frame', version: 2, name: 'refined' });
  expect(useBrowserStore.getState().comparisonFrames).toHaveLength(2);
  s.activateComparisonFrame('second');
  expect(getActiveFrame()?.id).toBe('second');
});
it('serializes through the lab session extension, restores orientation and resets old sessions', () => {
  useBrowserStore.getState().saveComparisonFrame(frame);
  const saved = JSON.parse(JSON.stringify(serializeExtensions(useBrowserStore.getState())));
  const ext = storeExtensions().find(e => e.id === 'lab.sync')!;
  expect(ext.importSession!(saved, useBrowserStore.getState())).toEqual({ comparisonFrames: [frame], activeComparisonFrameId: 'frame' });
  expect(ext.restoreSnapshot!(saved)).toEqual(restoreSync(saved));
  expect(ext.importSession!(undefined, useBrowserStore.getState())).toEqual({ comparisonFrames: [], activeComparisonFrameId: null });
  expect(extensionKeys()).toContain('comparisonFrames');
});
it('rejects unequal lengths, unknown active ids and malformed frames on restore', () => {
  expect(restoreSync({ comparisonFrames: [{ ...frame, length: 90 }], activeComparisonFrameId: 'frame' })).toEqual({ comparisonFrames: [], activeComparisonFrameId: null });
  expect(restoreSync({ comparisonFrames: [frame], activeComparisonFrameId: 'missing' }).activeComparisonFrameId).toBeNull();
});
it('restores block maps, copies and circular windows; gives old frames one rigid block', () => {
  const chained: ComparisonFrame = {
    ...frame, windows: [frame.windows[0], { ...frame.windows[1], strand: '+', copy: 'a', start: 100, end: 260, blocks: [{ frame: [0, 40], genomic: [100, 140] }, { frame: [40, 100], genomic: [200, 260] }] },
      { ...frame.windows[1], strand: '+', copy: 'b', contigLength: 150, start: 120, end: 220, blocks: [{ frame: [0, 30], genomic: [120, 150] }, { frame: [30, 100], genomic: [150, 220] }] }]
  };
  expect(restoreSync({ comparisonFrames: [chained] }).comparisonFrames).toHaveLength(1);
  const { blocks: _, ...legacy } = frame.windows[1];
  expect(restoreSync({ comparisonFrames: [{ ...frame, windows: [frame.windows[0], legacy] }] }).comparisonFrames[0].windows[1].blocks).toEqual([{ frame: [0, 100], genomic: [100, 200] }]);
  // A block of unequal lengths, a duplicate copy or a block outside its window is refused.
  for (const bad of [[{ frame: [0, 50], genomic: [100, 140] }], [{ frame: [0, 100], genomic: [50, 150] }]])
    expect(restoreSync({ comparisonFrames: [{ ...chained, windows: [chained.windows[0], { ...chained.windows[1], blocks: bad }] }] }).comparisonFrames).toEqual([]);
  expect(restoreSync({ comparisonFrames: [{ ...chained, windows: [...chained.windows, chained.windows[1]] }] }).comparisonFrames).toEqual([]);
});
it('refuses overlapping or origin-straddling blocks and malformed windows without throwing', () => {
  const overlapping = { ...frame, windows: [frame.windows[0], { ...frame.windows[1], strand: '+' as const, blocks: [{ frame: [0, 100], genomic: [100, 200] }, { frame: [0, 100], genomic: [100, 200] }] }] };
  expect(restoreSync({ comparisonFrames: [overlapping] }).comparisonFrames).toEqual([]);
  const straddling = { ...frame, windows: [frame.windows[0], { ...frame.windows[1], contigLength: 150 }] };
  expect(restoreSync({ comparisonFrames: [straddling] }).comparisonFrames).toEqual([]);
  expect(restoreSync({ comparisonFrames: [{ ...frame, windows: [null, frame.windows[1]] }] }).comparisonFrames).toEqual([]);
});
it('accepted circular copies become per-locus regions in reference coordinates', () => {
  const f: ComparisonFrame = { ...frame, id: 'circle', windows: [frame.windows[0], {
    ...frame.windows[1], strand: '+', start: 120, end: 220, contigLength: 150, copy: 'a',
    blocks: [{ frame: [0, 30], genomic: [120, 150] }, { frame: [30, 100], genomic: [150, 220] }],
  }] };
  useBrowserStore.getState().saveComparisonFrame(f);
  const peaks = useBrowserStore.getState().peaksByRule['matched-circle'];
  expect(peaks[1]).toMatchObject({ chrom: 'chr1', genome: 'alt', start: 0, end: 150,
    match: { label: 'W2a', length: 100, blocks: [{ frame: [0, 30], genomic: [120, 150] }, { frame: [30, 100], genomic: [0, 70] }] } });
});

it('an accepted homology map with an indel and a reversed member drives co-peaks', async () => {
  const initial = useBrowserStore.getState();
  const { clusterBasis } = await import('../../utils/clusterTargets');
  try {
    useBrowserStore.setState({ peakRules: initial.peakRules.filter(r => r.source !== 'matched'), peaksByRule: {}, selectedPeaks: new Set(), chrom: 'chr1' });
    useBrowserStore.getState().saveComparisonFrame({ ...frame, id: 'homology', windows: [frame.windows[0], {
      ...frame.windows[1], start: 300, end: 410, blocks: [{ frame: [0, 40], genomic: [370, 410] }, { frame: [50, 100], genomic: [300, 350] }],
    }] });
    useBrowserStore.getState().addCustomPeak(160, 180, 'chr1');
    const peaks = useBrowserStore.getState().getAllPeaks().filter(p => p.isCustom);
    expect(peaks.map(p => [p.genome ?? null, p.start, p.end])).toEqual([[null, 160, 180], ['alt', 320, 340]]);
    useBrowserStore.getState().replacePeakSelection([peaks[1].index]);
    const basis = clusterBasis(useBrowserStore.getState());
    expect(basis.kind).toBe('matched');
    expect(basis.regions.map(p => p.match!.blocks)).toEqual([
      [{ frame: [0, 20], genomic: [160, 180] }], [{ frame: [0, 20], genomic: [320, 340] }],
    ]);
    expect(basis.regions[1].match!.reversed).toBe(true);
  } finally { useBrowserStore.setState(initial, true); }
});
