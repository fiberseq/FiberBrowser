/**
 * The feature hub's session state (store extension `featureHub`, DESIGN §5.6): the scans it opened (by path, with
 * the manifest digest), its list settings, saved anchor sets and the hub selection. Hub refs (scan hits) live only
 * here, never in the legacy `selectedFeatures` (sessions from this build still open in 3.0.x, which ignores this
 * key). Browser providers (Find classes runs, NFR runs, SVs, peaks, Differences) register here and feed sets.
 */
import { registerStoreExtension } from '../../stores/storeExtensions';
import type { BrowserState } from '../../stores/browserStore';
import { featureKindDef, normalizeFeatureRefs, registerFeatureKind, type FeatureRef } from '../../stores/featureStore';
import type { AnchorSet, FeatureHit, FeatureSet, FeatureTypeDecl, Frame, GraphAlias, LiftStatus, TargetSpan } from './types';
import { kindOfType } from './kinds';
import type { AssocMode, AssocRequest, AssocResult } from './assocApi';
import { normalizeOverlay, type OverlayState } from './overlayTypes';

export interface HubOpenedScan {
  path: string;
  scanId: string;
  manifestDigest: string;
  label: string;
  source: 'opened' | 'cache';
}

export interface HubUi {
  /** Sets left out of the hit list (by set id). */
  hiddenSets: string[];
  /** '' = every type, else a type id. */
  typeFilter: string;
  /** Keep hits with a prevalence at least this in some column (null: no filter). */
  minPrevalence: number | null;
  sort: { key: 'locus' | 'prevalence' | 'strength' | 'delta' | 'label'; dir: 'asc' | 'desc' };
  /** Two comparison columns (group keys) for Δ. */
  compare: [string, string] | null;
  /** Only hits matched in another frame or set ("find shared", DESIGN §5.4). */
  sharedOnly?: boolean;
  /** The hub's tab: the hit list, the association builder and runs (A2), the patch overlay (V1). */
  tab?: 'hits' | 'assoc' | 'overlay';
}

/** An association run kept with the session (DESIGN §5.6): its definition and its result (rows capped at 5,000). */
export interface AssocRun {
  id: string;
  createdAt: string;
  label: string;
  definition: AssocRequest;
  status: 'complete' | 'error' | 'cancelled';
  result?: AssocResult;
  error?: string;
}

/** A hub selection entry: enough to act on it without the set loaded (Use as, sessions). */
export interface HubSelected {
  setId: string;
  hitId: string;
  typeId: string;
  chrom: string;
  start: number;
  end: number;
  anchor: number;
  strand?: '+' | '-';
  label?: string;
  /** The browser datasets the hit's states are read in (scan sets: bound datasets). */
  datasets?: string[];
  /** The hit's coordinate frame (a scan of another assembly: 'source'); absent: this genome. */
  frame?: Frame;
  /** Its set provides per-read states through /api/features/states (Filter can use it). */
  hasStates?: boolean;
  /** Sets backed by a legacy run keep their legacy refs (fp-class job/family per dataset, nfr run/element, sv). */
  legacyRefs?: FeatureRef[];
  /** A source-frame hit (G1): where it is on this genome, and its lift status. chrom/start/end stay the source's. */
  target?: TargetSpan;
  lift?: LiftStatus;
  /** Its graph columns (drawn on graph hosts and pop-outs). */
  graph?: GraphAlias;
  /** A lifted hit's strand on this genome (a flipped chain reverses its own). */
  targetStrand?: '+' | '-';
}

export interface FeatureHubState {
  scans: HubOpenedScan[];
  ui: HubUi;
  anchors: AnchorSet[];
  selected: HubSelected[];
  /** Association runs (A2), newest last. */
  assocRuns: AssocRun[];
  /** The patch overlay's settings and last result (V1). */
  overlay?: OverlayState | null;
}

export const DEFAULT_HUB_UI: HubUi = { hiddenSets: [], typeFilter: '', minPrevalence: null, sort: { key: 'locus', dir: 'asc' }, compare: null };
export const EMPTY_HUB: FeatureHubState = { scans: [], ui: DEFAULT_HUB_UI, anchors: [], selected: [], assocRuns: [] };

