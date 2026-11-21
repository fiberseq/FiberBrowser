/**
 * The Plots Gallery (PLOTS_PANEL_PLAN.md §Gallery): plots the user keeps, with the plot in the builder as its working card.
 *
 * A card holds the data to redraw a result exactly (the server's matrices, packed), a small thumbnail, the plot's
 * settings and the browser state when it was made (the undo/session serialized state, deduplicated across cards).
 * Three kinds of card (`status`):
 * - working: one per open plot (`plotId`), updated in place by every result (settings changes, Follow, re-runs); never
 *   in the saved Gallery, shown in the "Current" row. It goes when its plot is closed (with an undo).
 * - kept: in the Gallery, only by an explicit act: Keep (a frozen copy: data, browser state, seed; the working plot
 *   carries on), Duplicate, or choosing it for the Gallery's Compare. A plot opened from a kept card is a working plot
 *   whose `parentId` is that card: keeping it again adds a version under the card ("Replace original" swaps it in).
 * - legacy: unstarred auto-cards of sessions before explicit keeping, in a collapsed "Older auto-saved" group the
 *   user can clear in one click; the cap applies only to them. Starred auto-cards load as kept.
 *
 * A standalone store, not the browser store: the Gallery holds browser states, so it must never sit inside one (undo
 * snapshots would nest it). The session carries it as `frontend.plotsGallery` (api/session.ts).
 *
 * Session format (version 2; version 1 loads as above):
 *   plotsGallery: { version: 2, cap: number, entries: GalleryEntry[], states: { [stateId]: SerializedState } }
 */
import { create } from 'zustand';
import type { FootprintSizeData } from '../../api/clustering';
import { normalizePlot, type PlotLocus, type PlotSpec } from './plotModel';

export const GALLERY_VERSION = 2;
/** Older auto-saved (legacy) cards kept (oldest roll off). Kept and working cards have no cap. */
export const DEFAULT_GALLERY_CAP = 50;
export const MAX_GALLERY_CAP = 500;

/** A matrix packed for the session: values quantised to 16 bits between lo and hi (65535 = blank), base64. */
export interface PackedMatrix { r: number; c: number; lo: number; hi: number; q: string }

const NULL_CODE = 65535;
const LEVELS = 65534;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function packMatrix(m: (number | null)[][]): PackedMatrix {
  const r = m.length;
  const c = m[0]?.length ?? 0;
  let lo = Infinity, hi = -Infinity;
  for (const row of m) for (const v of row) if (v != null && Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!Number.isFinite(lo)) { lo = 0; hi = 0; }
  const codes = new Uint16Array(r * c);
  const span = hi - lo;
  for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) {
    const v = m[i][j];
    codes[i * c + j] = v == null || !Number.isFinite(v) ? NULL_CODE : span > 0 ? Math.round(((v - lo) / span) * LEVELS) : 0;
  }
  return { r, c, lo, hi, q: toBase64(new Uint8Array(codes.buffer)) };
}

export function unpackMatrix(p: PackedMatrix): (number | null)[][] {
  const bytes = fromBase64(p.q);
  const codes = new Uint16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const span = p.hi - p.lo;
  return Array.from({ length: p.r }, (_, i) => Array.from({ length: p.c }, (_, j) => {
    const code = codes[i * p.c + j];
    return code === NULL_CODE ? null : p.lo + (span > 0 ? (code / LEVELS) * span : 0);
  }));
}

type SizeData = FootprintSizeData;
export type PackedSizeData = Omit<SizeData, 'matrix'> & { matrix: PackedMatrix };
export type PackedByPanel = Record<string, Record<string, PackedSizeData>>;

export function packByPanel(byPanel: Record<string, Record<string, SizeData>>): PackedByPanel {
  const out: PackedByPanel = {};
  for (const [panel, groups] of Object.entries(byPanel)) {
    out[panel] = {};
    for (const [g, d] of Object.entries(groups)) out[panel][g] = { ...d, matrix: packMatrix(d.matrix) };
  }
  return out;
}

export function unpackByPanel(packed: PackedByPanel): Record<string, Record<string, SizeData>> {
  const out: Record<string, Record<string, SizeData>> = {};
  for (const [panel, groups] of Object.entries(packed)) {
    out[panel] = {};
    for (const [g, d] of Object.entries(groups)) out[panel][g] = { ...d, matrix: unpackMatrix(d.matrix) } as SizeData;
  }
  return out;
}

