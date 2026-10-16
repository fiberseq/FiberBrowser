import { copyPanelAtSite } from './panelCopies';
import type { PanelConfig } from '../types';
import { useBrowserStore } from '../stores/browserStore';
import { seedHistoryBaseline } from '../stores/historySlice';
import { generatePanelId } from '../stores/utils';
import { matchedGroupLabel } from './matchedGroupActions';
import { currentMatchedRun } from './clusterMatchedRun';
import { panelsForPerPanelMode } from './panelNavigation';

/** Open each region on its dataset, retaining the layout for Close and session restore. */
export function openRegionPanels(groupId: string): void {
  const s = useBrowserStore.getState();
  if (s.panels.some(p => p.regionPanelGroup?.id === groupId)) return;
  const rule = s.peakRules.find(r => r.id === groupId);
  const regions = [...(s.peaksByRule[groupId] ?? [])].filter(p => p.match)
    .sort((a, b) => Number(!!b.match!.template) - Number(!!a.match!.template) || a.match!.label.localeCompare(b.match!.label, undefined, { numeric: true }));
  if (!rule || !regions.length) return;
  const sources = regions.map(region => {
    const candidates = s.panels.filter(p => p.contentType === 'dataset' && p.datasetId
      && (p.genome ?? null) === (region.genome ?? null)
      && (!region.match!.datasetId || p.datasetId === region.match!.datasetId));
    return candidates.find(p => p.id === region.match!.panelId) ?? candidates.find(p => {
      const view = p.viewportOverride ?? s;
      return !p.collapsed && view.chrom === region.chrom && view.start <= region.start && view.end >= region.end;
    }) ?? candidates[0];
  });
  if (sources.some(p => !p)) return;
  seedHistoryBaseline(s, 'Before opening panels', 'layout');
  const width = Math.max(...regions.map(p => p.end - p.start));
  const padding = Math.max(20, Math.round(width * 0.1));
  const used = new Set<string>();
  const copies = regions.map((region, i): PanelConfig => {
    const source = sources[i]!;
    const span = width + padding * 2;
    const start = Math.max(0, Math.floor((region.start + region.end - span) / 2));
    const view = { chrom: region.chrom ?? s.chrom, start, end: start + span };
    const existing = s.panels.find(p => {
      const locus = p.viewportOverride ?? s;
      return !used.has(p.id) && !p.regionPanelGroup && p.datasetId === source.datasetId
        && (p.genome ?? null) === (region.genome ?? null) && locus.chrom === view.chrom
        && ((locus.start === view.start && locus.end === view.end) || (locus.start === region.start && locus.end === region.end));
    });
    const id = existing?.id ?? generatePanelId();
    used.add(id);
    return { ...copyPanelAtSite(existing ?? source, id, s), viewportOverride: view,
      genome: region.genome,
      collapsed: false, layoutRow: 0, layoutColumn: undefined, widthFraction: undefined, heightFraction: undefined,
      readSubset: undefined,
      title: region.match!.label, reversed: region.match!.reversed,
      regionPanelGroup: { id: groupId, label: matchedGroupLabel(rule), color: rule.color, regionLabel: region.match!.label,
        previous: { panels: s.panels, navigationMode: s.navigationMode, selectedDatasets: [...s.selectedDatasets], fullViewPanelId: s.fullViewPanelId, collapsedRows: [...s.collapsedRows] } },
    };
  });
  const others = panelsForPerPanelMode(s.panels.filter(p => !used.has(p.id)), { chrom: s.chrom, start: s.start, end: s.end })
    .map(p => p.contentType === 'dataset' ? { ...p, collapsed: true } : p);
  const clusterAssignments = { ...s.clusterAssignments };
  const savedRun = currentMatchedRun(s.clusterMatchedRun, s.clusterAssignments);
  // Earlier correspondence runs saved per-feature ids ("group:rule:span").
  // Resolve their owning group so those sessions can reopen the same panels.
  const run = savedRun && { ...savedRun, groups: [...new Set(savedRun.groups.map(id =>
    s.peakRules.filter(r => r.source === 'matched' && (r.id === id || id.startsWith(`${r.id}:`)))
      .sort((a, b) => b.id.length - a.id.length)[0]?.id ?? id))] };
  const mappedWindows: NonNullable<typeof run>['windows'] = [];
  if (run?.groups.includes(groupId)) copies.forEach((panel, i) => {
    const window = run.windows.find(w => w.label.startsWith(`${regions[i].match!.label} · `)
      && (w.datasetId ?? s.panels.find(p => p.id === w.panelId)?.datasetId) === panel.datasetId);
    if (window && run.assignments[window.key]) {
      clusterAssignments[panel.stateKey!] = run.assignments[window.key];
      mappedWindows.push({ ...window, panelId: panel.id, datasetId: panel.datasetId ?? undefined, stateKey: panel.stateKey! });
    }
  });
  const clusterMatchedRun = run && mappedWindows.length === copies.length ? { ...run, windows: mappedWindows,
    panelAssignments: Object.fromEntries(mappedWindows.map(w => [w.stateKey, clusterAssignments[w.stateKey]])) } : s.clusterMatchedRun;
  useBrowserStore.setState({ fullViewPanelId: null, collapsedRows: new Set([...s.collapsedRows].filter(row => row !== 0)), clusterMatchedRun, clusterAssignments, panels: [...copies, ...others], navigationMode: 'perPanel', selectedDatasets: new Set(copies.map(p => p.id)) });
  if (!regions.every(p => s.selectedPeaks.has(p.index))) useBrowserStore.getState().selectMatchedGroup(groupId);
  useBrowserStore.getState().pushSnapshot('Open as panels', { kind: 'layout', explicit: true });
}

export function closeRegionPanels(groupId: string): void {
  const s = useBrowserStore.getState();
  const previous = s.panels.find(p => p.regionPanelGroup?.id === groupId && p.regionPanelGroup.previous)?.regionPanelGroup?.previous;
  seedHistoryBaseline(s, 'Before closing panels', 'layout');
  // Older sessions identify a window's dataset only through its temporary panel.
  const clusterMatchedRun = s.clusterMatchedRun && { ...s.clusterMatchedRun, windows: s.clusterMatchedRun.windows.map(w => ({
    ...w, datasetId: w.datasetId ?? s.panels.find(p => p.id === w.panelId)?.datasetId ?? undefined,
  })) };
  useBrowserStore.setState({ clusterMatchedRun, ...(previous ? { panels: previous.panels, navigationMode: previous.navigationMode,
    selectedDatasets: new Set(previous.selectedDatasets), fullViewPanelId: previous.fullViewPanelId ?? null, collapsedRows: new Set(previous.collapsedRows ?? []) } : { panels: s.panels.filter(p => p.regionPanelGroup?.id !== groupId) }) });
  useBrowserStore.getState().pushSnapshot('Close group panels', { kind: 'layout', explicit: true });
}
