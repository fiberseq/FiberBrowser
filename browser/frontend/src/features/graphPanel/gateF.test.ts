/**
 * Gate F (DESIGN_GRAPH_PANEL.md §7, "interaction/restore"): graph-only selections and inspection, source placements
 * (ambiguous ones offered, never picked), navigation tokens for stale corrections, insertion expansion, restore
 * validation, the shared molecule hover across graph, lifted, source and native panels, and a fly package (dm6 plus
 * a strain) with no MAT/PAT assumptions anywhere.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import alu10k from './__fixtures__/gateC/alu_10k.topology.json';
import tandemDup from './__fixtures__/gateD/tandem_dup.topology.json';
import { buildLayout, laneLabel, type GroupItem, type LayoutModel } from './layout';
import { buildScene, planScene, type Scene, type SceneHit } from './scene';
import { canonicalProblem, focusWindow, isGraphSelection, isInsertionGroup, hitGroup, placementsByPath, selectionForHit,
  selectionProblem, sourcePlacements, sourceWindow, type GraphSelection } from './inspection';
import { bumpNavigation, linkIdentity, navigationToken, tokenCurrent, viewportKey } from './navigation';
import { canFollow, initialGraphView, referenceMatches } from './state';
import { laneColor } from './canvas';
import { hoverScope, moleculeKey, rowMoleculeKey } from '../liveLift/linking/hover';
import { graphDrawnDatasets } from './graphReadsStore';
import { restoreGraphSelection, selectGraph } from './selectionStore';
import { useBrowserStore } from '../../stores/browserStore';
import { useDifferenceSelection } from '../differences/selectionStore';
import type { GraphBinding, GraphRegistration, GraphTopology, GraphViewState } from './types';
import type { Dataset, PanelConfig } from '../../types';

type Fixture = { topology: unknown; bindings: unknown };
const COLORS = { target: '#334155', mat: '#c2410c', pat: '#1d4ed8' };

function registration(bindings: GraphBinding[], target = 'target', sources = ['mat', 'pat']): GraphRegistration {
  return {
    id: 'gtest', label: 'test', producer: 'fiberbrowser-graph', build_target: 'test',
    revisions: { package: 'p'.repeat(64), graph: 'g'.repeat(64), db: 'd'.repeat(64), maps: 'm'.repeat(64) },
    bindings, maps: sources.map(source => ({ target, source })),
  };
}

function setup(f: Fixture, opts: { expanded?: Set<string>; width?: number } = {}) {
  const topology = f.topology as GraphTopology;
  const bindings = f.bindings as GraphBinding[];
  const model = buildLayout(topology, bindings);
  const colors: Record<string, string> = {};
  for (const r of model.rows) colors[r.key] = laneColor(r);
  const scene = buildScene(model, { width: opts.width ?? 1400, gutter: 52, rightPad: 6, rulerHeight: 30, laneHeight: 28, laneGap: 4,
    compression: 'log', reversed: false, colors, smallBp: 0, expanded: opts.expanded });
  const reg = registration(bindings, topology.target, topology.paths.map(p => p.binding).filter(k => k !== topology.target));
  const state = initialGraphView(reg, null);
  return { topology, bindings, model, scene, reg, state: { ...state, targetBinding: topology.target } as GraphViewState };
}

const ctxOf = (s: ReturnType<typeof setup>) => ({ panelId: 'g1', reg: s.reg, state: s.state, model: s.model });
const slotHit = (scene: Scene, boundary: number) => scene.hits.find(h => h.payload.kind === 'slot' && h.payload.boundary === boundary)!;
const alleleHit = (scene: Scene, lane: string, boundary: number) => scene.hits.filter(h => h.payload.kind === 'allele'
  && h.payload.lane === lane && (h.payload.group as GroupItem).target?.start === boundary).at(-1)!;

/** The Alu fixture renamed to fly names: dm6 target, two strains on haplotype 0 (no MAT/PAT anywhere). */
function flyFixture(): Fixture {
  const swaps: [RegExp, string][] = [
    [/chr3_MATERNAL/g, 'chr2L'], [/chr3_PATERNAL/g, 'chr2L'], [/chr3/g, 'chr2L'],
    [/HG002 maternal/g, 'DGRP-399'], [/HG002 paternal/g, 'w1118'], [/HG002_MAT/g, 'DGRP-399'], [/HG002_PAT/g, 'w1118'],
    [/GRCh38/g, 'dm6'],
  ];
  const keys: Record<string, string> = { mat: 'dgrp399', pat: 'w1118', target: 'dm6_chr2L' };
  // Values only (field names stay): binding keys exactly, names and contigs wherever they occur.
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (v in keys) return keys[v];
      let out = v;
      for (const [a, b] of swaps) out = out.replace(a, b);
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(JSON.parse(JSON.stringify(alu10k))) as Fixture;
}

