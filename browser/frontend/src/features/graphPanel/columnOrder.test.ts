/**
 * Sort by position: canonical walk order across colinear sequence (agy post-merge review A, HIGH 1). An inverted copy
 * of a repeated node never leaps across colinear sequence to the furthest opposite-strand repeat, and a sole direct
 * match does not make an inverted copy unique when the carrier also walks the node colinearly. Inverted runs entered
 * at a visit with several candidates (inverted tandems, palindromic cores, A-B-A inversions) still begin at their
 * furthest candidate. Topologies are synthetic, in the helper's shape: a direct match for every shared node pair.
 */
import { describe, expect, it } from 'vitest';
import { canonicalWalk, compareColumnKeys, firstCarriedColumn } from './columnOrder';
import { packMemberBands, type BandMember } from './memberBands';
import type { PlacedMolecule } from './readGeometry';
import type { GraphOccurrence, GraphRead, GraphTopology } from './types';

/** Target first. Steps are `node+` / `node-`; `matches: false` drops the direct matches (the older wire form). */
function topo(spec: Record<string, string[]>, lens: Record<string, number>, matches = true): GraphTopology {
  const paths = Object.entries(spec).map(([binding, steps]) => {
    let at = 0;
    const occurrences = steps.map((st, j) => {
      const node = st.slice(0, -1), reverse = st.endsWith('-');
      const o = { id: `${binding}.${j}`, node, handle: st, reverse, fragment: `${binding}#f`,
        path_span: { start: at, end: at + lens[node] }, clip: { start: 0, end: lens[node] } } as GraphOccurrence;
      at += lens[node];
      return o;
    });
    return { binding, windows: [{ start: 0, end: at }], coverage: [], plan: null, complete: true, occurrences };
  });
  const tgt = paths[0].occurrences;
  const direct_matches = matches ? paths.slice(1).flatMap(p => p.occurrences.flatMap(so => tgt.filter(to => to.node === so.node)
    .map(to => ({ target_occurrence: to.id, source_occurrence: so.id, source_binding: p.binding, reverse: so.reverse !== to.reverse,
      provenance: 'direct_named_walk' })))) : [];
  return { target: paths[0].binding, interval: { start: 0, end: tgt[tgt.length - 1].path_span.end }, nodes: [], edges: [], summaries: [],
    target_queries: [], direct_matches, complete: true, correspondence_complete: true, timings: {}, paths } as unknown as GraphTopology;
}
const ranks = (t: GraphTopology, binding = 'mat') => {
  const w = canonicalWalk(t, [t.target, binding]);
  return w.occurrences.get(binding)!.map(o => w.visits.get(o.id)!);
};
const rd = (k: string, s0: number, e0: number) => ({ k, b: 'mat', s: s0, e: e0, cov: [[s0, e0, 0, 1]] as [number, number, number, number][] });
const mol = (r: ReturnType<typeof rd>): PlacedMolecule => ({ read: { ...r, d: 'd', lib: 0, q: r.k, rec: 'r', c: '', st: '+', sup: false, ins: [], hap: 'MAT' } as GraphRead,
  lane: 'mat', visits: [], body: [], calls: [], m6a: [], density: [], ins: [], holes: [], connectors: [], extent: [0, 100], unplacedBp: 0 });
const M: BandMember = { panelId: 'mat', stateKey: 'k-mat', datasetId: 'd', liftHap: 'MAT', binding: 'mat', label: 'MAT', color: '#111' };

