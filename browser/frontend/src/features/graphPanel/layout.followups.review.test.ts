/**
 * Graph follow-ups (A14) review regressions (agy round 1): palindromic-core inversions with repeated arms or several
 * cores, per-piece verdicts after the target-allele alignment, repeat visits from the final placement, and the
 * heaviest shared chain. Small walk topologies in the helper's shape (direct matches of every shared node).
 */
import { describe, expect, it } from 'vitest';
import { buildLayout, type GroupItem, type Item, type LayoutModel } from './layout';
import { buildScene, type Prim } from './scene';
import type { GraphBinding, GraphTopology } from './types';

/** A topology from node lengths and signed walks (target first), with every shared node's direct matches. */
function fromWalks(nodes: Record<string, number>, walks: Record<string, string[]>): { topology: GraphTopology; bindings: GraphBinding[] } {
  const paths = Object.entries(walks).map(([binding, walk]) => {
    let at = 0;
    const occurrences = walk.map((step, j) => {
      const node = step.replace('-', ''), len = nodes[node];
      const o = { id: `${binding}.${j}`, fragment: `${binding}#f`, node, handle: node, reverse: step.startsWith('-'), path_span: { start: at, end: at + len }, clip: { start: 0, end: len } };
      at += len;
      return o;
    });
    return { binding, windows: [{ start: 0, end: at }], coverage: [{ span: { start: 0, end: at }, kind: 'covered', fragment: `${binding}#f` }], occurrences, plan: null, complete: true };
  });
  const target = paths[0];
  const direct_matches = paths.slice(1).flatMap(p => p.occurrences.flatMap(o => target.occurrences.filter(t => t.node === o.node).map(t => ({
    target_occurrence: t.id, source_occurrence: o.id, source_binding: p.binding, reverse: o.reverse !== t.reverse, provenance: 'direct_named_walk',
  }))));
  const end = target.occurrences.at(-1)!.path_span.end;
  return {
    topology: { target: target.binding, interval: { start: 0, end }, nodes: Object.entries(nodes).map(([id, length]) => ({ id, length, selected: true, context: false })),
      edges: [], paths, direct_matches, target_queries: [], summaries: [], complete: true, correspondence_complete: true, timings: {} } as unknown as GraphTopology,
    bindings: [],
  };
}
const build = (f: ReturnType<typeof fromWalks>) => buildLayout(f.topology, f.bindings);
function groups(items: Item[], out: GroupItem[] = []): GroupItem[] {
  for (const it of items) {
    if (it.kind !== 'group') continue;
    out.push(it);
    groups(it.base.chain, out);
    for (const a of it.alts) if (a.family) groups(a.family.chain, out);
  }
  return out;
}
const matAlleles = (m: LayoutModel) => groups(m.chain).flatMap(g => g.alts.filter(a => a.carriers.includes('mat')).map(a => [g.target, a.bp, a.status, Boolean(a.inverted)]));
const onTarget = (m: LayoutModel, path: string, at: number) => m.chain.some(i => i.kind === 'run' && i.carriers.includes(path) && i.target!.start <= at && at < i.target!.end)
  || groups(m.chain).some(g => g.base.chain.some(i => i.kind === 'run' && i.carriers.includes(path) && i.target!.start <= at && at < i.target!.end));
const COLORS = { ref: '#334155', mat: '#c2410c', pat: '#1d4ed8', target: '#334155' };
const arcs = (m: LayoutModel) => buildScene(m, { width: 1200, gutter: 52, rightPad: 6, rulerHeight: 30, laneHeight: 34, laneGap: 4, compression: 'log', reversed: false, colors: COLORS, smallBp: 0 })
  .prims.filter((p): p is Extract<Prim, { t: 'arc' }> => p.t === 'arc');

