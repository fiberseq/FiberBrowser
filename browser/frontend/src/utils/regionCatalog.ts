import type { RegionCatalog, RegionCategory, RegionEntry } from '../types/regions';
import { categoryOrder, type ParsedBedRegion } from './regionBed';

/**
 * Pure operations on one reference's region catalog (stores/regionCatalogStore.ts
 * applies them). Every function returns a new catalog and leaves its input alone.
 */

let counter = 0;
export function regionId(prefix = 'r'): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function emptyCatalog(genome: string): RegionCatalog {
  return { version: 1, genome, categories: [], entries: [] };
}

export function findCategoryByName(catalog: RegionCatalog, name: string, parent?: string): RegionCategory | undefined {
  const wanted = name.trim().toLowerCase();
  return catalog.categories.find(c => c.name.trim().toLowerCase() === wanted && (c.parent ?? undefined) === (parent ?? undefined));
}

export function addCategory(catalog: RegionCatalog, category: Omit<RegionCategory, 'id'> & { id?: string }): { catalog: RegionCatalog; id: string } {
  const id = category.id ?? regionId('c');
  if (catalog.categories.some(c => c.id === id)) return { catalog, id };
  // A subheading only under a top-level category (one level of nesting).
  const parent = category.parent && catalog.categories.some(c => c.id === category.parent && !c.parent) ? category.parent : undefined;
  const next: RegionCategory = { ...category, id, name: category.name.trim() || 'Regions', ...(parent ? { parent } : {}), created: category.created ?? new Date().toISOString() };
  if (!parent) delete next.parent;
  return { catalog: { ...catalog, categories: [...catalog.categories, next] }, id };
}

/** The category of this name (a subheading when `parent`), made if missing. */
export function ensureCategory(catalog: RegionCatalog, name: string, extra: Partial<RegionCategory> = {}): { catalog: RegionCatalog; id: string } {
  const found = findCategoryByName(catalog, name, extra.parent);
  if (found) return { catalog, id: found.id };
  return addCategory(catalog, { name, ...extra });
}

export function updateCategory(catalog: RegionCatalog, id: string, patch: Partial<Omit<RegionCategory, 'id'>>): RegionCatalog {
  return { ...catalog, categories: catalog.categories.map(c => (c.id === id ? { ...c, ...patch } : c)) };
}

/** A category, its subheadings and every region in them. */
export function removeCategory(catalog: RegionCatalog, id: string): RegionCatalog {
  const gone = new Set([id, ...catalog.categories.filter(c => c.parent === id).map(c => c.id)]);
  return {
    ...catalog,
    categories: catalog.categories.filter(c => !gone.has(c.id)),
    entries: catalog.entries.filter(e => !gone.has(e.category)),
  };
}

/** Move a category before another (null: to the end), optionally under a new parent (null: top level). */
export function moveCategory(catalog: RegionCatalog, id: string, beforeId: string | null, parent?: string | null): RegionCatalog {
  const cat = catalog.categories.find(c => c.id === id);
  if (!cat || (beforeId === id && parent === undefined)) return catalog;
  const hasChildren = catalog.categories.some(c => c.parent === id);
  let moved: RegionCategory = cat;
  if (parent !== undefined) {
    // One level: a category with subheadings stays at the top; never under itself.
    const ok = parent && parent !== id && !hasChildren && catalog.categories.some(c => c.id === parent && !c.parent);
    moved = { ...cat };
    if (ok) moved.parent = parent as string;
    else delete moved.parent;
  }
  const rest = catalog.categories.filter(c => c.id !== id);
  if (beforeId === id) return { ...catalog, categories: catalog.categories.map(c => (c.id === id ? moved : c)) };
  const at = beforeId ? rest.findIndex(c => c.id === beforeId) : -1;
  const categories = at < 0 ? [...rest, moved] : [...rest.slice(0, at), moved, ...rest.slice(at)];
  return { ...catalog, categories };
}

export type NewEntry = Omit<RegionEntry, 'id' | 'category'> & { id?: string };

