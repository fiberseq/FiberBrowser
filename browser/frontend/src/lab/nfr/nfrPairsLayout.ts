/**
 * NFR pairs (preview): how the run's elements are drawn, shared by the panel's arcs and matrix and the NFR track over
 * the reads. An NFR with several variants is one element, folded, until it is unfolded (the accessibility store's
 * `expanded`, per run); its arcs then go to the NFR, or to its variants once unfolded. Overlapping elements (an
 * unfolded NFR's variants, a footprint class inside an NFR) get lanes of their own, as a gene track stacks isoforms.
 * Pure: no React, no store.
 */
import type { AccessibilityElement, AccessibilityPair, AccessibilityResult } from './api';
import { filterPairs, pairEffect, pairKey, shortElement, type ElementArc, type PairFilter } from './accessibilityView';

/** An element as drawn: one of the run's, or an NFR folded to one (its variants inside). */
export interface ShownElement extends AccessibilityElement {
  /** The run's elements it stands for: itself, or the folded NFR's variants. */
  members: string[];
  /** An NFR with several elements (variants or depth states): folded to one, or unfolded into them. */
  group?: { nfr: string; size: number; expanded: boolean };
}

/** The NFR elements (variants, depth states, the whole NFR) of each NFR, in the run's order. */
export function nfrMembers(result: Pick<AccessibilityResult, 'elements'> | null): Map<string, AccessibilityElement[]> {
  const out = new Map<string, AccessibilityElement[]>();
  for (const e of result?.elements ?? []) {
    if (e.kind !== 'nfr' || !e.nfr) continue;
    out.set(e.nfr, [...(out.get(e.nfr) ?? []), e]);
  }
  return out;
}

/** The NFRs that fold (several elements each). */
export function foldableNfrs(result: Pick<AccessibilityResult, 'elements'> | null): string[] {
  return [...nfrMembers(result)].filter(([, m]) => m.length > 1).map(([id]) => id);
}

/**
 * The elements as drawn, in the run's order: an NFR not in `expanded` with several elements is one element (id: the
 * NFR's id, 'N1'), the others as they are. Footprint classes only with `includeClasses`.
 */
export function shownElements(result: AccessibilityResult | null, expanded: readonly string[], includeClasses = true): ShownElement[] {
  if (!result) return [];
  const groups = nfrMembers(result);
  const open = new Set(expanded);
  const out: ShownElement[] = [];
  const folded = new Set<string>();
  for (const e of result.elements) {
    if (e.kind === 'tf') { if (includeClasses) out.push({ ...e, members: [e.id] }); continue; }
    const members = e.nfr ? groups.get(e.nfr) ?? [e] : [e];
    if (members.length < 2 || !e.nfr) { out.push({ ...e, members: [e.id] }); continue; }
    const group = { nfr: e.nfr, size: members.length, expanded: open.has(e.nfr) };
    if (group.expanded) { out.push({ ...e, members: [e.id], group }); continue; }
    if (folded.has(e.nfr)) continue;
    folded.add(e.nfr);
    const region = result.nfrs.find(n => n.id === e.nfr);
    const word = members.every(m => m.subtype === 'depth') ? 'states' : 'variants';
    out.push({
      id: e.nfr, kind: 'nfr', subtype: 'nfr', nfr: e.nfr,
      start: Math.min(...members.map(m => m.start)), end: Math.max(...members.map(m => m.end)),
      label: `${e.nfr} (${members.length} ${word})`,
      // open on a read in any of its variants: what is not closed
      prevalence: region?.closed != null ? 1 - region.closed : null,
      n: Math.max(...members.map(m => m.n)),
      members: members.map(m => m.id), group,
    });
  }
  return out;
}

/** Each run element's id -> the id of the element that draws it (a folded NFR draws its variants). */
export function shownIdOf(shown: readonly ShownElement[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of shown) for (const m of s.members) out.set(m, s.id);
  return out;
}

/** An arc between two drawn elements (`from`, `to`); its pair stays the run's pair (a variant pair of folded NFRs). */
export interface ShownArc extends ElementArc { from: string; to: string }

/**
 * The arcs between drawn elements: each pair's arc runs between the elements that draw its two ends. A pair inside
 * one folded NFR has no arc; `inner` counts them per NFR (unfold it to see them).
 */
export function shownArcs(arcs: readonly ElementArc[], shown: readonly ShownElement[]): { arcs: ShownArc[]; inner: Map<string, number> } {
  const of = shownIdOf(shown);
  const byId = new Map(shown.map(s => [s.id, s]));
  const out: ShownArc[] = [];
  const inner = new Map<string, number>();
  for (const arc of arcs) {
    const from = of.get(arc.pair.a), to = of.get(arc.pair.b);
    if (!from || !to) continue;
    if (from === to) { inner.set(from, (inner.get(from) ?? 0) + 1); continue; }
    const a = byId.get(from)!, b = byId.get(to)!;
    const ca = (a.start + a.end) / 2, cb = (b.start + b.end) / 2;
    out.push({ ...arc, from, to, start: Math.min(ca, cb), end: Math.max(ca, cb), distance: Math.abs(cb - ca) });
  }
  return { arcs: out, inner };
}