describe('agy post-merge A, HIGH 1: an inverted copy never leaps across colinear sequence', () => {
  // Target L A+ B+ A+ R; MAT inverts the first A in place: L A- B+ A+ R.
  const LENS = { L: 1000, A: 300, B: 400, R: 1000 };
  const T1A = (matches = true) => topo({ ref: ['L+', 'A+', 'B+', 'A+', 'R+'], mat: ['L+', 'A-', 'B+', 'A+', 'R+'] }, LENS, matches);

  it('1A: the upstream inverted A takes the first A; B and the colinear A keep their ranks', () => {
    for (const matches of [true, false]) {
      expect(ranks(T1A(matches)).map(v => v.rank)).toEqual([[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0], [4, 0, 0]]);
    }
  });

  it('1A: a read inside the inverted A sorts before reads in B and in the colinear A, and keeps the one row', () => {
    const walk = canonicalWalk(T1A(), ['ref', 'mat']);
    const up = rd('up', 1050, 1280), b = rd('b', 1350, 1650), copy = rd('copy', 1750, 1950);
    expect(firstCarriedColumn(up, walk)).toEqual([1, 0, 0, 20]);
    expect(firstCarriedColumn(b, walk)).toEqual([2, 0, 0, 50]);
    expect(firstCarriedColumn(copy, walk)).toEqual([3, 0, 0, 50]);
    // A read entering B from the inverted A: its first canonical column is A's start (MAT walks A reversed), still
    // in A's column, never after B.
    expect(firstCarriedColumn(rd('across', 1200, 1500), walk)).toEqual([1, 0, 0, 0]);
    const reads = [b, up];
    const lane = packMemberBands(reads.map(mol), [M], {}, 1, 'position', 3, undefined, m => firstCarriedColumn(m.read, walk))!.get('mat')!;
    expect(lane.rows.flat().map(m => m.read.k)).toEqual(['up']);
    expect(lane.hidden).toBe(1);
  });

  it('1B: a tandem forward copy is an extra copy, not the inverted repeat after B', () => {
    // Target L P+ B+ P- R; MAT duplicates P before B: L P+ P+ B+ P- R.
    for (const matches of [true, false]) {
      const v = ranks(topo({ ref: ['L+', 'P+', 'B+', 'P-', 'R+'], mat: ['L+', 'P+', 'P+', 'B+', 'P-', 'R+'] }, { L: 1000, P: 200, B: 400, R: 1000 }, matches));
      expect(v[1]).toEqual({ rank: [1, 0, 0], reverse: false });
      expect(v[2]).toEqual({ rank: [1, 1, 1], reverse: false });
      expect(v[3].rank).toEqual([2, 0, 0]);
      expect(v[4]).toEqual({ rank: [3, 0, 0], reverse: true });
    }
  });

  it('1B: on a node the target walks once, the colinear copy keeps its rank; the upstream inverted copy is an insertion', () => {
    // Target L X+ B+ R; MAT L X- B+ X+ R.
    for (const matches of [true, false]) {
      const v = ranks(topo({ ref: ['L+', 'X+', 'B+', 'R+'], mat: ['L+', 'X-', 'B+', 'X+', 'R+'] }, { L: 1000, X: 300, B: 400, R: 1000 }, matches));
      expect(v[3]).toEqual({ rank: [1, 0, 0], reverse: false });
      expect(v[1]).toEqual({ rank: [0, 1, 1], reverse: true });
      expect(v[2].rank).toEqual([2, 0, 0]);
      expect(compareColumnKeys([...v[1].rank, 0], [...v[2].rank, 0])).toBeLessThan(0);
    }
  });
});

describe('agy post-merge A, HIGH 1: inverted runs entered at a visit with several candidates still start at their furthest', () => {
  it('an inverted tandem (A+ A+ walked A- A-) takes the second A, then the first', () => {
    for (const matches of [true, false]) {
      expect(ranks(topo({ ref: ['L+', 'A+', 'A+', 'R+'], mat: ['L+', 'A-', 'A-', 'R+'] }, { L: 1000, A: 300, R: 1000 }, matches)).map(v => v.rank[0]))
        .toEqual([0, 2, 1, 3]);
    }
  });

  it('an inversion over A C+ C- A (a palindromic core between repeat arms) descends the whole run', () => {
    const v = ranks(topo({ ref: ['L+', 'A+', 'C+', 'C-', 'A+', 'R+'], mat: ['L+', 'A-', 'C+', 'C-', 'A-', 'R+'] }, { L: 1000, A: 300, C: 50, R: 1000 }));
    expect(v.map(x => x.rank[0])).toEqual([0, 4, 3, 2, 1, 5]);
    expect(v.map(x => x.reverse)).toEqual([false, false, true, false, false, false]);
  });

  it('an insertion inside the run does not end it; a minus-parity carrier walks the same run in its frame', () => {
    const v = ranks(topo({ ref: ['L+', 'A+', 'C+', 'C-', 'A+', 'R+'], mat: ['L+', 'A-', 'C+', 'I+', 'C-', 'A-', 'R+'] }, { L: 1000, A: 300, C: 50, I: 40, R: 1000 }));
    expect(v.map(x => x.rank[0])).toEqual([0, 4, 3, 4, 2, 1, 5]);
    expect(v[3].rank).toEqual([4, 1, 1]);
    // The inverted tandem, walked as its reverse complement.
    expect(ranks(topo({ ref: ['L+', 'A+', 'A+', 'R+'], mat: ['R-', 'A+', 'A+', 'L-'] }, { L: 1000, A: 300, R: 1000 })).map(x => x.rank[0]))
      .toEqual([3, 1, 2, 0]);
  });

  it('an inversion over A B A descends it; a target visit the carrier deletes inside an inversion may be crossed', () => {
    expect(ranks(topo({ ref: ['L+', 'A+', 'B+', 'A+', 'R+'], mat: ['L+', 'A-', 'B-', 'A-', 'R+'] }, { L: 1000, A: 300, B: 400, R: 1000 })).map(v => v.rank[0]))
      .toEqual([0, 3, 2, 1, 4]);
    expect(ranks(topo({ ref: ['L+', 'A+', 'D+', 'A+', 'R+'], mat: ['L+', 'A-', 'A-', 'R+'] }, { L: 1000, A: 300, D: 100, R: 1000 })).map(v => v.rank[0]))
      .toEqual([0, 3, 1, 4]);
  });

  it('an inverted tandem never runs on across a colinear anchor to a later repeat', () => {
    // Target L A+ A+ R A+; MAT L A- A- R A+: the inverted pair takes the first two A, the last A stays colinear.
    expect(ranks(topo({ ref: ['L+', 'A+', 'A+', 'R+', 'A+'], mat: ['L+', 'A-', 'A-', 'R+', 'A+'] }, { L: 1000, A: 300, R: 1000 })).map(v => v.rank[0]))
      .toEqual([0, 2, 1, 3, 4]);
  });
});