/** A metaprofile's raw groups, packed (coverage and signal per bin; finished at draw time). */
export interface PackedProfile {
  binBp: number;
  groups: Array<{ id: string; title: string; color?: string; dash?: number[]; nReads: number; coverage: PackedMatrix; signal: PackedMatrix }>;
}

export function packProfile(binBp: number, groups: Array<{ id: string; title: string; color?: string; dash?: number[]; raw: { nReads: number; coverage: ArrayLike<number>; signal: ArrayLike<number> } }>): PackedProfile {
  return { binBp, groups: groups.map(g => ({ id: g.id, title: g.title, color: g.color, ...(g.dash ? { dash: g.dash } : {}), nReads: g.raw.nReads,
    coverage: packMatrix([Array.from(g.raw.coverage)]), signal: packMatrix([Array.from(g.raw.signal)]) })) };
}

export function unpackProfile(p: PackedProfile): { binBp: number; groups: Array<{ id: string; title: string; color?: string; dash?: number[]; raw: { group: string; nReads: number; coverage: Float64Array; signal: Float64Array } }> } {
  const row = (m: PackedMatrix) => Float64Array.from((unpackMatrix(m)[0] ?? []).map(v => v ?? 0));
  return { binBp: p.binBp, groups: p.groups.map(g => ({ id: g.id, title: g.title, color: g.color, ...(g.dash ? { dash: g.dash } : {}), raw: { group: g.id, nReads: g.nReads, coverage: row(g.coverage), signal: row(g.signal) } })) };
}

/** A heatmap's data, packed: reads (rows as one matrix, with their group, start and mean) or features (per feature and
 * group, raw coverage and signal as matrices: row = feature × group). */
export interface PackedHeatmap {
  mode: 'reads' | 'features';
  binBp: number;
  start: number;
  groups: Array<{ id: string; title: string; color?: string }>;
  rows?: { group: string[]; start: number[]; mean: number[]; values: PackedMatrix };
  features?: { meta: Array<{ id: string; label: string; chrom: string; start: number; end: number; genome: string | null }>; nReads: number[]; coverage: PackedMatrix; signal: PackedMatrix };
}

export type GalleryStatus = 'working' | 'kept' | 'legacy';

export interface GalleryEntry {
  id: string;
  name: string;
  /** working: the open plot's card (`plotId`); kept: in the Gallery; legacy: an old session's auto-card. */
  status: GalleryStatus;
  /** Kept (the Gallery shows it): status === 'kept'. Kept for the card's data attribute and old readers. */
  starred: boolean;
  /** Working cards: the open plot they belong to. */
  plotId?: string;
  /** Working cards: the identity of what was last kept from it (its button then says Kept until the plot changes). */
  keptAs?: string;
  createdAt: number;
  /** The entry this one was edited from (a version), if any. */
  parentId: string | null;
  /** The plot's settings as made (a Follow plot keeps Follow; `computedFor` says where it was). */
  plot: PlotSpec;
  computedFor: PlotLocus;
  /** The request it answers (Open redraws from `data` while the request is unchanged). */
  requestKey: string;
  data: PackedByPanel;
  /** A metaprofile's data (profile types); size types use `data`. */
  profile?: PackedProfile;
  /** A heatmap's data. */
  heatmap?: PackedHeatmap;
  /** A line the plot showed with its data (BED region sets: the counts). */
  note?: string;
  /** Differential features: the table (rows, sides, test). */
  diff?: PackedDiff;
  /** Supplied series (a panel's run), kept exactly (not packed to 16 bits). */
  supplied?: SuppliedData;
  /** The groups drawn, in order: "<panel key>|<group>" ids into `data`, with their titles and colours. */
  items: Array<{ id: string; title: string; color?: string }>;
  /** A small JPEG data URL ('' where no canvas: tests). */
  thumb: string;
  /** Browser state when made: a key into `states`. */
  stateId: string;
  /** Dataset names (the card's line). */
  datasets: string[];
}

export interface GalleryState {
  version: number;
  /** Older auto-saved cards kept (oldest roll off). */
  cap: number;
  /** Not used since explicit keeping (version 2): always null. */
  liveId: string | null;
  entries: GalleryEntry[];
  states: Record<string, unknown>;
}

