/**
 * Graph selections (DESIGN_GRAPH_PANEL.md §6, Gate F): what a click on the graph panel names, as data the inspector
 * shows without any dataset. Two kinds, never confused with a dataset difference:
 *
 * - `graph-difference`: a selected-path bubble (insertion, deletion, substitution, inversion, complex region) or a
 *   fragment junction's alleles: the target span (an empty span at an insertion boundary), every allele with its
 *   paths, true length and source spans, the paths with no verified traversal, completeness and provenance;
 * - `graph-locus`: a stretch of shared sequence, a graph gap, a cluster or an open end: its target position, the
 *   clicked occurrence (node, path, source span) and the paths through it.
 *
 * A selection names its registration and revisions; restored, it is shown only when they still match (never
 * re-resolved by nearest geometry). The layout's bubble key is a locus identity, not a biological difference ID: a
 * canonical live-lift difference is attached only by the server's exact match (/api/graph/differences).
 */
import type { AltAllele, GroupItem, JunctionItem, LayoutModel, Visit } from './layout';
import { visitPiece } from './layout';
import { placementAt, type HitPayload, type Scene, type SceneHit } from './scene';
import type { GraphRegistration, GraphTopology, GraphViewState, Span } from './types';

export type GraphSelectionKind = 'graph-difference' | 'graph-locus';
export type GraphLocusWhat = 'insertion' | 'deletion' | 'substitution' | 'inversion' | 'complex' | 'junction'
  | 'sequence' | 'gap' | 'cluster' | 'open end';

export interface GraphAlleleInfo {
  id: string;
  /** Paths carrying it (binding keys, lane order). */
  paths: string[];
  bp: number;
  status: string;
  inverted: boolean;
  /** Each carrier's source span (an empty span at the boundary for a deletion). */
  source: { path: string; span: Span }[];
  reason?: string;
}

export interface GraphCanonical { datasetId: string; id: string; revision: string; label?: string }

export interface GraphSelection {
  schema: 1;
  kind: GraphSelectionKind;
  what: GraphLocusWhat;
  panelId: string;
  registrationId: string;
  revisions: { package: string; graph: string; db: string; maps: string };
  targetBinding: string;
  targetReference: string | null;
  contig: string;
  /** Target span; an empty span (start === end) at an insertion boundary. Null: no target backing. */
  target: Span | null;
  /** The layout locus (bubble group, run, junction, cluster): not a biological difference identity. */
  locusKey: string;
  /** The allele clicked, if any. */
  selectedAllele: string | null;
  alleles: GraphAlleleInfo[];
  /** The target's own allele (the base) and the paths sharing it. */
  base: { paths: string[]; bp: number } | null;
  unavailable: string[];
  /** graph-locus: the clicked occurrence. */
  occurrence: { id: string; node: string; path: string; offset: number; span: Span } | null;
  complete: boolean;
  /** direct: named-walk matches; inferred: map-inferred correspondence somewhere in view; unresolved: an allele
   * without verified placement. */
  provenance: 'direct' | 'inferred' | 'unresolved';
  canonical: GraphCanonical | null;
  /** Read binding(s) whose molecules were drawn here when it was selected (read-dependent rows need one). */
  reads: { datasetIds: string[]; molecules: number; revisions?: Record<string, string> } | null;
  /** Where "Show source span" can go (sourcePlacements, computed when selected). */
  placements?: SourcePlacement[];
  reason?: string;
}

function alleleInfo(a: AltAllele): GraphAlleleInfo {
  return { id: a.id, paths: [...a.carriers], bp: a.bp, status: a.status, inverted: Boolean(a.inverted),
    source: a.source.map(s => ({ path: s.path, span: { ...s.span } })), ...(a.reason ? { reason: a.reason } : {}) };
}