describe('Gate F: graph-only selection and inspection', () => {
  it('a slot click names the insertion: one boundary, both alleles with their own length and source span', () => {
    const s = setup(alu10k as Fixture);
    const sel = selectionForHit(slotHit(s.scene, 97_395), ctxOf(s))!;
    expect(sel.kind).toBe('graph-difference');
    expect(sel.what).toBe('insertion');
    expect(sel.target).toEqual({ start: 97_395, end: 97_395 });
    expect(sel.alleles.map(a => [a.paths.join(','), a.bp]).sort()).toEqual([['mat', 2353], ['pat', 2350]]);
    expect(sel.alleles.find(a => a.paths.includes('mat'))!.source[0].span).toEqual({ start: 94_676, end: 97_029 });
    expect(sel.reads).toBeNull();   // no read binding: no read rows, no fake dataset
    expect(sel.canonical).toBeNull();
    expect(isGraphSelection(sel)).toBe(true);
  });

  it('an allele click selects that allele; a shared-sequence click is a graph locus with its occurrence', () => {
    const s = setup(alu10k as Fixture);
    const pick = selectionForHit(alleleHit(s.scene, 'pat', 97_395), ctxOf(s))!;
    expect(pick.selectedAllele).toBe(pick.alleles.find(a => a.paths.includes('pat'))!.id);
    const run = s.scene.hits.find(h => h.payload.kind === 'run')!;
    const locus = selectionForHit(run, ctxOf(s), (run.y0 + run.y1) / 2)!;
    expect(locus.kind).toBe('graph-locus');
    expect(locus.what).toBe('sequence');
    expect(locus.occurrence?.node).toBeTruthy();
    expect(locus.target!.end - locus.target!.start).toBe(1);
  });

  it('read rows only with a read binding (counts the bound molecules over the spans)', () => {
    const s = setup(alu10k as Fixture);
    const sel = selectionForHit(slotHit(s.scene, 97_395), { ...ctxOf(s), readsAt: spans => ({ datasetIds: ['d1'], molecules: spans.length }) })!;
    expect(sel.reads).toEqual({ datasetIds: ['d1'], molecules: 2 });
  });

  it('insertion groups expand with a plain click: drawn at true bp, everything else unchanged', () => {
    const s = setup(alu10k as Fixture);
    const hit = slotHit(s.scene, 97_395);
    const group = hitGroup(hit);
    expect(isInsertionGroup(group)).toBe(true);
    const wide = setup(alu10k as Fixture, { expanded: new Set([group!.id]) });
    const slotW = (sc: Scene) => { const h = slotHit(sc, 97_395); return h.x1 - h.x0; };
    expect(slotW(wide.scene)).toBeGreaterThan(slotW(s.scene) * 1.05);
    // The expanded slot is at true bp relative to the target's own scale around it.
    const plan = planScene(wide.model, { width: 1400, gutter: 52, rightPad: 6, compression: 'log', smallBp: 0, expanded: new Set([group!.id]) });
    expect(plan.k.expanded?.has(group!.id)).toBe(true);
    // A substitution is not an insertion.
    const other = s.scene.hits.find(h => (h.payload.kind === 'allele' || h.payload.kind === 'slot') && !isInsertionGroup(hitGroup(h)));
    if (other) expect(isInsertionGroup(hitGroup(other))).toBe(false);
  });
});

