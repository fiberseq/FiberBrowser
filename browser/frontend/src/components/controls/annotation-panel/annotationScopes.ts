import type { PanelConfig } from '../../../types';

/** One annotation request: a region and the panels (state keys) showing it. */
export interface AnnotationRegionScope {
  chrom: string;
  start: number;
  end: number;
  datasetIds: string[];
  /** datasetId -> the state keys of its panels showing this region. */
  stateKeysByDataset: Record<string, string[]>;
  /** The panels' own reference (PanelConfig.genome); absent: the main genome. */
  genome?: string;
}

/**
 * Group target panels by the region each shows (its own locus, else the main
 * view) and its reference, so a panel at another locus or on another assembly
 * is analysed there (on its reference) and gets only its own dataset's result.
 */
export function annotationRegionScopes(
  stateKeys: string[],
  stateKeyToDs: Record<string, string>,
  panels: PanelConfig[],
  main: { chrom: string; start: number; end: number },
): AnnotationRegionScope[] {
  const scopes = new Map<string, AnnotationRegionScope>();
  for (const sk of stateKeys) {
    const dsId = stateKeyToDs[sk] || sk;
    const panel = panels.find(p => p.contentType === 'dataset' && (p.stateKey ?? p.datasetId) === sk);
    const region = panel?.viewportOverride ?? main;
    const genome = panel?.genome || undefined;
    const key = `${genome ?? ''}|${region.chrom}:${region.start}-${region.end}`;
    let scope = scopes.get(key);
    if (!scope) {
      scope = { chrom: region.chrom, start: region.start, end: region.end, datasetIds: [], stateKeysByDataset: {}, ...(genome ? { genome } : {}) };
      scopes.set(key, scope);
    }
    if (!scope.datasetIds.includes(dsId)) scope.datasetIds.push(dsId);
    (scope.stateKeysByDataset[dsId] ??= []).push(sk);
  }
  return [...scopes.values()];
}

/** A signature of the regions the target panels show (for request invalidation). */
export function annotationScopeSignature(scopes: AnnotationRegionScope[]): string {
  return scopes.map(s => `${s.genome ? `${s.genome}|` : ''}${s.chrom}:${s.start}-${s.end}=${Object.entries(s.stateKeysByDataset)
    .map(([ds, sks]) => `${ds}[${sks.join(',')}]`).join(';')}`).join('|');
}
