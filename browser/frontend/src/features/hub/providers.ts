/**
 * Core browser providers of hub sets (DESIGN §9): the shown Find classes run (footprint classes per dataset, legacy
 * fp-class refs) and the peak rules' peaks (one set per rule, ids by position so a rescan keeps them). Plugin packs
 * and other core features register their own (NFR runs, SVs, live-lift Differences).
 */
import type { BrowserState } from '../../stores/browserStore';
import { useConsensusViewStore } from '../../stores/consensusViewStore';
import { classFeature } from '../../utils/classFeatures';
import { channelKey, pooledPrevalence, recallerChannels, recallerClassRows } from '../../utils/recallerTable';
import { sameChrom } from '../../utils/chromAliases';
import { registerHubProvider, type HubView } from './hubState';
import type { FeatureHit, FeatureSet, FeatureTypeDecl, GroupDecl, HitValue } from './types';

export const dsKey = (datasetId: string) => `ds:${datasetId}`;
export const hapKey = (label: string) => `hap:${label}`;

export const overlapsView = (chrom: string, start: number, end: number, view: HubView) =>
  sameChrom(chrom, view.chrom) && (end > start ? start < view.end && view.start < end : view.start <= start && start < view.end);

export function datasetGroups(s: BrowserState, ids: string[]): GroupDecl[] {
  return [{ id: 'all', kind: 'all', label: 'All' },
    ...ids.map(id => ({ id: dsKey(id), datasetId: id, kind: 'dataset' as const, label: s.datasets.find(d => d.id === id)?.label ?? id }))];
}

const CLASS_TYPE: FeatureTypeDecl = {
  typeId: 'fp.class', module: 'browser:find-classes', label: 'Footprint class', plural: 'Footprint classes',
  provides: ['hit', 'state'], anchor: 'centre', zeroWidth: false,
  scores: [{ name: 'prevalence', label: 'Prevalence', kind: 'fraction', better: 'high', perGroup: true }],
  stateRule: '1: the read is a member of the class; 0: scored, not a member; .: not scored', roles: { prevalence: 'prevalence' },
};

export const PEAK_TYPE: FeatureTypeDecl = {
  typeId: 'peaks.peak', module: 'browser:peaks', label: 'Accessibility peak', plural: 'Peaks',
  provides: ['hit'], anchor: 'centre', zeroWidth: false,
  scores: [{ name: 'score', label: 'Peak score', kind: 'fraction', better: 'high', perGroup: false },
    { name: 'tier', label: 'Tier', kind: 'code', better: 'low', perGroup: false }],
  roles: { strength: 'score' },
};

