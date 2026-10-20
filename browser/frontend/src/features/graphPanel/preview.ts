/**
 * The thin topology preview (Gate B): the helper's selected-path walks drawn against the target's own coordinates,
 * without the joint bubble layout of Gates C–D.
 *
 * - The target lane is its named walk: each visit's clipped piece at its true target position.
 * - An alternate's visit that the helper matched directly to a target visit (same node, `direct_named_walk`) is drawn
 *   over that target visit, in the alternate's colour; an opposite-orientation match is marked reverse.
 * - Consecutive unmatched alternate visits form one run: between two matched pieces that touch it is an insertion at
 *   their boundary, labelled with its true length; across a target stretch it is a divergent stretch (both lengths).
 *   Target sequence an alternate skips between two matched pieces is a deletion. A run without a matched neighbour
 *   is "unplaced": it is listed with its length, never drawn at a made-up position.
 * - A visit matched to several target visits (a repeat) is not placed either.
 * - Missing coverage and every helper summary stay visible (the panel's status line); nothing is called complete
 *   that the helper did not report complete.
 */
import type { GraphBinding, GraphOccurrence, GraphTopology, Span } from './types';

export type PieceKind = 'node' | 'insertion' | 'deletion' | 'divergent' | 'unavailable';

export interface PreviewPiece {
  kind: PieceKind;
  /** Target coordinates (an insertion: start === end, its boundary). */
  start: number;
  end: number;
  /** Sequence bp this piece stands for on its own path (insertion/divergent: the alternate's run). */
  bp: number;
  reverse?: boolean;
  node?: string;
  occurrence?: string;
  /** The alternate's source span for runs (insertion/divergent/unplaced). */
  source?: Span;
}

export interface PreviewLane {
  key: string;
  label: string;
  title: string;
  role: 'target' | 'alternate';
  pieces: PreviewPiece[];
  /** Unplaced runs (no matched neighbour, or a repeat): listed, not drawn. */
  unplaced: { bp: number; source: Span }[];
  complete: boolean;
  uncoveredBp: number;
  visits: number;
  /** Placed visits whose connection is not one continuous same-orientation walk (left unresolved). */
  transitions: number;
}

export interface GraphPreview {
  interval: Span;
  lanes: PreviewLane[];
  complete: boolean;
  correspondenceComplete: boolean;
  summaries: string[];
  nodes: number;
  edges: number;
  visits: number;
}

/** A visit's piece inside the requested window, in its own path's coordinates. */
export function visitPiece(o: GraphOccurrence): Span {
  return { start: o.path_span.start + o.clip.start, end: o.path_span.start + o.clip.end };
}

/** The lane label: the binding key, without a trailing "_<its contig>" (per-chromosome packages), upper-cased when
 * short (MAT/PAT are display labels only; their colours follow the label). */
export function laneLabel(binding: GraphBinding | undefined, key: string): string {
  let k = binding?.key ?? key;
  const contig = binding?.path.contig;
  if (contig && k.endsWith(`_${contig}`) && k.length > contig.length + 1) k = k.slice(0, -(contig.length + 1));
  return k.length <= 4 ? k.toUpperCase() : k;
}

function laneTitle(binding: GraphBinding | undefined, key: string): string {
  if (!binding) return key;
  const p = binding.path;
  return `${binding.assembly} · ${p.sample}#${p.haplotype}#${p.contig}`;
}

function summaryText(s: Record<string, unknown>): string {
  const reason = String(s.reason ?? s.kind ?? 'summary');
  const span = s.span as Span | undefined;
  const where = span ? ` ${span.start.toLocaleString('en-US')}-${span.end.toLocaleString('en-US')}` : '';
  const binding = s.binding ? ` (${s.binding})` : '';
  return `${reason.replace(/_/g, ' ')}${binding}${where}`;
}

function clipTo(span: Span, window: Span): Span | null {
  const start = Math.max(span.start, window.start), end = Math.min(span.end, window.end);
  return end > start ? { start, end } : null;
}

function coverageGaps(coverage: { span: Span; kind: string }[], window: Span | null): { pieces: PreviewPiece[]; bp: number } {
  const pieces: PreviewPiece[] = [];
  let bp = 0;
  for (const c of coverage) {
    if (c.kind === 'covered') continue;
    bp += Math.max(0, c.span.end - c.span.start);
    const clipped = window ? clipTo(c.span, window) : null;
    if (clipped) pieces.push({ kind: 'unavailable', start: clipped.start, end: clipped.end, bp: clipped.end - clipped.start });
  }
  return { pieces, bp };
}