export const emptyGallery = (): GalleryState => ({ version: GALLERY_VERSION, cap: DEFAULT_GALLERY_CAP, liveId: null, entries: [], states: {} });

export const useGalleryStore = create<GalleryState>(() => emptyGallery());

/** A short, stable id for a JSON string (FNV-1a, 2 × 32 bits). */
export function hashText(text: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

let counter = 0;
const newEntryId = () => `g-${Date.now().toString(36)}-${(++counter).toString(36)}`;

/** Legacy cards past the cap leave, oldest first; states no entry uses leave with them. */
export function pruned(g: GalleryState): GalleryState {
  const legacy = g.entries.filter(e => e.status === 'legacy');
  const drop = new Set(legacy.slice(0, Math.max(0, legacy.length - g.cap)).map(e => e.id));
  const entries = drop.size ? g.entries.filter(e => !drop.has(e.id)) : g.entries;
  const used = new Set(entries.map(e => e.stateId));
  const states: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(g.states)) if (used.has(k)) states[k] = v;
  return { ...g, entries, states, liveId: null };
}

export const keptEntries = (g: GalleryState): GalleryEntry[] => g.entries.filter(e => e.status === 'kept');
export const workingEntries = (g: GalleryState): GalleryEntry[] => g.entries.filter(e => e.status === 'working');
export const legacyEntries = (g: GalleryState): GalleryEntry[] => g.entries.filter(e => e.status === 'legacy');
export const workingFor = (g: GalleryState, plotId: string): GalleryEntry | null => g.entries.find(e => e.status === 'working' && e.plotId === plotId) ?? null;

export interface GalleryInput {
  plot: PlotSpec;
  computedFor: PlotLocus;
  requestKey: string;
  byPanel: Record<string, Record<string, SizeData>>;
  items: Array<{ id: string; title: string; color?: string }>;
  thumb: string;
  datasets: string[];
  parentId?: string | null;
  name?: string;
  /** Profile types: their packed data (byPanel is then empty). */
  profile?: PackedProfile;
  heatmap?: PackedHeatmap;
  note?: string;
  diff?: PackedDiff;
  supplied?: SuppliedData;
}

/** Series a panel supplied, exactly as it computed them (null = no value at that x). */
export interface SuppliedData {
  /** x of each value when not evenly spaced (absent: x0 + i * dx). */
  xs?: number[];
  /** Matrices (supplied V-plots and heatmaps), one block each, rows top to bottom. */
  matrices?: Array<{ id: string; title: string; color?: string; rows: Array<{ label: string; values: Array<number | null> }> }>;
  series: Array<{ id: string; title: string; color?: string; dash?: number[]; values: Array<number | null> }>;
}

/** A differential result as kept: the rows (capped), the two sides and the test. */
export interface PackedDiff {
  rows: import('./differentialData').DiffRow[];
  groups: import('./differentialData').DiffEntry['groups'];
  test: string;
  density: import('./differentialData').DiffEntry['density'];
}

export const MAX_STORED_DIFF_ROWS = 2000;

/** What makes two results the same plot: its settings without its id, name and pin (renaming or pinning a plot
 * changes the entry, it does not make a new one). */
export function resultIdentity(plot: PlotSpec): string {
  const { id: _id, name: _name, pinned: _pinned, ...rest } = plot;
  return JSON.stringify(rest);
}

function withState(g: GalleryState, browserState: unknown): { stateId: string; states: Record<string, unknown> } {
  const stateJson = JSON.stringify(browserState ?? null);
  const stateId = hashText(stateJson);
  return { stateId, states: stateId in g.states ? g.states : { ...g.states, [stateId]: JSON.parse(stateJson) } };
}

function entryFromInput(input: GalleryInput, stateId: string, status: GalleryStatus, id = newEntryId()): GalleryEntry {
  return {
    id, name: input.name ?? '', status, starred: status === 'kept', createdAt: Date.now(), parentId: input.parentId ?? null,
    ...(status === 'working' ? { plotId: input.plot.id } : {}),
    plot: input.plot, computedFor: input.computedFor, requestKey: input.requestKey, data: packByPanel(input.byPanel),
    ...(input.profile ? { profile: input.profile } : {}), ...(input.heatmap ? { heatmap: input.heatmap } : {}), ...(input.note != null ? { note: input.note } : {}),
    ...(input.diff ? { diff: input.diff } : {}), ...(input.supplied ? { supplied: input.supplied } : {}), items: input.items,
    thumb: input.thumb, stateId, datasets: input.datasets,
  };
}