/** Every allele of a group: a family's lead and its members (each its own carriers and walk), once each. */
function allelesOf(alts: AltAllele[]): AltAllele[] {
  const out: AltAllele[] = [];
  const seen = new Set<string>();
  const add = (a: AltAllele) => { if (!seen.has(a.id)) { seen.add(a.id); out.push(a); } };
  for (const a of alts) {
    add(a);
    for (const m of a.family?.members ?? []) add(m);
  }
  return out;
}

export function groupWhat(g: GroupItem): GraphLocusWhat {
  if (g.type === 'complex') return 'complex';
  if (g.alts.some(a => a.inverted)) return 'inversion';
  const span = g.target ? g.target.end - g.target.start : g.base.bp;
  if (span === 0 && g.alts.some(a => a.bp > 0)) return 'insertion';
  if (g.alts.every(a => a.bp === 0)) return 'deletion';
  return 'substitution';
}

/** Whether a group is an insertion slot (a plain click expands it). */
export function isInsertionGroup(g: GroupItem | JunctionItem | null | undefined): g is GroupItem {
  return Boolean(g && g.kind === 'group' && groupWhat(g) === 'insertion');
}

/** The group a hit is about (an allele inside a family names its enclosing group). */
export function hitGroup(hit: SceneHit): GroupItem | JunctionItem | null {
  // Anything inside an allele family's tube (its shared runs, sub-bubbles, marks) belongs to the enclosing group.
  if (hit.within) return hit.within.group;
  const p = hit.payload;
  if (p.kind === 'allele' || p.kind === 'filler' || p.kind === 'base' || p.kind === 'slot' || p.kind === 'complex') return p.group;
  return null;
}

/** The path a click means: an allele's lane, a shared tube's clicked stripe (else its host). */
function clickedPath(hit: SceneHit, y?: number): string | null {
  const p = hit.payload;
  if (p.kind === 'allele') {
    const stripe = y !== undefined ? p.stripes?.find(s => y >= s.y0 && y <= s.y1) : undefined;
    return stripe?.key ?? p.lane;
  }
  if (p.kind === 'filler') return p.lane;
  if (p.kind === 'run') {
    const stripe = y !== undefined ? p.stripes?.find(s => y >= s.y0 && y <= s.y1) : undefined;
    return stripe?.key ?? p.host;
  }
  if (p.kind === 'base') return p.lane;
  return null;
}

/** The allele of the selection a click names: inside a family, the member carried by the clicked path (else the
 * family's lead), never an inner sub-bubble's own allele (it is not one of the group's alleles). */
function chosenAllele(hit: SceneHit, path: string | null): string | null {
  if (hit.within) {
    const lead = hit.within.allele;
    const all = [lead, ...(lead.family?.members ?? [])];
    return (path ? all.find(a => a.carriers.includes(path)) : undefined)?.id ?? lead.id;
  }
  const p = hit.payload;
  return p.kind === 'allele' || p.kind === 'filler' ? p.allele.id : null;
}

/** A shared run's occurrence under x on `path` (the scene's occurrence transform: carrier stripe, reversal), with
 * the path-forward offset in it and the target base there (target-backed geometry only). */
function runAt(p: Extract<HitPayload, { kind: 'run' }>, path: string, scene: Scene | undefined, x: number | undefined):
  { visit: Visit; offset: number; target: number | null } {
  const index = p.run.visits.indexOf(p.visit);
  const fallback: Visit = (path === p.host ? p.visit : p.run.byCarrier?.[path]?.[index]) ?? p.visit;
  if (!scene || x === undefined) return { visit: fallback, offset: 0, target: p.visit.target?.start ?? p.run.target?.start ?? null };
  const at = placementAt(scene, x, p.run.id, undefined, path) ?? placementAt(scene, x, p.run.id);
  const pool = [...p.run.visits, ...Object.values(p.run.byCarrier ?? {}).flat().filter((v): v is Visit => Boolean(v))];
  const visit = (at && pool.find(v => v.occ.id === at.place.occ)) || fallback;
  // The target base from the same occurrence inverse: the host's own visit under x on a target-backed run (its
  // path is the target, so its path offset is the target coordinate). Never a separately rounded screen inverse.
  const hostAt = placementAt(scene, x, p.run.id, undefined, p.host) ?? (path === p.host ? at : null);
  const hostVisit = hostAt ? pool.find(v => v.occ.id === hostAt.place.occ) : null;
  const target = hostAt && hostVisit?.target ? hostVisit.occ.path_span.start + hostAt.offset : null;
  return { visit, offset: at ? at.offset : 0, target };
}