/** Where an alternate's matched visit falls on the target: the same node offsets, mirrored for a reverse match. */
function placeOnTarget(alt: GraphOccurrence, target: GraphOccurrence, reverse: boolean): Span {
  const tStart = target.path_span.start, tEnd = target.path_span.end;
  const a = reverse ? tEnd - alt.clip.end : tStart + alt.clip.start;
  const b = reverse ? tEnd - alt.clip.start : tStart + alt.clip.end;
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

export function buildPreview(topology: GraphTopology, bindings: GraphBinding[]): GraphPreview {
  const window = topology.interval;
  const byKey = new Map(bindings.map(b => [b.key, b]));
  const targetPath = topology.paths.find(p => p.binding === topology.target) ?? topology.paths[0];
  const targetOcc = new Map((targetPath?.occurrences ?? []).map(o => [o.id, o]));
  // A target stretch an event spans must be named target sequence of one covered portion (one fragment), wholly
  // inside the requested window; a boundary (empty stretch) must lie within or at the edge of one.
  const covered = (targetPath?.coverage ?? []).filter(c => c.kind === 'covered');
  const targetCovered = (span: Span) => span.start >= window.start && span.end <= window.end
    && covered.some(c => span.start >= c.span.start && span.end <= c.span.end);
  // Direct matches per alternate visit (several: a repeat, not placed).
  const matches = new Map<string, { target: string; reverse: boolean }[]>();
  // How many visits of one compared path match each target visit: more than one (a duplication) is not placed.
  const perTarget = new Map<string, number>();
  for (const m of topology.direct_matches ?? []) {
    if (!targetOcc.has(m.target_occurrence)) continue;
    const list = matches.get(m.source_occurrence) ?? [];
    list.push({ target: m.target_occurrence, reverse: m.reverse });
    matches.set(m.source_occurrence, list);
    const k = `${m.source_binding}\u0000${m.target_occurrence}`;
    perTarget.set(k, (perTarget.get(k) ?? 0) + 1);
  }
  const lanes: PreviewLane[] = [];
  let visits = 0;
  for (const path of topology.paths) {
    visits += path.occurrences.length;
    const binding = byKey.get(path.binding);
    const isTarget = path.binding === topology.target;
    const lane: PreviewLane = {
      key: path.binding, label: laneLabel(binding, path.binding), title: laneTitle(binding, path.binding),
      role: isTarget ? 'target' : 'alternate', pieces: [], unplaced: [], complete: path.complete,
      uncoveredBp: 0, transitions: 0, visits: path.occurrences.length,
    };
    if (isTarget) {
      for (const o of path.occurrences) {
        const span = clipTo(visitPiece(o), window);
        if (span) lane.pieces.push({ kind: 'node', ...span, bp: span.end - span.start, reverse: o.reverse, node: o.node, occurrence: o.id });
      }
      const gaps = coverageGaps(path.coverage, window);
      lane.pieces.push(...gaps.pieces);
      lane.uncoveredBp = gaps.bp;
    } else {
      // Walk the alternate in its own order, placing matched visits and collecting the runs between them. An event
      // between two placed visits (insertion, deletion, divergent stretch) is asserted only when the alternate is one
      // continuous walk from the first to the second (same fragment, each visit starting where the last ended), both
      // keep the same relative orientation, and the second follows the first along the target in that orientation.
      // Anything else (a coverage gap, a fragment change, an inversion breakpoint, a repeat) is an unresolved
      // transition: its run is listed as unplaced and no target stretch is called deleted.
      let previous: PreviewPiece | null = null;
      let previousOcc: GraphOccurrence | null = null;
      let run: GraphOccurrence[] = [];
      const visitLength = (o: GraphOccurrence) => o.path_span.end - o.path_span.start;
      const continuous = (from: GraphOccurrence, through: GraphOccurrence[], to: GraphOccurrence) => {
        // The window may cut a visit: then the walk between the two is not all here.
        if (from.clip.end !== visitLength(from) || to.clip.start !== 0) return false;
        const walk = [from, ...through, to];
        for (let i = 1; i < walk.length; i++) {
          if (walk[i].fragment !== walk[i - 1].fragment || walk[i].path_span.start !== walk[i - 1].path_span.end) return false;
          // Only a whole visit can sit between two others; a clipped middle means the window cut the walk.
          if (i < walk.length - 1 && (walk[i].clip.start !== 0 || walk[i].clip.end !== visitLength(walk[i]))) return false;
        }
        return true;
      };
      const ordered = (a: PreviewPiece, b: PreviewPiece) => (a.reverse === b.reverse) && (a.reverse ? b.end <= a.start : b.start >= a.end);
      const between = (a: PreviewPiece, b: PreviewPiece) => (a.reverse ? { start: b.end, end: a.start } : { start: a.end, end: b.start });
      const flushRun = (next: PreviewPiece | null, nextOcc: GraphOccurrence | null) => {
        const runBp = run.reduce((n, o) => n + (o.clip.end - o.clip.start), 0);
        const pieces = run.map(visitPiece);
        const source = run.length ? { start: Math.min(...pieces.map(p => p.start)), end: Math.max(...pieces.map(p => p.end)) } : null;
        const gap = previous && next ? between(previous, next) : null;
        // Wholly outside the view (anchored by visits beyond it): not this window's business.
        const outside = gap && (gap.end > gap.start ? gap.end <= window.start || gap.start >= window.end
          : gap.start < window.start || gap.start > window.end);
        const shown = gap ? (gap.end > gap.start ? clipTo(gap, window) : gap) : null;
        if (outside && previous && next) {
          run = [];
          return;
        }
        if (previous && next && previousOcc && nextOcc && shown && continuous(previousOcc, run, nextOcc) && ordered(previous, next)
            && targetCovered(shown)) {
          if (run.length) {
            if (gap!.end > gap!.start) lane.pieces.push({ kind: 'divergent', ...shown, bp: runBp, source: source! });
            else lane.pieces.push({ kind: 'insertion', start: gap!.start, end: gap!.start, bp: runBp, source: source! });
          } else if (gap!.end > gap!.start) {
            lane.pieces.push({ kind: 'deletion', ...shown, bp: gap!.end - gap!.start });
          }
        } else {
          if (source) lane.unplaced.push({ bp: runBp, source });
          if (previous && next) lane.transitions += 1;
        }
        run = [];
      };
      for (const o of path.occurrences) {
        const found = matches.get(o.id);
        if (found && found.length === 1 && perTarget.get(`${path.binding}\u0000${found[0].target}`) === 1) {
          const t = targetOcc.get(found[0].target)!;
          // The anchor is the whole placed visit, inside the view or not; only its visible part is drawn.
          const anchor: PreviewPiece = { kind: 'node', ...placeOnTarget(o, t, found[0].reverse), bp: o.clip.end - o.clip.start,
            reverse: found[0].reverse, node: o.node, occurrence: o.id };
          if (previous) flushRun(anchor, o);
          else if (run.length) flushRun(null, null);
          const drawn = clipTo(anchor, window);
          if (drawn) lane.pieces.push({ ...anchor, ...drawn, bp: drawn.end - drawn.start });
          previous = anchor;
          previousOcc = o;
          continue;
        }
        run.push(o);
      }
      if (run.length) flushRun(null, null);
      lane.uncoveredBp = coverageGaps(path.coverage, null).bp;
    }
    lanes.push(lane);
  }
  const summaries = [...(topology.summaries ?? []).map(s => summaryText(s as Record<string, unknown>))];
  for (const path of topology.paths) {
    for (const s of path.plan?.summaries ?? []) summaries.push(summaryText({ binding: path.binding, ...(s as Record<string, unknown>) }));
  }
  return {
    interval: window, lanes, complete: topology.complete, correspondenceComplete: topology.correspondence_complete,
    summaries, nodes: topology.nodes.length, edges: topology.edges.length, visits,
  };
}

/** The target stretch between two placed pieces, in either traversal direction; null when they overlap (a repeat). */
export function gapBetween(a: PreviewPiece, b: PreviewPiece): Span | null {
  if (b.start >= a.end) return { start: a.end, end: b.start };
  if (b.end <= a.start) return { start: b.end, end: a.start };
  return null;
}
