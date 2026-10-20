/**
 * The graph panel's pure parts: its own coordinates, the thin topology preview on real toy-graph responses
 * (graphlift's alu and flip packages, captured from the native helper), saved state and link rules, and the
 * crosshair cut around it.
 */
import { describe, expect, it } from 'vitest';
import alu from './__fixtures__/alu.topology.json';
import flip from './__fixtures__/flip.topology.json';
import {
  clampViewport, followViewport, fromX, makeTransform, panViewport, parseLocus, ticks, toX, zoomViewport,
  GRAPH_MAX_TARGET_BP,
} from './coordinates';
import { buildPreview, gapBetween, laneLabel } from './preview';
import { canFollow, effectiveViewport, initialGraphView, restoreProblem, retargetFor, selectableBindings, togglePath, isGraphViewState } from './state';
import { crosshairSegments, overlapsExcluded } from '../../utils/crosshairSegments';
import type { GraphBinding, GraphRegistration, GraphTopology } from './types';
import type { PanelConfig } from '../../types';

const aluTopology = alu.topology as unknown as GraphTopology;
const aluBindings = alu.bindings as unknown as GraphBinding[];
const flipTopology = flip.topology as unknown as GraphTopology;
const flipBindings = flip.bindings as unknown as GraphBinding[];

function registration(bindings: GraphBinding[], id = 'galu'): GraphRegistration {
  return {
    id, label: 'alu', producer: 'fiberbrowser-graph', build_target: 'test',
    revisions: { package: 'p'.repeat(64), graph: 'g'.repeat(64), db: 'd'.repeat(64), maps: 'm'.repeat(64) },
    bindings, maps: [{ target: 'target', source: 'mat' }, { target: 'target', source: 'pat' }],
  };
}

describe('graph coordinates', () => {
  it('maps target positions to the drawing area and back, mirrored when reversed', () => {
    const t = makeTransform({ start: 1000, end: 2000 }, 50, 500);
    expect(toX(t, 1000)).toBe(50);
    expect(toX(t, 2000)).toBe(550);
    expect(fromX(t, 300)).toBe(1500);
    const r = makeTransform({ start: 1000, end: 2000 }, 50, 500, true);
    expect(toX(r, 1000)).toBe(550);
    expect(fromX(r, toX(r, 1234))).toBeCloseTo(1234);
  });

  it('clamps to 50 kb, 40 bp and a known contig size, never past an inferred one', () => {
    expect(clampViewport({ contig: 'c', start: 0, end: 200_000 }, null)).toEqual({ contig: 'c', start: 75_000, end: 125_000 });
    expect(clampViewport({ contig: 'c', start: 100, end: 110 }, null).end - clampViewport({ contig: 'c', start: 100, end: 110 }, null).start).toBe(40);
    expect(clampViewport({ contig: 'c', start: 230_000, end: 250_000 }, 240_000)).toEqual({ contig: 'c', start: 220_000, end: 240_000 });
    expect(clampViewport({ contig: 'c', start: 230_000, end: 250_000 }, 240_000, true)).toEqual({ contig: 'c', start: 230_000, end: 250_000 });
    expect(clampViewport({ contig: 'c', start: -500, end: 500 }, null)).toEqual({ contig: 'c', start: 0, end: 1000 });
    const followed = followViewport({ chrom: 'c', start: 0, end: 1_000_000 }, null);
    expect(followed.end - followed.start).toBe(GRAPH_MAX_TARGET_BP);
    expect((followed.start + followed.end) / 2).toBe(500_000);
  });

  it('pans and zooms around the pointer', () => {
    const v = { contig: 'c', start: 10_000, end: 20_000 };
    expect(panViewport(v, 2500, null)).toEqual({ contig: 'c', start: 12_500, end: 22_500 });
    const z = zoomViewport(v, 0.5, 12_000, null);
    expect(z.end - z.start).toBe(5000);
    expect(z.start).toBe(11_000);
  });

  it('parses a typed locus and places ticks at round steps', () => {
    expect(parseLocus(' chr3:97,300-97,500 ')).toEqual({ contig: 'chr3', start: 97_300, end: 97_500 });
    expect(parseLocus('chr3:5-1')).toBeNull();
    const { step, positions } = ticks(makeTransform({ start: 97_300, end: 97_500 }, 52, 600));
    expect(step).toBe(50);
    expect(positions).toEqual([97_300, 97_350, 97_400, 97_450]);
  });
});

