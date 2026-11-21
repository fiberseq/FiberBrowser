/**
 * Graph follow-ups (A14) item 1: an inversion whose core is a palindromic walk (P+, P-) anchors on that core and used
 * to read as two crossed substitutions (PHASE_D agy 2a). The layout's second pass recognises it as one inversion.
 * Fixtures are synthetic topologies in the helper's shape (every shared node's direct matches, both parities).
 */
import { describe, expect, it } from 'vitest';
import palindromic from './__fixtures__/followups/palindromic_inversion.topology.json';
import crossedCore from './__fixtures__/followups/crossed_core.topology.json';
import familyPalindrome from './__fixtures__/followups/family_palindrome.topology.json';
import { buildLayout, type GroupItem, type Item, type LayoutModel, type RunItem } from './layout';
import { buildScene, describeSceneHit, placementAt, sceneInverse, type Prim, type Scene } from './scene';
import type { GraphBinding, GraphTopology } from './types';

type Fixture = { topology: unknown; bindings: unknown };
const model = (f: Fixture) => buildLayout(f.topology as GraphTopology, f.bindings as GraphBinding[]);
const COLORS = { ref: '#334155', target: '#334155', mat: '#c2410c', pat: '#1d4ed8', alt: '#0f766e' };
const scene = (m: LayoutModel, reversed = false, smallBp = 0) => buildScene(m, {
  width: 1200, gutter: 52, rightPad: 6, rulerHeight: 30, laneHeight: 34, laneGap: 4, compression: 'log', reversed, colors: COLORS, smallBp,
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
const tubes = (s: Scene) => s.prims.filter((p): p is Extract<Prim, { t: 'tube' }> => p.t === 'tube');

describe('Graph follow-ups: palindromic-core inversions', () => {
  it('an inversion with a palindromic core (P+, P-) is one inversion, not two crossed substitutions', () => {
    const m = model(palindromic);
    // MAT (plus) and ALT (a minus comparison) walk B- P+ P- A- where the target walks A+ P+ P- B+: one allele.
    for (const lane of ['mat', 'alt']) {
      expect(alleles(m, lane).map(({ g, a }) => [g.target, a.bp, a.status, Boolean(a.inverted), a.visits.length, a.carriers]))
        .toEqual([[{ start: 900, end: 1090 }, 190, 'ok', true, 4, ['mat', 'alt']]]);
    }
    // PAT's two unrelated substitutions next to the same core stay two substitutions (nested in the inversion's slot).
    expect(alleles(m, 'pat').map(({ g, a }) => [g.target, a.bp, Boolean(a.inverted)])).toEqual([
      [{ start: 900, end: 960 }, 60, false], [{ start: 1020, end: 1090 }, 70, false],
    ]);
    expect(m.stats).toMatchObject({ inversions: 1, substitutions: 2, unresolved: 0, complex: 0 });
    // The core runs on the base allele for the target and PAT only: MAT and ALT walk it inside their inversion.
    const inv = alleles(m, 'mat')[0].g;
    expect(inv.base.carriers).toEqual(['ref', 'pat']);
    const core = inv.base.chain.filter((i): i is RunItem => i.kind === 'run');
    expect(core.map(r => [r.target, r.carriers])).toEqual([[{ start: 960, end: 1020 }, ['ref', 'pat']]]);
    // Everywhere outside it MAT and ALT share the target tube.
    for (const r of m.chain.filter((i): i is RunItem => i.kind === 'run')) expect(r.carriers).toEqual(['ref', 'mat', 'pat', 'alt']);
  });

  it('is drawn with the inversion geometry: chevrons against the target, strand-flip connectors, mirrored chevrons', () => {
    const m = model(palindromic);
    const a = alleles(m, 'mat')[0].a;
    for (const reversed of [false, true]) {
      const s = scene(m, reversed);
      expect(tubes(s).filter(p => p.arrows != null).map(p => p.arrows)).toEqual([reversed ? 1 : -1]);
      for (const o of s.occurrences.filter(x => x.owner === a.id)) {
        const l = placementAt(s, o.x0 + 1e-3, a.id)!, r = placementAt(s, o.x1 - 1e-3, a.id)!;
        expect(l.offset > r.offset).toBe(!reversed);
      }
    }
    const s = scene(m);
    const tube = tubes(s).find(p => p.arrows === -1)!;
    const curves = s.prims.filter((p): p is Extract<Prim, { t: 'curve' }> => p.t === 'curve' && p.color === COLORS.mat);
    expect(curves.some(c => Math.abs(c.x1 - tube.x1) < 1e-6)).toBe(true);
    expect(curves.some(c => Math.abs(c.x0 - tube.x0) < 1e-6)).toBe(true);
    const h = s.hits.find(x => x.payload.kind === 'allele' && x.payload.allele === a)!;
    expect(describeSceneHit(h, (h.x0 + h.x1) / 2, m)).toMatch(/^MAT, ALT · inversion of 190 bp: walks target 900-1,090 \(190 bp\) in reverse/);
    // Over the core, MAT's lane resolves to MAT's own visit of P inside its inversion, never to the target tube.
    const row = s.rows.find(r => r.key === 'mat')!;
    const inv = sceneInverse(s, (tube.x0 + tube.x1) / 2, tube.y + tube.h / 2)!;
    expect(tube.y >= row.top && tube.y + tube.h <= row.top + row.height).toBe(true);
    expect(inv.kind).toBe('allele');
    if (inv.kind === 'allele') {
      expect(inv.path).toBe('mat');
      expect(a.visits.slice(1, 3).map(v => v.occ.id)).toContain(inv.occurrence);
    }
    // Never folded into marks, whatever the threshold.
    expect(scene(m, false, 500).blocks.some(b => b.id === alleles(m, 'mat')[0].g.id && b.kind === 'group:bubble')).toBe(true);
  });

  it('crossed substitutions around a core that is not its own reverse stay two substitutions', () => {
    const m = model(crossedCore);
    expect(alleles(m, 'mat').map(({ g, a }) => [g.target, a.bp, Boolean(a.inverted)])).toEqual([
      [{ start: 900, end: 960 }, 70, false], [{ start: 1020, end: 1090 }, 60, false],
    ]);
    expect(m.stats).toMatchObject({ inversions: 0, substitutions: 2, unresolved: 0 });
  });

  it('inside an insertion family the member\'s palindromic-core inversion is one inversion too', () => {
    const m = model(familyPalindrome);
    const [ins] = groups(m.chain).filter(g => g.depth === 0);
    expect(ins.alts.map(a => [a.carriers, a.bp, a.family?.members.map(x => x.carriers)])).toEqual([[['mat'], 190, [['pat']]]]);
    const inner = groups(ins.alts[0].family!.chain);
    expect(inner.map(g => g.alts.map(a => [a.carriers, a.bp, Boolean(a.inverted)]))).toEqual([[[['pat'], 190, true]]]);
    expect(m.stats).toMatchObject({ inversions: 1, substitutions: 0, unresolved: 0 });
  });
});
