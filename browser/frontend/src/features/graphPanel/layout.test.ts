/**
 * Gate C (DESIGN_GRAPH_PANEL.md §7, "C–D: joint layout"): scene and hit fixtures on topologies the real native
 * helper produced (graphlift tests/graph_layout_fixtures.rs: the alu toy package and synthetic graphs prepared by
 * the real `prepare`, so every map is a generated graphlift sidecar with inferred fills and absorbed tiny anchors).
 * Plus the Phase B continuity regressions, now asserted on the joint layout.
 */
import { describe, expect, it } from 'vitest';
import alu800 from './__fixtures__/gateC/alu_800.topology.json';
import alu10k from './__fixtures__/gateC/alu_10k.topology.json';
import aluEdgeLeft from './__fixtures__/gateC/alu_edge_left.topology.json';
import aluEdgeRight from './__fixtures__/gateC/alu_edge_right.topology.json';
import aluPanA from './__fixtures__/gateC/alu_pan_a.topology.json';
import aluPanB from './__fixtures__/gateC/alu_pan_b.topology.json';
import snpDel from './__fixtures__/gateC/snp_del.topology.json';
import snpPanA from './__fixtures__/gateC/snp_del_pan_a.topology.json';
import snpPanB from './__fixtures__/gateC/snp_del_pan_b.topology.json';
import nested3 from './__fixtures__/gateC/nested3.topology.json';
import nested4 from './__fixtures__/gateC/nested4.topology.json';
import seg1 from './__fixtures__/gateC/segment_1x1000.topology.json';
import seg10 from './__fixtures__/gateC/segment_10x100.topology.json';
import repeatVisit from './__fixtures__/gateC/repeat_visit.topology.json';
import touching from './__fixtures__/gateC/touching_fragments.topology.json';
import crossing from './__fixtures__/gateC/crossing.topology.json';
import fragmentGap from './__fixtures__/gateC/fragment_gap.topology.json';
import flip from './__fixtures__/flip.topology.json';
import { buildLayout, familyCarriers, type AltAllele, type GroupItem, type Item, type JunctionItem, type LayoutModel, type RunItem } from './layout';
import {
  budget, buildScene, CURVE_PX, describeSceneHit, layoutWidth, MIN_SLOT_PX, sceneHitAt, sceneInverse, targetAtX, xForTarget,
  type Compression, type Scene, type SceneHit,
} from './scene';
import type { GraphBinding, GraphTopology } from './types';

type Fixture = { topology: unknown; bindings: unknown };
const model = (f: Fixture) => buildLayout(f.topology as GraphTopology, f.bindings as GraphBinding[]);
const COLORS = { target: '#334155', ref: '#334155', mat: '#c2410c', pat: '#1d4ed8', alt: '#0f766e' };
const scene = (m: LayoutModel, width = 1200, compression: Compression = 'log', reversed = false) => buildScene(m, {
  width, gutter: 52, rightPad: 6, rulerHeight: 30, laneHeight: 28, laneGap: 4, compression, reversed, colors: COLORS,
});

/** Every group, depth-first, with the lane-level families' sub-groups. */
function groups(items: Item[], out: GroupItem[] = []): GroupItem[] {
  for (const it of items) {
    if (it.kind !== 'group') continue;
    out.push(it);
    groups(it.base.chain, out);
    for (const a of it.alts) if (a.family) groups(a.family.chain, out);
  }
  return out;
}
const topGroups = (m: LayoutModel) => m.chain.filter((i): i is GroupItem => i.kind === 'group');
const atTarget = (m: LayoutModel, start: number, end = start) => groups(m.chain).filter(g => g.target?.start === start && g.target?.end === end);
const lane = (s: Scene, key: string) => s.rows.find(r => r.key === key)!;
const hitsOf = (s: Scene, kind: SceneHit['payload']['kind']) => s.hits.filter(h => h.payload.kind === kind);
const alleleHit = (s: Scene, key: string, pred: (a: AltAllele) => boolean) =>
  s.hits.find(h => h.payload.kind === 'allele' && h.payload.lane === key && pred(h.payload.allele))!;
