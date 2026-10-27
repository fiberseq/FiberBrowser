/**
 * Drawing molecules in their lanes' read bands (readGeometry.ts places them): the read body in the read-background
 * colour, a haplotype stripe at its left end (the live-lift convention), nucleosomes and other calls in the
 * colormap's chromatin colours, FIRE/MSP with their accessibility opacity, m6A ticks, CIGAR deletions as a line
 * through the body, read insertions as small carets, and the walk across connector space or undrawn bp as a dashed
 * line (never body). Each band row is a molecule's record; rows show only data, the band a compact count.
 */
import { LIVE_LIFT_COLORS } from '../../components/tracks/read-track/liveLiftCanvas';
import { getClusterColor, getClusterLabel } from '../../components/tracks/read-track/constants';
import { SV_COLORS } from '../../components/tracks/read-track/svDrawing';

const SV_CLIP_COLOR = SV_COLORS.clip;
import type { HostLane } from './memberBands';
import { GRAPH_GUTTER } from './canvas';
import type { ChromatinStyle } from './chromatinStyle';
import type { CallPiece, PackedLane, PlacedMolecule } from './readGeometry';
import type { Scene } from './scene';

export const READ_ROW_HEIGHT = 7;
export const READ_ROW_GAP = 2;
/** Read insertions drawn as carets from this many bp (1–4 bp HiFi indels would be noise at panel scale). */
export const READ_INSERTION_MIN_BP = 10;

export interface ReadLayers { nuc: boolean; tf: boolean; msp: boolean; m6a: boolean;
  /** Soft clips of at least this length, as the read tracks' SV display draws them (null or absent: off). */
  clipsMinLen?: number | null }

/**
 * The layers a graph read band draws: the toolbar's Layers row (the store's `enabledModTypes`, read the way the
 * read track reads it) and, under it, the panel's own Reads menu. Nucleosomes follow Nuc (as the read track's for
 * reads with a nuc layer, which graph reads always have); MSPs follow Accessibility (FIRE, or its legacy MSP key); TF follows
 * TF; m6A follows m6A (or its legacy `mod` alias). A layer the graph payload does not carry (5mC, deamination, ...)
 * is simply never drawn.
 */
export function effectiveReadLayers(enabled: Record<string, boolean | undefined> | null | undefined,
  panel?: Partial<ReadLayers> | null): ReadLayers {
  const g = enabled ?? {};
  const global: ReadLayers = {
    // Graph reads always carry a nuc layer (legacy inference included): the read track then reads `nuc` alone.
    nuc: g.nuc ?? true,
    msp: Boolean(g.fire || g.msp),
    tf: Boolean(g.tf),
    m6a: Boolean(g.m6a || g.mod),
  };
  return { nuc: global.nuc && panel?.nuc !== false, msp: global.msp && panel?.msp !== false,
    tf: global.tf && panel?.tf !== false, m6a: global.m6a && panel?.m6a !== false };
}

/** What one draw put on the canvas, per layer (e2e and tests read it). */
export interface ReadDrawStats { nuc: number; tf: number; msp: number; m6a: number; m6aDensity: number; outlined?: number; clips?: number }

export function emptyDrawStats(): ReadDrawStats {
  return { nuc: 0, tf: 0, msp: 0, m6a: 0, m6aDensity: 0 };
}

export interface ReadHit { x0: number; x1: number; y0: number; y1: number; molecule: PlacedMolecule;
  /** Host mode: the member panel whose sub-band the row is in. */
  member?: string }

/** Host mode (graph primary G3): what each row is and how it is marked. */
export interface ReadDecoration {
  /** Per lane: the member and cluster of each row (-1 unassigned, null: no clusters). */
  rowMember?: (lane: string, row: number) => string | undefined;
  rowCluster?: (lane: string, row: number) => number | null;
  selected?: (member: string | undefined, m: PlacedMolecule) => boolean;
  highlighted?: (m: PlacedMolecule) => boolean;
}

export const SELECTED_READ_COLOR = '#06b6d4';
export const HIGHLIGHTED_READ_COLOR = '#ca8a04';

/** A molecule's body as merged screen runs (touching pieces joined). */
export function bodyRuns(m: PlacedMolecule): [number, number][] {
  const spans = m.body.map(b => [b.x0, b.x1] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [a, b] of spans) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out;
}

