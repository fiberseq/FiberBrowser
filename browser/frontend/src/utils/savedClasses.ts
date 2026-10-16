/** Saved lattice-recaller classes: each save is its own definition (S1, S2, ...) tied to the run it came from, so a
 * strict and a loose run can both contribute classes without the second run's same-numbered class taking over. */
import type { FootprintGroup, SavedClassInfo } from '../types';
import type { RecallerChannel, RecallerClassRow } from './recallerTable';
import { channelTargets, parseTiers, tierSpec, TIER_LABEL } from './recallerTable';
import { classLabel } from './classIdentity';

/** The next free saved-class id across everything saved. */
export function nextSavedClassId(groups: FootprintGroup[]): string {
  const used = groups.map(g => /^S(\d+)$/.exec(g.savedClass?.id ?? '')?.[1]).filter(Boolean).map(Number);
  return `S${(used.length ? Math.max(...used) : 0) + 1}`;
}

/**
 * Saved classes loaded from a rules file, renumbered to follow the ones already here (appending must not give two
 * definitions the same S-number). Every entry of one loaded definition gets the same new id; names follow.
 */
export function remapSavedClassIds(loaded: FootprintGroup[], existing: FootprintGroup[]): FootprintGroup[] {
  const mapping = new Map<string, string>();
  const taken = [...existing];
  for (const g of loaded) {
    const old = g.savedClass?.id;
    if (!old || mapping.has(old)) continue;
    const next = nextSavedClassId(taken);
    mapping.set(old, next);
    taken.push({ ...g, savedClass: { ...g.savedClass!, id: next } });
  }
  return loaded.map(g => {
    const old = g.savedClass?.id;
    if (!old) return g;
    const id = mapping.get(old)!;
    const name = g.name.startsWith(`${old} · `) ? `${id} · ${g.name.slice(old.length + 3)}` : g.name;
    return { ...g, name, savedClass: { ...g.savedClass!, id } };
  });
}

/**
 * The groups an Undo puts back after a removal: entries still here are not doubled, and a saved class whose S-number
 * was given to another class meanwhile comes back under a new one (never two definitions under one id).
 */
export function restoreRemovedGroups(removed: FootprintGroup[], current: FootprintGroup[]): FootprintGroup[] {
  const back = removed.filter(g => !current.some(x => x.id === g.id));
  const taken = new Set(current.flatMap(g => (g.savedClass ? [g.savedClass.id] : [])));
  const colliding = back.filter(g => g.savedClass && taken.has(g.savedClass.id));
  const keep = back.filter(g => !colliding.includes(g));
  const remapped = remapSavedClassIds(colliding, [...current, ...keep]);
  return [...current, ...back.map(g => (colliding.includes(g) ? remapped[colliding.indexOf(g)] : g))];
}

/** Saved classes in the order first saved, each with its entries (one per picked dataset/strand). */
export function savedClassEntries(groups: FootprintGroup[]): { info: SavedClassInfo; groups: FootprintGroup[] }[] {
  const byId = new Map<string, { info: SavedClassInfo; groups: FootprintGroup[] }>();
  for (const g of groups) {
    if (!g.savedClass) continue;
    const entry = byId.get(g.savedClass.id) ?? { info: g.savedClass, groups: [] };
    entry.groups.push(g); byId.set(g.savedClass.id, entry);
  }
  return [...byId.values()];
}

/** The saved class as a class-table row (its run's numbers), for the shared table helpers. */
export function savedClassRow(info: SavedClassInfo): RecallerClassRow {
  return { family: info.id, start: info.start, end: info.end, datasets: [...new Set(info.channels.map(c => c.datasetId))], channels: info.stats };
}

const targetLabel = (info: SavedClassInfo, t: { datasetId: string; strand: string | null }) => {
  const c = info.channels.find(x => x.datasetId === t.datasetId);
  const dataset = c ? c.label.replace(/ (CT|GA)$/, '') : t.datasetId;
  return t.strand ? `${dataset} ${t.strand}` : dataset;
};

/** The name a saved class shows: its own class label ("Class 025") unless the user renamed it. An older saved entry's
 * rank-based name ("Class 1") is replaced by the class's own label, everywhere the class is named (card, export, filters). */
