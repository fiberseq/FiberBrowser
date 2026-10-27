import '../testSetup';
import { describe, expect, it, beforeEach } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useAnalysisRegionStore } from '../../stores/analysisRegionStore';
import { columnPathStatus, displaySpan, graphText, liftChip, liftText, regionOf } from './frames';
import { matchHits, sameFeature, type Matchable } from './matching';
import { normalizeHub, hitSelectionEntry, type HubSelected } from './hubState';
import { scanHitToFeature, scanColumnKey } from './hubData';
import { clusterRegionsOf, goToHits, newAnchorSet, onThisGenome } from './actions';
import { columnSpans, hubGraphOutlines, hubOutlineAt, pathForward } from './graphHits';
import { hubOutlinesFor } from './hubOutlines';
import type { ScanHit, ScanSetInfo } from './api';
import type { FeatureSet, GraphAlias } from './types';
import type { Scene } from '../graphPanel/scene';
import type { GraphTopology } from '../graphPanel/types';

const MAT_FRAME = { kind: 'source' as const, assembly: 'hg002', contig: 'chr3_MATERNAL', hap: 'HG002#2', hapLabel: 'MAT', datasetId: 'lifted' };
const PAT_FRAME = { ...MAT_FRAME, contig: 'chr3_PATERNAL', hap: 'HG002#1', hapLabel: 'PAT' };

const graph = (columns: GraphAlias['columns'], paths: Partial<GraphAlias['paths']> = {}): GraphAlias => ({
  registration: 'g1', target: 'target', binding: 'mat', anchor: [100, 100], columns,
  size: columns.reduce((n, c) => n + c[2] - c[1], 0), paths: paths as GraphAlias['paths'],
});

function hit(key: string, setId: string, over: Partial<Matchable> = {}): Matchable {
  return { key, setId, typeId: 'nfr.region', chrom: 'chr3', start: 1_000, end: 1_200, anchor: 1_100, ...over };
}

describe('display coordinates of hits in other frames (G1)', () => {
  it('places a lifted hit where it lifted and an insertion hit at its junction; an off-map hit nowhere', () => {
    const lifted = { chrom: 'chr3_MATERNAL', start: 50, end: 90, anchor: 70, frame: MAT_FRAME,
      target: { chrom: 'chr3', start: 1_050, end: 1_090, anchor: 1_070 }, lift: { status: 'exact' as const, chrom: 'chr3', start: 1_050, end: 1_090 } };
    expect(displaySpan(lifted)).toEqual({ chrom: 'chr3', start: 1_050, end: 1_090, anchor: 1_070 });
    expect(liftChip(lifted)).toEqual({ text: 'lifted', tone: 'ok' });
    expect(liftText(lifted)).toMatch(/^Lifted from MAT chr3_MATERNAL:51-90 to chr3:1,051-1,090: one placement/);
    const inside = { ...lifted, target: { chrom: 'chr3', start: 2_000, end: 2_000, anchor: 2_000, insertion: true },
      lift: { status: 'unmapped' as const, reason: 'no_projection', junction: [2_000, 2_000] as [number, number] } };
    expect(displaySpan(inside)?.insertion).toBe(true);
    expect(liftChip(inside)?.text).toBe('in insertion');
    expect(liftText(inside)).toMatch(/inside an insertion this genome lacks/);
    expect(regionOf(displaySpan(inside)!)).toEqual({ start: 1_975, end: 2_025 });
    const off = { ...lifted, target: undefined, lift: { status: 'unmapped' as const, reason: 'contig_not_in_map' } };
    expect(displaySpan(off)).toBeNull();
    expect(onThisGenome(off)).toBe(false);
    expect(liftText(off)).toMatch(/does not lift onto this genome \(contig not in map\)/);
    expect(displaySpan({ chrom: 'chr3', start: 5, end: 9, anchor: 7 })).toEqual({ chrom: 'chr3', start: 5, end: 9, anchor: 7 });
  });

  it('a comparison column on a path that lacks the hit says absent; columns off the graph say nothing', () => {
    const g = graph([['n1', 0, 100]], {
      target: { status: 'absent', carried: 0, total: 100, label: 'GRCh38', datasets: ['native'] },
      mat: { status: 'carried', carried: 100, total: 100, label: 'HG002 maternal', datasets: ['lifted'], hap: 'MAT' },
      pat: { status: 'partial', carried: 40, total: 100, label: 'HG002 paternal', datasets: ['lifted'], hap: 'PAT' },
    });
    expect(columnPathStatus(g, { datasetId: 'native' })).toBe('absent');
    expect(columnPathStatus(g, { datasetId: 'lifted', hap: 'MAT' })).toBe('carried');
    expect(columnPathStatus(g, { datasetId: 'lifted', hap: 'PAT' })).toBe('partial');
    expect(columnPathStatus(g, { datasetId: 'lifted' })).toBeUndefined();     // which haplotype: not said
    expect(columnPathStatus(g, { datasetId: 'other' })).toBeUndefined();
    expect(columnPathStatus(undefined, { datasetId: 'native' })).toBeUndefined();
    expect(graphText(g)).toMatch(/GRCh38: absent \(lacks this sequence\); MAT: carries it; PAT: carries part of it \(40 of 100 bp\)/);
  });
});