describe('thin topology preview', () => {
  it('Alu: MAT and PAT insert 2,353 and 2,350 bp at the same target boundary 97,395', () => {
    const preview = buildPreview(aluTopology, aluBindings);
    expect(preview.lanes.map(l => [l.key, l.label, l.role])).toEqual([
      ['target', 'target', 'target'], ['mat', 'MAT', 'alternate'], ['pat', 'PAT', 'alternate'],
    ]);
    expect(preview.complete).toBe(true);
    const target = preview.lanes[0];
    // The target lane is its named walk, clipped to the window, with no gaps.
    const nodes = target.pieces.filter(p => p.kind === 'node');
    expect(nodes[0].start).toBe(97_300);
    expect(nodes[nodes.length - 1].end).toBe(97_500);
    for (let i = 1; i < nodes.length; i++) expect(nodes[i].start).toBe(nodes[i - 1].end);
    expect(nodes.slice(0, 2).map(n => n.node)).toEqual(['645', '669']);
    for (const [lane, bp, source] of [[preview.lanes[1], 2353, [94_676, 97_029]], [preview.lanes[2], 2350, [95_686, 98_036]]] as const) {
      const inserts = lane.pieces.filter(p => p.kind === 'insertion');
      expect(inserts).toHaveLength(1);
      expect(inserts[0].start).toBe(97_395);
      expect(inserts[0].end).toBe(97_395);
      expect(inserts[0].bp).toBe(bp);
      expect([inserts[0].source!.start, inserts[0].source!.end]).toEqual(source);
      // Its matched flank nodes are drawn over the target's.
      const placed = lane.pieces.filter(p => p.kind === 'node').map(p => p.node);
      expect(placed).toContain('645');
      expect(placed).toContain('669');
      expect(lane.unplaced).toEqual([]);
    }
  });

  it('flip: a whole minus comparison is drawn reverse, in place, without invented runs', () => {
    const preview = buildPreview(flipTopology, flipBindings);
    expect(preview.complete).toBe(true);
    for (const lane of preview.lanes.slice(1)) {
      const nodes = lane.pieces.filter(p => p.kind === 'node');
      expect(nodes.length).toBeGreaterThan(0);
      expect(nodes.every(p => p.reverse)).toBe(true);
      for (const n of nodes) {
        expect(n.start).toBeGreaterThanOrEqual(flipTopology.interval.start);
        expect(n.end).toBeLessThanOrEqual(flipTopology.interval.end);
      }
    }
  });

  it('a skipped target stretch is a deletion; a repeat match and an edge run stay unplaced', () => {
    const occ = (id: string, node: string, start: number, len: number, clip = [0, len]) =>
      ({ id, fragment: 'f', node, handle: node, reverse: false, path_span: { start, end: start + len }, clip: { start: clip[0], end: clip[1] } });
    const topo: GraphTopology = {
      target: 'target', interval: { start: 0, end: 300 }, nodes: [], edges: [], target_queries: [], summaries: [{ reason: 'wire_limit', span: { start: 250, end: 300 } }],
      complete: false, correspondence_complete: false, timings: {},
      paths: [
        { binding: 'target', windows: [], coverage: [{ span: { start: 0, end: 250 }, kind: 'covered' }, { span: { start: 250, end: 300 }, kind: 'unavailable' }],
          occurrences: [occ('t1', '1', 0, 100), occ('t2', '2', 100, 50), occ('t3', '3', 150, 100)], plan: null, complete: false },
        { binding: 'alt', windows: [], coverage: [{ span: { start: 0, end: 220 }, kind: 'covered' }],
          occurrences: [occ('a0', '9', 0, 20), occ('a1', '1', 20, 100), occ('a3', '3', 120, 100)], plan: null, complete: true },
      ],
      direct_matches: [
        { target_occurrence: 't1', source_occurrence: 'a1', source_binding: 'alt', reverse: false, provenance: 'direct_named_walk' },
        { target_occurrence: 't3', source_occurrence: 'a3', source_binding: 'alt', reverse: false, provenance: 'direct_named_walk' },
      ],
    };
    const preview = buildPreview(topo, []);
    const alt = preview.lanes[1];
    expect(alt.pieces.find(p => p.kind === 'deletion')).toMatchObject({ start: 100, end: 150, bp: 50 });
    expect(alt.unplaced).toEqual([{ bp: 20, source: { start: 0, end: 20 } }]);
    expect(preview.lanes[0].pieces.find(p => p.kind === 'unavailable')).toMatchObject({ start: 250, end: 300 });
    expect(preview.complete).toBe(false);
    expect(preview.summaries[0]).toContain('wire limit');
    // A visit matched to two target visits (a repeat) is not placed.
    topo.direct_matches.push({ target_occurrence: 't2', source_occurrence: 'a3', source_binding: 'alt', reverse: false, provenance: 'direct_named_walk' });
    const repeat = buildPreview(topo, []).lanes[1];
    expect(repeat.pieces.filter(p => p.kind === 'node').map(p => p.node)).toEqual(['1']);
    expect(repeat.unplaced.map(u => u.bp)).toEqual([20, 100]);
  });

  it('lane labels drop a per-chromosome suffix only when it is the path\'s own contig', () => {
    const b = (key: string, contig: string) => ({ key, path: { sample: 'S', haplotype: '1', contig } } as GraphBinding);
    expect(laneLabel(b('pat_chr3', 'chr3'), 'pat_chr3')).toBe('PAT');
    expect(laneLabel(b('grch38_chr3', 'chr3'), 'grch38_chr3')).toBe('grch38');
    expect(laneLabel(b('pat_chr3', 'chr6'), 'pat_chr3')).toBe('pat_chr3');
    expect(laneLabel(b('mat', 'chr3_MATERNAL'), 'mat')).toBe('MAT');
  });

  it('no event is asserted across a coverage gap, a fragment change or an inversion breakpoint (review 1)', () => {
    const o = (id: string, node: string, start: number, len: number, fragment = 'f', reverse = false) =>
      ({ id, node, fragment, handle: node, reverse, path_span: { start, end: start + len }, clip: { start: 0, end: len } });
    const m = (t: string, a: string, reverse = false) => ({ target_occurrence: t, source_occurrence: a, source_binding: 'alt', reverse, provenance: 'direct_named_walk' });
    const topo = (targets: any[], alts: any[], matches: any[], win = { start: 0, end: 300 }, targetCoverage?: any[]): GraphTopology => ({
      target: 'target', interval: win, nodes: [], edges: [], target_queries: [], summaries: [], complete: false, correspondence_complete: false, timings: {},
      direct_matches: matches,
      paths: [{ binding: 'target', windows: [win], coverage: targetCoverage ?? [{ span: win, kind: 'covered' }], occurrences: targets, complete: true, plan: null },
              { binding: 'alt', windows: [], coverage: [], occurrences: alts, complete: false, plan: null }] } as unknown as GraphTopology);
    const gap = buildPreview(topo([o('t1', '1', 0, 100), o('t2', '2', 100, 50), o('t3', '3', 150, 100)],
      [o('a1', '1', 0, 100, 'f1'), o('a3', '3', 200, 100, 'f2')], [m('t1', 'a1'), m('t3', 'a3')]), []).lanes[1];
    expect(gap.pieces.filter(p => p.kind !== 'node')).toEqual([]);
    expect(gap.transitions).toBe(1);
    const inv = buildPreview(topo([o('t1', '1', 0, 100), o('t2', '2', 100, 100), o('t3', '3', 200, 100), o('t4', '4', 300, 100)],
      [o('a1', '1', 0, 100), o('a3', '3', 100, 100, 'f', true), o('a2', '2', 200, 100, 'f', true), o('a4', '4', 300, 100)],
      [m('t1', 'a1'), m('t3', 'a3', true), m('t2', 'a2', true), m('t4', 'a4')], { start: 0, end: 400 }), []).lanes[1];
    expect(inv.pieces.filter(p => p.kind === 'deletion')).toEqual([]);
    expect(inv.pieces.filter(p => p.kind === 'node').map(p => [p.node, p.start, p.reverse])).toEqual([['1', 0, false], ['3', 200, true], ['2', 100, true], ['4', 300, false]]);
    expect(inv.transitions).toBe(2);
    // A same-fragment, same-orientation walk that skips target sequence is still a deletion.
    const del = buildPreview(topo([o('t1', '1', 0, 100), o('t2', '2', 100, 50), o('t3', '3', 150, 100)],
      [o('a1', '1', 0, 100), o('a3', '3', 100, 100)], [m('t1', 'a1'), m('t3', 'a3')]), []).lanes[1];
    expect(del.pieces.find(p => p.kind === 'deletion')).toMatchObject({ start: 100, end: 150, bp: 50 });
    // Review 2: visits the window clips are not a continuous walk; a stretch without named target sequence is no
    // deletion either.
    const clip = (x: any, a: number, b: number) => ({ ...x, clip: { start: a, end: b } });
    const clipped = buildPreview(topo([clip(o('t1', '1', 0, 200), 0, 50), clip(o('t1b', '1', 0, 200), 150, 200)],
      [clip(o('a1', '1', 0, 200), 0, 50), clip(o('a1b', '1', 200, 200), 150, 200)], [m('t1', 'a1'), m('t1b', 'a1b')], { start: 0, end: 400 }), []).lanes[1];
    expect(clipped.pieces.filter(p => p.kind === 'deletion')).toEqual([]);
    const targetGap = buildPreview(topo([o('t1', '1', 0, 100), o('t3', '3', 150, 100)],
      [o('a1', '1', 0, 100), o('a3', '3', 100, 100)], [m('t1', 'a1'), m('t3', 'a3')], { start: 0, end: 300 },
      [{ span: { start: 0, end: 100 }, kind: 'covered' }, { span: { start: 100, end: 150 }, kind: 'gap' }, { span: { start: 150, end: 300 }, kind: 'covered' }]), []).lanes[1];
    expect(targetGap.pieces.filter(p => p.kind === 'deletion')).toEqual([]);
    expect(targetGap.transitions).toBe(1);
    // agy review 1: a matched visit reaching outside the view still anchors (its visible part drawn, true length
    // of what is drawn), and two visits of one path on the same target visit (a duplication) are not placed.
    const ctx = topo([clip(o('t1', '1', 900, 200), 100, 200), o('t2', '2', 1100, 100)],
      [o('a1', '1', 900, 200), o('ins', '9', 1100, 300), o('a2', '2', 1400, 100)], [m('t1', 'a1'), m('t2', 'a2')], { start: 1000, end: 1200 });
    const lane = buildPreview(ctx, []).lanes[1];
    expect(lane.pieces.find(p => p.kind === 'insertion')).toMatchObject({ start: 1100, bp: 300 });
    expect(lane.pieces.find(p => p.node === '1')).toMatchObject({ start: 1000, end: 1100, bp: 100 });
    expect(lane.unplaced).toEqual([]);
    const dup = buildPreview(topo([o('t1', '1', 0, 500)], [o('a1', '1', 0, 500), o('a2', '1', 500, 500)],
      [m('t1', 'a1'), m('t1', 'a2')], { start: 0, end: 500 }), []).lanes[1];
    expect(dup.pieces.filter(p => p.kind === 'node')).toEqual([]);
    expect(dup.unplaced.map(u => u.bp)).toEqual([1000]);
  });

  it('gaps between placed pieces work in either direction and refuse overlaps', () => {
    const p = (start: number, end: number) => ({ kind: 'node' as const, start, end, bp: end - start });
    expect(gapBetween(p(0, 10), p(15, 20))).toEqual({ start: 10, end: 15 });
    expect(gapBetween(p(15, 20), p(0, 10))).toEqual({ start: 10, end: 15 });
    expect(gapBetween(p(0, 10), p(5, 20))).toBeNull();
  });
});

