import { describe, expect, it } from 'vitest';
import { equivalentPeaks, variantPositionBlocks } from './equivalentPositions';
import { clusterBasis, clusterWindows, matchedClusterWindows } from './clusterTargets';
import { useBrowserStore } from '../stores/browserStore';
import type { FirePeak } from '../types';

const member = (label: string, chrom: string, blocks: NonNullable<FirePeak['match']>['blocks'], reversed = false): FirePeak => ({
  index: 0, chrom, start: Math.min(...blocks.map(b => b.genomic[0])), end: Math.max(...blocks.map(b => b.genomic[1])),
  match: { groupId: 'g', label, length: 200, reversed, blocks },
});
const map = variantPositionBlocks(1000, 1200, 1100, 0, 50);
const members = [member('reference', 'ref', map.reference), member('carrier', 'alt', map.alternate)];

describe('equivalent positions', () => {
  it('builds exact insertion and deletion maps without aligning', () => {
    expect(map.alternate).toEqual([{ frame: [0, 100], genomic: [0, 100] }, { frame: [100, 200], genomic: [150, 250] }]);
    const deletion = variantPositionBlocks(1000, 1200, 1100, 50, 0);
    expect(deletion.reference[1]).toEqual({ frame: [150, 200], genomic: [1150, 1200] });
    expect(deletion.alternate[1]).toEqual({ frame: [150, 200], genomic: [100, 150] });
  });
  it('projects both ways with one selection index and keeps the insertion private', () => {
    const forward = equivalentPeaks([{ index: 8, chrom: 'ref', start: 1120, end: 1150 }], [members], 'ref');
    expect(forward.map(p => [p.chrom, p.start, p.end, p.index])).toEqual([['ref', 1120, 1150, 8], ['alt', 170, 200, 8]]);
    expect(equivalentPeaks([{ index: 8, chrom: 'alt', start: 170, end: 200 }], [members], 'ref')).toEqual(forward);
    const privatePeak = { index: 9, chrom: 'alt', start: 110, end: 130 };
    expect(equivalentPeaks([privatePeak], [members], 'ref')).toEqual([privatePeak]);
  });
  it('honours a reversed homology member and an indel', () => {
    const reversed = member('reverse', 'other', [{ frame: [0, 80], genomic: [320, 400] }, { frame: [100, 200], genomic: [200, 300] }], true);
    const peaks = equivalentPeaks([{ index: 1, chrom: 'ref', start: 1120, end: 1150 }], [[members[0], reversed]], 'ref');
    expect(peaks[1]).toMatchObject({ start: 250, end: 280, match: { reversed: true, blocks: [{ frame: [0, 30], genomic: [250, 280] }] } });
    const gap = { index: 2, chrom: 'ref', start: 1080, end: 1090 };
    expect(equivalentPeaks([gap], [[members[0], reversed]], 'ref')).toEqual([gap]);
  });
  it('uses a drawn subfeature, rather than the whole correspondence, for a pooled cluster request', () => {
    const initial = useBrowserStore.getState();
    try {
      useBrowserStore.setState({ chrom: 'ref', start: 1000, end: 1200, peaksByRule: {}, selectedPeaks: new Set(),
        panels: [
          { id: 'a', datasetId: 'd', contentType: 'dataset', collapsed: false, viewportOverride: { chrom: 'ref', start: 1000, end: 1200 } },
          { id: 'b', datasetId: 'e', contentType: 'dataset', collapsed: false, viewportOverride: { chrom: 'alt', start: 0, end: 250 } },
        ] as never });
      useBrowserStore.getState().upsertMatchedGroup({ id: 'g', name: 'Homology', regions: members });
      useBrowserStore.getState().addCustomPeak(1120, 1150, 'ref');
      let s = useBrowserStore.getState();
      const peak = s.getAllPeaks().find(p => p.isCustom)!;
      s.togglePeakSelection(peak.index);
      s = useBrowserStore.getState();
      const basis = clusterBasis(s);
      expect(basis.kind).toBe('matched');
      expect(basis.regions).toHaveLength(2);
      expect(basis.regions.every(p => p.match!.length === 30)).toBe(true);
      const result = matchedClusterWindows(clusterWindows(s, ['d', 'e']), basis.regions);
      expect(result.refusal).toBeNull();
      expect(result.windows.map(w => w.blocks)).toEqual([
        [{ feature: 0, reverse: false, frame: [0, 30], genomic: [1120, 1150] }],
        [{ feature: 0, reverse: false, frame: [0, 30], genomic: [170, 200] }],
      ]);
      s.addCustomPeak(110, 130, 'alt');
      const own = useBrowserStore.getState().getAllPeaks().find(p => p.isCustom && !p.match)!;
      s.replacePeakSelection([peak.index, own.index]);
      const mixed = clusterBasis(useBrowserStore.getState());
      expect(mixed.regions.filter(p => p.match?.memberSpecific)).toHaveLength(1);
      const joint = matchedClusterWindows(clusterWindows(s, ['d', 'e']), mixed.regions);
      expect(joint.refusal).toBeNull();
      expect(joint.windows.map(w => w.blocks.map(b => b.feature))).toEqual([[0], [0, 1]]);
    } finally { useBrowserStore.setState(initial, true); }
  });
});