export function addEntries(catalog: RegionCatalog, categoryId: string, entries: NewEntry[]): { catalog: RegionCatalog; ids: string[] } {
  // Never into a category this catalog doesn't have (the regions would be invisible).
  if (!catalog.categories.some(c => c.id === categoryId)) return { catalog, ids: [] };
  const now = new Date().toISOString();
  const taken = new Set(catalog.entries.map(e => e.id));
  const added: RegionEntry[] = [];
  for (const entry of entries) {
    const start = Math.max(0, Math.floor(entry.start));
    const end = Math.ceil(entry.end);
    if (!entry.chrom || !(end > start)) continue;
    let id = entry.id ?? regionId('e');
    if (taken.has(id)) {
      if (entry.id) continue; // the same region again (a migration run twice)
      id = regionId('e');
    }
    taken.add(id);
    added.push({ ...entry, id, start, end, label: (entry.label ?? '').trim() || `${entry.chrom}:${start.toLocaleString()}-${end.toLocaleString()}`, category: categoryId, created: entry.created ?? now });
  }
  return { catalog: { ...catalog, entries: [...catalog.entries, ...added] }, ids: added.map(e => e.id) };
}

export function updateEntry(catalog: RegionCatalog, id: string, patch: Partial<Omit<RegionEntry, 'id'>>): RegionCatalog {
  return {
    ...catalog,
    entries: catalog.entries.map(e => {
      if (e.id !== id) return e;
      const next = { ...e, ...patch };
      next.start = Math.max(0, Math.floor(next.start));
      next.end = Math.max(next.start + 1, Math.ceil(next.end));
      if (typeof patch.label === 'string') next.label = patch.label.trim() || e.label;
      return next;
    }),
  };
}

export function removeEntries(catalog: RegionCatalog, ids: Iterable<string>): RegionCatalog {
  const gone = new Set(ids);
  return { ...catalog, entries: catalog.entries.filter(e => !gone.has(e.id)) };
}

/** Move regions into a category, before `beforeId` (null: at its end), keeping their order. */
export function moveEntries(catalog: RegionCatalog, ids: string[], categoryId: string, beforeId: string | null = null): RegionCatalog {
  if (!catalog.categories.some(c => c.id === categoryId)) return catalog;
  const moving = new Set(ids.filter(id => id !== beforeId));
  const picked = catalog.entries.filter(e => moving.has(e.id)).map(e => ({ ...e, category: categoryId }));
  if (!picked.length) return catalog;
  const rest = catalog.entries.filter(e => !moving.has(e.id));
  let at = beforeId ? rest.findIndex(e => e.id === beforeId) : -1;
  if (at < 0) {
    // After the category's last region (or at the end).
    let last = -1;
    rest.forEach((e, i) => { if (e.category === categoryId) last = i; });
    at = last < 0 ? rest.length : last + 1;
  }
  return { ...catalog, entries: [...rest.slice(0, at), ...picked, ...rest.slice(at)] };
}

/** Regions of a category in display order (with `deep`, its subheadings' after its own). */
export function entriesOf(catalog: RegionCatalog, categoryId: string, deep = false): RegionEntry[] {
  const ids = new Set([categoryId]);
  if (deep) for (const c of catalog.categories) if (c.parent === categoryId) ids.add(c.id);
  const own = catalog.entries.filter(e => e.category === categoryId);
  if (!deep) return own;
  const children = catalog.categories.filter(c => c.parent === categoryId).flatMap(c => catalog.entries.filter(e => e.category === c.id));
  return [...own, ...children];
}

/**
 * BED regions into the catalog: under their track-line (or "Category | label")
 * categories, else under `fallbackCategory` (the file's name). Returns the
 * categories used.
 */
