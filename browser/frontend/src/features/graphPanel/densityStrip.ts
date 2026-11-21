/**
 * Density strips (DESIGN_GRAPH_PRIMARY §6.2 L2, §6.3; graph primary G7). A sub-band that draws fewer rows than it has
 * molecules (sampled by the server, or past its rows) gets a strip above its rows: coverage, then the accessible (MSP)
 * and nucleosome fractions per bin, over every row the server decoded for that band before its molecule cap and mark
 * budget (services/graph_panel/reads.py `density_strip`). The denominator is the rows measured at the bin.
 *
 * Bins are in source coordinates of the band's path and are placed along the walk like a read body (a pseudo-read
 * over the strip's windows), so a strip follows the same geometry as the rows under it.
 */
import type { Scene } from './scene';
import { placeRead, type PlacementIndex } from './readGeometry';
import type { GraphRead, GraphReadsResponse } from './types';
import type { HostLane } from './memberBands';
import type { ChromatinStyle } from './chromatinStyle';
import { GRAPH_GUTTER } from './canvas';

export interface GraphStrip { dataset_id: string; binding: string; bp: number; windows: [number, number, number[], number[], number[]][] }
export interface GraphBandReport { dataset_id: string; binding: string; estimated: number | null; quota: number; level: number;
  fraction: number; decoded: number; capped: number; molecules: number }

/** A strip's bins on screen: x extent, rows measured, accessible and nucleosome counts. */
export interface PlacedBin { x0: number; x1: number; cov: number; acc: number; nuc: number }

export const stripKey = (datasetId: string, binding: string) => `${datasetId}\u0000${binding}`;

/** Place a strip's bins along its path's walk (as a read body over its windows). */
export function placeStrip(strip: GraphStrip, index: PlacementIndex): PlacedBin[] {
  if (!strip.windows.length) return [];
  const s = Math.min(...strip.windows.map(w => w[0])), e = Math.max(...strip.windows.map(w => w[1]));
  const pseudo: GraphRead = { k: `strip|${strip.dataset_id}|${strip.binding}`, d: strip.dataset_id, lib: 0, q: '', rec: '', b: strip.binding,
    c: '', st: '+', sup: false, s, e, cov: strip.windows.map(w => [w[0], w[1], 0, 1] as [number, number, number, number]), ins: [] };
  const body = placeRead(pseudo, index, strip.binding, { calls: false, visits: false }).body;
  const out: PlacedBin[] = [];
  for (const [wa, wb, cov, acc, nuc] of strip.windows) {
    for (let i = 0; i < cov.length; i++) {
      if (!cov[i]) continue;
      const a = wa + i * strip.bp, b = Math.min(wb, a + strip.bp);
      for (const p of body) {
        const s0 = Math.max(a, p.s0), s1 = Math.min(b, p.s1);
        if (s1 <= s0) continue;
        const f = (x: number) => (p.x1 - p.x0) * ((x - p.s0) / Math.max(1e-9, p.s1 - p.s0));
        const xa = p.dir === 1 ? p.x0 + f(s0) : p.x1 - f(s0), xb = p.dir === 1 ? p.x0 + f(s1) : p.x1 - f(s1);
        out.push({ x0: Math.min(xa, xb), x1: Math.max(xa, xb), cov: cov[i], acc: acc[i], nuc: nuc[i] });
      }
    }
  }
  return out;
}

/** Each strip's bins, by (dataset, path). */
export function placeStrips(response: GraphReadsResponse | null, index: PlacementIndex | null): Map<string, PlacedBin[]> {
  const out = new Map<string, PlacedBin[]>();
  if (!response?.strips || !index) return out;
  for (const s of response.strips) if (index.occurrences.has(s.binding)) out.set(stripKey(s.dataset_id, s.binding), placeStrip(s, index));
  return out;
}

/** Whether a sub-band draws fewer rows than its molecules: the server sampled or capped it, or rows were left over. */
export function bandSampled(band: GraphBandReport | undefined): boolean {
  return Boolean(band && (band.level > 0 || band.capped > 0));
}

/** The band's disclosure (§6.3): "PAT · 140 of 1,240 molecules · sampled 1/8 · 38 rows". */
export function bandDisclosure(label: string, shown: number, band: GraphBandReport | undefined, rows: number, hidden: number): string {
  const total = band?.estimated ?? null;
  const parts = [label, total != null && total > shown ? `${shown.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} molecules`
    : `${shown.toLocaleString('en-US')} molecule${shown === 1 ? '' : 's'}`];
  if (band && band.level > 0) parts.push(`sampled 1/${1 << band.level} by name`);
  if (band?.capped) parts.push(`${band.capped.toLocaleString('en-US')} over the band's share`);
  parts.push(`${rows} row${rows === 1 ? '' : 's'}${hidden ? ` (+${hidden.toLocaleString('en-US')} not drawn)` : ''}`);
  return parts.join(' · ');
}

/** Draw the strips of a host's sub-bands into their reserved rows, with each band's disclosure. */
export function drawDensityStrips(ctx: CanvasRenderingContext2D, scene: Scene, lanes: Map<string, HostLane>, strips: Map<string, PlacedBin[]>,
  memberDataset: (memberId: string) => string | undefined, bands: Map<string, GraphBandReport>, style: ChromatinStyle,
  rowHeight: number, gap: number, alpha = 1, labelOffset = 0): number {
  let drawn = 0;
  const msp = style.call('msp', 100, {})?.color ?? '#dc2626';
  const nuc = style.call('nuc', 147, {})?.color ?? '#6b7280';
  for (const row of scene.rows) {
    const lane = lanes.get(row.key);
    if (!lane || !row.bandHeight) continue;
    for (const g of lane.groups) {
      const n = g.stripRows ?? 0;
      if (!n) continue;
      const ds = memberDataset(g.memberId);
      const bins = ds ? strips.get(stripKey(ds, row.key)) ?? [] : [];
      const top = row.bandTop + gap + g.startRow * (rowHeight + gap);
      const h = n * (rowHeight + gap) - gap;
      const third = Math.max(2, Math.floor((h - 9) / 3));
      const y0 = top + 9;
      const maxCov = bins.reduce((m, b) => Math.max(m, b.cov), 0) || 1;
      ctx.save();
      ctx.globalAlpha = alpha;
      for (const b of bins) {
        const w = Math.max(0.75, b.x1 - b.x0);
        // Coverage (grey, by depth), then the accessible and nucleosome fractions of the rows measured there.
        ctx.globalAlpha = alpha * (0.15 + 0.6 * (b.cov / maxCov));
        ctx.fillStyle = '#64748b';
        ctx.fillRect(b.x0, y0, w, third);
        ctx.globalAlpha = alpha * Math.min(1, b.acc / b.cov);
        ctx.fillStyle = msp;
        ctx.fillRect(b.x0, y0 + third, w, third);
        ctx.globalAlpha = alpha * Math.min(1, b.nuc / b.cov);
        ctx.fillStyle = nuc;
        ctx.fillRect(b.x0, y0 + 2 * third, w, third);
        drawn++;
      }
      ctx.globalAlpha = alpha;
      const band = ds ? bands.get(stripKey(ds, row.key)) : undefined;
      const molecules = new Set(lane.rows.slice(g.startRow + n, g.startRow + g.rowCount).flatMap(r => r.map(m => `${m.read.d}|${m.read.lib}|${m.read.q}`))).size;
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#475569';
      ctx.fillText(bandDisclosure(g.label, molecules, band, g.rowCount - n, g.hidden), GRAPH_GUTTER + 4 - labelOffset, top + 7);
      ctx.restore();
    }
  }
  return drawn;
}