export function savedDisplayName(info: Pick<SavedClassInfo, 'className' | 'family'>): string {
  return !info.className || /^Class \S+$/.test(info.className) ? classLabel(info.family) : info.className;
}

export const savedClassName = (info: SavedClassInfo, tier?: string | null) =>
  `${info.id} · ${savedDisplayName(info)}${!tier || tier === 'core' ? '' : ` (${parseTiers(tier).map(t => TIER_LABEL[t]).join(' + ')})`}`;

/**
 * The entries for a saved class: one per picked target (a DAF dataset with both strands picked is one entry). Entries
 * already present for a target keep their id, color and on/off state, so filters and co-occupancy follow them.
 */
export function savedClassGroups(info: SavedClassInfo, template: FootprintGroup, tier: string | null | undefined, existing: FootprintGroup[] = []): FootprintGroup[] {
  const spec = tierSpec(parseTiers(tier));
  const targets = channelTargets(info.picked, info.channels as RecallerChannel[]);
  return targets.map(t => {
    const source = info.channels.find(c => c.datasetId === t.datasetId)?.source;
    const datasetId = source?.dataset_id ?? t.datasetId;
    const interval = source ? (source.window.strand === '-'
      ? [source.window.end - (info.end - source.coordinate_origin), source.window.end - (info.start - source.coordinate_origin)]
      : [source.window.start + info.start - source.coordinate_origin, source.window.start + info.end - source.coordinate_origin]) : null;
    const prior = existing.find(g => (g.consensusDatasetId ?? g.sourceDatasetId) === t.datasetId && (g.consensusStrand ?? null) === t.strand);
    const base = prior ?? { ...template, id: crypto.randomUUID() };
    const { consensusStrand: _s, consensusTier: _t, ...rest } = base;
    return {
      ...rest, savedClass: info, sourceDatasetId: datasetId,
      ...(source && interval ? { consensusDatasetId: t.datasetId, referenceChrom: source.window.chrom,
        referenceAbsStart: interval[0], referenceAbsEnd: interval[1], familyModelAbsStart: interval[0], familyModelAbsEnd: interval[1] } : {}),
      name: `${savedClassName(info, spec)} · ${targetLabel(info, t)}`,
      // Stored explicitly, 'core' included: a strict saved class must never inherit a wider display tier.
      ...(t.strand ? { consensusStrand: t.strand } : {}), consensusTier: spec,
    };
  });
}

/** What a saved (Cart) class counts: its stored tier; a missing one (a strict save from before tiers were stored)
 * is strict. Never the run's display tier, which only unsaved class-table actions follow. */
export const savedTierOf = (g: Pick<FootprintGroup, 'consensusTier'>): string => tierSpec(parseTiers(g.consensusTier || 'core'));

/** Replace a saved class's entries (after changing its channels or what it counts), keeping its place in the list. */
export function replaceSavedClass(all: FootprintGroup[], id: string, next: FootprintGroup[]): FootprintGroup[] {
  const at = all.findIndex(g => g.savedClass?.id === id);
  const rest = all.filter(g => g.savedClass?.id !== id);
  if (at < 0) return [...rest, ...next];
  const before = all.slice(0, at).filter(g => g.savedClass?.id !== id).length;
  return [...rest.slice(0, before), ...next, ...rest.slice(before)];
}

/** Per class of a run: what its saved definitions count ('core', 'core+edge', ...; the union when saved more than
 * once), which is what the reads show for it while that run is displayed. Unsaved classes count strictly. */
export function savedRunTiers(groups: FootprintGroup[], jobId: string): Record<string, string> {
  const parts = new Map<string, Set<string>>();
  for (const g of groups) {
    if (!g.savedClass || g.consensusJobId !== jobId || !g.consensusStateId) continue;
    const set = parts.get(g.consensusStateId) ?? new Set<string>();
    parseTiers(g.consensusTier).forEach(t => set.add(t)); parts.set(g.consensusStateId, set);
  }
  return Object.fromEntries([...parts].map(([family, set]) => [family, tierSpec([...set] as ReturnType<typeof parseTiers>)]));
}
