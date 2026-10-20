/**
 * Regressions from the Gate D reviews (native/review/graphD): each case is a small walk topology built in the helper's
 * shape (direct matches of every shared node, both parities), plus the real Alu fixture for carrier identities.
 */
import { describe, expect, it } from 'vitest';
import inv40 from './__fixtures__/gateD/inv40.topology.json';
import alu10k from './__fixtures__/gateC/alu_10k.topology.json';
import { buildLayout, type GroupItem, type Item, type LayoutModel } from './layout';
import { buildScene, placementAt, sceneHitAt, sceneInverse, xForOccurrence, type Prim, type Scene, type SceneHit } from './scene';
import type { GraphBinding, GraphTopology } from './types';

const COLORS = { ref: '#334155', mat: '#c2410c', pat: '#1d4ed8', target: '#334155' };
const scene = (m: LayoutModel, smallBp = 0, reversed = false) => buildScene(m, {
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
const vmarks = (s: Scene) => s.prims.filter((p): p is Extract<Prim, { t: 'vmark' }> => p.t === 'vmark');
const mid = (h: SceneHit) => [(h.x0 + h.x1) / 2, (h.y0 + h.y1) / 2] as const;

describe('Gate D review fixes', () => {
  it('#1: a folded small parent keeps the differences nested in it (each a mark and a hit)', () => {
    const m = build(fromWalks({ L: 800, A: 2, B: 2, C: 2, X: 2, R: 800 }, { ref: ['L', 'A', 'B', 'C', 'R'], mat: ['L', 'R'], pat: ['L', 'A', 'X', 'C', 'R'] }));
    const [del] = groups(m.chain).filter(g => g.alts.some(a => a.carriers.includes('mat')));
    const [sub] = groups(m.chain).filter(g => g.alts.some(a => a.carriers.includes('pat')));
    expect(groups(del.base.chain)).toContain(sub);
    const s = scene(m, 50);
    expect(vmarks(s).map(p => [p.color, p.kind]).sort()).toEqual([[COLORS.pat, 'sub'], [COLORS.mat, 'del']].sort());
    const hits = s.hits.filter(h => h.payload.kind === 'allele');
    expect([...new Set(hits.map(h => h.payload.kind === 'allele' ? `${h.payload.group.id}|${h.payload.lane}` : ''))].sort()).toEqual([`${del.id}|mat`, `${sub.id}|pat`].sort());
    // PAT's mark sits inside MAT's deleted span, at its own position.
    const delMark = vmarks(s).find(p => p.color === COLORS.mat)!, subMark = vmarks(s).find(p => p.color === COLORS.pat)!;
    expect(subMark.x0).toBeGreaterThanOrEqual(delMark.x0 - 1e-6);
    expect(subMark.x1).toBeLessThanOrEqual(delMark.x1 + 1e-6);
  });

  it('#2: every carrier of a shared tube or mark resolves to its own occurrence', () => {
    // Identical SNP in MAT and PAT: one allele, two marks; each mark's inverse is that path's occurrence.
    const snp = build(fromWalks({ L: 800, A: 1, B: 1, R: 800 }, { ref: ['L', 'A', 'R'], mat: ['L', 'B', 'R'], pat: ['L', 'B', 'R'] }));
    const s = scene(snp, 50);
    const marks = s.hits.filter(h => h.payload.kind === 'allele');
    // Each mark is two hit regions (its stripe and its pin): both resolve to that carrier's occurrence.
    expect(marks.map(h => { const [x, y] = mid(h); const inv = sceneInverse(s, x, y); return inv?.kind === 'allele' ? [inv.path, inv.occurrence] : null; }).sort())
      .toEqual([['mat', 'mat.1'], ['mat', 'mat.1'], ['pat', 'pat.1'], ['pat', 'pat.1']]);
    // On the shared target tube, each stripe is its own path's visit of the node (and the target position).
    const run = s.hits.find(h => h.payload.kind === 'run' && h.payload.run.visits[0].occ.node === 'L')!;
    for (const key of ['ref', 'mat', 'pat']) {
      const st = run.payload.kind === 'run' ? run.payload.stripes!.find(x => x.key === key)! : null!;
      const inv = sceneInverse(s, (run.x0 + run.x1) / 2, (st.y0 + st.y1) / 2)!;
      expect(inv.kind).toBe('target');
      if (inv.kind !== 'target') continue;
      expect(inv.carrier?.occurrence ?? inv.occurrence).toBe(`${key}.0`);
      if (key !== 'ref') expect(inv.carrier!.offset).toBe(inv.offset);
    }
    // The real Alu: on the shared MAT/PAT tube, PAT's stripe is a PAT occurrence, MAT's a MAT one.
    const m = buildLayout(alu10k.topology as unknown as GraphTopology, alu10k.bindings as unknown as GraphBinding[]);
    const as = scene(m, 50);
    const ids = (key: string) => new Set((alu10k.topology as any).paths.find((p: any) => p.binding === key).occurrences.map((o: any) => o.id));
    const famRuns = as.hits.filter(h => h.payload.kind === 'run' && h.within && h.payload.stripes && h.payload.stripes.length === 2);
    expect(famRuns.length).toBeGreaterThan(0);
    let checked = 0;
    for (const h of famRuns) {
      if (h.payload.kind !== 'run') continue;
      for (const st of h.payload.stripes!) {
        const x = (h.x0 + h.x1) / 2, y = (st.y0 + st.y1) / 2;
        if (sceneHitAt(as, x, y) !== h) continue;
        const inv = sceneInverse(as, x, y)!;
        expect(inv.kind).toBe('allele');
        if (inv.kind !== 'allele') continue;
        expect(inv.path).toBe(st.key);
        expect(ids(st.key).has(inv.occurrence)).toBe(true);
        // Round trip through the forward transform of that path's occurrence.
        const back = xForOccurrence(as, inv.occurrence!, inv.offset, h.payload.host, h.payload.run.id)!;
        expect(back).not.toBeNull();
        const again = sceneInverse(as, back, y)!;
        expect(again.kind === 'allele' ? [again.occurrence, again.offset] : null).toEqual([inv.occurrence, inv.offset]);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('#3: an inversion inside an insertion family is an inversion, never a substitution mark', () => {
    const m = build(fromWalks({ L: 1000, A: 120, B: 40, C: 110, R: 1000 }, { ref: ['L', 'R'], mat: ['L', 'A', 'B', 'C', 'R'], pat: ['L', 'A', '-B', 'C', 'R'] }));
    expect(m.stats.inversions).toBe(1);
    const inv = groups(m.chain).flatMap(g => g.alts).find(a => a.inverted)!;
    expect(inv.carriers).toEqual(['pat']);
    const s = scene(m, 50);
    expect(vmarks(s)).toEqual([]);
    expect(s.prims.some(p => p.t === 'tube' && p.arrows === -1)).toBe(true);
  });

  it('#4: two different inverted alleles are each drawn reversed (not aligned into a family); mirroring flips the chevrons', () => {
    const m = build(fromWalks({ L: 1000, A: 120, B: 100, C: 110, X: 100, R: 1000 }, { ref: ['L', 'A', 'B', 'C', 'R'], mat: ['L', '-C', '-B', '-A', 'R'], pat: ['L', '-C', '-X', '-A', 'R'] }));
    const alts = groups(m.chain).flatMap(g => g.alts);
    expect(alts.map(a => [a.carriers, Boolean(a.inverted), Boolean(a.family)])).toEqual([[['mat'], true, false], [['pat'], true, false]]);
    for (const reversed of [false, true]) {
      const s = scene(m, 0, reversed);
      const arrows = s.prims.filter((p): p is Extract<Prim, { t: 'tube' }> => p.t === 'tube' && p.arrows != null).map(p => p.arrows);
      expect(arrows).toEqual(reversed ? [1, 1] : [-1, -1]);
      for (const a of alts) {
        for (const o of s.occurrences.filter(x => x.owner === a.id)) {
          const l = placementAt(s, o.x0 + 1e-3, a.id)!, r = placementAt(s, o.x1 - 1e-3, a.id)!;
          // Plus paths with inverted alleles: path-forward runs right to left (left to right when mirrored).
          expect(l.offset > r.offset).toBe(!reversed);
        }
      }
    }
    const f = inv40 as unknown as { topology: GraphTopology; bindings: GraphBinding[] };
    const mm = buildLayout(f.topology, f.bindings);
    expect([false, true].map(rev => scene(mm, 0, rev).prims.filter(p => p.t === 'tube' && p.arrows != null).map(p => (p as any).arrows))).toEqual([[-1], [1]]);
  });

  it('#5: one reversed shared node in a long replacement does not make the whole replacement an inversion', () => {
    const m = build(fromWalks({ L: 1000, A: 1000, B: 40, C: 1000, X: 10, Y: 10, R: 1000 }, { ref: ['L', 'A', 'B', 'C', 'R'], mat: ['L', 'X', '-B', 'Y', 'R'], pat: ['L', 'A', 'B', 'C', 'R'] }));
    expect(m.stats).toMatchObject({ inversions: 0, unresolved: 1 });
    const a = groups(m.chain).flatMap(g => g.alts).find(x => x.carriers.includes('mat'))!;
    expect([a.status, a.reason, Boolean(a.inverted)]).toEqual(['unresolved', 'a local inversion', false]);
  });

  it('#6: visits beyond the four unrolled are summarized, with arcs only for the unrolled ones', () => {
    const m = build(fromWalks({ L: 800, R: 200, Z: 800 }, { ref: ['L', 'R', 'Z'], mat: ['L', 'R', 'R', 'R', 'R', 'R', 'R', 'Z'], pat: ['L', 'R', 'Z'] }));
    const ins = groups(m.chain).flatMap(g => g.alts).find(a => a.carriers.includes('mat'))!;
    expect(ins.visits.map(v => v.repeat?.n)).toEqual([2, 3, 4, 5, 6]);
    expect(m.summaries.some(t => t.includes('walks node R 6 times here: visits beyond 4 are not unrolled'))).toBe(true);
    const arcs = scene(m).prims.filter((p): p is Extract<Prim, { t: 'arc' }> => p.t === 'arc');
    expect(arcs.map(a => a.tier)).toEqual([0, 1, 2]);
  });

  // ------------------------------------------------------------------ round 2
  const COLORS4 = { ...COLORS, alt: '#0f766e' };
  const scene4 = (m: LayoutModel, smallBp = 0) => buildScene(m, {
    width: 1200, gutter: 52, rightPad: 6, rulerHeight: 30, laneHeight: 34, laneGap: 4, compression: 'log', reversed: false, colors: COLORS4, smallBp,
  });

  it('r2 #1: a small insertion family with a difference inside stays a bubble; the inner difference keeps its hit', () => {
    const m = build(fromWalks({ L: 1000, A: 12, B: 2, C: 12, X: 2, R: 1000 }, { ref: ['L', 'R'], mat: ['L', 'A', 'B', 'C', 'R'], pat: ['L', 'A', 'X', 'C', 'R'] }));
    const nested = groups(m.chain).find(g => g.depth === 1)!;
    expect(nested).toBeTruthy();
    const s = scene(m, 50);
    expect(s.hits.filter(h => h.payload.kind === 'allele').map(h => (h.payload.kind === 'allele' ? h.payload.group.id : ''))).toContain(nested.id);
  });

  it('r2 #2: an expanded carrier of a family sub-allele resolves to its own occurrence', () => {
    const m = build(fromWalks({ L: 1000, A: 120, B: 10, C: 110, X: 10, R: 1000 }, { ref: ['L', 'R'], mat: ['L', 'A', 'B', 'C', 'R'], pat: ['L', 'A', 'X', 'C', 'R'], alt: ['L', 'A', 'X', 'C', 'R'] }));
    for (const smallBp of [0, 50]) {
      const s = scene4(m, smallBp);
      // Bubbles: the sub-allele's tube, with a stripe per carrier. Marks: one mark per carrier (ALT's own).
      const h = s.hits.find(x => x.payload.kind === 'allele' && x.within && x.payload.allele.carriers.includes('alt')
        && (x.payload.lane === 'alt' || Boolean(x.payload.stripes?.some(st => st.key === 'alt'))))!;
      expect(h).toBeTruthy();
      if (h.payload.kind !== 'allele') continue;
      const st = h.payload.stripes?.find(x => x.key === 'alt');
      const y = st ? (st.y0 + st.y1) / 2 : (h.y0 + h.y1) / 2;
      expect(sceneInverse(s, (h.x0 + h.x1) / 2, y)).toMatchObject({ kind: 'allele', path: 'alt', occurrence: 'alt.2' });
    }
  });

  it('r2 #3: the base stripes of a folded difference inside a family are their paths\' own occurrences', () => {
    const m = build(fromWalks({ L: 1000, A: 120, B: 10, C: 110, X: 10, R: 1000 }, { ref: ['L', 'R'], mat: ['L', 'A', 'B', 'C', 'R'], pat: ['L', 'A', 'B', 'C', 'R'], alt: ['L', 'A', 'X', 'C', 'R'] }));
    const s = scene4(m, 50);
    const h = s.hits.find(x => x.payload.kind === 'base' && x.within)!;
    expect(h).toBeTruthy();
    if (h.payload.kind !== 'base') return;
    for (const key of ['mat', 'pat']) {
      const st = h.payload.stripes!.find(x => x.key === key)!;
      const x = (h.x0 + h.x1) / 2, y = (st.y0 + st.y1) / 2;
      expect(sceneHitAt(s, x, y)).toBe(h);
      expect(sceneInverse(s, x, y)).toMatchObject({ kind: 'allele', path: key, occurrence: `${key}.2` });
    }
  });

  it('r3: a mark\'s hit never covers another carrier\'s unchanged stripe', () => {
    const m = build(fromWalks({ L: 1000, A: 120, B: 10, C: 110, X: 10, R: 1000 }, { ref: ['L', 'R'], mat: ['L', 'A', 'B', 'C', 'R'], pat: ['L', 'A', 'X', 'C', 'R'], alt: ['L', 'A', 'B', 'C', 'R'] }));
    for (const reversed of [false, true]) {
      const s = buildScene(m, { width: 1200, gutter: 52, rightPad: 6, rulerHeight: 30, laneHeight: 34, laneGap: 4, compression: 'log', reversed, colors: COLORS4, smallBp: 50 });
      const base = s.hits.find(x => x.payload.kind === 'base' && x.within)!;
      if (base.payload.kind !== 'base') continue;
      for (const key of ['mat', 'alt']) {
        const st = base.payload.stripes!.find(x => x.key === key)!;
        const x = (base.x0 + base.x1) / 2, y = (st.y0 + st.y1) / 2;
        expect(sceneInverse(s, x, y)).toMatchObject({ kind: 'allele', path: key, occurrence: `${key}.2` });
      }
      // PAT's own stripe and its pin are PAT's allele.
      const pat = s.hits.filter(x => x.payload.kind === 'allele' && x.payload.lane === 'pat' && x.within);
      expect(pat.length).toBe(2);
      for (const h of pat) expect(sceneHitAt(s, (h.x0 + h.x1) / 2, (h.y0 + h.y1) / 2)).toBe(h);
    }
  });
});
