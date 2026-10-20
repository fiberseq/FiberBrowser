/**
 * Gate D (DESIGN_GRAPH_PANEL.md §7, "C–D: joint layout"): relative inversions, repeats and occurrence transforms,
 * plus the small-difference marks. Every topology is real helper output (graphlift tests/graph_layout_fixtures.rs:
 * synthetic graphs prepared by the real `prepare`, and the flip toy package), so the maps are generated graphlift
 * sidecars: the 40 bp inversion has no minus piece, the 330 bp one a split chain.
 */
import { describe, expect, it } from 'vitest';
import inv40 from './__fixtures__/gateD/inv40.topology.json';
import invSplit from './__fixtures__/gateD/inv_split.topology.json';
import invInMinus from './__fixtures__/gateD/inv_in_minus.topology.json';
import mixedSigns from './__fixtures__/gateD/mixed_signs.topology.json';
import tandemDup from './__fixtures__/gateD/tandem_dup.topology.json';
import repeatNested from './__fixtures__/gateD/repeat_nested.topology.json';
import flip4k from './__fixtures__/gateD/flip_4k.topology.json';
import alu10k from './__fixtures__/gateC/alu_10k.topology.json';
import alu800 from './__fixtures__/gateC/alu_800.topology.json';
import snpDel from './__fixtures__/gateC/snp_del.topology.json';
import nested4 from './__fixtures__/gateC/nested4.topology.json';
import crossing from './__fixtures__/gateC/crossing.topology.json';
import fragmentGap from './__fixtures__/gateC/fragment_gap.topology.json';
import repeatVisit from './__fixtures__/gateC/repeat_visit.topology.json';
import { buildLayout, type AltAllele, type GroupItem, type Item, type LayoutModel } from './layout';
import {
  buildScene, describeSceneHit, foldMarks, placementAt, sceneHitAt, sceneInverse, smallDifferenceBp, targetAtX, xForOccurrence,
  type Prim, type Scene, type SceneHit,
} from './scene';
import type { GraphBinding, GraphTopology } from './types';

type Fixture = { topology: unknown; bindings: unknown };
const model = (f: Fixture) => buildLayout(f.topology as GraphTopology, f.bindings as GraphBinding[]);
const COLORS = { target: '#334155', ref: '#334155', mat: '#c2410c', pat: '#1d4ed8', alt: '#0f766e' };
const scene = (m: LayoutModel, opts: { width?: number; reversed?: boolean; smallBp?: number } = {}) => buildScene(m, {
  width: opts.width ?? 1200, gutter: 52, rightPad: 6, rulerHeight: 30, laneHeight: 28, laneGap: 4, compression: 'log',
  reversed: opts.reversed ?? false, colors: COLORS, smallBp: opts.smallBp ?? 0,
});

function groups(items: Item[], out: GroupItem[] = []): GroupItem[] {
  for (const it of items) {
    if (it.kind !== 'group') continue;
    out.push(it);
    groups(it.base.chain, out);
    for (const a of it.alts) if (a.family) groups(a.family.chain, out);
  }
  return out;
}
const alleles = (m: LayoutModel, path: string) => groups(m.chain).flatMap(g => g.alts.flatMap(a => [a, ...(a.family?.members ?? [])])
  .filter(a => a.carriers.includes(path)).map(a => ({ g, a })));
const minusPieces = (f: Fixture, key: string) => ((f.topology as any).paths.find((p: any) => p.binding === key).plan?.candidates ?? [])
  .filter((c: any) => c.strands.includes('-')).length;
const mid = (h: SceneHit) => [(h.x0 + h.x1) / 2, (h.y0 + h.y1) / 2] as const;
const allelePrimsIn = (s: Scene, lane: string) => {
  const row = s.rows.find(r => r.key === lane)!;
  return s.prims.filter((p): p is Extract<Prim, { t: 'tube' }> => p.t === 'tube' && p.y >= row.top && p.y + p.h <= row.top + row.height);
};