export function importBedRegions(catalog: RegionCatalog, regions: ParsedBedRegion[], fallbackCategory: string): { catalog: RegionCatalog; imported: number; categories: string[] } {
  let next = catalog;
  const byPath = new Map<string, string>();
  const used: string[] = [];
  const categoryFor = (path: string[] | undefined): string => {
    const names = path && path.length ? path : [fallbackCategory];
    const key = names.join('\u0000');
    const known = byPath.get(key);
    if (known) return known;
    const top = ensureCategory(next, names[0], { source: 'bed' });
    next = top.catalog;
    let id = top.id;
    if (names.length > 1) {
      const child = ensureCategory(next, names[1], { source: 'bed', parent: top.id });
      next = child.catalog;
      id = child.id;
    }
    byPath.set(key, id);
    if (!used.includes(id)) used.push(id);
    return id;
  };
  const grouped = new Map<string, NewEntry[]>();
  for (const r of regions) {
    const id = categoryFor(r.categoryPath);
    const list = grouped.get(id) ?? [];
    list.push({ chrom: r.chrom, start: r.start, end: r.end, label: r.label, source: 'bed', ...(r.score != null ? { score: r.score } : {}), ...(r.strand ? { strand: r.strand } : {}) });
    grouped.set(id, list);
  }
  let imported = 0;
  for (const [id, list] of grouped) {
    const res = addEntries(next, id, list);
    next = res.catalog;
    imported += res.ids.length;
  }
  return { catalog: next, imported, categories: used };
}

/** Union of two catalogs of one reference: `over` wins for ids in both; order: base's, then over's new ones. */
export function mergeCatalogs(base: RegionCatalog, over: RegionCatalog): RegionCatalog {
  // One category per dataset's detected amplicons: `over`'s replaces a same-dataset one under another id.
  const autoOver = new Map(over.categories.filter(c => c.source === 'auto' && c.fingerprint).map(c => [c.fingerprint as string, c.id]));
  const replaced = new Set(base.categories.filter(c => c.source === 'auto' && c.fingerprint && autoOver.has(c.fingerprint) && autoOver.get(c.fingerprint) !== c.id).map(c => c.id));
  if (replaced.size) {
    base = { ...base, categories: base.categories.filter(c => !replaced.has(c.id)), entries: base.entries.filter(e => !replaced.has(e.category)) };
  }
  const overCats = new Map(over.categories.map(c => [c.id, c]));
  const overEntries = new Map(over.entries.map(e => [e.id, e]));
  const baseCatIds = new Set(base.categories.map(c => c.id));
  const baseEntryIds = new Set(base.entries.map(e => e.id));
  return {
    version: 1,
    genome: base.genome || over.genome,
    categories: [...base.categories.map(c => overCats.get(c.id) ?? c), ...over.categories.filter(c => !baseCatIds.has(c.id))],
    entries: [...base.entries.map(e => overEntries.get(e.id) ?? e), ...over.entries.filter(e => !baseEntryIds.has(e.id))],
  };
}

/** A catalog from anywhere (a session file, the server) made safe to use. */
export function normalizeCatalog(raw: unknown, genome: string): RegionCatalog {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<RegionCatalog>;
  const categories = (Array.isArray(r.categories) ? r.categories : [])
    .filter((c): c is RegionCategory => !!c && typeof c === 'object' && typeof (c as RegionCategory).id === 'string')
    .map(c => ({ ...c, name: String(c.name ?? 'Regions') }));
  const catIds = new Set(categories.map(c => c.id));
  const entries = (Array.isArray(r.entries) ? r.entries : [])
    .filter((e): e is RegionEntry => !!e && typeof e === 'object' && typeof (e as RegionEntry).id === 'string'
      && typeof (e as RegionEntry).chrom === 'string' && Number.isFinite((e as RegionEntry).start) && Number.isFinite((e as RegionEntry).end)
      && (e as RegionEntry).end > (e as RegionEntry).start)
    .map(e => ({ ...e, label: String(e.label ?? ''), source: e.source ?? 'saved' }));
  // Regions whose category is missing get one, so nothing is invisible.
  let catalog: RegionCatalog = { version: 1, genome: String(r.genome ?? genome) || genome, categories, entries,
    ...(Number.isFinite(r.revision) ? { revision: Number(r.revision) } : {}) };
  if (entries.some(e => !catIds.has(e.category))) {
    const made = ensureCategory(catalog, 'Uncategorized', { source: 'user' });
    catalog = { ...made.catalog, entries: made.catalog.entries.map(e => (catIds.has(e.category) ? e : { ...e, category: made.id })) };
  }
  return catalog;
}

/** Categories in display order, each with its depth. */
export function orderedCategories(catalog: RegionCatalog): Array<{ category: RegionCategory; depth: 0 | 1; path: string }> {
  return categoryOrder(catalog).map(({ category, path }) => ({ category, depth: category.parent ? 1 : 0, path }));
}

