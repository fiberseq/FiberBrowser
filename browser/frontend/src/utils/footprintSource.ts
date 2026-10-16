import type { BrowserState } from '../stores/browserStore';
import type { FootprintGroup } from '../types';
import { panelLocus } from './panelScope';
import { panelReversed } from '../hooks/usePanelDisplayStore';
import { sameChrom } from './chromAliases';
import { clusterWindows } from './clusterTargets';
import type { FootprintInfo } from '../api/footprints';

/** Display sequence and hit offsets in the source panel's direction; genomic bounds stay forward. */
export function orientFootprint(fp: FootprintInfo | undefined, reversed: boolean): FootprintInfo | undefined {
  if (!fp?.sequence || !reversed) return fp;
  const complement: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A', N: 'N' };
  const sequence = [...fp.sequence].reverse().map(b => complement[b.toUpperCase()] ?? b).join('');
  return { ...fp, sequence, motif_hits: fp.motif_hits.map(h => ({ ...h,
    start: sequence.length - h.end, end: sequence.length - h.start, strand: h.strand === '+' ? '-' : '+',
  })) };
}

/** Resolve a definition on its source reference, including copies and closed source panels. */
export function footprintSource(s: BrowserState, group: FootprintGroup, datasetIds: string[]) {
  const candidate = group.sourceIndex >= 0 ? s.selectedFootprints[group.sourceIndex] : undefined;
  const fp = candidate && (group.referenceAbsStart == null || (candidate.absStart === group.referenceAbsStart
    && candidate.absEnd === group.referenceAbsEnd && (!group.referenceChrom || sameChrom(candidate.chrom, group.referenceChrom)))) ? candidate : undefined;
  const key = group.sourceViewKey ?? fp?.stateKey;
  const datasetId = group.sourceDatasetId ?? fp?.datasetId;
  const chrom = group.referenceChrom ?? fp?.chrom ?? s.chrom;
  const at = group.referenceAbsStart ?? fp?.absStart;
  const genome = group.referenceGenome !== undefined ? group.referenceGenome : fp?.genome;
  const candidates = s.panels.filter(p => p.contentType === 'dataset' && p.datasetId);
  const panel = candidates.find(p => key && (p.stateKey ?? p.datasetId) === key)
    ?? candidates.find(p => (!datasetId || p.datasetId === datasetId) && (genome === undefined || (p.genome ?? null) === genome)
      && sameChrom(panelLocus(s, p).chrom, chrom) && (at == null || (panelLocus(s, p).start <= at && panelLocus(s, p).end > at)));
  const reference = genome !== undefined ? genome : panel?.genome ?? null;
  const reversed = group.referenceReversed ?? fp?.reversed ?? (panel ? panelReversed(s, panel.id) : false);
  const scoped = candidates.filter(p => datasetIds.includes(p.datasetId!) && (p.genome ?? null) === reference
    && sameChrom(panelLocus(s, p).chrom, chrom) && (at == null || (panelLocus(s, p).start <= at && panelLocus(s, p).end > at)));
  // A clicked split keeps its cohort even when another copy shows the same dataset and locus.
  const sourcePanels = panel ? scoped.filter(p => p.datasetId !== panel.datasetId || p.id === panel.id) : scoped;
  const ids = [...new Set(sourcePanels.map(p => p.datasetId!))];
  if (!ids.length) ids.push(datasetId ?? datasetIds[0]);
  const windows = clusterWindows({ ...s, panels: sourcePanels, selectedDatasets: new Set() }, ids.filter(Boolean));
  const reads = Object.fromEntries(windows.filter(w => w.read_ids).map(w => [w.dataset_id, w.read_ids!]));
  return { chrom, viewChrom: panel ? panelLocus(s, panel).chrom : s.chrom, genome: reference, reversed, panelId: panel?.id, datasetIds: ids.filter(Boolean),
    readIdsByDataset: Object.keys(reads).length ? reads : undefined };
}