it('splits a feature at insertion seams and keeps its unmapped piece on its source', () => {
  const projected = equivalentPeaks([{ index: 3, chrom: 'alt', start: 80, end: 170 }], [members], 'ref');
  expect(projected.filter(p => p.match).map(p => [p.chrom, p.start, p.end])).toEqual([
    ['ref', 1080, 1100], ['alt', 80, 100], ['ref', 1100, 1120], ['alt', 150, 170],
  ]);
  expect(projected.filter(p => !p.match)).toEqual([{ index: 3, chrom: 'alt', start: 100, end: 150 }]);
  expect(projected.every(p => p.index === 3)).toBe(true);
});

it('projects a selected region feature through the same correspondence and clusters on its own mode', () => {
  const initial = useBrowserStore.getState();
  try {
    useBrowserStore.setState({ chrom: 'ref', peaksByRule: {}, selectedPeaks: new Set(), selectedFeatures: [],
      peakRules: initial.peakRules.filter(r => r.source !== 'matched') });
    useBrowserStore.getState().upsertMatchedGroup({ id: 'g', name: 'Homology', regions: members });
    useBrowserStore.getState().selectFeature({ kind: 'fp-class', source: 'calls', id: '3', chrom: 'ref', start: 1120, end: 1150 });
    const s = useBrowserStore.getState();
    expect(s.getAllPeaks().filter(p => p.featureIndex !== undefined).map(p => [p.chrom, p.start, p.end])).toEqual([
      ['ref', 1120, 1150], ['alt', 170, 200],
    ]);
    const basis = clusterBasis(s);
    expect(basis.kind).toBe('matched');
    expect(basis.regions.map(p => p.mode)).toEqual(['tf', 'tf']);
  } finally { useBrowserStore.setState(initial, true); }
});

it('preserves a selected peak by position when a rescan inserts a new peak before it', () => {
  const initial = useBrowserStore.getState();
  try {
    useBrowserStore.setState({ peaksByRule: {}, selectedPeaks: new Set() });
    const id = initial.peakRules.find(r => r.source === 'accessibility')!.id;
    initial.setPeaksByRule(id, [{ index: 0, chrom: 'ref', start: 1100, end: 1120 }]);
    const selected = useBrowserStore.getState().peaksByRule[id][0].index;
    initial.replacePeakSelection([selected]);
    initial.setPeaksByRule(id, [{ index: 0, chrom: 'ref', start: 1000, end: 1020 }, { index: 1, chrom: 'ref', start: 1100, end: 1120 }]);
    const s = useBrowserStore.getState();
    expect(s.selectedPeaks.has(s.peaksByRule[id][1].index)).toBe(true);
    expect(s.selectedPeaks.has(s.peaksByRule[id][0].index)).toBe(false);
  } finally { useBrowserStore.setState(initial, true); }
});

