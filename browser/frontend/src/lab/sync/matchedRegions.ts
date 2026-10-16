import { runMatchedRegions, executeRegionWindows } from '../../utils/equivalentClustering';
export { runMatchedRegions } from '../../utils/equivalentClustering';
import { openRegionPanels } from '../../utils/regionPanels';
import { removeMatchedGroups } from '../../utils/matchedGroupActions';
import { useSyncSettings } from './settings';
import type { FirePeak } from '../../types';
import { registerRegionAnalysis } from '../../utils/regionAnalysis';
import { alignWindowPeaks } from '../../utils/locusPeaks';
import { sameChrom } from '../../utils/chromAliases';
import { useBrowserStore } from '../../stores/browserStore';
import { useEphemeralStore } from '../../stores/ephemeralStore';
import { seedHistoryBaseline } from '../../stores/historySlice';
import { extendTrackMenu } from '../../components/tracks/trackRegistry';
import { rigidMatchedRegions } from '../../utils/matchedRegions';
import { registerClusterBasisRunner, registerClusterPlanTransform } from '../../utils/clusterRunExtensions';
import { clusterWindows, matchedClusterWindows, type ClusterBasis, type RegionClusterWindow, type PlanState } from '../../utils/clusterTargets';
import { getTargetDatasetIds, type BrowserState } from '../../stores/browserStore';
import { fetchJson } from '../../api/sharedFetch';
import { setRunResult } from '../../stores/runResultStore';

export function linkSelectedRegions() {
  const s = useBrowserStore.getState();
  let peaks = Object.values(s.peaksByRule).flat().filter(p => s.selectedPeaks.has(p.index));
  if (peaks.length < 2) return;
  seedHistoryBaseline(s, 'Before linking regions', 'analysis');
  const groupIds = [...new Set(peaks.flatMap(p => p.match ? [p.match.groupId] : []))];
  const existing = groupIds.length === 1 && peaks.some(p => !p.match) ? s.peakRules.find(r => r.id === groupIds[0]) : undefined;
  if (existing && peaks.some(p => p.match && (p.match.blocks.length !== 1 || p.match.wrapsOrigin))) {
    setRunResult('cluster', { tone:'error', text:'This group has gaps. Link new rigid regions as a separate group.' });
    return;
  }
  if (existing) {
    const members = s.peaksByRule[existing.id] ?? [];
    const additions = peaks.filter(p => !p.match && !members.some(m => {
      const source = m.match?.sourceRegion ?? m;
      return (source.chrom ?? s.chrom) === (p.chrom ?? s.chrom) && (source.genome ?? null) === (p.genome ?? null)
        && source.start === p.start && source.end === p.end;
    }));
    peaks = [...members, ...additions];
  }
  const labels = new Set(peaks.flatMap(p=>p.match?[p.match.label]:[]));
  const regions = rigidMatchedRegions(peaks, s.chrom).map((p,i)=>{
    let label=existing?peaks[i].match?.label:undefined;
    if (!label) { let n=i+1; while(labels.has(`W${n}`))n++; label=`W${n}`; labels.add(label); }
    return { ...p, match:{ ...p.match!, reversed:peaks[i].match?.reversed??false, label,
      ...(peaks[i].match?.copy?{copy:peaks[i].match!.copy}:{}) } };
  });
  const id = s.upsertMatchedGroup({ id:existing?.id, name:existing?.name??`Matched ${s.peakRules.filter(r => r.source === 'matched').length + 1}`,
    color:existing?.color, regions, matchGroup: { origin: 'manual' } });
  s.selectMatchedGroup(id);
  s.pushSnapshot('Link as matched');
  setRunResult('cluster', { tone: 'note', text: `Linked ${peaks.length} regions, cropped to ${regions[0].match!.length} bp.` });
  return id;
}