export const MAX_ASSOC_RUNS = 20;
const MAX_STORED_ROWS = 5000;
const MAX_STORED_HITS = 2000;
const MODES: AssocMode[] = ['M1', 'M2', 'M3', 'M4'];

/** A run as it is kept: inline hits of its definition and its rows capped (sessions stay small). */
export function storableRun(run: AssocRun): AssocRun {
  const capRef = (ref: AssocRequest['a'] | undefined) => (ref && ref.hits && ref.hits.length > MAX_STORED_HITS
    ? { ...ref, hits: ref.hits.slice(0, MAX_STORED_HITS) } : ref);
  const cut = [run.definition.a, run.definition.b].some(ref => (ref?.hits?.length ?? 0) > MAX_STORED_HITS);
  const definition = { ...run.definition, a: capRef(run.definition.a)!, ...(run.definition.b ? { b: capRef(run.definition.b) } : {}),
    ...(cut || run.definition.truncated ? { truncated: true } : {}) };
  const result = run.result ? { ...run.result, ...(run.result.anchors && run.result.anchors.length > MAX_STORED_ROWS
    ? { anchors: run.result.anchors.slice(0, MAX_STORED_ROWS) } : {}) } : undefined;
  return { ...run, definition, ...(result ? { result } : {}) };
}

function normalizeAssocRuns(value: unknown): AssocRun[] {
  if (!Array.isArray(value)) return [];
  const out: AssocRun[] = [];
  for (const raw of value) {
    const r = raw as Record<string, unknown>;
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.definition || typeof r.definition !== 'object') continue;
    const d = r.definition as Record<string, unknown>;
    if (!MODES.includes(d.mode as AssocMode) || !d.a || typeof d.a !== 'object') continue;
    const status = r.status === 'error' || r.status === 'cancelled' ? r.status : 'complete';
    const res = r.result && typeof r.result === 'object' && MODES.includes((r.result as { mode?: AssocMode }).mode as AssocMode)
      ? r.result as AssocResult : undefined;
    out.push(storableRun({ id: r.id, createdAt: typeof r.createdAt === 'string' ? r.createdAt : '', label: typeof r.label === 'string' ? r.label : '',
      definition: d as unknown as AssocRequest, status, ...(res ? { result: res } : {}),
      ...(typeof r.error === 'string' ? { error: r.error } : {}) }));
  }
  return out.slice(-MAX_ASSOC_RUNS);
}