describe('Graph follow-ups review regressions', () => {
  it('agy 2A: arms with a repeated node (each a local inversion) still make one palindromic-core inversion', () => {
    const m = build(fromWalks({ L: 500, X: 150, A: 50, P: 30, B: 70, R: 500 },
      { ref: ['L', 'X', 'A', 'P', '-P', 'A', 'B', 'R'], mat: ['L', '-B', '-A', 'P', '-P', '-A', '-X', 'R'] }));
    expect(matAlleles(m)).toEqual([[{ start: 500, end: 880 }, 380, 'ok', true]]);
    expect(m.stats).toMatchObject({ inversions: 1, unresolved: 0 });
    expect(onTarget(m, 'mat', 700)).toBe(false);
    // Arms that are each a placed inversion: one inversion too.
    const m2 = build(fromWalks({ L: 500, A: 60, P: 30, R: 500 }, { ref: ['L', 'A', 'P', '-P', 'A', 'R'], mat: ['L', '-A', 'P', '-P', '-A', 'R'] }));
    expect(matAlleles(m2)).toEqual([[{ start: 500, end: 680 }, 180, 'ok', true]]);
  });

  it('agy 2C: an inversion over several palindromic cores is one inversion (the longest reversed run)', () => {
    const m = build(fromWalks({ L: 500, A: 60, P: 30, B: 70, Q: 30, R: 500 }, {
      ref: ['L', 'A', 'P', '-P', 'B', 'Q', '-Q', 'A', 'P', '-P', 'B', 'R'], mat: ['L', '-B', 'P', '-P', '-A', 'Q', '-Q', '-B', 'P', '-P', '-A', 'R'] }));
    expect(matAlleles(m)).toEqual([[{ start: 500, end: 940 }, 440, 'ok', true]]);
    expect(onTarget(m, 'mat', 700)).toBe(false);
  });

  it('agy 1A: a piece left after the target-allele alignment gets its own verdict (a placed inversion)', () => {
    const m = build(fromWalks({ L: 500, A: 200, I: 40, X: 80, R: 500 },
      { ref: ['L', 'A', 'I', 'A', '-I', '-I', 'R'], mat: ['L', 'A', '-I', 'A', 'X', 'R'] }));
    expect(matAlleles(m)).toEqual([[{ start: 700, end: 740 }, 40, 'ok', true], [{ start: 940, end: 1020 }, 80, 'ok', false]]);
    expect(m.stats).toMatchObject({ inversions: 1, substitutions: 1, unresolved: 0 });
  });

  it('agy 1B: a local inversion between two copies of a repeat aligns on the target allele', () => {
    const m = build(fromWalks({ L: 500, A: 120, B: 20, R: 500 }, { ref: ['L', 'A', 'B', 'A', 'R'], mat: ['L', 'A', '-B', 'A', 'R'] }));
    expect(matAlleles(m)).toEqual([[{ start: 620, end: 640 }, 20, 'ok', true]]);
    expect(m.stats).toMatchObject({ inversions: 1, unresolved: 0 });
  });

  it('agy 3A: repeat visits follow the final placement (a core taken by an inversion is no anchor)', () => {
    const m = build(fromWalks({ L: 500, A: 60, P: 30, B: 70, M: 500, R: 500 },
      { ref: ['L', 'A', 'P', '-P', 'B', 'M', 'R'], mat: ['L', '-B', 'P', '-P', '-A', 'M', 'P', 'R'] }));
    expect(m.stats).toMatchObject({ inversions: 1, repeats: 0 });
    expect(arcs(m)).toEqual([]);
    const m2 = build(fromWalks({ P: 30, L: 500, A: 60, B: 70, R: 500 },
      { ref: ['P', 'L', 'A', 'P', '-P', 'B', 'R'], mat: ['P', 'L', '-B', 'P', '-P', '-A', 'R'] }));
    expect(m2.stats).toMatchObject({ inversions: 1, repeats: 2 });
  });

  it('agy 3B: copies anchored by the target-allele alignment number the others as repeat visits', () => {
    const m = build(fromWalks({ L: 500, A: 120, B: 20, C: 20, M: 500, R: 500 },
      { ref: ['L', 'A', 'B', 'A', 'M', 'R'], mat: ['L', 'A', 'C', 'A', 'M', 'A', 'A', 'A', 'R'] }));
    expect(m.stats.repeats).toBe(3);
    expect(m.summaries.some(t => t.includes('walks node A 5 times here: visits beyond 4 are not unrolled'))).toBe(true);
  });

  it('agy 4: the alignment keeps the heaviest shared chain, not the one with most visits', () => {
    const m = build(fromWalks({ L: 500, S: 2, BIG: 500, R: 500 },
      { ref: ['L', 'S', 'S', 'S', 'BIG', 'BIG', 'R'], mat: ['L', 'BIG', 'BIG', 'S', 'S', 'S', 'R'] }));
    // BIG BIG run on the target; the three 2 bp S copies are a deletion before and an insertion after them.
    expect(onTarget(m, 'mat', 600)).toBe(true);
    expect(onTarget(m, 'mat', 1100)).toBe(true);
    expect(matAlleles(m)).toEqual([[{ start: 500, end: 506 }, 0, 'ok', false], [{ start: 1506, end: 1506 }, 6, 'ok', false]]);
  });

  // ------------------------------------------------------------------ agy round 2
  const inverted = (m: LayoutModel) => groups(m.chain).flatMap(g => g.alts.flatMap(a => [a, ...(a.family?.members ?? [])]).filter(a => a.inverted));

  it('agy r2 1a: a forward walk of a palindromic target stretch is never an inversion (tandem copies, identical walks)', () => {
    const tandem = build(fromWalks({ L: 400, M: 200, P: 80, Q: 60, N: 200, R: 400 }, {
      ref: ['L', 'M', 'P', 'M', 'P', 'Q', '-Q', '-P', 'N', '-P', 'N', 'R'],
      mat: ['L', 'M', 'P', 'P', 'M', 'P', 'Q', '-Q', '-P', 'N', '-P', '-P', 'N', 'R'] }));
    expect(inverted(tandem)).toEqual([]);
    expect(tandem.stats.inversions).toBe(0);
    const walk = ['L', 'P', '-P', 'P', '-P', 'P', '-P', 'P', '-P', 'P', '-P', 'Q', '-Q', 'P', '-P', 'P', '-P', 'P', '-P', 'P', '-P', 'P', '-P', 'R'];
    const same = build(fromWalks({ L: 2000, P: 30, Q: 50, R: 2000 }, { ref: walk, mat: walk }));
    expect(inverted(same)).toEqual([]);
    expect(same.stats.inversions).toBe(0);
  });

  it('agy r2 1b: inside an insertion family, a member walking the lead\'s palindromic stretch forward is no inversion', () => {
    const m = build(fromWalks({ L: 400, P: 80, M: 200, Q: 60, N: 200, X: 1, Y: 1, R: 400 }, {
      ref: ['L', 'R'], mat: ['L', 'P', '-P', 'M', 'P', 'Q', '-Q', '-P', 'N', 'X', 'R'], pat: ['L', 'P', '-P', 'M', 'P', 'Q', '-Q', '-P', 'N', 'Y', 'R'] }));
    expect(inverted(m)).toEqual([]);
    expect(m.stats.inversions).toBe(0);
  });

  it('agy r2 1c: forward palindromic flanks around a palindromic-core inversion stay outside it', () => {
    const m = build(fromWalks({ L: 400, M: 150, P: 80, X: 90, A: 60, Q: 40, B: 70, N: 150, R: 400 }, {
      ref: ['L', 'M', 'P', 'M', 'P', 'X', 'A', 'Q', '-Q', 'B', '-X', '-P', 'N', '-P', 'N', 'R'],
      mat: ['L', 'M', 'P', 'P', 'M', 'P', 'X', '-B', 'Q', '-Q', '-A', '-X', '-P', 'N', '-P', '-P', 'N', 'R'] }));
    const inv = inverted(m);
    expect(inv.map(a => [a.bp, a.visits.map(v => `${v.occ.node}${v.reverse ? '-' : '+'}`)])).toEqual([[210, ['B-', 'Q+', 'Q-', 'A-']]]);
    // MAT stays on the target over its forward flank X.
    const x = (m.chain.find(i => i.kind === 'run' && i.visits.some(v => v.occ.node === 'X')) as Extract<Item, { kind: 'run' }> | undefined)
      ?? groups(m.chain).flatMap(g => g.base.chain).find(i => i.kind === 'run' && i.visits.some(v => v.occ.node === 'X')) as Extract<Item, { kind: 'run' }>;
    expect(x.carriers).toContain('mat');
  });

  it('agy r2 2: alternate families keep the heaviest shared chain (bp), as the target-allele alignment does', () => {
    for (const [s, famBp] of [[2, 1000], [130, 1000]] as const) {
      const m = build(fromWalks({ L: 400, S1: s, S2: s, BIG: 1000, R: 400 }, {
        ref: ['L', 'R'], mat: ['L', 'S1', 'S2', 'BIG', 'R'], pat: ['L', 'BIG', 'S1', 'S2', 'R'] }));
      const [g] = groups(m.chain);
      const lead = g.alts.find(a => a.family)!;
      expect(lead).toBeTruthy();
      expect(lead.family!.members).toHaveLength(1);
      // BIG runs once, on the family tube; S1 S2 are the sub-bubbles.
      expect(lead.family!.chain.filter(i => i.kind === 'run').reduce((t, r) => t + r.bp, 0)).toBe(famBp);
    }
  });

  // ------------------------------------------------------------------ agy round 3
  const sig = (a: { visits: { occ: { node: string }; reverse: boolean }[] }) => a.visits.map(v => `${v.occ.node}${v.reverse ? '-' : '+'}`);

  it('agy r3: forward flanks inside the outer differences are trimmed onto the base, the inversion keeps its core', () => {
    // Distinct arms, no anchored spacer between the forward flank P and the inversion (r2 1c without X).
    const noX = build(fromWalks({ L: 400, M: 150, P: 80, A: 60, Q: 40, B: 70, N: 150, R: 400 }, {
      ref: ['L', 'M', 'P', 'M', 'P', 'A', 'Q', '-Q', 'B', '-P', 'N', '-P', 'N', 'R'],
      mat: ['L', 'M', 'P', 'P', 'M', 'P', '-B', 'Q', '-Q', '-A', '-P', 'N', '-P', '-P', 'N', 'R'] }));
    expect(inverted(noX).map(a => [a.bp, sig(a)])).toEqual([[210, ['B-', 'Q+', 'Q-', 'A-']]]);
    // Repeated arms, the flank longer than the arm (r1 2A with flanks): one inversion, nothing unresolved.
    const local = build(fromWalks({ L: 400, M: 150, P: 80, A: 60, Q: 40, N: 150, R: 400 }, {
      ref: ['L', 'M', 'P', 'M', 'P', 'A', 'Q', '-Q', 'A', '-P', 'N', '-P', 'N', 'R'],
      mat: ['L', 'M', 'P', 'P', 'M', 'P', '-A', 'Q', '-Q', '-A', '-P', 'N', '-P', '-P', 'N', 'R'] }));
    expect(inverted(local).map(a => [a.bp, sig(a)])).toEqual([[200, ['A-', 'Q+', 'Q-', 'A-']]]);
    expect(local.stats).toMatchObject({ inversions: 1, unresolved: 0 });
    // Five copies of the flank pair on both sides, no other difference: one inversion, no repeat visits, MAT on P.
    const five = build(fromWalks({ L: 400, P: 40, M: 150, A: 120, Q: 30, N: 150, R: 400 }, {
      ref: ['L', 'P', '-P', 'P', '-P', 'P', '-P', 'P', '-P', 'M', 'P', 'A', 'Q', '-Q', 'A', '-P', 'N', 'R'],
      mat: ['L', 'P', '-P', 'P', '-P', 'P', '-P', 'P', '-P', 'M', 'P', '-A', 'Q', '-Q', '-A', '-P', 'N', 'R'] }));
    expect(five.stats).toMatchObject({ inversions: 1, repeats: 0, substitutions: 0, unresolved: 0 });
    expect(inverted(five).map(a => [a.bp, sig(a)])).toEqual([[300, ['A-', 'Q+', 'Q-', 'A-']]]);
    expect(onTarget(five, 'mat', 400 + 8 * 40 + 150 + 10)).toBe(true);   // the forward P after M
  });

  it('agy r3: inside an insertion family the member\'s inversion is trimmed the same way, matching a peer panel led by MAT', () => {
    const nodes = { L: 400, P: 40, M: 200, A: 120, Q: 30, N: 200, R: 400 };
    const mat = ['L', 'P', '-P', 'M', 'P', 'A', 'Q', '-Q', 'A', '-P', 'N', 'R'], pat = ['L', 'P', '-P', 'M', 'P', '-A', 'Q', '-Q', '-A', '-P', 'N', 'R'];
    const fam = build(fromWalks(nodes, { ref: ['L', 'R'], mat, pat }));
    expect(inverted(fam).map(a => [a.carriers, a.bp, sig(a)])).toEqual([[['pat'], 300, ['A-', 'Q+', 'Q-', 'A-']]]);
    expect(fam.stats.inversions).toBe(1);
    const peer = build(fromWalks(nodes, { mat, pat }));
    expect(inverted(peer).map(a => [a.carriers, a.bp, sig(a)])).toEqual([[['pat'], 300, ['A-', 'Q+', 'Q-', 'A-']]]);
    expect(peer.stats).toMatchObject({ inversions: 1, unresolved: 0, repeats: 0 });
  });
});

