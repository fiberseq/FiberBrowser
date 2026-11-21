/**
 * Size-band sources and conditioning for the profile types (Metaprofile, and the size histogram's scope):
 * - bands: the source's footprints filtered by length (bands from the edges: < e0, e0–e1, ..., ≥ eN), one band, or
 *   one line per band;
 * - conditioning: each read's state at the anchor (centre ± N bp): covered there by a nucleosome-sized footprint, by
 *   a TF-sized one, or open (neither); the groups split by state.
 * Both act on engine reads before accumulation, so the engine's numbers for a group are those of its reads.
 */
import type { ProfileRead } from './profileEngine';
import { bandLabel, type ProfileSettings } from './plotModel';

export type AnchorState = 'nucleosome' | 'tf' | 'open';
export const ANCHOR_STATES: readonly { value: AnchorState; label: string; dash: number[] }[] = [
  { value: 'open', label: 'open at the anchor', dash: [] },
  { value: 'tf', label: 'TF-sized footprint at the anchor', dash: [6, 3] },
  { value: 'nucleosome', label: 'nucleosome at the anchor', dash: [2, 2.5] },
];

type Group = { id: string; title: string; color?: string; dash?: number[] };
type Read = ProfileRead & { footprints?: Array<[number, number]> };

/** The band of a footprint length (0 .. edges.length). */
export function bandOf(size: number, edges: number[]): number {
  let i = 0;
  while (i < edges.length && size >= edges[i]) i++;
  return i;
}

/** A read's state at centre ± w: the largest footprint covering any of it decides (nucleosome-sized wins). */
export function anchorState(r: Read, centre: number, w: number, nucBp: number): AnchorState {
  const lo = centre - w, hi = centre + w + 1;
  let state: AnchorState = 'open';
  for (const [a, b] of r.footprints ?? r.intervals ?? []) {
    if (a < hi && b > lo) {
      if (b - a >= nucBp) return 'nucleosome';
      state = 'tf';
    }
  }
  return state;
}

/** Reads and groups after the bands and the conditioning (groups in order: group × band × state). */
export function applyBandsAndCondition<T extends Read>(reads: T[], groups: Group[], s: ProfileSettings, centreOf: (r: T) => number | null):
  { reads: T[]; groups: Group[] } {
  const bands = s.band === 'each' ? s.bandEdges.map((_, i) => i).concat([s.bandEdges.length]) : s.band === 'off' ? [null] : [s.band];
  const states: Array<AnchorState | null> = s.conditionOn ? ANCHOR_STATES.map(x => x.value) : [null];
  if (bands.length === 1 && bands[0] === null && !s.conditionOn) return { reads, groups };
  const outGroups: Group[] = [];
  for (const g of groups) for (const b of bands) for (const st of states) {
    const parts = [b != null && s.band === 'each' ? bandLabel(s.bandEdges, b) : null, st ? ANCHOR_STATES.find(x => x.value === st)!.label : null].filter(Boolean);
    outGroups.push({ id: `${g.id}${b != null && s.band === 'each' ? `|b${b}` : ''}${st ? `|s:${st}` : ''}`, title: parts.length ? `${g.title} · ${parts.join(' · ')}` : g.title,
      ...(g.color ? { color: g.color } : {}), ...(st ? { dash: ANCHOR_STATES.find(x => x.value === st)!.dash } : b != null && s.band === 'each' ? { dash: [[], [7, 3], [2, 2.5], [8, 3, 2, 3]][b % 4] } : {}) });
  }
  const out: T[] = [];
  for (const r of reads) {
    let st: AnchorState | null = null;
    if (s.conditionOn) {
      const c = centreOf(r);
      if (c == null) continue;
      st = anchorState(r, c, s.conditionBp, s.conditionNucBp);
    }
    for (const b of bands) {
      const intervals = b == null ? r.intervals : r.intervals?.filter(([a, e, size]) => bandOf(size ?? e - a, s.bandEdges) === b);
      const id = `${r.group}${b != null && s.band === 'each' ? `|b${b}` : ''}${st ? `|s:${st}` : ''}`;
      out.push({ ...r, group: id, ...(intervals ? { intervals } : {}) });
    }
  }
  return { reads: out, groups: outGroups };
}

/** "footprints < 90 bp", "one line per size band (< 90, 90–200, ≥ 200 bp)", conditioning text: what a profile measures. */
export function bandsText(s: ProfileSettings): string {
  const band = s.band === 'off' ? '' : s.band === 'each' ? `one line per size band (${[...s.bandEdges.map((_, i) => bandLabel(s.bandEdges, i)), bandLabel(s.bandEdges, s.bandEdges.length)].join(', ')})` : `footprints ${bandLabel(s.bandEdges, s.band)}`;
  const cond = s.conditionOn ? `reads grouped by their state at the anchor ± ${s.conditionBp} bp (nucleosome ≥ ${s.conditionNucBp} bp, TF-sized, open)` : '';
  return [band, cond].filter(Boolean).join('; ');
}