/** The analysis owns entry points; core only knows region geometry and display. */
export function registerMatchedRegions() {
  registerRegionAnalysis({
    recover: sharedBlockRecovery,
    run: request => fetchJson('/api/lab/region-classes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) }),
    link: range => {
      const s = useBrowserStore.getState();
      if(s.getAllPeaks().some(p=>p.match&&s.selectedPeaks.has(p.index)&&p.chrom===range.chrom&&p.start===range.start&&p.end===range.end&&(p.genome??null)===range.genome)) {
        setRunResult('cluster',{tone:'note',text:'This region is already in the selected group.'}); return;
      }
      s.addCustomPeak(range.start, range.end, range.chrom, range.genome);
      const now = useBrowserStore.getState();
      const added = now.getAllPeaks().find(p => p.isCustom && p.start === range.start && p.end === range.end && p.chrom === range.chrom && (p.genome ?? null) === range.genome);
      if (added) useBrowserStore.setState({ selectedPeaks: new Set([...now.selectedPeaks, added.index]) });
      if (!linkSelectedRegions()) setRunResult('cluster', { tone: 'note', text: 'Region selected. Set or draw another region, then choose Link as matched.' });
    },
  });
  extendTrackMenu('fire', () => {
    const s = useBrowserStore.getState();
    const region = useEphemeralStore.getState().hoveredRegion;
    const p = region ? s.peaksByRule[region.groupId]?.find(p => p.match?.label === region.label) : undefined;
    const group = p?.match?.groupId;
    return [
      { id: 'sync-link-matched', label: 'Link as matched', icon: 'target',
        disabled: s.getAllPeaks().filter(p => s.selectedPeaks.has(p.index)).length < 2, run: linkSelectedRegions },
      ...(group ? [
        { id: 'sync-open-panels', label: 'Open as panels', icon: 'target' as const, run: () => openRegionPanels(group) },
        { id: 'sync-reverse-region', label: 'Reverse region', icon: 'target' as const, run: () => { s.reverseMatchedRegion(p!.index); s.pushSnapshot('Reverse region'); } },
        { id: 'sync-rename-group', label: 'Rename group', icon: 'settings' as const, panel: 'peak-detection', title: 'Edit the group name in Peak Detection' },
        { id: 'sync-remove-group', label: 'Remove group', icon: 'x' as const, run: () => removeMatchedGroups(group) },
      ] : []),
    ];
  });
  registerClusterBasisRunner('matched', runMatchedRegions);
  registerClusterBasisRunner('ordered', async (s, basis, report) => {
    const prepared = orderedWindows(s, basis);
    if (!prepared) throw new Error('Select or draw the same number of peaks in each panel to cluster them together.');
    await executeRegionWindows(s, { ...basis, regions: prepared.regions }, prepared.windows, report);
  });
  registerClusterPlanTransform((s, plan) => {
    if (plan.basis.kind !== 'peaks') return plan;
    const advice = { text: 'Plain peaks are paired from left to right and cropped to the narrowest width; windows without peaks use the same offsets. These positions are not verified matches.',
      action: { label: 'Synchronise regions', panel: 'sync-regions' } };
    const windows = clusterWindows(s, getTargetDatasetIds(s.selectedDatasets, s.panels, s.datasets));
    if (new Set(windows.map(w => w.panel.genome ?? null)).size < 2) return { ...plan, advice };
    advice.text = 'Plain peaks in each panel are paired from left to right and cropped to the narrowest width. These positions are not verified matches.';
    const prepared = orderedWindows(s, plan.basis);
    if (!prepared) return { ...plan, advice };
    const keys = new Set(prepared.windows.map(w => w.stateKey));
    const rows = plan.rows.map(row => {
      const p = s.panels.find(p => p.id === row.panelId)!;
      return keys.has(p.stateKey ?? p.datasetId ?? '') ? { ...row, inRun: true, reason: null, shortReason: null } : row;
    });
    const headline = `Cluster on ${plan.basis.what} across ${keys.size} panels on ${new Set(prepared.windows.map(w => w.genome)).size} references (paired by order)`;
    return { ...plan, basis: { ...plan.basis, kind: 'ordered' }, rows, refusal: null, advice,
      headline, summary: `${headline} · ${advice.text}`, chip: `Panels: ${keys.size} · paired by order` };
  });
}

/** Existing left-to-right pairing, with an explicit reference on each window. */
function orderedWindows(s: PlanState, basis: ClusterBasis) {
  const windows = clusterWindows(s, getTargetDatasetIds(s.selectedDatasets, s.panels, s.datasets))
    .filter(w => w.read_ids?.length !== 0).map(w => ({ ...w, genome: w.panel.genome ?? null }));
  // Across references, require each window's own peaks before alignment can fill offsets or drop extras.
  const counts = windows.map(w => basis.regions.filter(p => sameChrom(p.chrom ?? s.chrom, w.chrom)
    && (p.genome ?? null) === w.genome && p.start < w.end && p.end > w.start).length);
  if (!counts.length || counts.some(count => count === 0 || count !== counts[0])) return null;
  const aligned = alignWindowPeaks(windows, basis.regions, s.chrom);
  if (!aligned) return null;
  const regions = windows.flatMap((w, wi) => aligned.byWindow[w.result_key].map((p, feature) => ({ ...p, chrom: w.chrom, genome: w.genome ?? undefined,
    match: { groupId: `ordered-${feature}`, label: `W${wi + 1}`, length: p.end-p.start, reversed: false,
      blocks: [{ frame: [0, p.end-p.start] as [number, number], genomic: [p.start, p.end] as [number, number] }] } })));
  const mapped: RegionClusterWindow[] = windows.map((w, wi) => {
    const own = aligned.byWindow[w.result_key];
    return { ...w, stateKey: w.result_key, result_key: `${w.result_key}@ordered`, region_label: `W${wi + 1}`,
      start: Math.max(0, Math.min(...own.map(p => p.start))), end: Math.max(...own.map(p => p.end)),
      blocks: own.map((p, feature) => ({ feature, reverse: false, frame: [0, p.end-p.start], genomic: [p.start, p.end] })) };
  });
  return { windows: mapped, regions };
}

/** Intersect block maps without crossing a gap or a split at the circular origin. */
export function longestSharedBlock(peaks: FirePeak[], minimum: number): FirePeak[] | null {
  if (!peaks.length || peaks.some(p => !p.match)) return null;
  let shared: [number, number][] = [[0, Math.min(...peaks.map(p => p.match!.length))]];
  for (const p of peaks) shared = shared.flatMap(([a, b]) => p.match!.blocks.flatMap(block => {
    const lo = Math.max(a, block.frame[0]), hi = Math.min(b, block.frame[1]);
    return hi > lo ? [[lo, hi] as [number, number]] : [];
  }));
  const span = shared.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]) || a[0] - b[0])[0];
  if (!span || span[1] - span[0] < minimum) return null;
  const [a, b] = span, length = b - a;
  return peaks.map(p => {
    const m = p.match!, block = m.blocks.find(v => v.frame[0] <= a && v.frame[1] >= b)!;
    const start = m.reversed ? block.genomic[1] - (b - block.frame[0]) : block.genomic[0] + a - block.frame[0];
    return { ...p, start, end: start + length, match: { ...m, groupId: '', length, wrapsOrigin: false,
      blocks: [{ frame: [0, length] as [number, number], genomic: [start, start + length] as [number, number] }] } };
  });
}

