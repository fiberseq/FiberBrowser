/**
 * The hub selection outlined on linear dataset panels and pop-outs (feature hub G1). Each selected hit is drawn with
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

export function hubOutlinesFor(s: BrowserState, selected: HubSelected[]): AnalysisOutline[] {
  if (!selected.length) return [];
  const main = mainGenomeKey(s);
  const datasetIds = s.datasets.map(d => d.id);
  const genomes = usePanelGenomeStore.getState().genomes;
  const out: AnalysisOutline[] = [];
  for (const h of selected.slice(0, MAX_OUTLINES)) {
    const label = h.label || h.typeId;
    const t = displaySpan(h);
    if (t) {
      const r = regionOf(t);
      out.push({ chrom: t.chrom, start: r.start, end: r.end, genome: null, genomeKey: main, datasetIds, color: HUB_OUTLINE_COLOUR,
        label: t.insertion ? `${label} (in an insertion)` : label });
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
        color: HUB_OUTLINE_COLOUR, label });
    }
  }
  return out;
}

let installed = false;
/** Keep the outlines in step with the hub selection and the panels (called once at registration). */
export function installHubOutlines(): void {
  if (installed) return;
  installed = true;
  let last: unknown = null;
  let lastPanels: unknown = null;
  let lastDatasets: unknown = null;
  const sync = (s: BrowserState) => {
    const selected = s.featureHub?.selected ?? [];
    if (selected === last && s.panels === lastPanels && s.datasets === lastDatasets) return;
    last = selected;
    lastPanels = s.panels;
    lastDatasets = s.datasets;
    const next = hubOutlinesFor(s, selected);
    const cur = useAnalysisRegionStore.getState().outlines[HUB_OUTLINE_KIND] ?? [];
    if (!next.length && !cur.length) return;
    useAnalysisRegionStore.getState().set(HUB_OUTLINE_KIND, next);
  };
  useBrowserStore.subscribe(sync);
  sync(useBrowserStore.getState());
}