// ---------------------------------------------------------------------------------------------------- inversions

describe('Gate D: relative inversions', () => {
  it('a 40 bp local inversion with no minus piece is placed from the direct reverse matches', () => {
    expect(minusPieces(inv40, 'mat')).toBe(0);
    const m = model(inv40);
    const inv = alleles(m, 'mat');
    expect(inv.map(({ g, a }) => [g.target, a.bp, a.status, a.inverted])).toEqual([[{ start: 900, end: 940 }, 40, 'ok', true]]);
    expect(m.stats).toMatchObject({ inversions: 1, unresolved: 0, substitutions: 1 });   // PAT's SNP is the substitution
    const s = scene(m);
    const h = s.hits.find(x => x.payload.kind === 'allele' && x.payload.allele.inverted)!;
    expect(describeSceneHit(h, mid(h)[0], m)).toBe(`MAT · inversion of 40 bp: walks target 900-940 (40 bp) in reverse · source MAT ${h.payload.kind === 'allele' ? h.payload.allele.source[0].span.start.toLocaleString('en-US') : ''}-${h.payload.kind === 'allele' ? h.payload.allele.source[0].span.end.toLocaleString('en-US') : ''}`);
    // Drawn with chevrons and strand-flip connectors (in to its far end, out of its near end).
    const tube = allelePrimsIn(s, 'mat').find(p => p.arrows === -1)!;
    expect(tube).toBeTruthy();
    const curves = s.prims.filter((p): p is Extract<Prim, { t: 'curve' }> => p.t === 'curve' && p.color === COLORS.mat);
    expect(curves.some(c => Math.abs(c.x1 - tube.x1) < 1e-6)).toBe(true);
    expect(curves.some(c => Math.abs(c.x0 - tube.x0) < 1e-6)).toBe(true);
  });

  it('a 330 bp split-chain inversion (a minus map piece) is the same placed allele', () => {
    expect(minusPieces(invSplit, 'mat')).toBeGreaterThan(0);
    const m = model(invSplit);
    expect(alleles(m, 'mat').map(({ g, a }) => [g.target, a.bp, a.inverted, a.visits.length])).toEqual([[{ start: 1000, end: 1330 }, 330, true, 3]]);
    expect(alleles(m, 'pat')).toEqual([]);
    expect(m.stats).toMatchObject({ inversions: 1, unresolved: 0, substitutions: 0, complex: 0 });
  });

  it('an inversion inside an already minus comparison is relative to that baseline', () => {
    const m = model(invInMinus);
    // MAT's baseline is the minus comparison: its visits are listed against its own direction.
    const inv = alleles(m, 'mat');
    expect(inv.map(({ g, a }) => [g.target, a.bp, a.inverted, a.visits[0].reverse, a.visits[0].backward])).toEqual([[{ start: 1200, end: 1280 }, 80, true, true, true]]);
    expect(m.stats).toMatchObject({ inversions: 1, unresolved: 0, substitutions: 0 });
    // Everywhere else MAT shares the target tube.
    expect(m.chain.filter(i => i.kind === 'run').every(r => r.kind === 'run' && r.carriers.includes('mat'))).toBe(true);
  });

  it('mixed handle signs without a relative inversion: no inversion, nothing unresolved', () => {
    const m = model(mixedSigns);
    expect(m.stats).toMatchObject({ inversions: 0, unresolved: 0, complex: 0, substitutions: 1 });
    expect(alleles(m, 'mat').map(({ a }) => [a.bp, a.inverted ?? false])).toEqual([[1, false]]);
    expect(alleles(m, 'pat')).toEqual([]);
    // PAT, the whole region reversed, is on every shared run.
    expect(m.chain.filter(i => i.kind === 'run').every(r => r.kind === 'run' && r.carriers.includes('pat'))).toBe(true);
  });

  it('an inversion is never a mark, whatever the threshold', () => {
    const m = model(inv40);
    const s = scene(m, { smallBp: 50 });
    const g = alleles(m, 'mat')[0].g;
    expect(s.blocks.some(b => b.id === g.id && b.kind === 'group:bubble')).toBe(true);
    // PAT's SNP is a mark.
    expect(s.prims.some(p => p.t === 'vmark' && p.color === COLORS.pat && p.kind === 'sub')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------- repeats

describe('Gate D: repeats unrolled by occurrence', () => {
  it('tandem copies are repeat visits of the anchored copy, with visit counts and return arcs', () => {
    const m = model(tandemDup);
    const mat = alleles(m, 'mat'), pat = alleles(m, 'pat');
    expect(mat.map(({ g, a }) => [g.target, a.bp, a.visits.map(v => v.repeat && [v.repeat.n, v.repeat.count])])).toEqual([[{ start: 1000, end: 1000 }, 200, [[2, 2]]]]);
    expect(pat.map(({ g, a }) => [g.target, a.bp, a.visits.map(v => v.repeat && [v.repeat.n, v.repeat.count])])).toEqual([[{ start: 1000, end: 1000 }, 400, [[2, 3], [3, 3]]]]);
    // One slot for both (the same flanks), nothing unplaced.
    expect(mat[0].g).toBe(pat[0].g);
    expect(m.stats).toMatchObject({ repeats: 3, unplaced: 0, complex: 0, unresolved: 0 });
    const target = (tandemDup.topology as any).paths[0].occurrences.find((o: any) => o.node === '2');
    expect(mat[0].a.visits[0].repeat!.of).toBe(target.id);
    const s = scene(m);
    const arcs = s.prims.filter((p): p is Extract<Prim, { t: 'arc' }> => p.t === 'arc');
    expect(arcs.length).toBe(3);
    // Each arc ends on the target's R.
    const r = s.occurrences.find(o => o.occ === target.id && o.lane === 'ref')!;
    for (const a of arcs) expect(a.x1).toBeCloseTo((r.x0 + r.x1) / 2, 6);
    expect(new Set(arcs.map(a => a.tier))).toEqual(new Set([0, 1]));
    const h = s.hits.find(x => x.payload.kind === 'allele' && x.payload.lane === 'pat')!;
    expect(describeSceneHit(h, mid(h)[0], m)).toContain('2 repeat visits of node 2 (visit 2 of 3, visit 3 of 3)');
    expect(s.prims.some(p => p.t === 'text' && p.text === '+400 bp · repeat ×3')).toBe(true);
  });

  it('a repeat copy inside a nested group: PAT\'s insertion is a child of MAT\'s deletion, its R a repeat visit', () => {
    const m = model(repeatNested);
    const del = groups(m.chain).find(g => g.alts.some(a => a.carriers.includes('mat') && a.bp === 0))!;
    expect(del.target).toEqual({ start: 800, end: 1750 });
    const child = groups(del.base.chain).find(g => g.alts.some(a => a.carriers.includes('pat')))!;
    expect(child.target).toEqual({ start: 1350, end: 1350 });
    const ins = child.alts.find(a => a.carriers.includes('pat'))!;
    expect(ins.bp).toBe(450);
    expect(ins.visits.map(v => v.repeat && [v.repeat.n, v.repeat.count])).toEqual([undefined, [2, 2]]);
    expect(m.stats).toMatchObject({ repeats: 1, unplaced: 0, complex: 0 });
    expect(scene(m).prims.filter(p => p.t === 'arc')).toHaveLength(1);
  });

  it('the Gate C repeated-boundary fixture is unchanged (no extra repeat visits there)', () => {
    const m = model(repeatVisit);
    expect(m.stats).toMatchObject({ insertions: 2, unplaced: 0, complex: 0 });
  });
});

// ---------------------------------------------------------------------------------------------------- transforms

/** x → (occurrence, offset) → x′ → (occurrence, offset): the same base, within one base width. */
function roundTrips(s: Scene) {
  let checked = 0;
  for (const o of s.occurrences) {
    const span = o.end - o.start;
    for (const f of [0.02, 0.37, 0.5, 0.81, 0.98]) {
      const x = o.x0 + f * (o.x1 - o.x0);
      const at = placementAt(s, x, o.owner, o.lane)!;
      expect(at).not.toBeNull();
      const back = xForOccurrence(s, at.place.occ, at.offset, at.place.lane, at.place.owner)!;
      expect(back).not.toBeNull();
      expect(Math.abs(back - x)).toBeLessThanOrEqual((o.x1 - o.x0) / span + 1e-6);
      const again = placementAt(s, back, o.owner, o.lane)!;
      expect([again.place.occ, again.offset]).toEqual([at.place.occ, at.offset]);
      checked += 1;
    }
  }
  return checked;
}

/** Through the hits: every sequence hit's inverse goes forward to an x whose inverse is the same base. */
function hitRoundTrips(s: Scene) {
  let checked = 0;
  for (const h of s.hits) {
    if (h.payload.kind !== 'run' && h.payload.kind !== 'allele') continue;
    const [x, y] = mid(h);
    if (sceneHitAt(s, x, y) !== h) continue;
    const inv = sceneInverse(s, x, y);
    if (!inv || (inv.kind !== 'target' && inv.kind !== 'allele') || !inv.occurrence) continue;
    const lane = h.payload.kind === 'run' ? h.payload.host : h.payload.lane;
    const owner = h.payload.kind === 'run' ? h.payload.run.id : h.payload.allele.id;
    const back = xForOccurrence(s, inv.occurrence, inv.offset, lane, owner);
    if (back == null) continue;   // a family member's base: drawn in the lead's tube
    const again = sceneInverse(s, back, y);
    expect(again && 'occurrence' in again ? [again.occurrence, again.offset] : null).toEqual([inv.occurrence, inv.offset]);
    if (inv.kind === 'target') {
      // The occurrence transform and the target map agree on target-backed sequence.
      const t = targetAtX(s.targetMap, back);
      expect(t && !t.boundary ? Math.abs(t.pos - inv.pos) : 0).toBeLessThanOrEqual(1);
    }
    checked += 1;
  }
  return checked;
}

describe('Gate D: occurrence transforms and reverse hit round trips', () => {
  const fixtures: [string, Fixture][] = [
    ['inv40', inv40], ['inv_split', invSplit], ['inv_in_minus', invInMinus], ['mixed_signs', mixedSigns], ['tandem_dup', tandemDup],
    ['repeat_nested', repeatNested], ['flip_4k', flip4k], ['alu_10k', alu10k], ['alu_800', alu800], ['snp_del', snpDel],
    ['nested4', nested4], ['crossing', crossing], ['fragment_gap', fragmentGap],
  ];
  for (const [name, f] of fixtures) {
    for (const reversed of [false, true]) {
      for (const smallBp of [0, 50]) {
        it(`${name}: ${reversed ? 'reversed panel' : 'forward'}, ${smallBp ? 'marks' : 'bubbles'}`, () => {
          const s = scene(model(f), { reversed, smallBp });
          expect(roundTrips(s)).toBeGreaterThan(0);
          expect(hitRoundTrips(s)).toBeGreaterThan(0);
        });
      }
    }
  }

  it('an inverted allele and a minus comparison draw path-forward offsets right to left', () => {
    for (const f of [invSplit, invInMinus]) {
      const m = model(f);
      const s = scene(m);
      const a = alleles(m, 'mat')[0].a;
      const pl = s.occurrences.filter(o => o.owner === a.id);
      expect(pl.length).toBe(a.visits.length);
      for (const o of pl) {
        const left = placementAt(s, o.x0 + 0.01, a.id, 'mat')!, right = placementAt(s, o.x1 - 0.01, a.id, 'mat')!;
        expect(left.place.occ).toBe(o.occ);
        // inv_split: a plus path, its inverted allele drawn right to left. inv_in_minus: a minus path (backward),
        // its inverted allele drawn reversed again, so path-forward left to right.
        const expectDecreasing = f === invSplit;
        expect(left.offset > right.offset).toBe(expectDecreasing);
      }
      // Path order of the inverted visits runs right to left (plus path) or left to right (minus path).
      const xs = a.visits.map(v => pl.find(o => o.occ === v.occ.id)!.x0);
      const sorted = [...xs].sort((p, q) => p - q);
      expect(xs).toEqual(f === invSplit ? [...sorted].reverse() : sorted);
    }
  });

  it('flip (whole-minus): an alternate allele\'s offsets decrease left to right; mirrored panels flip it again', () => {
    const m = model(flip4k);
    for (const reversed of [false, true]) {
      const s = scene(m, { reversed });
      const mine = s.occurrences.filter(o => o.lane !== 'target');
      expect(mine.length).toBeGreaterThan(0);
      for (const o of mine) {
        if (o.end - o.start < 2) continue;
        const l = placementAt(s, o.x0 + 1e-3, o.owner, o.lane)!, r = placementAt(s, o.x1 - 1e-3, o.owner, o.lane)!;
        expect(l.offset > r.offset).toBe(!reversed);
      }
      // The target's own visits run path-forward left to right (unless mirrored).
      const t = s.occurrences.find(o => o.lane === 'target' && o.end - o.start > 10)!;
      const l = placementAt(s, t.x0 + 1e-3, t.owner, 'target')!, r = placementAt(s, t.x1 - 1e-3, t.owner, 'target')!;
      expect(l.offset < r.offset).toBe(!reversed);
    }
  });
});

// ---------------------------------------------------------------------------------------------------- marks

describe('small differences as marks on the shared tube', () => {
  it('the threshold scales with zoom: 10–50 bp, bubbles when zoomed in or chosen', () => {
    expect(smallDifferenceBp(10_000, 650)).toBe(50);
    expect(smallDifferenceBp(50_000, 650)).toBe(50);
    expect(smallDifferenceBp(2_000, 650)).toBe(12);
    expect(smallDifferenceBp(1_000, 650)).toBe(0);
    expect(smallDifferenceBp(10_000, 650, 'bubbles')).toBe(0);
  });

  it('an SNP is a tick on MAT\'s stripe, hoverable, while the 320 bp deletion still branches', () => {
    const m = model(snpDel);
    const s = scene(m, { smallBp: 13 });
    const snp = groups(m.chain).find(g => g.target?.start === 900 && g.target.end === 901)!;
    expect(s.blocks.some(b => b.id === snp.id)).toBe(false);
    expect(s.blocks.some(b => b.kind === 'marked')).toBe(true);
    const del = groups(m.chain).find(g => g.target?.start === 1601 && g.target.end === 1921)!;
    expect(s.blocks.find(b => b.id === del.id)?.kind).toBe('group:bubble');
    const tick = s.prims.find((p): p is Extract<Prim, { t: 'vmark' }> => p.t === 'vmark' && p.color === COLORS.mat && p.kind === 'sub')!;
    expect(tick).toBeTruthy();
    // The pin is outside the tube on the stripe's nearer side (MAT is the middle of ref, mat, pat: up; PAT, the
    // bottom stripe, would go down); the hit is at least 8 px wide and wins over the run.
    expect(m.rows.map(r => r.key)).toEqual(['ref', 'mat', 'pat']);
    expect(tick.side).toBe('up');
    expect(tick.y).toBeGreaterThan(tick.ty0);
    const h = s.hits.find(x => x.payload.kind === 'allele' && x.payload.group === snp)!;
    expect(h.x1 - h.x0).toBeGreaterThanOrEqual(8);
    expect(sceneHitAt(s, (h.x0 + h.x1) / 2, h.y1 - 1)).toBe(h);
    expect(describeSceneHit(h, mid(h)[0], m)).toContain('MAT · 1 bp in place of target 900-901');
    // MAT stays on the target tube there: no MAT lane tube for the SNP.
    const matTubes = allelePrimsIn(s, 'mat');
    expect(matTubes.every(p => p.x1 < (h.x0 - 20) || p.x0 > h.x1 + 20)).toBe(true);
    // The target map still covers the SNP's base.
    expect(targetAtX(s.targetMap, (h.x0 + h.x1) / 2)?.pos).toBeCloseTo(900, -1);
  });

  it('the shared MAT/PAT Alu is one tube with both stripes; their copies\' differences are marks on it', () => {
    const m = model(alu10k);
    const s = scene(m, { smallBp: 50 });
    const alu = groups(m.chain).find(g => g.target?.start === 97_395 && g.base.bp === 0)!;
    const lead = alu.alts.find(a => a.family)!;
    expect(lead.carriers).toEqual(['mat']);
    // Inside the family every sub-difference is small: the family chain folds into marked runs only.
    const folded = foldMarks(lead.family!.chain, 50);
    expect(folded.every(i => i.kind === 'run' || i.kind === 'marked')).toBe(true);
    expect(folded.some(i => i.kind === 'marked')).toBe(true);
    // One tube in the lead's lane carries both stripes; PAT's lane has no tube of its own inside the slot.
    const block = s.blocks.find(b => b.id === alu.id)!;
    const inMat = allelePrimsIn(s, 'mat').filter(p => p.x0 >= block.x0 && p.x1 <= block.x1);
    expect(inMat.length).toBeGreaterThan(0);
    expect(inMat.every(p => p.slots.map(x => x.key).join(',') === 'mat,pat')).toBe(true);
    expect(allelePrimsIn(s, 'pat').filter(p => p.x0 >= block.x0 && p.x1 <= block.x1)).toEqual([]);
    // PAT's differences there are marks on its stripe, hoverable as PAT's alleles.
    const patMarks = s.hits.filter(h => h.payload.kind === 'allele' && h.payload.lane === 'pat' && h.x0 >= block.x0 && h.x1 <= block.x1 && h.within);
    expect(patMarks.length).toBeGreaterThan(0);
    // Bubbles mode: the same sub-differences branch into PAT's lane again.
    const b = scene(m, { smallBp: 0 });
    const blockB = b.blocks.find(x => x.id === alu.id)!;
    expect(allelePrimsIn(b, 'pat').filter(p => p.x0 >= blockB.x0 && p.x1 <= blockB.x1).length).toBeGreaterThan(0);
  });

  it('marks keep every allele inspectable: one mark hit per carrier of each small allele', () => {
    const m = model(alu10k);
    const s = scene(m, { smallBp: 50 });
    const small = (g: GroupItem) => g.type === 'bubble' && Math.max(g.base.bp, ...g.alts.map(a => a.bp)) < 50;
    let expected = 0;
    const walk = (items: Item[]) => {
      for (const it of items) {
        if (it.kind !== 'group') continue;
        if (small(it) && groups([it]).every(x => x.alts.every((a: AltAllele) => a.status === 'ok' && !a.inverted))) {
          expected += it.alts.flatMap(a => [a, ...(a.family?.members ?? [])]).reduce((t, a) => t + a.carriers.length, 0);
          continue;
        }
        walk(it.base.chain);
        for (const a of it.alts) if (a.family) walk(a.family.chain);
      }
    };
    walk(m.chain);
    expect(expected).toBeGreaterThan(0);
    expect(s.prims.filter(p => p.t === 'vmark')).toHaveLength(expected);
  });
});
