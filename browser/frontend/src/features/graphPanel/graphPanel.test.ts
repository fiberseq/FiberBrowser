/**
 * The graph panel's pure parts: its own coordinates (the joint layout is layout.test.ts) on real toy-graph responses
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
import { laneLabel } from './layout';
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

describe('lane labels', () => {
  it('lane labels drop a per-chromosome suffix only when it is the path\'s own contig', () => {
    const b = (key: string, contig: string) => ({ key, path: { sample: 'S', haplotype: '1', contig } } as GraphBinding);
    expect(laneLabel(b('pat_chr3', 'chr3'), 'pat_chr3')).toBe('PAT');
    expect(laneLabel(b('grch38_chr3', 'chr3'), 'grch38_chr3')).toBe('grch38');
    expect(laneLabel(b('pat_chr3', 'chr6'), 'pat_chr3')).toBe('pat_chr3');
    expect(laneLabel(b('mat', 'chr3_MATERNAL'), 'mat')).toBe('MAT');
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
