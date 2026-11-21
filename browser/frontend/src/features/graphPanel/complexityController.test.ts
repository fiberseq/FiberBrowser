/**
 * Graph primary G7 (Codex G7 review): the hand-off controller probes a host drawn linear for complexity whenever its
 * judgement is not of the current topology request (another window, path selection or package), and returns to the
 * graph once the probe says less than 30% is unresolved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queries: any[] = [];
let refuse = false;
vi.mock('./api', async orig => { const mod = await orig<typeof import('./api')>(); return {
  ...mod,
  querySubgraph: vi.fn(async (q: any) => {
    queries.push(q);
    if (refuse) throw new mod.GraphRequestError(422, { code: 'complexity_limit', message: 'too complex', retryable: false });
    const resolved = q.selected.length < 2;   // the unresolved compared path is gone
    return { result: { target: q.target, interval: q.interval, nodes: [], edges: [], direct_matches: [], target_queries: [], summaries: [],
      complete: true, correspondence_complete: true, timings: {},
      paths: [{ binding: q.target, windows: [], coverage: [], plan: null, complete: true,
        occurrences: [{ id: 'o', fragment: 'f', node: 'n', handle: 'h', reverse: false, path_span: q.interval, clip: { start: 0, end: 1 } }] },
      ...(resolved ? [] : [{ binding: 'mat', windows: [], coverage: [], occurrences: [], complete: true, plan: { windows: [], candidates: [], summaries: [] } }])] } };
  }),
}; });

import { useBrowserStore } from '../../stores/browserStore';
import { useGraphStatusStore } from './statusStore';
import { HANDOFF_SETTLE_MS, startHandoffController, useGraphSettings } from './handoff';
import { judgmentKey, useGraphComplexity } from './complexity';
import type { PanelConfig } from '../../types';

const REG = { id: 'gp', label: 'p', producer: 'x', build_target: 'y', revisions: { package: 'p', graph: 'g', db: 'd', maps: 'm' },
  bindings: [{ key: 't', path: { sample: 'REF', haplotype: '0', contig: 'chr3' }, assembly: 'REF', reference: 'REF', size: 1e9,
    size_inferred: false, fragments: [{ origin: 0, end: 1e9, indexed: true }], uncovered: [] }], maps: [] };
const host = (selected: string[]): PanelConfig => ({ id: 'h', contentType: 'dataset', datasetId: 'd', subTracks: [], collapsed: false,
  linkGroup: null, layoutRow: 0, viewMode: 'graph', graphView: { schema: 2, role: 'host', members: [{ panelId: 'h', binding: null }],
    handoff: { shown: 'linear', reason: 'complexity' }, registrationId: 'gp', packageRevision: 'p', graphRevision: 'g', mapRevision: 'm',
    targetBinding: 't', targetReferenceId: 'REF', initiatingPanelId: null, initiatingReferenceId: null, selectedPathKeys: selected,
    targetViewport: null, linkMode: 'independent', layoutSettings: { contextBp: 0, laneHeight: 28 } } } as PanelConfig);

describe('complexity probes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    useGraphSettings.getState().set({ outBp: 50_000, inBp: 40_000, complexity: true });
    useGraphStatusStore.setState({ status: { helper: { available: true }, registrations: [REG], registration_errors: [], limits: {} } as never });
    useGraphComplexity.setState({ byHost: {} });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('a changed path selection at the same window is probed again, and the graph returns', async () => {
    startHandoffController();
    const view = { chrom: 'chr3', start: 1000, end: 11_000 };
    useBrowserStore.setState({ ...view, currentGenome: 'REF', panels: [host(['t', 'mat'])] } as never);
    useGraphComplexity.getState().set('h', judgmentKey(host(['t', 'mat']).graphView, view), 1);
    // The unresolved compared path removed: another request, not judged yet, so probed once settled.
    useBrowserStore.setState({ panels: [host(['t'])] } as never);
    await vi.advanceTimersByTimeAsync(HANDOFF_SETTLE_MS + 20);
    expect(queries.length).toBe(1);
    expect(queries[0].selected).toEqual(['t']);
    await vi.advanceTimersByTimeAsync(HANDOFF_SETTLE_MS + 20);
    expect(useBrowserStore.getState().panels[0].graphView!.handoff!.shown).toBe('graph');
  });

  it('agy G7 review: a refused probe is recorded as unresolved, not probed again and again', async () => {
    startHandoffController();
    refuse = true;
    queries.length = 0;
    const view = { chrom: 'chr3', start: 2000, end: 12_000 };
    useBrowserStore.setState({ ...view, currentGenome: 'REF', panels: [host(['t', 'mat'])] } as never);
    await vi.advanceTimersByTimeAsync(HANDOFF_SETTLE_MS + 20);
    expect(queries.length).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(useGraphComplexity.getState().byHost.h).toMatchObject({ fraction: 1 });
    useBrowserStore.setState(s => ({ panels: [...s.panels] }) as never);
    await vi.advanceTimersByTimeAsync(HANDOFF_SETTLE_MS * 3);
    expect(queries.length).toBe(1);
    expect(useBrowserStore.getState().panels[0].graphView!.handoff!.shown).toBe('linear');
    refuse = false;
  });
});
