/** Saved panel scans and live SNP scans share the same dataset-scoped hub identity. */
import type { BrowserState } from '../../stores/browserStore';
import { registerHubProvider, type HubView } from '../hub/hubState';
import { datasetGroups, dsKey, overlapsView } from '../hub/providers';
import type { FeatureHit, FeatureSet, FeatureTypeDecl } from '../hub/types';
import { useVariantsStore } from './variantsState';

const TYPE: FeatureTypeDecl = { typeId: 'var.snp', module: 'browser:snp', label: 'SNP', plural: 'SNPs', provides: ['hit'],
  anchor: 'start', zeroWidth: true, scores: [{ name: 'maf', label: 'Minor allele fraction', kind: 'fraction', better: 'none', perGroup: true }],
  roles: { prevalence: 'maf' } };
export function snpSets(s: BrowserState, view: HubView): FeatureSet[] {
  const scans = new Map(Object.values(useVariantsStore.getState().scans).map(scan => [scan.scan_key, scan]));
  for (const p of s.panels) if (p.variants?.scan) scans.set(p.variants.scan.scan_key, p.variants.scan);
  return [...scans.values()].flatMap(scan => {
    if (scan.target?.genome || !s.datasets.some(d => d.id === scan.dataset_id) || !overlapsView(scan.region.chrom, scan.region.start, scan.region.end, view)) return [];
    const ds = scan.dataset_id, chrom = scan.region.chrom, setId = `browser:snp:${ds}:${scan.scan_key}`;
    const hits: FeatureHit[] = scan.snps.filter(n => overlapsView(chrom, n.pos, n.pos + (n.kind === 'del' ? n.length : n.kind === 'ins' ? 0 : 1), view)).map(n => ({
      setId, hitId: `snp:${ds}:${chrom}:${n.id}`, typeId: TYPE.typeId, frame: { kind: 'linear', chrom }, chrom, start: n.pos,
      end: n.pos + (n.kind === 'del' ? n.length : n.kind === 'ins' ? 0 : 1), anchor: n.pos, label: `${n.alleles.join('/')} @ ${n.pos + 1}`,
      scores: { maf: n.maf }, values: { [dsKey(ds)]: { prevalence: { v: n.maf, n: n.depth } } },
      detail: { kind: n.kind, passes: n.passes, scan: scan.scan_key }, link: { panel: 'variants', payload: { snp: n.id } },
    }));
    return [{ setId, typeId: TYPE.typeId, type: TYPE, frame: { kind: 'linear' as const, chrom }, datasets: [ds], groups: datasetGroups(s, [ds]),
      coverage: { territory: 'regions' as const, ref: `${chrom}:${scan.region.start}-${scan.region.end}` }, count: hits.length, status: 'complete' as const,
      source: { kind: 'inline' as const, hits }, provenance: { producer: 'browser' as const, module: 'snp', inputs: [ds], units: 'regions' as const } }];
  });
}
export function registerSnpHubProvider(): void {
  registerHubProvider({ id: 'snp', sets: snpSets, subscribe: fn => useVariantsStore.subscribe(fn) });
}