function provenanceOf(alleles: GraphAlleleInfo[], model: LayoutModel): GraphSelection['provenance'] {
  if (alleles.some(a => a.status === 'unresolved')) return 'unresolved';
  return model.correspondenceComplete ? 'direct' : 'inferred';
}

export interface SelectionContext {
  panelId: string;
  reg: GraphRegistration;
  state: GraphViewState;
  model: LayoutModel;
  /** The scene the hit is on (a click's occurrence and target base come from its transforms). */
  scene?: Scene;
  /** The read bindings drawn and the molecules over a source span (read-dependent rows). */
  readsAt?: (source: { path: string; span: Span }[]) => { datasetIds: string[]; molecules: number; revisions?: Record<string, string> } | null;
}

function base(ctx: SelectionContext): Pick<GraphSelection, 'schema' | 'panelId' | 'registrationId' | 'revisions' | 'targetBinding' | 'targetReference' | 'contig' | 'canonical'> {
  const target = ctx.reg.bindings.find(b => b.key === ctx.state.targetBinding);
  return {
    schema: 1, panelId: ctx.panelId, registrationId: ctx.reg.id,
    revisions: { package: ctx.reg.revisions.package, graph: ctx.reg.revisions.graph, db: ctx.reg.revisions.db, maps: ctx.reg.revisions.maps },
    targetBinding: ctx.state.targetBinding ?? '', targetReference: target?.reference ?? ctx.state.targetReferenceId ?? null,
    contig: target?.path.contig ?? ctx.state.targetViewport?.contig ?? '', canonical: null,
  };
}

