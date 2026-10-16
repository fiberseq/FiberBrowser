/**
 * Sessions and plugin packs (ARCHITECTURE.md): a session says which packs wrote parts of it (`packs` in its frontend
 * state, and in every undo step and crash-recovery copy: each pack's panel types, row types, feature kinds, panel
 * fields and store keys). A build without one of them leaves those parts out when it opens the session, an undo step
 * or a recovered state, and says so in one line (sessions); a build with them restores everything.
 */
import { hasContribution, loadedPacks, packDeclarations, type ContributionKind, type PackDeclaration } from '../plugins/packRegistry';
import type { PanelConfig } from '../types';

export type SessionPacks = Record<string, Omit<PackDeclaration, 'name'>>;

/** What this build's packs contributed, for the session being saved. */
export function sessionPackMarker(): SessionPacks {
  const out: SessionPacks = {};
  for (const { name, ...rest } of packDeclarations()) out[name] = rest;
  return out;
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

const KINDS: ContributionKind[] = ['panels', 'tracks', 'features', 'panelFields', 'panelOwners', 'stateKeys'];

/**
 * The packs a session's frontend state names that this build doesn't have, with only the parts this build lacks: a
 * part such a pack wrote that this build also has (a feature that graduated from the pack to core) is restored as
 * this build's own. A pack whose every part this build has is not missing.
 */
export function missingSessionPacks(frontend: Record<string, unknown> | undefined): PackDeclaration[] {
  const marker = frontend?.packs;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return [];
  const here = new Set(loadedPacks().map(p => p.name));
  return Object.entries(marker as Record<string, unknown>).filter(([name]) => !here.has(name)).map(([name, raw]) => {
    const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const out = { name, label: typeof d.label === 'string' && d.label ? d.label : name } as PackDeclaration;
    for (const kind of KINDS) out[kind] = list(d[kind]).filter(id => !hasContribution(kind, id));
    return out;
  }).filter(d => KINDS.some(kind => d[kind].length));
}

export interface MissingPackOptions {
  /** Datasets the server left out (a missing pack's: results.datasets_skipped): their panels go too. */
  skippedDatasetIds?: Iterable<string>;
}

type PanelLike = Pick<PanelConfig, 'contentType' | 'subTracks'> & { id?: string; datasetId?: string | null };

/**
 * A session's panels without the missing packs' panels (their types, and panels one of their owner fields marks),
 * rows and panel fields, and without the panels of datasets the server skipped.
 */
export function withoutMissingPacks<T extends PanelLike>(panels: T[], missing: PackDeclaration[], options: MissingPackOptions = {}): T[] {
  if (!Array.isArray(panels)) return panels;
  const skipped = new Set(options.skippedDatasetIds ?? []);
  if (!missing.length && !skipped.size) return panels;
  const types = new Set(missing.flatMap(m => m.panels));
  const tracks = new Set(missing.flatMap(m => m.tracks));
  const fields = missing.flatMap(m => m.panelFields);
  const owners = missing.flatMap(m => m.panelOwners ?? []);
  const owned = (p: T) => owners.some(f => (p as Record<string, unknown>)[f] != null);
  return panels.filter(p => p && !types.has(p.contentType) && !owned(p) && !(p.datasetId && skipped.has(p.datasetId))).map(p => {
    const out = { ...p } as T & Record<string, unknown>;
    for (const field of fields) delete out[field];
    if (Array.isArray(p.subTracks)) out.subTracks = p.subTracks.filter(t => !tracks.has(t?.type));
    return out;
  });
}

interface SavedStateLike {
  panels?: unknown;
  fullViewPanelId?: string | null;
  datasets?: unknown;
  packs?: unknown;
}

/**
 * A saved state (a session's frontend state, an undo step, a crash-recovery copy) fit for this build: the missing
 * packs' panels left out (withoutMissingPacks), the full view cleared when its panel went, and the datasets only the
 * removed panels showed dropped (crash recovery would reopen them; undo compares them with the open ones).
 */
export function withoutMissingPackState<S extends SavedStateLike>(state: S, options: MissingPackOptions = {}): S {
  if (!state || !Array.isArray(state.panels)) return state;
  const missing = missingSessionPacks(state as Record<string, unknown>);
  const skipped = [...(options.skippedDatasetIds ?? [])];
  if (!missing.length && !skipped.length) return state;
  const before = state.panels as PanelLike[];
  const panels = withoutMissingPacks(before, missing, { skippedDatasetIds: skipped });
  const keptIds = new Set(panels.map(p => p.id));
  const keptDatasets = new Set(panels.map(p => p.datasetId).filter(Boolean));
  const dropped = new Set([...skipped, ...before.filter(p => p && !keptIds.has(p.id) && p.datasetId && !keptDatasets.has(p.datasetId)).map(p => p.datasetId as string)]);
  const out = { ...state, panels } as S;
  if (state.fullViewPanelId && !keptIds.has(state.fullViewPanelId)) out.fullViewPanelId = null;
  if (Array.isArray(state.datasets) && dropped.size) {
    out.datasets = (state.datasets as { id?: string }[]).filter(d => !(d && d.id && dropped.has(d.id)));
  }
  return out;
}

/**
 * Whether a saved state uses a missing pack's parts (so leaving them out is worth a note): a panel of its types, a panel
 * it owns or with a field of its, a selected feature of its kinds, or a list it saved that isn't empty. Its rows alone
 * don't count (new panels get every registered row, used or not).
 */
export function usesPackParts(state: Record<string, unknown> | undefined, pack: PackDeclaration): boolean {
  if (!state) return false;
  const panels = (Array.isArray(state.panels) ? state.panels : []) as Record<string, unknown>[];
  const fields = [...pack.panelFields, ...pack.panelOwners];
  if (panels.some(p => p && (pack.panels.includes(String(p.contentType)) || fields.some(f => p[f] != null)))) return true;
  const selected = (Array.isArray(state.selectedFeatures) ? state.selectedFeatures : []) as { kind?: unknown }[];
  if (selected.some(f => pack.features.includes(String(f?.kind)))) return true;
  return pack.stateKeys.some(key => Array.isArray(state[key]) && (state[key] as unknown[]).length > 0);
}

/** The one-line note a build without a session's packs gives (labels: of the packs, from the session or the server). */
export function missingPacksNote(labels: string[]): string | null {
  const unique = [...new Set(labels.filter(Boolean))];
  if (!unique.length) return null;
  return `This session uses features this build doesn't include (${unique.join(', ')}); they were left out.`;
}
