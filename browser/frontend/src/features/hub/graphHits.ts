/**
 * Hub hits on a graph host (feature hub G1; DESIGN §5.4, DESIGN_GRAPH_PRIMARY §2.3). A hit's graph columns
 * (`[node, o0, o1)`, node-forward offsets, from the server's fixed tiles) are drawn wherever the scene draws a visit of
 * those nodes: on the target walk and on every lane that carries them, so a target-aliased hit spans the lanes that
 * share its sequence, and a MAT/PAT hit inside an insertion is drawn on the inserted sequence of its carriers only.
 * A hit without graph columns but placed on this genome is outlined over its target span across the lanes.
 *
 * Hits come from the hub's hits in view (the scan sets) and from the hub selection; selected ones are drawn bold.
 * A click on an outline selects its hit (shift adds), as a click on its hub row does.
 */
import { useBrowserStore } from '../../stores/browserStore';
import type { GraphTopology } from '../graphPanel/types';
import { xForTarget, type Scene } from '../graphPanel/scene';
import { scanSets, useHubData } from './hubData';
import { displaySpan } from './frames';
import { hitSelectionEntry, type HubSelected } from './hubState';
import type { FeatureHit, GraphAlias } from './types';

export interface HubGraphOutline {
  key: string; setId: string; hitId: string; label: string; selected: boolean;
  x0: number; x1: number; y0: number; y1: number; kind: 'columns' | 'region';
}

interface Drawable { setId: string; hitId: string; typeId: string; label?: string; graph?: GraphAlias; chrom: string; start: number; end: number;
  anchor: number; frame?: FeatureHit['frame']; target?: FeatureHit['target'] }

/** Path-forward offsets `[p0, p1)` of node-forward run `[a, b)` in a visit of a node of length `len`. */
export function pathForward(a: number, b: number, len: number, reverse: boolean): [number, number] {
  return reverse ? [len - b, len - a] : [a, b];
}

/** x of path-forward offset `p` (a base edge) inside a placement drawn over `[x0, x1]`. */
function xAt(o: Scene['occurrences'][number], p: number): number {
  const u = Math.max(0, Math.min(1, (p - o.start) / Math.max(1e-9, o.end - o.start)));
  return o.dir === 1 ? o.x0 + u * (o.x1 - o.x0) : o.x1 - u * (o.x1 - o.x0);
}

/** Lane spans (x ranges per lane) of a hit's columns on a scene. */
export function columnSpans(scene: Scene, topology: GraphTopology, columns: GraphAlias['columns']): Map<string, [number, number]> {
  const runs = new Map<string, Array<[number, number]>>();
  for (const [node, a, b] of columns) runs.set(node, [...(runs.get(node) ?? []), [a, b]]);
  const lengths = new Map(topology.nodes.map(n => [n.id, n.length]));
  const reverse = new Map<string, boolean>();
  for (const p of topology.paths) for (const o of p.occurrences) reverse.set(o.id, o.reverse);
  const out = new Map<string, [number, number]>();
  for (const o of scene.occurrences) {
    const mine = runs.get(o.node);
    const len = lengths.get(o.node);
    if (!mine || len == null) continue;
    const rev = reverse.get(o.occ) ?? false;
    for (const [a, b] of mine) {
      const [p0, p1] = pathForward(a, b, len, rev);
      const lo = Math.max(p0, o.start), hi = Math.min(p1, o.end);
      if (hi <= lo) continue;
      const xa = xAt(o, lo), xb = xAt(o, hi);
      const x0 = Math.min(xa, xb), x1 = Math.max(xa, xb);
      const have = out.get(o.lane);
      out.set(o.lane, have ? [Math.min(have[0], x0), Math.max(have[1], x1)] : [x0, x1]);
    }
  }
  return out;
}

/** The hits to draw: the hub's scan hits in view and the selection (deduplicated). */
export function drawableHits(selected: HubSelected[] = useBrowserStore.getState().featureHub?.selected ?? []): { hit: Drawable; selected: boolean }[] {
  const sel = new Set(selected.map(s => `${s.setId}|${s.hitId}`));
  const out = new Map<string, { hit: Drawable; selected: boolean }>();
  for (const [setId, entry] of Object.entries(useHubData.getState().hits)) {
    for (const h of entry.hits) out.set(`${setId}|${h.hitId}`, { hit: { ...h, setId }, selected: sel.has(`${setId}|${h.hitId}`) });
  }
  for (const s of selected) if (!out.has(`${s.setId}|${s.hitId}`)) out.set(`${s.setId}|${s.hitId}`, { hit: s, selected: true });
  return [...out.values()];
}

