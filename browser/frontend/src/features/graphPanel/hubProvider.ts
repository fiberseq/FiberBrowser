/** Graph bubbles keep the package revision and exact layout locus; no nearest-position identity matching. */
import { create } from 'zustand';
import type { BrowserState } from '../../stores/browserStore';
import { registerHubProvider, type HubView } from '../hub/hubState';
import { overlapsView } from '../hub/providers';
import type { FeatureHit, FeatureSet, FeatureTypeDecl } from '../hub/types';
import type { Item, LayoutModel } from './layout';
import type { GraphRegistration } from './types';

interface Entry { panelId: string; registration: GraphRegistration; model: LayoutModel }
const data = create<{ entries: Record<string, Entry> }>(() => ({ entries: {} }));
export function publishGraphHub(panelId: string, registration: GraphRegistration, model: LayoutModel): void {
  data.setState(s => ({ entries: { ...s.entries, [panelId]: { panelId, registration, model } } }));
}
export function resetGraphHub(): void { data.setState({ entries: {} }); }
const TYPE: FeatureTypeDecl = { typeId: 'graph.bubble', module: 'browser:graph', label: 'Graph bubble', plural: 'Graph bubbles',
  provides: ['hit'], anchor: 'boundary', zeroWidth: true, scores: [{ name: 'bp', label: 'Alternate length', kind: 'bp', better: 'none', perGroup: false }] };
export function graphSets(s: BrowserState, view: HubView): FeatureSet[] {
  const sets: FeatureSet[] = [];
  for (const { panelId, registration: reg, model } of Object.values(data.getState().entries)) {
    const chrom = reg.bindings.find(b => b.key === model.target)?.path.contig;
    if (!chrom) continue;
    const panel = s.panels.find(p => p.id === panelId);
    const saved = panel?.graphView;
    if (saved?.registrationId && (saved.registrationId !== reg.id || saved.packageRevision !== reg.revisions.package || saved.graphRevision !== reg.revisions.graph || saved.mapRevision !== reg.revisions.maps)) continue;
    if (!panel || !overlapsView(chrom, model.interval.start, model.interval.end, view)) continue;
    const setId = `browser:graph:${reg.id}:${JSON.stringify(reg.revisions)}:${model.target}`;
    const hits: FeatureHit[] = [];
    const walk = (items: Item[]) => { for (const g of items) {
      if (g.kind === 'run') continue;
      if (g.target && overlapsView(chrom, g.target.start, g.target.end, view)) {
        hits.push({ setId, hitId: `${setId}:${g.id}`, typeId: TYPE.typeId,
          frame: { kind: 'graph', registration: reg.id, revision: reg.revisions.graph, binding: model.target },
          chrom: chrom, start: g.target.start, end: g.target.end, anchor: g.target.start,
          label: g.kind === 'group' ? g.type : 'junction', scores: { bp: Math.max(0, ...g.alts.map(a => a.bp)) },
          detail: { locusKey: g.id, revisions: reg.revisions, alleles: g.alts.map(a => ({ id: a.id, bp: a.bp, carriers: a.carriers })), unavailable: g.kind === 'group' ? g.unavailable : g.stops } });
      }
      if (g.kind === 'group') { walk(g.base.chain); for (const a of g.alts) if (a.family) walk(a.family.chain); }
    } };
    walk(model.chain);
    sets.push({ setId, typeId: TYPE.typeId, type: TYPE, frame: { kind: 'graph', registration: reg.id, revision: reg.revisions.graph, binding: model.target },
      datasets: [], groups: [], coverage: { territory: 'view' }, count: hits.length, status: model.complete ? 'complete' : 'partial',
      source: { kind: 'inline', hits }, provenance: { producer: 'browser', module: 'graph', inputs: [reg.id], units: 'view' } });
  }
  return sets;
}
export function registerGraphHubProvider(): void { registerHubProvider({ id: 'graph', sets: graphSets, subscribe: fn => data.subscribe(fn) }); }