describe('matching hits across frames (DESIGN §5.4)', () => {
  it('a target-frame hit and a lifted source-frame hit of one feature match (target-aliased)', () => {
    const native = hit('grch38|n1', 'grch38-scan');
    const lifted = hit('hg002|m1', 'hg002-scan', { chrom: 'chr3_MATERNAL', start: 51_000, end: 51_190, anchor: 51_095, frame: MAT_FRAME,
      target: { chrom: 'chr3', start: 1_010, end: 1_200, anchor: 1_105 } });
    expect(sameFeature(native, lifted)).toBe(true);
    expect(matchHits([native, lifted]).get('grch38|n1')).toEqual(['hg002|m1']);
    // Less than half of the shorter one overlapping: not the same feature.
    const shifted = { ...lifted, target: { chrom: 'chr3', start: 1_150, end: 1_400, anchor: 1_275 } };
    expect(sameFeature(native, shifted)).toBe(false);
    // Another type never matches; neither does an unmapped hit with no graph columns.
    expect(sameFeature(native, { ...lifted, typeId: 'fp.class' })).toBe(false);
    expect(sameFeature(native, { ...lifted, target: undefined })).toBe(false);
  });

  it('MAT and PAT hits of one scan match each other; two hits of one frame never do', () => {
    const mat = hit('s|m', 's', { chrom: 'chr3_MATERNAL', frame: MAT_FRAME, target: { chrom: 'chr3', start: 1_000, end: 1_200, anchor: 1_100 } });
    const pat = hit('s|p', 's', { chrom: 'chr3_PATERNAL', frame: PAT_FRAME, target: { chrom: 'chr3', start: 1_020, end: 1_210, anchor: 1_115 } });
    const mat2 = hit('s|m2', 's', { chrom: 'chr3_MATERNAL', frame: MAT_FRAME, target: { chrom: 'chr3', start: 1_000, end: 1_200, anchor: 1_100 } });
    expect(sameFeature(mat, pat)).toBe(true);
    expect(sameFeature(mat, mat2)).toBe(false);
  });

  it('point features match within 20 bp of their anchors', () => {
    const a = hit('a|1', 'a', { start: 500, end: 500, anchor: 500 });
    expect(sameFeature(a, hit('b|1', 'b', { start: 515, end: 515, anchor: 515 }))).toBe(true);
    expect(sameFeature(a, hit('b|2', 'b', { start: 530, end: 530, anchor: 530 }))).toBe(false);
  });

  it('hits inside an insertion match on graph columns only when they share the carried columns', () => {
    const inside = { target: { chrom: 'chr3', start: 2_000, end: 2_000, anchor: 2_000, insertion: true } };
    const mat = hit('s|m', 's', { ...inside, frame: MAT_FRAME, graph: graph([['n1', 0, 60], ['n2', 0, 40]]) });
    const pat = hit('s|p', 's', { ...inside, frame: PAT_FRAME, graph: graph([['n1', 10, 60], ['n2', 0, 40], ['n9', 0, 10]]) });
    const other = hit('s|q', 's', { ...inside, frame: PAT_FRAME, graph: graph([['n7', 0, 100]]) });
    expect(sameFeature(mat, pat)).toBe(true);        // 90 of 100 and 90 of 100 shared
    expect(sameFeature(mat, other)).toBe(false);
    // Insertion junctions are not matched by position (both at 2,000), only by columns.
    expect(sameFeature({ ...mat, graph: undefined }, { ...other, graph: undefined })).toBe(false);
    // Another package's columns never match.
    expect(sameFeature(mat, { ...pat, graph: { ...pat.graph!, registration: 'g2' } })).toBe(false);
  });
});

const SET: ScanSetInfo = {
  setId: 'hub:src', typeId: 'nfr.region', status: 'complete', datasets: ['lifted'], count: 1,
  type: { typeId: 'nfr.region', module: 'nfr', label: 'NFR', plural: 'NFRs', provides: ['hit', 'state'], anchor: 'centre', zeroWidth: false,
    scores: [{ name: 'prevalence', label: 'P', kind: 'fraction', better: 'high', perGroup: true }], roles: { prevalence: 'prevalence' } },
  provenance: { producer: 'fiberhmm-scan', module: 'nfr', inputs: [], units: 'grid' },
  frame: { kind: 'source', assembly: 'hg002', contig: 'chr3_MATERNAL' },
  groups: [{ id: 'all', kind: 'all', label: 'All' }, { id: 'dataset_1', datasetId: 'lifted', kind: 'dataset', label: 'Sample (lifted)', scanDataset: 'dataset_1' }],
  coverage: { territory: 'units' }, source: { kind: 'scan', scanId: 's1', module: 'nfr' },
};

