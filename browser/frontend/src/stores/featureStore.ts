/**
 * Features: things selected in the read view, like peaks, that the main toolbar's Cluster, Sort and Filter act on:
 * footprint classes (Find classes run) here, and the kinds plugin packs register (registerFeatureKind). The channels
 * above the reads draw them; shift-click (there or in the panels' lists) selects them; Cluster, Sort and Filter act
 * on the selection, each kind on its own layer.
 *
 * The selection is session state (it lives in the browser store: `selectedFeatures`, saved with the session like the
 * peak selection). Hover and the runs drawn are transient (this store).
 */
import type { ComponentType } from 'react';
import { create } from 'zustand';
import { declareContribution } from '../plugins/packRegistry';

/** Feature kinds plugin packs add: a pack augments this interface (`declare module`) with its kinds as keys. */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface PackFeatureKinds {}

/** 'fp-class': a footprint class of a Find classes run (per dataset); the rest: plugin packs' kinds. */
export type FeatureKind = 'fp-class' | Extract<keyof PackFeatureKinds, string>;

export interface FeatureRef {
  kind: FeatureKind;
  /** The run the feature comes from (fp-class: the Find classes run; a pack's kind: its own source). */
  source: string;
  /** Footprint class: the class (family) id; a pack's kind: its own id. */
  id: string;
  /** Kinds that are per dataset (footprint classes) carry it. */
  datasetId?: string;
  /** Where it is and how it is shown (filled in where it was selected; kept with the selection in sessions). */
  chrom?: string;
  start?: number;
  end?: number;
  /** "Class 3". */
  label?: string;
  colour?: string;
}

/** A feature as drawn and listed. */
export interface Feature extends FeatureRef {
  chrom: string;
  start: number;
  end: number;
  label: string;
  colour: string;
}

/** What a feature kind is, for the selection, the chip and Cluster / Sort / Filter. */
export interface FeatureKindDef {
  kind: string;
  /** Features of it are per dataset (they need datasetId, and it is part of their identity). */
  perDataset?: boolean;
  /** Its identity also carries the chromosome (positions repeat across chromosomes). */
  keyedByChrom?: boolean;
  /** The layer its per-read states are read from, as the selection chip says it ("TF class layer"). */
  layerLabel: string;
  /** What hints call them ("footprint classes"), in `listOrder` among the kinds (absent: not named in hints). */
  pluralName?: string;
  /** What run notes call them when hints don't name them (no pluralName): "SVs" ("ticked SVs group reads only with Combinatorial"). */
  noun?: string;
  listOrder?: number;
  /** What a read's state at one of them means ("classes: footprinted or not"; Cluster's tooltip). */
  stateNote?: string;
  /** The layer they are clustered on ("footprint classes on the TF class layer"; Cluster's tooltip). */
  layerNote?: string;
  /** Where else the same groups come from ("the X panel's buttons"; Cluster's tooltip in combinatorial mode). */
  groupingNote?: string;
  /** The short name group labels use ("Class 3" -> "C3"). */
  shortName?: (f: FeatureRef) => string;
  /**
   * The peak-region mode the non-combinatorial Cluster uses for its span (null: not a region to cluster on). `layers`:
   * the feature's dataset's available layers, when the caller knows them (a kind may pick its layer by them).
   */
  regionMode?: (f: FeatureRef, ctx?: { layers?: Record<string, unknown> }) => string | null;
  /** The hub feature type its refs stand for ('fp.class'; features/hub/kinds.ts keeps the table one to one). */
  typeId?: string;
  /** Insertion boundaries: a ref with `start === end` keeps its coordinates (the true interval is the boundary). */
  zeroWidth?: boolean;
  /**
   * The kind's own toolbar actions. A selection holding it gets these instead of the generic ones: its features
   * alone are used (it doesn't mix with other kinds there; the chip says so).
   */
  actions?: FeatureKindActions;
}

export interface FeatureKindActions {
  cluster: (features: FeatureRef[]) => Promise<string | null>;
  /** The panel its Cluster groups (its id), when not the targeted panels: what Cluster's "Panels" plan names. */
  groupsPanel?: (features: FeatureRef[]) => string | undefined;
  /** Why Sort and Filter by features don't apply to it. */
  sortFilter: string;
  /** Why Cluster can't combine it with other kinds. */
  mixed: string;
  /** The selection chip's buttons for it (in place of the generic "Split into panels"). */
  Chip: ComponentType<{ features: FeatureRef[]; all: FeatureRef[] }>;
}

/** The kind with actions of its own among a selection's features (the first one), if any. */
export function featureKindWithActions(features: FeatureRef[]): (FeatureKindDef & { actions: FeatureKindActions }) | null {
  for (const f of features) {
    const def = kinds.get(f.kind);
    if (def?.actions) return def as FeatureKindDef & { actions: FeatureKindActions };
  }
  return null;
}

const kinds = new Map<string, FeatureKindDef>();

