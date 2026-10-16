/**
 * Where the reads Read Stats describes come from, in a few words: the
 * dataset name (its file stem), several names, or a count. Panels showing
 * the same dataset are one source; how many panels is said only when there
 * are several.
 */
export function describeReadSource(
  stateKeys: string[],
  datasetIdOf: (stateKey: string) => string,
  labelOf: (datasetId: string) => string,
): string {
  const panelsByDataset = new Map<string, number>();
  for (const sk of stateKeys) {
    const ds = datasetIdOf(sk);
    panelsByDataset.set(ds, (panelsByDataset.get(ds) ?? 0) + 1);
  }
  const names = [...panelsByDataset.keys()].map(labelOf);
  const panelCount = stateKeys.length;
  if (names.length === 0) return '';
  if (names.length === 1) return panelCount > 1 ? `${names[0]} (${panelCount} panels)` : names[0];
  if (names.length <= 3) return names.join(', ');
  return `${names.length} datasets`;
}
