/** Graph bubbles keep the package revision and exact layout locus; no nearest-position identity matching. */
import { create } from 'zustand';
import type { BrowserState } from '../../stores/browserStore';
import { registerHubProvider, type HubView } from '../hub/hubState';
import { overlapsView } from '../hub/providers';
import type { FeatureHit, FeatureSet, FeatureTypeDecl, GraphAlias } from '../hub/types';
import type { Item, LayoutModel } from './layout';
import type { GraphRegistration } from './types';

interface Entry { panelId: string; registration: GraphRegistration; model: LayoutModel }
const data = create<{ entries: Record<string, Entry> }>(() => ({ entries: {} }));
export function publishGraphHub(panelId: string, registration: GraphRegistration, model: LayoutModel): void {
  data.setState(s => ({ entries: { ...s.entries, [panelId]: { panelId, registration, model } } }));
}
export function resetGraphHub(): void { data.setState({ entries: {} }); }
const TYPE: FeatureTypeDecl = { typeId: 'graph.bubble', module: 'browser:graph', label: 'Graph bubble', plural: 'Graph bubbles',
  provides: ['hit', 'state'], anchor: 'boundary', zeroWidth: true, roles: { prevalence: 'carriage', strength: 'bp' }, scores: [{ name: 'carriage', label: 'Path carriage', kind: 'fraction', better: 'none', perGroup: true }, { name: 'bp', label: 'Alternate length', kind: 'bp', better: 'none', perGroup: false }] };
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
        const columns = (visits: import('./layout').Visit[]): GraphAlias['columns'] => (visits ?? []).map(v => {
          const length = v.occ.path_span.end - v.occ.path_span.start;
          return [v.occ.node, v.occ.reverse ? length - v.occ.clip.end : v.occ.clip.start, v.occ.reverse ? length - v.occ.clip.start : v.occ.clip.end];
        });
        const all = [...new Map(g.alts.flatMap(a => columns(a.visits)).map(c => [c.join(':'), c])).values()];
        const size = all.reduce((n, c) => n + c[2] - c[1], 0);
        const paths: GraphAlias['paths'] = {};
        const states: Record<string, { state: string }> = {};
        for (const b of reg.bindings) {
          const alt = g.alts.find(a => a.carriers.includes(b.key));
          const base = g.kind === 'group' && (g.base.carriers ?? []).includes(b.key);
          const unavailable = (g.kind === 'group' ? g.unavailable ?? [] : g.stops ?? []).includes(b.key);
          const own = alt ? columns(alt.visits) : [];
          const carried = own.reduce((n, c) => n + c[2] - c[1], 0);
          paths[b.key] = { status: unavailable || (!alt && !base) ? 'unresolved' : alt ? (carried === size && size ? 'carried' : 'partial') : 'absent',
            carried, total: size, label: b.path.haplotype || b.assembly, datasets: [], ...(own.length ? { columns: own } : {}) };
          states[b.key] = { state: unavailable || (!alt && !base) ? '.' : alt ? '1' : '0' };
        }
        hits.push({ setId, hitId: `${setId}:${g.id}`, typeId: TYPE.typeId,
          frame: { kind: 'graph', registration: reg.id, revision: reg.revisions.graph, binding: model.target },
          target: { chrom, start: g.target.start, end: g.target.end, anchor: g.target.start },
          chrom: chrom, start: g.target.start, end: g.target.end, anchor: g.target.start,
          label: g.kind === 'group' ? g.type : 'junction', scores: { bp: Math.max(0, ...g.alts.map(a => a.bp)) },
          graph: { registration: reg.id, target: model.target, binding: g.alts[0]?.carriers[0] ?? model.target, anchor: [g.target.start, g.target.end], columns: all, size, paths },
          stateSpec: { kind: 'graph', paths: states },
          detail: { kind: g.target.start === g.target.end ? 'insertion' : g.alts.every(a => a.bp === 0) ? 'deletion' : 'replacement', locusKey: g.id, revisions: reg.revisions, alleles: g.alts.map(a => ({ id: a.id, bp: a.bp, carriers: a.carriers })), unavailable: g.kind === 'group' ? g.unavailable : g.stops } });
      }
      if (g.kind === 'group') { walk(g.base.chain); for (const a of g.alts) if (a.family) walk(a.family.chain); }
    } };
    walk(model.chain);
    sets.push({ setId, typeId: TYPE.typeId, type: TYPE, frame: { kind: 'graph', registration: reg.id, revision: reg.revisions.graph, binding: model.target },
      datasets: s.datasets.map(d => d.id), groups: [], coverage: { territory: 'view' }, count: hits.length, status: model.complete ? 'complete' : 'partial',
      source: { kind: 'inline', hits }, provenance: { producer: 'browser', module: 'graph', inputs: [reg.id], units: 'view' } });
  }
  return sets;
}
export function registerGraphHubProvider(): void { registerHubProvider({ id: 'graph', sets: graphSets, subscribe: fn => data.subscribe(fn) }); }
