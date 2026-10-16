export type Metric = 'sequence' | 'accessibility' | 'nfr' | 'anchor' | 'shape';
export type Strand = '+' | '-';
export type Verdict = 'supports' | 'disagrees' | 'weak' | 'abstains';
export type Status = 'agreement' | 'single-metric' | 'disagreement' | 'weak';
export type Interval = [number, number];
export interface SyncWindow {
  panelId: string;
  datasetId: string;
  genome: string | null;
  chrom: string;
  start: number;
  end: number;
  label: string;
  anchor?: {
    position: number;
    strand: Strand;
    label: string;
  };
  readIds?: string[];
  readStrand?: 'CT' | 'GA';
}
export interface Provenance {
  metric: string;
  score: number;
  scores: Partial<Record<Metric, number | null>>;
  flags: string[];
}
/**
 * One gap-free stretch of a frame window: frame [u0, u1) ↔ genomic [g0, g1), equal lengths.
 * On '+' frame u0 is genomic g0; on '-' frame u0 is genomic g1 - 1. Genomic coordinates are
 * logical: on a circular contig they may pass `contigLength` (across the origin), but a
 * block never straddles a multiple of it, so each block is one BED interval.
 */
export interface FrameBlock {
  frame: Interval;
  genomic: Interval;
}
export interface FrameWindow extends SyncWindow {
  strand: Strand;
  provenance: Provenance;
  /** Copy letter when one panel contributes several matched sub-windows (W3a, W3b…). */
  copy?: string;
  /** The block map; a rigid window is one block (two when it wraps a circular origin). */
  blocks: FrameBlock[];
  /** Length of a circular contig; start/end and blocks may then pass it. */
  contigLength?: number;
  /** The window's label when the frame was made (W3a), shown on the panels. */
  tag?: string;
}
export interface ComparisonFrame {
  id: string;
  name: string;
  version: number;
  windows: FrameWindow[];
  status: 'draft' | 'accepted';
  templatePanelId: string;
  alignedOn: Metric[];
  length: number;
}
export interface Assessment {
  verdict: Verdict;
  score: number | null;
  /** Sequence: the share of the proposal its shared sequence covers. */
  share?: number;
  best?: number;
  shift?: number;
  why?: string;
}
/** A gap-free aligned stretch of a proposal: template [a, b) ↔ window [c, d) (on '-', a ↔ d - 1). */
export interface Block {
  template: Interval;
  window: Interval;
}
/** An indel between two blocks: `inserted` window bases absent from the template, `deleted` template bases absent from the window. */
export interface Gap {
  template: number;
  window: number;
  inserted: number;
  deleted: number;
}
/** One candidate correspondence of window `panelId` with its partner (the template unless an other-pair proposal). */
export interface Proposal {
  id: string;
  panelId: string;
  partnerId: string;
  rank: number;
  template: Interval;
  window: Interval;
  strand: Strand;
  sources: Metric[];
  metrics: Partial<Record<Metric, Assessment>>;
  status: Status;
  confidence: number;
  supports: number;
  assessed: number;
  disagree?: number;
  flags?: string[];
  identity?: number;
  aligned?: number;
  alternatives?: number;
  /** A chain of collinear aligned blocks (sequence proposals); absent = one rigid block. */
  blocks?: Block[];
  gaps?: Gap[];
  indels?: { inserted: number; deleted: number; count: number };
  /** Profile-only and anchor proposals: one offset, not following indels. */
  rigid?: boolean;
  /** Which sides reach across a circular window's origin. */
  crosses?: ('template' | 'window')[];
  /** Local chromatin shape: mean channel r, z against scrambled template profiles, the NFR pair it is centred on. */
  r?: number;
  z?: number;
  nfr?: [number, number] | null;
  landmark?: boolean;
  channels?: string[];
}
export interface SyncNote {
  panelId: string | null;
  kind: 'no-sequence' | 'nothing' | 'no-minimap2' | string;
  text: string;
}
/** Where a window's sequence aligns in the template's whole reference. */
export interface Locus {
  chrom: string;
  start: number;
  end: number;
  strand: Strand;
  aligned: number;
  identity: number;
  query: Interval;
  inTemplate: boolean;
}
export interface SyncResult {
  metrics: Metric[];
  windows: SyncWindow[];
  proposals: Proposal[];
  coverage: Record<string, Interval[][]>;
  /** Plain-language notes: a window without sequence, a window with nothing comparable (and why), a missing tool. */
  notes: (string | SyncNote)[];
  timings?: Record<string, number>;
  reads?: Record<string, number>;
  circular?: Record<string, number>;
}
/** The chosen correspondence: the initiating proposal first; a window may contribute several copies. */
export interface Selection {
  /** The window providing the first copy, for an internal-repeat selection. */
  templateId?: string;
  matches: Proposal[];
  start: number;
  end: number;
  /** Windows left out of the frame because they lack this stretch (partial frames). */
  excluded?: string[];
  /** Of those, windows a multi-way block reaches only through another window (no direct match with the template). */
  transitive?: string[];
}
export const statusLabels: Record<Status, string> = { agreement: 'Metrics agree', 'single-metric': 'One metric', disagreement: 'Metrics disagree', weak: 'Weak' };
const statusRank: Record<Status, number> = { agreement: 0, 'single-metric': 1, disagreement: 2, weak: 3 };
/** A frame window's identity within its frame: the panel, plus the copy letter. */
export const windowKey = (w: { panelId: string; copy?: string }) => w.copy ? `${w.panelId}#${w.copy}` : w.panelId;
/** Template-pair proposals (the ones a frame can use), best first per window. */
export function templateProposals(result: SyncResult): Proposal[] {
  const template = result.windows[0]?.panelId;
  return result.proposals.filter(p => p.partnerId === template && result.windows.some(w => w.panelId === p.panelId));
}
/** Proposals between two non-template windows (shown for context; not frame candidates). */
export function otherPairProposals(result: SyncResult): Proposal[] {
  const ids = new Set(result.windows.slice(1).map(w => w.panelId));
  return result.proposals.filter(p => ids.has(p.partnerId) && ids.has(p.panelId));
}
export function byQuality(a: Proposal, b: Proposal) {
  return statusRank[a.status] - statusRank[b.status] || b.confidence - a.confidence || (b.template[1] - b.template[0]) - (a.template[1] - a.template[0]);
}
/** The proposals to draw and list: top `limit` per window pair unless all are requested. */
export function visibleProposals(proposals: Proposal[], limit: number | null, keep: string[] = []): Proposal[] {
  const groups = new Map<string, Proposal[]>();
  for (const p of proposals) {
    const key = `${p.partnerId}~${p.panelId}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return [...groups.values()].flatMap(list => [...list].sort(byQuality).filter((p, i) => p.panelId === p.partnerId || limit == null || i < limit || keep.includes(p.id)));
}
/** Whether a proposal reaches across a circular window's origin (either side). */
export function crossesOrigin(p: Proposal) {
  return !!p.flags?.includes('crosses-origin');
}
/** A one-turn logical window on a circular contig centred on `interval`, so a match there sits inside it. */
export function rotatedWindow(w: { start: number; end: number }, interval: Interval, size: number): { start: number; end: number } {
  const width = Math.min(size, w.end - w.start);
  const centre = Math.round((interval[0] + interval[1]) / 2);
  const start = (((centre - Math.floor(width / 2)) % size) + size) % size;
  return { start, end: start + width };
}
/** A proposal's blocks; a rigid proposal is one block. */
export function proposalBlocks(p: Pick<Proposal, 'template' | 'window' | 'blocks'>): Block[] {
  return p.blocks?.length ? p.blocks : [{ template: p.template, window: p.window }];
}
/** The block clipped to [lo, hi) on the template (side 'template') or window side, keeping the correspondence. */
export function clipBlock(b: Block, strand: Strand, lo: number, hi: number, side: 'template' | 'window'): Block | null {
  const [t0, t1] = b.template, [w0, w1] = b.window;
  if (side === 'template') {
    const a = Math.max(t0, lo), z = Math.min(t1, hi);
    if (z <= a)
      return null;
    return { template: [a, z], window: strand === '+' ? [w0 + a - t0, w0 + z - t0] : [w1 - (z - t0), w1 - (a - t0)] };
  }
  const a = Math.max(w0, lo), z = Math.min(w1, hi);
  if (z <= a)
    return null;
  return { template: strand === '+' ? [t0 + a - w0, t0 + z - w0] : [t0 + (w1 - z), t1 - (a - w0)], window: [a, z] };
}
/** Blocks for drawing: neighbours joined when both of their gaps are at most `joinBp`. */
export function drawnBlocks(p: Pick<Proposal, 'template' | 'window' | 'blocks' | 'strand'>, joinBp: number): Block[] {
  const out: Block[] = [];
  for (const b of proposalBlocks(p)) {
    const last = out[out.length - 1];
    if (last) {
      const gt = b.template[0] - last.template[1];
      const gw = p.strand === '+' ? b.window[0] - last.window[1] : last.window[0] - b.window[1];
      if (gt <= joinBp && gw <= joinBp && gt >= 0 && gw >= 0) {
        out[out.length - 1] = { template: [last.template[0], b.template[1]], window: p.strand === '+' ? [last.window[0], b.window[1]] : [b.window[0], last.window[1]] };
        continue;
      }
    }
    out.push(b);
  }
  return out;
}
/**
 * A block as drawn against one turn of each bar: on a circular window (`size`), the parts
 * past its end (or before its start) move by one turn, so a match across an origin shows
 * on both sides of that bar.
 */
export function splitForBars(b: Block, strand: Strand, top: { start: number; end: number }, topSize: number | undefined, bottom: { start: number; end: number }, bottomSize: number | undefined): Block[] {
  const side = (blocks: Block[], key: 'template' | 'window', w: { start: number; end: number }, size?: number) => size ? blocks.flatMap(block => {
    const parts: Block[] = [];
    for (const [lo, hi, shift] of [[-Infinity, w.start, size], [w.start, w.end, 0], [w.end, Infinity, -size]] as const) {
      const c = clipBlock(block, strand, lo, hi, key);
      if (c)
        parts.push(shift ? { ...c, [key]: [c[key][0] + shift, c[key][1] + shift] as Interval } : c);
    }
    return parts;
  }) : blocks;
  return side(side([b], 'template', top, topSize), 'window', bottom, bottomSize);
}
/** Whether a proposal rests on chromatin alone (no shared sequence, no anchor). */
export function chromatinOnly(p: Proposal) {
  return !!p.flags?.includes('chromatin-only');
}
/** Select a common stretch; never invent a correspondence for an unmatched window.
 * `copies` lists, per panel, the proposal ids to use together (several copies of one region).
 * With `partial`, windows without the stretch are left out (listed in `excluded`) instead of
 * failing or shrinking the others. */
export function selectProposal(result: SyncResult, chosen: Proposal, copies: Record<string, string[]> = {}, partial = false, only?: string[]): Selection | null {
  if (chosen.partnerId === chosen.panelId)
    return selectRepeats(result, chosen, copies);
  if (chosen.partnerId !== result.windows[0]?.panelId)
    return null;
  const size = result.circular?.[result.windows[0].panelId];
  // On a circular template every proposal is kept on each turn that meets the chosen one, so the
  // all-window intersection decides which turn is used. `only` restricts it to a block's proposals.
  const pool = templateProposals(result).filter(p => !only || only.includes(p.id) || p.id === chosen.id)
    .filter(p => p.status !== 'weak' || p.id === chosen.id || Object.values(copies).some(ids => ids.includes(p.id)))
    .flatMap(p => size ? [-1, 0, 1].map(k => shiftTurn(p, k * size)).filter(q => Math.min(q.template[1], chosen.template[1]) > Math.max(q.template[0], chosen.template[0])) : [p]);
  const others = result.windows.slice(1).filter(w => w.panelId !== chosen.panelId);
  // Sweep boundaries: every proposal's ends and its aligned blocks' ends, so a gapped chain's
  // aligned stretches are each a candidate.
  const points = [...new Set([chosen.template[0], chosen.template[1], ...pool
    .flatMap(p => [p.template, ...proposalBlocks(p).map(b => b.template)].flat()).filter(x => x > chosen.template[0] && x < chosen.template[1])])].sort((a, b) => a - b);
  let best: Selection | null = null;
  let bestWeight = -1;
  // Sweep shared extents so an early alternative cannot hide a valid all-window block.
  for (let i = 0; i < points.length - 1; i++) {
    // Covering means aligned bases over most of the stretch, not just a chain's envelope across a gap.
    const covers = (p: Proposal) => p.template[0] <= points[i] && p.template[1] >= points[i + 1] && alignedWithin(p, points[i], points[i + 1]) >= 0.5 * (points[i + 1] - points[i]);
    if (!covers(chosen))
      continue;
    const matches = [chosen];
    const excluded: string[] = [];
    let complete = true;
    for (const w of [{ panelId: chosen.panelId }, ...others]) {
      const own = w.panelId === chosen.panelId;
      const wanted = (copies[w.panelId] ?? []).filter(id => !own || id !== chosen.id);
      const candidates = pool.filter(p => p.panelId === w.panelId && p.id !== chosen.id);
      if (wanted.length) {
        const picked = wanted.map(id => candidates.find(p => p.id === id && covers(p))).filter((p): p is Proposal => !!p);
        if (picked.length < wanted.length) {
          complete = false;
          break;
        }
        matches.push(...picked);
      }
      else if (!own) {
        const p = candidates.filter(covers).sort(byQuality)[0];
        if (!p) {
          if (partial) {
            excluded.push(w.panelId);
            continue;
          }
          complete = false;
          break;
        }
        matches.push(p);
      }
    }
    if (!complete)
      continue;
    const start = Math.max(...matches.map(p => p.template[0]));
    const end = Math.min(...matches.map(p => p.template[1]));
    // More windows first (partial frames), then the stretch every match aligns best over (its
    // least-aligned match's aligned bases), weighted by support.
    const minAligned = Math.min(...matches.map(p => alignedWithin(p, start, end)));
    const weight = matches.length * 1e12 + minAligned * matches.reduce((sum, p) => sum + p.confidence, 0);
    if (weight > bestWeight) {
      best = { matches, start, end, ...(excluded.length ? { excluded } : {}) };
      bestWeight = weight;
    }
  }
  return best;
}
/** A proposal moved by whole turns of a circular template so its template stretch overlaps `ref`'s most. */
export function onTurnOf(p: Proposal, ref: Pick<Proposal, 'template'>, size: number): Proposal {
  let best = 0, bestOverlap = -Infinity;
  for (const k of [-1, 0, 1]) {
    const overlap = Math.min(p.template[1] + k * size, ref.template[1]) - Math.max(p.template[0] + k * size, ref.template[0]);
    if (overlap > bestOverlap) {
      best = k;
      bestOverlap = overlap;
    }
  }
  return shiftTurn(p, best * size);
}
/** A proposal with its template side moved by `d` (whole turns of a circular template). */
function shiftTurn(p: Proposal, d: number): Proposal {
  if (!d)
    return p;
  return { ...p, template: [p.template[0] + d, p.template[1] + d], blocks: p.blocks?.map(b => ({ ...b, template: [b.template[0] + d, b.template[1] + d] as Interval })),
    gaps: p.gaps?.map(g => ({ ...g, template: g.template + d })) };
}
/** Template bases of [lo, hi) that a proposal's blocks align. */
export function alignedWithin(p: Pick<Proposal, 'template' | 'window' | 'blocks'>, lo: number, hi: number): number {
  return proposalBlocks(p).reduce((sum, b) => sum + Math.max(0, Math.min(b.template[1], hi) - Math.max(b.template[0], lo)), 0);
}
/** Proposals of a window that cover at least half of the selected template stretch (e.g. repeated copies). */
export function alternativesFor(result: SyncResult, selection: Selection, panelId: string): Proposal[] {
  const need = (selection.end - selection.start) / 2;
  const size = result.circular?.[result.windows[0]?.panelId];
  // Copies are of one kind: chromatin-only matches are offered beside sequence matches only when the current one is one.
  const current = selection.matches.find(m => m.panelId === panelId);
  const sameKind = (p: Proposal) => selection.matches.some(m => m.id === p.id) || (!p.flags?.includes('contradicted-by-sequence') && chromatinOnly(p) === (!!current && chromatinOnly(current)));
  const pool = selection.templateId ? selectRepeats(result, selection.matches[0], {})?.matches ?? [] : templateProposals(result);
  return pool.map(p => size ? onTurnOf(p, { template: [selection.start, selection.end] }, size) : p).filter(p => p.panelId === panelId && sameKind(p) && (p.status !== 'weak' || selection.matches.some(m => m.id === p.id))
    && Math.min(p.template[1], selection.end) - Math.max(p.template[0], selection.start) >= need)
    .sort((a, b) => a.window[0] - b.window[0]);
}
/** Crop all matches to the same template interval (BED half-open coordinates). */
export function refine(selection: Selection, start: number, end: number): Selection {
  const lo = Math.max(...selection.matches.map(p => p.template[0]));
  const hi = Math.min(...selection.matches.map(p => p.template[1]));
  start = Math.max(lo, Math.min(hi - 1, Math.round(Number.isFinite(start) ? start : lo)));
  end = Math.min(hi, Math.max(start + 1, Math.round(Number.isFinite(end) ? end : hi)));
  return { ...selection, start, end };
}
/** Split blocks at every multiple of a circular contig's length, so each block is one reference interval. */
export function splitAtOrigin(blocks: FrameBlock[], strand: Strand, size?: number): FrameBlock[] {
  if (!size)
    return blocks;
  return blocks.flatMap(b => {
    const [u0, u1] = b.frame, [g0, g1] = b.genomic;
    const cuts = [g0];
    for (let x = (Math.floor(g0 / size) + 1) * size; x < g1; x += size)
      cuts.push(x);
    cuts.push(g1);
    return cuts.slice(0, -1).map((x0, i) => {
      const x1 = cuts[i + 1];
      return { genomic: [x0, x1] as Interval, frame: (strand === '+' ? [u0 + x0 - g0, u0 + x1 - g0] : [u1 - (x1 - g0), u1 - (x0 - g0)]) as Interval };
    });
  });
}
/** The same genomic bases read the other way along the frame. */
export function mirrorBlocks(blocks: FrameBlock[], length: number): FrameBlock[] {
  return blocks.map(b => ({ ...b, frame: [length - b.frame[1], length - b.frame[0]] as Interval })).sort((a, b) => a.frame[0] - b.frame[0]);
}
function provenance(p?: Proposal): Provenance {
  if (!p)
    return { metric: 'template', score: 1, scores: {}, flags: [] };
  return {
    metric: p.sources.join(' + '), score: p.confidence, flags: [p.status, ...(p.flags ?? []), ...(p.rigid ? ['rigid'] : [])],
    scores: Object.fromEntries(Object.entries(p.metrics).map(([m, a]) => [m, a?.verdict === 'abstains' ? null : a?.score ?? null]))
  };
}
/** Frame-relative block map of a proposal cropped to template [start, end). */
function proposalFrameBlocks(p: Proposal, start: number, end: number): FrameBlock[] {
  return proposalBlocks(p).map(b => clipBlock(b, p.strand, start, end, 'template')).filter((b): b is Block => !!b)
    .map(b => ({ frame: [b.template[0] - start, b.template[1] - start] as Interval, genomic: b.window }));
}
function frameWindow(w: SyncWindow, blocks: FrameBlock[], strand: Strand, extra: Partial<FrameWindow>): FrameWindow {
  return {
    ...w, ...extra, strand, blocks: blocks.sort((a, b) => a.frame[0] - b.frame[0]),
    start: Math.min(...blocks.map(b => b.genomic[0])), end: Math.max(...blocks.map(b => b.genomic[1])),
  } as FrameWindow;
}
/**
 * Materialize the frame: equal length (template [start, end)) for every window; each other
 * window is one entry per chosen copy with its block map (indels show as frame or genomic
 * stretches without a partner). Oriented to the template's TSS when anchors are used;
 * `flips` reverse a window along the frame.
 */
export function frameWindows(result: SyncResult, selection: Selection, flips: Record<string, boolean> = {}): FrameWindow[] {
  const length = selection.end - selection.start;
  const templateId = selection.templateId ?? result.windows[0].panelId;
  const templateStrand = result.metrics.includes('anchor') ? result.windows.find(w => w.panelId === templateId)?.anchor?.strand ?? '+' : '+';
  const orient = (fw: FrameWindow): FrameWindow => {
    const reverse = (templateStrand === '-') !== !!flips[windowKey(fw)];
    return reverse ? { ...fw, strand: fw.strand === '+' ? '-' : '+', blocks: mirrorBlocks(fw.blocks, length) } : fw;
  };
  return result.windows.filter(w => !selection.excluded?.includes(w.panelId)).flatMap(w => {
    const size = result.circular?.[w.panelId];
    const extra = size ? { contigLength: size } : {};
    const matches = selection.matches.filter(p => p.panelId === w.panelId && proposalFrameBlocks(p, selection.start, selection.end).length).sort((a, b) => a.window[0] - b.window[0]);
    const rows = matches.map(p => frameWindow(w, splitAtOrigin(proposalFrameBlocks(p, selection.start, selection.end), p.strand, size), p.strand,
      { ...extra, provenance: provenance(p) }));
    if (w.panelId === templateId)
      rows.unshift(frameWindow(w, splitAtOrigin([{ frame: [0, length], genomic: [selection.start, selection.end] }], '+', size), '+', { ...extra, provenance: provenance() }));
    return rows.sort((a, b) => a.start - b.start).map((row, k) => orient({ ...row, ...(rows.length > 1 ? { copy: String.fromCharCode(97 + k) } : {}) }));
  });
}
/** Bases of [start, end) covered by one read's merged blocks (relative to its window start). */
function coveredBp(blocks: Interval[], start: number, end: number) {
  let total = 0;
  for (const [a, b] of blocks)
    total += Math.max(0, Math.min(b, end) - Math.max(a, start));
  return total;
}
/** A genomic interval as pieces inside the loaded window: on a circular contig it is cut at
 * the loaded window's seams (its start plus whole turns) and each piece moved by whole turns. */
function inLoaded(g: Interval, source: { start: number; end: number } | undefined, size?: number): Interval[] {
  if (!size || !source)
    return [g];
  const pieces: Interval[] = [];
  let x = g[0];
  while (x < g[1]) {
    const turn = Math.floor((x - source.start) / size);
    const seam = source.start + (turn + 1) * size;
    const y = Math.min(g[1], seam);
    pieces.push([x - turn * size, y - turn * size]);
    x = y;
  }
  return pieces;
}
/** Reads covering at least `cover` of each window's mapped bases (the check) and those covering all of them. */
export function comparability(windows: FrameWindow[], result: SyncResult, length: number, minimum: number, cover = 0.8) {
  const counts = windows.map(w => {
    const source = result.windows.find(s => s.panelId === w.panelId);
    const reads = source ? result.coverage[w.panelId] ?? [] : [];
    const blocks = w.blocks.flatMap(b => inLoaded(b.genomic, source, result.circular?.[w.panelId])).map(g => [g[0] - (source?.start ?? 0), g[1] - (source?.start ?? 0)] as Interval);
    const mapped = blocks.reduce((s, [a, b]) => s + b - a, 0);
    const need = Math.ceil(mapped * cover);
    let count = 0, spanning = 0;
    for (const read of reads) {
      const bp = blocks.reduce((s, [a, b]) => s + coveredBp(read, a, b), 0);
      if (bp >= need)
        count++;
      if (bp === mapped)
        spanning++;
    }
    return { key: windowKey(w), panelId: w.panelId, copy: w.copy, count, spanning, mapped };
  });
  return {
    counts,
    equal: windows.length >= 2 && windows.every(w => w.blocks.length > 0 && w.blocks.every(b => b.frame[0] >= 0 && b.frame[1] <= length && b.frame[1] - b.frame[0] === b.genomic[1] - b.genomic[0])),
    reads: counts.every(c => c.count >= minimum), strands: windows.every(w => w.strand === '+' || w.strand === '-'),
    inside: windows.every(w => result.windows.some(s => s.panelId === w.panelId && w.blocks.every(b =>
      inLoaded(b.genomic, s, result.circular?.[w.panelId]).every(g => g[0] >= s.start && g[1] <= s.end))))
  };
}
/**
 * BED6 rows for a frame, one per block, with frame coordinates in extra columns. Circular
 * blocks are given in reference coordinates (a window across an origin is two rows).
 */
export function frameBedRows(frame: ComparisonFrame, label: (w: FrameWindow) => string): string[] {
  const rows = ['#chrom\tstart\tend\tname\tscore\tstrand\tframe_start\tframe_end\tframe\tversion\twindow\treference'];
  for (const w of frame.windows) {
    for (const b of [...w.blocks].sort((x, y) => x.frame[0] - y.frame[0])) {
      const turn = w.contigLength ? Math.floor(b.genomic[0] / w.contigLength) * w.contigLength : 0;
      const name = label(w).replace(/\s+/g, '_');
      rows.push([w.chrom, b.genomic[0] - turn, b.genomic[1] - turn, name, Math.max(0, Math.min(1000, Math.round(w.provenance.score * 1000))), w.strand,
        b.frame[0], b.frame[1], frame.name.replace(/\s+/g, '_'), frame.version, name, w.genome ?? 'main'].join('\t'));
    }
  }
  return rows;
}
/** Ribbon corners keep endpoint correspondence: reverse matches cross between the two bars. */
export function ribbonPoints(top: Interval, bottom: Interval, y1: number, y2: number, strand: Strand) {
  const [a, b] = strand === '+' ? bottom : [bottom[1], bottom[0]];
  return `${top[0]},${y1} ${top[1]},${y1} ${b},${y2} ${a},${y2}`;
}
/** Whether (x, y) lies inside a ribbon (a trapezoid, or an hourglass when reversed). */
export function insideRibbon(top: Interval, bottom: Interval, y1: number, y2: number, strand: Strand, x: number, y: number) {
  if (y < Math.min(y1, y2) || y > Math.max(y1, y2) || y1 === y2)
    return false;
  const f = (y - y1) / (y2 - y1);
  const [a, b] = strand === '+' ? bottom : [bottom[1], bottom[0]];
  const left = top[0] + (a - top[0]) * f, right = top[1] + (b - top[1]) * f;
  return x >= Math.min(left, right) - 1 && x <= Math.max(left, right) + 1;
}
/** Plain-language reasons behind a proposal's confidence, one per metric, then how it maps. */
export function explain(p: Proposal, labels: Record<Metric, string>): string[] {
  const lines = (Object.entries(p.metrics) as [Metric, Assessment][]).map(([m, a]) => {
    const score = a.score == null || (m === 'sequence' && (a.verdict === 'disagrees' || !a.score)) ? '' : m === 'sequence' ? ` (${Math.round(a.score * 100)}% identity)` : m === 'anchor' ? '' : ` (r ${a.score.toFixed(2)})`;
    const verdict = a.verdict === 'supports' ? 'supports' : a.verdict === 'disagrees' ? 'disagrees' : a.verdict === 'weak' ? 'does not support' : 'could not assess';
    return `${labels[m]} ${verdict}${score}${a.why ? `: ${a.why}` : ''}`;
  });
  const n = proposalBlocks(p).length;
  lines.push(p.rigid
    ? 'Rigid: one offset for the whole stretch. Profile-only and anchor proposals cannot follow indels yet.'
    : n > 1
      ? `Follows the alignment block by block (${n} blocks; +${(p.indels?.inserted ?? 0).toLocaleString('en-US')}/−${(p.indels?.deleted ?? 0).toLocaleString('en-US')} bp of indels), so profiles are compared base for base across indels.`
      : 'One gap-free aligned block.');
  return lines;
}

/** A proposal seen from the other side: template and window swap, the same strand. */
export function swapSides(p: Proposal): Proposal {
  const blocks = proposalBlocks(p).map(b => ({ template: b.window, window: b.template })).sort((a, b) => a.template[0] - b.template[0]);
  // Gaps are re-read from the swapped blocks: on '-' the boundary before a gap changes sides.
  const gaps: Gap[] = [];
  for (let i = 1; i < blocks.length; i++) {
    const a = blocks[i - 1], b = blocks[i];
    const gt = b.template[0] - a.template[1];
    const gw = p.strand === '+' ? b.window[0] - a.window[1] : a.window[0] - b.window[1];
    if (Math.max(gt, gw) >= 10)
      gaps.push({ template: a.template[1], window: p.strand === '+' ? a.window[1] : a.window[0], inserted: Math.max(gw, 0), deleted: Math.max(gt, 0) });
  }
  return {
    ...p, partnerId: p.panelId, panelId: p.partnerId, template: p.window, window: p.template, blocks,
    gaps: p.blocks ? gaps : p.gaps, indels: p.indels && { ...p.indels, inserted: p.indels.deleted, deleted: p.indels.inserted },
    crosses: p.crosses?.map(side => side === 'template' ? 'window' : 'template'),
  };
}
/** The window coordinate of template position `t`, or null when `t` is not in an aligned block. */
export function mapStrict(p: Proposal, t: number): number | null {
  const b = proposalBlocks(p).find(b => t >= b.template[0] && t < b.template[1]);
  if (!b)
    return null;
  return p.strand === '+' ? b.window[0] + (t - b.template[0]) : b.window[1] - 1 - (t - b.template[0]);
}
/** Proposals between two windows, oriented from `top` to `bottom` (either was the partner). */
export function pairProposals(proposals: Proposal[], top: string, bottom: string): Proposal[] {
  return proposals.flatMap(p => p.partnerId === top && p.panelId === bottom ? [p] : p.partnerId === bottom && p.panelId === top ? [swapSides(p)] : []);
}
/** Window order for the all-windows map: start at the template and keep adding the window most
 * similar to the last one (summed confidence of their proposals), so similar windows sit together. */
export function orderWindows(result: SyncResult): SyncWindow[] {
  const ids = result.windows.map(w => w.panelId);
  const sim = (a: string, b: string) => pairProposals(result.proposals.filter(p => p.status !== 'weak'), a, b).reduce((s, p) => s + p.confidence, 0);
  const order = [ids[0]];
  const left = new Set(ids.slice(1));
  while (left.size) {
    const last = order[order.length - 1];
    const next = [...left].sort((a, b) => sim(last, b) - sim(last, a) || ids.indexOf(a) - ids.indexOf(b))[0];
    order.push(next);
    left.delete(next);
  }
  return order.map(id => result.windows.find(w => w.panelId === id)!);
}
/** One window's part of a multi-way block: its stretch(es) (several copies possible). */
export interface BlockMember {
  panelId: string;
  intervals: Interval[];
}
/** Stretches in several windows that the pairwise proposals tie together. */
export interface MultiBlock {
  id: string;
  members: BlockMember[];
  proposalIds: string[];
  /** Windows present / windows compared. */
  coverage: number;
  total: number;
  confidence: number;
  chromatinOnly: boolean;
  /** Pairs whose direct mapping disagrees with the one implied through a third window. */
  inconsistent: { a: string; b: string; via: string; offBy: number }[];
}
/** The window coordinate a proposal maps template position `t` to (nearest block's offset outside blocks). */
export function mapThrough(p: Proposal, t: number): number {
  const blocks = proposalBlocks(p);
  const b = blocks.find(b => t >= b.template[0] && t < b.template[1]) ?? blocks.reduce((best, b) =>
    Math.min(Math.abs(t - b.template[0]), Math.abs(t - b.template[1])) < Math.min(Math.abs(t - best.template[0]), Math.abs(t - best.template[1])) ? b : best);
  return p.strand === '+' ? b.window[0] + (t - b.template[0]) : b.window[1] - (t - b.template[0]);
}
/**
 * Multi-way blocks from the pairwise proposals (template pairs and other pairs): each proposal
 * links a stretch of one window to a stretch of another; stretches of one window that overlap
 * by at least half the shorter join; the connected pieces are the blocks. A triangle whose
 * direct mapping differs from the one through the third window by more than `tolerance` bp is
 * flagged. Ranked by coverage (windows present), then confidence.
 */
export function multiwayBlocks(result: SyncResult, tolerance = 100): MultiBlock[] {
  // Weak, disputed and sequence-contradicted proposals do not tie windows together.
  const proposals = result.proposals.filter(p => p.status !== 'weak' && p.status !== 'disagreement' && !p.flags?.includes('contradicted-by-sequence'));
  // A node is one side of a proposal: its window, envelope and aligned stretches.
  const nodes: { panelId: string; interval: Interval; aligned: Interval[] }[] = [];
  const parent: number[] = [];
  const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const join = (a: number, b: number) => { parent[find(a)] = find(b); };
  const node = (panelId: string, interval: Interval, aligned: Interval[]) => { nodes.push({ panelId, interval, aligned }); parent.push(parent.length); return nodes.length - 1; };
  const edges = proposals.map(p => ({ p, a: node(p.partnerId, p.template, proposalBlocks(p).map(b => b.template)), b: node(p.panelId, p.window, proposalBlocks(p).map(b => b.window)) }));
  for (const e of edges)
    join(e.a, e.b);
  const total = (ivs: Interval[]) => ivs.reduce((s, [a, b]) => s + b - a, 0);
  const shared = (x: Interval[], y: Interval[]) => x.reduce((s, [a, b]) => s + y.reduce((t, [c, d]) => t + Math.max(0, Math.min(b, d) - Math.max(a, c)), 0), 0);
  // Two sides in one window are the same stretch when their aligned bases overlap by half the smaller.
  const same = (x: typeof nodes[number], y: typeof nodes[number]) => shared(x.aligned, y.aligned) >= 0.5 * Math.min(total(x.aligned), total(y.aligned));
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++)
      if (nodes[i].panelId === nodes[j].panelId && same(nodes[i], nodes[j]))
        join(i, j);
  const groups = new Map<number, typeof edges>();
  for (const e of edges)
    groups.set(find(e.a), [...(groups.get(find(e.a)) ?? []), e]);
  const blocks: MultiBlock[] = [];
  for (const [root, group] of groups) {
    // Members: per window, its sides grouped by the same rule on their own aligned bases
    // (connected components, so the order never matters); separate groups are copies.
    const members = new Map<string, Interval[]>();
    const sides = new Map<string, number[]>();
    nodes.forEach((n, i) => { if (find(i) === root) sides.set(n.panelId, [...(sides.get(n.panelId) ?? []), i]); });
    for (const [id, list] of sides) {
      const up = list.map((_, k) => k);
      const top = (k: number): number => up[k] === k ? k : (up[k] = top(up[k]));
      for (let x = 0; x < list.length; x++)
        for (let y = x + 1; y < list.length; y++)
          if (same(nodes[list[x]], nodes[list[y]]))
            up[top(x)] = top(y);
      const groups = new Map<number, Interval>();
      list.forEach((i, k) => {
        const g = groups.get(top(k));
        const iv = nodes[i].interval;
        groups.set(top(k), g ? [Math.min(g[0], iv[0]), Math.max(g[1], iv[1])] : [iv[0], iv[1]]);
      });
      members.set(id, [...groups.values()]);
    }
    // Consistency around triangles: a -> b directly vs a -> c -> b, strand and position, at three
    // positions aligned in all three legs; every pairing of copies is tried.
    const inconsistent: MultiBlock['inconsistent'] = [];
    const ps = group.map(e => e.p);
    const pairs = new Map<string, Map<string, Proposal[]>>();
    for (const p of ps) for (const q of [p, swapSides(p)]) {
      if (!pairs.has(q.partnerId)) pairs.set(q.partnerId, new Map());
      const neighbours = pairs.get(q.partnerId)!;
      neighbours.set(q.panelId, [...(neighbours.get(q.panelId) ?? []), q]);
    }
    // Only connected triangles can disagree; sparse copy graphs have very few of them.
    for (const [a, neighbours] of pairs) for (const [b, ab] of neighbours) for (const [c, ac] of neighbours) {
      if (a >= b || c === a || c === b)
        continue;
      const cb = pairs.get(c)?.get(b);
      if (!cb?.length)
        continue;
      let best = Infinity, tested = false;
      for (const d of ab) for (const first of ac) for (const second of cb) {
        // Exactly where all three legs are aligned: a-side intersections of the direct and first
        // legs, mapped through the first leg's block and cut to the second leg's blocks, then back.
        const spots: [number, number][] = [];
        for (const x of proposalBlocks(d)) for (const y of proposalBlocks(first)) {
          const lo = Math.max(x.template[0], y.template[0]), hi = Math.min(x.template[1], y.template[1]);
          if (hi <= lo)
            continue;
          const toC = (t: number) => first.strand === '+' ? y.window[0] + (t - y.template[0]) : y.window[1] - 1 - (t - y.template[0]);
          const fromC = (c: number) => first.strand === '+' ? c - y.window[0] + y.template[0] : y.window[1] - 1 - c + y.template[0];
          const cLo = Math.min(toC(lo), toC(hi - 1)), cHi = Math.max(toC(lo), toC(hi - 1));
          for (const z of proposalBlocks(second)) {
            const a2 = Math.max(cLo, z.template[0]), b2 = Math.min(cHi, z.template[1] - 1);
            if (b2 >= a2)
              spots.push([Math.min(fromC(a2), fromC(b2)), Math.max(fromC(a2), fromC(b2))]);
          }
        }
        // One position in every three-leg intersection: offsets are constant inside each, so its middle catches any
        // contradiction there (only the largest few let one in a short block through: Codex, a720581d).
        const picks = spots.map(([u, v]) => Math.round((u + v) / 2));
        let worst = -1;
        for (const t of picks) {
          const direct = mapStrict(d, t), mid = mapStrict(first, t);
          const through = mid == null ? null : mapStrict(second, mid);
          if (direct == null || through == null)
            continue;
          tested = true;
          worst = Math.max(worst, (d.strand === (first.strand === second.strand ? '+' : '-')) ? Math.abs(direct - through) : Infinity);
        }
        if (worst >= 0)
          best = Math.min(best, worst);
      }
      if (tested && best > tolerance)
        inconsistent.push({ a, b, via: c, offBy: Number.isFinite(best) ? best : -1 });
    }
    blocks.push({
      id: `b${blocks.length}`, members: [...members].map(([panelId, list]) => ({ panelId, intervals: list.sort((x, y) => x[0] - y[0]) })),
      proposalIds: ps.map(p => p.id), coverage: members.size, total: result.windows.length,
      confidence: Math.round(100 * ps.reduce((s, p) => s + p.confidence, 0) / ps.length) / 100,
      chromatinOnly: ps.every(chromatinOnly), inconsistent,
    });
  }
  return blocks.filter(b => b.coverage >= 2).sort((x, y) => y.coverage - x.coverage || y.confidence - x.confidence).map((b, i) => ({ ...b, id: `b${i}` }));
}
/** A selection from a multi-way block: the template's proposals in the block (copies included);
 * windows not in the block are left out of the frame. Null when the template is not in it. */
export function selectBlock(result: SyncResult, block: MultiBlock): Selection | null {
  const template = result.windows[0].panelId;
  if (!block.members.some(m => m.panelId === template))
    return null;
  let inBlock = templateProposals(result).filter(p => p.panelId !== template && block.proposalIds.includes(p.id));
  // Per window, matches of one kind: sequence ones when there are any, else chromatin-only ones.
  inBlock = inBlock.filter(p => !chromatinOnly(p) || !inBlock.some(q => q.panelId === p.panelId && !chromatinOnly(q)));
  if (!inBlock.length)
    return null;
  const chosen = [...inBlock].sort(byQuality)[0];
  const copies: Record<string, string[]> = {};
  for (const p of inBlock)
    copies[p.panelId] = [...(copies[p.panelId] ?? []), p.id];
  // Only the block's own proposals: no other match (one the block left out) sneaks back in.
  const selection = selectProposal(result, chosen, copies, true, inBlock.map(p => p.id));
  if (!selection)
    return null;
  const direct = new Set([template, ...inBlock.map(p => p.panelId)]);
  const transitive = block.members.map(m => m.panelId).filter(id => !direct.has(id));
  const excluded = [...new Set([...(selection.excluded ?? []), ...transitive, ...result.windows.map(w => w.panelId).filter(id => !block.members.some(m => m.panelId === id))])];
  return { ...selection, ...(excluded.length ? { excluded } : {}), ...(transitive.length ? { transitive } : {}) };
}

// Results are immutable; share copy grouping between drawing, selection and alternatives.
const repeatCache = new WeakMap<SyncResult, MultiBlock[]>();
const repeatProposalCache = new WeakMap<SyncResult, Proposal[]>();
/** Put each physical copy on one logical turn, retaining full origin-spanning blocks. */
export function repeatProposals(result: SyncResult): Proposal[] {
  const cached = repeatProposalCache.get(result);
  if (cached) return cached;
  const out: Proposal[] = [];
  for (const w of result.windows) {
    const ps = result.proposals.filter(p => p.panelId === w.panelId && p.partnerId === w.panelId);
    const size = result.circular?.[w.panelId];
    if (!size) { out.push(...ps); continue; }
    const sides = ps.flatMap(p => [p.template, p.window]);
    const turns = new Map<Interval, number>();
    const representatives: Interval[] = [];
    // Longest first: a clipped duplicate must not shorten an origin-spanning copy.
    for (const iv of [...sides].sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))) {
      let shift = -Math.floor(iv[0] / size) * size;
      for (const ref of representatives) {
        const d = Math.round((ref[0] - iv[0]) / size) * size;
        if (Math.min(ref[1], iv[1] + d) - Math.max(ref[0], iv[0] + d) >= .5 * Math.min(ref[1] - ref[0], iv[1] - iv[0])) {
          shift = d;
          break;
        }
      }
      turns.set(iv, shift);
      representatives.push([iv[0] + shift, iv[1] + shift]);
    }
    for (const p of ps) {
      const shifted = shiftTurn(p, turns.get(p.template)!);
      out.push(swapSides(shiftTurn(swapSides(shifted), turns.get(p.window)!)));
    }
  }
  repeatProposalCache.set(result, out);
  return out;
}
/** Internal repeats grouped by connected copies; triangles use the same check as multi-way blocks. */
export function repeatGroups(result: SyncResult): MultiBlock[] {
  const cached = repeatCache.get(result);
  if (cached) return cached;
  const out: MultiBlock[] = [];
  for (const w of result.windows) {
    const ps = repeatProposals(result).filter(p => p.panelId === w.panelId);
    const sides = ps.flatMap(p => [p.template, p.window]);
    const parents = sides.map((_, i) => i);
    const root = (i: number): number => parents[i] === i ? i : (parents[i] = root(parents[i]));
    for (let i = 0; i < sides.length; i++) for (let j = i + 1; j < sides.length; j++) {
      const a = sides[i], b = sides[j];
      if (Math.min(a[1], b[1]) - Math.max(a[0], b[0]) >= .5 * Math.min(a[1] - a[0], b[1] - b[0]))
        parents[root(i)] = root(j);
    }
    const node = (i: number) => `${w.panelId}#${root(i)}`;
    // Copies remain copies when chromatin differs; retain the disagreement on the original proposal.
    const mapped = ps.map((p, i): Proposal => ({ ...p, partnerId: node(2 * i), panelId: node(2 * i + 1),
      status: p.metrics.sequence?.verdict === 'supports' ? 'single-metric' : p.status }));
    const virtual = { ...result, windows: [...new Set(sides.map((_, i) => node(i)))].map(panelId => ({ ...w, panelId })), proposals: mapped };
    for (const block of multiwayBlocks(virtual))
      out.push({ ...block, id: `repeat-${w.panelId}-${block.id}`, members: [{ panelId: w.panelId, intervals: block.members.flatMap(m => m.intervals).sort((a, b) => a[0] - b[0]) }] });
  }
  repeatCache.set(result, out);
  return out;
}
/** Use connected copies of a repeat, keeping their block maps and orientations. */
function selectRepeats(result: SyncResult, chosen: Proposal, copies: Record<string, string[]>): Selection | null {
  const group = repeatGroups(result).find(g => g.proposalIds.includes(chosen.id));
  if (!group || group.inconsistent.length)
    return null;
  const ps = repeatProposals(result).filter(p => group.proposalIds.includes(p.id));
  const intervals = group.members[0].intervals;
  const node = (iv: Interval) => intervals.findIndex(x => Math.min(x[1], iv[1]) - Math.max(x[0], iv[0]) >= .5 * Math.min(x[1] - x[0], iv[1] - iv[0]));
  const paths = new Map<number, Proposal | null>([[0, null]]);
  const queue = [0];
  const edges = [...ps].sort(byQuality).flatMap(p => [p, swapSides(p)]);
  // Compose through a copy only over blocks aligned in both legs; never fill an indel.
  for (const at of queue) {
    for (const p of edges) {
      const next = node(p.window);
      if (node(p.template) !== at || next < 0 || paths.has(next)) continue;
      const first = paths.get(at);
      let mapped = p;
      if (first) {
        const blocks: Block[] = [];
        for (const a of proposalBlocks(first)) for (const b of proposalBlocks(p)) {
          const lo = Math.max(a.window[0], b.template[0]), hi = Math.min(a.window[1], b.template[1]);
          if (hi <= lo) continue;
          const left = clipBlock(a, first.strand, lo, hi, 'window');
          const right = clipBlock(b, p.strand, lo, hi, 'template');
          if (left && right) blocks.push({ template: left.template, window: right.window });
        }
        if (!blocks.length) continue;
        blocks.sort((a, b) => a.template[0] - b.template[0]);
        mapped = { ...p, blocks, strand: first.strand === p.strand ? '+' : '-',
          template: [blocks[0].template[0], blocks[blocks.length - 1].template[1]],
          window: [Math.min(...blocks.map(b => b.window[0])), Math.max(...blocks.map(b => b.window[1]))],
          confidence: Math.min(first.confidence, p.confidence), flags: [...(p.flags ?? []), 'through-copy'] };
      }
      paths.set(next, mapped); queue.push(next);
    }
  }
  const matches = [...paths.values()].filter((p): p is Proposal => !!p)
    .filter(p => !copies[chosen.panelId]?.length || copies[chosen.panelId].includes(p.id));
  if (!matches.length)
    return null;
  const start = Math.max(...matches.map(p => p.template[0])), end = Math.min(...matches.map(p => p.template[1]));
  if (end <= start)
    return null;
  return { templateId: chosen.panelId, start, end, matches,
    excluded: result.windows.filter(w => w.panelId !== chosen.panelId).map(w => w.panelId) };
}