/** What a kept copy is a copy of: the plot's settings and the request (a working card is "kept" while these hold). */
export const contentIdentity = (e: Pick<GalleryEntry, 'plot' | 'requestKey'>): string => hashText(`${resultIdentity(e.plot)}|${e.requestKey}`);

/** Kept for callers of the old card rule: options are ignored (every result updates its plot's working card). */
export interface RecordOptions { following?: boolean; force?: boolean }

/**
 * Record a result: the plot's working card is updated in place, or made (the first result of a plot). Never a Gallery
 * card: only Keep, Duplicate and Compare add those. The same request with the same settings again changes nothing.
 */
export function recordInGallery(g: GalleryState, input: GalleryInput, browserState: unknown, _o: RecordOptions = {}): { gallery: GalleryState; entry: GalleryEntry | null; created: boolean } {
  const cur = workingFor(g, input.plot.id);
  if (cur && cur.requestKey === input.requestKey && resultIdentity(cur.plot) === resultIdentity(input.plot) && cur.parentId === (input.parentId ?? null)) {
    return { gallery: g, entry: cur, created: false };
  }
  const { stateId, states } = withState(g, browserState);
  const next = entryFromInput({ ...input, name: input.name || cur?.name || '' }, stateId, 'working', cur?.id);
  if (cur?.keptAs) next.keptAs = cur.keptAs;
  const entries = cur ? g.entries.map(e => (e.id === cur.id ? next : e)) : [...g.entries, next];
  return { gallery: pruned({ ...g, entries, states }), entry: next, created: !cur };
}

/** A frozen copy of a card as a kept Gallery card (Keep, Duplicate, Compare). A working card's copy keeps its parent
 *  (a version of the card it was opened from); `parentId` overrides. */
export function keptCopy(e: GalleryEntry, patch: Partial<Pick<GalleryEntry, 'name' | 'parentId'>> = {}): GalleryEntry {
  const { plotId: _p, keptAs: _k, ...rest } = e;
  return { ...rest, ...patch, id: newEntryId(), status: 'kept', starred: true, createdAt: Date.now() };
}

/** Keep: a working card's content enters the Gallery as a frozen copy (the working plot carries on). A kept or legacy
 *  card is made kept in place. Returns the kept card. */
export function keepEntry(g: GalleryState, id: string, name?: string): { gallery: GalleryState; kept: GalleryEntry | null } {
  const e = g.entries.find(x => x.id === id);
  if (!e) return { gallery: g, kept: null };
  if (e.status !== 'working') {
    const kept: GalleryEntry = { ...e, status: 'kept', starred: true, ...(name ? { name } : {}) };
    return { gallery: { ...g, entries: g.entries.map(x => (x.id === id ? kept : x)) }, kept };
  }
  const kept = keptCopy(e, name ? { name } : {});
  const working: GalleryEntry = { ...e, keptAs: contentIdentity(e), ...(name ? { name } : {}) };
  return { gallery: { ...g, entries: [...g.entries.map(x => (x.id === id ? working : x)), kept] }, kept };
}

/** Duplicate: a kept copy of any card (a sibling, not a version). */
export function duplicateEntry(g: GalleryState, id: string): { gallery: GalleryState; kept: GalleryEntry | null } {
  const e = g.entries.find(x => x.id === id);
  if (!e) return { gallery: g, kept: null };
  const kept = keptCopy(e, { name: `${e.name || ''}${e.name ? ' ' : ''}(copy)`.trim(), parentId: e.status === 'kept' ? e.parentId : null });
  return { gallery: { ...g, entries: [...g.entries, kept] }, kept };
}

/** Whether the working card's content is what was last kept from it. */
export const workingIsKept = (e: GalleryEntry | null): boolean => !!e && e.status === 'working' && e.keptAs === contentIdentity(e);