export function bandHeight(lane: PackedLane | undefined, rowHeight = READ_ROW_HEIGHT, gap = READ_ROW_GAP): number {
  if (!lane || !lane.rows.length) return 0;
  return lane.rows.length * (rowHeight + gap) + gap;
}

function drawCall(ctx: CanvasRenderingContext2D, c: CallPiece, y: number, h: number, style: ChromatinStyle, pxPerBp: number, alpha = 1) {
  const s = style.call(c.layer, c.call[2], c.qualities);
  if (!s) return;
  const x = c.x0, w = Math.max(0.75, c.x1 - c.x0);
  ctx.globalAlpha = s.opacity * alpha;
  ctx.fillStyle = s.color;
  ctx.fillRect(x, y, w, h);
  // Edge ambiguity (colormap setting): soft draws a faint band out to the liberal edge, loose a crisp one. Only an
  // edge of the call itself carries it, on the screen side it is on.
  const edgeOn = c.layer === 'nuc' ? style.applyNuc : c.layer === 'tf' ? style.applyTf : false;
  if (edgeOn && style.edgeMode !== 'strict') {
    const left = c.edgeL !== undefined ? style.edgeGapBp(c.edgeL) * pxPerBp : 0;
    const right = c.edgeR !== undefined ? style.edgeGapBp(c.edgeR) * pxPerBp : 0;
    ctx.globalAlpha = s.opacity * alpha * (style.edgeMode === 'soft' ? 0.35 : 1);
    if (left > 0.25) ctx.fillRect(x - left, y, left, h);
    if (right > 0.25) ctx.fillRect(x + w, y, right, h);
  }
  ctx.globalAlpha = alpha;
}

/** Draw every placed molecule; returns their hit rows. `colors`: lane key -> haplotype ink; `alpha`: the whole
 * band's opacity (reads of the previous window kept while the next load is in flight are dimmed). */
