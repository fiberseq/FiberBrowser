/**
 * SVs in the feature hub (`var.sv`, DESIGN §9): the SV row's clusters in view, one hit per SV across the panels'
 * datasets (the same SV within the row's matching tolerance), with the carrier share per dataset. Insertions are
 * boundaries (zero width at `ref`); their legacy refs keep `[ref, ref+1)` (svFeatureRef), so sessions read in 3.0.x.
 */
import type { BrowserState } from '../../stores/browserStore';
import { hubSpanOf } from '../../stores/featureStore';
import { useTrackFeedStore } from '../../stores/trackFeedStore';
import { registerHubProvider, type HubView } from '../hub/hubState';
import { datasetGroups, dsKey, overlapsView } from '../hub/providers';
import type { FeatureHit, FeatureSet, FeatureTypeDecl, HitValue } from '../hub/types';
import { svFeatureRef, svMatches, svName, type SvLike } from './svFeatures';
import type { ReadPanelFeed } from '../../stores/trackFeedStore';

// The hub owns these loads: full view can unmount every read track.
const hubFeeds = new Map<string, ReadPanelFeed>();
const listeners = new Set<() => void>();
export function rememberHubSv(feed: ReadPanelFeed): void {
  hubFeeds.set(feed.datasetId, feed);
  listeners.forEach(fn => fn());
}
export function clearHubSv(): void { hubFeeds.clear(); listeners.forEach(fn => fn()); }

const SV_TYPE: FeatureTypeDecl = {
  // No per-read states through the hub yet (SV genotypes group reads through the SV tab's own split).
  typeId: 'var.sv', module: 'browser:sv', label: 'SV', plural: 'SVs', provides: ['hit', 'state'], anchor: 'start', zeroWidth: true,
  scores: [{ name: 'prevalence', label: 'Carrier share', kind: 'fraction', better: 'none', perGroup: true },
    { name: 'support', label: 'Carriers', kind: 'count', better: 'high', perGroup: true }],
  roles: { prevalence: 'prevalence', strength: 'support' },
};

function svSets(s: BrowserState, view: HubView): FeatureSet[] {
  const merged: Array<{ sv: SvLike; byDataset: Record<string, { support: number; informative: number }> }> = [];
  const feeds = [...Object.entries(useTrackFeedStore.getState().byStateKey), ...[...hubFeeds].map(([id, feed]) => [`hub:${id}`, feed] as const)];
  for (const [stateKey, feed] of feeds) {
    if (stateKey.startsWith('hub:') && !s.datasets.some(d => d.id === feed.datasetId)) continue;
    // A panel on another reference (its own genome) is not in this genome's coordinates.
    const panel = s.panels.find(p => (p.stateKey ?? p.datasetId) === stateKey);
    if (panel?.genome) continue;
    if (!feed.sv || feed.zoomedOut || !overlapsView(feed.dataChrom, feed.dataStart, feed.dataEnd, view)) continue;
    for (const c of feed.sv.clusters) {
      const sv: SvLike = { t: c.t, ref: c.ref, len: c.len };
      const end = c.t === 'D' ? c.ref + c.len : c.ref;
      if (!overlapsView(feed.dataChrom, c.ref, end, view)) continue;
      let entry = merged.find(m => svMatches(m.sv, sv));
      if (!entry) { entry = { sv, byDataset: {} }; merged.push(entry); }
      const cur = entry.byDataset[feed.datasetId];
      if (!cur || c.informative > cur.informative) entry.byDataset[feed.datasetId] = { support: c.support, informative: c.informative };
    }
  }
  if (!merged.length) return [];
  const datasets = [...new Set(merged.flatMap(m => Object.keys(m.byDataset)))];
  const setId = 'browser:sv';
  const hits: FeatureHit[] = merged.map(({ sv, byDataset }) => {
    const refs = Object.keys(byDataset).map(ds => svFeatureRef(sv, ds, view.chrom));
    // The hub's interval: an insertion's boundary (hubSpan), a deletion's span.
    const span = hubSpanOf(refs[0])!;
    const values: Record<string, Record<string, HitValue>> = {};
    let carriers = 0, informative = 0;
    for (const [ds, v] of Object.entries(byDataset)) {
      values[dsKey(ds)] = { prevalence: { v: v.informative ? v.support / v.informative : null, n: v.informative }, strength: { v: v.support } };
      carriers += v.support; informative += v.informative;
    }
    values.all = { prevalence: { v: informative ? carriers / informative : null, n: informative }, strength: { v: carriers } };
    return { hitId: `sv:${view.chrom}:${sv.t}:${sv.ref}:${sv.len}`, setId, typeId: 'var.sv', frame: { kind: 'linear', chrom: view.chrom },
      chrom: view.chrom, start: span.start, end: span.end, anchor: span.start, label: svName(sv, refs[0].datasetId!, view.chrom),
      scores: { prevalence: values.all.prevalence.v, support: carriers }, stateSpec: { kind: 'sv', t: sv.t, length: sv.len }, values, legacyRefs: refs,
      flags: span.zeroWidth ? ['zero_width'] : [], detail: { kind: sv.t === 'I' ? 'insertion' : 'deletion', length: sv.len },
      link: { panel: 'variants', payload: null } };
  });
  return [{ setId, typeId: 'var.sv', type: SV_TYPE, frame: { kind: 'linear', chrom: view.chrom }, datasets, groups: datasetGroups(s, datasets),
    coverage: { territory: 'view' }, count: hits.length, status: 'complete', source: { kind: 'inline', hits },
    provenance: { producer: 'browser', module: 'sv', inputs: datasets, units: 'view', summary: 'SV row clusters in view (reads loaded in the panels)' } }];
}

export function registerSvHubProvider(): void {
  registerHubProvider({ id: 'sv', sets: svSets, subscribe: fn => {
    listeners.add(fn); const off = useTrackFeedStore.subscribe(fn);
    return () => { listeners.delete(fn); off(); };
  } });
}