/**
 * Names from a BED file for regions already listed (a dataset's amplicons):
 * each region takes the name of the BED region overlapping it most, when
 * that overlap covers at least half of either. Returns id -> name.
 */
export function namesFromBed(entries: RegionEntry[], bed: ParsedBedRegion[]): Map<string, string> {
  const byChrom = new Map<string, ParsedBedRegion[]>();
  for (const r of bed) {
    const list = byChrom.get(r.chrom) ?? [];
    list.push(r);
    byChrom.set(r.chrom, list);
  }
  const out = new Map<string, string>();
  for (const e of entries) {
    let best: { name: string; overlap: number } | null = null;
    for (const r of byChrom.get(e.chrom) ?? []) {
      const overlap = Math.min(e.end, r.end) - Math.max(e.start, r.start);
      if (overlap <= 0) continue;
      if (overlap < 0.5 * (e.end - e.start) && overlap < 0.5 * (r.end - r.start)) continue;
      if (!best || overlap > best.overlap) best = { name: r.label, overlap };
    }
    if (best) out.set(e.id, best.name);
  }
  return out;
}

/**
 * Another window saved the catalog since this one read it: this window's own
 * changes (from `base`, what it read, to `local`, what it has now) applied on
 * top of what is saved now (`server`): regions and categories it added or
 * changed replace or join the saved ones, the ones it deleted are removed.
 */
export function rebaseCatalog(base: RegionCatalog, local: RegionCatalog, server: RegionCatalog): RegionCatalog {
  const diff = <T extends { id: string }>(before: T[], after: T[]) => {
    const was = new Map(before.map(x => [x.id, JSON.stringify(x)]));
    const now = new Set(after.map(x => x.id));
    return {
      deleted: new Set(before.filter(x => !now.has(x.id)).map(x => x.id)),
      upserts: after.filter(x => was.get(x.id) !== JSON.stringify(x)),
    };
  };
  const apply = <T extends { id: string }>(list: T[], change: { deleted: Set<string>; upserts: T[] }): T[] => {
    const out = list.filter(x => !change.deleted.has(x.id));
    const at = new Map(out.map((x, i) => [x.id, i]));
    for (const x of change.upserts) {
      const i = at.get(x.id);
      if (i === undefined) { at.set(x.id, out.length); out.push(x); } else out[i] = x;
    }
    return out;
  };
  return normalizeCatalog({
    ...server,
    categories: apply(server.categories, diff(base.categories, local.categories)),
    entries: apply(server.entries, diff(base.entries, local.entries)),
  }, server.genome || local.genome);
}

/**
 * Undo one catalog change: `before` and `after` are the catalog around the change,
 * `current` the catalog now (edits made since are kept). What the change removed
 * comes back where it was, what it added goes, and what it changed gets its old
 * value back unless it was changed again since.
 */
export function revertCatalogChange(before: RegionCatalog, after: RegionCatalog, current: RegionCatalog): RegionCatalog {
  const revert = <T extends { id: string }>(was: T[], made: T[], now: T[]): T[] => {
    const madeById = new Map(made.map(x => [x.id, x]));
    const wasById = new Map(was.map(x => [x.id, x]));
    // Items the change added are dropped; items it changed get their old value back.
    const kept = now.filter(x => wasById.has(x.id) || !madeById.has(x.id))
      .map(x => (madeById.get(x.id) === x && wasById.has(x.id) ? wasById.get(x.id)! : x));
    // Items the change removed come back after the item that preceded them.
    const present = new Set(kept.map(x => x.id));
    const after = new Map<string | null, T[]>();
    let anchor: string | null = null;
    for (const item of was) {
      if (present.has(item.id)) { anchor = item.id; continue; }
      if (madeById.has(item.id)) continue;
      const list = after.get(anchor) ?? [];
      list.push(item);
      after.set(anchor, list);
    }
    if (!after.size) return kept;
    const out: T[] = [...(after.get(null) ?? [])];
    for (const x of kept) {
      out.push(x);
      const list = after.get(x.id);
      if (list) out.push(...list);
    }
    return out;
  };
  const entries = revert(before.entries, after.entries, current.entries);
  // A category the change made stays when regions or subheadings were added to it since
  // (they would be invisible without it).
  const used = new Set([...entries.map(e => e.category), ...current.categories.map(c => c.parent).filter((x): x is string => !!x)]);
  const beforeCats = new Set(before.categories.map(c => c.id));
  const keep = after.categories.filter(c => !beforeCats.has(c.id) && used.has(c.id));
  const categories = revert(before.categories, after.categories.filter(c => !keep.includes(c)), current.categories);
  return { ...current, categories, entries };
}

