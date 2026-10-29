import { featureKey } from '../../stores/featureStore';
import { refreshLegacyRuns } from './legacyRuns';
/**
 * The hub's live data (transient): the scans open on the server, their hits in view, and the browser providers'
 * sets. The session keeps only what to reopen (featureHub.scans); this store is rebuilt from it.
 */
import { create } from 'zustand';
import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { closeScan as apiClose, listScans, openScan as apiOpen, scanHits, type ScanHit, type ScanInfo, type ScanSetInfo } from './api';
import { ensureHubKind, hubProviders, onHubProvidersChanged, type HubOpenedScan, type HubView } from './hubState';
import { dsKey } from './providers';
import type { FeatureHit, FeatureSet, GroupDecl, HitValue } from './types';

interface HubDataStore {
  scans: ScanInfo[];
  /** Session scans whose directory could not be opened: path -> why. */
  missing: Record<string, string>;
  error: string;
  /** set id -> hits in the view the key names. */
  hits: Record<string, { key: string; hits: FeatureHit[]; truncated: boolean; error?: string; groups?: GroupDecl[];
    /** Why a source-frame set's hits can't all be placed here, or why graph columns are missing. */
    note?: string }>;
  loadingHits: boolean;
  setScans: (scans: ScanInfo[]) => void;
}

export const useHubData = create<HubDataStore>(set => ({
  scans: [], missing: {}, error: '', hits: {}, loadingHits: false,
  setScans: scans => set({ scans }),
}));

/**
 * The hub's session generation: a session import moves it on (resetHubData), and work started for an older one
 * (restoring, adopting a live scan's results) stops at its next step without writing anything.
 */
let generation = 0;
const current = (born: number) => born === generation;

const opened = (info: ScanInfo): HubOpenedScan => ({ path: info.path, scanId: info.scanId, manifestDigest: info.manifestDigest, label: info.label, source: info.source });

function rememberInSession(info: ScanInfo) {
  useBrowserStore.getState().setFeatureHub(hub => ({
    scans: [...hub.scans.filter(s => s.path !== info.path && s.scanId !== info.scanId), opened(info)],
  }));
}

/**
 * Refresh the server's open scans. The hub shows the scans this session lists (featureHub.scans): a scan the server
 * has open for another reason (a session imported before) never joins it on its own.
 */
export async function refreshScans(): Promise<ScanInfo[]> {
  try {
    const { scans } = await listScans();
    const listed = new Set(useBrowserStore.getState().featureHub.scans.map(s => s.path));
    const mine = scans.filter(s => listed.has(s.path));
    useHubData.setState({ scans: mine, error: '' });
    for (const s of mine) for (const set of s.sets) ensureHubKind(set.type);
    return scans;
  } catch (e) {
    useHubData.setState({ error: String((e as Error).message ?? e) });
    return useHubData.getState().scans;
  }
}

/** A live scan of this session finished: its cache directories join the session (then the list). */
export async function adoptScans(scanIds: string[], born = generation): Promise<void> {
  if (!scanIds.length || !current(born)) return;
  try {
    const { scans } = await listScans();
    if (!current(born)) return;
    for (const s of scans) if (scanIds.includes(s.scanId)) rememberInSession(s);
  } catch { /* the next refresh shows them once listed */ }
  if (current(born)) await refreshScans();
}

export const hubGeneration = () => generation;

/** A session is being imported: the hub's live data belong to the previous one. */
export function resetHubData(): void {
  generation += 1;
  hitsController?.abort();
  useHubData.setState({ scans: [], missing: {}, error: '', hits: {}, loadingHits: false });
}

/** Open a scan directory (Open scan…): binds it to the loaded datasets and lists its sets. */
export async function openScanPath(path: string): Promise<ScanInfo> {
  const info = await apiOpen(path);
  rememberInSession(info);
  useHubData.setState(state => {
    const missing = { ...state.missing };
    delete missing[path];
    return { missing };
  });
  await refreshScans();
  // Bound datasets got the scan's layers (tables-mode overlay): refresh their layer lists.
  void refreshDatasetLayers();
  return info;
}