/** Close a plot: its working card goes (kept copies stay). Returns the card for an undo. */
export function closeWorking(g: GalleryState, plotId: string): { gallery: GalleryState; removed: GalleryEntry | null } {
  const e = workingFor(g, plotId);
  if (!e) return { gallery: g, removed: null };
  return { gallery: pruned({ ...g, entries: g.entries.filter(x => x.id !== e.id) }), removed: e };
}

/** Undo a close: the working card back (its browser state is still in `states` when another card shares it, else given). */
export function restoreWorking(g: GalleryState, e: GalleryEntry, state: unknown): GalleryState {
  if (g.entries.some(x => x.id === e.id)) return g;
  const states = e.stateId in g.states ? g.states : { ...g.states, [e.stateId]: state };
  return { ...g, entries: [...g.entries.filter(x => !(x.status === 'working' && x.plotId === e.plotId)), e], states };
}

/** Clear the older auto-saved group. */
export const clearLegacy = (g: GalleryState): GalleryState => pruned({ ...g, entries: g.entries.filter(e => e.status !== 'legacy') });

/** Kept for old callers: no live cards since explicit keeping. */
export const freezeEntry = (g: GalleryState, _id: string): GalleryState => g;

/** Rename or change a card's plot. `starred: true` keeps it, `starred: false` on a kept card returns it to working
 *  only if it is one; otherwise ignored (unkeeping a kept card is Delete). */
export const updateEntry = (g: GalleryState, id: string, patch: Partial<Pick<GalleryEntry, 'name' | 'starred' | 'plot'>>): GalleryState => {
  const base = patch.starred === true ? keepEntry(g, id).gallery : g;
  const { starred: _s, ...rest } = patch;
  return { ...base, entries: base.entries.map(e => (e.id !== id ? e
    // The card's name is its plot's name (one field).
    : { ...e, ...rest, ...(rest.name !== undefined ? { plot: { ...(rest.plot ?? e.plot), name: rest.name } } : {}) })) };
};

export const removeEntry = (g: GalleryState, id: string): GalleryState => pruned({ ...g, entries: g.entries.filter(e => e.id !== id) });

/** "Replace original": `fromId`'s content (a working card or a version) takes the place of the kept card `targetId`,
 *  keeping its id, name and parent. A version `fromId` goes; a working card stays (now matching what is kept). */
export function replaceEntry(g: GalleryState, targetId: string, fromId: string): GalleryState {
  const target = g.entries.find(e => e.id === targetId);
  const from = g.entries.find(e => e.id === fromId);
  if (!target || !from || target === from) return g;
  const { plotId: _p, keptAs: _k, ...content } = from;
  const merged: GalleryEntry = { ...content, id: target.id, name: target.name, status: 'kept', starred: true, parentId: target.parentId };
  const entries = g.entries.flatMap(e => {
    if (e.id === targetId) return [merged];
    if (e.id === fromId) return from.status === 'working' ? [{ ...from, keptAs: contentIdentity(from) }] : [];
    return [e];
  });
  return pruned({ ...g, entries });
}

export const setCap = (g: GalleryState, cap: number): GalleryState =>
  pruned({ ...g, cap: Math.round(Math.min(MAX_GALLERY_CAP, Math.max(1, Number.isFinite(cap) ? cap : DEFAULT_GALLERY_CAP))) });

export const entryState = (g: GalleryState, e: GalleryEntry): unknown => g.states[e.stateId];