/** The outlines of the hub's hits on a host's scene (empty: no scene, or no hit on this package and target). */
export function hubGraphOutlines(scene: Scene | null, topology: GraphTopology | null | undefined, registrationId: string | null,
  target: string | null, reversed = false, hits = drawableHits()): HubGraphOutline[] {
  if (!scene || !topology || !registrationId || !target || !scene.rows.length) return [];
  const out: HubGraphOutline[] = [];
  const rowOf = new Map(scene.rows.map(r => [r.key, r]));
  const top = scene.rows[0].top;
  const bottom = Math.max(...scene.rows.map(r => Math.max(r.top + r.height, r.bandTop + r.bandHeight)));
  for (const { hit, selected } of hits) {
    const key = `${hit.setId}|${hit.hitId}`;
    const label = hit.label || hit.typeId;
    const g = hit.graph;
    if (g && g.registration === registrationId && g.target === target) {
      for (const [lane, [x0, x1]] of columnSpans(scene, topology, g.columns)) {
        const row = rowOf.get(lane);
        if (!row) continue;
        const y1 = row.bandHeight > 0 ? row.bandTop + row.bandHeight : row.top + row.height;
        out.push({ key, setId: hit.setId, hitId: hit.hitId, label, selected, x0, x1: Math.max(x1, x0 + 2), y0: row.top, y1, kind: 'columns' });
      }
      continue;
    }
    // No columns on this package: the hit's target span across the lanes, when it is placed on this genome.
    const t = displaySpan(hit);
    if (!t || t.insertion) continue;
    const a = xForTarget(scene.targetMap, t.start, 'start', reversed);
    const b = xForTarget(scene.targetMap, Math.max(t.end, t.start + 1), 'end', reversed);
    if (a == null || b == null) continue;
    out.push({ key, setId: hit.setId, hitId: hit.hitId, label, selected, x0: Math.min(a, b), x1: Math.max(a, b, Math.min(a, b) + 2), y0: top, y1: bottom, kind: 'region' });
  }
  return out;
}

const COLOUR = { line: 'rgba(79, 70, 229, 0.95)', faint: 'rgba(79, 70, 229, 0.45)', fill: 'rgba(79, 70, 229, 0.10)' };

export function drawHubOutlines(ctx: CanvasRenderingContext2D, outlines: HubGraphOutline[]): void {
  if (!outlines.length) return;
  ctx.save();
  for (const o of outlines) {
    if (o.selected) {
      ctx.fillStyle = COLOUR.fill;
      ctx.fillRect(o.x0, o.y0, Math.max(1, o.x1 - o.x0), o.y1 - o.y0);
    }
    ctx.strokeStyle = o.selected ? COLOUR.line : COLOUR.faint;
    ctx.setLineDash(o.selected ? [] : [3, 2]);
    ctx.lineWidth = o.selected ? 1.5 : 1;
    ctx.strokeRect(o.x0 + 0.5, o.y0 + 0.5, Math.max(1, o.x1 - o.x0 - 1), o.y1 - o.y0 - 1);
  }
  ctx.restore();
}

/** The outline under a point (the narrowest wins: a hit inside a wider one stays clickable). */
export function hubOutlineAt(outlines: HubGraphOutline[], x: number, y: number): HubGraphOutline | null {
  let best: HubGraphOutline | null = null;
  for (const o of outlines) {
    if (x < o.x0 - 1 || x > o.x1 + 1 || y < o.y0 || y > o.y1) continue;
    if (!best || o.x1 - o.x0 < best.x1 - best.x0) best = o;
  }
  return best;
}

/** Hover text of an outline. */
export function hubOutlineText(o: HubGraphOutline): string {
  return `Feature hub: ${o.label}${o.selected ? ' (selected)' : ''}. Click to ${o.selected ? 'deselect' : 'select'} it in the hub.`;
}

/** A click on an outline: select its hit in the hub (shift/⌘ adds or removes). Returns whether it was handled. */
export function selectFromGraph(o: HubGraphOutline, additive: boolean): boolean {
  const hub = useBrowserStore.getState().featureHub;
  const has = hub.selected.some(s => s.setId === o.setId && s.hitId === o.hitId);
  const entry = (() => {
    const fromSel = hub.selected.find(s => s.setId === o.setId && s.hitId === o.hitId);
    if (fromSel) return fromSel;
    const h = useHubData.getState().hits[o.setId]?.hits.find(x => x.hitId === o.hitId);
    return h ? selectionEntryOf(o.setId, h) : null;
  })();
  if (!entry) return false;
  useBrowserStore.getState().setFeatureHub(cur => {
    if (!additive) return { selected: has && cur.selected.length === 1 ? [] : [entry] };
    return { selected: has ? cur.selected.filter(s => !(s.setId === o.setId && s.hitId === o.hitId)) : [...cur.selected, entry] };
  });
  return true;
}

function selectionEntryOf(setId: string, hit: FeatureHit): HubSelected | null {
  const set = scanSets(useHubData.getState().scans).find(s => s.setId === setId);
  return set ? hitSelectionEntry(set, hit) : null;
}
