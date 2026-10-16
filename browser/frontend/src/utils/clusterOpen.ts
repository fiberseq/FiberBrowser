import { addDataset, addDatasetsGrouped } from '../api/datasets';
import { loadFasta } from '../api/reference';
import type { RemoteEntry } from '../api/remote';
import { useBrowserStore } from '../stores/browserStore';
import { loadPlasmidFiles, openPlasmidDatasetFiles } from './plasmidLoader';
import { showLoadedReference } from './referenceNavigation';

export interface ClusterOpenSummary {
  opened: number;
  errors: string[];
}

function name(ref: string): string {
  return ref.split('/').pop() || ref;
}

/** What a selection would open, in the order it opens (reference first). */
export function planClusterOpen(entries: RemoteEntry[]) {
  const pick = (kind: RemoteEntry['kind']) => entries.filter(e => e.type === 'file' && e.kind === kind).map(e => e.ref);
  const maps = pick('map');
  const bams = pick('bam');
  return {
    fasta: pick('fasta').slice(0, 1),
    // One map with BAMs: the one-step plasmid dataset (load, add, link by sequence).
    plasmidDataset: maps.length === 1 && bams.length > 0 ? { map: maps[0], bams } : null,
    maps: maps.length === 1 && bams.length > 0 ? [] : maps,
    bams: maps.length === 1 && bams.length > 0 ? [] : bams,
    bigbeds: pick('bigbed'),
  };
}

/**
 * Open files from a connected cluster by their ssh:// references: a FASTA as
 * the reference, plasmid maps (with their BAMs linked by sequence), BAM and
 * BigBed datasets. Every later read goes through the connection by range.
 */
export async function openClusterFiles(entries: RemoteEntry[]): Promise<ClusterOpenSummary> {
  const plan = planClusterOpen(entries);
  const store = useBrowserStore.getState();
  const errors: string[] = [];
  let opened = 0;

  for (const ref of plan.fasta) {
    const result = await loadFasta(ref);
    if (result.success) {
      store.setHasFasta(true);
      store.setFastaPath(result.path || ref);
      store.setCurrentGenome(result.inferred_genome ?? null);
      await showLoadedReference();
      opened += 1;
    } else errors.push(`${name(ref)}: ${result.error || 'could not load FASTA'}`);
  }
  if (plan.plasmidDataset) {
    const result = await openPlasmidDatasetFiles(plan.plasmidDataset.map, plan.plasmidDataset.bams);
    if (result.success) opened += 1 + result.datasets.length;
    else errors.push(`${name(plan.plasmidDataset.map)}: ${result.error || 'could not open'}`);
  }
  if (plan.maps.length > 0) {
    const result = await loadPlasmidFiles(plan.maps);
    opened += result.count;
    if (!result.success && result.error) errors.push(result.error);
  }
  for (const ref of plan.bams) {
    const result = await addDataset(ref);
    if (result.success && result.dataset) {
      useBrowserStore.getState().addDataset(result.dataset);
      opened += 1;
    } else errors.push(`${name(ref)}: ${result.error || 'could not load'}`);
  }
  if (plan.bigbeds.length > 0) {
    const result = await addDatasetsGrouped(plan.bigbeds);
    for (const dataset of result.datasets ?? []) {
      useBrowserStore.getState().addDataset(dataset);
      opened += 1;
    }
    if (!result.success) errors.push(result.error || 'could not load BigBed files');
    for (const error of result.errors ?? []) errors.push(error);
  }
  if (opened > 0) useBrowserStore.getState().triggerRefresh();
  return { opened, errors };
}
