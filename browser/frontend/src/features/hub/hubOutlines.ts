/**
 * The hub's available hits and selection on linear dataset panels and pop-outs. Each hit is drawn with
 * the analysis-region outline (ruler and reads, `stores/analysisRegionStore`, never in figures, sessions or undo):
 *
 * - where it is on this genome (its own coordinates, its lift, or its insertion's junction) on every dataset panel
 *   on this genome: native panels, lifted panels and their haplotype pop-outs;
 * - a source-frame hit also at its source coordinates on the linked source views of its assembly (a pop-out "as
 *   source view"), where the inserted sequence it may sit in is drawn.
 */
import { useBrowserStore, type BrowserState } from '../../stores/browserStore';
import { useAnalysisRegionStore, type AnalysisOutline } from '../../stores/analysisRegionStore';
import { usePanelGenomeStore } from '../../stores/panelGenomeStore';
import { mainGenomeKey } from '../../utils/regionNavigation';
import { displaySpan, inThisGenome, regionOf } from './frames';
import type { HubSelected } from './hubState';
import { hitSelectionEntry } from './hubState';
import { scanSets, useHubData } from './hubData';

export const HUB_OUTLINE_KIND = 'hub';

type FileHolder = { path?: string; paths?: string[] } | undefined;
/** Two datasets on the same BAM files (so the same assembly). */
function samePaths(a: FileHolder, b: FileHolder): boolean {
  if (!a || !b) return false;
  const pa = a.paths?.length ? a.paths : [a.path];
  const pb = b.paths?.length ? b.paths : [b.path];
  return pa.length === pb.length && pa.every((p, i) => Boolean(p) && p === pb[i]);
}
export const HUB_OUTLINE_COLOUR = '#4f46e5';
const MAX_OUTLINES = 64;

export function hubOutlinesFor(s: BrowserState, selected: HubSelected[], available: HubSelected[] = []): AnalysisOutline[] {
  const hits = [...new Map([...selected, ...available].map(h => [`${h.setId}|${h.hitId}`, h])).values()];
  if (!hits.length) return [];
  const main = mainGenomeKey(s);
  const datasetIds = s.datasets.map(d => d.id);
  const genomes = usePanelGenomeStore.getState().genomes;
  const out: AnalysisOutline[] = [];
  for (const h of hits.slice(0, MAX_OUTLINES)) {
    const isSelected = selected.some(x => x.setId === h.setId && x.hitId === h.hitId);
    const clickable = { selected: isSelected, onSelect: (additive: boolean) => {
      useBrowserStore.getState().setFeatureHub(cur => {
        const has = cur.selected.some(x => x.setId === h.setId && x.hitId === h.hitId);
        return { selected: additive ? has ? cur.selected.filter(x => x.setId !== h.setId || x.hitId !== h.hitId) : [...cur.selected, h]
          : has && cur.selected.length === 1 ? [] : [h] };
      });
    } };
    const label = h.label || h.typeId;
    const t = displaySpan(h);
    if (t) {
      const r = regionOf(t);
      out.push({ chrom: t.chrom, start: r.start, end: r.end, genome: null, genomeKey: main, datasetIds, color: HUB_OUTLINE_COLOUR,
        label: t.insertion ? `${label} (in an insertion)` : label, ...clickable });
    }
    if (inThisGenome(h)) continue;
    // The source coordinates, on the source views of the hit's own assembly: the linked source views of the live-lift
    // dataset it was lifted through, and source panels of that dataset's own BAM (the inspector's "Open in … view").
    const liftedId = h.frame?.kind === 'source' ? h.frame.datasetId : undefined;
    const lifted = liftedId ? s.datasets.find(d => d.id === liftedId) : undefined;
    if (!lifted) continue;
    for (const p of s.panels) {
      if (!p.genome || !p.datasetId) continue;
      const linked = (p as { liftLink?: { datasetId?: string } }).liftLink?.datasetId === liftedId;
      const own = Boolean((p as { liveLiftSource?: unknown }).liveLiftSource) && samePaths(s.datasets.find(d => d.id === p.datasetId), lifted);
      if (!linked && !own) continue;
      if (!genomes[p.genome]?.chroms?.some(c => c.name === h.chrom)) continue;
      const r = regionOf({ chrom: h.chrom, start: h.start, end: h.end, anchor: h.anchor });
      out.push({ chrom: h.chrom, start: r.start, end: r.end, genome: p.genome, genomeKey: p.genome, datasetIds: [p.datasetId],
        color: HUB_OUTLINE_COLOUR, label, ...clickable });
    }
  }
  return out;
}

let installed = false;
/** Keep clickable outlines in step with the hub data, selection and panels (called once at registration). */
export function installHubOutlines(): void {
  if (installed) return;
  installed = true;
  let last: unknown = null;
  let lastPanels: unknown = null;
  let lastDatasets: unknown = null;
  let lastHits: unknown = null;
  let lastHidden: unknown = null;
  const sync = (s: BrowserState) => {
    const selected = s.featureHub?.selected ?? [];
    const data = useHubData.getState();
    if (selected === last && s.panels === lastPanels && s.datasets === lastDatasets && data === lastHits && s.featureHub.ui.hiddenSets === lastHidden) return;
    lastHits = data;
    lastHidden = s.featureHub.ui.hiddenSets;
    last = selected;
    lastPanels = s.panels;
    lastDatasets = s.datasets;
    const sets = [...scanSets(data.scans).map(set => ({ ...set, source: { kind: 'inline' as const, hits: data.hits[set.setId]?.hits ?? [] } })), ...data.providers];
    const available = sets.filter(set => !s.featureHub.ui.hiddenSets.includes(set.setId)).flatMap(set => set.source.kind === 'inline'
      ? set.source.hits.map(h => hitSelectionEntry(set, h)) : []);
    const next = hubOutlinesFor(s, selected, available);
    const cur = useAnalysisRegionStore.getState().outlines[HUB_OUTLINE_KIND] ?? [];
    if (!next.length && !cur.length) return;
    useAnalysisRegionStore.getState().set(HUB_OUTLINE_KIND, next);
  };
  useBrowserStore.subscribe(sync);
  useHubData.subscribe(() => sync(useBrowserStore.getState()));
  sync(useBrowserStore.getState());
}