const SOURCE_HIT: ScanHit = {
  hitId: 'nfr:region:chr3_MATERNAL:51100:aaaa', typeId: 'nfr.region', chrom: 'chr3_MATERNAL', start: 51_000, end: 51_200, anchor: 51_100,
  label: '', score: null, flags: [], zeroWidth: false, raw: {}, groupKinds: {}, module: {},
  columns: { all: { prevalence: { v: 0.4 } }, 'dataset_1:MAT': { prevalence: { v: 0.4 } } },
  frame: { kind: 'source', contig: 'chr3_MATERNAL', hap: 'HG002#2', hapLabel: 'MAT', datasetId: 'lifted' },
  source: { chrom: 'chr3_MATERNAL', start: 51_000, end: 51_200, anchor: 51_100 },
  lift: { status: 'partial', chrom: 'chr3', start: 1_000, end: 1_150, placements: 1, flipped: false },
  target: { chrom: 'chr3', start: 1_000, end: 1_150, anchor: 1_080 },
};

describe('source-frame scan hits in the hub', () => {
  beforeEach(() => {
    useBrowserStore.setState({ chrom: 'chr3', start: 0, end: 10_000, datasets: [] } as never);
  });

  it('keep their source coordinates and haplotype, fill the haplotype column, and select with their lift', () => {
    const f = scanHitToFeature(SET, 's1', SOURCE_HIT);
    expect(f.frame).toMatchObject({ kind: 'source', contig: 'chr3_MATERNAL', hapLabel: 'MAT', datasetId: 'lifted' });
    expect([f.chrom, f.start, f.end]).toEqual(['chr3_MATERNAL', 51_000, 51_200]);
    expect(f.lift?.status).toBe('partial');
    expect(scanColumnKey(SET, 'dataset_1:MAT', 's1')).toBe('ds:lifted:MAT');
    expect(f.values?.['ds:lifted:MAT']?.prevalence?.v).toBe(0.4);
    const entry = hitSelectionEntry(SET as unknown as FeatureSet, f);
    expect(entry).toMatchObject({ lift: 'partial', target: { chrom: 'chr3', start: 1_000, end: 1_150 }, hasStates: true });
    // The session keeps the lift and target of a selection entry, and drops malformed ones.
    const back = normalizeHub({ selected: [entry, { ...entry, hitId: 'x', target: { chrom: 'chr3' }, lift: 'bogus' }] }).selected;
    expect(back[0]).toMatchObject({ lift: 'partial', target: { chrom: 'chr3', start: 1_000, end: 1_150, anchor: 1_080 } });
    expect(back[1].target).toBeUndefined();
    expect(back[1].lift).toBeUndefined();
  });

  it('Use as works on them: anchors where they lifted (source kept), cluster regions at the lift or junction, Go to', () => {
    const f = scanHitToFeature(SET, 's1', SOURCE_HIT);
    const entry = hitSelectionEntry(SET as unknown as FeatureSet, f);
    const anchors = newAnchorSet([entry]).anchors;
    expect(anchors[0]).toMatchObject({ chrom: 'chr3', pos: 1_080, start: 1_000, end: 1_150, lift: 'partial',
      source: { chrom: 'chr3_MATERNAL', start: 51_000, end: 51_200 } });
    expect(clusterRegionsOf([entry])).toEqual([expect.objectContaining({ start: 1_000, end: 1_150 })]);
    const inside: HubSelected = { ...entry, hitId: 'in', target: { chrom: 'chr3', start: 2_000, end: 2_000, anchor: 2_000, insertion: true }, lift: 'unmapped' };
    expect(clusterRegionsOf([inside])).toEqual([expect.objectContaining({ start: 1_975, end: 2_025 })]);
    expect(newAnchorSet([inside]).anchors[0]).toMatchObject({ pos: 2_000, insertion: true });
    const off: HubSelected = { ...entry, hitId: 'off', target: undefined, lift: 'unmapped' };
    expect(clusterRegionsOf([off])).toEqual([]);
    expect(goToHits([off])).toMatch(/don't lift onto this genome/);
    expect(goToHits([entry])).toBeNull();
    const st = useBrowserStore.getState();
    expect(st.chrom).toBe('chr3');
    expect(st.start).toBeLessThanOrEqual(1_000);
    expect(st.end).toBeGreaterThanOrEqual(1_150);
  });

  it('selected hits are outlined on this genome and on the source views of their assembly', () => {
    const f = scanHitToFeature(SET, 's1', SOURCE_HIT);
    const entry = hitSelectionEntry(SET as unknown as FeatureSet, f);
    const s = useBrowserStore.getState();
    const outlines = hubOutlinesFor({ ...s, datasets: [{ id: 'lifted' }, { id: 'native' }] as never, panels: [] } as never, [entry]);
    expect(outlines).toHaveLength(1);
    expect(outlines[0]).toMatchObject({ chrom: 'chr3', start: 1_000, end: 1_150, datasetIds: ['lifted', 'native'] });
    expect(useAnalysisRegionStore.getState().outlines).toBeDefined();
  });
});

describe('hub hits on a graph host', () => {
  // Two lanes: the target walks node n1 (40 bp) forward; MAT walks n1 and its own n2 (20 bp), the inserted sequence.
  const topology = {
    nodes: [{ id: 'n1', length: 40 }, { id: 'n2', length: 20 }],
    paths: [{ binding: 'target', occurrences: [{ id: 't1', node: 'n1', reverse: false }] },
      { binding: 'mat', occurrences: [{ id: 'm1', node: 'n1', reverse: false }, { id: 'm2', node: 'n2', reverse: true }] }],
  } as unknown as GraphTopology;
  const scene = {
    rows: [{ key: 'target', top: 0, height: 10, bandTop: 10, bandHeight: 20 }, { key: 'mat', top: 40, height: 10, bandTop: 50, bandHeight: 0 }],
    occurrences: [
      { occ: 't1', node: 'n1', lane: 'target', owner: 'r', x0: 0, x1: 40, start: 0, end: 40, dir: 1, path: 'target' },
      { occ: 'm1', node: 'n1', lane: 'mat', owner: 'r', x0: 0, x1: 40, start: 0, end: 40, dir: 1, path: 'mat' },
      { occ: 'm2', node: 'n2', lane: 'mat', owner: 'a', x0: 40, x1: 80, start: 0, end: 20, dir: 1, path: 'mat' },
    ],
    targetMap: [{ x0: 0, x1: 40, t0: 1_000, t1: 1_040, kind: 'seq' }],
  } as unknown as Scene;

  it('maps node-forward columns to the lanes that draw those nodes (reverse visits mirrored)', () => {
    expect(pathForward(0, 5, 20, true)).toEqual([15, 20]);
    const spans = columnSpans(scene, topology, [['n2', 0, 5]]);
    expect([...spans.keys()]).toEqual(['mat']);
    expect(spans.get('mat')).toEqual([70, 80]);   // n2 is walked reversed: offsets 0..5 are its last 5 drawn bases
    const shared = columnSpans(scene, topology, [['n1', 10, 20]]);
    expect(shared.get('target')).toEqual([10, 20]);
    expect(shared.get('mat')).toEqual([10, 20]);
  });

  it('outlines selected and unselected hits; an insertion hit only on its carriers; a click finds the narrowest', () => {
    const inside = { setId: 's', hitId: 'in', typeId: 'nfr.region', chrom: 'chr3_MATERNAL', start: 5, end: 10, anchor: 7,
      graph: { ...graph([['n2', 0, 5]]), registration: 'g1', target: 'target' } };
    const shared = { setId: 's', hitId: 'sh', typeId: 'nfr.region', chrom: 'chr3', start: 1_010, end: 1_020, anchor: 1_015,
      graph: { ...graph([['n1', 10, 20]]), registration: 'g1', target: 'target', binding: 'target' } };
    const plain = { setId: 's2', hitId: 'p', typeId: 'peaks.peak', chrom: 'chr3', start: 1_000, end: 1_040, anchor: 1_020 };
    const out = hubGraphOutlines(scene, topology, 'g1', 'target', false,
      [{ hit: inside, selected: true }, { hit: shared, selected: false }, { hit: plain, selected: false }]);
    const of = (id: string) => out.filter(o => o.hitId === id);
    expect(of('in').map(o => [o.y0, o.x0, o.x1, o.selected])).toEqual([[40, 70, 80, true]]);
    expect(of('sh').map(o => o.y0).sort()).toEqual([0, 40]);
    expect(of('sh')[0]).toMatchObject({ kind: 'columns', y1: 30 });   // the target lane and its reads band
    expect(of('p')).toEqual([expect.objectContaining({ kind: 'region', x0: 0, x1: 40, y0: 0, y1: 50 })]);
    expect(hubOutlineAt(out, 15, 5)?.hitId).toBe('sh');
    expect(hubOutlineAt(out, 75, 45)?.hitId).toBe('in');
    expect(hubGraphOutlines(scene, topology, 'other', 'target', false, [{ hit: inside, selected: true }])).toEqual([]);
  });
});
