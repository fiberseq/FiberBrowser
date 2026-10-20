/**
 * Regressions from the Gate C reviews (native/review/graphC: Codex round 1, agy). Each failed on the reviewed
 * commit (cacafd187); the walks are minimal named-walk topologies where every match is a direct node match.
 */
import { describe, expect, it } from 'vitest';
import alu800 from './__fixtures__/gateC/alu_800.topology.json';
import nested4 from './__fixtures__/gateC/nested4.topology.json';
import snpDel from './__fixtures__/gateC/snp_del.topology.json';
import fragmentGap from './__fixtures__/gateC/fragment_gap.topology.json';
import repeatVisit from './__fixtures__/gateC/repeat_visit.topology.json';
import { buildLayout, type GroupItem, type Item, type JunctionItem, type LayoutModel } from './layout';
import { budget, buildScene, layoutWidth, sceneHitAt, sceneInverse, xForTarget, type Scene } from './scene';
import type { GraphBinding, GraphTopology } from './types';

const scene = (m: LayoutModel, width = 1200) => buildScene(m, {
  width, gutter: 52, rightPad: 6, rulerHeight: 30, laneHeight: 28, laneGap: 4, compression: 'log', reversed: false, colors: {},
});
const groups = (xs: Item[]): GroupItem[] => xs.flatMap(x => (x.kind === 'group'
  ? [x, ...groups(x.base.chain), ...x.alts.flatMap(a => (a.family ? groups(a.family.chain) : []))] : []));
const fixture = (f: { topology: unknown; bindings: unknown }) => buildLayout(f.topology as GraphTopology, f.bindings as GraphBinding[]);

type Walk = [string, number][];
/** Each path one fragment from 0; matches wherever a path visits a target node (forward). */
function topo(walks: [string, Walk, string?][], window?: { start: number; end: number }): GraphTopology {
  const paths = walks.map(([binding, nodes, frag]) => {
    let at = 0;
    const occurrences = nodes.map(([node, len], i) => {
      const start = at;
      at += len;
      return { id: `${binding}:${i}`, node, handle: node, reverse: false, fragment: frag ?? `${binding}#f`, path_span: { start, end: at }, clip: { start: 0, end: len } };
    });
    return { binding, occurrences, windows: [{ start: 0, end: at }], plan: null, complete: true,
      coverage: [{ span: { start: 0, end: at }, kind: 'covered', fragment: frag ?? `${binding}#f`, left_end: 'fragment_terminal', right_end: 'fragment_terminal' }] };
  });
  const direct_matches = paths.slice(1).flatMap(p => p.occurrences.flatMap(o => paths[0].occurrences.filter(t => t.node === o.node)
    .map(t => ({ target_occurrence: t.id, source_occurrence: o.id, source_binding: p.binding, reverse: false, provenance: 'direct_named_walk' }))));
  return { target: paths[0].binding, interval: window ?? paths[0].windows[0], paths, direct_matches, nodes: [], edges: [],
    target_queries: [], summaries: [], complete: true, correspondence_complete: true, timings: {} } as unknown as GraphTopology;
}
const nodes = (n: number, len = 100): Walk => Array.from({ length: n }, (_, i) => [String(i + 1), len]);
const mid = (s: Scene, pred: (h: Scene['hits'][number]) => boolean) => {
  const h = s.hits.filter(pred).at(-1)!;
  return [(h.x0 + h.x1) / 2, (h.y0 + h.y1) / 2] as const;
};

