import { useSplitPanelStore } from '../../stores/splitPanelStore';
import { useReadActionsStore } from '../../stores/readActionsStore';
import { getFeatureStates } from '../../api/features';
import { addRegionsToCategory } from '../../stores/regionCatalogStore';
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
import { requestGuard, STALE, filterBySelectedFeatures, type FeatureFilterMode } from '../../utils/featureClustering';
import { runUiCluster } from '../../utils/clusterRunner';
import { seedHistoryBaseline } from '../../stores/historySlice';
import { mainGenomeKey } from '../../utils/regionNavigation';
import { sameChrom } from '../../utils/chromAliases';
import { selectionRefs, type HubSelected } from './hubState';
import { kindOfType } from './kinds';
import type { AnchorSet, Frame } from './types';
import { clusterBasis } from '../../utils/clusterTargets';
import { displaySpan, inThisGenome, regionOf, type Placeable } from './frames';

/** An anchor in this genome: a lifted hit is anchored where it lifted (or at its insertion's junction), keeping its
 * source coordinates and lift status; a hit that can't be placed here keeps its own frame and coordinates. */
function anchorOf(h: HubSelected): AnchorSet['anchors'][number] {
  const base = { ...(h.strand ? { strand: h.strand } : {}), ...(h.label ? { label: h.label } : {}), hitId: h.hitId };
  // graph carriage, kept so overlays and associations at these anchors count carriers only
  const paths = h.graph ? { paths: Object.fromEntries(Object.entries(h.graph.paths).map(([k, p]) =>
    [k, { status: p.status, ...(p.hap ? { hap: p.hap } : {}), datasets: p.datasets }])) } : {};
  const t = !inThisGenome(h) ? h.target : undefined;
  if (t) {
    return { chrom: t.chrom, pos: t.anchor, start: t.start, end: t.end, ...base,
      ...(h.frame ? { frame: h.frame } : {}), source: { chrom: h.chrom, start: h.start, end: h.end, anchor: h.anchor },
      ...(h.lift ? { lift: h.lift } : {}), ...(t.insertion ? { insertion: true } : {}),
      ...(h.targetStrand ? { targetStrand: h.targetStrand } : {}), ...paths };
  }
  return { chrom: h.chrom, pos: h.anchor, ...base, start: h.start, end: h.end, ...(h.frame ? { frame: h.frame } : {}), ...paths };
}