describe('graph view state and links', () => {
  const reg = registration(aluBindings);
  const target = aluBindings.find(b => b.key === 'target')!;

  it('a new panel follows the main view only on the target contig', () => {
    const following = initialGraphView(reg, { chrom: 'chr3', start: 90_000, end: 100_000, reference: 'GRCh38_chr3.fa' });
    expect(following.linkMode).toBe('follow');
    expect(following.selectedPathKeys).toEqual(['target', 'mat', 'pat']);
    expect(following.targetViewport).toEqual({ contig: 'chr3', start: 90_000, end: 100_000 });
    expect(isGraphViewState(following)).toBe(true);
    const elsewhere = initialGraphView(reg, { chrom: 'chr19', start: 0, end: 5000 });
    expect(elsewhere.linkMode).toBe('independent');
    expect(elsewhere.targetViewport).toEqual({ contig: 'chr3', start: 0, end: 10_000 });
    expect(canFollow(target, { chrom: 'chr3_MATERNAL', start: 0, end: 1, reference: 'hg38' })).toBe(false);
    // The same contig name on another assembly is never followed (no coordinates copied between assemblies).
    expect(canFollow(target, { chrom: 'chr3', start: 0, end: 1, reference: 'a-different-assembly' })).toBe(false);
    expect(canFollow(target, { chrom: 'chr3', start: 0, end: 1, reference: null })).toBe(false);
    expect(canFollow(target, { chrom: 'chr3', start: 0, end: 1, reference: 'hg38' })).toBe(true);
    expect(canFollow(target, { chrom: 'chr3', start: 0, end: 1, reference: 'hg38-chr3.fa' })).toBe(true);
    expect(canFollow(target, { chrom: 'chr3', start: 0, end: 1, reference: 'hg38_to_hg19.fa' })).toBe(false);
    expect(canFollow(target, { chrom: 'chr3', start: 0, end: 1, reference: 'hg19' })).toBe(false);
    expect(initialGraphView(reg, { chrom: 'chr3', start: 0, end: 5000, reference: 'dm6' }).linkMode).toBe('independent');
  });

  it('two panels keep independent initiating viewports', () => {
    const main = { chrom: 'chr3', start: 90_000, end: 100_000, reference: 'hg38' };
    const own: PanelConfig = { id: 'p-own', contentType: 'dataset', datasetId: null, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0,
      viewportOverride: { chrom: 'chr3', start: 150_000, end: 151_000 } };
    const a = initialGraphView(reg, main);
    const b = { ...initialGraphView(reg, main, 'p-own'), initiatingPanelId: 'p-own' };
    const c = { ...a, linkMode: 'independent' as const, targetViewport: { contig: 'chr3', start: 5000, end: 6000 } };
    expect(effectiveViewport(a, target, [own], main)).toEqual({ contig: 'chr3', start: 90_000, end: 100_000 });
    expect(effectiveViewport(b, target, [own], main)).toEqual({ contig: 'chr3', start: 150_000, end: 151_000 });
    expect(effectiveViewport(c, target, [own], main)).toEqual({ contig: 'chr3', start: 5000, end: 6000 });
    // The main view moves: only the panel following it changes.
    const moved = { chrom: 'chr3', start: 120_000, end: 130_000, reference: 'hg38' };
    expect(effectiveViewport(a, target, [own], moved)?.start).toBe(120_000);
    expect(effectiveViewport(b, target, [own], moved)?.start).toBe(150_000);
    expect(effectiveViewport(c, target, [own], moved)?.start).toBe(5000);
    // A panel of its own on another assembly is not followed even on a contig of the same name.
    const other = { ...own, id: 'p-other', genome: 'a-different-assembly' };
    expect(effectiveViewport({ ...b, initiatingPanelId: 'p-other', initiatingReferenceId: null }, target, [other], main))
      .toEqual(b.targetViewport);
    // A followed reference switched under it: not followed any more.
    expect(effectiveViewport({ ...a, initiatingReferenceId: 'hg38' }, target, [own], { ...moved, reference: 'GRCh38.fa' }))
      .toEqual(a.targetViewport);
    // Its initiating panel closed: it keeps its last saved viewport.
    expect(effectiveViewport({ ...b, targetViewport: { contig: 'chr3', start: 1, end: 2001 } }, target, [], moved)).toEqual({ contig: 'chr3', start: 1, end: 2001 });
  });

  it('restoring checks the registration and its revisions; paths stay within four, the target fixed', () => {
    const state = initialGraphView(reg, null);
    expect(restoreProblem(state, [reg])).toBeNull();
    expect(restoreProblem(state, [])).toMatch(/not registered/);
    expect(restoreProblem(state, [{ ...reg, revisions: { ...reg.revisions, graph: 'x'.repeat(64) } }])).toMatch(/changed/);
    expect(togglePath(state, 'target')).toBe(state);
    const fewer = togglePath(state, 'pat');
    expect(fewer.selectedPathKeys).toEqual(['target', 'mat']);
    expect(togglePath(fewer, 'pat').selectedPathKeys).toEqual(['target', 'mat', 'pat']);
    const full = { ...state, selectedPathKeys: ['target', 'a', 'b', 'c'] };
    expect(togglePath(full, 'd')).toBe(full);
  });
});

