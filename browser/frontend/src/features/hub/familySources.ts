/**
 * Feature families as per-read sources: the feature hub's sets in a view that carry per-read states (Find classes'
 * footprint classes, NFR runs' variants and regions, nucleosome geometries), read with /api/features/states as Plots ›
 * Differential and Group by › Selected classes read them; never recomputed.
 *
 * One source of truth for every consumer: Plots' metaprofile sources (features/plots/multiSource.ts) read families
 * through here, and Quantify a window's measure registry (feat/window-quant: windowQuant/sources.ts) uses the same ids
 * (`fam:<set>|<hit>`), kinds and membership rule, so it can import this module instead of its own copy.
 *
 * Membership rule: a read is a member of a hit when any of the hit's refs says '1' (footprint classes have one ref per
 * dataset); it was evaluated when any says '0' or '1'. Reads with neither were not scored on the hit.
 */
import { getFeatureStates } from '../../api/features';
import type { BrowserState } from '../../stores/browserStore';
import { mergeProviderSets } from './hubData';
import { hitSelectionEntry, hubProviders, selectionRefs, type HubSelected, type HubView } from './hubState';

export interface FamilyKind {
  /** The source group id ("fp-families"). */
  source: string;
  label: string;
  /** Picker order (layers 10, families 20, NFR 30, nucleosomes 40). */
  order: number;
  typeIds: string[];
  /** Why there are none in a view, and the step that makes some (a Plots prerequisite kind). */
  empty: { reason: string; prereq?: 'classes' | 'nfr' | 'geometries'; stepLabel?: string };
}

export const FAMILY_KINDS: readonly FamilyKind[] = [
  { source: 'fp-families', label: 'Footprint families', order: 20, typeIds: ['fp.class'],
    empty: { reason: 'Find classes has not run on this view', prereq: 'classes', stepLabel: 'Find classes' } },
  { source: 'nfr-families', label: 'NFR families', order: 30, typeIds: ['nfr.variant', 'nfr.region'],
    empty: { reason: 'No NFR (Accessibility) run covers this view: run one in the Accessibility panel', prereq: 'nfr', stepLabel: 'Open Accessibility' } },
  // Listed under 'Nucleosomes' with the regularity score in Quantify's picker (Plots doesn't offer geometries).
  { source: 'nuc-geometries', label: 'Nucleosomes', order: 40, typeIds: ['nuc.geometry'] /* geoHub.GEO_TYPE_ID */,
    empty: { reason: 'No nucleosome geometries in this view', prereq: 'geometries', stepLabel: 'Find geometries' } },
];

/** A family's source id: `fam:<set>|<hit>` (Quantify a window's measure id, the same string). */
export const familyMeasureId = (h: Pick<HubSelected, 'setId' | 'hitId'>): string => `fam:${h.setId}|${h.hitId}`;
export const isFamilySource = (id: string): boolean => id.startsWith('fam:');

/** The hits of these types in view that carry per-read states, by position. */
export function familyHits(state: BrowserState, view: HubView, typeIds: readonly string[]): HubSelected[] {
  const sets = mergeProviderSets(hubProviders().flatMap(p => { try { return p.sets(state, view); } catch { return []; } }));
  return sets.filter(set => typeIds.includes(set.typeId) && set.source.kind === 'inline')
    .flatMap(set => (set.source.kind === 'inline' ? set.source.hits : []).map(hit => hitSelectionEntry(set, hit)))
    .filter(h => h.hasStates)
    .sort((a, b) => a.start - b.start || a.hitId.localeCompare(b.hitId));
}

/** The family kind a hit belongs to (by its type). */
export const familyKindOf = (typeId: string): FamilyKind | undefined => FAMILY_KINDS.find(k => k.typeIds.includes(typeId));

/** Per hit: its span and, per dataset, the member and the evaluated read names. */
export interface FamilyMembership {
  id: string;
  label: string;
  span: [number, number];
  chrom: string;
  members: Record<string, Set<string>>;
  evaluated: Record<string, Set<string>>;
}

/** The state of a read over a hit's refs at positions `idx` (the membership rule above). */
export function familyState(states: string, idx: number[]): '1' | '0' | undefined {
  let st: '1' | '0' | undefined;
  for (const j of idx) { const c = states[j]; if (c === '1') return '1'; if (c === '0') st = '0'; }
  return st;
}

/** Membership of the hits' reads (one request; each hit's refs sit at known positions in the answer). */
export async function loadFamilyMembership(hits: HubSelected[]): Promise<Map<string, FamilyMembership>> {
  const out = new Map<string, FamilyMembership>();
  if (!hits.length) return out;
  const refs = hits.map(h => selectionRefs([h]));
  const res = await getFeatureStates(refs.flat());
  let at = 0;
  hits.forEach((h, i) => {
    const idx = refs[i].map(() => at++);
    const members: Record<string, Set<string>> = {}, evaluated: Record<string, Set<string>> = {};
    for (const [ds, reads] of Object.entries(res.by_dataset ?? {})) {
      const m = new Set<string>(), e = new Set<string>();
      for (const [read, states] of Object.entries(reads)) {
        const st = familyState(states, idx);
        if (st) e.add(read);
        if (st === '1') m.add(read);
      }
      if (e.size) { members[ds] = m; evaluated[ds] = e; }
    }
    out.set(familyMeasureId(h), { id: familyMeasureId(h), label: h.label ?? h.hitId, span: [h.start, h.end], chrom: h.chrom, members, evaluated });
  });
  return out;
}