export function drawReads(ctx: CanvasRenderingContext2D, scene: Scene, lanes: Map<string, PackedLane>, style: ChromatinStyle,
  layers: ReadLayers, colors: Record<string, string>, rowHeight = READ_ROW_HEIGHT, gap = READ_ROW_GAP, alpha = 1,
  stats?: ReadDrawStats, deco?: ReadDecoration): ReadHit[] {
  const hits: ReadHit[] = [];
  const pxPerBpOf = (m: PlacedMolecule) => {
    const bp = m.body.reduce((t, b) => t + (b.s1 - b.s0), 0);
    const px = m.body.reduce((t, b) => t + (b.x1 - b.x0), 0);
    return bp > 0 ? px / bp : 0;
  };
  for (const row of scene.rows) {
    const lane = lanes.get(row.key);
    if (!lane || !row.bandHeight) continue;
    const ink = colors[row.key] ?? row.color;
    lane.rows.forEach((items, r) => {
      const y = row.bandTop + gap + r * (rowHeight + gap);
      const mid = y + rowHeight / 2;
      for (const m of items) {
        const pxPerBp = pxPerBpOf(m);
        // The walk through connector space and undrawn bp: dashed, never body.
        // Connector space (a bypassed allele, the curve where a branch leaves): a faint solid line; bp the scene
        // summarised (cluster, complex region): the live-lift dashed connector.
        ctx.globalAlpha = alpha;
        ctx.save();
        ctx.lineWidth = 1;
        for (const c of m.connectors) {
          if (c.kind === 'unplaced') { ctx.strokeStyle = LIVE_LIFT_COLORS.connector; ctx.globalAlpha = 0.8 * alpha; ctx.setLineDash([2, 2]); }
          else { ctx.strokeStyle = '#94a3b8'; ctx.globalAlpha = 0.55 * alpha; ctx.setLineDash([]); }
          ctx.beginPath(); ctx.moveTo(c.x0, mid + 0.5); ctx.lineTo(c.x1, mid + 0.5); ctx.stroke();
        }
        ctx.restore();
        ctx.fillStyle = style.body;
        for (const b of m.body) ctx.fillRect(b.x0, y, Math.max(0.5, b.x1 - b.x0), rowHeight);
        // Calls, their edge bands and marks are clipped to the drawn body: never into a hole, connector space or
        // geometry the scene summarised. Nucleosomes first.
        ctx.save();
        ctx.beginPath();
        for (const b of m.body) ctx.rect(b.x0, y - 0.5, Math.max(0.5, b.x1 - b.x0), rowHeight + 1);
        ctx.clip();
        for (const layer of ['nuc', 'tf', 'msp'] as const) {
          if (!layers[layer]) continue;
          for (const c of m.calls) if (c.layer === layer) { drawCall(ctx, c, y, rowHeight, style, pxPerBp, alpha); if (stats) stats[layer]++; }
        }
        if (layers.m6a) {
          ctx.fillStyle = style.m6a;
          const w = Math.max(1, Math.min(2, pxPerBp * 0.8));
          for (const p of m.m6a) ctx.fillRect(p.x - w / 2, y, w, rowHeight);
          if (stats) { stats.m6a += m.m6a.length; stats.m6aDensity += m.density.length; }
          for (const d of m.density) {
            // Density: m6A per bp in the bin, as the tick colour's opacity (marks over budget).
            ctx.globalAlpha = alpha * Math.max(0.06, Math.min(0.85, (d.count / Math.max(1, d.bp)) * 3));
            ctx.fillRect(d.x0, y, Math.max(0.5, d.x1 - d.x0), rowHeight);
          }
          ctx.globalAlpha = alpha;
        }
        ctx.restore();
        // CIGAR holes inside drawn geometry, where at least a pixel: a deletion is a dark line, a skip (N) dashed.
        for (const h of m.holes) {
          if (h.x1 - h.x0 < 1) continue;
          if (h.kind === 'D') { ctx.fillStyle = '#475569'; ctx.fillRect(h.x0, mid - 0.5, h.x1 - h.x0, 1); continue; }
          ctx.save(); ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
          ctx.beginPath(); ctx.moveTo(h.x0, mid + 0.5); ctx.lineTo(h.x1, mid + 0.5); ctx.stroke(); ctx.restore();
        }
        // Soft clips (the read tracks' SV display): a bar at the boundary with a tick toward the clipped side.
        if (layers.clipsMinLen != null && m.clips) {
          ctx.save(); ctx.strokeStyle = SV_CLIP_COLOR; ctx.lineWidth = 1.5; ctx.beginPath();
          for (const c of m.clips) {
            if (c.len < layers.clipsMinLen) continue;
            ctx.moveTo(c.x, y); ctx.lineTo(c.x, y + rowHeight);
            if (rowHeight >= 4) { ctx.moveTo(c.x, mid); ctx.lineTo(c.x + c.dir * 4, mid); }
            if (stats) stats.clips = (stats.clips ?? 0) + 1;
          }
          ctx.stroke(); ctx.restore();
        }
        // Read insertions (no path bp): a caret above the row at the source boundary.
        ctx.fillStyle = LIVE_LIFT_COLORS.badge;
        for (const i of m.ins) {
          if (i.len < READ_INSERTION_MIN_BP) continue;
          ctx.beginPath(); ctx.moveTo(i.x - 2, y - 1.5); ctx.lineTo(i.x + 2, y - 1.5); ctx.lineTo(i.x, y + 1.5); ctx.closePath(); ctx.fill();
        }
        // The haplotype stripe at the molecule's left end (its lane's ink); dashed outline for a supplementary record.
        const left = m.body.reduce((a, b) => (b.x0 < a.x0 ? b : a), m.body[0]);
        ctx.fillStyle = ink;
        ctx.fillRect(left.x0, y, Math.min(3, Math.max(1, left.x1 - left.x0)), rowHeight);
        // Host mode: the cluster stripe beside the haplotype stripe (the read tracks' palette; unassigned grey).
        const cluster = deco?.rowCluster?.(row.key, r) ?? null;
        if (cluster != null) {
          ctx.fillStyle = getClusterColor(cluster);
          ctx.fillRect(left.x0 + 3, y, 3, rowHeight);
        }
        if (m.read.sup) {
          // A supplementary record: its body edged with a dashed line in the lane's ink.
          ctx.save(); ctx.strokeStyle = ink; ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
          for (const [x0, x1] of bodyRuns(m)) if (x1 - x0 >= 3) ctx.strokeRect(x0 + 0.5, y + 0.5, x1 - x0 - 1, rowHeight - 1);
          ctx.restore();
        }
        const member = deco?.rowMember?.(row.key, r);
        const selected = deco?.selected?.(member, m), highlighted = deco?.highlighted?.(m);
        if (selected || highlighted) {
          // Selected (cyan) or highlighted (amber): the read tracks' outlines.
          ctx.save(); ctx.globalAlpha = 1; ctx.strokeStyle = selected ? SELECTED_READ_COLOR : HIGHLIGHTED_READ_COLOR; ctx.lineWidth = 2;
          ctx.strokeRect(m.extent![0] - 1, y - 1, m.extent![1] - m.extent![0] + 2, rowHeight + 2);
          ctx.restore();
          if (stats) stats.outlined = (stats.outlined ?? 0) + 1;
        }
        hits.push({ x0: m.extent![0], x1: m.extent![1], y0: y - gap / 2, y1: y + rowHeight + gap / 2, molecule: m, ...(member ? { member } : {}) });
        ctx.globalAlpha = 1;
      }
    });
  }
  return hits;
}