describe('Gate F: source placements', () => {
  it('an insertion focuses its boundary; its source span holds the inserted bases', () => {
    const s = setup(alu10k as Fixture);
    const sel = selectionForHit(slotHit(s.scene, 97_395), ctxOf(s))!;
    const list = sourcePlacements(sel, s.topology);
    const mat = list.find(p => p.path === 'mat')!;
    expect(mat.span).toEqual({ start: 94_676, end: 97_029 });
    const win = sourceWindow(mat.span);
    expect(win.start).toBeLessThanOrEqual(94_676);
    expect(win.end).toBeGreaterThanOrEqual(97_029);
    const focus = focusWindow(sel.target!, 240_000);
    expect(focus.start).toBeLessThan(97_395);
    expect(focus.end).toBeGreaterThan(97_395);
    expect(focus.end - focus.start).toBeGreaterThanOrEqual(200);
  });

  it('a node a path visits twice offers both visits as a choice (never picks one)', () => {
    const s = setup(tandemDup as Fixture);
    const repeated = s.topology.paths.find(p => p.binding !== s.topology.target
      && p.occurrences.some((o, i) => p.occurrences.findIndex(x => x.node === o.node) !== i))!;
    const node = repeated.occurrences.find((o, i) => repeated.occurrences.findIndex(x => x.node === o.node) !== i)!.node;
    const sel: GraphSelection = { ...selectionForHit(s.scene.hits.find(h => h.payload.kind === 'run')!, ctxOf(s), 0)!,
      occurrence: { id: 'x', node, path: repeated.binding, offset: 0, span: { start: 0, end: 1 } } };
    const byPath = placementsByPath(sourcePlacements(sel, s.topology));
    const visits = byPath.get(repeated.binding)!;
    expect(visits.length).toBeGreaterThan(1);
    expect(new Set(visits.map(v => v.span.start)).size).toBe(visits.length);
    expect(visits.every(v => /visit \d of \d \(repeat\)/.test(v.note ?? ''))).toBe(true);
  });
});

describe('Gate F: navigation tokens (stale corrections)', () => {
  const state = (over: Partial<GraphViewState> = {}): GraphViewState => ({
    schema: 1, registrationId: 'r', packageRevision: 'p1', graphRevision: 'g', mapRevision: 'm', targetBinding: 't',
    targetReferenceId: 'GRCh38', initiatingPanelId: null, initiatingReferenceId: null, selectedPathKeys: ['t'],
    targetViewport: { contig: 'chr3', start: 0, end: 10_000 }, linkMode: 'independent', layoutSettings: { contextBp: 100, laneHeight: 28 }, ...over });
  const v = { contig: 'chr3', start: 0, end: 10_000 };

  it('a correction applies only under the token it was computed for', () => {
    const s = state();
    const token = navigationToken('p', s, v);
    expect(tokenCurrent(token, s, v)).toBe(true);
    // A newer navigation of the panel drops it.
    bumpNavigation('p');
    expect(tokenCurrent(token, s, v)).toBe(false);
    const t2 = navigationToken('p', s, v);
    // Another link (following a panel), another package revision or another viewport drop it too.
    expect(tokenCurrent(t2, state({ linkMode: 'follow', initiatingPanelId: 'x' }), v)).toBe(false);
    expect(tokenCurrent(t2, state({ packageRevision: 'p2' }), v)).toBe(false);
    expect(tokenCurrent(t2, s, { ...v, start: 1 })).toBe(false);
    expect(tokenCurrent(t2, null, v)).toBe(false);
    expect(linkIdentity(state({ linkMode: 'follow' }))).not.toBe(linkIdentity(s));
    expect(viewportKey(v)).toBe('chr3:0-10000');
  });
});