/**
 * Lanes for drawn elements, as a gene track stacks isoforms: an element goes in the first lane where it overlaps
 * nothing (overlapping elements: distinct lanes; elements apart: one lane). NFR elements take the top lanes, footprint
 * classes the lanes under them. Genomic (not pixel) overlap, so every view of a run lays it out the same way.
 */
export function assignLanes(elements: readonly Pick<AccessibilityElement, 'id' | 'kind' | 'start' | 'end'>[]): { lanes: Map<string, number>; count: number } {
  const lanes = new Map<string, number>();
  let offset = 0;
  for (const kind of ['nfr', 'tf'] as const) {
    const ends: number[] = [];
    const items = elements.filter(e => (kind === 'tf' ? e.kind === 'tf' : e.kind !== 'tf'))
      .map((e, i) => ({ e, i }))
      .sort((x, y) => x.e.start - y.e.start || y.e.end - x.e.end || x.i - y.i);
    for (const { e } of items) {
      let lane = ends.findIndex(end => e.start >= end);
      if (lane < 0) { lane = ends.length; ends.push(e.end); } else ends[lane] = e.end;
      lanes.set(e.id, offset + lane);
    }
    offset += ends.length;
  }
  return { lanes, count: offset };
}

/** The run's elements a drawn or selected id stands for: an element itself, or an NFR's ('N1') elements. */
export function membersOf(result: Pick<AccessibilityResult, 'elements'> | null, id: string): string[] {
  const els = result?.elements ?? [];
  if (els.some(e => e.id === id)) return [id];
  return els.filter(e => e.kind === 'nfr' && e.nfr === id).map(e => e.id);
}

/** Strongest first: |adjusted effect| (undefined last), then q. */
const strongest = (x: AccessibilityPair, y: AccessibilityPair) =>
  Math.abs(pairEffect(y) ?? -1) - Math.abs(pairEffect(x) ?? -1) || x.q - y.q;

/**
 * The tested pairs between two drawn or selected ids (an element, or a folded NFR's elements), strongest first: the
 * ones that pass the panel's filters before the others.
 */
export function pairsBetween(result: AccessibilityResult | null, a: string, b: string, filter?: PairFilter | null): AccessibilityPair[] {
  if (!result) return [];
  const A = new Set(membersOf(result, a)), B = new Set(membersOf(result, b));
  const passing = new Set(filter ? filterPairs(result, filter).map(p => pairKey(p.a, p.b)) : []);
  return result.pairs.filter(p => (A.has(p.a) && B.has(p.b)) || (A.has(p.b) && B.has(p.a)))
    .sort((x, y) => Number(passing.has(pairKey(y.a, y.b))) - Number(passing.has(pairKey(x.a, x.b))) || strongest(x, y));
}

/**
 * The pair to inspect for two picks (an element or an NFR each, as on the arcs, the matrix or the NFR track): two
 * elements as they are (an untested pair says why in the card), else the strongest tested pair between them. An error
 * in plain words when there is none.
 */
export function pairForPicks(result: AccessibilityResult | null, a: string, b: string, filter?: PairFilter | null): { a: string; b: string } | { error: string } {
  if (!result) return { error: 'Find NFR variants first.' };
  const A = membersOf(result, a), B = membersOf(result, b);
  const byId = new Map(result.elements.map(e => [e.id, e]));
  const name = (id: string) => (byId.has(id) ? shortElement(byId.get(id), id) : id);
  if (!A.length || !B.length) return { error: 'That element is not in the shown run.' };
  if (A.some(x => B.includes(x))) return { error: `Pick two different elements (${name(a)} and ${name(b)} are the same NFR).` };
  const skipped = new Map(result.family.skipped.map(s => [pairKey(s.a, s.b), s.reason]));
  if (A.length === 1 && B.length === 1) {
    // an NFR picked as such ('N1') with one element: that element
    const [ea, eb] = [A[0], B[0]];
    if (skipped.get(pairKey(ea, eb)) === 'overlap') return { error: `${name(ea)} and ${name(eb)} overlap: one opening cannot be two elements, so the pair is not tested.` };
    return { a: ea, b: eb };
  }
  const best = pairsBetween(result, a, b, filter)[0];
  if (best) return { a: best.a, b: best.b };
  return { error: `No pair between ${name(a)} and ${name(b)} was tested.` };
}