/** Each read band's compact label in the gutter: how many records it shows (and how many more did not fit). */
export function drawReadBandLabels(ctx: CanvasRenderingContext2D, scene: Scene, lanes: Map<string, PackedLane>, colors: Record<string, string>): void {
  ctx.textAlign = 'left';
  for (const row of scene.rows) {
    const lane = lanes.get(row.key);
    if (!lane || !row.bandHeight) continue;
    const shown = lane.rows.reduce((t, r) => t + r.length, 0);
    const ink = colors[row.key] ?? row.color;
    // The band's colour landmark: its path's ink down the gutter edge, then the path and its count.
    ctx.fillStyle = ink;
    ctx.fillRect(1, row.bandTop + 1, 3, Math.max(2, row.bandHeight - 2));
    ctx.font = 'bold 10px sans-serif';
    ctx.fillText(row.label, 8, row.bandTop + 11);
    ctx.font = '9px sans-serif';
    ctx.fillStyle = '#64748b';
    ctx.fillText(`${shown} read${shown === 1 ? '' : 's'}`, 8, row.bandTop + 22);
    if (lane.hidden) ctx.fillText(`+${lane.hidden} more`, 8, row.bandTop + 32);
  }
}

/** A member group's molecules per cluster, in cluster order (null: not clustered). */
export function clusterCounts(lane: HostLane, startRow: number, rowCount: number): string | null {
  const counts = new Map<number, number>();
  for (let i = startRow; i < startRow + rowCount; i++) {
    const c = lane.rowCluster[i];
    if (c == null) return null;
    counts.set(c, (counts.get(c) ?? 0) + lane.rows[i].length);
  }
  if (!counts.size) return null;
  return [...counts].map(([c, n]) => `${c === -1 ? '–' : getClusterLabel(c, true)} ${n}`).join(' · ');
}

/** Text for the gutter in lines of at most `width` (measured by `measure`), at most `maxLines` of them: whole " · "
 * items per line where they fit, an item wider than a line wrapped at its spaces; past `maxLines` the last line ends
 * in "…". (The gutter is 52 px: "Not a carrier 51" or "C0 29 · C1 3" on one line were cut off.) */
