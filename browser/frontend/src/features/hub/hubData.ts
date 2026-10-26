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
import type { FeatureHit, FeatureSet, HitValue } from './types';

interface HubDataStore {
  scans: ScanInfo[];
  /** Session scans whose directory could not be opened: path -> why. */
  missing: Record<string, string>;
  error: string;
  /** set id -> hits in the view the key names. */
  hits: Record<string, { key: string; hits: FeatureHit[]; truncated: boolean; error?: string }>;
  loadingHits: boolean;
  setScans: (scans: ScanInfo[]) => void;
}

export const useHubData = create<HubDataStore>(set => ({
  scans: [], missing: {}, error: '', hits: {}, loadingHits: false,
  setScans: scans => set({ scans }),
}));

const opened = (info: ScanInfo): HubOpenedScan => ({ path: info.path, scanId: info.scanId, manifestDigest: info.manifestDigest, label: info.label, source: info.source });

function rememberInSession(info: ScanInfo) {
  useBrowserStore.getState().setFeatureHub(hub => ({
    scans: [...hub.scans.filter(s => s.path !== info.path && s.scanId !== info.scanId), opened(info)],
  }));
}

/** Refresh the server's open scans; the browser-scan cache directories join the session's list. */
export async function refreshScans(): Promise<ScanInfo[]> {
  try {
    const { scans } = await listScans();
    useHubData.setState({ scans, error: '' });
    for (const s of scans) for (const set of s.sets) ensureHubKind(set.type);
    const known = new Set(useBrowserStore.getState().featureHub.scans.map(s => s.path));
    for (const s of scans) if (s.source === 'cache' && !known.has(s.path)) rememberInSession(s);
    return scans;
  } catch (e) {
    useHubData.setState({ error: String((e as Error).message ?? e) });
    return useHubData.getState().scans;
  }
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
/** Reopen the session's scans the server doesn't have open (after a session import or a restart). */
export async function restoreSessionScans(): Promise<void> {
  if (restoring) return;
  restoring = true;
  try {
    const server = await refreshScans();
    const open = new Set(server.map(s => s.path));
    const missing: Record<string, string> = { ...useHubData.getState().missing };
    for (const s of useBrowserStore.getState().featureHub.scans) {
      if (open.has(s.path)) { delete missing[s.path]; continue; }
      try {
        const info = await apiOpen(s.path);
        delete missing[s.path];
        if (s.manifestDigest && info.manifestDigest !== s.manifestDigest) missing[s.path] = 'the scan changed since the session was saved: its hits may differ';
      } catch (e) {
        missing[s.path] = String((e as Error).message ?? e).replace(/^API error \d+: /, '');
      }
    }
    useHubData.setState({ missing });
    await refreshScans();
    void refreshDatasetLayers();
  } finally {
    restoring = false;
  }
}

/** The column key of a scan set's group: its bound browser dataset, else the scan's own dataset id. */
export function scanColumnKey(set: ScanSetInfo, scanDataset: string, scanId: string): string {
  if (scanDataset === 'all') return 'all';
  const g = set.groups.find(x => x.scanDataset === scanDataset || x.id === scanDataset);
  return g?.datasetId ? dsKey(g.datasetId) : `scan:${scanId}:${scanDataset}`;
}

export function scanHitToFeature(set: ScanSetInfo, scanId: string, h: ScanHit): FeatureHit {
  const values: Record<string, Record<string, HitValue>> = {};
  for (const [col, roles] of Object.entries(h.columns ?? {})) {
    const key = scanColumnKey(set, col, scanId);
    values[key] = { ...(roles.prevalence ? { prevalence: roles.prevalence } : {}), ...(roles.strength ? { strength: roles.strength } : {}) };
  }
  const all = h.columns?.all ?? {};
  return {
    hitId: h.hitId, setId: set.setId, typeId: h.typeId, frame: set.frame, chrom: h.chrom, start: h.start, end: h.end, anchor: h.anchor,
    ...(h.strand ? { strand: h.strand } : {}), label: h.label,
    scores: { prevalence: all.prevalence?.v ?? null, strength: all.strength?.v ?? null, score: h.score },
    values, flags: h.flags, detail: { module: h.module, raw: h.raw, unitId: h.unitId, parentId: h.parentId },
  };
}

/** Scan sets of the open scans, as hub feature sets (their hits in view come from useHubData.hits). */
export function scanSets(scans: ScanInfo[]): Array<FeatureSet & { scan: ScanInfo; info: ScanSetInfo }> {
  // Groups keyed like the hits' values: the bound browser dataset's column, else the scan's own dataset.
  return scans.flatMap(scan => scan.sets.map(set => ({ ...(set as unknown as FeatureSet), scan, info: set,
    groups: set.groups.map(g => ({ ...g, id: g.id === 'all' ? 'all' : scanColumnKey(set, g.scanDataset ?? g.id, scan.scanId) })) })));
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
      jobs.push(scanHits(scan.scanId, module, view.chrom, view.start, view.end, undefined, controller.signal).then(res => {
        for (const set of sets) {
          next[set.setId] = { key, truncated: res.truncated,
            hits: res.hits.filter(h => h.typeId === set.typeId).map(h => scanHitToFeature(set, scan.scanId, h)) };
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
  const state = useBrowserStore(useShallow(s => ({ peaksByRule: s.peaksByRule, peakRules: s.peakRules, datasets: s.datasets })));
  useEffect(() => {
    const bump = () => setVersion(v => v + 1);
    const subs = hubProviders().flatMap(p => (p.subscribe ? [p.subscribe(bump)] : []));
    const off = onHubProvidersChanged(bump);
    return () => { subs.forEach(u => u()); off(); };
  }, []);
  return useMemo(() => {
    const s = useBrowserStore.getState();
    return hubProviders().flatMap(p => { try { return p.sets(s, view); } catch { return []; } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, view.chrom, view.start, view.end, state]);
}