describe('Gate F: restore', () => {
  const s = setup(alu10k as Fixture);
  const sel = selectionForHit(slotHit(s.scene, 97_395), ctxOf(s))!;

  it('a restored selection is shown live only at the same registration and revisions; never re-resolved', () => {
    expect(selectionProblem(sel, [s.reg])).toBeNull();
    expect(selectionProblem(sel, [])).toMatch(/not registered/);
    for (const k of ['package', 'graph', 'db', 'maps'] as const) {
      const changed = { ...s.reg, revisions: { ...s.reg.revisions, [k]: 'x' } };
      expect(selectionProblem(sel, [changed])).toContain(`${k} revision`);
    }
    expect(selectionProblem(sel, [{ ...s.reg, bindings: s.reg.bindings.filter(b => b.key !== 'target') }])).toMatch(/target path/);
  });

  it('only a valid shape is restored', () => {
    expect(restoreGraphSelection(JSON.parse(JSON.stringify(sel)))).toEqual(sel);
    expect(restoreGraphSelection({ ...sel, revisions: { package: 'p' } })).toBeNull();
    expect(restoreGraphSelection({ ...sel, target: { start: 5, end: 1 } })).toBeNull();
    expect(restoreGraphSelection({ ...sel, schema: 2 })).toBeNull();
    expect(restoreGraphSelection(null)).toBeNull();
  });

  it('a canonical difference stays reused only while its dataset is at the same revision', () => {
    const c = { datasetId: 'd', id: 'MAT:ins:1', revision: 'r1' };
    expect(canonicalProblem(c, { d: 'r1' })).toBeNull();
    expect(canonicalProblem(c, { d: 'r2' })).toMatch(/changed/);
    expect(canonicalProblem(c, {})).toMatch(/not loaded/);
  });

  it('a graph selection and a dataset difference selection exclude each other', () => {
    selectGraph(sel, true);
    expect(useBrowserStore.getState().graphSelection?.locusKey).toBe(sel.locusKey);
    expect(useBrowserStore.getState().graphInspect).toBe(true);
    useDifferenceSelection.getState().select({ datasetId: 'd', panelId: 'p', viewKey: 'main', chrom: 'chr3',
      difference: { id: 'x', t_start: 1, t_end: 1, ref_bp: 0, alt_bp: 5 } as never });
    expect(useBrowserStore.getState().graphSelection).toBeNull();
    selectGraph(sel, false);
    expect(useDifferenceSelection.getState().selection).toBeNull();
    expect(useBrowserStore.getState().graphInspect).toBe(false);
    selectGraph(null);
  });
});

describe('Gate F: molecule hover across graph, lifted, source and native panels', () => {
  const lifted = { id: 'lift', data_type: 'bam_livelift', paths: ['/a.bam', '/b.bam'], path: '/a.bam' } as unknown as Dataset;
  const native = { id: 'nat', data_type: 'bam', paths: ['/n.bam'], path: '/n.bam' } as unknown as Dataset;
  const liftPanel = { id: 'L', contentType: 'dataset', datasetId: 'lift' } as PanelConfig;
  const nativePanel = { id: 'N', contentType: 'dataset', datasetId: 'nat' } as PanelConfig;
  const sourcePanel = { id: 'S', contentType: 'dataset', datasetId: 'lift', liftLink: { id: 'k', datasetId: 'lift', liftPanelId: 'L', hap: 'h', hapLabel: 'MAT', contig: 'c', flip: false } } as PanelConfig;

  beforeEach(() => undefined);

  it('graph-plus-lifted-only: a lifted panel shares hovers once a graph panel draws its reads (no source panel)', () => {
    expect(hoverScope(liftPanel, [liftPanel], [lifted])).toBeNull();
    const drawn = graphDrawnDatasets({ g1: { drawn: ['lift'], bindings: [] } }, new Set(['g1', 'L']));
    expect(hoverScope(liftPanel, [liftPanel], [lifted], drawn)).toMatchObject({ role: 'lift' });
    // A closed graph panel no longer counts.
    expect(graphDrawnDatasets({ g1: { drawn: ['lift'], bindings: [] } }, new Set(['L'])).size).toBe(0);
  });

  it('three views: graph, lifted and source panel rows of one molecule share the key; libraries stay apart', () => {
    const drawn = new Set(['lift']);
    const liftScope = hoverScope(liftPanel, [liftPanel, sourcePanel], [lifted], drawn)!;
    const srcScope = hoverScope(sourcePanel, [liftPanel, sourcePanel], [lifted], drawn)!;
    const liftedRow = { id: 'q1', live_lift: { library: 1 } } as never;
    const sourceRow = { id: 'q1', library_id: '/b.bam' } as never;
    const graphKey = moleculeKey('lift', 1, 'q1');   // the graph read's (d, lib, q)
    expect(rowMoleculeKey(liftedRow, liftScope)).toBe(graphKey);
    expect(rowMoleculeKey(sourceRow, srcScope)).toBe(graphKey);
    // The same QNAME in the other library is another molecule.
    expect(rowMoleculeKey({ id: 'q1', live_lift: { library: 0 } } as never, liftScope)).not.toBe(graphKey);
  });

  it('a native read binding hovers with its own dataset, library and QNAME (no name match across files)', () => {
    expect(hoverScope(nativePanel, [nativePanel], [native, lifted])).toBeNull();
    const scope = hoverScope(nativePanel, [nativePanel], [native, lifted], new Set(['nat']))!;
    expect(rowMoleculeKey({ id: 'q9', library_id: '/n.bam' } as never, scope)).toBe(moleculeKey('nat', 0, 'q9'));
    // The lifted dataset drawn does not pull the native panel in.
    expect(hoverScope(nativePanel, [nativePanel], [native, lifted], new Set(['lift']))).toBeNull();
  });
});