declare module '../../stores/browserStore' {
  interface BrowserState {
    featureHub: FeatureHubState;
    setFeatureHub: (patch: Partial<FeatureHubState> | ((hub: FeatureHubState) => Partial<FeatureHubState>)) => void;
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const LIFT_STATUSES: LiftStatus[] = ['exact', 'split', 'partial', 'unmapped'];
const liftOf = (v: unknown): LiftStatus | null => (LIFT_STATUSES.includes(v as LiftStatus) ? v as LiftStatus : null);
function sourceOf(v: unknown): { chrom: string; start: number; end: number } | null {
  const q = v as Record<string, unknown> | null;
  if (!q || typeof q !== 'object' || !str(q.chrom) || num(q.start) === null || num(q.end) === null) return null;
  return { chrom: str(q.chrom), start: num(q.start)!, end: num(q.end)! };
}
function targetOf(v: unknown): TargetSpan | null {
  const q = v as Record<string, unknown> | null;
  if (!q || typeof q !== 'object' || !str(q.chrom) || num(q.start) === null || num(q.end) === null) return null;
  return { chrom: str(q.chrom), start: num(q.start)!, end: num(q.end)!, anchor: num(q.anchor) ?? num(q.start)!,
    ...(q.insertion === true ? { insertion: true } : {}) };
}
/** A selection's graph columns, kept as they were (bounded: a few thousand runs). */
function graphOf(v: unknown): GraphAlias | null {
  const g = v as Record<string, unknown> | null;
  if (!g || typeof g !== 'object' || !str(g.registration) || !str(g.target) || !str(g.binding) || !Array.isArray(g.columns)) return null;
  const columns = g.columns.slice(0, 4000).filter((c): c is [string, number, number] =>
    Array.isArray(c) && c.length === 3 && typeof c[0] === 'string' && Number.isFinite(c[1]) && Number.isFinite(c[2]));
  const anchor = Array.isArray(g.anchor) && g.anchor.length === 2 && g.anchor.every(Number.isFinite) ? g.anchor as [number, number] : [0, 0] as [number, number];
  const paths = g.paths && typeof g.paths === 'object' ? g.paths as GraphAlias['paths'] : {};
  return { registration: str(g.registration), target: str(g.target), binding: str(g.binding), anchor, columns,
    size: num(g.size) ?? columns.reduce((n, c) => n + c[2] - c[1], 0), paths };
}

/** Saved graph path statuses of an anchor (bounded). */
function pathsOfSaved(v: unknown): Record<string, { status: string; hap?: string; datasets?: string[] }> | null {
  if (!v || typeof v !== 'object') return null;
  const out: Record<string, { status: string; hap?: string; datasets?: string[] }> = {};
  for (const [k, p] of Object.entries(v as Record<string, unknown>).slice(0, 64)) {
    const q = p as Record<string, unknown>;
    if (!q || typeof q.status !== 'string') continue;
    out[k] = { status: q.status, ...(typeof q.hap === 'string' ? { hap: q.hap } : {}),
      ...(Array.isArray(q.datasets) ? { datasets: q.datasets.filter((x): x is string => typeof x === 'string') } : {}) };
  }
  return Object.keys(out).length ? out : null;
}

/** The hub state from a session or snapshot: well formed, unknown fields dropped. */
export function normalizeHub(value: unknown): FeatureHubState {
  if (!value || typeof value !== 'object') return EMPTY_HUB;
  const v = value as Record<string, unknown>;
  const scans = (Array.isArray(v.scans) ? v.scans : []).flatMap(raw => {
    const s = raw as Record<string, unknown>;
    if (!s || typeof s !== 'object' || !str(s.path) || !str(s.scanId)) return [];
    return [{ path: str(s.path), scanId: str(s.scanId), manifestDigest: str(s.manifestDigest), label: str(s.label) || str(s.path),
      source: s.source === 'cache' ? 'cache' as const : 'opened' as const }];
  });
  const u = (v.ui && typeof v.ui === 'object' ? v.ui : {}) as Record<string, unknown>;
  const sort = (u.sort && typeof u.sort === 'object' ? u.sort : {}) as Record<string, unknown>;
  const sortKeys = ['locus', 'prevalence', 'strength', 'delta', 'label'];
  const ui: HubUi = {
    hiddenSets: Array.isArray(u.hiddenSets) ? u.hiddenSets.filter((x): x is string => typeof x === 'string') : [],
    typeFilter: str(u.typeFilter),
    minPrevalence: num(u.minPrevalence),
    sort: { key: (sortKeys.includes(str(sort.key)) ? sort.key : 'locus') as HubUi['sort']['key'], dir: sort.dir === 'desc' ? 'desc' : 'asc' },
    compare: Array.isArray(u.compare) && u.compare.length === 2 && u.compare.every(x => typeof x === 'string') ? [u.compare[0], u.compare[1]] as [string, string] : null,
    ...(u.sharedOnly === true ? { sharedOnly: true } : {}),
    ...(u.tab === 'assoc' || u.tab === 'overlay' ? { tab: u.tab } : {}),
  };
  const anchors = (Array.isArray(v.anchors) ? v.anchors : []).flatMap(raw => {
    const a = raw as Record<string, unknown>;
    if (!a || typeof a !== 'object' || !str(a.id) || !Array.isArray(a.anchors)) return [];
    const points = a.anchors.flatMap(p => {
      const q = p as Record<string, unknown>;
      if (!q || !str(q.chrom) || num(q.pos) === null) return [];
      return [{ chrom: str(q.chrom), pos: num(q.pos)!, ...(q.strand === '+' || q.strand === '-' ? { strand: q.strand as '+' | '-' } : {}),
        ...(str(q.label) ? { label: str(q.label) } : {}), ...(str(q.hitId) ? { hitId: str(q.hitId) } : {}),
        ...(num(q.start) !== null ? { start: num(q.start)! } : {}), ...(num(q.end) !== null ? { end: num(q.end)! } : {}),
        ...(q.frame && typeof q.frame === 'object' && typeof (q.frame as { kind?: unknown }).kind === 'string' ? { frame: q.frame as Frame } : {}),
      ...(sourceOf(q.source) ? { source: { ...sourceOf(q.source)!, ...(num((q.source as Record<string, unknown>).anchor) !== null ? { anchor: num((q.source as Record<string, unknown>).anchor)! } : {}) } } : {}),
      ...(liftOf(q.lift) ? { lift: liftOf(q.lift)! } : {}),
      ...(q.insertion === true ? { insertion: true } : {}),
      ...(q.targetStrand === '+' || q.targetStrand === '-' ? { targetStrand: q.targetStrand as '+' | '-' } : {}),
      ...(pathsOfSaved(q.paths) ? { paths: pathsOfSaved(q.paths)! } : {}) }];
    });
    return [{ id: str(a.id), label: str(a.label) || 'Anchors', sources: Array.isArray(a.sources) ? a.sources.filter((x): x is string => typeof x === 'string') : [],
      createdAt: str(a.createdAt), anchors: points }];
  });
  const selected = (Array.isArray(v.selected) ? v.selected : []).flatMap(raw => {
    const h = raw as Record<string, unknown>;
    if (!h || !str(h.setId) || !str(h.hitId) || !str(h.chrom) || num(h.start) === null || num(h.end) === null) return [];
    return [{ setId: str(h.setId), hitId: str(h.hitId), typeId: str(h.typeId), chrom: str(h.chrom), start: num(h.start)!, end: num(h.end)!,
      anchor: num(h.anchor) ?? Math.floor((num(h.start)! + num(h.end)!) / 2),
      ...(h.strand === '+' || h.strand === '-' ? { strand: h.strand as '+' | '-' } : {}), ...(str(h.label) ? { label: str(h.label) } : {}),
      ...(Array.isArray(h.datasets) ? { datasets: h.datasets.filter((x): x is string => typeof x === 'string') } : {}),
      ...(typeof h.hasStates === 'boolean' ? { hasStates: h.hasStates } : {}),
      ...(h.frame && typeof h.frame === 'object' && typeof (h.frame as { kind?: unknown }).kind === 'string' ? { frame: h.frame as Frame } : {}),
      ...(Array.isArray(h.legacyRefs) ? { legacyRefs: normalizeFeatureRefs(h.legacyRefs) } : {}),
      ...(targetOf(h.target) ? { target: targetOf(h.target)! } : {}), ...(liftOf(h.lift) ? { lift: liftOf(h.lift)! } : {}),
      ...(graphOf(h.graph) ? { graph: graphOf(h.graph)! } : {}),
      ...(h.targetStrand === '+' || h.targetStrand === '-' ? { targetStrand: h.targetStrand as '+' | '-' } : {}) }];
  });
  const overlay = v.overlay && typeof v.overlay === 'object' ? normalizeOverlay(v.overlay) : null;
  return { scans, ui, anchors, selected, assocRuns: normalizeAssocRuns(v.assocRuns), ...(overlay ? { overlay } : {}) };
}

export function registerHubState(): void {
  registerStoreExtension({
    id: 'featureHub',
    keys: ['featureHub'],
    create: set => ({
      featureHub: EMPTY_HUB,
      setFeatureHub: (patch: Partial<FeatureHubState> | ((hub: FeatureHubState) => Partial<FeatureHubState>)) =>
        set(s => ({ featureHub: { ...s.featureHub, ...(typeof patch === 'function' ? patch(s.featureHub) : patch) } })),
    }),
    serialize: s => ({ featureHub: s.featureHub ?? EMPTY_HUB }),
    restoreSnapshot: saved => ('featureHub' in saved ? { featureHub: normalizeHub(saved.featureHub) } : {}),
    importSession: frontend => {
      const featureHub = normalizeHub(frontend?.featureHub);
      // The server closed the previous session's scans on import: reopen this session's own (also with the hub
      // closed, so their read layers come back).
      if (featureHub.scans.length) setTimeout(() => { void import('./hubData').then(m => m.restoreSessionScans()); }, 0);
      return { featureHub };
    },
    // The previous session's live data and live scan.
    onSessionImport: () => {
      void import('./hubData').then(m => m.resetHubData());
      void import('./hubJob').then(m => m.useHubJob.getState().clear());
      void import('./assocJob').then(m => m.useAssocJob.getState().clear());
    },
  });
}

// ------------------------------------------------------------------ browser providers
export interface HubView { chrom: string; start: number; end: number }

export interface HubProvider {
  id: string;
  /** The provider's sets for the view (inline hits). */
  sets: (s: BrowserState, view: HubView) => FeatureSet[];
  /** Calls `listener` when its sets may have changed (stores outside the browser store). */
  subscribe?: (listener: () => void) => () => void;
}

const providers = new Map<string, HubProvider>();
const providerListeners = new Set<() => void>();

/** Add a browser provider (core features, plugin packs). */
export function registerHubProvider(provider: HubProvider): void {
  providers.set(provider.id, provider);
  for (const fn of providerListeners) fn();
}

export function hubProviders(): HubProvider[] {
  return [...providers.values()];
}

export function onHubProvidersChanged(fn: () => void): () => void {
  providerListeners.add(fn);
  return () => { providerListeners.delete(fn); };
}

// ------------------------------------------------------------------ kinds of hub types
/** Register the selection kind of a hub type once (scan types the build has no kind for yet). */
export function ensureHubKind(type: FeatureTypeDecl): string {
  const kind = kindOfType(type.typeId);
  if (!featureKindDef(kind)) {
    registerFeatureKind({
      kind, typeId: type.typeId, layerLabel: 'scan states', stateNote: type.stateRule || undefined,
      zeroWidth: type.zeroWidth || undefined,
      shortName: f => f.label || f.id.split(':').slice(-2, -1)[0] || f.id,
      regionMode: () => (type.module === 'fp' ? 'tf' : 'accessibility'),
    });
  }
  return kind;
}

/** The refs whose per-read states Filter, Sort and Cluster read for hub selection entries. */
export function selectionRefs(selected: HubSelected[]): FeatureRef[] {
  const out: FeatureRef[] = [];
  for (const h of selected) {
    if (h.legacyRefs?.length) { out.push(...h.legacyRefs); continue; }
    // One ref per hub hit: the scan provider reads every bound dataset's states from it (no dataset fan-out).
    const kind = kindOfType(h.typeId);
    out.push({ kind, source: h.setId, id: h.hitId, chrom: h.chrom, start: h.start, end: h.end, label: h.label } as FeatureRef);
  }
  return out;
}

export function hitSelectionEntry(set: FeatureSet, hit: FeatureHit): HubSelected {
  // Per-read states: scan sets declaring 'state' (read from the scan), and legacy sets whose refs a states provider
  // answers (Find classes, NFR runs). Kinds with their own actions (SVs) have none here.
  const legacy = hit.legacyRefs ?? [];
  const hasStates = set.type.provides.includes('state') && (legacy.length
    ? legacy.every(r => !featureKindDef(r.kind)?.actions) : set.source.kind === 'scan' || set.setId.startsWith('hub:'));
  return { setId: set.setId, hitId: hit.hitId, typeId: hit.typeId, chrom: hit.chrom, start: hit.start, end: hit.end, hasStates,
    anchor: hit.anchor, ...(hit.strand ? { strand: hit.strand } : {}), ...(hit.label ? { label: hit.label } : {}),
    datasets: set.datasets, ...(hit.frame && hit.frame.kind !== 'linear' ? { frame: hit.frame } : {}),
    ...(hit.legacyRefs?.length ? { legacyRefs: hit.legacyRefs } : {}),
    ...(hit.target ? { target: hit.target } : {}), ...(hit.lift ? { lift: hit.lift.status } : {}), ...(hit.graph ? { graph: hit.graph } : {}),
    ...(hit.frame?.kind === 'source' && hit.strand ? { targetStrand: hit.lift?.flipped ? (hit.strand === '+' ? '-' : '+') : hit.strand } : {}) };
}