it('keeps pooled peaks on the map that called them when correspondences overlap', () => {
  const other = members.map(p => ({ ...p, chrom: p.chrom === 'alt' ? 'other-alt' : p.chrom,
    match: { ...p.match!, groupId: 'other-map' } }));
  const projected = equivalentPeaks([{ index: 1, chrom: 'ref', start: 1120, end: 1150, correspondenceId: 'other-map' }], [members, other], 'ref');
  expect(projected.map(p => p.chrom)).toEqual(['ref', 'other-alt']);
  expect(projected.every(p => p.match!.correspondenceId === 'other-map')).toBe(true);
});

it('keeps the unaligned part of a boundary feature on its source panel', () => {
  const own = members.map((p, i) => ({ ...p, match: { ...p.match!, panelId: `p${i}` } }));
  const projected = equivalentPeaks([{ index: 1, chrom: 'alt', start: 80, end: 170 }], [own], 'ref');
  expect(projected.find(p => !p.match)).toMatchObject({ start: 100, end: 150, memberPanelId: 'p1' });
});

it.each([false, true])('uses half-open block edges and round trips reversed=%s', reversed => {
  const target = member('target', 'other', [{ frame: [0, 100], genomic: [200, 300] }, { frame: [100, 200], genomic: [400, 500] }], reversed);
  for (const [start, end] of [[1000, 1001], [1099, 1100], [1100, 1101], [1199, 1200]]) {
    const pair = equivalentPeaks([{ index: 1, chrom: 'ref', start, end }], [[members[0], target]], 'ref');
    expect(pair).toHaveLength(2);
    expect(pair[1].end - pair[1].start).toBe(1);
    const { match: _m, ...back } = pair[1];
    expect(equivalentPeaks([back], [[members[0], target]], 'ref')[0]).toMatchObject({ start, end });
  }
});

it('projects circular-origin blocks without joining the ends of the contig', () => {
  const circular = { ...member('circle', 'circle', [{ frame: [0, 100], genomic: [900, 1000] }, { frame: [100, 200], genomic: [0, 100] }]), match: {
    ...member('circle', 'circle', [{ frame: [0, 100], genomic: [900, 1000] }, { frame: [100, 200], genomic: [0, 100] }]).match!, wrapsOrigin: true } };
  const result = equivalentPeaks([{ index: 1, chrom: 'ref', start: 1090, end: 1110 }], [[members[0], circular]], 'ref');
  expect(result.filter(p => p.chrom === 'circle').map(p => [p.start, p.end])).toEqual([[990, 1000], [0, 10]]);
});

it('retains selected member-specific region features alongside shared ones', () => {
  const initial = useBrowserStore.getState();
  try {
    useBrowserStore.setState({ chrom: 'ref', peaksByRule: {}, selectedFeatures: [], selectedPeaks: new Set(),
      peakRules: initial.peakRules.filter(r => r.source !== 'matched') });
    const s = useBrowserStore.getState();
    s.upsertMatchedGroup({ id: 'g', name: 'Flanks', regions: members });
    s.selectFeature({ kind: 'fp-class', source: 'calls', id: 'shared', chrom: 'ref', start: 1120, end: 1150 });
    s.selectFeature({ kind: 'fp-class', source: 'calls', id: 'private', chrom: 'alt', start: 110, end: 130 }, true);
    const basis = clusterBasis(useBrowserStore.getState());
    expect(basis.regions.filter(p => p.match?.memberSpecific)).toHaveLength(1);
    expect(basis.unused).toContain('1 member-specific');
  } finally { useBrowserStore.setState(initial, true); }
});