const mid = (h: SceneHit) => [(h.x0 + h.x1) / 2, (h.y0 + h.y1) / 2] as const;

describe('Gate C: SNP and deletion (real map with an inferred fill and an absorbed tiny anchor)', () => {
  const m = model(snpDel);
  const s = scene(m);
  it('an SNP is one 1 bp bubble; the inferred map fill plays no part in the anchors', () => {
    const plan = (snpDel.topology as any).paths[1].plan;
    expect(plan.candidates.some((c: any) => c.correspondence === 'inferred_fill' && c.target.start === 900)).toBe(true);
    expect(m.correspondenceComplete).toBe(false);
    const [snp] = atTarget(m, 900, 901);
    expect(snp.base).toMatchObject({ carriers: ['ref', 'pat'], bp: 1 });
    expect(snp.alts.map(a => [a.carriers, a.bp, a.status])).toEqual([[['mat'], 1, 'ok']]);
    const h = alleleHit(s, 'mat', a => a.id === snp.alts[0].id);
    expect(describeSceneHit(h, mid(h)[0], m)).toContain('1 bp in place of target 900-901');
  });
  it('a deletion is an empty allele with a bypass and its true length', () => {
    const [del] = atTarget(m, 1601, 1921);
    expect(del.base).toMatchObject({ carriers: ['ref', 'mat'], bp: 320 });
    expect(del.alts.map(a => [a.carriers, a.bp])).toEqual([[['pat'], 0]]);
    const h = alleleHit(s, 'pat', a => a.id === del.alts[0].id);
    expect(describeSceneHit(h, mid(h)[0], m)).toBe('PAT · deletion of 320 bp (target 1,601-1,921)');
    expect(s.prims.some(p => p.t === 'text' && p.text === '−320 bp')).toBe(true);
  });
  it('the 4 bp shared node graphlift absorbed between opposite indels is kept as a direct anchor', () => {
    const plan = (snpDel.topology as any).paths[1].plan;
    expect(plan.candidates.some((c: any) => c.correspondence === 'unresolved' && c.target.start === 2721 && c.target.end === 2865)).toBe(true);
    const runs = m.chain.filter((i): i is RunItem => i.kind === 'run');
    expect(runs.find(r => r.target?.start === 2861)).toMatchObject({ bp: 4, carriers: ['ref', 'mat', 'pat'] });
    expect(atTarget(m, 2721, 2861)[0].alts[0]).toMatchObject({ carriers: ['mat'], bp: 0 });
    expect(atTarget(m, 2865)[0].alts[0]).toMatchObject({ carriers: ['mat'], bp: 120 });
    expect(m.stats).toMatchObject({ insertions: 1, deletions: 2, substitutions: 1, complex: 0, unplaced: 0 });
  });
  it('target-backed hits invert to true coordinates; the cursor is only on target sequence', () => {
    for (const t of [10, 450, 899, 900, 1000, 1700, 2863, 3700]) {
      // Where base t starts ('end': after a slot or bubble edge at that coordinate).
      const x = xForTarget(s.targetMap, t, 'end')!;
      expect(targetAtX(s.targetMap, x + 1e-6)?.pos).toBe(t);
      const inv = sceneInverse(s, x + 1e-6, lane(s, 'ref').center);
      expect(inv).toMatchObject({ kind: 'target', pos: t });
    }
  });
});