/** The selection a hit names (null: nothing selectable there, e.g. connector filler with no allele). */
export function selectionForHit(hit: SceneHit, ctx: SelectionContext, y?: number, x?: number): GraphSelection | null {
  const p: HitPayload = hit.payload;
  const g = hitGroup(hit);
  if (g) {
    const alts = g.kind === 'group' ? allelesOf(g.alts) : g.alts;
    const alleles = alts.map(alleleInfo);
    const path = clickedPath(hit, y);
    const picked = chosenAllele(hit, path);
    const chosen = picked && alleles.some(a => a.id === picked) ? picked : null;
    const source = alleles.flatMap(a => a.source);
    // A click on sequence inside the allele also names that occurrence.
    const inRun = p.kind === 'run' && path ? runAt(p, path, ctx.scene, x) : null;
    return {
      ...base(ctx), kind: 'graph-difference', what: g.kind === 'group' ? groupWhat(g) : 'junction',
      target: g.target ? { ...g.target } : null, locusKey: g.id, selectedAllele: chosen, alleles,
      base: g.kind === 'group' ? { paths: [...g.base.carriers], bp: g.base.bp } : null,
      unavailable: g.kind === 'group' ? [...g.unavailable] : [],
      occurrence: inRun && path ? { id: inRun.visit.occ.id, node: inRun.visit.occ.node, path, offset: inRun.offset, span: visitPiece(inRun.visit.occ) } : null,
      complete: ctx.model.complete && alleles.every(a => a.status === 'ok'),
      provenance: provenanceOf(alleles, ctx.model), reads: ctx.readsAt?.(source) ?? null,
      ...(g.kind === 'group' && g.reason ? { reason: g.reason } : {}),
    };
  }
  if (p.kind === 'run') {
    // The carrier whose stripe was clicked (its own occurrence of the node under x), else the host's.
    const path = clickedPath(hit, y) ?? p.host;
    const { visit, offset, target: at } = runAt(p, path, ctx.scene, x);
    const piece = visitPiece(visit.occ);
    return {
      ...base(ctx), kind: 'graph-locus', what: 'sequence',
      target: at != null ? { start: at, end: at + 1 } : null, locusKey: p.run.id, selectedAllele: null, alleles: [],
      base: { paths: [...p.run.carriers], bp: p.run.bp }, unavailable: [],
      occurrence: { id: visit.occ.id, node: visit.occ.node, path, offset, span: piece },
      complete: ctx.model.complete, provenance: ctx.model.correspondenceComplete ? 'direct' : 'inferred',
      reads: ctx.readsAt?.([{ path, span: piece }]) ?? null,
    };
  }
  if (p.kind === 'gap') {
    const span = (p.gap ?? p.junction.gap)?.span ?? p.junction.target;
    return {
      ...base(ctx), kind: 'graph-locus', what: 'gap', target: { ...span }, locusKey: p.junction.id, selectedAllele: null,
      alleles: p.junction.alts.map(alleleInfo), base: null, unavailable: [...p.junction.stops], occurrence: null,
      complete: false, provenance: 'unresolved', reads: null, reason: (p.gap ?? p.junction.gap)?.kind ?? 'gap',
    };
  }
  if (p.kind === 'cluster') {
    return {
      ...base(ctx), kind: 'graph-locus', what: 'cluster', target: { ...p.cluster.target }, locusKey: p.cluster.id,
      selectedAllele: null, alleles: [], base: null, unavailable: [], occurrence: null, complete: ctx.model.complete,
      provenance: ctx.model.correspondenceComplete ? 'direct' : 'inferred', reads: null,
      reason: `${p.cluster.variants} differences clustered (zoom in to separate them)`,
    };
  }
  if (p.kind === 'end') {
    return {
      ...base(ctx), kind: 'graph-locus', what: 'open end', target: { start: p.end.at, end: p.end.at }, locusKey: `end:${p.end.path}:${p.end.side}:${p.end.at}`,
      selectedAllele: null, alleles: p.end.source ? [{ id: `end:${p.end.path}`, paths: [p.end.path], bp: p.end.bp, status: 'unresolved',
        inverted: false, source: [{ path: p.end.path, span: { ...p.end.source } }] }] : [],
      base: null, unavailable: [], occurrence: null, complete: false, provenance: 'unresolved', reads: null,
      reason: p.end.reason.replace(/_/g, ' '),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------- placements

/** One place a selection's source sequence can be shown: a path's span (an occurrence's piece, an allele's span). */
export interface SourcePlacement { path: string; span: Span; occurrence?: string; note?: string }

/**
 * Where "Show source span" can go: each allele's carrier spans (an insertion's span holds the inserted bases), or
 * for a locus every occurrence of the clicked node on each path through it (a repeat visits it more than once: each
 * visit is a distinct placement, offered as a choice, never picked for the user).
 */
export function sourcePlacements(sel: GraphSelection, topology: GraphTopology | null): SourcePlacement[] {
  const out: SourcePlacement[] = [];
  const seen = new Set<string>();
  const add = (p: SourcePlacement) => {
    const k = `${p.path}|${p.span.start}|${p.span.end}`;
    if (!seen.has(k)) { seen.add(k); out.push(p); }
  };
  if (sel.kind === 'graph-difference' || sel.what === 'open end' || sel.what === 'gap') {
    const alleles = sel.selectedAllele ? sel.alleles.filter(a => a.id === sel.selectedAllele) : sel.alleles;
    for (const a of alleles) for (const s of a.source) add({ path: s.path, span: s.span, note: `${a.bp.toLocaleString('en-US')} bp allele` });
    return out;
  }
  if (sel.occurrence && topology) {
    for (const path of topology.paths) {
      if (path.binding === topology.target) continue;
      const visits = path.occurrences.filter(o => o.node === sel.occurrence!.node);
      visits.forEach((o, i) => add({ path: path.binding, span: visitPiece(o), occurrence: o.id,
        note: visits.length > 1 ? `visit ${i + 1} of ${visits.length} (repeat)` : undefined }));
    }
  }
  return out;
}

/** Placements grouped by path: a path with more than one is ambiguous (the menu lists each). */
export function placementsByPath(list: SourcePlacement[]): Map<string, SourcePlacement[]> {
  const out = new Map<string, SourcePlacement[]>();
  for (const p of list) (out.get(p.path) ?? out.set(p.path, []).get(p.path)!).push(p);
  return out;
}

/** The target window that focuses a selection: padded, at least 200 bp, an insertion boundary at its centre. */
export function focusWindow(target: Span, size: number | null, maxBp = 50_000): Span {
  const len = Math.min(maxBp, Math.max(200, (target.end - target.start) * 3));
  const mid = (target.start + target.end) / 2;
  let start = Math.max(0, Math.round(mid - len / 2));
  let end = start + Math.round(len);
  if (size != null && end > size) { end = size; start = Math.max(0, end - Math.round(len)); }
  return { start, end };
}

/** A source window that shows a placement whole (the inserted bases included), padded on both sides. */
export function sourceWindow(span: Span, maxBp = 50_000): Span {
  const len = Math.max(1, span.end - span.start);
  const pad = Math.max(100, Math.round(len * 0.25));
  const start = Math.max(0, span.start - pad);
  return { start, end: Math.min(start + maxBp, span.end + pad) };
}

// ---------------------------------------------------------------------------------------------------- restore

export function isGraphSelection(v: unknown): v is GraphSelection {
  const s = v as GraphSelection | null;
  const span = (x: unknown) => x === null || (typeof x === 'object' && x !== null && Number.isFinite((x as Span).start)
    && Number.isFinite((x as Span).end) && (x as Span).end >= (x as Span).start);
  return Boolean(s && typeof s === 'object' && s.schema === 1 && (s.kind === 'graph-difference' || s.kind === 'graph-locus')
    && typeof s.panelId === 'string' && typeof s.registrationId === 'string' && typeof s.locusKey === 'string'
    && s.revisions && ['package', 'graph', 'db', 'maps'].every(k => typeof (s.revisions as Record<string, unknown>)[k] === 'string')
    && typeof s.targetBinding === 'string' && span(s.target) && Array.isArray(s.alleles)
    && s.alleles.every(a => a && typeof a.id === 'string' && Array.isArray(a.paths) && Number.isFinite(a.bp) && Array.isArray(a.source)
      && a.source.every(x => x && typeof x.path === 'string' && span(x.span))));
}

/**
 * Why a (restored) selection can't be shown live: its package is not registered or changed (any of its four
 * revisions), or its target binding is gone. Null: it is current. A stale selection keeps its frozen coordinates;
 * it is never moved to the nearest geometry of another revision.
 */
export function selectionProblem(sel: GraphSelection, regs: readonly GraphRegistration[]): string | null {
  const reg = regs.find(r => r.id === sel.registrationId);
  if (!reg) return 'Its graph package is not registered on this server.';
  const changed = (['package', 'graph', 'db', 'maps'] as const).filter(k => reg.revisions[k] !== sel.revisions[k]);
  if (changed.length) return `Its graph package changed since it was selected (${changed.join(', ')} revision).`;
  if (!reg.bindings.some(b => b.key === sel.targetBinding)) return 'Its target path is no longer in the package.';
  return null;
}

/** A canonical difference is still the one it named only while its dataset is at the same revision. */
export function canonicalProblem(c: GraphCanonical | null, revisions: Record<string, string>): string | null {
  if (!c) return null;
  const now = revisions[c.datasetId];
  if (now === undefined) return 'Its live-lift dataset is not loaded.';
  return now === c.revision ? null : 'Its live-lift dataset changed (another file or map); the difference is not reused.';
}
