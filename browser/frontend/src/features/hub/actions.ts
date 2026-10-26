/**
 * The hub's "Use as" actions (DESIGN §6.2) on the hub selection:
 * - anchors: an anchor set (positions, strand, label) saved with the session (association, overlays, sync windows);
 * - cluster regions: the hits in view as the Cluster button's peak regions (each on its kind's layer), then Cluster;
 * - filter: keep the reads in state 1 at any (or every) chosen hit, through /api/features/states (source
 *   'feature-hub' in the filter chip);
 * - go to: the view centred on the hits.
 */
import { useBrowserStore } from '../../stores/browserStore';
import { featureRegionMode, type FeatureRef } from '../../stores/featureStore';
import { filterBySelectedFeatures, type FeatureFilterMode } from '../../utils/featureClustering';
import { runUiCluster } from '../../utils/clusterRunner';
import { sameChrom } from '../../utils/chromAliases';
import { selectionRefs, type HubSelected } from './hubState';
import { kindOfType } from './kinds';
import type { AnchorSet, Frame } from './types';
import { clusterBasis } from '../../utils/clusterTargets';

const ZERO_WIDTH_PAD = 25;

export function newAnchorSet(selected: HubSelected[], label?: string): AnchorSet {
  const anchors = selected.map(h => ({ chrom: h.chrom, pos: h.anchor, ...(h.strand ? { strand: h.strand } : {}),
    ...(h.label ? { label: h.label } : {}), hitId: h.hitId, start: h.start, end: h.end, ...(h.frame ? { frame: h.frame } : {}) }));
  const types = [...new Set(selected.map(h => h.typeId))];
  return {
    id: `anchors-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    label: label || `${anchors.length} ${types.join(' + ')} anchor${anchors.length === 1 ? '' : 's'}`,
    sources: [...new Set(selected.map(h => h.setId))], createdAt: new Date().toISOString(), anchors,
  };
}

/** Save the selection as an anchor set (an undo step; saved with the session). */
export function asAnchors(selected: HubSelected[], label?: string): string | null {
  if (!selected.length) return 'Select hits first (click a row; shift-click adds).';
  const set = newAnchorSet(selected, label);
  const store = useBrowserStore.getState();
  store.setFeatureHub(hub => ({ anchors: [...hub.anchors, set] }));
  store.pushSnapshot(`Anchors: ${set.label}`);
  return null;
}

/** The selection's intervals in the main view, as peak regions (zero-width hits get a small window). */
/** Hits in this genome's coordinates (a scan of another assembly lists its hits there until they are lifted, G1). */
export const onThisGenome = (h: { frame?: Frame }) => !h.frame || h.frame.kind === 'linear' || h.frame.kind === 'lifted';

export function clusterRegionsOf(selected: HubSelected[]): { start: number; end: number; mode: string; label?: string }[] {
  const s = useBrowserStore.getState();
  const out = [];
  for (const h of selected) {
    if (!onThisGenome(h) || !sameChrom(h.chrom, s.chrom) || h.end < s.start || h.start > s.end) continue;
    const start = h.end > h.start ? h.start : h.start - ZERO_WIDTH_PAD;
    const end = h.end > h.start ? h.end : h.start + ZERO_WIDTH_PAD;
    const ref = { kind: kindOfType(h.typeId), source: h.setId, id: h.hitId } as FeatureRef;
    const ds = h.datasets?.[0];
    const layers = (s.datasets.find(d => d.id === ds)?.available_layers ?? {}) as Record<string, unknown>;
    const mode = featureRegionMode(ref, layers) ?? 'accessibility';
    out.push({ start: Math.max(0, Math.floor(start)), end: Math.ceil(end), mode, label: h.label });
  }
  return out;
}

/**
 * The selection's hits in view become the Cluster button's peak regions (custom peaks, each on its kind's layer),
 * then Cluster runs as the button does. Returns an error message, or null.
 */
export async function asClusterRegions(selected: HubSelected[], run = true): Promise<string | null> {
  const regions = clusterRegionsOf(selected);
  if (!regions.length) {
    if (selected.length && !selected.some(onThisGenome)) return 'These hits are in another assembly\'s coordinates: lifting them onto this genome comes later.';
    return selected.length ? 'None of the selected hits is in the main view: go to them first.' : 'Select hits first.';
  }
  const store = useBrowserStore.getState();
  // Cluster's own precedence (utils/clusterTargets.clusterBasis): selected features and an active cluster rule win
  // over selected peaks, so both make way for the hub's regions.
  if (store.selectedFeatures.length) store.setSelectedFeatures([]);
  if (typeof store.clusterPeakMode === 'string' && store.clusterPeakMode.startsWith('cluster_rule:')) {
    useBrowserStore.setState({ clusterPeakMode: 'accessibility' as typeof store.clusterPeakMode });
  }
  for (const r of regions) store.addCustomPeak(r.start, r.end, store.chrom);
  const now = useBrowserStore.getState();
  const custom = now.getCustomRuleId();
  // The main reference's custom peaks only (a panel on another genome can hold a peak with the same span).
  const peaks = now.getAllPeaks().filter(p => p.ruleId === custom && !p.genome && sameChrom(p.chrom ?? now.chrom, now.chrom));
  const selectedPeaks = new Set<number>();
  const peakModes: Record<number, string> = {};
  for (const r of regions) {
    const p = peaks.find(x => x.start === r.start && x.end === r.end);
    if (!p) continue;
    selectedPeaks.add(p.index);
    if (r.mode !== 'accessibility') peakModes[p.index] = r.mode;
  }
  useBrowserStore.setState({ selectedPeaks, peakModes: peakModes as typeof now.peakModes });
  const basis = clusterBasis(useBrowserStore.getState());
  if (basis.kind !== 'peaks') return `Cluster would use ${basis.what}, not the hub's regions: clear it first.`;
  const want = regions.map(r => `${r.start}-${r.end}-${r.mode}`).sort().join(',');
  const got = basis.regions.filter(r => !r.genome).map(r => `${r.start}-${r.end}-${r.mode}`).sort().join(',');
  if (want !== got || basis.regions.some(r => r.genome)) return 'Cluster\'s regions are not the hub\'s: check the selected peaks.';
  useBrowserStore.getState().pushSnapshot(`Cluster regions from the feature hub (${regions.length})`);
  if (!run) return null;
  const ran = await runUiCluster();
  if (!ran) return 'Open a read panel to cluster.';
  const assigned = Object.values(useBrowserStore.getState().clusterAssignments ?? {}).some(m => m && Object.keys(m).length > 0);
  if (!assigned) {
    const lo = Math.min(...regions.map(r => r.start)), hi = Math.max(...regions.map(r => r.end));
    return `Cluster ran, but no read covers all ${regions.length} regions (${((hi - lo) / 1000).toFixed(1)} kb apart): `
      + 'Cluster uses the reads that span every region, so select hits closer together.';
  }
  return null;
}

/** Keep the reads in state 1 at the selected hits (any or all of them) in the target panels. */
export async function asFilter(selected: HubSelected[], mode: FeatureFilterMode = 'any'): Promise<string | null> {
  if (!selected.length) return 'Select hits first.';
  const refs = selectionRefs(selected);
  const names = selected.map(h => h.label || h.hitId).slice(0, 4).join(', ') + (selected.length > 4 ? '…' : '');
  return filterBySelectedFeatures(mode, { features: refs, target: 'feature-hub',
    label: `Feature hub > ${mode === 'all' ? 'in every' : mode === 'none' ? 'in none of' : 'in any of'} ${names}` });
}

/** Centre the main view on hits (the view's width, or their span with a margin). */
export function goToHits(all: Array<{ chrom: string; start: number; end: number; frame?: Frame }>): string | null {
  const selected = all.filter(onThisGenome);
  if (!selected.length) return all.length ? 'These hits are in another assembly\'s coordinates: lifting them onto this genome comes later.' : null;
  const s = useBrowserStore.getState();
  const chrom = selected[0].chrom;
  const same = selected.filter(h => sameChrom(h.chrom, chrom));
  const lo = Math.min(...same.map(h => h.start));
  const hi = Math.max(...same.map(h => Math.max(h.end, h.start + 1)));
  const width = Math.max(s.end - s.start, Math.ceil((hi - lo) * 1.2), 2_000);
  const start = Math.max(0, Math.round((lo + hi) / 2 - width / 2));
  s.setViewport(chrom, start, start + width);
  return null;
}