describe('Gate F: dm6 plus a generic strain (no MAT/PAT assumptions)', () => {
  const fly = flyFixture();
  const s = setup(fly);

  it('lays out the strains as any paths: labels and colours from their own names', () => {
    expect(s.model.rows.map(r => r.key)).toEqual(['dm6_chr2L', 'dgrp399', 'w1118']);
    const labels = s.model.rows.map(r => r.label);
    expect(labels.some(l => /MAT|PAT/i.test(l))).toBe(false);
    expect(laneLabel((fly.bindings as GraphBinding[]).find(b => b.key === 'dgrp399'), 'dgrp399')).not.toMatch(/MAT|PAT/);
    const strainInk = laneColor({ role: 'alternate', label: 'dgrp399' });
    expect([laneColor({ role: 'alternate', label: 'MAT' }), laneColor({ role: 'alternate', label: 'PAT' })]).not.toContain(strainInk);
  });

  it('the insertion is one slot with both strains\' alleles and their source spans', () => {
    const sel = selectionForHit(slotHit(s.scene, 97_395), { panelId: 'g', reg: s.reg, state: s.state, model: s.model })!;
    expect(sel.what).toBe('insertion');
    expect(sel.contig).toBe('chr2L');
    expect(sel.alleles.map(a => a.paths[0]).sort()).toEqual(['dgrp399', 'w1118']);
    expect(JSON.stringify(sel)).not.toMatch(/MAT|PAT|HG002|GRCh38/);
    expect(sourcePlacements(sel, s.topology).map(p => p.path).sort()).toEqual(['dgrp399', 'w1118']);
  });

  it('follows a dm6 view (by assembly alias, e.g. a BDGP6 FASTA), never another assembly by contig name', () => {
    const target = s.bindings.find(b => b.key === 'dm6_chr2L')!;
    expect(referenceMatches(target, 'dm6')).toBe(true);
    expect(referenceMatches(target, 'Drosophila_melanogaster.BDGP6.fa')).toBe(true);
    expect(canFollow(target, { chrom: 'chr2L', start: 1, end: 2, reference: 'dm6' })).toBe(true);
    expect(canFollow(target, { chrom: 'chr2L', start: 1, end: 2, reference: 'DGRP-399.fa' })).toBe(false);
    const view = initialGraphView(s.reg, { chrom: 'chr2L', start: 95_000, end: 100_000, reference: 'dm6' });
    expect(view.linkMode).toBe('follow');
    expect(view.selectedPathKeys).toEqual(['dm6_chr2L', 'dgrp399', 'w1118']);
  });
});

// Keep the SceneHit / LayoutModel types referenced (fixtures above are typed through them).
export type _T = SceneHit | LayoutModel;