/** Add a feature kind (plugin packs; footprint classes are built in). */
export function registerFeatureKind(def: FeatureKindDef): void {
  kinds.set(def.kind, def);
  declareContribution('features', def.kind);
}

export function featureKindDef(kind: string): FeatureKindDef | undefined {
  return kinds.get(kind);
}

/** The kinds hints name ("Select footprint classes first"), in their order. */
export function listedFeatureKinds(): FeatureKindDef[] {
  return [...kinds.values()].filter(def => def.pluralName).sort((a, b) => (a.listOrder ?? 100) - (b.listOrder ?? 100));
}

registerFeatureKind({
  kind: 'fp-class', typeId: 'fp.class', perDataset: true, layerLabel: 'TF class layer', pluralName: 'footprint classes', listOrder: 10,
  stateNote: 'classes: footprinted or not', layerNote: 'footprint classes on the TF class layer',
  shortName: f => (f.label || f.id).replace(/^class\s*/i, 'C'),
  // The TF class layer the dataset has: recalled (tf_rc), cross-recalled (tf_cr), else the calls (tf). Without the
  // dataset's layers (the combinatorial pattern regions), 'tf'.
  regionMode: (_f, ctx) => (ctx?.layers?.tf_rc ? 'tf_rc' : ctx?.layers?.tf_cr ? 'tf_cr' : 'tf'),
});

/** A feature's peak-region mode (its kind's `regionMode`; 'accessibility' for kinds without one; null: not a region). */
export function featureRegionMode(f: FeatureRef, layers?: Record<string, unknown>): string | null {
  const def = kinds.get(f.kind);
  if (!def?.regionMode) return 'accessibility';
  return layers ? def.regionMode(f, { layers }) : def.regionMode(f);
}

export const featureKey = (r: FeatureRef): string => {
  const def = kinds.get(r.kind);
  return `${r.kind}|${r.source}|${r.id}|${def?.perDataset ? r.datasetId ?? '' : ''}${def?.keyedByChrom ? `|${r.chrom ?? ''}` : ''}`;
};
export const sameFeature = (a: FeatureRef | null | undefined, b: FeatureRef | null | undefined): boolean =>
  !!a && !!b && featureKey(a) === featureKey(b);

/** "Class 3" -> "C3" (a pack's kind: its own short name): the short name group labels use. */
export function featureShortName(f: FeatureRef): string {
  const def = kinds.get(f.kind);
  return def?.shortName ? def.shortName(f) : (f.label || f.id);
}

/** Selected features from a session or snapshot: well formed, of kinds this build knows, without duplicates. */
export function normalizeFeatureRefs(value: unknown): FeatureRef[] {
  if (!Array.isArray(value)) return [];
  const out: FeatureRef[] = [];
  const seen = new Set<string>();
  for (const v of value) {
    if (!v || typeof v !== 'object') continue;
    const r = v as Record<string, unknown>;
    const def = typeof r.kind === 'string' ? kinds.get(r.kind) : undefined;
    if (!def) continue;  // a kind of a plugin pack this build doesn't have
    if (typeof r.source !== 'string' || typeof r.id !== 'string' || !r.source || !r.id) continue;
    if (def.perDataset && (typeof r.datasetId !== 'string' || !r.datasetId)) continue;
    const ref: FeatureRef = { kind: r.kind as FeatureKind, source: r.source, id: r.id };
    if (typeof r.datasetId === 'string' && r.datasetId) ref.datasetId = r.datasetId;
    if (typeof r.chrom === 'string' && r.chrom) ref.chrom = r.chrom;
    // Zero-width coordinates (an insertion boundary) are kept only for kinds that declare them.
    if (Number.isFinite(r.start) && Number.isFinite(r.end)
      && (Number(r.end) > Number(r.start) || (def.zeroWidth && Number(r.end) === Number(r.start)))) { ref.start = Number(r.start); ref.end = Number(r.end); }
    if (typeof r.label === 'string' && r.label) ref.label = r.label;
    if (typeof r.colour === 'string' && r.colour) ref.colour = r.colour;
    const key = featureKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/** Toggle a feature in a selection (additive: shift / ctrl / cmd) or make it the only one (a plain click). */
export function nextSelection(current: FeatureRef[], ref: FeatureRef, additive: boolean): FeatureRef[] {
  const key = featureKey(ref);
  const has = current.some(r => featureKey(r) === key);
  if (!additive) return has && current.length === 1 ? current : [ref];
  return has ? current.filter(r => featureKey(r) !== key) : [...current, ref];
}

interface FeatureStore {
  hovered: FeatureRef | null;
  setHover: (ref: FeatureRef | null) => void;
}

export const useFeatureStore = create<FeatureStore>(set => ({
  hovered: null,
  setHover: hovered => set(state => (sameFeature(state.hovered, hovered) || (!state.hovered && !hovered) ? {} : { hovered })),
}));

/** Hover and selection state of one feature (for a row or a bar to ring itself). */
export function isFeatureIn(list: FeatureRef[], ref: FeatureRef): boolean {
  const key = featureKey(ref);
  return list.some(r => featureKey(r) === key);
}
