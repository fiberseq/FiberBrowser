import type { Dataset } from '../types';

/** A dataset's footprint-class datatype (consensus_chemistry; family_scan_chemistry from servers before 3.0). */
export function consensusChemistry(dataset: Pick<Dataset, 'consensus_chemistry' | 'family_scan_chemistry'> | undefined): Dataset['consensus_chemistry'] {
  return dataset?.consensus_chemistry ?? dataset?.family_scan_chemistry ?? null;
}

/** Selected datasets that still need their assay type (DddA, DddB, Hia5…) set. */
export function datasetsMissingConsensusChemistry(
  datasets: Dataset[],
  datasetIds: string[],
): Dataset[] {
  const selected = new Set(datasetIds);
  return datasets.filter(dataset => (
    selected.has(dataset.id) && !consensusChemistry(dataset)
  ));
}

/** DAF-seq data (DddA/DddB): each read is one strand (CT or GA), so panels can show one strand. */
export function isStrandedDafDataset(dataset: Dataset | undefined): boolean {
  if (!dataset) return false;
  const chemistry = consensusChemistry(dataset) ?? (dataset as { chemistry_metadata?: { chemistry?: string } }).chemistry_metadata?.chemistry;
  if (chemistry === 'ddda' || chemistry === 'dddb') return true;
  if (chemistry) return false;
  return Boolean(dataset.available_layers?.deam);
}
