import type { BrowserState } from '../stores/browserStore';
import type { ConsensusJob, ConsensusRequest } from '../api/consensusWorkflow';
import type { ClassRange } from './classRegion';
import { sameChrom } from './chromAliases';

export interface AnalysisWindow extends ClassRange {
  name: string;
  label?: string;
  dataset_id: string;
  strand: '+' | '-';
}
type Recovery = { label: string; run: () => void };
type Extension = { recover?: (s: BrowserState) => Recovery | null; run: (request: ConsensusRequest) => Promise<ConsensusJob>; link: (range: ClassRange) => void };
let extension: Extension | null = null;
/** A pack supplies entry points; shared controls retain the same region choices. */
export function registerRegionAnalysis(value: Extension) { extension = value; }
export function regionAnalysisExtension() { return extension; }

/** Explicit rigid windows, one per selected region and targeted dataset. Never substitute the view. */
export function selectedAnalysisWindows(s: BrowserState, datasetIds: string[]): { windows: AnalysisWindow[]; error: string | null; label: string; recovery?: Recovery } {
  const selected = s.getAllPeaks().filter(p => p.match && (p.featureIndex !== undefined || s.selectedPeaks.has(p.index)));
  const featureIds = [...new Set(selected.map(p => p.match!.groupId))];
  const groups = featureIds.map(id => ({ id, name: s.peakRules.find(r => r.id === (selected.find(p => p.match!.groupId === id)?.match?.correspondenceId ?? id))?.name ?? 'Matched regions' }));
  const fail = (error: string) => ({ windows: [], error, label: error });
  if (groups.length !== 1) return fail('Select one matched group in the Peaks track.');
  const peaks = selected.filter(p => p.match!.groupId === groups[0].id);
  if (peaks.some(p => !p.match || p.match.blocks.length !== 1 || p.match.wrapsOrigin || p.match.blocks[0].frame[0] !== 0
    || p.match.blocks[0].frame[1] !== p.match.length || p.end - p.start !== p.match.length)) {
    const recovery = extension?.recover?.(s);
    return recovery ? { ...fail('These regions have gaps or cross the origin.'), recovery }
      : fail('No shared block is long enough. Lower Minimum aligned length or select another group.');
  }
  if (new Set(peaks.map(p => p.match!.length)).size !== 1) return fail('Select matched regions of equal width.');
  const windows: AnalysisWindow[] = [];
  for (const [i, p] of peaks.entries()) {
    const ids = new Set(s.panels.filter(panel => datasetIds.includes(panel.datasetId ?? '') && (panel.genome ?? null) === (p.genome ?? null)
      && sameChrom(panel.viewportOverride?.chrom ?? s.chrom, p.chrom ?? s.chrom)
      && (panel.viewportOverride?.start ?? s.start) < p.end && (panel.viewportOverride?.end ?? s.end) > p.start).map(panel => panel.datasetId!));
    if (!ids.size) return fail(`No targeted panel shows ${p.match!.label}. Show every region of the group, or select another group.`);
    for (const id of ids) windows.push({ name: `${p.match!.label}-${i}-${id}`, label: `${groups[0].name} · ${p.match!.label}`, dataset_id: id, chrom: p.chrom!, start: p.start, end: p.end,
      genome: p.genome ?? null, strand: p.match!.reversed ? '-' : '+' });
  }
  if (!windows.length || datasetIds.some(id => !windows.some(w => w.dataset_id === id)))
    return fail('Some selected datasets have no matched region. Untick them or show a region there.');
  return { windows, error: null, label: `${groups[0].name} · ${windows.length} regions / datasets · ${peaks[0].match!.length} bp each` };
}