describe('Gate C: the MAT/PAT Alu insertion takes one slot', () => {
  for (const [name, fixture] of [['800 bp', alu800], ['10 kb', alu10k], ['window starting at 97,395', aluEdgeRight], ['window ending at 97,395', aluEdgeLeft]] as const) {
    it(`one group at 97,395 with an empty target allele and both alleles (${name})`, () => {
      const m = model(fixture);
      const at = atTarget(m, 97_395);
      expect(at).toHaveLength(1);
      const [alu] = at;
      expect(alu.depth).toBe(0);
      expect(alu.base).toMatchObject({ carriers: ['target'], bp: 0 });
      // MAT leads; PAT's copy shares its nodes: one family, drawn once, with the small differences as sub-bubbles.
      expect(alu.alts).toHaveLength(1);
      const lead = alu.alts[0];
      expect(lead).toMatchObject({ carriers: ['mat'], bp: 2353 });
      expect(lead.source).toEqual([{ path: 'mat', span: { start: 94_676, end: 97_029 } }]);
      expect(lead.family!.members.map(x => [x.carriers, x.bp, x.source[0].span])).toEqual([[['pat'], 2350, { start: 95_686, end: 98_036 }]]);
      const shared = lead.family!.chain.filter((i): i is RunItem => i.kind === 'run' && i.carriers.join() === 'mat,pat');
      expect(shared.reduce((t, r) => t + r.bp, 0)).toBeGreaterThan(2300);
      // Never two serial slots or coincident parent/child bubbles at that boundary.
      expect(groups(m.chain).filter(g => g.target?.start === 97_395 && g.target?.end === 97_395)).toHaveLength(1);
      expect(m.openEnds.filter(e => e.reason === 'unplaced')).toEqual([]);
    });
  }
  it('hover: each lane says its own insertion at the boundary; the slot has no target base', () => {
    const m = model(alu800);
    const s = scene(m);
    const [alu] = atTarget(m, 97_395);
    for (const [key, bp] of [['mat', '2,353'], ['pat', '2,350']] as const) {
      const h = s.hits.filter(x => x.payload.kind === 'allele' && x.payload.lane === key && x.payload.group === alu).at(-1)!;
      const [x, y] = mid(h);
      const top = sceneHitAt(s, x, y)!;
      expect(describeSceneHit(top, x, m)).toContain(`insertion of ${bp} bp at target boundary 97,395`);
      expect(top.cursor).toBe(false);
      expect(sceneInverse(s, x, y)).toMatchObject({ kind: 'allele', path: key, boundary: 97_395 });
    }
    const slot = hitsOf(s, 'slot').find(h => h.payload.kind === 'slot' && h.payload.group === alu)!;
    expect(sceneInverse(s, ...mid(slot))).toEqual({ kind: 'connector', group: alu.id, boundary: 97_395 });
    expect(targetAtX(s.targetMap, mid(slot)[0])).toMatchObject({ pos: 97_395, boundary: true });
    // Its x range is the slot: the base allele's coordinate on both sides is the boundary itself.
    expect(xForTarget(s.targetMap, 97_395, 'start')).toBeCloseTo(slot.x0);
    expect(xForTarget(s.targetMap, 97_395, 'end')).toBeCloseTo(slot.x1);
    expect(s.prims.filter(p => p.t === 'text' && /^\+2,35[03] bp$/.test(p.text)).map(p => (p as any).text).sort()).toEqual(['+2,350 bp', '+2,353 bp']);
  });
  it('the slot budget is the longest allele, compressed once', () => {
    const m = model(alu800);
    const s = scene(m);
    const [alu] = atTarget(m, 97_395);
    const w = layoutWidth(alu, s.scale, 'log');
    const lead = alu.alts[0];
    const chain = lead.family!.chain.reduce((t, it) => t + layoutWidth(it, s.scale, 'log'), 0);
    expect(s.metrics).toEqual({ min: MIN_SLOT_PX, curve: CURVE_PX });
    expect(w).toBeCloseTo(Math.max(MIN_SLOT_PX, chain) + 2 * CURVE_PX, 6);
  });
});