function sharedBlockRecovery(s: BrowserState) {
  const groups = s.peakRules.filter(r => r.source === 'matched' && (s.peaksByRule[r.id] ?? []).some(p => s.selectedPeaks.has(p.index)));
  if (groups.length !== 1) return null;
  const group = groups[0];
  const regions = longestSharedBlock(s.peaksByRule[group.id], useSyncSettings.getState().minimum);
  if (!regions) return null;
  return { label: 'Use the longest shared block', run: () => {
    const now = useBrowserStore.getState();
    if (now.peaksByRule[group.id] !== s.peaksByRule[group.id]) return;
    seedHistoryBaseline(now, 'Before using shared block', 'analysis');
    const id = now.upsertMatchedGroup({ name: `${group.name} · shared block`, color: group.color, regions, matchGroup: { origin: 'manual' } });
    const indices = new Set((now.peaksByRule[group.id] ?? []).map(p => p.index));
    useBrowserStore.setState(st => ({ selectedPeaks: new Set([...st.selectedPeaks].filter(i => !indices.has(i))) }));
    useBrowserStore.getState().selectMatchedGroup(id);
    const mode = s.peakModes[s.peaksByRule[group.id][0].index];
    if (mode) useBrowserStore.getState().setPeakMode(useBrowserStore.getState().peaksByRule[id][0].index, mode);
    useBrowserStore.getState().pushSnapshot('Use shared block');
  } };
}
