/**
 * Usability round 2 (NFR panel): Find disabled without a dataset and errors in plain words (N10), the class table's
 * link beside the class and wrapping cells (N18), class counts with their scope (N11), the Find classes tiles as a
 * determinate bar (N6), the variant rows on the shared CheckboxRow, the legend's grammar (N14), the card's view tabs
 * sticky under its identity row (NFR-8), and the "each read in one group" note beside the prevalence.
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
import { DEFAULT_PAIR_FILTER, plainError } from './accessibilityView';
import { resetJobs } from './nfrJobs';
import { NfrClasses } from './accessibility/NfrClasses';
import { savedFromNfr } from './savedNfrVariants';
import { resetRunNames, useRunNamesStore } from '../../utils/runNames';
import { nfrProgress, nfrStageProgress, nfrStageTitle, nfrStepIndex } from './nfrProgress';

vi.mock('../../api/consensusWorkflow', async importOriginal => ({
  ...(await importOriginal<typeof import('../../api/consensusWorkflow')>()), getConsensusJob: vi.fn(), cancelConsensus: vi.fn(), getConsensusJobs: vi.fn(),
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
const at = (h: number, m: number) => new Date(2026, 9, 6, h, m).getTime() / 1000;

const CLASS = {
  id: 'class_025', class_id: 'class_025', label: 'class 25', start: 47518180, end: 47518220, prevalence: .3, inside: ['V1'],
  layers: Object.fromEntries(['V1', 'V2', 'V3'].map(n => [n, { reads: 100, open: 90, labelled: 80, unlabelled_open: 10, footprinted: 30,
    excluded_members: { nucleosome: 0, linker: 0 }, p_open: .37, ci_open: [.3, .4], p_fp_given_open: .26, ci_fp_given_open: [.2, .3], p_footprinted: .1,
    stack: { closed: .63, open_unfootprinted: .27, open_footprinted: .1 } }])),
};

describe('NFR panel, usability round 2', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.mocked(api.getAccessibilityJobs).mockReset().mockResolvedValue({ jobs: [{ ...COMPLETE_JOB, result: undefined }] });
    vi.mocked(api.getAccessibilityJob).mockReset().mockResolvedValue(COMPLETE_JOB);
    vi.mocked(api.getNfrOverview).mockReset().mockResolvedValue({ nfr: 'N1', x: [0, 1], step: 10, all: { profile: [0.3, 0.3], n: 2661 }, variants: {} });
    vi.mocked(api.getNfrMotifs).mockReset().mockReturnValue(new Promise(() => {}));
    vi.mocked(api.getClassStatus).mockReset().mockResolvedValue({ class_job: null, joined: null, classes: 0, reason: 'none' });
    vi.mocked(cw.getConsensusJobs).mockReset().mockResolvedValue({ jobs: [], active_job: null } as any);
    useAccessibilityStore.setState({ jobId: COMPLETE_JOB.job_id, result: NFR_RESULT, showArcs: false, arcSelection: 'significant', showClassArcs: true, applied: [],
      ...DEFAULT_PAIR_FILTER, focus: null, panelTab: 'nfrs', listFilter: 'all', openCard: null, focusedVariant: null, showEarlier: false, untickedLive: {},
      listScroll: null, inspected: null, cardView: {}, highlightClass: null });
    resetJobs();
    resetRunNames();
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({
      chrom: 'chr19', start: 47517650, end: 47518985,
      datasets: [{ id: 'ds1', label: 'napa_ddda', color: '#3b82f6', path: 'x' }],
      panels: [{ id: 'p1', contentType: 'dataset', datasetId: 'ds1', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 }],
      selectedDatasets: new Set(), clusterAssignments: {}, clusterOrder: {}, clusterFocus: {},
      savedNfrVariants: [], footprintGroups: [], selectedFeatures: [], _historyStack: [], _historyPointer: -1,
    } as never);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  async function renderPanel(tab: 'nfrs' | 'coaccess' = 'nfrs') {
    useAccessibilityStore.setState({ panelTab: tab });
    await act(async () => root.render(<AccessibilityPanel />));
    await wait(30);
  }

  it('with no dataset, Find is off and the panel says "Open a BAM or choose one in the Library" (N10, R12)', async () => {
    useBrowserStore.setState({ datasets: [], panels: [] } as never);
    useAccessibilityStore.setState({ jobId: null, result: null });
    vi.mocked(api.getAccessibilityJobs).mockResolvedValue({ jobs: [] });
    await renderPanel();
    const find = q(container, 'nfr-find') as HTMLButtonElement;
    expect(find.textContent).toBe('Find NFR variants');
    expect(find.disabled).toBe(true);
    expect(q(container, 'nfr-no-data')!.textContent).toBe('Open a BAM or choose one in the Library');   // the one empty state (R12)
    expect(q(container, 'nfr-no-data-library')).not.toBeNull();
    await click(find);
    expect(api.startAccessibility).not.toHaveBeenCalled();
  });

  it('a dataset with no assay type: the same setup card as Footprints, not an error (owner, round 3)', async () => {
    useAccessibilityStore.setState({ jobId: null, result: null });
    vi.mocked(api.getAccessibilityJobs).mockResolvedValue({ jobs: [] });
    await renderPanel();
    const find = q(container, 'nfr-find') as HTMLButtonElement;
    expect(find.disabled).toBe(true);
    expect(find.textContent).toBe('Set up datasets to continue');
    expect(find.title).toContain('Set the assay type of napa_ddda first');
    expect(q(container, 'nfr-dataset-setup')).not.toBeNull();
    expect(q(container, 'nfr-no-data')).toBeNull();
    await click(find);
    expect(api.startAccessibility).not.toHaveBeenCalled();
    // Set (as the card's Save does): Find comes back and the card goes.
    await act(async () => useBrowserStore.setState({ datasets: [{ id: 'ds1', label: 'napa_ddda', color: '#3b82f6', path: 'x', consensus_chemistry: 'ddda' }] } as never));
    await wait(10);
    expect((q(container, 'nfr-find') as HTMLButtonElement).textContent).toBe('Find NFR variants');
    expect((q(container, 'nfr-find') as HTMLButtonElement).disabled).toBe(false);
    expect(q(container, 'nfr-dataset-setup')).toBeNull();
  });

  it('two regions in the targeted panels: Find stays off but does not say "Open a BAM" (Codex)', async () => {
    useBrowserStore.setState({
      datasets: [{ id: 'ds1', label: 'a', color: '#3b82f6', path: 'x' }, { id: 'ds2', label: 'b', color: '#ef4444', path: 'y' }],
      panels: [{ id: 'p1', contentType: 'dataset', datasetId: 'ds1', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 },
        { id: 'p2', contentType: 'dataset', datasetId: 'ds2', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0,
          viewportOverride: { chrom: 'chr2', start: 100, end: 5000 } }],
    } as never);
    await renderPanel();
    const find = q(container, 'nfr-find') as HTMLButtonElement;
    expect(find.disabled).toBe(true);
    expect(find.textContent).toBe('Find NFR variants');
    expect(find.title).toContain('different regions');
    expect(q(container, 'nfr-no-data')).toBeNull();
  });

  it('server refusals in plain words, never "API error 422" (N10)', () => {
    expect(plainError(new Error('API error 422: Select one or more distinct datasets'))).toBe('There is no dataset in view to analyse. Open a BAM or choose one in the Library.');
    expect(plainError(new Error('API error 422: region too large'))).toBe('Region too large');
    expect(plainError(new Error('API error 422'))).toBe('The server did not accept this request (error 422).');
    expect(plainError(new Error('API error 500: boom'))).toBe('The server failed: boom');
    expect(plainError(new Error('Failed to fetch'))).toBe('Failed to fetch');
  });

  it('the legend asks "What are the variant types?" (N14)', async () => {
    await renderPanel();
    expect(q(container, 'nfr-legend-types')!.getAttribute('aria-label')).toBe('What are the variant types?');
    expect(q(container, 'nfr-legend-callable')!.getAttribute('aria-label')).toBe('What is callable?');
  });

  it('variant rows are CheckboxRows (16-px box, the row toggles it); shift-click still selects without ticking', async () => {
    await renderPanel();
    const card = () => qa(container, 'nfr-card')[0];
    const row = qa(card(), 'nfr-variant-row').find(r => r.dataset.variant === 'N1:V2')!;
    const label = q(row, 'nfr-variant-check')!;
    const input = q(row, 'nfr-variant-check-input') as HTMLInputElement;
    expect(label.tagName).toBe('LABEL');
    expect(label.className).toContain('min-h-[24px]');
    expect(input.className).toContain('h-4 w-4');
    expect(input.checked, 'V2 starts ticked').toBe(true);
    await click(row.querySelector('.font-semibold'));                          // the words toggle it
    expect((q(qa(card(), 'nfr-variant-row').find(r => r.dataset.variant === 'N1:V2')!, 'nfr-variant-check-input') as HTMLInputElement).checked, 'V2 unticked by its words').toBe(false);
    const v3 = qa(card(), 'nfr-variant-row').find(r => r.dataset.variant === 'N1:V3')!;
    await act(async () => { v3.querySelector('.font-semibold')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true })); });
    expect(useBrowserStore.getState().selectedFeatures.map(f => f.id)).toEqual(['N1:V3']);
    expect((q(qa(card(), 'nfr-variant-row').find(r => r.dataset.variant === 'N1:V3')!, 'nfr-variant-check-input') as HTMLInputElement).checked, 'V3 still ticked').toBe(true);     // shift-click selects, doesn't untick
    // a modifier click on the box itself: selects, and neither the box nor the card's ticked variants change (Codex)
    const v1 = () => qa(card(), 'nfr-variant-row').find(r => r.dataset.variant === 'N1:V1')!;
    const ticked = card().dataset.variants;
    await act(async () => { q(v1(), 'nfr-variant-check-input')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })); });
    expect(useBrowserStore.getState().selectedFeatures.map(f => f.id)).toEqual(['N1:V3', 'N1:V1']);
    expect(card().dataset.variants).toBe(ticked);
    expect((q(v1(), 'nfr-variant-check-input') as HTMLInputElement).checked).toBe(true);
  });

  it('an open card keeps its view tabs sticky under its identity row (NFR-8), and says the split puts each read in one group', async () => {
    useAccessibilityStore.setState({ openCard: `${COMPLETE_JOB.job_id}|N1` });
    await renderPanel();
    const card = qa(container, 'nfr-card').find(c => c.dataset.nfr === 'N1')!;
    expect(card.style.getPropertyValue('--nfr-card-head-h')).toMatch(/px$/);
    const tabs = q(card, 'nfr-card-views-tabs')!;
    expect(tabs.className).toContain('sticky');
    expect(tabs.style.top).toContain('var(--nfr-card-head-h');
    expect(q(card, 'nfr-card-one-group')!.textContent).toContain('each read in one group');
  });

  it('a starred card of another run, open, has the same sticky identity row (Codex)', async () => {
    vi.mocked(api.getAccessibilityJobs).mockResolvedValue({ jobs: [{ ...COMPLETE_JOB, result: undefined }, { ...COMPLETE_JOB, job_id: 'old', result: undefined }] });
    const stored = { ...savedFromNfr('old', { ...NFR_RESULT, region: { chrom: 'chr2', start: 1, end: 5000 } }, { ...NFR_RESULT.nfrs[0], start: 100, end: 400 }, ['ds1']), chrom: 'chr2' };
    useBrowserStore.getState().addSavedNfrVariants([stored]);
    useAccessibilityStore.setState({ showEarlier: true, openCard: `old|${stored.nfrId}` });
    await renderPanel();
    const card = q(container, 'nfr-earlier')!.querySelector<HTMLElement>('[data-testid="nfr-card"][data-stored="true"]')!;
    const head = q(card, 'nfr-card-head')!;
    expect(head.className).toContain('sticky');
    expect(card.style.getPropertyValue('--nfr-card-head-h')).toMatch(/px$/);
  });

  it('class counts in Co-accessibility say their scope and their run by its short name (N11)', async () => {
    useRunNamesStore.getState().note('footprint', [{ job_id: 'cls9abcd', created_at: at(14, 2) }]);
    vi.mocked(api.getClassStatus).mockResolvedValue({ class_job: 'cls9abcd', joined: 'posthoc', classes: 120, reason: null });
    const noJoin = { ...NFR_RESULT, class_join: null };
    useAccessibilityStore.setState({ result: noJoin });
    vi.mocked(api.getAccessibilityJob).mockResolvedValue({ ...COMPLETE_JOB, result: noJoin });
    await renderPanel('coaccess');
    expect(q(container, 'nfr-class-join')!.textContent).toContain('120 classes in this window (Footprint run 1 · 6 Oct 14:02) found after this run');
  });
});

describe('Find NFR variants\' progress uses the Find classes layout (owner request)', () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => {
    resetJobs(); localStorage.clear();
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    useAccessibilityStore.setState({ jobId: null, result: null, panelTab: 'nfrs', listFilter: 'all', openCard: null, cardView: {}, highlightClass: null });
    useBrowserStore.setState({
      chrom: 'chr19', start: 47517650, end: 47518985, datasets: [{ id: 'ds1', label: 'napa_ddda', color: '#3b82f6', path: 'x' }],
      panels: [{ id: 'p1', contentType: 'dataset', datasetId: 'ds1', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 }],
      savedNfrVariants: [], footprintGroups: [], selectedFeatures: [], clusterAssignments: {},
    } as never);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });
  const running = (stage: string, message: string, progress: object | undefined) => ({
    job_id: 'run9', status: 'running' as const, stage, message, created_at: Date.now() / 1000 - 30, started_at: Date.now() / 1000 - 29,
    progress: progress as never,
  });
  async function show(job: ReturnType<typeof running>) {
    vi.mocked(api.getAccessibilityJobs).mockReset().mockResolvedValue({ jobs: [job] });
    vi.mocked(api.getAccessibilityJob).mockReset().mockResolvedValue(job);
    await act(async () => root.render(<AccessibilityPanel />));
    await wait(30);
    return q(container, 'nfr-progress')!;
  }

  it('loading: the step strip, a plain title, the raw message as the detail line, stripes for an unknown total', async () => {
    const box = await show(running('loading', 'amp_DddB_full: loading all regional observations (dddb)', { stage: 'loading', completed: null, total: null, fraction: null }));
    const steps = q(box, 'nfr-progress-steps')!;
    expect([...steps.querySelectorAll('[role="listitem"]')].map(s => s.textContent)).toEqual(['Load reads', 'Find NFR variants', 'NFR pairs', 'Save results']);
    expect(steps.textContent).toContain('Step 1 of 4');
    expect(box.querySelector('strong')!.textContent).toBe('Loading reads');
    expect(q(box, 'nfr-progress-message')!.textContent).toBe('amp_DddB_full: loading all regional observations (dddb)');
    expect(q(box, 'nfr-progress-fill')!.dataset.indeterminate).toBe('true');
  });

  it('finding variants: a determinate bar that names the NFR ("NFR 3 of 9"); pair tests counted', async () => {
    let box = await show(running('nfr', 'N3 (3/9, 15040333-15041063): prediction strength k=2/8', { stage: 'nfr', completed: 30, total: 90, fraction: 1 / 3 }));
    expect(box.querySelector('strong')!.textContent).toBe('Finding NFR variants');
    expect(q(box, 'nfr-progress-steps')!.textContent).toContain('Step 2 of 4');
    expect(q(box, 'nfr-progress-bar-text')!.textContent).toBe('NFR 3 of 9');   // the step strip names the step (R5)
    expect(box.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('33');
    act(() => root.unmount()); root = createRoot(container);
    box = await show(running('coaccess', 'Pair tests 120/300', { stage: 'coaccess', completed: 120, total: 300, fraction: .4 }));
    expect(q(box, 'nfr-progress-bar-text')!.textContent).toBe('120 / 300 pair tests completed');
    expect(q(box, 'nfr-progress-steps')!.textContent).toContain('Step 3 of 4');
    // the combination patterns after the pair tests: named, in the same step (R5)
    act(() => root.unmount()); root = createRoot(container);
    box = await show(running('combinations', 'Combination patterns of 6 elements', undefined));
    expect(q(box, 'nfr-progress-bar-text')!.textContent).toContain('Pair tests done · testing combination patterns');
    expect(q(box, 'nfr-progress-steps')!.textContent).toContain('Step 3 of 4');
  });
});

describe('an NFR card\'s Footprints view (N11, N18, N6)', () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => {
    resetJobs(); resetRunNames();
    vi.mocked(cw.getConsensusJobs).mockReset().mockResolvedValue({ jobs: [{ job_id: 'other', created_at: at(13, 0) }, { job_id: 'cls1', created_at: at(14, 2) }], active_job: null } as any);
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    useBrowserStore.setState({ footprintGroups: [], openAnalysisPanel: vi.fn() } as never);
    useAccessibilityStore.setState({ highlightClass: null, classRevision: 0 });
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });
  const entry = () => ({ ...savedFromNfr('nfrjob', NFR_RESULT, NFR_RESULT.nfrs[0], ['ds1']), id: 'e1', savedAt: 1 });

  it('"5 classes in N1 · Footprint run 2 · 6 Oct 14:02"; the link sits beside the class; no fixed-width last column', async () => {
    vi.mocked(api.getNfrClasses).mockReset().mockResolvedValue({ nfr: 'N1', class_job: 'cls1', joined: 'posthoc', classes: [CLASS, { ...CLASS, id: 'c2', class_id: 'class_026' }] });
    vi.mocked(api.getNfrCooccupancy).mockReset().mockResolvedValue({ nfr: 'N1', class_job: 'cls1', definition: 'x', pairs: [] });
    await act(async () => root.render(<NfrClasses entry={entry()} names={['V1', 'V2', 'V3']} />));
    await wait(40);
    expect(q(container, 'nfr-class-count')!.textContent).toBe('2 classes in N1');
    expect(q(container, 'nfr-class-run')!.textContent).toBe('Footprint run 2 · 6 Oct 14:02');
    expect(q(container, 'nfr-class-status')!.title).toContain('cls1');
    const row = qa(container, 'nfr-class-row')[0];
    const nameCell = q(row, 'nfr-class-name-cell')!;
    expect(q(nameCell, 'nfr-class-show')).not.toBeNull();                       // beside the class name, in the first column
    expect(row.querySelectorAll('td')).toHaveLength(1 + 3);                      // class + one per variant: no link column
    expect(nameCell.textContent).toContain('47,518,180');                        // the span moved under the name
    const bar = row.querySelector('[data-testid="nfr-layer-bar"]')!;
    expect(bar.getAttribute('width')).toBe('100%');                              // the bar shrinks with the card
    expect(q(row, 'nfr-class-cell')!.textContent).toBe('37% · 26%');             // one line; the column heads say open · fp (R4)
    expect(q(row, 'nfr-class-cell')!.title).toBe('V1: open 37% · footprinted when open 26%');
  });

  it('Find classes from the card: the tiles as a determinate bar (N6)', async () => {
    vi.mocked(api.getNfrClasses).mockReset().mockResolvedValue({ nfr: 'N1', class_job: null, joined: null, classes: [], reason: 'none' });
    vi.mocked(api.startNfrClassRun).mockReset().mockResolvedValue({ job_id: 'cj1', status: 'queued', existing: false });
    vi.mocked(cw.getConsensusJob).mockReset().mockResolvedValue({ job_id: 'cj1', status: 'running', stage: 'recaller_discovery',
      message: 'tile 44/59 15040000-15042000: 2387 molecules', created_at: Date.now() / 1000 - 130, started_at: Date.now() / 1000 - 130,
      cr_mode: 'lattice_recaller', progress: { stage: 'recaller_discovery', task: 'recaller_discovery', completed: null, total: null, fraction: null, stage_started_at: 0, semantics: '' } } as any);
    await act(async () => root.render(<NfrClasses entry={entry()} names={['V1']} />));
    await wait(30);
    await click(q(container, 'nfr-run-classes'));
    await wait(40);
    const status = q(container, 'nfr-find-classes-status')!;
    expect(status.textContent).toContain('tile 44 of 59');
    expect(status.textContent).not.toContain('Find classes: tile');           // the step strip names the step (R5)
    expect(status.textContent).not.toContain('total not yet known');
    expect(status.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('75');
    expect(q(container, 'nfr-find-classes-status-fill')!.dataset.indeterminate).toBeUndefined();
  });
});

describe('nfrProgress helpers', () => {
  it('map the engine\'s stages to steps, titles and counts', () => {
    expect(nfrStepIndex({ stage: 'native' })).toBe(0);
    expect(nfrStepIndex({ stage: 'combinations' })).toBe(2);
    expect(nfrStepIndex({ stage: 'finalizing' })).toBe(3);
    expect(nfrStageTitle({ stage: 'native' })).toBe('Replaying the native caller');
    expect(nfrStageTitle({ stage: 'mystery' })).toBe('Working');
    expect(nfrProgress({ stage: 'native', progress: { stage: 'native', completed: 32, total: 64, fraction: .5, unit: 'alignments' } }))
      .toMatchObject({ completed: 32, total: 64, unit: 'alignments' });
    expect(nfrProgress({ stage: 'nfr', progress: { stage: 'nfr', completed: 3, total: 9, fraction: 1 / 3 } })).toEqual({ fraction: 1 / 3 });
    expect(nfrStageProgress({ stage: 'nfr', message: 'N1 (1/4, 10-20): bootstrap 50/200' })).toEqual({ label: 'Find NFR variants', noun: 'NFR', completed: 1, total: 4 });
    expect(nfrStageProgress({ stage: 'nfr', message: '2,000 molecules in chr3L:1-2' })).toBeNull();
  });
});