describe('Gate C: nested three- and four-path intervals, the child budget counted once', () => {
  it('three paths: PAT\'s SNP is a child inside MAT\'s deletion, on the base allele', () => {
    const m = model(nested3);
    const top = topGroups(m);
    expect(top).toHaveLength(1);
    const parent = top[0];
    expect(parent.target).toEqual({ start: 800, end: 1761 });
    expect(parent.base.carriers).toEqual(['ref', 'pat']);
    expect(parent.alts.map(a => [a.carriers, a.bp])).toEqual([[['mat'], 0]]);
    const kids = parent.base.chain.filter((i): i is GroupItem => i.kind === 'group');
    expect(kids.map(k => [k.depth, k.target, k.base.carriers, k.alts.map(a => a.carriers)])).toEqual([
      [1, { start: 1360, end: 1361 }, ['ref'], [['pat']]],
    ]);
    // MAT is on the parent's alternate allele there: elsewhere, not unavailable.
    expect(kids[0].unavailable).toEqual([]);
  });
  it('four paths: ALT\'s insertion and PAT\'s SNP at one boundary are both children, insertion first', () => {
    const m = model(nested4);
    const [parent] = topGroups(m);
    expect(parent.base.carriers).toEqual(['ref', 'pat', 'alt']);
    const kids = parent.base.chain.filter((i): i is GroupItem => i.kind === 'group');
    expect(kids.map(k => [k.target, k.base.carriers, k.alts.map(a => [a.carriers, a.bp])])).toEqual([
      [{ start: 1360, end: 1360 }, ['ref', 'pat'], [[['alt'], 150]]],
      [{ start: 1360, end: 1361 }, ['ref', 'alt'], [[['pat'], 1]]],
    ]);
    const s = scene(m);
    // The parent's width is its base chain (children inside, once) plus its curve zones; the top level holds the
    // parent only — the children are not budgeted again outside it.
    const base = parent.base.chain.reduce((t, it) => t + layoutWidth(it, s.scale, 'log'), 0);
    expect(layoutWidth(parent, s.scale, 'log')).toBeCloseTo(base + 2 * CURVE_PX, 6);
    const ins = kids[0];
    expect(layoutWidth(ins, s.scale, 'log')).toBeCloseTo(Math.max(MIN_SLOT_PX, budget(150, 'log') * s.scale) + 2 * CURVE_PX, 6);
    expect(s.blocks.map(b => b.kind)).toEqual(['run', 'group:bubble', 'run']);
    const total = s.blocks.reduce((t, b) => t + (b.x1 - b.x0), 0);
    expect(total).toBeCloseTo(s.dataWidth, 3);
    // Hover each lane at the insertion: ALT's own allele; at the parent, MAT's deletion.
    const altHit = alleleHit(s, 'alt', a => a.bp === 150);
    expect(describeSceneHit(altHit, mid(altHit)[0], m)).toContain('ALT · insertion of 150 bp at target boundary 1,360');
    const matHit = alleleHit(s, 'mat', a => a.bp === 0);
    expect(describeSceneHit(matHit, mid(matHit)[0], m)).toContain('MAT · deletion of 961 bp (target 800-1,761)');
  });
});

describe('Gate C: equivalent segmentation (1 × 1,000 bp versus 10 × 100 bp)', () => {
  it('a 1,000 bp insertion and a 1,000 bp shared flank take the same width either way', () => {
    const a = model(seg1), b = model(seg10);
    for (const m of [a, b]) {
      const [ins] = topGroups(m);
      expect(ins.alts[0].bp).toBe(1000);
      expect(m.chain[0]).toMatchObject({ kind: 'run', bp: 1000 });
    }
    expect(budget(1000, 'log')).toBeCloseTo(432.19, 2);
    const sa = scene(a), sb = scene(b);
    expect(sa.scale).toBeCloseTo(sb.scale, 9);
    expect(sb.blocks.map(x => [x.kind, +x.x0.toFixed(6), +x.x1.toFixed(6)])).toEqual(sa.blocks.map(x => [x.kind, +x.x0.toFixed(6), +x.x1.toFixed(6)]));
    // The ten nodes are cut lines inside one tube, not ten budgets.
    const tubes = (s: Scene) => s.prims.filter(p => p.t === 'tube');
    expect(tubes(sa).length).toBe(tubes(sb).length);
    expect(Math.max(...tubes(sb).map(t => (t as any).nodes.length))).toBe(9);
  });
});

