/**
 * The feature hub's session state (store extension `featureHub`, DESIGN §5.6): the scans it opened (by path, with
 * the manifest digest), its list settings, saved anchor sets and the hub selection. Hub refs (scan hits) live only
 * here, never in the legacy `selectedFeatures` (sessions from this build still open in 3.0.x, which ignores this
 * key). Browser providers (Find classes runs, NFR runs, SVs, peaks, Differences) register here and feed sets.
 */
import { registerStoreExtension } from '../../stores/storeExtensions';
import type { BrowserState } from '../../stores/browserStore';
import { featureKindDef, normalizeFeatureRefs, registerFeatureKind, type FeatureRef } from '../../stores/featureStore';
import type { AnchorSet, FeatureHit, FeatureSet, FeatureTypeDecl, Frame } from './types';
import { kindOfType } from './kinds';

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
}

export interface FeatureHubState {
  scans: HubOpenedScan[];
  ui: HubUi;
  anchors: AnchorSet[];
  selected: HubSelected[];
}

export const DEFAULT_HUB_UI: HubUi = { hiddenSets: [], typeFilter: '', minPrevalence: null, sort: { key: 'locus', dir: 'asc' }, compare: null };
export const EMPTY_HUB: FeatureHubState = { scans: [], ui: DEFAULT_HUB_UI, anchors: [], selected: [] };

declare module '../../stores/browserStore' {
  interface BrowserState {
    featureHub: FeatureHubState;
    setFeatureHub: (patch: Partial<FeatureHubState> | ((hub: FeatureHubState) => Partial<FeatureHubState>)) => void;
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

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
        ...(q.frame && typeof q.frame === 'object' && typeof (q.frame as { kind?: unknown }).kind === 'string' ? { frame: q.frame as Frame } : {}) }];
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
      ...(Array.isArray(h.legacyRefs) ? { legacyRefs: normalizeFeatureRefs(h.legacyRefs) } : {}) }];
  });
  return { scans, ui, anchors, selected };
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
    ...(hit.legacyRefs?.length ? { legacyRefs: hit.legacyRefs } : {}) };
}
