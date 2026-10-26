/**
 * Live-lift Differences in the feature hub (`var.diff`, DESIGN §9): the Differences the Differences row loaded for
 * the view, one set per live-lift dataset, with a column per haplotype (MAT, PAT: a Difference is on one haplotype,
 * so its column says where it is). Insertions are boundaries (zero width). Ids are the Differences' own.
 */
import type { BrowserState } from '../../stores/browserStore';
import { registerHubProvider, type HubView } from '../hub/hubState';
import { hapKey, overlapsView } from '../hub/providers';
import type { FeatureHit, FeatureSet, FeatureTypeDecl, GroupDecl } from '../hub/types';
import { loadedDifferences, onDifferencesLoaded } from './differenceCache';
import type { DifferencesResponse } from './differenceTypes';

const CHANGE: Record<string, string> = {
  snv: 'snv', mnv: 'mnv', insertion: 'insertion', deletion: 'deletion', replacement: 'replacement', inversion: 'inversion',
  aligned_bubble: 'complex', no_correspondence: 'unresolved',
};

const DIFF_TYPE: FeatureTypeDecl = {
  typeId: 'var.diff', module: 'browser:diff', label: 'Difference', plural: 'Differences', provides: ['hit'], anchor: 'start', zeroWidth: true,
  scores: [{ name: 'bp', label: 'Size', kind: 'bp', better: 'none', perGroup: false }], roles: { strength: 'bp' },
};

function diffSets(s: BrowserState, view: HubView): FeatureSet[] {
  // Each lifted panel loads its own response (a MAT panel, a PAT panel): one set per dataset, their items merged.
  const byDataset = new Map<string, DifferencesResponse[]>();
  for (const response of loadedDifferences()) {
    if (response.mode !== 'items' || !overlapsView(response.chrom, response.start, response.end, view)) continue;
    // Only the dataset's current map and settings (a settings change makes a new lift key).
    const key = s.datasets.find(d => d.id === response.dataset_id)?.live_lift?.key;
    if (key && response.lift_key !== key) continue;
    byDataset.set(response.dataset_id, [...(byDataset.get(response.dataset_id) ?? []), response]);
  }
  const out: FeatureSet[] = [];
  for (const [datasetId, responses] of byDataset) {
    const dataset = s.datasets.find(d => d.id === datasetId);
    const setId = `browser:diff:${datasetId}`;
    const haps: string[] = [];
    const hits: FeatureHit[] = [];
    const seen = new Set<string>();
    for (const response of responses) {
      for (const d of response.items) {
        if (seen.has(d.id) || !overlapsView(response.chrom, d.t_start, d.t_end, view)) continue;
        seen.add(d.id);
        if (!haps.includes(d.hap_label)) haps.push(d.hap_label);
        const bp = Math.max(d.ref_bp, d.alt_bp);
        hits.push({ hitId: d.id, setId, typeId: 'var.diff', frame: { kind: 'lifted', liftKey: response.lift_key, hap: d.hap, chrom: response.chrom },
          chrom: response.chrom, start: d.t_start, end: d.t_end, anchor: d.t_start,
          label: `${CHANGE[d.kind] ?? d.kind} ${bp.toLocaleString()} bp`, scores: { bp },
          values: { [hapKey(d.hap_label)]: { strength: { v: bp } } }, flags: d.t_end <= d.t_start ? ['zero_width'] : [],
          detail: { hap: d.hap_label, kind: d.kind, source: d.source, src: d.src, aliases: d.aliases } });
      }
    }
    haps.sort();
    const groups: GroupDecl[] = haps.map(h => ({ id: hapKey(h), datasetId, kind: 'haplotype', label: h }));
    out.push({ setId, typeId: 'var.diff', type: DIFF_TYPE, frame: { kind: 'linear', chrom: responses[0].chrom }, datasets: [datasetId],
      groups, coverage: { territory: 'view' }, count: hits.length, status: 'complete', source: { kind: 'inline', hits },
      provenance: { producer: 'browser', module: 'live-lift', inputs: [datasetId], units: 'view',
        summary: `Live-lift Differences of ${dataset?.label ?? datasetId} (assembly against this genome)` } });
  }
  return out;
}

export function registerDifferencesHubProvider(): void {
  registerHubProvider({ id: 'differences', sets: diffSets, subscribe: onDifferencesLoaded });
}