describe('Gate C: repeated boundary coordinates on distinct visits', () => {
  it('two insertions flanked by the same node R stay distinct visits with distinct keys', () => {
    const m = model(repeatVisit);
    const g = topGroups(m);
    expect(g.map(x => [x.target, x.alts.map(a => [a.carriers, a.bp])])).toEqual([
      [{ start: 1000, end: 1000 }, [[['pat'], 60]]],
      [{ start: 1800, end: 1800 }, [[['mat'], 90]]],
    ]);
    const topo = repeatVisit.topology as any;
    const rVisits = topo.paths[0].occurrences.filter((o: any) => o.node === '2').map((o: any) => o.id);
    expect(rVisits).toHaveLength(2);
    // PAT's insertion follows the first R visit, MAT's the second: the left keys are the next target visits.
    expect(g[0].leftKey).not.toBe(g[1].leftKey);
    expect(g[0].id).not.toBe(g[1].id);
    expect(m.stats.anchors).toEqual({ mat: 5, pat: 5 });
  });
  it('touching fragments: the junction coordinate on two fragments is never one boundary', () => {
    const m = model(touching);
    const j = m.chain.find((i): i is JunctionItem => i.kind === 'junction')!;
    expect(j).toMatchObject({ gap: null, target: { start: 1400, end: 1400 }, leftEnd: 'fragment_terminal', rightEnd: 'fragment_terminal' });
    expect(j.alts.map(a => [a.carriers, a.bp, a.status])).toEqual([[['mat'], 80, 'junction']]);
    expect(topGroups(m)).toEqual([]);
    const s = scene(m);
    expect(s.prims.filter(p => p.t === 'mark')).toHaveLength(2);
    const h = alleleHit(s, 'mat', a => a.bp === 80);
    expect(describeSceneHit(h, mid(h)[0], m)).toContain('across a target fragment junction at 1,400');
  });
});

describe('Gate C: a crossing collapses locally', () => {
  const m = model(crossing);
  it('crossing deletions become one complex block; the separate SNP stays a bubble', () => {
    const top = topGroups(m);
    expect(top.map(g => [g.type, g.target])).toEqual([['complex', { start: 800, end: 1280 }], ['bubble', { start: 1980, end: 1981 }]]);
    const cx = top[0];
    expect(cx.alts.map(a => a.carriers[0])).toEqual(['mat', 'pat']);
    // What each path is known to walk inside stays visible on the base.
    const runs = cx.base.chain.filter((i): i is RunItem => i.kind === 'run').map(r => [r.target, r.carriers]);
    expect(runs).toEqual([[{ start: 800, end: 950 }, ['ref', 'pat']], [{ start: 950, end: 1110 }, ['ref']], [{ start: 1110, end: 1280 }, ['ref', 'mat']]]);
    expect(top[1].alts[0]).toMatchObject({ carriers: ['mat'], bp: 1, status: 'ok' });
    const s = scene(m);
    const h = hitsOf(s, 'complex')[0];
    expect(describeSceneHit(h, mid(h)[0], m)).toContain('Complex region target 800-1,280 (480 bp on the target) · crossing intervals');
    expect(s.prims.some(p => p.t === 'frame')).toBe(true);
    expect(m.stats.complex).toBe(1);
  });
});

describe('Gate C: fragment gaps and open ends', () => {
  const m = model(fragmentGap);
  const s = scene(m);
  it('a target graph gap is its own block; continuous paths walk across it, a fragment end is capped', () => {
    const j = m.chain.find((i): i is JunctionItem => i.kind === 'junction')!;
    expect(j.gap).toMatchObject({ kind: 'graph_gap', span: { start: 1500, end: 6500 } });
    expect(j.alts.map(a => [a.carriers, a.bp])).toEqual([[['mat', 'pat'], 0]]);
    expect(m.openEnds).toEqual([{ path: 'pat', side: 'right', at: 7200, reason: 'fragment_terminal', bp: 0, source: null }]);
    expect(m.complete).toBe(false);
    expect(m.summaries.join(' ')).toContain('missing flanks');
    const gapHit = hitsOf(s, 'gap')[0];
    expect(describeSceneHit(gapHit, mid(gapHit)[0], m)).toContain('graph gap 1,500-6,500 (5,000 bp) · walking on: MAT+PAT');
    expect(sceneInverse(s, ...mid(gapHit))).toEqual({ kind: 'gap', span: { start: 1500, end: 6500 } });
    const g = s.prims.find(p => p.t === 'gap')!;
    const x = xForTarget(s.targetMap, 4000)!;
    expect(x).toBeGreaterThan((g as any).x0);
    expect(x).toBeLessThan((g as any).x1);
    const end = hitsOf(s, 'end')[0];
    expect(describeSceneHit(end, mid(end)[0], m)).toBe('PAT · its fragment ends at target 7,200');
    // PAT's stripe is absent after its end.
    const after = m.chain.filter((i): i is RunItem => i.kind === 'run' && (i.target?.start ?? 0) >= 7200);
    expect(after.every(r => !r.carriers.includes('pat'))).toBe(true);
  });
});

