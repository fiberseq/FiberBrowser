/**
 * NFR runs in the feature hub (the lab pack's provider): each completed Accessibility run in view gives its NFRs
 * (`nfr.region`) and NFR variants (`nfr.variant`), with the run's legacy refs (source = job id) so states, sessions
 * and 3.0.x keep resolving them. Variant prevalence per dataset is the molecule-weighted EM prevalence over the
 * dataset's channels.
 */
import type { BrowserState } from '../../stores/browserStore';
import { registerHubProvider, type HubView } from '../../features/hub/hubState';
import { datasetGroups, dsKey, overlapsView } from '../../features/hub/providers';
import type { FeatureHit, FeatureSet, FeatureTypeDecl, HitValue } from '../../features/hub/types';
import { useNfrRunsStore } from './nfrRunsStore';
import { nfrRef, variantRef } from './NfrFeatureTrack';

const REGION_TYPE: FeatureTypeDecl = {
  typeId: 'nfr.region', module: 'browser:nfr', label: 'NFR', plural: 'NFRs', provides: ['hit', 'state'], anchor: 'centre', zeroWidth: false,
  scores: [{ name: 'closed', label: 'Closed share', kind: 'fraction', better: 'none', perGroup: false }],
  stateRule: '1: open in the NFR; 0: closed; .: not callable', transferableState: true,
};
const VARIANT_TYPE: FeatureTypeDecl = {
  typeId: 'nfr.variant', module: 'browser:nfr', label: 'NFR variant', plural: 'NFR variants', provides: ['hit', 'state'], anchor: 'centre',
  zeroWidth: false, scores: [{ name: 'prevalence', label: 'Prevalence (EM)', kind: 'fraction', better: 'high', perGroup: true },
    { name: 'gain_nats', label: 'Support gain', kind: 'nats', better: 'high', perGroup: false }],
  stateRule: '1: the variant is open in the read; 0: not; .: not callable', roles: { prevalence: 'prevalence', strength: 'gain_nats' },
};

function datasetOfChannel(key: string, datasets: string[]): string | null {
  const head = key.split('::')[0];
  return datasets.includes(head) ? head : datasets.length === 1 ? datasets[0] : null;
}

function nfrSets(s: BrowserState, view: HubView): FeatureSet[] {
  const out: FeatureSet[] = [];
  for (const run of Object.values(useNfrRunsStore.getState().nfrRuns)) {
    const chrom = run.result.region.chrom;
    if (!overlapsView(chrom, run.result.region.start, run.result.region.end, view)) continue;
    const datasets = run.datasetIds;
    const regionSet = `browser:nfr:${run.jobId}`, variantSet = `browser:nfr-variant:${run.jobId}`;
    const regions: FeatureHit[] = [], variants: FeatureHit[] = [];
    for (const n of run.result.nfrs) {
      const ref = nfrRef(run, n);
      if (overlapsView(chrom, ref.start!, ref.end!, view)) {
        regions.push({ hitId: `nfr:${run.jobId}:${n.id}`, setId: regionSet, typeId: 'nfr.region', frame: { kind: 'linear', chrom }, chrom,
          start: Math.floor(ref.start!), end: Math.ceil(ref.end!), anchor: Math.floor((n.start + n.end) / 2), label: n.id,
          scores: { closed: n.closed ?? null }, values: { all: {} }, legacyRefs: [ref], detail: { status: n.status, reads: n.reads, callable: n.callable },
          link: { panel: 'accessibility', payload: { jobId: run.jobId, nfr: n.id } } });
      }
      for (const v of n.variants) {
        if (!overlapsView(chrom, v.L, v.R, view)) continue;
        const values: Record<string, Record<string, HitValue>> = { all: { prevalence: { v: v.prevalence, lo: v.ci?.[0] ?? null, hi: v.ci?.[1] ?? null } } };
        const per: Record<string, { w: number; sum: number }> = {};
        for (const [key, ch] of Object.entries(v.by_channel ?? {})) {
          const ds = datasetOfChannel(key, datasets);
          if (!ds || ch.em == null) continue;
          const acc = per[ds] ?? (per[ds] = { w: 0, sum: 0 });
          acc.w += Math.max(1, ch.n); acc.sum += ch.em * Math.max(1, ch.n);
        }
        for (const [ds, acc] of Object.entries(per)) values[dsKey(ds)] = { prevalence: { v: acc.sum / acc.w, n: acc.w } };
        variants.push({ hitId: `nfr-variant:${run.jobId}:${v.id}`, setId: variantSet, typeId: 'nfr.variant', frame: { kind: 'linear', chrom }, chrom,
          start: Math.floor(v.L), end: Math.ceil(v.R), anchor: Math.floor((v.L + v.R) / 2), label: `${v.nfr} ${v.name}`,
          scores: { prevalence: v.prevalence, gain_nats: v.gain_nats }, values, legacyRefs: [variantRef(run, v)],
          link: { panel: 'accessibility', payload: { jobId: run.jobId, nfr: v.nfr } } });
      }
    }
    const provenance = { producer: 'browser' as const, module: 'nfr', inputs: datasets, units: 'regions' as const,
      summary: `NFR run ${run.jobId.slice(0, 8)} · ${chrom}:${run.result.region.start.toLocaleString()}-${run.result.region.end.toLocaleString()} (experimental)` };
    const base = { frame: { kind: 'linear' as const, chrom }, datasets, groups: datasetGroups(s, datasets),
      coverage: { territory: 'regions' as const, ref: `${chrom}:${run.result.region.start}-${run.result.region.end}` }, status: 'complete' as const, provenance };
    out.push({ ...base, setId: regionSet, typeId: 'nfr.region', type: REGION_TYPE, count: regions.length, source: { kind: 'inline', hits: regions } });
    out.push({ ...base, setId: variantSet, typeId: 'nfr.variant', type: VARIANT_TYPE, count: variants.length, source: { kind: 'inline', hits: variants } });
  }
  return out;
}

export function registerNfrHubProvider(): void {
  registerHubProvider({ id: 'nfr', sets: nfrSets, subscribe: fn => useNfrRunsStore.subscribe(fn) });
}