describe('a package with several targets (one per chromosome)', () => {
  const b = (key: string, sample: string, hap: string, contig: string, assembly: string): GraphBinding =>
    ({ key, path: { sample, haplotype: hap, contig }, assembly, reference: assembly, size: 1_000_000, size_inferred: false, fragments: [{ origin: 0, end: 1_000_000, indexed: true }], uncovered: [] });
  const multi: GraphRegistration = {
    ...registration([]), id: 'gmulti',
    bindings: [b('ref_chr1', 'REF', '0', 'chr1', 'REF'), b('ref_chr3', 'REF', '0', 'chr3', 'REF'), b('h1_chr1', 'S', '1', 'chr1', 'S one'),
      b('h2_chr1', 'S', '2', 'chr1', 'S two'), b('h1_chr3', 'S', '1', 'chr3', 'S one'), b('h2_chr3', 'S', '2', 'chr3', 'S two')],
    maps: [{ target: 'ref_chr1', source: 'h1_chr1' }, { target: 'ref_chr1', source: 'h2_chr1' }, { target: 'ref_chr3', source: 'h1_chr3' }, { target: 'ref_chr3', source: 'h2_chr3' }],
  };

  it('opens on the main view\'s contig with that target\'s mapped paths only, and follows onto another contig', () => {
    const state = initialGraphView(multi, { chrom: 'chr3', start: 500, end: 9500, reference: 'REF' });
    expect(state.targetBinding).toBe('ref_chr3');
    expect(state.selectedPathKeys).toEqual(['ref_chr3', 'h1_chr3', 'h2_chr3']);
    expect(selectableBindings(multi, 'ref_chr3').map(x => x.key)).toEqual(['h1_chr3', 'h2_chr3']);
    expect(retargetFor(multi, state, { chrom: 'chr3', start: 0, end: 10, reference: 'REF' })).toBeNull();
    const moved = retargetFor(multi, state, { chrom: 'chr1', start: 100, end: 200, reference: 'REF' })!;
    expect(retargetFor(multi, state, { chrom: 'chr1', start: 100, end: 200, reference: 'OTHER' })).toBeNull();
    expect(moved.targetBinding).toBe('ref_chr1');
    expect(moved.selectedPathKeys).toEqual(['ref_chr1', 'h1_chr1', 'h2_chr1']);
    expect(retargetFor(multi, state, { chrom: 'chr9', start: 0, end: 10, reference: 'REF' })).toBeNull();
    expect(retargetFor(multi, { ...state, linkMode: 'independent' }, { chrom: 'chr1', start: 0, end: 10, reference: 'REF' })).toBeNull();
  });
});

describe('crosshair cut around a graph panel', () => {
  it('leaves out the stretch over an excluded panel at that x only', () => {
    const graph = { left: 600, right: 900, top: 40, bottom: 400 };
    expect(crosshairSegments(300, 30, 800, [graph])).toEqual([{ top: 30, bottom: 800 }]);
    expect(crosshairSegments(700, 30, 800, [graph])).toEqual([{ top: 30, bottom: 40 }, { top: 400, bottom: 800 }]);
    expect(crosshairSegments(700, 30, 300, [graph])).toEqual([{ top: 30, bottom: 40 }]);
    expect(crosshairSegments(700, 30, 800, [graph, { left: 650, right: 750, top: 500, bottom: 600 }]))
      .toEqual([{ top: 30, bottom: 40 }, { top: 400, bottom: 500 }, { top: 600, bottom: 800 }]);
    expect(overlapsExcluded({ left: 590, right: 710, top: 50, bottom: 70 }, [graph])).toBe(true);
    expect(overlapsExcluded({ left: 100, right: 220, top: 50, bottom: 70 }, [graph])).toBe(false);
  });
});