describe('Gate C review regressions', () => {
  it('an insertion at a parent\'s endpoint keeps the parent open for later children (Codex 1)', () => {
    const t = nodes(10);
    const m = buildLayout(topo([['ref', t], ['mat', [...t.slice(0, 2), ...t.slice(8)]],
      ['pat', [...t.slice(0, 2), ['101', 50], ...t.slice(2)]], ['alt', [...t.slice(0, 4), ['102', 100], ...t.slice(5)]]]), []);
    const g = groups(m.chain);
    // MAT's deletion [200,800); PAT's insertion at its endpoint 200; ALT's substitution [400,500) nested inside.
    expect(g.map(x => [x.depth, x.target, x.alts.map(a => a.carriers[0])])).toEqual([
      [0, { start: 200, end: 200 }, ['pat']],
      [0, { start: 200, end: 800 }, ['mat']],
      [1, { start: 400, end: 500 }, ['alt']],
    ]);
  });

  it('many major bubbles cluster instead of zeroing sequence widths or overflowing (Codex 2)', () => {
    const t: Walk = [], a: Walk = [];
    for (let i = 0; i < 30; i++) {
      t.push([`s${i}`, 300], [`r${i}`, 100]);
      a.push([`s${i}`, 300], [`x${i}`, 100]);
    }
    const s = scene(buildLayout(topo([['ref', t], ['alt', a]]), []), 420);
    expect(s.clusters).toBeGreaterThan(0);
    expect(s.scale).toBeGreaterThan(0);
    const end = Math.max(...s.blocks.map(b => b.x1));
    expect(end).toBeLessThanOrEqual(s.dataLeft + s.dataWidth + 1e-6);
  });

  it('every omitted stretch after a truncated walk stays in the coverage partition (Codex 3)', () => {
    const f = JSON.parse(JSON.stringify(fragmentGap));
    f.topology.paths[0].occurrences = f.topology.paths[0].occurrences.slice(0, 1);
    const m = buildLayout(f.topology, f.bindings);
    const tail = m.chain.filter((i): i is JunctionItem => i.kind === 'junction').flatMap(j => j.gaps.map(g => [g.kind, g.span.start, g.span.end]));
    expect(tail).toEqual([['omitted', 900, 1500], ['graph_gap', 1500, 6500], ['omitted', 6500, 8500]]);
    const s = scene(m);
    expect(xForTarget(s.targetMap, 8000)).not.toBeNull();
  });

  it('children win over their parent: nested slots, target sequence inside a bubble, family sub-bubbles (Codex 5, agy 1)', () => {
    const m = fixture(nested4), s = scene(m);
    const [x, y] = mid(s, h => h.payload.kind === 'slot' && h.payload.boundary === 1360);
    expect(sceneInverse(s, x, y)).toMatchObject({ kind: 'connector', boundary: 1360 });
    const d = fixture(snpDel), ds = scene(d);
    const xd = xForTarget(ds.targetMap, 1750)! + 1e-6;
    const hit = sceneHitAt(ds, xd, ds.rows[0].center)!;
    expect(hit.payload.kind).toBe('run');
    expect(hit.cursor).toBe(true);
    expect(sceneInverse(ds, xd, ds.rows[0].center)).toMatchObject({ kind: 'target', pos: 1750, offset: 149 });
    const a = fixture(alu800), as = scene(a);
    const sub = as.hits.filter(h => h.within && h.payload.kind === 'allele');
    expect(sub.length).toBeGreaterThan(0);
    const [sx, sy] = [(sub[0].x0 + sub[0].x1) / 2, (sub[0].y0 + sub[0].y1) / 2];
    expect(sceneHitAt(as, sx, sy)).toBe(sub[0]);
  });

  it('filler and deletions invert as connector space; family members invert through the shared tube (Codex 6, agy 4)', () => {
    const m = buildLayout(topo([['ref', [['1', 100], ['2', 100], ['3', 100]]], ['alt', [['1', 100], ['4', 10], ['3', 100]]]]), []);
    const s = scene(m);
    const filler = s.hits.find(h => h.payload.kind === 'filler')!;
    expect(sceneInverse(s, (filler.x0 + filler.x1) / 2, (filler.y0 + filler.y1) / 2)?.kind).toBe('connector');
    const d = fixture(snpDel), ds = scene(d);
    const del = ds.hits.find(h => h.payload.kind === 'allele' && h.payload.allele.bp === 0)!;
    expect(sceneInverse(ds, (del.x0 + del.x1) / 2, (del.y0 + del.y1) / 2)?.kind).toBe('connector');
    // In the Alu, MAT and PAT share node 646 in one tube: the same x is the same offset on both.
    const a = fixture(alu800), as = scene(a);
    const run = as.hits.find(h => h.payload.kind === 'run' && h.payload.host === 'mat' && h.payload.run.visits[0].occ.node === '646')!;
    const x = run.x0 + 0.4 * (run.x1 - run.x0);
    const matRow = as.rows.find(r => r.key === 'mat')!, patRow = as.rows.find(r => r.key === 'pat')!;
    const im = sceneInverse(as, x, matRow.center) as { offset: number; occurrence: string };
    const ip = sceneInverse(as, x, patRow.center) as { offset: number; occurrence: string };
    expect(ip.offset).toBe(im.offset);
    expect(ip.occurrence).not.toBe(im.occurrence);
  });

  it('a clipped visit inverts to its occurrence-local offset (Codex 7)', () => {
    const a = fixture(alu800), s = scene(a);
    const x = xForTarget(s.targetMap, 97_000, 'end')! + 1e-6;
    expect(sceneInverse(s, x, s.rows[0].center)).toMatchObject({ kind: 'target', pos: 97_000, offset: 683 });
  });

  it('a zero-span base needs the walk on both sides; a break is open ends, never an empty insertion (agy 2, 3)', () => {
    const t = nodes(4, 400);
    // PAT ends at 400 where MAT inserts: PAT is not on that insertion's base.
    const ends = buildLayout(topo([['ref', t], ['mat', [t[0], ['ins', 50], ...t.slice(1)]], ['pat', [t[0]]]]), []);
    const [ins] = groups(ends.chain);
    expect(ins.target).toEqual({ start: 400, end: 400 });
    expect(ins.base.carriers).toEqual(['ref']);
    expect(ins.unavailable).toEqual(['pat']);
    // A deletion starting at the insertion's boundary passes it straight through (junction order): base.
    const del = buildLayout(topo([['ref', t], ['mat', [t[0], ['ins', 50], ...t.slice(1)]], ['pat', [t[0], t[3]]]]), []);
    expect(groups(del.chain).find(g => g.target?.end === 400)!.base.carriers).toEqual(['ref', 'pat']);
    // PAT changes fragment between adjacent visits inside MAT's deletion: open ends, no phantom slot, and PAT does
    // not walk the deletion's base across the break.
    const top = topo([['ref', t], ['mat', [t[0], t[3]]], ['pat', t.slice(0, 2), 'pat#a']]);
    const second = topo([['pat', t.slice(2), 'pat#b']]).paths[0] as any;
    second.binding = 'pat';
    second.occurrences.forEach((o: any) => { o.path_span = { start: o.path_span.start + 800, end: o.path_span.end + 800 }; o.id = `pb:${o.id}`; });
    (top.paths[2] as any).occurrences.push(...second.occurrences);
    (top.paths[2] as any).coverage.push(...second.coverage);
    second.occurrences.forEach((o: any) => top.direct_matches.push({ target_occurrence: `ref:${t.findIndex(n => n[0] === o.node)}`, source_occurrence: o.id, source_binding: 'pat', reverse: false, provenance: 'direct_named_walk' }));
    const brk = buildLayout(top, []);
    const g = groups(brk.chain);
    expect(g.map(x => [x.target, x.alts.map(a => a.carriers[0])])).toEqual([[{ start: 400, end: 1200 }, ['mat']]]);
    expect(g[0].base.carriers).toEqual(['ref']);
    expect(brk.openEnds.filter(e => e.path === 'pat').map(e => [e.side, e.at, e.reason])).toEqual([['right', 800, 'broken'], ['left', 800, 'broken']]);
  });

  it('two repeat visits resolving onto one target visit are both left unplaced (agy 6a)', () => {
    const t = JSON.parse(JSON.stringify(repeatVisit.topology));
    const pat = t.paths[2];
    // Duplicate PAT's first R visit (a tandem copy): both copies then fit between the same unique neighbours.
    const r = pat.occurrences[1];
    const copy = { ...r, id: `${r.id}-copy`, path_span: { start: r.path_span.end, end: 2 * r.path_span.end - r.path_span.start } };
    const shift = copy.path_span.end - copy.path_span.start;
    for (const o of pat.occurrences.slice(2)) o.path_span = { start: o.path_span.start + shift, end: o.path_span.end + shift };
    pat.occurrences.splice(2, 0, copy);
    for (const m of t.direct_matches.filter((m: any) => m.source_occurrence === r.id)) t.direct_matches.push({ ...m, source_occurrence: copy.id });
    const m = buildLayout(t, repeatVisit.bindings as unknown as GraphBinding[]);
    // S1, S2, the second R visit and S3 anchor; neither copy of the first R does: they stay in PAT's own allele.
    expect(m.stats.anchors.pat).toBe(4);
    const g = groups(m.chain).find(x => x.alts.some(a => a.carriers.includes('pat')))!;
    expect(g.target).toEqual({ start: 700, end: 1000 });
    expect(g.alts.find(a => a.carriers.includes('pat'))!.visits.map(v => v.occ.node)).toEqual(['2', '2', '5']);
  });

  it('open ends at a clipped or flank-margin anchor are drawn at the window edge (agy 5)', () => {
    const t = topo([['ref', nodes(3)], ['alt', nodes(3).slice(0, 2)]], { start: 50, end: 180 });
    t.summaries = [{ binding: 'alt', reason: 'wire_limit', source: { start: 0, end: 1 } } as any];
    const m = buildLayout(t, []);
    const e = m.openEnds.find(x => x.path === 'alt')!;
    expect(e.at).toBe(180);
    const s = scene(m);
    expect(s.hits.some(h => h.payload.kind === 'end')).toBe(true);
  });

  it('a small parent with a large nested child is major: never clustered (agy 6b)', () => {
    const t: Walk = [], a: Walk = [], b: Walk = [];
    for (let i = 0; i < 40; i++) {
      t.push([`s${i}`, 200], [`d${i}`, 20], [`e${i}`, 20]);
      a.push([`s${i}`, 200]);
      b.push([`s${i}`, 200], [`d${i}`, 20], [`big${i}`, 300], [`e${i}`, 20]);
    }
    for (const w of [t, a, b]) w.push(['tail', 200]);
    const m = buildLayout(topo([['ref', t], ['mat', a], ['pat', b]]), []);
    // Wide enough that only the small-bubble stage could cluster (the overflow stage does not apply here).
    const s = scene(m, 1600);
    const clustered = new Set(s.blocks.filter(x => x.kind === 'cluster').map(x => x.id));
    // Each MAT deletion (40 bp) holds PAT's 300 bp insertion strictly inside: none may disappear into a cluster.
    expect(groups(m.chain).filter(g => g.depth === 1 && g.alts.some(a => a.bp === 300))).toHaveLength(40);
    for (const g of m.chain.filter((i): i is GroupItem => i.kind === 'group')) {
      expect(s.blocks.some(x => x.id === g.id)).toBe(true);
    }
    expect(clustered.size).toBe(0);
  });

  it('child budget once, from raw lengths (Codex 10)', () => {
    const m = fixture(nested4), s = scene(m);
    const [parent] = m.chain.filter((i): i is GroupItem => i.kind === 'group');
    const k = s.metrics;
    const slot = (bp: number) => Math.max(k.min, budget(bp, 'log') * s.scale) + 2 * k.curve;
    // Base 800..1761: runs 560 bp (X1 + S2) and 400 bp (S3) around ALT's 150 bp insertion and PAT's 1 bp SNP.
    const expected = budget(560, 'log') * s.scale + slot(150) + slot(1) + budget(400, 'log') * s.scale;
    expect(layoutWidth(parent, s.scale, 'log', k)).toBeCloseTo(Math.max(k.min, expected) + 2 * k.curve, 6);
  });

  it('an overflow cluster still counts and marks every nested variant (Codex r2-1)', () => {
    const t: Walk = [], a: Walk = [], b: Walk = [];
    for (let i = 0; i < 40; i++) {
      t.push([`s${i}`, 200], [`d${i}`, 20], [`e${i}`, 20]);
      a.push([`s${i}`, 200]);
      b.push([`s${i}`, 200], [`d${i}`, 20], [`big${i}`, 300], [`e${i}`, 20]);
    }
    for (const w of [t, a, b]) w.push(['tail', 200]);
    const m = buildLayout(topo([['ref', t], ['mat', a], ['pat', b]]), []);
    const s = scene(m, 420);
    const clusters = s.hits.filter(h => h.payload.kind === 'cluster').map(h => (h.payload as any).cluster);
    expect(clusters.length).toBeGreaterThan(0);
    const per = clusters.reduce((acc: Record<string, number>, c: any) => { for (const [k, n] of Object.entries(c.perPath)) acc[k] = (acc[k] ?? 0) + (n as number); return acc; }, {});
    const inClusters = clusters.reduce((n: number, c: any) => n + c.items.filter((i: any) => i.kind === 'group').length, 0);
    expect(per.pat).toBe(per.mat);
    expect(per.pat).toBe(inClusters);
    expect(clusters.every((c: any) => c.major > 0)).toBe(true);
    // A tick per member in its lane: PAT's 300 bp insertions tall, MAT's 40 bp deletions short.
    expect(s.prims.filter(p => p.t === 'tick' && p.h === 14).length).toBe(inClusters);
    expect(s.prims.filter(p => p.t === 'tick').length).toBe(2 * inClusters);
  });

  it('many fragment junctions never zero the sequence or overflow (Codex r2-2)', () => {
    const t = topo([['ref', nodes(60)], ['alt', nodes(60)]]);
    // Sixty adjacent target fragments of 100 bp.
    const ref = t.paths[0] as any;
    ref.occurrences.forEach((o: any, i: number) => { o.fragment = `ref#f${i}`; });
    ref.coverage = ref.occurrences.map((o: any) => ({ span: { ...o.path_span }, kind: 'covered', fragment: o.fragment, left_end: 'fragment_terminal', right_end: 'fragment_terminal' }));
    const m = buildLayout(t, []);
    const s = scene(m, 420);
    expect(s.scale).toBeGreaterThan(0);
    expect(s.hits.filter(h => h.payload.kind === 'run').length).toBeGreaterThan(0);
    expect(Math.max(...s.blocks.map(b => b.x1))).toBeLessThanOrEqual(s.dataLeft + s.dataWidth + 1e-6);
  });

  it('a family sub-allele inverts with the enclosing target boundary (Codex r2-3)', () => {
    const a = fixture(alu800), s = scene(a);
    const subs = s.hits.filter(h => h.within && h.payload.kind === 'allele' && h.payload.allele.bp > 0);
    expect(subs.length).toBeGreaterThan(0);
    for (const h of subs) {
      const inv = sceneInverse(s, (h.x0 + h.x1) / 2, (h.y0 + h.y1) / 2);
      expect(inv).toMatchObject({ kind: 'allele', boundary: 97_395 });
    }
  });

  it('crossing collapse cost grows linearly (Codex 9, r2-4)', () => {
    const times: number[] = [];
    for (const n of [650, 1300, 2600]) {
      const t: Walk = [], a: Walk = [], b: Walk = [];
      for (let i = 0; i < n; i++) {
        const block: Walk = Array.from({ length: 5 }, (_, j) => [String(5 * i + j + 1), 1]);
        t.push(...block); a.push(block[0], block[3], block[4]); b.push(block[0], block[1], block[4]);
      }
      const top = topo([['ref', t], ['mat', a], ['pat', b]]);
      buildLayout(top, []);
      const t0 = performance.now();
      const m = buildLayout(top, []);
      times.push(performance.now() - t0);
      expect(m.stats.complex).toBe(n);
    }
    console.log('CROSSING_COST_MS', JSON.stringify(times.map(x => +x.toFixed(1))));
    // Quadrupling the components may not cost more than ~10x (quadratic would be ~16x).
    expect(times[2] / Math.max(1, times[0])).toBeLessThan(10);
  });
});