/**
 * Move categories (with their subheadings and regions) and regions from one
 * reference's catalog into another's (a BED imported into the wrong one, a
 * dataset's amplicons left on the wrong reference). Moved regions go into the
 * category of the same name there (made if missing). A dataset's detected
 * amplicons become an ordinary category (they are no longer that dataset's
 * detection on its reference). Ids are kept unless the target has them.
 */
export function moveBetweenCatalogs(
  source: RegionCatalog,
  target: RegionCatalog,
  what: { categoryIds?: string[]; entryIds?: string[] },
): { source: RegionCatalog; target: RegionCatalog; moved: number; entryIds: Array<[string, string]> } {
  /** Each moved region's id here and there. */
  const entryIds: Array<[string, string]> = [];
  const plain = (c: RegionCategory): Omit<RegionCategory, 'id'> & { id?: string } => {
    const { fingerprint: _fp, ...rest } = c;
    return { ...rest, source: c.source === 'auto' || c.source === 'top' ? 'user' : c.source };
  };
  const takenCats = new Set(target.categories.map(c => c.id));
  const takenEntries = new Set(target.entries.map(e => e.id));
  let next = target;
  let moved = 0;
  const goneCats = new Set<string>();
  const goneEntries = new Set<string>();
  // Whole categories (a subheading moved alone becomes a category there).
  for (const id of what.categoryIds ?? []) {
    const top = source.categories.find(c => c.id === id);
    if (!top || goneCats.has(id)) continue;
    const children = source.categories.filter(c => c.parent === id);
    const made = addCategory(next, { ...plain(top), parent: undefined, id: takenCats.has(top.id) ? undefined : top.id });
    next = made.catalog;
    takenCats.add(made.id);
    const idFor = new Map([[top.id, made.id]]);
    for (const child of children) {
      const sub = addCategory(next, { ...plain(child), parent: made.id, id: takenCats.has(child.id) ? undefined : child.id });
      next = sub.catalog;
      takenCats.add(sub.id);
      idFor.set(child.id, sub.id);
    }
    for (const [from, to] of idFor) {
      goneCats.add(from);
      const list = source.entries.filter(e => e.category === from);
      const res = addEntries(next, to, list.map(({ category: _c, id, ...e }) => ({ ...e, id: takenEntries.has(id) ? undefined : id })));
      next = res.catalog;
      res.ids.forEach((x, i) => { takenEntries.add(x); entryIds.push([list[i].id, x]); });
      list.forEach(e => goneEntries.add(e.id));
      moved += res.ids.length;
    }
  }
  // Single regions: into the category of the same name.
  const loose = source.entries.filter(e => (what.entryIds ?? []).includes(e.id) && !goneEntries.has(e.id));
  const byCategory = new Map<string, RegionEntry[]>();
  for (const e of loose) byCategory.set(e.category, [...(byCategory.get(e.category) ?? []), e]);
  for (const [categoryId, list] of byCategory) {
    const from = source.categories.find(c => c.id === categoryId);
    const found = ensureCategory(next, from?.name ?? 'Moved regions', from ? { source: plain(from).source } : { source: 'user' });
    next = found.catalog;
    const res = addEntries(next, found.id, list.map(({ category: _c, id, ...e }) => ({ ...e, id: takenEntries.has(id) ? undefined : id })));
    next = res.catalog;
    res.ids.forEach((x, i) => { takenEntries.add(x); entryIds.push([list[i].id, x]); });
    list.forEach(e => goneEntries.add(e.id));
    moved += res.ids.length;
  }
  return {
    source: { ...source, categories: source.categories.filter(c => !goneCats.has(c.id)), entries: source.entries.filter(e => !goneEntries.has(e.id)) },
    target: next,
    moved,
    entryIds,
  };
}