export async function closeScanId(scanId: string): Promise<void> {
  await apiClose(scanId).catch(() => undefined);
  useBrowserStore.getState().setFeatureHub(hub => ({ scans: hub.scans.filter(s => s.scanId !== scanId),
    selected: hub.selected.filter(h => !useHubData.getState().scans.find(s => s.scanId === scanId)?.sets.some(set => set.setId === h.setId)) }));
  await refreshScans();
  void refreshDatasetLayers();
}

/** The datasets' layer lists from the server (a scan overlay adds or removes layers). */
export async function refreshDatasetLayers(): Promise<void> {
  try {
    const { getDatasets } = await import('../../api/datasets');
    const res = await getDatasets();
    const byId = new Map((res.datasets ?? []).map(d => [d.id, d]));
    useBrowserStore.setState(s => ({
      datasets: s.datasets.map(d => {
        const server = byId.get(d.id);
        return server ? { ...d, available_layers: server.available_layers, derived_layers: server.derived_layers } as typeof d : d;
      }),
    }));
  } catch { /* layer lists refresh on the next dataset load */ }
}

let restoring = false;
let again = false;
/**
 * Reopen the session's scans the server doesn't have open (after a session import or a restart). A call while one
 * runs (another session imported meanwhile) runs again when it ends, on the session's list as it is then.
 */
export async function restoreSessionScans(): Promise<void> {
  if (restoring) { again = true; return; }
  restoring = true;
  try {
    do {
      again = false;
      await restoreOnce();
    } while (again);
  } finally {
    restoring = false;
  }
}

async function restoreOnce(): Promise<void> {
  {
    const born = generation;
    let serverGeneration: number | undefined;
    try { serverGeneration = (await listScans()).generation; } catch { /* an older server: no generation */ }
    if (!current(born)) return;
    const server = await refreshScans();
    if (!current(born)) return;
    const open = new Set(server.map(s => s.path));   // every scan the server has open (refreshScans returns all)
    const missing: Record<string, string> = { ...useHubData.getState().missing };
    for (const s of useBrowserStore.getState().featureHub.scans) {
      if (!current(born)) return;   // another session was imported meanwhile: its own restore runs
      if (open.has(s.path)) { delete missing[s.path]; continue; }
      try {
        const info = await apiOpen(s.path, serverGeneration);
        delete missing[s.path];
        if (s.manifestDigest && info.manifestDigest !== s.manifestDigest) missing[s.path] = 'the scan changed since the session was saved: its hits may differ';
      } catch (e) {
        missing[s.path] = String((e as Error).message ?? e).replace(/^API error \d+: /, '');
      }
    }
    if (!current(born)) return;
    // Scans of a session imported meanwhile are what count: forget notes about paths it no longer lists.
    const listed = new Set(useBrowserStore.getState().featureHub.scans.map(s => s.path));
    for (const path of Object.keys(missing)) if (!listed.has(path)) delete missing[path];
    useHubData.setState({ missing });
    await refreshScans();
    void refreshDatasetLayers();
  }
}

/** The column key of a scan set's group: its bound browser dataset, else the scan's own dataset id. */
export function scanColumnKey(set: ScanSetInfo, scanDataset: string, scanId: string): string {
  if (scanDataset === 'all') return 'all';
  const g = set.groups.find(x => x.scanDataset === scanDataset || x.id === scanDataset);
  if (g) return groupKey(set, g, scanId);
  // A dataset's haplotype group ('dataset_1:HP1', nuc patches): its dataset's column with the haplotype.
  const cut = scanDataset.lastIndexOf(':');
  const base = cut > 0 ? set.groups.find(x => x.scanDataset === scanDataset.slice(0, cut)) : undefined;
  if (base) return `${groupKey(set, base, scanId)}:${scanDataset.slice(cut + 1)}`;
  return `scan:${scanId}:${scanDataset}`;
}