function normalizeEntry(raw: unknown, states: Record<string, unknown>, version: number): GalleryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const loc = r.computedFor as Record<string, unknown> | undefined;
  if (typeof r.id !== 'string' || !r.data || typeof r.data !== 'object' || !loc || typeof loc.chrom !== 'string') return null;
  if (typeof r.stateId !== 'string' || !(r.stateId in states)) return null;
  return {
    id: r.id, name: typeof r.name === 'string' ? r.name.slice(0, 200) : '',
    // Before explicit keeping (version 1) every result was a card: starred ones were kept, the rest are older auto-saved.
    ...(() => {
      const status: GalleryStatus = version < 2 ? (r.starred === true ? 'kept' : 'legacy')
        : r.status === 'working' || r.status === 'legacy' ? r.status : 'kept';
      return { status, starred: status === 'kept',
        ...(status === 'working' && typeof r.plotId === 'string' ? { plotId: r.plotId } : {}),
        ...(status === 'working' && typeof r.keptAs === 'string' ? { keptAs: r.keptAs } : {}) };
    })(),
    createdAt: Number(r.createdAt) || 0, parentId: typeof r.parentId === 'string' ? r.parentId : null,
    plot: normalizePlot(r.plot),
    computedFor: { chrom: loc.chrom, start: Number(loc.start) || 0, end: Number(loc.end) || 0, genome: typeof loc.genome === 'string' ? loc.genome : null },
    requestKey: typeof r.requestKey === 'string' ? r.requestKey : '', data: r.data as PackedByPanel,
    ...(r.profile && typeof r.profile === 'object' && Array.isArray((r.profile as PackedProfile).groups) ? { profile: r.profile as PackedProfile } : {}),
    ...(r.heatmap && typeof r.heatmap === 'object' && Array.isArray((r.heatmap as PackedHeatmap).groups) ? { heatmap: r.heatmap as PackedHeatmap } : {}),
    ...(typeof r.note === 'string' ? { note: r.note.slice(0, 2000) } : {}),
    ...(r.diff && typeof r.diff === 'object' && Array.isArray((r.diff as PackedDiff).rows) && (r.diff as PackedDiff).groups
      ? { diff: { ...(r.diff as PackedDiff), rows: (r.diff as PackedDiff).rows.slice(0, MAX_STORED_DIFF_ROWS) } } : {}),
    ...(r.supplied && typeof r.supplied === 'object' && Array.isArray((r.supplied as SuppliedData).series)
      ? { supplied: { ...(Array.isArray((r.supplied as SuppliedData).matrices) ? { matrices: (r.supplied as SuppliedData).matrices!.filter(m => m && typeof m.id === 'string' && Array.isArray(m.rows))
        .map(m => ({ ...m, rows: m.rows.map(row => ({ label: String(row.label ?? ''), values: (row.values ?? []).map(v => (typeof v === 'number' && Number.isFinite(v) ? v : null)) })) })) } : {}),
        ...(Array.isArray((r.supplied as SuppliedData).xs) ? { xs: (r.supplied as SuppliedData).xs!.filter(v => typeof v === 'number') } : {}), series: (r.supplied as SuppliedData).series.filter(x => x && typeof x.id === 'string' && Array.isArray(x.values))
        .map(x => ({ ...x, values: x.values.map(v => (typeof v === 'number' && Number.isFinite(v) ? v : null)) })) } } : {}),
    items: Array.isArray(r.items) ? (r.items as unknown[]).filter((i): i is { id: string; title: string; color?: string } =>
      !!i && typeof i === 'object' && typeof (i as { id?: unknown }).id === 'string' && typeof (i as { title?: unknown }).title === 'string') : [],
    thumb: typeof r.thumb === 'string' && r.thumb.startsWith('data:image/') ? r.thumb : '', stateId: r.stateId,
    datasets: Array.isArray(r.datasets) ? r.datasets.filter((d): d is string => typeof d === 'string') : [],
  };
}

/** A stored Gallery as state (malformed entries, and entries whose browser state is missing, are left out). */
export function normalizeGallery(raw: unknown): GalleryState {
  if (!raw || typeof raw !== 'object') return emptyGallery();
  const r = raw as Record<string, unknown>;
  const states = r.states && typeof r.states === 'object' ? r.states as Record<string, unknown> : {};
  const version = Number(r.version) || 1;
  const seen = new Set<string>();
  const entries: GalleryEntry[] = [];
  for (const e of Array.isArray(r.entries) ? r.entries : []) {
    const n = normalizeEntry(e, states, version);
    if (!n || seen.has(n.id) || (n.status === 'working' && !n.plotId)) continue;
    seen.add(n.id);
    entries.push(n);
  }
  return setCap({ version: GALLERY_VERSION, cap: DEFAULT_GALLERY_CAP, liveId: null, entries, states }, Number(r.cap ?? DEFAULT_GALLERY_CAP));
}

/** The session's copy. */
export const galleryForSave = (): GalleryState => useGalleryStore.getState();
/** Session import: the session's Gallery, or an empty one. */
export function restoreGallery(raw: unknown): void { useGalleryStore.setState(normalizeGallery(raw), true); }
