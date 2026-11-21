/**
 * Graph follow-ups (A14) item 2: family alignment led by the target allele, independent of lane order (PHASE_C open
 * item 6, PHASE_D open item 4). Alleles that share stretches with the target allele align on it; among alternates
 * the family lead no longer depends on which path is selected first.
 */
import { describe, expect, it } from 'vitest';
import alu10k from './__fixtures__/gateC/alu_10k.topology.json';
import repeatTargetFamily from './__fixtures__/followups/repeat_target_family.topology.json';
import { buildLayout, type AltAllele, type GroupItem, type Item, type LayoutModel, type RunItem } from './layout';
import { buildScene } from './scene';
import type { GraphBinding, GraphTopology } from './types';

type Fixture = { topology: unknown; bindings: unknown };
/** The same response with the compared paths in another lane order (indexed matches remapped). */
function permuted(f: Fixture, order: string[]): LayoutModel {
  const t = JSON.parse(JSON.stringify(f.topology));
  const old: string[] = t.paths.map((p: { binding: string }) => p.binding);
  t.paths = order.map(b => t.paths[old.indexOf(b)]);
  if (t.direct_match_index) t.direct_match_index = t.direct_match_index.map(([p, s, x, r]: number[]) => [order.indexOf(old[p]), s, x, r]);
  return buildLayout(t as GraphTopology, f.bindings as GraphBinding[]);
}
function groups(items: Item[], out: GroupItem[] = []): GroupItem[] {
  for (const it of items) {
    if (it.kind !== 'group') continue;
    out.push(it);
    groups(it.base.chain, out);
    for (const a of it.alts) if (a.family) groups(a.family.chain, out);
  }
  return out;
}
const walk = (a: { visits: { occ: { node: string }; reverse: boolean }[] }) => a.visits.map(v => `${v.occ.node}${v.reverse ? '-' : '+'}`).join(',');
const set = (xs: string[]) => [...xs].sort().join('+');
/** The alignment's structure without lane order: items, alleles, families, carriers as sets. */
function shape(items: Item[]): unknown[] {
  const allele = (a: AltAllele): unknown => ({
    carriers: set(a.carriers), bp: a.bp, walk: walk(a), status: a.status, inverted: Boolean(a.inverted),
    family: a.family ? { members: a.family.members.map(allele).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))), chain: shape(a.family.chain) } : null,
  });
  return items.map(it => {
    if (it.kind === 'run') return { run: it.target, host: it.host, walk: walk(it), carriers: set(it.carriers) };
    if (it.kind === 'group') {
      return { group: it.target, host: it.host, type: it.type, base: { carriers: set(it.base.carriers), chain: shape(it.base.chain) },
        alts: it.alts.map(allele).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))), unavailable: set(it.unavailable) };
    }
    return { junction: it.target };
  });
}
const COLORS = { ref: '#334155', target: '#334155', mat: '#c2410c', pat: '#1d4ed8' };

describe('Graph follow-ups: family alignment led by the target allele, independent of lane order', () => {
  it('alleles that share a repeat the target walks twice align on the target allele: only the SNP between is a bubble', () => {
    for (const order of [['ref', 'mat', 'pat'], ['ref', 'pat', 'mat']]) {
      const m = permuted(repeatTargetFamily, order);
      const gs = groups(m.chain);
      // One slot: the 1 bp B, with C (MAT) and D (PAT). Before, each lane drew its own 241 bp A C A / A D A allele.
      expect(gs.map(g => [g.target, g.base.bp, g.alts.map(a => [a.carriers, a.bp]).sort()])).toEqual([
        [{ start: 1020, end: 1021 }, 1, [[['mat'], 1], [['pat'], 1]]],
      ]);
      // Both copies of A run on the target's tube with every path's stripe, each its own path's occurrence.
      const runs = m.chain.filter((i): i is RunItem => i.kind === 'run');
      expect(runs.map(r => [r.target, set(r.carriers)])).toEqual([
        [{ start: 0, end: 1020 }, 'mat+pat+ref'], [{ start: 1021, end: 1941 }, 'mat+pat+ref'],
      ]);
      for (const r of runs) for (const key of ['mat', 'pat']) expect(r.byCarrier![key].every(v => v != null && v.occ.id && v.occ.fragment.startsWith(key === 'mat' ? 'M#' : 'P#'))).toBe(true);
      expect(m.stats).toMatchObject({ substitutions: 2, insertions: 0, deletions: 0, unresolved: 0, complex: 0, unplaced: 0 });
      // The scene marks the SNPs (no allele tube carries A).
      const s = buildScene(m, { width: 1200, gutter: 52, rightPad: 6, rulerHeight: 30, laneHeight: 34, laneGap: 4, compression: 'log', reversed: false, colors: COLORS, smallBp: 50 });
      expect(s.prims.filter(p => p.t === 'vmark').length).toBe(2);
    }
  });

  it('a lane-order permutation gives the identical alignment', () => {
    for (const f of [alu10k, repeatTargetFamily] as Fixture[]) {
      const keys = (f.topology as { paths: { binding: string }[] }).paths.map(p => p.binding);
      const a = permuted(f, keys), b = permuted(f, [keys[0], ...keys.slice(1).reverse()]);
      expect(shape(b.chain)).toEqual(shape(a.chain));
      expect(b.stats).toEqual(a.stats);
    }
  });

  it('the Alu family is led by the same allele (MAT\'s 2,353 bp copy) whichever haplotype is selected first', () => {
    for (const order of [['target', 'mat', 'pat'], ['target', 'pat', 'mat']]) {
      const m = permuted(alu10k, order);
      const g = groups(m.chain).find(x => x.target?.start === 97_395 && x.target.end === 97_395)!;
      expect(g.alts.map(a => [a.carriers, a.bp, a.family?.members.map(x => [x.carriers, x.bp])])).toEqual([[['mat'], 2353, [[['pat'], 2350]]]]);
      // Its tube is drawn in MAT's lane.
      expect(g.alts[0].family!.chain.every(it => it.host === 'mat')).toBe(true);
    }
  });
});