/** A scan group's column: its bound dataset's (with the scan dataset when several bind to one loaded dataset). */
function groupKey(set: ScanSetInfo, g: ScanSetInfo['groups'][number], scanId: string): string {
  if (!g.datasetId) return `scan:${scanId}:${g.scanDataset ?? g.id}`;
  const shared = set.groups.filter(x => x.datasetId === g.datasetId).length > 1;
  return shared ? `${dsKey(g.datasetId)}#${g.scanDataset ?? g.id}` : dsKey(g.datasetId);
}

/** Column decls for the scan groups a set's hits carry beyond its datasets (haplotype groups). */
export function extraScanGroups(set: ScanSetInfo, scanId: string, hits: ScanHit[]): GroupDecl[] {
  const out = new Map<string, GroupDecl>();
  for (const h of hits) {
    for (const col of Object.keys(h.columns ?? {})) {
      if (col === 'all' || set.groups.some(g => g.scanDataset === col || g.id === col)) continue;
      const key = scanColumnKey(set, col, scanId);
      if (out.has(key)) continue;
      const cut = col.lastIndexOf(':');
      const base = cut > 0 ? set.groups.find(g => g.scanDataset === col.slice(0, cut)) : undefined;
      out.set(key, { id: key, datasetId: base?.datasetId, kind: 'haplotype', label: base ? `${base.label} ${col.slice(cut + 1)}` : col,
        ...(cut > 0 ? { hap: col.slice(cut + 1) } : {}) });
    }
  }
  return [...out.values()];
}

export function scanHitToFeature(set: ScanSetInfo, scanId: string, h: ScanHit): FeatureHit {
  const values: Record<string, Record<string, HitValue>> = {};
  for (const [col, roles] of Object.entries(h.columns ?? {})) {
    const key = scanColumnKey(set, col, scanId);
    values[key] = { ...(roles.prevalence ? { prevalence: roles.prevalence } : {}), ...(roles.strength ? { strength: roles.strength } : {}) };
  }
  const all = h.columns?.all ?? {};
  // A source-frame hit (G1): its own frame (contig, haplotype), its lift and where it is drawn on this genome.
  const frame: FeatureHit['frame'] = h.frame
    ? { kind: 'source', assembly: (set.frame as { assembly?: string }).assembly ?? '', contig: h.frame.contig,
        ...(h.frame.hap ? { hap: h.frame.hap } : {}), ...(h.frame.hapLabel ? { hapLabel: h.frame.hapLabel } : {}), datasetId: h.frame.datasetId }
    : set.frame;
  return {
    hitId: h.hitId, setId: set.setId, typeId: h.typeId, frame, chrom: h.chrom, start: h.start, end: h.end, anchor: h.anchor,
    ...(h.strand ? { strand: h.strand } : {}), label: h.label,
    scores: { prevalence: all.prevalence?.v ?? null, strength: all.strength?.v ?? null, score: h.score },
    values, flags: h.flags, detail: { module: h.module, raw: h.raw, unitId: h.unitId, parentId: h.parentId },
    ...(h.source ? { source: h.source } : {}), ...(h.lift ? { lift: h.lift } : {}), ...(h.target ? { target: h.target } : {}),
    ...(h.graph ? { graph: h.graph } : {}),
  };
}

/** Scan sets of the open scans, as hub feature sets (their hits in view come from useHubData.hits). */
export function scanSets(scans: ScanInfo[]): Array<FeatureSet & { scan: ScanInfo; info: ScanSetInfo }> {
  // Groups keyed like the hits' values: the bound browser dataset's column, else the scan's own dataset.
  return scans.flatMap(scan => scan.sets.map(set => ({ ...(set as unknown as FeatureSet), scan, info: set,
    groups: set.groups.map(g => {
      if (g.id === 'all') return g;
      const id = scanColumnKey(set, g.scanDataset ?? g.id, scan.scanId);
      return { ...g, id, label: id.includes('#') ? `${g.label} · ${g.scanDataset ?? g.id}` : g.label };
    }) })));
}