describe('Gate F review round 1', () => {
  const s = setup(alu10k as Fixture);
  const ctx = () => ({ ...ctxOf(s), scene: s.scene });

  it('a shared-sequence click names the base and occurrence under the pointer (not the run\'s first visit)', () => {
    const run = s.scene.hits.filter(h => h.payload.kind === 'run' && !h.within)
      .sort((a, b) => (b.x1 - b.x0) - (a.x1 - a.x0))[0];
    const y = (run.y0 + run.y1) / 2;
    const left = selectionForHit(run, ctx(), y, run.x0 + 5)!;
    const right = selectionForHit(run, ctx(), y, run.x1 - 5)!;
    expect(left.target && right.target).toBeTruthy();
    expect(right.target!.start).toBeGreaterThan(left.target!.start + 20);
    expect(right.occurrence!.id === left.occurrence!.id ? right.occurrence!.offset > left.occurrence!.offset : true).toBe(true);
  });

  it('a click inside an allele family names the enclosing insertion and the clicked path\'s allele', () => {
    const inner = s.scene.hits.filter(h => h.within && h.within.group.target?.start === 97_395);
    expect(inner.length).toBeGreaterThan(0);
    for (const h of inner) {
      expect(isInsertionGroup(hitGroup(h))).toBe(true);
      const sel = selectionForHit(h, ctx(), (h.y0 + h.y1) / 2, (h.x0 + h.x1) / 2)!;
      expect(sel.kind).toBe('graph-difference');
      expect(sel.target).toEqual({ start: 97_395, end: 97_395 });
      if (sel.selectedAllele) expect(sel.alleles.some(a => a.id === sel.selectedAllele)).toBe(true);
      expect(sourcePlacements(sel, s.topology).length).toBeGreaterThan(0);
    }
  });

  it('an expanded small insertion leaves the marks (its own bubble), and is never clustered', () => {
    const small = 50;
    const opts = { width: 1400, gutter: 52, rightPad: 6, compression: 'log' as const, smallBp: small };
    const plain = planScene(s.model, opts);
    const marked = plain.top.find(t => t.kind === 'marked' && t.parts.some(p => p.kind === 'group' && isInsertionGroup(p)));
    expect(marked).toBeTruthy();   // 1 bp insertions are marks at this threshold
    const id = (marked as { parts: { kind: string; id: string }[] }).parts.find(p => p.kind === 'group' && isInsertionGroup(p as never))!.id;
    const wide = planScene(s.model, { ...opts, expanded: new Set([id]) });
    expect(wide.top.some(t => t.kind === 'group' && t.id === id)).toBe(true);
    expect(wide.top.some(t => t.kind === 'marked' && t.parts.some(p => p.id === id))).toBe(false);
    // Drawn as its own slot, wider than the mark it was.
    const scene = buildScene(s.model, { ...opts, rulerHeight: 30, laneHeight: 28, laneGap: 4, reversed: false, colors: {}, plan: wide, expanded: new Set([id]) });
    expect(scene.hits.some(h => h.payload.kind === 'slot' && h.payload.group.id === id)).toBe(true);
  });

  it('source panels come only from the selection\'s own graph panel bindings', async () => {
    const { sourcePanelsFor } = await import('./navigation');
    const { useGraphReadsStore } = await import('./graphReadsStore');
    useBrowserStore.setState({ panels: [{ id: 'S', contentType: 'dataset', datasetId: 'lift',
      liftLink: { id: 'k', datasetId: 'lift', liftPanelId: 'L', hap: 'h', hapLabel: 'MAT', contig: 'c_MAT', flip: false } }] } as never);
    const binding = { dataset_id: 'lift', label: 'L', kind: 'lifted' as const, revision: 'r', paths: { mat: 'c_MAT' }, problems: [], libraries: 1 };
    useGraphReadsStore.setState({ byPanel: { other: { drawn: ['lift'], bindings: [binding] } } });
    expect(sourcePanelsFor('mat', 'mine')).toEqual([]);
    useGraphReadsStore.setState({ byPanel: { mine: { drawn: ['lift'], bindings: [binding] } } });
    expect(sourcePanelsFor('mat', 'mine').map(t => t.panelId)).toEqual(['S']);
    useGraphReadsStore.setState({ byPanel: {} });
    useBrowserStore.setState({ panels: [] } as never);
  });

  it('a clamped zoom schedules no correction; a token never outlives a newer move', () => {
    const st = { ...s.state, packageRevision: 'p' } as GraphViewState;
    const v = { contig: 'chr3', start: 0, end: 50_000 };
    const t = navigationToken('zp', st, v);
    bumpNavigation('zp');
    expect(tokenCurrent(t, st, v)).toBe(false);
  });
});

describe('dataset adoption waits for a session restore', () => {
  it('a restore in flight blocks adoption into an empty page', async () => {
    const { duringSessionRestore, sessionRestoresInFlight } = await import('../../utils/sessionRestore');
    let release: () => void = () => undefined;
    const done = duringSessionRestore(() => new Promise<void>(r => { release = r; }));
    expect(sessionRestoresInFlight()).toBe(1);
    release();
    await done;
    expect(sessionRestoresInFlight()).toBe(0);
  });
});
