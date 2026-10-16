/**
 * Usability round 1 (NFR panel): Find classes' job status from a card, "Re-run to include them" when classes were found
 * after the run, inspect vs group for a pair (arcs, matrix, pair rows by keyboard), the read panel's groups legend, a
 * class linked from the Footprints panel, the legend and its "?" help.
 */
import '../testSetup';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useAccessibilityStore } from './accessibilityStore';
import * as api from './api';
import * as cw from '../../api/consensusWorkflow';
import { AccessibilityPanel } from './AccessibilityPanel';
import { COMPLETE_JOB, NFR_RESULT } from './accessibility/fixture';
import { DEFAULT_PAIR_FILTER } from './accessibilityView';
import { resetJobs } from './nfrJobs';
import { FOCUS_NFR_EVENT } from './nfrLinks';
import { NfrClasses } from './accessibility/NfrClasses';
import { savedFromNfr } from './savedNfrVariants';
import { useNfrGroupsHeader } from './NfrGroupsChip';

vi.mock('../../api/consensusWorkflow', async importOriginal => ({
  ...(await importOriginal<typeof import('../../api/consensusWorkflow')>()), getConsensusJob: vi.fn(), cancelConsensus: vi.fn(),
}));
vi.mock('./api', async importOriginal => ({
  ...(await importOriginal<typeof import('./api')>()),
  startAccessibility: vi.fn(), getAccessibilityJob: vi.fn(), getAccessibilityJobs: vi.fn(), getAccessibilityGroups: vi.fn(),
  cancelAccessibility: vi.fn(), getNfrOverview: vi.fn(), splitAccessibilityReads: vi.fn(), getNfrMotifs: vi.fn(),
  getNfrClasses: vi.fn(), getNfrCooccupancy: vi.fn(), startNfrClassRun: vi.fn(), getClassStatus: vi.fn(),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const q = (c: ParentNode, id: string) => c.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (c: ParentNode, id: string) => [...c.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click(); });
const button = (c: HTMLElement, text: string) => [...c.querySelectorAll('button')].find(b => b.textContent?.trim().startsWith(text))!;

const PAIR = NFR_RESULT.pairs[0];
const SPLIT: api.AccessibilitySplit = {
  job_id: COMPLETE_JOB.job_id, kind: 'pair', a: 'N1:V1', b: 'N1:V3', short: ['N1 V1', 'N1 V3'],
  groups: [
    { id: 0, key: '11', label: 'N1 V1+ N1 V3+', molecules: 198, count: 2, pattern: [1, 1] },
    { id: 1, key: '10', label: 'N1 V1+ N1 V3−', molecules: 283, count: 1, pattern: [1, 0] },
    { id: 2, key: '01', label: 'N1 V1− N1 V3+', molecules: 288, count: 1, pattern: [0, 1] },
    { id: 3, key: '00', label: 'N1 V1− N1 V3−', molecules: 1620, count: 1, pattern: [0, 0] },
    { id: 4, key: 'na', label: 'Not informative', molecules: 364, count: 1, pattern: null },
  ],
  by_dataset: { ds1: { r1: 0, r2: 0, r3: 1, r4: 2, r5: 3, r6: 4 } }, ambiguous_reads: {},
  table: PAIR.table, pair: PAIR, tested: true, skipped: null,
  excluded: { shared: 272 }, excluded_text: { shared: 'one opening covers both (shared)' },
  window: [47517850, 47518810],
};

describe('NFR panel, usability round 1', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.mocked(api.getAccessibilityJobs).mockReset().mockResolvedValue({ jobs: [{ ...COMPLETE_JOB, result: undefined }] });
    vi.mocked(api.getAccessibilityJob).mockReset().mockResolvedValue(COMPLETE_JOB);
    vi.mocked(api.getNfrOverview).mockReset().mockResolvedValue({ nfr: 'N1', x: [0, 1], step: 10, all: { profile: [0.3, 0.3], n: 2661 }, variants: {} });
    vi.mocked(api.splitAccessibilityReads).mockReset().mockResolvedValue(SPLIT);
    vi.mocked(api.getNfrMotifs).mockReset().mockReturnValue(new Promise(() => {}));
    vi.mocked(api.getClassStatus).mockReset().mockResolvedValue({ class_job: null, joined: null, classes: 0, reason: 'No Find classes run in this session covers these molecules.' });
    useAccessibilityStore.setState({ jobId: COMPLETE_JOB.job_id, result: NFR_RESULT, showArcs: false, arcSelection: 'significant', showClassArcs: true, applied: [],
      ...DEFAULT_PAIR_FILTER, focus: null, panelTab: 'nfrs', listFilter: 'all', openCard: null, focusedVariant: null, showEarlier: false, untickedLive: {},
      listScroll: null, inspected: null, cardView: {}, highlightClass: null });
    resetJobs();
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({
      chrom: 'chr19', start: 47517650, end: 47518985,
      datasets: [{ id: 'ds1', label: 'napa_ddda', color: '#3b82f6', path: 'x', consensus_chemistry: 'ddda' }],
      panels: [{ id: 'p1', contentType: 'dataset', datasetId: 'ds1', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 }],
      selectedDatasets: new Set(), clusterAssignments: { ds1: { r1: 7, r2: 8 } }, clusterOrder: { ds1: [7, 8] }, clusterFocus: {},
      savedNfrVariants: [], footprintGroups: [], _historyStack: [], _historyPointer: -1,
    } as never);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  async function renderPanel(tab: 'nfrs' | 'coaccess' = 'nfrs') {
    useAccessibilityStore.setState({ panelTab: tab });
    await act(async () => root.render(<AccessibilityPanel />));
    await wait(30);
  }

  it('names the action "Find NFR variants" and explains the terms with focusable help', async () => {
    await renderPanel();
    expect(q(container, 'nfr-find')!.textContent).toBe('Find NFR variants');
    const legend = q(container, 'nfr-legend')!;
    expect(legend.textContent).toContain('callable reads');
    const helps = qa(legend, 'nfr-legend-callable').concat(qa(legend, 'nfr-legend-closed'), qa(legend, 'nfr-legend-interval'), qa(legend, 'nfr-legend-types'));
    expect(helps).toHaveLength(4);
    for (const h of helps) { expect(h.tagName).toBe('BUTTON'); expect(h.textContent).toContain('?'); }
    expect(qa(legend, 'nfr-legend-types')[0].textContent).toContain('satellite');            // the sr-only explanation
    // the card's own: callable and closed
    expect(q(container, 'nfr-help-callable')).not.toBeNull();
  });

  it('an arc inspects; a pair row inspects from the keyboard; its Group reads button groups', async () => {
    const before = useBrowserStore.getState().clusterAssignments.ds1;
    await renderPanel('coaccess');
    const row = qa(container, 'nfr-pair-row')[0];
    expect(row.tabIndex).toBe(0);
    await act(async () => { row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await wait(10);
    expect(api.splitAccessibilityReads).toHaveBeenCalledTimes(1);
    expect(q(container, 'nfr-pair-detail')!.dataset.mode).toBe('inspect');
    expect(useBrowserStore.getState().clusterAssignments.ds1).toBe(before);
    // the arcs legend says what a click does now
    expect(q(container, 'nfr-arcs-legend')!.textContent).toContain('inspect the pair');
    expect(q(container, 'nfr-arcs-legend')!.textContent).toContain('rarely together');
    // the row's own button groups the reads (fetched for it), then Restore previous grouping takes them back
    await click(qa(container, 'nfr-pair-group')[0]);
    await wait(10);
    expect(useBrowserStore.getState().clusterAssignments.ds1).toEqual(SPLIT.by_dataset.ds1);
    expect(q(container, 'nfr-pair-detail')!.dataset.mode).toBe('grouped');
    expect(qa(q(container, 'nfr-pair-detail')!, 'nfr-split-group').map(g => g.textContent)).toContain('N1 V1+ N1 V3+198');
    await click(q(container, 'nfr-split-clear'));
    expect(useBrowserStore.getState().clusterAssignments.ds1).toBe(before);
  });

  it('the pair table names the statistic and its q as evidence', async () => {
    await renderPanel('coaccess');
    const head = q(container, 'nfr-pair-table')!.querySelector('thead')!;
    expect(head.textContent).toContain('Adjusted log₂ OR (pooled)');
    expect([...head.querySelectorAll('th')].find(t => t.textContent === 'q')!.title).toContain('evidence, not proof');
  });

  it('says how many classes were found after the run, and re-runs to include them (never "no classes")', async () => {
    vi.mocked(api.getClassStatus).mockResolvedValue({ class_job: 'cls9abcd', joined: 'posthoc', classes: 5, reason: null });
    vi.mocked(api.startAccessibility).mockReset().mockResolvedValue({ job_id: 'new', status: 'queued', message: 'Waiting' });
    const noJoin = { ...NFR_RESULT, class_join: null };
    useAccessibilityStore.setState({ result: noJoin });
    vi.mocked(api.getAccessibilityJob).mockResolvedValue({ ...COMPLETE_JOB, result: noJoin,
      request: { dataset_ids: ['ds1'], chrom: 'chr19', start: 47517000, end: 47519500, parameters: { stringency: 0.9 }, region_source: 'view' } });
    await renderPanel('coaccess');
    await wait(20);
    const join = q(container, 'nfr-class-join')!;
    expect(join.dataset.state).toBe('after-run');
    expect(join.textContent).toContain('5 classes in this window (Footprint run cls9…) found after this run');   // scoped (N11)
    expect(join.textContent).not.toContain('no classes');
    await click(q(container, 'nfr-class-rerun'));
    expect(api.startAccessibility).toHaveBeenCalledWith(expect.objectContaining({ dataset_ids: ['ds1'], chrom: 'chr19', start: 47517000, end: 47519500, parameters: { stringency: 0.9, detect_method: 'enrichment' } }));
    await wait(10);
    expect(q(container, 'nfr-progress')).not.toBeNull();                      // its progress shows on this tab too
  });

  it('a class linked from the Footprints panel opens the card on its Footprints view, the class marked', async () => {
    vi.mocked(api.getNfrClasses).mockReset().mockResolvedValue({ nfr: 'N1', class_job: 'cls1', joined: 'run', reason: null, classes: [
      { id: 'class_008', class_id: 'class_008', label: 'class 008', start: 47518180, end: 47518220, prevalence: .3, inside: ['V1'], layers: {} },
      { id: 'class_009', class_id: 'class_009', label: 'class 009', start: 47518300, end: 47518330, prevalence: .2, inside: [], layers: {} },
    ] });
    await renderPanel();
    await act(async () => { window.dispatchEvent(new CustomEvent(FOCUS_NFR_EVENT, { detail: { jobId: COMPLETE_JOB.job_id, nfrId: 'N1', classId: 'class_009' } })); });
    await wait(120);
    const st = useAccessibilityStore.getState();
    expect(st.openCard).toBe(`${COMPLETE_JOB.job_id}|N1`);
    expect(st.cardView[`${COMPLETE_JOB.job_id}|N1`]).toBe('classes');
    expect(api.getNfrMotifs).not.toHaveBeenCalled();                          // the motif view is not scanned for it
    const marked = qa(container, 'nfr-class-row').filter(r => r.dataset.highlighted);
    expect(marked.map(r => r.dataset.class)).toEqual(['class_009']);
    expect(marked[0].textContent).toContain('Class 009');
  });

  it('only the newest pair inspection counts; Close drops one still on its way (Codex review)', async () => {
    let resolveA: (v: api.AccessibilitySplit) => void = () => {};
    const B = { ...SPLIT, a: 'N1:V2', b: 'class_008', short: ['N1 V2', 'C008'] };
    vi.mocked(api.splitAccessibilityReads).mockReset()
      .mockImplementationOnce(() => new Promise(r => { resolveA = r; }))
      .mockImplementationOnce(async () => B);
    await renderPanel('coaccess');
    const rows = qa(container, 'nfr-pair-row');
    await click(rows[0]);
    await click(rows[1]);
    await wait(10);
    await act(async () => { resolveA(SPLIT); });
    await wait(10);
    expect(useAccessibilityStore.getState().inspected?.split.a).toBe('N1:V2');      // B stays
    // a request still on its way when the card is closed does not reopen it
    vi.mocked(api.splitAccessibilityReads).mockImplementationOnce(() => new Promise(r => { resolveA = r; }));
    await click(qa(container, 'nfr-pair-row')[0]);
    await click(q(container, 'nfr-split-close'));
    await act(async () => { resolveA(SPLIT); });
    await wait(10);
    expect(useAccessibilityStore.getState().inspected).toBeNull();
    expect(q(container, 'nfr-pair-detail')).toBeNull();
  });

  it('Re-run replays the shown run\'s own request (no local loader settings slipped in)', async () => {
    vi.mocked(api.getClassStatus).mockResolvedValue({ class_job: 'cls9', joined: 'posthoc', classes: 2, reason: null });
    vi.mocked(api.startAccessibility).mockReset().mockResolvedValue({ job_id: 'new', status: 'queued', message: 'Waiting' });
    localStorage.setItem('fiberhmm-consensus-parameters-v2', JSON.stringify({ input: { frame: 'other' } }));
    const noJoin = { ...NFR_RESULT, class_join: null };
    useAccessibilityStore.setState({ result: noJoin });
    vi.mocked(api.getAccessibilityJob).mockResolvedValue({ ...COMPLETE_JOB, result: noJoin,
      request: { dataset_ids: ['ds1'], chrom: 'chr19', start: 1, end: 9, parameters: { stringency: 0.85 }, chemistry_overrides: { ds1: 'ddda' } } as any });
    await renderPanel('coaccess');
    await wait(20);
    await click(q(container, 'nfr-class-rerun'));
    const sent = vi.mocked(api.startAccessibility).mock.calls[0][0];
    expect(sent).toMatchObject({ dataset_ids: ['ds1'], start: 1, end: 9, parameters: { stringency: 0.85 }, chemistry_overrides: { ds1: 'ddda' } });
    expect(sent).not.toHaveProperty('loader_parameters');
  });

  it('a class linked from another Find classes run is not marked as this card\'s class (Codex review)', async () => {
    vi.mocked(api.getNfrClasses).mockReset().mockResolvedValue({ nfr: 'N1', class_job: 'clsA', joined: 'run', reason: null, classes: [
      { id: 'class_009', class_id: 'class_009', label: 'class 009', start: 47518300, end: 47518330, prevalence: .2, inside: [], layers: {} },
    ] });
    await renderPanel();
    await act(async () => { window.dispatchEvent(new CustomEvent(FOCUS_NFR_EVENT, { detail: { jobId: COMPLETE_JOB.job_id, nfrId: 'N1', classId: 'class_009', classJob: 'clsB' } })); });
    await wait(120);
    expect(qa(container, 'nfr-class-row').filter(r => r.dataset.highlighted)).toHaveLength(0);
    expect(q(container, 'nfr-class-other-run')!.textContent).toContain('Class 009');
  });

  it('the Reads menu works from the keyboard and gives the focus back (Codex review)', async () => {
    await renderPanel();
    await click(q(container, 'nfr-card-open'));
    await wait(20);
    const trigger = q(container, 'nfr-reads-menu')!;
    await click(trigger);
    const items = q(container, 'nfr-reads-menu-items')!;
    expect(document.activeElement).toBe(q(items, 'nfr-saved-group'));
    await act(async () => { items.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(document.activeElement).toBe(q(items, 'nfr-saved-split-panels'));
    await act(async () => { items.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(items.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it('the card keeps its read actions in one Reads menu and explains prevalence against the read groups', async () => {
    await renderPanel();
    await click(q(container, 'nfr-card-open'));
    await wait(20);
    expect(q(container, 'nfr-card-head')!.dataset.sticky).toBe('true');
    expect(q(container, 'nfr-reads-menu')).not.toBeNull();
    expect(q(container, 'nfr-card-prevalence-note')!.textContent).toContain('Estimated molecule prevalence');
    expect(q(container, 'nfr-help-prevalence')!.textContent).toContain('most likely');
  });
});

describe('Find classes from an NFR card: the shared job status', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    resetJobs();
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    useBrowserStore.setState({ footprintGroups: [] } as never);
    useAccessibilityStore.setState({ highlightClass: null, classRevision: 0 });
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('before launch says roughly how long; while running shows the stage, elapsed time and Cancel', async () => {
    vi.mocked(api.getNfrClasses).mockReset().mockResolvedValue({ nfr: 'N1', class_job: null, joined: null, classes: [], reason: 'none' });
    vi.mocked(api.startNfrClassRun).mockReset().mockResolvedValue({ job_id: 'cj1', status: 'queued', existing: false });
    vi.mocked(cw.getConsensusJob).mockReset().mockResolvedValue({ job_id: 'cj1', status: 'running', stage: 'recaller_quantify', message: 'Counting',
      created_at: Date.now() / 1000 - 65, started_at: Date.now() / 1000 - 64, cr_mode: 'lattice_recaller' } as any);
    vi.mocked(cw.cancelConsensus).mockReset().mockResolvedValue({ job_id: 'cj1', status: 'cancelling', stage: 'recaller_quantify', message: '' } as any);
    const entry = { ...savedFromNfr('nfrjob', NFR_RESULT, NFR_RESULT.nfrs[0], ['ds1']), id: 'e1', savedAt: 1 };
    await act(async () => root.render(<NfrClasses entry={entry} names={['V1']} />));
    await wait(30);
    expect(q(container, 'nfr-find-classes-status-hint')!.textContent).toBe('Usually several minutes for a view this size.');
    await click(q(container, 'nfr-run-classes'));
    await wait(40);
    const status = q(container, 'nfr-find-classes-status')!;
    expect(status.dataset.state).toBe('running');
    expect(status.textContent).toContain('Counting each class on the molecules');
    expect(q(container, 'nfr-find-classes-status-elapsed')!.textContent).toMatch(/1m 0\ds elapsed/);
    await click(q(container, 'nfr-find-classes-status-cancel'));
    expect(cw.cancelConsensus).toHaveBeenCalledWith('cj1');
  });
});

describe('the read panel says what the NFR groups are', () => {
  it('a header chip with the groups and Restore previous grouping, only while the panel holds them', async () => {
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    useBrowserStore.setState({ clusterAssignments: { ds1: { r1: 7 } }, clusterOrder: { ds1: [7] }, clusterFocus: {}, _historyStack: [], _historyPointer: -1 } as never);
    useAccessibilityStore.setState({ applied: [], inspected: null });
    const panel = { id: 'p1', contentType: 'dataset', datasetId: 'ds1', subTracks: [], collapsed: false } as any;
    function Header() { const a = useNfrGroupsHeader({ panel, dataset: undefined, showLayoutChrome: true }); return <div data-testid="hdr">{a?.chips ?? null}</div>; }
    await act(async () => root.render(<Header />));
    expect(q(container, 'nfr-groups-chip')).toBeNull();
    const { applySplit } = await import('./nfrGrouping');
    await act(async () => { applySplit(COMPLETE_JOB.job_id, SPLIT, NFR_RESULT, { ds1: ['ds1'] }); });
    expect(q(container, 'nfr-groups-chip')!.textContent).toContain('N1 V1 × N1 V3');
    await click(q(container, 'nfr-groups-chip'));
    expect(q(container, 'nfr-groups-legend')!.textContent).toContain('Not informative');
    await click(q(container, 'nfr-groups-chip-restore'));
    expect(useBrowserStore.getState().clusterAssignments.ds1).toEqual({ r1: 7 });
    expect(q(container, 'nfr-groups-chip')).toBeNull();
    act(() => root.unmount()); container.remove();
  });

  it('offers Restore only while every panel still holds the grouping (Codex review)', async () => {
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    useBrowserStore.setState({ clusterAssignments: { ds1: { r1: 7 }, ds2: { q1: 7 } }, clusterOrder: {}, clusterFocus: {}, _historyStack: [], _historyPointer: -1 } as never);
    useAccessibilityStore.setState({ applied: [], inspected: null });
    const panel = { id: 'p1', contentType: 'dataset', datasetId: 'ds1', subTracks: [], collapsed: false } as any;
    function Header() { const a = useNfrGroupsHeader({ panel, dataset: undefined, showLayoutChrome: true }); return <div>{a?.chips ?? null}</div>; }
    await act(async () => root.render(<Header />));
    const { applySplit } = await import('./nfrGrouping');
    await act(async () => { applySplit(COMPLETE_JOB.job_id, { ...SPLIT, by_dataset: { ds1: { r1: 0 }, ds2: { q1: 1 } } }, NFR_RESULT, { ds1: ['ds1'], ds2: ['ds2'] }); });
    // the other panel is regrouped
    await act(async () => { useBrowserStore.getState().setClusterAssignments('ds2', { q1: 3 }, { mirror: false }); });
    await click(q(container, 'nfr-groups-chip'));
    expect(q(container, 'nfr-groups-chip-restore')).toBeNull();
    expect(q(container, 'nfr-groups-chip-partial')).not.toBeNull();
    act(() => root.unmount()); container.remove();
  });
});