let hitsController: AbortController | null = null;
/** Fetch the visible scan sets' hits for a view (one request per scan module). */
export async function loadScanHits(view: HubView, hidden: string[]): Promise<void> {
  hitsController?.abort();
  const controller = new AbortController();
  hitsController = controller;
  const key = `${view.chrom}:${view.start}-${view.end}`;
  const scans = useHubData.getState().scans;
  const jobs: Array<Promise<void>> = [];
  const next: HubDataStore['hits'] = {};
  useHubData.setState({ loadingHits: true });
  for (const scan of scans) {
    const byModule = new Map<string, ScanSetInfo[]>();
    for (const set of scan.sets) {
      if (hidden.includes(set.setId)) continue;
      const module = (set.source as { module?: string }).module ?? set.provenance.module;
      byModule.set(module, [...(byModule.get(module) ?? []), set]);
    }
    for (const [module, sets] of byModule) {
      jobs.push(scanHits(scan.scanId, module, view.chrom, view.start, view.end, undefined, controller.signal, true).then(res => {
        for (const set of sets) {
          const mine = res.hits.filter(h => h.typeId === set.typeId);
          next[set.setId] = { key, truncated: res.truncated, groups: extraScanGroups(set, scan.scanId, mine),
            hits: mine.map(h => scanHitToFeature(set, scan.scanId, h)),
            ...(res.note || res.graphNote ? { note: [res.note, res.graphNote].filter(Boolean).join('; ') } : {}) };
        }
      }).catch(e => {
        if (controller.signal.aborted) return;
        for (const set of sets) next[set.setId] = { key, hits: [], truncated: false, error: String((e as Error).message ?? e) };
      }));
    }
  }
  await Promise.all(jobs);
  if (controller.signal.aborted) return;
  useHubData.setState({ hits: next, loadingHits: false });
}

/** The browser providers' sets for a view, recomputed when their sources change. */
export function useProviderSets(view: HubView): FeatureSet[] {
  const [version, setVersion] = useState(0);
  const state = useBrowserStore(useShallow(s => ({ peaksByRule: s.peaksByRule, peakRules: s.peakRules, datasets: s.datasets, panels: s.panels, footprintGroups: s.footprintGroups, savedNfrVariants: s.savedNfrVariants, graphSelection: s.graphSelection })));
  useEffect(() => {
    void refreshLegacyRuns();
    const bump = () => setVersion(v => v + 1);
    const subs = hubProviders().flatMap(p => (p.subscribe ? [p.subscribe(() => {
      bump();
      if (p.id === 'find-classes' || p.id === 'nfr') void refreshLegacyRuns();
    })] : []));
    const off = onHubProvidersChanged(bump);
    return () => { subs.forEach(u => u()); off(); };
  }, []);
  return useMemo(() => {
    const s = useBrowserStore.getState();
    return mergeProviderSets(hubProviders().flatMap(p => { try { return p.sets(s, view); } catch { return []; } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, view.chrom, view.start, view.end, state]);
}

/** Merge facades, live panels and cart pins into one row per set/hit, retaining the richest live values. */
export function mergeProviderSets(sets: FeatureSet[]): FeatureSet[] {
  const merged = new Map<string, FeatureSet>();
  for (const incoming of sets) {
    const prior = merged.get(incoming.setId);
    if (!prior || prior.source.kind !== 'inline' || incoming.source.kind !== 'inline') {
      merged.set(incoming.setId, incoming); continue;
    }
    const hits = new Map(prior.source.hits.map(h => [h.hitId, h]));
    for (const h of incoming.source.hits) {
      const prev = hits.get(h.hitId);
      hits.set(h.hitId, prev ? { ...h, ...prev,
        flags: [...new Set([...(prev.flags ?? []), ...(h.flags ?? [])])],
        legacyRefs: [...new Map([...(prev.legacyRefs ?? []), ...(h.legacyRefs ?? [])].map(r => [featureKey(r), r])).values()],
        detail: { ...h.detail, ...prev.detail } } : h);
    }
    merged.set(incoming.setId, { ...prior, datasets: [...new Set([...prior.datasets, ...incoming.datasets])],
      groups: [...new Map([...prior.groups, ...incoming.groups].map(g => [g.id, g])).values()],
      count: hits.size, source: { kind: 'inline', hits: [...hits.values()] } });
  }
  return [...merged.values()];
}
