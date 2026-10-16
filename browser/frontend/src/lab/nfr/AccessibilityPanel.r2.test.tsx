import { scrollIntoViewWithin } from '../../utils/scrollWithin';
import '../testSetup';  // temporary: moves with the NFR panel into src/lab/
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useAccessibilityStore } from './accessibilityStore';
import * as api from './api';
import { AccessibilityPanel } from './AccessibilityPanel';
import { COMPLETE_JOB, NFR_RESULT } from './accessibility/fixture';
import { DEFAULT_PAIR_FILTER } from './accessibilityView';
import { resetJobs } from './nfrJobs';
import { FOCUS_NFR_EVENT } from './nfrLinks';
import { downloadTextFile } from '../../utils/analysisExport';
import { clearNfrSequenceCache } from './nfrSequence';
import { loadSavedNfrVariants, SAVED_NFR_VARIANTS_STORAGE_KEY, savedFromNfr } from './savedNfrVariants';

vi.mock('../../utils/scrollWithin', () => ({ scrollIntoViewWithin: vi.fn() }));

vi.mock('../../utils/analysisExport', async importOriginal => ({
  ...(await importOriginal<typeof import('../../utils/analysisExport')>()),
  downloadTextFile: vi.fn(),
}));

vi.mock('./api', async importOriginal => ({
  ...(await importOriginal<typeof import('./api')>()),
  startAccessibility: vi.fn(),
  getAccessibilityJob: vi.fn(),
  getAccessibilityJobs: vi.fn(),
  getAccessibilityGroups: vi.fn(),
  cancelAccessibility: vi.fn(),
  getNfrOverview: vi.fn(),
  splitAccessibilityReads: vi.fn(),
  getVariantMotifs: vi.fn(),
  getNfrMotifs: vi.fn(),
  startNfrClassRun: vi.fn(),
  getNfrShape: vi.fn(),
  getNfrSequence: vi.fn(),
  getNfrVPlots: vi.fn(),
  getNfrPhasing: vi.fn(),
  getNfrPrevalence: vi.fn(),
  getVariantShape: vi.fn(),
  getVariantSequence: vi.fn(),
  getVariantVPlots: vi.fn(),
  getVariantPhasing: vi.fn(),
  getVariantPrevalence: vi.fn(),
  startVariantTransfer: vi.fn(),
  getVariantTransfer: vi.fn(),
  cancelVariantTransfer: vi.fn(),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const q = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (c: HTMLElement, id: string) => [...c.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
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
  excluded: { shared: 272, not_spanning_a: 92 }, excluded_text: { shared: 'one opening covers both (shared)', not_spanning_a: 'no state for N1 V1' },
  strata: [{ channel: 'ds1::CT', quintile: 1, n: 240, openness: [0.1, 0.2], table: [20, 30, 30, 160], log2or: 1.7 }],
  spacing: { kind: 'between', reads: 198, median: 160, q1: 150, q3: 175, note: 'On 198 molecules with both open, about one nucleosome separates the two openings (median 160 bp, IQR 150–175).' },
  profiles: Object.fromEntries(['11', '10', '01', '00', 'na'].map(k => [k, { x: [1, 2, 3], accessibility: [0.2, 0.8, 0.3], n: [5, 5, 5], reads: 5 }])),
  window: [47517850, 47518810],
};

describe('Accessibility (preview), round 2: drill-down, one NFR list with stars, the open card\'s views', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.mocked(api.getAccessibilityJobs).mockReset().mockResolvedValue({ jobs: [{ ...COMPLETE_JOB, result: undefined }] });
    vi.mocked(api.getAccessibilityJob).mockReset().mockResolvedValue(COMPLETE_JOB);
    vi.mocked(api.getNfrOverview).mockReset().mockResolvedValue({ nfr: 'N1', x: [0, 1], step: 10, all: { profile: [0.3, 0.3], n: 2661 }, variants: {} });
    vi.mocked(api.splitAccessibilityReads).mockReset().mockResolvedValue(SPLIT);
    // N1 shown as its variants (the fold state is tested in AccessibilityPanel.render.test.tsx)
    useAccessibilityStore.setState({ jobId: COMPLETE_JOB.job_id, result: NFR_RESULT, showArcs: false, arcSelection: 'significant', showClassArcs: true, applied: [],
      expanded: { [COMPLETE_JOB.job_id]: ['N1'] }, pairRequest: null, pairsView: 'arcs', ...DEFAULT_PAIR_FILTER, focus: null, panelTab: 'nfrs', listFilter: 'all', openCard: null, focusedVariant: null, showEarlier: false, untickedLive: {}, listScroll: null });
    clearNfrSequenceCache();
    resetJobs();
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({
      chrom: 'chr19', start: 47517650, end: 47518985,
      datasets: [{ id: 'ds1', label: 'napa_ddda', color: '#3b82f6', path: 'x' }, { id: 'ds2', label: 'napa_rep2', color: '#f59e0b', path: 'y' }],
      panels: [{ id: 'p1', contentType: 'dataset', datasetId: 'ds1', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 }],
      selectedDatasets: new Set(), clusterAssignments: { ds1: { r1: 7, r2: 8 } }, clusterOrder: { ds1: [7, 8] }, clusterFocus: {},
      savedNfrVariants: [], _historyStack: [], _historyPointer: -1,
    } as never);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  async function openCoaccess() {
    await act(async () => root.render(<AccessibilityPanel />));
    await wait(30);
    await click(button(container, 'NFR pairs'));
  }

  const card = (nfr = 'N1') => container.querySelector<HTMLElement>(`[data-testid="nfr-card"][data-nfr="${nfr}"]:not([data-stored])`)!;
  async function renderPanel() {
    await act(async () => root.render(<AccessibilityPanel />));
    await wait(30);
  }
  /** Open the card of N1 of the shown run in place. */
  async function openN1() {
    await click(q(card(), 'nfr-card-open'));
    await wait(20);
  }

  it('runs selected matched windows separately and retains both results', async () => {
    const { registerRegionAnalysis } = await import('../../utils/regionAnalysis');
    const { rigidMatchedRegions } = await import('../../utils/matchedRegions');
    const { useNfrRunsStore } = await import('./nfrRunsStore');
    registerRegionAnalysis({run:vi.fn(),link:vi.fn()});
    const s=useBrowserStore.getState();
    useBrowserStore.setState({datasets:s.datasets.map(d=>({...d,consensus_chemistry:'ddda'}))} as never);
    const id=s.upsertMatchedGroup({name:'Pair',regions:rigidMatchedRegions([
      {index:0,layer:0,chrom:'chr19',start:47517700,end:47517900},
      {index:1,layer:0,chrom:'chr19',start:47518500,end:47518700},
    ],'chr19')});
    s.selectMatchedGroup(id);
    vi.mocked(api.startAccessibility).mockImplementation(async request => ({ ...COMPLETE_JOB, job_id:`region-${request.start}`,request,
      result:{...NFR_RESULT,region:{chrom:request.chrom,start:request.start,end:request.end}} }));
    await renderPanel();
    await click(q(container,'nfr-region-matched'));
    expect(q(container,'nfr-region-method')!.textContent).toContain('separately');
    await click(q(container,'nfr-find'));
    expect(api.startAccessibility).toHaveBeenCalledTimes(2);
    expect(api.startAccessibility).toHaveBeenNthCalledWith(1,expect.objectContaining({start:47517700,end:47517900,parameters:expect.objectContaining({nfr_regions:[[47517700,47517900]]})}));
    expect(qa(container,'nfr-region-result')).toHaveLength(2);
    expect(useNfrRunsStore.getState().nfrRuns['region-47517700']).toBeDefined();
    expect(useNfrRunsStore.getState().nfrRuns['region-47518500']).toBeDefined();
  });

  it('clicking an arc inspects the pair (the read panels unchanged); Group reads by this pair puts its four groups there', async () => {
    const clustering = useBrowserStore.getState().clusterAssignments.ds1;
    await openCoaccess();
    const arc = qa(container, 'nfr-arc').find(a => a.dataset.pair === 'N1:V1|N1:V3')!;
    await act(async () => { arc.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await wait(10);
    expect(api.splitAccessibilityReads).toHaveBeenCalledWith(COMPLETE_JOB.job_id, { a: 'N1:V1', b: 'N1:V3' });
    // inspect only: the detail card, the read panels as they were
    expect(q(container, 'nfr-pair-detail')!.dataset.mode).toBe('inspect');
    expect(useBrowserStore.getState().clusterAssignments.ds1).toBe(clustering);
    expect(q(container, 'nfr-split-inspect-note')).not.toBeNull();
    await click(q(container, 'nfr-split-group-reads'));
    expect(api.splitAccessibilityReads).toHaveBeenCalledTimes(1);                  // the inspected split, not fetched again
    expect(q(container, 'nfr-pair-detail')!.dataset.mode).toBe('grouped');
    // the read panels hold the groups (cluster ids 0-3 the 2x2 cells, 4 not informative)
    const s = useBrowserStore.getState();
    expect(s.clusterAssignments.ds1).toEqual(SPLIT.by_dataset.ds1);
    expect(s.clusterOrder.ds1).toEqual([0, 1, 2, 3, 4]);
    expect(s.clusterPatterns).toEqual({ 0: [1, 1], 1: [1, 0], 2: [0, 1], 3: [0, 0] });
    const card = q(container, 'nfr-pair-detail')!;
    expect(qa(card, 'nfr-split-group').map(g => g.dataset.group)).toEqual(['11', '10', '01', '00']);
    expect(q(card, 'nfr-split-2x2')!.textContent).toContain('198');
    expect(q(card, 'nfr-split-na')!.textContent).toContain('364');
    expect(q(card, 'nfr-split-na')!.textContent).toContain('272 one opening covers both');
    const effect = q(card, 'nfr-split-effect')!;
    expect(effect.textContent).toContain('Adjusted log₂ OR (openness strata pooled): +1.61');
    expect(effect.textContent).toContain('q 1.8e-21');
    expect(effect.title).toContain('Pooled log₂ OR (unadjusted) +1.69');
    expect(q(card, 'nfr-split-spacing')!.textContent).toContain('about one nucleosome');
    expect(q(card, 'nfr-split-profiles')).not.toBeNull();
    await click(q(card, 'nfr-split-strata-toggle'));
    expect(q(card, 'nfr-split-strata')!.textContent).toContain('Q1');
    expect(qa(container, 'nfr-arc').find(a => a.dataset.pair === 'N1:V1|N1:V3')!.dataset.selected).toBe('true');
    // a group chip focuses that group in the read panels
    await click(qa(card, 'nfr-split-group')[0]);
    expect([...(useBrowserStore.getState().clusterFocus.ds1 ?? [])]).toEqual([0]);
    // Restore previous grouping returns to the clustering the split replaced
    expect(q(card, 'nfr-split-clear')!.textContent).toBe('Restore previous grouping');
    await click(q(card, 'nfr-split-clear'));
    expect(useBrowserStore.getState().clusterAssignments.ds1).toBe(clustering);
    expect(q(container, 'nfr-pair-detail')).toBeNull();
  });

  it('an element then a second one inspects their pair; a pair picked on the NFR track opens here; folded NFRs unfold for a pair inside', async () => {
    await openCoaccess();
    const element = (id: string) => container.querySelector(`[data-testid="nfr-element"][data-element="${id}"]`)!;
    await act(async () => { element('N1:V1').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(useAccessibilityStore.getState().focus).toBe('N1:V1');
    expect(element('N1:V1').getAttribute('data-focus')).toBe('true');
    await act(async () => { element('class_008').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await wait(10);
    expect(api.splitAccessibilityReads).toHaveBeenLastCalledWith(COMPLETE_JOB.job_id, { a: 'N1:V1', b: 'class_008' });
    // the inspected pair (the mock answers N1 V1 × N1 V3) is ringed on the arcs
    expect(element('N1:V3').getAttribute('data-in-pair')).toBe('true');
    expect(element('N1:V2').getAttribute('data-in-pair')).toBeNull();
    // overlapping variants: said in plain words, nothing asked of the server
    await act(async () => { element('N1:V1').dispatchEvent(new MouseEvent('click', { bubbles: true })); });   // deselect
    await act(async () => { element('N1:V1').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { element('N1:V2').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await wait(10);
    expect(api.splitAccessibilityReads).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('overlap: one opening cannot be two elements');
    // the NFR track asks for a pair (a folded N1 and the class): the panel inspects N1's strongest pair with it, and a
    // pair inside N1 unfolds N1 so its arc shows
    act(() => { useAccessibilityStore.setState({ expanded: {} }); });
    await act(async () => { useAccessibilityStore.getState().requestPair(COMPLETE_JOB.job_id, 'N1', 'class_008'); });
    await wait(10);
    expect(api.splitAccessibilityReads).toHaveBeenLastCalledWith(COMPLETE_JOB.job_id, { a: 'N1:V1', b: 'class_008' });
    expect(useAccessibilityStore.getState().pairRequest).toBeNull();
    await act(async () => { useAccessibilityStore.getState().requestPair(COMPLETE_JOB.job_id, 'N1:V1', 'N1:V3'); });
    await wait(10);
    expect(useAccessibilityStore.getState().expanded[COMPLETE_JOB.job_id]).toEqual(['N1']);
    expect(qa(container, 'nfr-arc').find(a => a.dataset.pair === 'N1:V1|N1:V3')).toBeDefined();
  });

  it('a matrix cell inspects too; grouped, then after an undo the card says the grouping was replaced', async () => {
    await openCoaccess();
    await click(button(container, 'Matrix'));
    const cell = qa(container, 'nfr-matrix-cell').find(c => c.dataset.pair === 'N1:V2|class_008')!;
    await click(cell);
    expect(api.splitAccessibilityReads).toHaveBeenCalledWith(COMPLETE_JOB.job_id, { a: 'N1:V2', b: 'class_008' });
    await wait(10);
    expect(q(container, 'nfr-pair-detail')!.dataset.mode).toBe('inspect');
    await click(q(container, 'nfr-split-group-reads'));
    // overlapping variants have no split
    const overlap = qa(container, 'nfr-matrix-cell').find(c => c.textContent === '×')!;
    await click(overlap);
    expect(api.splitAccessibilityReads).toHaveBeenCalledTimes(1);
    await act(async () => { useBrowserStore.getState().undo(); });
    await wait(10);
    expect(useBrowserStore.getState().clusterAssignments.ds1).toEqual({ r1: 7, r2: 8 });
    expect(q(container, 'nfr-split-reapply')).not.toBeNull();
  });

  it('splits by combination pattern', async () => {
    const withCombos = { ...NFR_RESULT, combos: { elements: ['N1:V1', 'class_008', 'N1:V3'], labels: [], n: 1200, n_spanning: 1300, n_shared_excluded: 100, status: 'ok', patterns: [] } };
    useAccessibilityStore.setState({ result: withCombos });
    vi.mocked(api.getAccessibilityJob).mockResolvedValue({ ...COMPLETE_JOB, result: withCombos });
    vi.mocked(api.splitAccessibilityReads).mockResolvedValue({ ...SPLIT, kind: 'combination', elements: ['N1:V1', 'class_008', 'N1:V3'], short: ['N1 V1', 'C008', 'N1 V3'],
      groups: [{ id: 0, key: '101', label: 'N1 V1+ C008− N1 V3+', molecules: 50, count: 1, pattern: [1, 0, 1] }, { id: 1, key: 'na', label: 'Not informative', molecules: 9, count: 1, pattern: null }],
      by_dataset: { ds1: { r1: 0, r2: 1 } }, pair: null });
    await openCoaccess();
    await click(q(container, 'nfr-split-combos'));
    expect(api.splitAccessibilityReads).toHaveBeenCalledWith(COMPLETE_JOB.job_id, { elements: ['N1:V1', 'class_008', 'N1:V3'] });
    await wait(10);
    expect(q(container, 'nfr-split-patterns')!.textContent).toContain('N1 V1+ C008− N1 V3+');
  });

  it('a star keeps an NFR (one entry, its ticked variants); the card opens in place to its analysis; Starred filters the same list', async () => {
    vi.mocked(api.getNfrMotifs).mockReset().mockResolvedValue({
      nfr: 'N1', window: [47517850, 47518810], region: [47513170, 47523510], variants: ['V1', 'V2', 'V3'],
      spans: { V1: [47518152, 47518247], V2: [47518219, 47518459], V3: [47518412, 47518513] }, members: { V1: 480, V2: 770, V3: 300 },
      species: { genome: 'hg38', taxid: 9606, inferred: false, name: 'human' },
      pinned: { requested: ['CTCF'], resolved: { CTCF: ['MA0139.2'] }, missing: [], substituted: {}, defaults: ['CTCF'], species: 'human' },
      threshold: { mode: 'p', p: 1e-4, relative: null, background: 'local', composition: { A: 0.3, C: 0.2, G: 0.2, T: 0.3 } },
      scanned: 720, unreachable: [], tested: 600, background: { bp: 9000, intervals: 3 }, with_sites: 1, sentences: [],
      families: [], warnings: [], seconds: 1, definitions: { sites: 's', background: 'b', enrichment: 'e', differential: 'd', families: 'f' },
    } as api.NfrMotifs);
    await renderPanel();
    // one list: the tabs are the NFRs and Co-accessibility; no Save buttons, no Saved tab
    expect([...container.querySelectorAll('[role="tab"], [data-testid="analysis-tabs"] button')].map(b => b.textContent?.trim()).filter(Boolean)).not.toContain('Saved');
    expect(q(container, 'nfr-save-selected')).toBeNull();
    expect(card().dataset.starred).toBe('false');
    // untick V2 on the card (its views leave it out), then star it: one entry, V2 unticked
    await click(qa(card(), 'nfr-variant-check').find(c => c.closest('[data-variant]')!.getAttribute('data-variant') === 'N1:V2')!);
    expect(card().dataset.variants).toBe('V1,V3');
    await click(q(card(), 'nfr-card-star'));
    let saved = useBrowserStore.getState().savedNfrVariants;
    expect(saved.map(e => e.nfrId)).toEqual(['N1']);
    expect(saved[0].variants.filter(v => v.shown).map(v => v.variantId)).toEqual(['N1:V1', 'N1:V3']);
    expect(card().dataset.starred).toBe('true');
    expect(card().dataset.entry).toBe(saved[0].id);
    expect(button(container, 'Starred').textContent).toBe('Starred (1)');
    // a tick on a starred card is the entry's
    await click(qa(card(), 'nfr-variant-check').find(c => c.closest('[data-variant]')!.getAttribute('data-variant') === 'N1:V2')!);
    saved = useBrowserStore.getState().savedNfrVariants;
    expect(saved[0].variants.every(v => v.shown)).toBe(true);
    // open in place: name and note, the read controls, the sequence, the views (motif map first)
    await openN1();
    expect(q(card(), 'nfr-card-open')!.getAttribute('aria-expanded')).toBe('true');
    expect(q(card(), 'nfr-card-name')).not.toBeNull();
    expect(q(card(), 'nfr-saved-controls')).not.toBeNull();
    expect(q(card(), 'nfr-card-sequence')).not.toBeNull();
    expect(q(card(), 'nfr-saved-inspect')).not.toBeNull();
    expect(api.getNfrMotifs).toHaveBeenCalledWith(COMPLETE_JOB.job_id, 'N1', expect.objectContaining({ mode: 'p', p: 1e-4, background: 'local' }));
    expect(q(card(), 'nfr-motif-map-empty')).not.toBeNull();
    const head = [...q(card(), 'nfr-motif-table')!.querySelectorAll('th')].map(t => t.textContent);
    expect(head).toEqual(expect.arrayContaining(['V1', 'V2', 'V3']));
    // the statistics are in the open card
    await click(q(card(), 'nfr-details-toggle'));
    expect(q(card(), 'nfr-details')!.textContent).toContain('by prediction strength');
    // Starred: the same card; unstarring takes it out of Starred (and the entry goes)
    await click(button(container, 'Starred'));
    expect(qa(container, 'nfr-card')).toHaveLength(1);
    await click(q(card(), 'nfr-card-star'));
    expect(useBrowserStore.getState().savedNfrVariants).toEqual([]);
    expect(qa(container, 'nfr-card')).toHaveLength(0);
    expect(q(container, 'nfr-starred-none-here')).not.toBeNull();
    await click(button(container, 'All'));
    expect(card().dataset.starred).toBe('false');
    // closing and reopening the panel keeps the stars (the browser store)
    await click(q(card(), 'nfr-card-star'));
    act(() => root.unmount());
    root = createRoot(container);
    await renderPanel();
    expect(button(container, 'Starred').textContent).toBe('Starred (1)');
  });

  it('migration: entries saved before (sessions, localStorage, the older per-variant format) are starred cards with every field', async () => {
    const other = { ...NFR_RESULT, region: { chrom: 'chr2', start: 1, end: 5000 } };
    const perNfr = { ...savedFromNfr(COMPLETE_JOB.job_id, NFR_RESULT, NFR_RESULT.nfrs[0], ['ds1'], ['N1:V1', 'N1:V3']), id: 'e1', savedAt: 5,
      name: 'NAPA promoter', note: 'check V3', color: '#123456' };
    const oldVariant = { id: 'old1', jobId: 'gonejob', chrom: 'chr2', variantId: 'N4:V2', start: 300, end: 520, relation: 'full', depth: 'pioneered', width: 220,
      prevalence: 0.41, strict: 0.38, ci: [0.36, 0.46], savedAt: 1, name: 'my favourite', note: 'from the poster', region: other.region, datasetIds: ['ds1'], callable: 900, reads: 950 };
    localStorage.setItem(SAVED_NFR_VARIANTS_STORAGE_KEY, JSON.stringify([perNfr, oldVariant]));
    useBrowserStore.setState({ savedNfrVariants: loadSavedNfrVariants() } as never);
    await renderPanel();
    // the shown run's entry: its card, starred, with its name, note, colour and ticks
    expect(card().dataset.starred).toBe('true');
    expect(card().dataset.entry).toBe('e1');
    expect(card().dataset.variants).toBe('V1,V3');
    expect(q(card(), 'nfr-card-feature')!.textContent).toContain('NAPA promoter');
    await openN1();
    const nameRow = q(card(), 'nfr-card-name')!;
    expect((nameRow.querySelector('input[type="text"]') as HTMLInputElement).value).toBe('NAPA promoter');
    expect((nameRow.querySelector('input[placeholder="Note"]') as HTMLInputElement).value).toBe('check V3');
    expect((nameRow.querySelector('input[type="color"]') as HTMLInputElement).value).toBe('#123456');
    // the older per-variant entry of a run this server no longer has: Earlier, its stored numbers, Go there
    expect(q(container, 'nfr-earlier-toggle')!.textContent).toContain('Earlier (1)');
    await click(q(container, 'nfr-earlier-toggle'));
    const stored = container.querySelector<HTMLElement>('[data-testid="nfr-card"][data-stored="true"]')!;
    expect(stored.dataset.nfr).toBe('N4');
    expect(stored.textContent).toContain('V2 41%');
    expect(stored.textContent).toContain('run not loaded');
    expect(q(stored, 'nfr-card-go')).not.toBeNull();
    const kept = useBrowserStore.getState().savedNfrVariants.find(e => e.nfrId === 'N4')!;
    expect(kept.note).toContain('my favourite');
    expect(kept.note).toContain('from the poster');
    // the Starred count holds both; nothing was dropped
    expect(button(container, 'Starred').textContent).toBe('Starred (2)');
  });

  it('a saved NFR\'s views put its variants side by side: V-plots, phasing, prevalence by group, the advanced plots, export', async () => {
    const { savedFromNfr } = await import('./savedNfrVariants');
    useBrowserStore.getState().addSavedNfrVariants([savedFromNfr(COMPLETE_JOB.job_id, NFR_RESULT, NFR_RESULT.nfrs[0], ['ds1'])]);
    vi.mocked(api.getNfrMotifs).mockReset().mockReturnValue(new Promise(() => {}));
    const quant = (n: number) => ({ n, p5: 1, q1: 2, median: 3, q3: 4, p95: 5, mean: 3 });
    const bnd = { minus1: quant(300), plus1: quant(300), minus1_size: quant(300), plus1_size: quant(300), minus1_dyads: [], plus1_dyads: [] };
    vi.mocked(api.getNfrShape).mockReset().mockResolvedValue({
      nfr: 'N1', variants: ['V1', 'V2', 'V3'],
      sizes: { step: 10, lo: 60, hi: 300, variants: { V1: { summary: quant(400), hist: [1, 2, 3] }, V2: { summary: quant(700), hist: [3, 2, 1] }, V3: { summary: quant(300), hist: [1, 1, 1] }, other: { summary: quant(10), hist: [1, 0, 0] } } },
      edges: { points: [[47518150, 47518250, 'V1'], [47518220, 47518460, 'V2']], total: 2, shown: 2, density: null, centres: { V1: [47518152, 47518247], V2: [47518219, 47518459], V3: [47518412, 47518513] } },
      boundary: { V1: bnd, V2: bnd, V3: bnd }, boundary_note: null,
    });
    vi.mocked(api.getNfrSequence).mockReset().mockResolvedValue({
      variant: null, nfr: 'N1', window: [47517850, 47518810],
      variants: {
        V1: { span: [47518152, 47518247], bp: 95, gc: 0.41, cpg: 1, cpg_oe: 0.75, tracts: [{ start: 47518200, end: 47518208, base: 'A', length: 8 }], tract_bp: 8 },
        V2: { span: [47518219, 47518459], bp: 240, gc: 0.52, cpg: 4, cpg_oe: 0.6, tracts: [], tract_bp: 0 },
        V3: { span: [47518412, 47518513], bp: 101, gc: 0.47, cpg: 2, cpg_oe: 0.5, tracts: [], tract_bp: 0 },
      },
      flanks: { left: { bp: 300, gc: 0.5, cpg: 3, cpg_oe: 0.4, tracts: [], tract_bp: 0 }, right: { bp: 300, gc: 0.5, cpg: 3, cpg_oe: 0.4, tracts: [], tract_bp: 0 } },
      gc_track: { x: [1, 2], gc: [0.4, 0.5], window: 50 }, tracts: [], definitions: { tracts: 'runs', cpg_oe: 'o/e' },
    });
    const m = { centre: [[0, 1], [1, 0]], coverage: [[0, 1], [1, 0]] };
    vi.mocked(api.getNfrVPlots).mockReset().mockResolvedValue({
      nfr: 'N1', window: [47517850, 47518810], step: 10, size: [60, 520], size_step: 10, count_all: 2000, names: ['V1', 'V2', 'V3'],
      all: { centre: [[1, 2], [3, 4]], coverage: [[1, 2], [3, 4]] },
      variants: { V1: { ...m, count: 480, span: [47518152, 47518247] }, V2: { ...m, count: 770, span: [47518219, 47518459] }, V3: { ...m, count: 300, span: [47518412, 47518513] } },
    });
    const series = (reads: number) => ({ x: [1, 2], occupancy: [0.8, 0.1], n: [reads, reads], reads });
    vi.mocked(api.getNfrPhasing).mockReset().mockResolvedValue({
      nfr: 'N1', window: [47517170, 47519510], names: ['V1', 'V2', 'V3'], all: series(2661),
      variants: { V1: { members: series(480), span: [47518152, 47518247], boundary: bnd }, V2: { members: series(770), span: [47518219, 47518459], boundary: bnd }, V3: { members: series(300), span: [47518412, 47518513], boundary: null } },
    });
    const pv = (p: number) => ({ prevalence: p, strict: p - 0.02, ci: [p - 0.05, p + 0.05] as [number, number] });
    vi.mocked(api.getNfrPrevalence).mockReset().mockResolvedValue({
      nfr: 'N1', names: ['V1', 'V2', 'V3'], note: 'frozen catalogue', datasets: [],
      tests: { datasets: null, groups: { groups: ['C7', 'C8'], reads: { C7: 1, C8: 1 }, configurations: ['V1', 'closed'], g: 12.3, df: 1, p: 4.5e-4, definition: 'G',
        variants: { V1: { share: { C7: 1, C8: 0 }, p: 1e-4, q: 3e-4 }, V2: { share: { C7: 0, C8: 0 }, p: null, q: null } } } },
      groups: [{ group: 'C7', callable: 1, reads: 1, variants: { V1: pv(0.9), V2: pv(0.05), V3: pv(0.05) } },
        { group: 'all', callable: 2661, reads: null, variants: { V1: pv(0.18), V2: pv(0.29), V3: pv(0.19) } }],
    });
    await renderPanel();
    await openN1();
    // the tabs: the motif map first, the footprints section, then V-plots, phasing, prevalence; the rest under Advanced
    expect([...q(container, 'nfr-saved-inspect')!.querySelectorAll('[data-testid="analysis-subtabs"] > button')].map(t => t.textContent))
      .toEqual(['Motifs', 'Footprints', 'V-plots', 'Phasing', 'Prevalence', 'Advanced', 'Export']);
    await click(button(container, 'Advanced'));
    await wait(20);
    expect(api.getNfrShape).toHaveBeenCalledWith(COMPLETE_JOB.job_id, 'N1');
    expect(q(container, 'nfr-width-plot')).not.toBeNull();
    expect(q(container, 'nfr-edge-plot')).toBeNull();                    // the edges plot is gone
    expect(q(container, 'nfr-boundary-plot')).not.toBeNull();
    const features = q(container, 'nfr-seq-features')!.textContent!;
    expect(features).toContain('41%');
    expect(features).toContain('52%');                                   // every variant in one table
    expect(features).toContain('1 (8 bp)');
    await click(button(container, 'V-plots'));
    await wait(20);
    expect(qa(container, 'nfr-vplot').map(v => v.dataset.variant)).toEqual(['all', 'V1', 'V2', 'V3']);
    expect(api.getNfrVPlots).toHaveBeenLastCalledWith(COMPLETE_JOB.job_id, 'N1', { step: 10, size_step: 10, pad: 300 });
    await act(async () => {
      const sel = container.querySelector('[aria-label="V-plot size bin"]') as HTMLSelectElement;
      sel.value = '20'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await wait(20);
    expect(api.getNfrVPlots).toHaveBeenLastCalledWith(COMPLETE_JOB.job_id, 'N1', { step: 10, size_step: 20, pad: 300 });
    await click(button(container, 'Phasing'));
    await wait(20);
    expect(q(container, 'nfr-phasing-boundary')!.textContent).toContain('V2');
    await click(button(container, 'Prevalence'));
    await wait(20);
    // the read panels' current groups go to the server, by read name per dataset
    expect(api.getNfrPrevalence).toHaveBeenCalledWith(COMPLETE_JOB.job_id, 'N1', { C7: { ds1: ['r1'] }, C8: { ds1: ['r2'] } }, 100);
    expect(q(container, 'nfr-prevalence-plot')).not.toBeNull();
    expect(q(container, 'nfr-usage-test-groups')!.textContent).toBe('Variant usage differs between read groups (p 4.5e-4)');
    expect(q(container, 'nfr-usage-test-groups')!.title).toContain('V1 q 3e-4');          // the details in the tooltip
    const table = q(container, 'nfr-prevalence-table')!.textContent!;
    expect(table).toContain('90%');
    expect(table).toContain('29%');
    expect(button(container, 'Quantify in napa_rep2')).toBeTruthy();
    await click(button(container, 'Export'));
    expect(q(container, 'nfr-export-members')!.getAttribute('href')).toContain(`/api/accessibility/jobs/${COMPLETE_JOB.job_id}/nfrs/N1/members.tsv`);
  });

  it('prevalence groups take each panel\'s own names: an SV allele split reads Carriers / Reference', async () => {
    const { savedFromNfr } = await import('./savedNfrVariants');
    useBrowserStore.setState({ clusterAssignments: { ds1: { r1: 0, r2: 1, r3: 2 } }, clusterOrder: { ds1: [0, 1, 2] },
      clusterGroupLabels: { ds1: { 0: 'Carriers', 1: 'Reference', 2: 'Not informative' } } } as never);
    useBrowserStore.getState().addSavedNfrVariants([savedFromNfr(COMPLETE_JOB.job_id, NFR_RESULT, NFR_RESULT.nfrs[0], ['ds1'])]);
    vi.mocked(api.getNfrMotifs).mockReset().mockReturnValue(new Promise(() => {}));
    vi.mocked(api.getNfrPrevalence).mockReset().mockReturnValue(new Promise(() => {}));
    await renderPanel();
    await openN1();
    await click(button(container, 'Prevalence'));
    await wait(20);
    expect(api.getNfrPrevalence).toHaveBeenCalledWith(COMPLETE_JOB.job_id, 'N1',
      { Carriers: { ds1: ['r1'] }, Reference: { ds1: ['r2'] }, 'Not informative': { ds1: ['r3'] } }, 100);
  });

  it('NFR group names stay on the panel they were applied to: another dataset\'s SV alleles keep theirs', async () => {
    const { savedFromNfr } = await import('./savedNfrVariants');
    const nfrGroups = { r1: 0, r2: 1 };
    useBrowserStore.setState({
      panels: [{ id: 'p1', contentType: 'dataset', datasetId: 'ds1', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 },
        { id: 'p2', contentType: 'dataset', datasetId: 'ds2', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 1 }],
      clusterAssignments: { ds1: nfrGroups, ds2: { s1: 0, s2: 1 } }, clusterOrder: { ds1: [0, 1], ds2: [0, 1] },
      clusterGroupLabels: { ds2: { 0: 'Carriers', 1: 'Reference', 2: 'Not informative' } },
    } as never);
    useAccessibilityStore.setState({ applied: [{ kind: 'pair', jobId: COMPLETE_JOB.job_id,
      grouping: { label: 'Split', written: { ds1: nfrGroups }, stash: {} as never },
      split: { ...SPLIT, groups: [{ ...SPLIT.groups[0], id: 0, label: 'V1+' }, { ...SPLIT.groups[1], id: 1, label: 'V1-' }] } }] });
    useBrowserStore.getState().addSavedNfrVariants([savedFromNfr(COMPLETE_JOB.job_id, NFR_RESULT, NFR_RESULT.nfrs[0], ['ds1', 'ds2'])]);
    vi.mocked(api.getNfrMotifs).mockReset().mockReturnValue(new Promise(() => {}));
    vi.mocked(api.getNfrPrevalence).mockReset().mockReturnValue(new Promise(() => {}));
    await renderPanel();
    await openN1();
    await click(button(container, 'Prevalence'));
    await wait(20);
    const groups = vi.mocked(api.getNfrPrevalence).mock.calls.at(-1)![2] as Record<string, unknown>;
    expect(Object.keys(groups).sort()).toEqual(['napa_ddda V1+', 'napa_ddda V1-', 'napa_rep2 Carriers', 'napa_rep2 Reference']);
  });

  /** N1's card > Prevalence on ds1 (and ds2): the read groups it asks for. */
  async function prevalenceGroups(datasetIds: string[]) {
    const { savedFromNfr } = await import('./savedNfrVariants');
    useBrowserStore.getState().addSavedNfrVariants([savedFromNfr(COMPLETE_JOB.job_id, NFR_RESULT, NFR_RESULT.nfrs[0], datasetIds)]);
    vi.mocked(api.getNfrMotifs).mockReset().mockReturnValue(new Promise(() => {}));
    vi.mocked(api.getNfrPrevalence).mockReset().mockReturnValue(new Promise(() => {}));
    await renderPanel();
    await openN1();
    await click(button(container, 'Prevalence'));
    await wait(20);
    return Object.keys(vi.mocked(api.getNfrPrevalence).mock.calls.at(-1)![2] as Record<string, unknown>).sort();
  }
  const panelOf = (id: string, datasetId: string, stateKey?: string, layoutRow = 0) =>
    ({ id, contentType: 'dataset', datasetId, stateKey, subTracks: [], collapsed: false, linkGroup: null, layoutRow });
  const splitNamed = (labels: string[]) => ({ ...SPLIT, groups: labels.map((label, id) => ({ ...SPLIT.groups[id % SPLIT.groups.length], id, label })) });

  it('two NFR groupings on two datasets: each panel keeps the names of the one it holds', async () => {
    const a = { r1: 0, r2: 1 }; const b = { s1: 0, s2: 1 };
    useBrowserStore.setState({ panels: [panelOf('p1', 'ds1'), panelOf('p2', 'ds2', undefined, 1)],
      clusterAssignments: { ds1: a, ds2: b }, clusterOrder: { ds1: [0, 1], ds2: [0, 1] }, clusterGroupLabels: {} } as never);
    useAccessibilityStore.setState({ applied: [
      { kind: 'pair', jobId: COMPLETE_JOB.job_id, grouping: { label: 'A', written: { ds1: a }, stash: {} as never }, split: splitNamed(['A+', 'A-']) },
      { kind: 'pair', jobId: COMPLETE_JOB.job_id, grouping: { label: 'B', written: { ds2: b }, stash: {} as never }, split: splitNamed(['B+', 'B-']) },
    ] } as never);
    expect(await prevalenceGroups(['ds1', 'ds2'])).toEqual(['napa_ddda A+', 'napa_ddda A-', 'napa_rep2 B+', 'napa_rep2 B-']);
  });

  it('a grouping on two panels of a dataset still names the panel not split since', async () => {
    const g = { r1: 0, r2: 1 };
    useBrowserStore.setState({ panels: [panelOf('p1', 'ds1', 'ds1'), panelOf('p2', 'ds1', 'p2', 1)],
      clusterAssignments: { ds1: g, p2: { r1: 1, r2: 0 } }, clusterOrder: { ds1: [0, 1], p2: [0, 1] },
      clusterGroupLabels: { p2: { 0: 'Carriers', 1: 'Reference' } } } as never);
    useAccessibilityStore.setState({ applied: [
      { kind: 'pair', jobId: COMPLETE_JOB.job_id, grouping: { label: 'A', written: { ds1: g, p2: g }, stash: {} as never }, split: splitNamed(['V1+', 'V1-']) },
    ] } as never);
    expect(await prevalenceGroups(['ds1'])).toEqual(['napa_ddda #1 V1+', 'napa_ddda #1 V1-', 'napa_ddda #2 Carriers', 'napa_ddda #2 Reference']);
  });

  it('an SV split back after Clear keeps its names, even with the cleared NFR groups\' membership', async () => {
    const g = { r1: 0, r2: 1 };
    useBrowserStore.setState({ panels: [panelOf('p1', 'ds1')],
      clusterAssignments: { ds1: { ...g } }, clusterOrder: { ds1: [0, 1] }, clusterGroupLabels: { ds1: { 0: 'Carriers', 1: 'Reference' } } } as never);
    useAccessibilityStore.setState({ applied: [
      { kind: 'pair', jobId: COMPLETE_JOB.job_id, grouping: { label: 'A', written: { ds1: g }, stash: {} as never }, split: splitNamed(['V1+', 'V1-']), dismissed: true },
    ] } as never);
    expect(await prevalenceGroups(['ds1'])).toEqual(['Carriers', 'Reference']);
  });

  it('a starred NFR whose run is gone is in Earlier with its numbers, and offers to find variants again there', async () => {
    useBrowserStore.getState().addSavedNfrVariants([{ ...savedFromNfr('gone', NFR_RESULT, NFR_RESULT.nfrs[0], ['ds1'], ['N1:V2']) }]);
    await renderPanel();
    // the shown run's own N1 card is not starred; the gone run's entry is set aside in Earlier, collapsed
    expect(card().dataset.starred).toBe('false');
    expect(q(container, 'nfr-earlier-toggle')!.textContent).toContain('Earlier (1)');
    expect(container.querySelector('[data-testid="nfr-card"][data-stored="true"]')).toBeNull();
    await click(q(container, 'nfr-earlier-toggle'));
    const stored = container.querySelector<HTMLElement>('[data-testid="nfr-card"][data-stored="true"]')!;
    expect(stored.textContent).toContain('run not loaded');
    expect(stored.textContent).toContain('Go there');
    await click(q(stored, 'nfr-card-open'));
    expect(q(stored, 'nfr-card-sequence')).toBeNull();                          // no run: no sequence, no views
    await click(button(container, 'Go there and find variants'));
    expect(q(container, 'nfr-find')).not.toBeNull();
    await click(q(container, 'nfr-settings-toggle'));
    expect((q(container, 'nfr-settings')!.querySelector('input[type="text"]') as HTMLInputElement).value).toBe('chr19:47518170-47518510');
  });

  it('the arcs cull to the strongest pairs: q, strength and top N, focus on one variant or NFR, and an expanded view', async () => {
    await openCoaccess();
    const pairs = () => qa(container, 'nfr-arc').map(a => a.dataset.pair).sort();
    expect(pairs()).toEqual(['N1:V1|N1:V3', 'N1:V1|class_008', 'N1:V2|class_008']);           // q <= 0.05, |log2 OR| >= 1
    expect(q(container, 'nfr-pair-counts')!.textContent).toContain('3 shown of 3 significant');
    await act(async () => { const r = q(container, 'nfr-min-effect') as HTMLInputElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(r, '1.75'); r.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(pairs()).toEqual(['N1:V1|class_008', 'N1:V2|class_008']);
    await act(async () => { const sel = q(container, 'nfr-top-n') as HTMLSelectElement; sel.value = '10'; sel.dispatchEvent(new Event('change', { bubbles: true })); });
    useAccessibilityStore.setState({ topN: 1 });
    await wait(5);
    expect(pairs()).toEqual(['N1:V1|class_008']);                                            // the strongest one
    useAccessibilityStore.setState({ minEffect: 0, topN: null });
    await wait(5);
    // click an element: only its connections; again: all
    const v3 = container.querySelector('[data-testid="nfr-element"][data-element="N1:V3"]')!;
    await act(async () => { v3.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(useAccessibilityStore.getState().focus).toBe('N1:V3');
    expect(pairs()).toEqual(['N1:V1|N1:V3']);
    // the matrix gets the same filters: the focused element and its partner only
    await click(button(container, 'Matrix'));
    // (the square is mirrored: the pair's cell above and below the diagonal)
    expect(qa(container, 'nfr-matrix-cell').filter(c => c.dataset.pair).map(c => c.dataset.pair)).toEqual(['N1:V1|N1:V3', 'N1:V1|N1:V3']);
    await click(button(container, 'Arcs'));
    await act(async () => { const sel = q(container, 'nfr-focus') as HTMLSelectElement; sel.value = 'N1'; sel.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(pairs()).toEqual(['N1:V1|N1:V3', 'N1:V1|class_008', 'N1:V2|class_008']);           // one NFR with all its variants
    await click(q(container, 'nfr-arcs-expand'));
    expect(document.querySelector('[data-testid="nfr-arcs-expanded"] [data-testid="nfr-arcs"]')).not.toBeNull();
    // the shared strip's q holds the arcs too
    await act(async () => { const r = q(container, 'nfr-q') as HTMLInputElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(r, '0'); r.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(useAccessibilityStore.getState().qMax).toBe(0.001);
  });

  it('an open card has the read controls: group, split into panels, split by combination pattern, select as features (starred or not, this run or another)', async () => {
    const { savedFromNfr } = await import('./savedNfrVariants');
    const { useSplitPanelStore } = await import('../../stores/splitPanelStore');
    vi.mocked(api.getNfrMotifs).mockReset().mockReturnValue(new Promise(() => {}));
    vi.mocked(api.getAccessibilityGroups).mockReset().mockResolvedValue({
      job_id: COMPLETE_JOB.job_id, nfr: 'N1', variants: NFR_RESULT.nfrs[0].variants.map(v => ({ name: v.name, start: v.L, end: v.R })),
      groups: [{ id: 0, label: 'V2', display_label: 'V2', count: 2, pattern: [0, 1, 0] }, { id: 1, label: 'closed', display_label: 'closed', count: 1, pattern: [0, 0, 0] }],
      by_dataset: { ds1: { r1: 0, r2: 0, r3: 1 } },
    });
    vi.mocked(api.splitAccessibilityReads).mockReset().mockResolvedValue({ ...SPLIT, kind: 'combination', a: undefined, b: undefined, elements: ['N1:V1', 'N1:V3'], short: ['N1 V1', 'N1 V3'] });
    useSplitPanelStore.setState({ pending: null });
    // one entry from the run shown, one from another run (its result read from the server)
    const other = { ...COMPLETE_JOB, job_id: 'otherjob' };
    vi.mocked(api.getAccessibilityJob).mockImplementation(async id => (id === 'otherjob' ? other : COMPLETE_JOB));
    await renderPanel();
    await openN1();                                                                  // not starred: the controls are there all the same
    const controls = q(container, 'nfr-saved-controls')!;
    // one "Reads ▾" menu holds them
    expect(q(controls, 'nfr-reads-menu')!.textContent).toBe('Reads ▾');
    expect(q(controls, 'nfr-reads-menu-items')!.hidden).toBe(true);
    await click(q(controls, 'nfr-reads-menu'));
    expect(q(controls, 'nfr-reads-menu-items')!.hidden).toBe(false);
    expect([...q(controls, 'nfr-reads-menu-items')!.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Group in this panel', 'Split into panels…', 'Split by combination pattern', 'Select as features']);
    expect(q(card(), 'nfr-card-pairs')!.textContent).toBe('Pairs involving N1');
    // group: the NFR's configurations into the read panels, the groups bar shown here, the button says so
    await click(q(container, 'nfr-saved-group'));
    await wait(20);
    expect(api.getAccessibilityGroups).toHaveBeenCalledWith(COMPLETE_JOB.job_id, 'N1');
    expect(useBrowserStore.getState().clusterAssignments.ds1).toEqual({ r1: 0, r2: 0, r3: 1 });
    expect(q(container, 'nfr-groups-bar')).not.toBeNull();
    expect(q(container, 'nfr-saved-group')!.textContent).toBe('Grouped by variant');
    // split by combination pattern of the ticked variants (in the run's element order)
    const check = (id: string) => qa(card(), 'nfr-variant-check').find(c => c.closest('[data-variant]')!.getAttribute('data-variant') === id)!;
    await click(check('N1:V2'));
    await click(q(container, 'nfr-saved-split-patterns'));
    await wait(20);
    expect(api.splitAccessibilityReads).toHaveBeenLastCalledWith(COMPLETE_JOB.job_id, { elements: ['N1:V1', 'N1:V3'] });
    // one ticked variant: no combination
    await click(check('N1:V3'));
    expect((q(container, 'nfr-saved-split-patterns') as HTMLButtonElement).disabled).toBe(true);
    // split into panels: the split-panel request, with the run's result
    await click(q(container, 'nfr-saved-split-panels'));
    await wait(20);
    expect(useSplitPanelStore.getState().pending?.source).toMatchObject({ kind: 'configurations', jobId: COMPLETE_JOB.job_id, nfrId: 'N1', result: NFR_RESULT });
    useSplitPanelStore.setState({ pending: null });
    // select as features: the ticked variants; shift-click toggles one
    await click(q(container, 'nfr-saved-select-features'));
    expect(useBrowserStore.getState().selectedFeatures.map(f => f.id)).toEqual(['N1:V1']);
    expect(useBrowserStore.getState().selectedFeatures[0]).toMatchObject({ kind: 'nfr-variant', source: COMPLETE_JOB.job_id, chrom: 'chr19' });
    const v3 = qa(card(), 'nfr-variant-row').find(l => l.dataset.variant === 'N1:V3')!;
    await act(async () => { v3.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })); });
    expect(useBrowserStore.getState().selectedFeatures.map(f => f.id)).toEqual(['N1:V1', 'N1:V3']);
    expect(v3.dataset.featureSelected).toBe('true');
    // a starred entry of another run (Earlier, its run still on the server): its result is read for the split panels
    useBrowserStore.setState({ savedNfrVariants: [] } as never);
    useBrowserStore.getState().addSavedNfrVariants([savedFromNfr('otherjob', NFR_RESULT, NFR_RESULT.nfrs[0], ['ds1'])]);
    vi.mocked(api.getAccessibilityJobs).mockResolvedValue({ jobs: [{ ...COMPLETE_JOB, result: undefined }, { ...other, result: undefined }] });
    act(() => root.unmount());
    root = createRoot(container);
    useAccessibilityStore.setState({ openCard: null });
    await renderPanel();
    await click(q(container, 'nfr-earlier-toggle'));
    const stored = container.querySelector<HTMLElement>('[data-testid="nfr-card"][data-stored="true"]')!;
    await click(q(stored, 'nfr-card-open'));
    expect(stored.textContent).not.toContain('run not loaded');
    await click(q(stored, 'nfr-saved-split-panels'));
    await wait(20);
    expect(api.getAccessibilityJob).toHaveBeenCalledWith('otherjob');
    expect(useSplitPanelStore.getState().pending?.source).toMatchObject({ kind: 'configurations', jobId: 'otherjob', nfrId: 'N1' });
    useSplitPanelStore.setState({ pending: null });
  });

  it('one control strip above both tabs: the list filter, the same q and settings on NFRs and Co-accessibility', async () => {
    await renderPanel();
    for (const tab of ['NFRs', 'NFR pairs']) {
      await click(button(container, tab));
      expect(qa(container, 'nfr-filter-strip')).toHaveLength(1);
    }
    expect(q(container, 'nfr-list-filter')).toBeNull();                          // All / Starred is the list's
    await click(q(container, 'nfr-settings-toggle'));
    expect(q(container, 'nfr-run-settings')).not.toBeNull();
    expect(q(container, 'nfr-motif-parameters')).not.toBeNull();
    expect(button(container, 'Motifs pooled')).toBeUndefined();
    await click(button(container, 'NFRs'));
    expect(q(q(container, 'nfr-filter-strip')!, 'nfr-list-filter')).not.toBeNull();
    expect(q(container, 'nfr-pooled-disclosure')!.textContent).toContain('more often present, open or footprinted in one kind of variant');
  });

  it('starred cards of the shown run are its cards; other runs\' are in a collapsed Earlier group with their numbers and Go there', async () => {
    vi.mocked(api.getNfrMotifs).mockReset().mockReturnValue(new Promise(() => {}));
    useBrowserStore.getState().addSavedNfrVariants([savedFromNfr(COMPLETE_JOB.job_id, NFR_RESULT, NFR_RESULT.nfrs[0], ['ds1']),
      { ...savedFromNfr('old', { ...NFR_RESULT, region: { chrom: 'chr2', start: 1, end: 5000 } }, { ...NFR_RESULT.nfrs[0], start: 100, end: 400 }, ['ds1']), chrom: 'chr2' }]);
    await renderPanel();
    expect(qa(container, 'nfr-card')).toHaveLength(1);
    expect(card().dataset.starred).toBe('true');
    expect(q(container, 'nfr-earlier-toggle')!.textContent).toContain('Earlier (1)');
    expect(q(container, 'nfr-earlier')!.querySelector('[data-testid="nfr-card"]')).toBeNull();      // collapsed
    // Starred: the starred card and Earlier (open when nothing of this run is starred)
    await click(button(container, 'Starred'));
    expect(qa(container, 'nfr-card')).toHaveLength(1);
    await click(q(card(), 'nfr-card-star'));
    expect(q(container, 'nfr-earlier')!.querySelector('[data-testid="nfr-card"][data-stored="true"]')).not.toBeNull();
  });

  it('hovering an element (here, or from the NFR channel through hoveredElement) brings its arcs forward', async () => {
    await openCoaccess();
    const v3 = container.querySelector('[data-testid="nfr-element"][data-element="N1:V3"]')!;
    await act(async () => { v3.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    expect(useAccessibilityStore.getState().hoveredElement).toBe('N1:V3');
    const op = (pair: string) => Number(container.querySelector(`[data-testid="nfr-arc"][data-pair="${pair}"]`)!.getAttribute('stroke-opacity'));
    expect(op('N1:V1|N1:V3')).toBe(1);
    expect(op('N1:V2|class_008')).toBeLessThan(0.2);
    await act(async () => { useAccessibilityStore.getState().setHoveredElement('N1'); });   // an NFR from the channel: all its variants
    expect(op('N1:V2|class_008')).toBe(1);
    await act(async () => { v3.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); });
    expect(useAccessibilityStore.getState().hoveredElement).toBeNull();
  });

  it('a quantification keeps running when its view closes, and Cancel during its start still stops it on the server', async () => {
    const { savedFromNfr } = await import('./savedNfrVariants');
    useBrowserStore.getState().addSavedNfrVariants([savedFromNfr(COMPLETE_JOB.job_id, NFR_RESULT, NFR_RESULT.nfrs[0], ['ds1'])]);
    vi.mocked(api.getNfrMotifs).mockReset().mockReturnValue(new Promise(() => {}));
    vi.mocked(api.getNfrPrevalence).mockReset().mockReturnValue(new Promise(() => {}));
    let started!: (t: api.TransferJob) => void;
    vi.mocked(api.startVariantTransfer).mockReset().mockReturnValue(new Promise(r => { started = r; }));
    vi.mocked(api.cancelVariantTransfer).mockReset().mockResolvedValue({} as api.TransferJob);
    await renderPanel();
    await openN1();
    await click(button(container, 'Prevalence'));
    await click(q(container, 'nfr-transfer'));
    // the view closes (the card closed, another tab); the job is the panel's and still running
    await click(q(card(), 'nfr-card-open'));
    await click(button(container, 'NFR pairs'));
    await click(button(container, 'NFRs'));
    await wait(10);
    await openN1();
    await click(button(container, 'Prevalence'));
    expect(q(container, 'nfr-transfer-running')).not.toBeNull();
    await click(q(container, 'nfr-transfer-running-cancel'));                // before the start request answered
    await act(async () => { started({ transfer_id: 'tr1', job_id: COMPLETE_JOB.job_id, nfr: 'N1', dataset_ids: ['ds2'], status: 'queued', message: 'Waiting' }); });
    await wait(10);
    expect(api.cancelVariantTransfer).toHaveBeenCalledWith('tr1');
    expect(q(container, 'nfr-transfer')!.textContent).toContain('cancelled');
  });
  it('an NFR or variant clicked over the reads opens its card in place and brings it into view, from any tab or filter', async () => {
    vi.mocked(api.getNfrMotifs).mockReset().mockReturnValue(new Promise(() => {}));
    const focusNfr = (variantId?: string, jobId = COMPLETE_JOB.job_id, nfrId = 'N1') => act(async () => {
      window.dispatchEvent(new CustomEvent(FOCUS_NFR_EVENT, { detail: { jobId, nfrId, saved: false, ...(variantId ? { variantId } : {}) } }));
    });
    const scrolled = vi.mocked(scrollIntoViewWithin).mockClear();
    await renderPanel();
    // from Co-accessibility: back on the list, the card open, the clicked variant ringed and brought into view
    await click(button(container, 'NFR pairs'));
    await focusNfr('N1:V2');
    await wait(120);
    expect(useAccessibilityStore.getState().panelTab).toBe('nfrs');
    expect(q(card(), 'nfr-card-open')!.getAttribute('aria-expanded')).toBe('true');
    const focused = () => qa(card(), 'nfr-variant-row').filter(r => r.dataset.focused === 'true').map(r => r.dataset.variant);
    expect(focused()).toEqual(['N1:V2']);
    expect(scrolled).toHaveBeenCalled();
    expect(scrolled.mock.calls.at(-1)?.[0]).toBe(qa(card(), 'nfr-variant-row').find(r => r.dataset.variant === 'N1:V2'));
    // closed by hand; another variant clicked opens it again at that variant; the NFR itself: nothing ringed
    await click(q(card(), 'nfr-card-open'));
    await focusNfr('N1:V3');
    await wait(120);
    expect(q(card(), 'nfr-card-open')!.getAttribute('aria-expanded')).toBe('true');
    expect(focused()).toEqual(['N1:V3']);
    await focusNfr();
    await wait(120);
    expect(focused()).toEqual([]);
    // on the Starred filter, an NFR not starred: the filter goes back to All so its card shows
    await click(button(container, 'Starred'));
    expect(qa(container, 'nfr-card')).toHaveLength(0);
    await focusNfr('N1:V1');
    await wait(120);
    expect(useAccessibilityStore.getState().listFilter).toBe('all');
    expect(focused()).toEqual(['N1:V1']);
    // a starred NFR of another run (a Footprints link): Earlier opens at it
    useBrowserStore.getState().addSavedNfrVariants([savedFromNfr('otherjob', NFR_RESULT, NFR_RESULT.nfrs[0], ['ds1'])]);
    await focusNfr('N1:V2', 'otherjob');
    await wait(120);
    const stored = container.querySelector<HTMLElement>('[data-testid="nfr-card"][data-stored="true"]')!;
    expect(q(stored, 'nfr-card-open')!.getAttribute('aria-expanded')).toBe('true');
    expect(qa(stored, 'nfr-saved-variant').filter(v => v.dataset.focused === 'true').map(v => v.dataset.variant)).toEqual(['N1:V2']);
    // an NFR of another run not starred: that run is loaded and shown, its card opened
    const third = { ...COMPLETE_JOB, job_id: 'job3' };
    vi.mocked(api.getAccessibilityJob).mockResolvedValue(third);
    await focusNfr(undefined, 'job3');
    await wait(150);
    expect(useAccessibilityStore.getState().jobId).toBe('job3');
    expect(useAccessibilityStore.getState().openCard).toBe('job3|N1');
    expect(q(card(), 'nfr-card-open')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('only the newest click counts: a run still loading for an earlier click is not shown over a later one (Codex review)', async () => {
    vi.mocked(api.getNfrMotifs).mockReset().mockReturnValue(new Promise(() => {}));
    await renderPanel();
    let releaseA!: (j: api.AccessibilityJob) => void;
    vi.mocked(api.getAccessibilityJob).mockImplementation(id => (id === 'runA' ? new Promise(r => { releaseA = r; }) : Promise.resolve(COMPLETE_JOB)));
    const focus = (jobId: string, variantId: string) => act(async () => {
      window.dispatchEvent(new CustomEvent(FOCUS_NFR_EVENT, { detail: { jobId, nfrId: 'N1', variantId } }));
    });
    await focus('runA', 'N1:V1');                        // another run: loading
    await focus(COMPLETE_JOB.job_id, 'N1:V3');           // then a card of the run shown
    await wait(100);
    await act(async () => { releaseA({ ...COMPLETE_JOB, job_id: 'runA' }); });
    await wait(100);
    expect(useAccessibilityStore.getState().jobId).toBe(COMPLETE_JOB.job_id);
    expect(useAccessibilityStore.getState().openCard).toBe(`${COMPLETE_JOB.job_id}|N1`);
    expect(useAccessibilityStore.getState().focusedVariant?.variantId).toBe('N1:V3');
  });

  it('a remount (closing split panels re-mounts the panel) keeps the tab, the filter, the open card and its scroll position', async () => {
    vi.mocked(api.getNfrMotifs).mockReset().mockReturnValue(new Promise(() => {}));
    useBrowserStore.getState().addSavedNfrVariants([savedFromNfr(COMPLETE_JOB.job_id, NFR_RESULT, NFR_RESULT.nfrs[0], ['ds1'])]);
    // the panel's frame: a scrolling box around it
    const frame = document.createElement('div');
    frame.style.overflowY = 'auto';
    Object.defineProperty(frame, 'scrollHeight', { configurable: true, value: 4000 });
    Object.defineProperty(frame, 'clientHeight', { configurable: true, value: 500 });
    container.remove();
    frame.appendChild(container);
    document.body.appendChild(frame);
    await renderPanel();
    await click(button(container, 'Starred'));
    await openN1();
    frame.scrollTop = 640;
    await act(async () => { frame.dispatchEvent(new Event('scroll')); await new Promise(r => setTimeout(r, 40)); });
    expect(useAccessibilityStore.getState().listScroll).toBe(640);
    act(() => root.unmount());
    frame.scrollTop = 0;
    root = createRoot(container);
    await renderPanel();
    expect(useAccessibilityStore.getState().listFilter).toBe('starred');
    expect(q(card(), 'nfr-card-open')!.getAttribute('aria-expanded')).toBe('true');
    expect(q(card(), 'nfr-saved-inspect')).not.toBeNull();
    expect(frame.scrollTop).toBe(640);
    // a session import starts the list afresh (another session's run)
    await act(async () => { useAccessibilityStore.getState().reset(); });
    expect(useAccessibilityStore.getState().openCard).toBeNull();
    frame.remove();
    document.body.appendChild(container);
  });

  it('an open card copies its sequence and saves it as FASTA: the NFR window and each variant, with coordinates', async () => {
    vi.mocked(api.getNfrMotifs).mockReset().mockReturnValue(new Promise(() => {}));
    const lo = 47518100;
    const bases = Array.from({ length: 500 }, (_, i) => 'ACGT'[(i * 7) % 4]).join('');
    vi.mocked(api.getNfrSequence).mockReset().mockResolvedValue({ variant: null, nfr: 'N1', window: [lo, lo + 500], chrom: 'chr19', sequence: bases,
      variants: {}, flanks: { left: { bp: 0, gc: null, cpg: 0, cpg_oe: null, tracts: [], tract_bp: 0 }, right: { bp: 0, gc: null, cpg: 0, cpg_oe: null, tracts: [], tract_bp: 0 } },
      gc_track: { x: [], gc: [], window: 50 }, tracts: [], definitions: { tracts: '', cpg_oe: '' } } as api.VariantSequence);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    vi.mocked(downloadTextFile).mockReset();
    await renderPanel();
    await openN1();
    await click(q(card(), 'nfr-seq-copy'));
    await wait(20);
    expect(api.getNfrSequence).toHaveBeenCalledWith(COMPLETE_JOB.job_id, 'N1', 0);
    // N1 is 47,518,170-47,518,510 (0-based half-open): 340 bases
    expect(writeText).toHaveBeenCalledWith(bases.slice(47518170 - lo, 47518510 - lo));
    expect(q(card(), 'nfr-seq-notice')!.textContent).toBe('Copied N1 (340 bp, chr19:47,518,171-47,518,510)');
    await click(q(card(), 'nfr-seq-fasta'));
    await wait(20);
    const [fasta, file] = vi.mocked(downloadTextFile).mock.calls.at(-1)!;
    expect(fasta.split('\n')[0]).toBe('>N1 chr19:47518171-47518510 NFR window');
    expect(fasta.split('\n').slice(1).join('')).toBe(bases.slice(70, 410));
    expect(fasta.split('\n')[1]).toHaveLength(60);
    expect(file).toBe('N1_chr19_47518171-47518510.fa');
    // per variant: V2's span (rounded edges 47,518,219-47,518,459)
    await click(q(card(), 'nfr-seq-variants-toggle'));
    const v2 = qa(card(), 'nfr-seq-variant').find(v => v.dataset.variant === 'V2')!;
    await click(q(v2, 'nfr-seq-variant-fasta'));
    await wait(20);
    expect(vi.mocked(downloadTextFile).mock.calls.at(-1)![0].split('\n')[0]).toBe('>N1_V2 chr19:47518220-47518459 V2 full');
    await click(q(v2, 'nfr-seq-variant-copy'));
    await wait(20);
    expect(writeText).toHaveBeenLastCalledWith(bases.slice(47518219 - lo, 47518459 - lo));
    expect(api.getNfrSequence).toHaveBeenCalledTimes(1);                         // read once per run and NFR
    // without bases (no genome FASTA): it says so
    clearNfrSequenceCache();
    vi.mocked(api.getNfrSequence).mockRejectedValueOnce(new Error('No reference sequence for this region'));
    await click(q(card(), 'nfr-seq-copy'));
    await wait(20);
    expect(q(card(), 'nfr-seq-notice')!.textContent).toContain('No sequence: No reference sequence');
  });
});