export function gutterLines(text: string, width: number, measure: (s: string) => number, maxLines: number): string[] {
  if (maxLines < 1) return [];
  const pieces: string[] = [];
  for (const item of text.split(' · ')) {
    if (measure(item) <= width) { pieces.push(item); continue; }
    // Wider than a line: its words, packed (a single word wider than a line stays whole).
    let line = '';
    for (const word of item.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (line && measure(next) > width) { pieces.push(line); line = word; } else line = next;
    }
    if (line) pieces.push(line);
  }
  const lines: string[] = [];
  for (const piece of pieces) {
    const last = lines.length ? lines[lines.length - 1] : null;
    const joined = last !== null ? `${last} · ${piece}` : piece;
    if (last !== null && measure(joined) <= width) lines[lines.length - 1] = joined; else lines.push(piece);
  }
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${kept[maxLines - 1]}…`;
  return kept;
}

/** Host mode: each member sub-band's label in the gutter — its dataset colour down the rows it holds, the member's
 * name and how many records it shows (and how many more did not fit). */
export function drawHostBandLabels(ctx: CanvasRenderingContext2D, scene: Scene, lanes: Map<string, HostLane>,
  rowHeight = READ_ROW_HEIGHT, gap = READ_ROW_GAP): void {
  ctx.textAlign = 'left';
  for (const row of scene.rows) {
    const lane = lanes.get(row.key);
    if (!lane || !row.bandHeight) continue;
    for (const g of lane.groups) {
      if (!g.rowCount) continue;
      const top = row.bandTop + gap + g.startRow * (rowHeight + gap);
      const h = g.rowCount * (rowHeight + gap) - gap;
      ctx.fillStyle = g.color;
      ctx.fillRect(1, top, 3, Math.max(2, h));
      const shown = lane.rows.slice(g.startRow, g.startRow + g.rowCount).reduce((t, r) => t + r.length, 0);
      ctx.font = 'bold 10px sans-serif';
      ctx.fillText(g.label, 8, top + 9);
      if (h >= 20) {
        ctx.font = '9px sans-serif';
        ctx.fillStyle = '#64748b';
        const measure = (t: string) => ctx.measureText(t).width;
        // "44 reads +9" is wider than the gutter too: wrapped like the counts ("44 reads", "+9").
        const reads = gutterLines(`${shown} read${shown === 1 ? '' : 's'}${g.hidden ? ` +${g.hidden}` : ''}`, GRAPH_GUTTER - 10,
          measure, Math.floor((h - 10) / 10));
        reads.forEach((line, i) => ctx.fillText(line, 8, top + 19 + i * 10));
        const below = 10 + reads.length * 10;
        // Per-cluster counts (the compare step, DESIGN_GRAPH_PRIMARY §3.3): "C0 24 · C1 3" (the strip's rows aside).
        const strip = g.stripRows ?? 0;
        const counts = clusterCounts(lane, g.startRow + strip, g.rowCount - strip);
        if (counts && h >= below + 10) {
          // Wrapped to the gutter, as many lines as the band has room for.
          const lines = gutterLines(counts, GRAPH_GUTTER - 10, measure, Math.floor((h - below) / 10));
          lines.forEach((line, i) => ctx.fillText(line, 8, top + below + 9 + i * 10));
        }
      }
    }
  }
}

const where = (n: number) => n.toLocaleString('en-US');

/** Hover text of a molecule row at x: the record, then the call or mark under the pointer (whole size, identity). */
export function describeReadHit(hit: ReadHit, x: number, datasetLabel: (id: string) => string, laneLabel: (key: string) => string,
  layers?: ReadLayers): string {
  const m = hit.molecule, r = m.read;
  const head = `${r.q} · ${datasetLabel(r.d)}${r.lib ? ` (library ${r.lib + 1})` : ''} · ${laneLabel(r.b)} ${r.c}:${where(r.s)}-${where(r.e)} · alignment orientation ${r.st}${r.sup ? ' · supplementary' : ''}`;
  const near = (a: number, b: number) => x >= a - 0.5 && x <= b + 0.5;
  // Only calls of a drawn layer are named (a hidden layer is not under the pointer).
  const call = (['msp', 'tf', 'nuc'] as const).filter(l => !layers || layers[l]).map(l => m.calls.find(c => c.layer === l && near(c.x0, c.x1))).find(Boolean);
  if (call) {
    const name = call.layer === 'nuc' ? 'nucleosome' : call.layer === 'tf' ? 'TF footprint' : call.inferred ? 'MSP (inferred from nucleosome gaps)' : 'MSP';
    const q = Object.entries(call.qualities).map(([k, v]) => `${k} ${v}`).join(', ');
    const pieces = m.calls.filter(c => c.layer === call.layer && c.index === call.index).length;
    return `${head} — ${name} ${where(call.call[2])} bp at ${where(call.call[0])}-${where(call.call[1])}${call.id ? ` (${call.id})` : ''}${q ? ` · ${q}` : ''}${pieces > 1 ? ` · drawn in ${pieces} pieces` : ''}`;
  }
  const ins = m.ins.find(i => Math.abs(i.x - x) <= 2 && i.len >= READ_INSERTION_MIN_BP);
  if (ins) return `${head} — read insertion of ${where(ins.len)} bp at ${r.c}:${where(ins.pos)} (no path sequence)`;
  const hole = m.holes.find(h => near(h.x0, h.x1));
  if (hole) return `${head} — ${hole.kind === 'D' ? 'deletion' : 'skipped (N)'} of ${where(hole.s1 - hole.s0)} bp in the read`;
  if (m.marksHidden) return `${head} — calls and m6A not drawn (the panel's mark budget; fewer rows or a smaller window shows them)`;
  const c = m.connectors.find(k => near(k.x0, k.x1));
  if (c) return `${head} — ${c.kind === 'unplaced' ? 'walks sequence not drawn here (summarised or clustered)' : 'walks on (connector space, no sequence)'}`;
  return head;
}
