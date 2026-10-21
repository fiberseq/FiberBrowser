/**
 * Graph primary G7: the complexity hand-off (DESIGN_GRAPH_PRIMARY §7.2): linear past 50% of the window unresolved in
 * the topology, back below 30%, judged on the topology; a linear host probes its settled window.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { complexityShown, unresolvedFraction, useGraphComplexity, viewKey } from './complexity';
import { applyShown, desiredHandoff, useGraphSettings } from './handoff';
import { useGraphStatusStore } from './statusStore';
import type { GraphPathResult, GraphTopology } from './types';
import type { PanelConfig } from '../../types';

const occ = (start: number, end: number) => ({ id: `o${start}`, fragment: 'f', node: `n${start}`, handle: 'h', reverse: false,
  path_span: { start, end }, clip: { start: 0, end: end - start } });
const cand = (start: number, end: number, correspondence = 'map_anchor') => ({ target: { start, end }, source: { start, end },
  chain_ids: [], strands: [], kind: 'map_block', correspondence, owned: true });
const path = (binding: string, extra: Partial<GraphPathResult>): GraphPathResult => ({ binding, windows: [], coverage: [], occurrences: [],
  plan: null, complete: true, ...extra });
const topo = (paths: GraphPathResult[]): GraphTopology => ({ target: 't', interval: { start: 0, end: 1000 }, nodes: [], edges: [], paths,
  direct_matches: [], target_queries: [], summaries: [], complete: true, correspondence_complete: true, timings: {} });

describe('unresolvedFraction', () => {
  it('is 0 when the target walks the whole window and every compared path resolves it', () => {
    expect(unresolvedFraction(topo([path('t', { occurrences: [occ(0, 600), occ(600, 1000)] }),
      path('mat', { plan: { windows: [], candidates: [cand(0, 1000)], summaries: [] } })]))).toBe(0);
  });
  it('counts target coverage gaps and a limit cut (no visits at all)', () => {
    expect(unresolvedFraction(topo([path('t', { occurrences: [occ(0, 400)] })]))).toBeCloseTo(0.6);
    expect(unresolvedFraction(topo([path('t', {})]))).toBe(1);
    // A helper limit cut: the walk is truncated (chr21 at 50 kb, the selected-node limit).
    const cut = { ...topo([path('t', { occurrences: [occ(0, 820)] })]), complete: false, summaries: [{ reason: 'selected_node_limit', binding: 't' }] };
    expect(unresolvedFraction(cut)).toBe(1);
  });
  it('counts target bases a compared path has no resolved correspondence for; paths without a plan do not count', () => {
    const t = path('t', { occurrences: [occ(0, 1000)] });
    const mat = path('mat', { plan: { windows: [], candidates: [cand(0, 300), cand(300, 700, 'unresolved')], summaries: [] } });
    expect(unresolvedFraction(topo([t, mat]))).toBeCloseTo(0.7);
    expect(unresolvedFraction(topo([t, path('pat', {})]))).toBe(0);
    // Two compared paths: a base either lacks is unresolved.
    const pat = path('pat', { plan: { windows: [], candidates: [cand(500, 1000), cand(0, 200, 'inferred_fill')], summaries: [] } });
    expect(unresolvedFraction(topo([t, mat, pat]))).toBeCloseTo(0.8);  // mat lacks 300–1000, pat 200–500
  });
});

describe('complexityShown (hysteresis)', () => {
  it('leaves past 50% and returns below 30% only when linear for this reason', () => {
    expect(complexityShown('graph', 0.49, false)).toBe('graph');
    expect(complexityShown('graph', 0.51, false)).toBe('linear');
    expect(complexityShown('linear', 0.4, true)).toBe('linear');
    expect(complexityShown('linear', 0.29, true)).toBe('graph');
    expect(complexityShown('linear', 0.4, false)).toBe('graph');
    expect(complexityShown('graph', undefined, false)).toBeNull();
  });
});

describe('desiredHandoff', () => {
  const reg = { id: 'gp', label: 'p', producer: 'x', build_target: 'y', revisions: { package: 'p', graph: 'g', db: 'd', maps: 'm' },
    bindings: [{ key: 't', path: { sample: 'REF', haplotype: '0', contig: 'chr3' }, assembly: 'REF', reference: 'REF', size: 1e8,
      size_inferred: false, fragments: [{ origin: 0, end: 1e8, indexed: true }], uncovered: [] }], maps: [] };
  const host = (handoff: Record<string, unknown> = {}): PanelConfig => ({ id: 'h', contentType: 'dataset', datasetId: 'd', subTracks: [],
    collapsed: false, linkGroup: null, layoutRow: 0, viewMode: 'graph', graphView: { schema: 2, role: 'host', members: [{ panelId: 'h', binding: null }],
      handoff: { shown: 'graph', ...handoff }, registrationId: 'gp', packageRevision: 'p', graphRevision: 'g', mapRevision: 'm', targetBinding: 't',
      targetReferenceId: 'REF', initiatingPanelId: null, initiatingReferenceId: null, selectedPathKeys: ['t'], targetViewport: null,
      linkMode: 'independent', layoutSettings: { contextBp: 0, laneHeight: 28 } } } as PanelConfig);
  const main = { chrom: 'chr3', start: 1000, end: 11_000, reference: 'REF' };
  beforeEach(() => {
    localStorage.clear();
    useGraphSettings.getState().set({ outBp: 50_000, inBp: 40_000, complexity: true });
    useGraphStatusStore.setState({ status: { helper: { available: true }, registrations: [reg], registration_errors: [], limits: {} } as never });
    useGraphComplexity.setState({ byHost: {} });
  });

  it('goes linear for complexity in a narrow window, and returns once the probe says below 30%', () => {
    expect(desiredHandoff(host(), main)).toEqual({ shown: 'graph' });
    useGraphComplexity.getState().set('h', viewKey(main), 0.8);
    expect(desiredHandoff(host(), main)).toEqual({ shown: 'linear', reason: 'complexity' });
    const linear = host({ shown: 'linear', reason: 'complexity' });
    // A new window not judged yet: stays linear (its probe decides).
    const moved = { ...main, start: 2000, end: 12_000 };
    expect(desiredHandoff(linear, moved)).toEqual({ shown: 'linear', reason: 'complexity' });
    useGraphComplexity.getState().set('h', viewKey(moved), 0.4);
    expect(desiredHandoff(linear, moved).shown).toBe('linear');
    useGraphComplexity.getState().set('h', viewKey(moved), 0.2);
    expect(desiredHandoff(linear, moved)).toEqual({ shown: 'graph' });
  });

  it('the width rule wins and says so; the setting turns the complexity rule off', () => {
    useGraphComplexity.getState().set('h', viewKey(main), 0.9);
    expect(desiredHandoff(host(), { ...main, end: 80_000 })).toEqual({ shown: 'linear', reason: 'width' });
    useGraphSettings.getState().set({ complexity: false });
    expect(desiredHandoff(host(), main)).toEqual({ shown: 'graph' });
  });

  it('applyShown records the reason while linear and clears it on return', () => {
    const p = applyShown([host()], 'h', 'linear', 'complexity');
    expect(p[0].graphView!.handoff).toMatchObject({ shown: 'linear', reason: 'complexity' });
    const back = applyShown(p, 'h', 'graph');
    expect(back[0].graphView!.handoff!.reason).toBeUndefined();
  });
});