function classSets(s: BrowserState, view: HubView): FeatureSet[] {
  const { jobId, catalog } = useConsensusViewStore.getState();
  if (!jobId || !catalog?.region) return [];
  const chrom = catalog.region.chrom;
  const datasets = Object.keys(catalog.datasets);
  const labels = Object.fromEntries(s.datasets.map(d => [d.id, d.label]));
  const hits: FeatureHit[] = [];
  const setId = `browser:fp-class:${jobId}`;
  if (catalog.cr_mode === 'lattice_recaller') {   // isRecallerCatalog
    const channels = recallerChannels(catalog, labels);
    for (const row of recallerClassRows(catalog)) {
      if (!overlapsView(chrom, row.start, row.end, view)) continue;
      const values: Record<string, Record<string, HitValue>> = {};
      const all = pooledPrevalence(row, channels.map(c => c.key), 'molecules');
      if (all.value != null) values.all = { prevalence: { v: all.value, lo: all.lower, n: all.molecules } };
      for (const ds of row.datasets) {
        const keys = channels.filter(c => c.datasetId === ds).map(c => c.key);
        const p = pooledPrevalence(row, keys.length ? keys : [channelKey(ds, 'pooled')], 'molecules');
        if (p.value != null) values[dsKey(ds)] = { prevalence: { v: p.value, lo: p.lower, n: p.molecules } };
      }
      hits.push({ hitId: `fp-class:${jobId}:${row.family}`, setId, typeId: 'fp.class', frame: { kind: 'linear', chrom }, chrom,
        start: Math.floor(row.start), end: Math.ceil(row.end), anchor: Math.floor((row.start + row.end) / 2), label: row.family,
        scores: { prevalence: all.value }, values,
        legacyRefs: row.datasets.map(ds => classFeature(jobId, ds, row.family, row.start, row.end, chrom, row.family)),
        link: { panel: 'footprint-analysis', payload: { jobId, family: row.family } } });
    }
  } else {
    const byFamily = new Map<string, { start: number; end: number; datasets: string[] }>();
    for (const [ds, entry] of Object.entries(catalog.datasets)) {
      for (const f of entry.catalog ?? []) {
        if (f.ignored) continue;
        const cur = byFamily.get(f.family) ?? { start: f.consensus_start, end: f.consensus_end, datasets: [] };
        cur.datasets.push(ds);
        byFamily.set(f.family, cur);
      }
    }
    for (const [family, f] of byFamily) {
      if (!overlapsView(chrom, f.start, f.end, view)) continue;
      hits.push({ hitId: `fp-class:${jobId}:${family}`, setId, typeId: 'fp.class', frame: { kind: 'linear', chrom }, chrom,
        start: Math.floor(f.start), end: Math.ceil(f.end), anchor: Math.floor((f.start + f.end) / 2), label: family,
        scores: {}, values: Object.fromEntries(f.datasets.map(ds => [dsKey(ds), {}])),
        legacyRefs: f.datasets.map(ds => classFeature(jobId, ds, family, f.start, f.end, chrom, family)) });
    }
  }
  return [{ setId, typeId: 'fp.class', type: CLASS_TYPE, frame: { kind: 'linear', chrom }, datasets,
    groups: datasetGroups(s, datasets), coverage: { territory: 'regions', ref: `${chrom}:${catalog.region.start}-${catalog.region.end}` },
    count: hits.length, status: 'complete', source: { kind: 'inline', hits },
    provenance: { producer: 'browser', module: 'find-classes', inputs: datasets, units: 'regions',
      summary: `Find classes run ${jobId.slice(0, 8)} · ${chrom}:${catalog.region.start.toLocaleString()}-${catalog.region.end.toLocaleString()}` } }];
}

function peakSets(s: BrowserState, view: HubView): FeatureSet[] {
  const out: FeatureSet[] = [];
  for (const rule of s.peakRules) {
    if (!rule.enabled || rule.source === 'custom' || rule.source === 'matched') continue;
    const peaks = (s.peaksByRule[rule.id] ?? []).filter(p => overlapsView(p.chrom ?? s.chrom, p.start, p.end, view));
    const setId = `browser:peaks:${rule.id}`;
    const hits: FeatureHit[] = peaks.map(p => {
      const chrom = p.chrom ?? s.chrom;
      return { hitId: `peak:${rule.id}:${chrom}:${p.start}-${p.end}`, setId, typeId: 'peaks.peak', frame: { kind: 'linear', chrom }, chrom,
        start: p.start, end: p.end, anchor: Math.floor((p.start + p.end) / 2),
        label: ['Strong', 'Medium', 'Weak', 'Rare'][p.layer ?? 0] ?? 'Peak',
        scores: { score: p.score ?? null, tier: p.layer ?? null }, values: { all: { strength: { v: p.score ?? null } } },
        detail: { rule: rule.name, width: p.width, threshold: p.threshold } };
    });
    out.push({ setId, typeId: 'peaks.peak', type: { ...PEAK_TYPE, plural: `Peaks · ${rule.name}` }, frame: { kind: 'linear', chrom: view.chrom },
      datasets: [], groups: [{ id: 'all', kind: 'all', label: 'All' }], coverage: { territory: 'view' }, count: hits.length,
      status: 'complete', source: { kind: 'inline', hits },
      provenance: { producer: 'browser', module: 'peaks', inputs: [], units: 'view', summary: `Peak rule ${rule.name} (${rule.source}), scanned in the browser` } });
  }
  return out;
}

export function registerCoreHubProviders(): void {
  registerHubProvider({ id: 'find-classes', sets: classSets, subscribe: fn => useConsensusViewStore.subscribe(fn) });
  registerHubProvider({ id: 'peaks', sets: peakSets });
}