export function newAnchorSet(selected: HubSelected[], label?: string): AnchorSet {
  const anchors = selected.map(anchorOf);
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

/** Hits placed on this genome: in its coordinates, or lifted onto it (a source-frame hit that lifted, or sits at an
 * insertion's junction, G1). An unmapped hit of another assembly is not. */
export const onThisGenome = (h: Placeable | { frame?: Frame }) => ('chrom' in h ? displaySpan(h as Placeable) !== null : inThisGenome(h));

/** The selection's intervals in the main view, as peak regions (zero-width hits and insertion junctions get a small
 * window: in graph mode a region holding an insertion's junction clusters on the inserted columns). */
export function clusterRegionsOf(selected: HubSelected[]): { start: number; end: number; mode: string; label?: string }[] {
  const s = useBrowserStore.getState();
  const out = [];
  for (const h of selected) {
    const t = displaySpan(h);
    if (!t || !sameChrom(t.chrom, s.chrom) || t.end < s.start || t.start > s.end) continue;
    const { start, end } = regionOf(t);
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
    if (selected.length && !selected.some(onThisGenome)) return 'These hits are in another assembly and don\'t lift onto this genome.';
    return selected.length ? 'None of the selected hits is in the main view: go to them first.' : 'Select hits first.';
  }
  // One region per span (an NFR and its full-span variant, two insertions at one boundary): a layer mode wins over
  // plain accessibility.
  const bySpan = new Map<string, typeof regions[number]>();
  for (const r of regions) {
    const key = `${r.start}-${r.end}`;
    const prev = bySpan.get(key);
    if (!prev || (prev.mode === 'accessibility' && r.mode !== 'accessibility')) bySpan.set(key, r);
  }
  regions.splice(0, regions.length, ...bySpan.values());
  const store = useBrowserStore.getState();
  const customRule = store.peakRules.find(r => r.id === store.getCustomRuleId());
  if (!customRule || !customRule.enabled) return 'Turn on the Custom peak rule first: the hub\'s regions are custom peaks.';
  // Everything changed below goes back if Cluster wouldn't use the hub's regions.
  const before = { selectedFeatures: store.selectedFeatures, clusterPeakMode: store.clusterPeakMode, peaksByRule: store.peaksByRule,
    selectedPeaks: store.selectedPeaks, peakModes: store.peakModes };
  seedHistoryBaseline(store, 'Before cluster regions from the feature hub', 'analysis');
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
  const want = regions.map(r => `${r.start}-${r.end}-${r.mode}`).sort().join(',');
  const got = basis.regions.filter(r => !r.genome).map(r => `${r.start}-${r.end}-${r.mode}`).sort().join(',');
  if (basis.kind !== 'peaks' || want !== got || basis.regions.some(r => r.genome)) {
    useBrowserStore.setState(before);
    return basis.kind !== 'peaks' ? `Cluster would use ${basis.what}, not the hub's regions: clear it first.`
      : 'Cluster\'s regions would not be the hub\'s (a matched group overlaps them?): nothing was changed.';
  }
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
  // Only hits with per-read states (peaks, SVs and Differences have none here): the rest are left out, said so.
  const usable = selected.filter(h => h.hasStates);
  if (!usable.length) return 'None of the selected hits has per-read states (footprint classes and NFRs do).';
  const refs = selectionRefs(usable);
  if (refs.length > 16) return `${refs.length} hits: filter on 16 or fewer at a time.`;
  const names = usable.map(h => h.label || h.hitId).slice(0, 4).join(', ') + (usable.length > 4 ? '…' : '');
  const error = await filterBySelectedFeatures(mode, { features: refs, target: 'feature-hub',
    label: `Feature hub > ${mode === 'all' ? 'in every' : mode === 'none' ? 'in none of' : 'in any of'} ${names}` });
  if (error) return error;
  const left = selected.length - usable.length;
  return left ? `Filtered on ${usable.length} hit${usable.length === 1 ? '' : 's'}; ${left} without per-read states left out.` : null;
}

/** Centre the main view on hits (the view's width, or their span with a margin); lifted hits where they lifted. */
export function goToHits(all: Array<{ chrom: string; start: number; end: number; anchor?: number; frame?: Frame; target?: Placeable['target'] }>): string | null {
  const selected = all.flatMap(h => {
    const t = displaySpan({ anchor: h.start, ...h } as Placeable);
    return t ? [t] : [];
  });
  if (!selected.length) return all.length ? 'These hits are in another assembly and don\'t lift onto this genome.' : null;
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

/** State-pattern splits retain the descriptors needed to restore their states. */
export function asSplit(selected: HubSelected[]): string | null {
  if (!selected.length || selected.some(h => !h.hasStates)) return 'Every selected hit must have per-record states to split.';
  const features = selectionRefs(selected);
  if (features.length > 16) return 'Split on 16 or fewer hits at a time.';
  useSplitPanelStore.getState().request({ kind: 'patterns', features });
  return null;
}

export async function asHighlight(selected: HubSelected[]): Promise<string | null> {
  if (!selected.length) return 'Select hits first.';
  const withStates = selected.filter(h => h.hasStates);
  if (withStates.length) {
    if (selectionRefs(withStates).length > 16) return 'Highlight on 16 or fewer hits at a time.';
    const current = requestGuard('hub-highlight');
    const result = await getFeatureStates(selectionRefs(withStates));
    if (!current()) return STALE;
    const scopedRows: Record<string, Set<string>> = {};
    for (const [dataset, reads] of Object.entries(result.by_dataset)) scopedRows[dataset] = new Set(Object.entries(reads).filter(([, pattern]) => pattern.includes('1')).map(([id]) => id));
    useReadActionsStore.getState().highlightReads([...new Set(Object.values(scopedRows).flatMap(ids => [...ids]))], { scopedRows });
  }
  const s = useBrowserStore.getState();
  const regions = selected.flatMap(h => {
    const t = displaySpan(h);
    return t ? [{ chrom: t.chrom, start: t.start, end: Math.max(t.end, t.start + 1), label: h.label, genome: mainGenomeKey(s) }] : [];
  });
  s.addHighlights(regions);
  return regions.length || withStates.length ? null : 'These hits have no placement on this reference.';
}

export function asRegionCatalog(selected: HubSelected[], category = 'Feature hub'): string | null {
  const s = useBrowserStore.getState();
  const regions = selected.flatMap(h => {
    const t = displaySpan(h);
    return t ? [{ chrom: t.chrom, start: t.start, end: Math.max(t.end, t.start + 1), label: h.label || h.typeId,
      source: 'saved' as const, ...(h.strand ? { strand: h.targetStrand ?? h.strand } : {}),
      detail: `${h.typeId} · ${h.hitId}${t.end === t.start ? ' · insertion boundary (BED display width 1)' : ''}` }] : [];
  });
  if (!regions.length) return 'These hits have no placement on this reference.';
  addRegionsToCategory(mainGenomeKey(s), category, regions);
  return null;
}

const cell = (v: unknown) => String(v ?? '').replace(/[\t\r\n]/g, ' ');
export function hitExportText(selected: HubSelected[], format: 'bed' | 'values'): string {
  const provenance = [...new Map(selected.filter(h => h.provenance).map(h => [h.setId, h.provenance!])).values()];
  const header = '# Feature hub; coordinates=0-based-half-open\n# provenance=' + JSON.stringify(provenance) + '\n';
  if (format === 'bed') return header + selected.map(h => [h.chrom, h.start, h.end, h.label || h.hitId,
    Math.round(Math.max(0, Math.min(1000, (h.scores?.prevalence ?? 0) * 1000))), h.strand ?? '.'].map(cell).join('\t')).join('\n') + '\n';
  return header + 'set_id\thit_id\ttype\tchrom\tstart\tend\tframe\tgroup\tscore\tvalue\tlo\thi\tn\tn_callable\n' + selected.flatMap(h => {
    const groups: NonNullable<import('./types').FeatureHit['values']> = h.values && Object.keys(h.values).length ? h.values : { all: Object.fromEntries(Object.entries(h.scores ?? {}).map(([k, v]) => [k, { v }])) };
    return Object.entries(groups).flatMap(([group, scores]) => Object.entries(scores).map(([score, v]) =>
      [h.setId, h.hitId, h.typeId, h.chrom, h.start, h.end, h.frame?.kind ?? 'linear', group, score, v.v, v.lo, v.hi, v.n, v.nCallable].map(cell).join('\t')));
  }).join('\n') + '\n';
}
export function exportHits(selected: HubSelected[], format: 'bed' | 'values'): void {
  const url = URL.createObjectURL(new Blob([hitExportText(selected, format)], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = format === 'bed' ? 'hub-hits.bed' : 'hub-values.tsv'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** A conditioning variable over exactly the chosen hits, including selections on earlier pages. */
export function conditioningSet(selected: HubSelected[]): import('./types').FeatureSet | null {
  if (!selected.length) return null;
  const setId = 'browser:hub-conditioning';
  const stateful = selected.every(h => h.hasStates);
  return { setId, typeId: 'hub.conditioning', type: { typeId: 'hub.conditioning', module: 'browser', label: 'Selected hits',
    plural: 'Selected hits', provides: stateful ? ['hit', 'state'] : ['hit'], anchor: 'start', zeroWidth: true, scores: [] },
    frame: { kind: 'linear', chrom: selected[0].chrom }, datasets: [...new Set(selected.flatMap(h => h.datasets ?? []))], groups: [],
    coverage: { territory: 'regions' }, count: selected.length, status: 'complete',
    source: { kind: 'inline', hits: selected.map(h => ({ ...h, lift: h.lift ? { status: h.lift } : undefined, frame: h.frame ?? { kind: 'linear', chrom: h.chrom },
      scores: h.scores ?? {}, detail: { hubSelection: h } })) },
    provenance: { producer: 'browser', module: 'selection', inputs: [...new Set(selected.map(h => h.setId))], units: 'regions' } };
}