describe('Gate C: deterministic pans', () => {
  const overlapIds = (m: LayoutModel, lo: number, hi: number) => groups(m.chain)
    .filter(g => g.target && g.target.start >= lo && g.target.end <= hi && g.depth === 0)
    .map(g => [g.id, g.target, g.alts.map(a => [a.id, familyCarriers(a, m.rows.map(r => r.key)), a.bp])]);
  it('the same response gives the same scene', () => {
    expect(scene(model(alu800))).toEqual(scene(model(alu800)));
  });
  for (const [name, a, b, lo, hi] of [['alu', aluPanA, aluPanB, 96_501, 97_999], ['snp_del', snpPanA, snpPanB, 701, 2_200]] as const) {
    it(`bubbles in the overlap keep their identities, alleles and lanes (${name})`, () => {
      const ma = model(a), mb = model(b);
      const ia = overlapIds(ma, lo, hi), ib = overlapIds(mb, lo, hi);
      expect(ia.length).toBeGreaterThan(0);
      expect(ib).toEqual(ia);
    });
  }
});

describe('scene transforms', () => {
  it('a reversed panel mirrors the finished scene once; coordinates and hits round-trip', () => {
    const m = model(alu800);
    const f = scene(m), r = scene(m, 1200, 'log', true);
    for (const t of [97_000, 97_219, 97_300, 97_394, 97_500, 97_799]) {
      const xf = xForTarget(f.targetMap, t)!, xr = xForTarget(r.targetMap, t, 'start', true)!;
      expect(xr).toBeCloseTo(f.dataLeft + (f.dataLeft + f.dataWidth) - xf, 6);
      expect(targetAtX(r.targetMap, xr - 1e-6)?.pos).toBe(t);
    }
    const [alu] = atTarget(m, 97_395);
    const hf = alleleHit(f, 'mat', a => a === alu.alts[0]), hr = alleleHit(r, 'mat', a => a === alu.alts[0]);
    expect(hr.x0).toBeCloseTo(f.dataLeft + f.dataLeft + f.dataWidth - hf.x1, 6);
  });
  it('true-bp widths: runs in proportion to bp, insertions still with a slot', () => {
    const m = model(seg1);
    const s = scene(m, 1200, 'linear');
    const [run, ins, tail] = s.blocks;
    expect(run.x1 - run.x0).toBeCloseTo(1000 * s.scale, 6);
    expect(ins.x1 - ins.x0).toBeCloseTo(1000 * s.scale + 2 * CURVE_PX, 6);
    expect(tail.x1 - tail.x0).toBeCloseTo(800 * s.scale, 6);
  });
  it('many small bubbles in a narrow panel cluster; the Alu (≥ 100 bp) never does', () => {
    const m = model(alu10k);
    const narrow = scene(m, 420);
    expect(narrow.clusters).toBeGreaterThan(0);
    expect(narrow.blocks.some(b => b.kind === 'group:bubble' && b.id === atTarget(m, 97_395)[0].id)).toBe(true);
    const c = hitsOf(narrow, 'cluster')[0];
    expect(describeSceneHit(c, mid(c)[0], m)).toMatch(/^\d+ small variants in target [\d,]+-[\d,]+ .* zoom in to separate them$/);
    // At an ordinary width the bubbles only compact their curve zones.
    const wide = scene(m, 1400);
    expect(wide.clusters).toBe(0);
    expect(wide.metrics.curve).toBeLessThan(CURVE_PX);
  });
  it('flip: a whole minus comparison is the baseline, not an inversion everywhere', () => {
    const m = model(flip);
    expect(m.stats.anchors.mat).toBeGreaterThan(0);
    expect(m.chain.filter(i => i.kind === 'run').every(r => (r as RunItem).carriers.includes('mat'))).toBe(true);
    expect(m.stats.unresolved).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------- Phase B regressions

describe('continuity rules (Phase B reviews), on the joint layout', () => {
  const o = (id: string, node: string, start: number, len: number, fragment = 'f', reverse = false) =>
    ({ id, node, fragment, handle: node, reverse, path_span: { start, end: start + len }, clip: { start: 0, end: len } });
  const clip = (x: any, a: number, b: number) => ({ ...x, clip: { start: a, end: b } });
  const m = (t: string, a: string, reverse = false) => ({ target_occurrence: t, source_occurrence: a, source_binding: 'alt', reverse, provenance: 'direct_named_walk' });
  const topo = (targets: any[], alts: any[], matches: any[], win = { start: 0, end: 300 }, targetCoverage?: any[], summaries: any[] = []): GraphTopology => ({
    target: 'target', interval: win, nodes: [], edges: [], target_queries: [], summaries, complete: false, correspondence_complete: false, timings: {},
    direct_matches: matches,
    paths: [{ binding: 'target', windows: [win], coverage: targetCoverage ?? [{ span: win, kind: 'covered', fragment: targets[0]?.fragment ?? 'f' }], occurrences: targets, complete: true, plan: null },
            { binding: 'alt', windows: [], coverage: [], occurrences: alts, complete: false, plan: null }] } as unknown as GraphTopology);
  const events = (mm: LayoutModel) => groups(mm.chain).flatMap(g => g.alts.filter(a => a.carriers.includes('alt')).map(a => ({ type: g.type, target: g.target, bp: a.bp, base: g.base.bp, status: a.status })));
  const deletions = (mm: LayoutModel) => events(mm).filter(e => e.type === 'bubble' && e.status === 'ok' && e.bp === 0);

  it('a skipped target stretch is a deletion; an edge run is unplaced; a missing tail is a gap', () => {
    const t = topo([o('t1', '1', 0, 100), o('t2', '2', 100, 50), o('t3', '3', 150, 100)],
      [o('a0', '9', 0, 20), o('a1', '1', 20, 100), o('a3', '3', 120, 100)], [m('t1', 'a1'), m('t3', 'a3')],
      { start: 0, end: 300 }, [{ span: { start: 0, end: 250 }, kind: 'covered', fragment: 'f' }, { span: { start: 250, end: 300 }, kind: 'unavailable' }],
      [{ reason: 'wire_limit', span: { start: 250, end: 300 } }]);
    const mm = buildLayout(t, []);
    expect(deletions(mm)).toEqual([{ type: 'bubble', target: { start: 100, end: 150 }, bp: 0, base: 50, status: 'ok' }]);
    expect(mm.openEnds).toEqual([{ path: 'alt', side: 'left', at: 0, reason: 'unplaced', bp: 20, source: { start: 0, end: 20 } }]);
    expect(mm.chain.at(-1)).toMatchObject({ kind: 'junction', gap: { kind: 'unavailable', span: { start: 250, end: 300 } } });
    expect(mm.complete).toBe(false);
    expect(mm.summaries[0]).toContain('wire limit');
    // A visit matched to two target visits with nothing to choose between them is not placed.
    t.direct_matches.push(m('t2', 'a3'));
    const rep = buildLayout(t, []);
    expect(rep.stats.anchors.alt).toBe(1);
    expect(deletions(rep)).toEqual([]);
    expect(rep.openEnds.map(e => [e.side, e.reason, e.bp])).toEqual([['left', 'unplaced', 20], ['right', 'unplaced', 100]]);
  });
  it('no event is asserted across a fragment change, a window clip, a target gap or adjacent fragments', () => {
    const frag = buildLayout(topo([o('t1', '1', 0, 100), o('t2', '2', 100, 50), o('t3', '3', 150, 100)],
      [o('a1', '1', 0, 100, 'f1'), o('a3', '3', 200, 100, 'f2')], [m('t1', 'a1'), m('t3', 'a3')]), []);
    expect(deletions(frag)).toEqual([]);
    expect(events(frag)).toEqual([{ type: 'bubble', target: { start: 100, end: 150 }, bp: 0, base: 50, status: 'unresolved' }]);
    const clipped = buildLayout(topo([clip(o('t1', '1', 0, 200), 0, 50), clip(o('t1b', '1', 0, 200), 150, 200)],
      [clip(o('a1', '1', 0, 200), 0, 50), clip(o('a1b', '1', 200, 200), 150, 200)], [m('t1', 'a1'), m('t1b', 'a1b')], { start: 0, end: 400 }), []);
    expect(deletions(clipped)).toEqual([]);
    const targetGap = buildLayout(topo([o('t1', '1', 0, 100), o('t3', '3', 150, 100)],
      [o('a1', '1', 0, 100), o('a3', '3', 100, 100)], [m('t1', 'a1'), m('t3', 'a3')], { start: 0, end: 300 },
      [{ span: { start: 0, end: 100 }, kind: 'covered', fragment: 'f' }, { span: { start: 100, end: 150 }, kind: 'gap' }, { span: { start: 150, end: 300 }, kind: 'covered', fragment: 'f' }]), []);
    expect(deletions(targetGap)).toEqual([]);
    expect(targetGap.chain.find(i => i.kind === 'junction')).toMatchObject({ gap: { span: { start: 100, end: 150 } }, alts: [{ carriers: ['alt'], bp: 0 }] });
    const two = buildLayout(topo([{ ...o('t1', '1', 0, 100), fragment: 'T#a' }, { ...o('t3', '3', 150, 100), fragment: 'T#b' }],
      [o('a1', '1', 0, 100), o('a3', '3', 100, 100)], [m('t1', 'a1'), m('t3', 'a3')], { start: 0, end: 300 },
      [{ span: { start: 0, end: 150 }, kind: 'covered', fragment: 'T#a' }, { span: { start: 150, end: 300 }, kind: 'covered', fragment: 'T#b' }]), []);
    expect(groups(two.chain)).toEqual([]);
    expect(two.chain.filter(i => i.kind === 'junction')).toHaveLength(1);
  });
  it('a local inversion is unresolved (Gate D), never a plain substitution', () => {
    const inv = buildLayout(topo([o('t1', '1', 0, 100), o('t2', '2', 100, 100), o('t3', '3', 200, 100), o('t4', '4', 300, 100)],
      [o('a1', '1', 0, 100), o('a3', '3', 100, 100, 'f', true), o('a2', '2', 200, 100, 'f', true), o('a4', '4', 300, 100)],
      [m('t1', 'a1'), m('t3', 'a3', true), m('t2', 'a2', true), m('t4', 'a4')], { start: 0, end: 400 }), []);
    expect(events(inv)).toEqual([{ type: 'bubble', target: { start: 100, end: 300 }, bp: 200, base: 200, status: 'unresolved' }]);
    expect(inv.stats.substitutions).toBe(0);
    const s = scene(inv);
    const h = s.hits.find(x => x.payload.kind === 'allele')!;
    expect(describeSceneHit(h, mid(h)[0], inv)).toContain('unresolved (a local inversion)');
  });
  it('anchors outside the view place an edge insertion; a duplicated visit is not placed', () => {
    const ctx = buildLayout(topo([clip(o('t1', '1', 900, 200), 100, 200), o('t2', '2', 1100, 100)],
      [o('a1', '1', 900, 200), o('ins', '9', 1100, 300), o('a2', '2', 1400, 100)], [m('t1', 'a1'), m('t2', 'a2')], { start: 1000, end: 1200 }), []);
    expect(events(ctx)).toEqual([{ type: 'bubble', target: { start: 1100, end: 1100 }, bp: 300, base: 0, status: 'ok' }]);
    expect(ctx.chain[0]).toMatchObject({ kind: 'run', bp: 100, target: { start: 1000, end: 1100 } });
    const dup = buildLayout(topo([o('t1', '1', 0, 500)], [o('a1', '1', 0, 500), o('a2', '1', 500, 500)],
      [m('t1', 'a1'), m('t1', 'a2')], { start: 0, end: 500 }), []);
    expect(dup.stats.anchors.alt).toBe(0);
    expect(dup.openEnds.map(e => [e.reason, e.bp])).toEqual([['unplaced', 1000]]);
  });
});
