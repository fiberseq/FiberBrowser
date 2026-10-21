/**
 * Graph primary G7 (DESIGN_GRAPH_PRIMARY §6): fill-height rows shared across sub-bands, density strips in rows
 * reserved above a sampled band, the strip placed along its path's walk, and the band's disclosure.
 */
import { describe, expect, it } from 'vitest';
import alu10k from './__fixtures__/gateC/alu_10k.topology.json';
import { buildLayout } from './layout';
import { buildScene } from './scene';
import { placementIndex, placeRead, type PlacedMolecule } from './readGeometry';
import { allocateRows, packMemberBands, STRIP_ROWS, type BandMember } from './memberBands';
import { bandDisclosure, bandSampled, placeStrip } from './densityStrip';
import { clusterCounts } from './readCanvas';
import type { GraphBinding, GraphRead, GraphTopology } from './types';

describe('allocateRows (fill height)', () => {
  it('gives every band what it needs when they fit, else equal shares with the rest to the larger bands', () => {
    expect(allocateRows([5, 10], 100)).toEqual([5, 10]);
    expect(allocateRows([5, 100, 100], 65)).toEqual([5, 30, 30]);
    expect(allocateRows([40, 40, 40, 40], 8)).toEqual([3, 3, 3, 3]);   // at least 3 each, even past the height
  });
});

describe('strip rows', () => {
  const mol = (q: string, x0: number): PlacedMolecule => ({
    read: { k: `d|0|${q}|r`, d: 'd', lib: 0, q, rec: 'r', b: 'mat', c: '', st: '+', sup: false, s: x0, e: x0 + 50, cov: [], ins: [], hap: 'MAT' } as GraphRead,
    lane: 'mat', visits: [], body: [{ x0, x1: x0 + 50, s0: x0, s1: x0 + 50, occ: 'o', dir: 1 }], calls: [], m6a: [], density: [], ins: [], holes: [],
    connectors: [], extent: [x0, x0 + 50], unplacedBp: 0,
  });
  const M: BandMember = { panelId: 'mat', stateKey: 'k-mat', datasetId: 'd', liftHap: 'MAT', binding: 'mat', label: 'MAT', color: '#111' };
  const mols = Array.from({ length: 10 }, (_, i) => mol(`q${i}`, 0));

  it('are reserved at the band start, out of its rows, and never count as clusters', () => {
    const lanes = packMemberBands(mols, [M], { mat: { assignments: Object.fromEntries(mols.map((m, i) => [m.read.q, i % 2])) } }, 8, 'position', 3,
      () => STRIP_ROWS);
    const lane = lanes.get('mat')!;
    const g = lane.groups[0];
    expect(g.stripRows).toBe(STRIP_ROWS);
    expect(lane.rows.length).toBe(8);
    expect(lane.rows.slice(0, STRIP_ROWS).every(r => r.length === 0)).toBe(true);
    expect(g.hidden).toBe(10 - (8 - STRIP_ROWS));
    // (Every molecule starts at 0: one per row; cluster 0 first fills the band's 5 rows.)
    expect(clusterCounts(lane, g.startRow + STRIP_ROWS, g.rowCount - STRIP_ROWS)).toBe('C0 5');
  });

  it('per-band row counts (a function of lane and member)', () => {
    const lanes = packMemberBands(mols, [M], {}, (lane, member) => (lane === 'mat' && member === 'mat' ? 4 : 1));
    expect(lanes.get('mat')!.rows.length).toBe(4);
  });
});

describe('placeStrip', () => {
  const f = alu10k as unknown as { topology: GraphTopology; bindings: GraphBinding[] };
  const model = buildLayout(f.topology, f.bindings);
  const sc = buildScene(model, { width: 1400, gutter: 52, rightPad: 6, rulerHeight: 30, laneHeight: 28, laneGap: 4, compression: 'log',
    reversed: false, colors: {}, smallBp: 0 });
  const index = placementIndex(sc, f.topology);

  it('places bins where a read body over the same bases goes', () => {
    const w = f.topology.paths.find(p => p.binding === 'target')!.windows[0];
    const a = w.start + 1000, b = a + 400;
    const strip = { dataset_id: 'n', binding: 'target', bp: 100, windows: [[a, b, [4, 4, 0, 2], [1, 2, 0, 0], [3, 2, 0, 2]] as [number, number, number[], number[], number[]]] };
    const bins = placeStrip(strip, index);
    // (A bin may be several pieces where the walk splits it at node boundaries.) The empty bin is not drawn.
    expect(new Set(bins.map(x => x.cov))).toEqual(new Set([4, 2]));
    const body = placeRead({ k: 'x', d: 'n', lib: 0, q: 'x', rec: '', b: 'target', c: '', st: '+', sup: false, s: a, e: a + 100,
      cov: [[a, a + 100, 0, 1]], ins: [] }, index).body;
    const first = bins.filter(x => x.acc === 1);   // the first bin's pieces
    expect(Math.min(...first.map(x => x.x0))).toBeCloseTo(Math.min(...body.map(p => p.x0)), 5);
    expect(Math.max(...first.map(x => x.x1))).toBeCloseTo(Math.max(...body.map(p => p.x1)), 5);
  });
});

describe('disclosure', () => {
  it('says how many molecules of how many, the sampling and the rows', () => {
    const band = { dataset_id: 'd', binding: 'pat', estimated: 1240, quota: 150, level: 3, fraction: 0.125, decoded: 150, capped: 0, molecules: 140 };
    expect(bandSampled(band)).toBe(true);
    expect(bandDisclosure('PAT', 140, band, 38, 0)).toBe('PAT · 140 of 1,240 molecules · sampled 1/8 by name · 38 rows');
    expect(bandDisclosure('MAT', 12, { ...band, estimated: 12, level: 0 }, 12, 0)).toBe('MAT · 12 molecules · 12 rows');
    expect(bandSampled({ ...band, level: 0 })).toBe(false);
  });
});
