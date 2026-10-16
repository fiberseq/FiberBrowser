import '../testSetup';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useAccessibilityStore } from './accessibilityStore';
import * as api from './api';
import { AccessibilityPanel } from './AccessibilityPanel';
import { COMPLETE_JOB, NFR_RESULT } from './accessibility/fixture';

vi.mock('./api', async importOriginal => ({
  ...(await importOriginal<typeof import('./api')>()),
  startAccessibility: vi.fn(),
  getAccessibilityJob: vi.fn(),
  getAccessibilityJobs: vi.fn(),
  getAccessibilityGroups: vi.fn(),
  splitAccessibilityReads: vi.fn(() => new Promise(() => {})),
  cancelAccessibility: vi.fn(),
  getNfrOverview: vi.fn(),
  getNfrMotifs: vi.fn(() => new Promise(() => {})),
  getAccessibilitySchema: vi.fn(),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const q = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (c: HTMLElement, id: string) => [...c.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click(); });

describe('Accessibility (preview) panel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.mocked(api.getAccessibilityJobs).mockReset().mockResolvedValue({ jobs: [] });
    vi.mocked(api.getAccessibilitySchema).mockReset().mockRejectedValue(new Error('no engine'));
    vi.mocked(api.startAccessibility).mockReset().mockResolvedValue({ job_id: 'job12345abcdef', status: 'queued', message: 'Waiting' });
    vi.mocked(api.getAccessibilityJob).mockReset()
      .mockResolvedValueOnce({ job_id: 'job12345abcdef', status: 'running', stage: 'nfr', message: 'Finding NFR variants', progress: { stage: 'nfr', completed: 1, total: 4, fraction: 0.25 } })
      .mockResolvedValue(COMPLETE_JOB);
    vi.mocked(api.getAccessibilityGroups).mockReset().mockResolvedValue({
      job_id: 'job12345abcdef', nfr: 'N1', variants: NFR_RESULT.nfrs[0].variants.map(v => ({ name: v.name, start: v.L, end: v.R })),
      groups: [{ id: 0, label: 'V2', display_label: 'V2', count: 2, pattern: [0, 1, 0] }, { id: 1, label: 'closed', display_label: 'closed', count: 1, pattern: [0, 0, 0] }],
      by_dataset: { ds1: { r1: 0, r2: 0, r3: 1 } },
    });
    vi.mocked(api.getNfrOverview).mockReset().mockResolvedValue({ nfr: 'N1', x: [0, 1, 2], step: 10, all: { profile: [0.2, 0.5, 0.2], n: 2661 },
      variants: { V1: { profile: [0.9, 0.1, 0], n: 480 }, V2: { profile: [0.1, 1, 0.1], n: 770 }, V3: { profile: [0, 0.1, 0.9], n: 500 } } });
    useAccessibilityStore.setState({ jobId: null, result: null, showArcs: false, arcSelection: 'significant', showClassArcs: true, applied: [],
      expanded: {}, pairRequest: null, focus: null, pairsView: 'arcs', panelTab: 'nfrs', listFilter: 'all', openCard: null, focusedVariant: null, showEarlier: false, untickedLive: {}, listScroll: null });
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({
      chrom: 'chr19', start: 47517650, end: 47518985,
      datasets: [{ id: 'ds1', label: 'napa_ddda', color: '#3b82f6', consensus_chemistry: 'ddda' }],
      panels: [{ id: 'p1', contentType: 'dataset', datasetId: 'ds1', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 }],
      selectedDatasets: new Set(), clusterAssignments: {}, clusterOrder: {}, clusterFocus: {},
    } as never);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('preserves saved caps while schema loading retries and then submits them', async () => {
    localStorage.setItem('fiberhmm-nfr-preview-settings-v1', JSON.stringify({ max_discovery_molecules: 2000, max_quantification_molecules: 2000 }));
    let resolve!: (value: Awaited<ReturnType<typeof api.getAccessibilitySchema>>) => void;
    vi.mocked(api.getAccessibilitySchema).mockRejectedValueOnce(new Error('starting'))
      .mockImplementation(() => new Promise(r => { resolve = r; }));
    await act(async () => root.render(<AccessibilityPanel />));
    expect((q(container, 'nfr-find') as HTMLButtonElement).disabled).toBe(true);
    await click(q(container, 'nfr-find'));
    expect(api.startAccessibility).not.toHaveBeenCalled();
    await wait(1600);
    expect(api.getAccessibilitySchema).toHaveBeenCalledTimes(2);
    await click(q(container, 'nfr-find'));
    expect(api.startAccessibility).not.toHaveBeenCalled();
    await act(async () => resolve({ defaults: { max_discovery_molecules: 0, max_quantification_molecules: 0, sample_seed: 1 } } as never));
    await click(q(container, 'nfr-find'));
    expect(api.startAccessibility).toHaveBeenCalledWith(expect.objectContaining({ parameters: expect.objectContaining({
      max_discovery_molecules: 2000, max_quantification_molecules: 2000, sample_seed: 1,
    }) }));
  });

  it('keeps saved caps blocked after schema retries are exhausted', async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem('fiberhmm-nfr-preview-settings-v1', JSON.stringify({ max_quantification_molecules: 2000 }));
      await act(async () => root.render(<AccessibilityPanel />));
      await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
      expect(api.getAccessibilitySchema).toHaveBeenCalledTimes(4);
      expect(q(container, 'nfr-read-depth-pending')?.textContent).toContain('Reopen the panel');
      await click(q(container, 'nfr-find'));
      expect(api.startAccessibility).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('shows supported read caps and the frozen usage note', async () => {
    vi.mocked(api.getAccessibilitySchema).mockResolvedValue({defaults:{max_discovery_molecules:0,max_quantification_molecules:0,sample_seed:1}} as never);
    const result={...NFR_RESULT,detection:{method:'raw',loader_sampling:[{dataset_id:'ds1',reads_seen:25000,eligible_reads:20000,reads_decoded:3000}],molecule_sampling:[{phase:'discovery',purpose:'region_detection',max_discovery_molecules:2000,
      strata:[{stratum:'ds1::CT',available:2734,discovery:2000,quantification:null}]}]}};
    vi.mocked(api.getAccessibilityJobs).mockResolvedValue({jobs:[COMPLETE_JOB]});
    useAccessibilityStore.setState({jobId:COMPLETE_JOB.job_id,result} as never);
    vi.mocked(api.getAccessibilityJob).mockReset().mockResolvedValue({...COMPLETE_JOB,result} as never);
    await act(async()=>root.render(<AccessibilityPanel/>));
    await wait(50);
    await click(q(container, 'nfr-settings-toggle'));
    expect((q(container,'nfr-max-discovery-molecules') as HTMLInputElement).value).toBe('0');
    expect((q(container,'nfr-sample-seed') as HTMLInputElement).value).toBe('1');
    expect(q(container,'nfr-read-depth-notes')?.textContent).toContain('decoded 3,000 of 20,000 eligible reads');
    expect(q(container,'nfr-read-depth-notes')?.textContent).toContain('Used 2,000 of 2,734 eligible reads in the decoded subset in napa_ddda (CT) for finding regions');
  });

  it('shows the region it analyses (no preview label), runs FiberHMM on the view and lists the variants', async () => {
    await act(async () => root.render(<AccessibilityPanel />));
    await wait(50);
    expect(q(container, 'nfr-preview-badge')).toBeNull();
    expect(q(container, 'nfr-region-line')?.textContent).toContain('chr19:47,517,650–47,518,985 · 1,335 bp · this view');
    await click(q(container, 'nfr-find'));
    expect(api.startAccessibility).toHaveBeenCalledWith(expect.objectContaining({
      dataset_ids: ['ds1'], chrom: 'chr19', start: 47517650, end: 47518985, region_source: 'view',
      parameters: { stringency: 0.9, mode: 'variants', elements: 'variants', internal_footprint_labels: true },
    }));
    await wait(600);
    expect(q(container, 'nfr-progress')?.textContent).toContain('Finding NFR variants');
    await wait(1000);
    const rows = qa(container, 'nfr-variant-row');
    expect(rows.map(r => r.dataset.variant)).toEqual(['N1:V1', 'N1:V2', 'N1:V3']);
    // the overview: one prevalence with its interval, member reads of the callable ones, a mini profile
    expect(rows[1].textContent).toContain('29%[28–31]');
    expect(rows[1].textContent).toContain('770 of 2,661 reads');
    expect(rows[1].textContent).toContain('47,518,219–47,518,459');
    expect(qa(container, 'nfr-mini-profile')).toHaveLength(3);
    expect(q(container, 'nfr-lanes')?.querySelectorAll('rect').length).toBe(4);     // the NFR + one bar per variant
    const card = q(container, 'nfr-card')!;
    expect(card.textContent).toContain('2,661 of 2,753 reads callable');
    // the statistics are in the open card, behind Statistics
    expect(q(container, 'nfr-details-toggle')).toBeNull();
    await click(q(card, 'nfr-card-open'));
    expect(q(container, 'nfr-details')).toBeNull();
    await click(q(container, 'nfr-details-toggle'));
    const details = q(container, 'nfr-details')!;
    expect(details.textContent).toContain('27–29%');           // strict to EM
    expect(details.textContent).toContain('CT 30% · GA 28%');
    expect(details.textContent).toContain('k = 3 by prediction strength');
    expect(details.textContent).toContain('92 edge-censored');
    expect(q(container, 'nfr-configurations')?.textContent).toContain('V1+V3: full NFR with internal footprint (class_008)');
    expect(details.querySelectorAll('[title^="EM estimate"]')[1]?.getAttribute('title')).toBe('EM estimate 29.1%; strict (reads at least 90% sure) 26.8%');
    expect(useAccessibilityStore.getState().jobId).toBe('job12345abcdef');
    expect(q(container, 'nfr-export-link')?.getAttribute('href')).toContain('/api/accessibility/jobs/job12345abcdef/export/variants.tsv');
  });

  it('sends the finer stringency and the settings chosen', async () => {
    await act(async () => root.render(<AccessibilityPanel />));
    await click([...container.querySelectorAll('button')].find(b => b.textContent === '0.85 finer')!);
    await click(q(container, 'nfr-settings-toggle'));
    const states = q(container, 'nfr-settings')!.querySelector('select')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(states, 'depth');
      states.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(q(container, 'nfr-within-clusters')).toBeNull();     // reads are not clustered
    await click(q(container, 'nfr-find'));
    expect(vi.mocked(api.startAccessibility).mock.calls[0][0].parameters).toEqual(
      { stringency: 0.85, mode: 'depth', elements: 'variants', internal_footprint_labels: true });
  });

  it('offers the within-cluster check only when the reads are clustered', async () => {
    useBrowserStore.setState({ clusterAssignments: { ds1: { r1: 0, r2: 1, r3: 2 } } } as never);
    await act(async () => root.render(<AccessibilityPanel />));
    await click(q(container, 'nfr-settings-toggle'));
    const check = q(container, 'nfr-within-clusters')!;
    expect(check.textContent).toContain('3 clusters');
    expect(check.title).toContain('two tested elements masked');
    await click(check.querySelector('input'));
    await click(q(container, 'nfr-find'));
    expect(vi.mocked(api.startAccessibility).mock.calls[0][0].parameters).toMatchObject({ within_clusters: 3 });
  });

  it('groups the reads by variant as clusters, with a legend', async () => {
    vi.mocked(api.getAccessibilityJobs).mockResolvedValue({ jobs: [{ ...COMPLETE_JOB, result: undefined }] });
    vi.mocked(api.getAccessibilityJob).mockReset().mockResolvedValue(COMPLETE_JOB);
    await act(async () => root.render(<AccessibilityPanel />));
    await wait(50);
    await click(q(container, 'nfr-card-open'));
    await click(q(container, 'nfr-saved-group'));
    await wait(20);
    expect(api.getAccessibilityGroups).toHaveBeenCalledWith('job12345abcdef', 'N1');
    const s = useBrowserStore.getState();
    expect(s.clusterAssignments.ds1).toEqual({ r1: 0, r2: 0, r3: 1 });
    expect(s.clusterOrder.ds1).toEqual([0, 1]);
    expect(s.dynamicClustering).toBe(false);
    expect(s.clusterPeakRegions).toHaveLength(3);
    expect(q(container, 'nfr-group-legend')?.textContent).toContain('V2');
  });

  it('under StrictMode, follows a run still going and drops the previous session\'s run on import', async () => {
    useAccessibilityStore.setState({ jobId: 'old-session-job', result: NFR_RESULT });
    vi.mocked(api.getAccessibilityJobs).mockResolvedValue({ jobs: [{ ...COMPLETE_JOB, result: undefined }, { job_id: 'b', status: 'running', message: 'Loading molecules' }] });
    vi.mocked(api.getAccessibilityJob).mockReset().mockImplementation(async id => (id === 'b'
      ? { job_id: 'b', status: 'running', message: 'Loading molecules' } : COMPLETE_JOB));
    await act(async () => root.render(<StrictMode><AccessibilityPanel /></StrictMode>));
    await wait(100);
    expect(useAccessibilityStore.getState().jobId).toBe('job12345abcdef');      // the stale id is replaced
    expect(q(container, 'nfr-progress')?.textContent).toContain('Loading molecules');
    expect(q(container, 'nfr-progress-cancel')).not.toBeNull();
    vi.mocked(api.getAccessibilityJobs).mockResolvedValue({ jobs: [] });
    await act(async () => { useAccessibilityStore.getState().reset(); });
    await wait(50);
    expect(useAccessibilityStore.getState().result).toBeNull();
    expect(q(container, 'nfr-result')).toBeNull();
  });

  it('draws co-accessibility arcs (above: together, below: apart), the matrix, and arcs over the reads', async () => {
    useAccessibilityStore.setState({ jobId: COMPLETE_JOB.job_id, result: NFR_RESULT });
    vi.mocked(api.getAccessibilityJobs).mockResolvedValue({ jobs: [{ ...COMPLETE_JOB, result: undefined }] });
    vi.mocked(api.getAccessibilityJob).mockReset().mockResolvedValue(COMPLETE_JOB);
    await act(async () => root.render(<AccessibilityPanel />));
    await wait(30);
    await click([...container.querySelectorAll('button')].find(b => b.textContent === 'NFR pairs')!);
    // N1 is folded to one element: its arcs go to it, and the pair between its own variants waits for it to unfold
    expect(qa(container, 'nfr-element').map(e => e.dataset.element)).toEqual(['N1', 'class_008']);
    expect(qa(container, 'nfr-arc').map(a => a.dataset.pair)).toEqual(['N1:V2|class_008', 'N1:V1|class_008']);
    expect(q(container, 'nfr-inner-pairs')?.textContent).toBe('1 inside');
    expect(q(container, 'nfr-fold-chip')?.textContent).toContain('(1 inside)');
    await click(q(container, 'nfr-fold-chip'));
    expect(useAccessibilityStore.getState().expanded[COMPLETE_JOB.job_id]).toEqual(['N1']);
    const arcs = qa(container, 'nfr-arc');
    expect(arcs.map(a => a.dataset.side)).toEqual(['up', 'up', 'down']);
    expect(arcs.find(a => a.dataset.pair === 'N1:V2|class_008')?.getAttribute('stroke-dasharray')).toBe('2 3');
    expect(qa(container, 'nfr-element')).toHaveLength(4);
    expect(q(container, 'nfr-class-join')?.textContent).toContain('2,600 of 2,753 molecules joined');
    expect(q(container, 'nfr-pair-table')?.textContent).toContain('N1 V1 × N1 V3');
    await click([...container.querySelectorAll('button')].find(b => b.textContent === 'Matrix')!);
    // square and mirrored: rows and columns the same elements in the same order; each pair's cell on both sides
    const cells = qa(container, 'nfr-matrix-cell');
    const order = ['N1:V1', 'N1:V2', 'class_008', 'N1:V3'];
    expect(qa(container, 'nfr-matrix-diag').map(c => c.dataset.element)).toEqual(order);
    expect(cells).toHaveLength(order.length * (order.length - 1));
    expect(cells.filter(c => c.textContent === '*')).toHaveLength(6);
    expect(cells.filter(c => c.textContent === '×')).toHaveLength(4);    // overlapping variants are not tested
    const cell = (r: string, c: string) => cells.find(x => x.dataset.cell === `${r}|${c}`)!;
    expect(cell('N1:V3', 'N1:V1').dataset.pair).toBe('N1:V1|N1:V3');
    expect(cell('N1:V1', 'N1:V3').dataset.pair).toBe('N1:V1|N1:V3');
    expect(cell('N1:V1', 'N1:V3').style.background).toBe(cell('N1:V3', 'N1:V1').style.background);
    expect(cell('N1:V1', 'N1:V3').dataset.mirror).toBe('true');
    // the diagonal: each element's own open share, in its tooltip
    expect(qa(container, 'nfr-matrix-diag')[0].title).toContain('open on 18.0% of its reads');
    // a mirrored cell inspects the same pair
    await click(cell('N1:V1', 'N1:V3'));
    expect(vi.mocked(api.splitAccessibilityReads)).toHaveBeenLastCalledWith(COMPLETE_JOB.job_id, { a: 'N1:V1', b: 'N1:V3' });
    // the matrix unfolds and folds the same NFR: folded, one row for N1
    await click(container.querySelector('[data-testid="nfr-matrix-toggle"][data-nfr="N1"]'));
    expect(useAccessibilityStore.getState().expanded[COMPLETE_JOB.job_id]).toEqual([]);
    expect(qa(container, 'nfr-matrix-cell').map(c => c.dataset.cell)).toEqual(['N1|class_008', 'class_008|N1']);
    expect(qa(container, 'nfr-matrix-diag')[0].title).toContain('open on 73.1% of its reads (any of its variants)');
    // one folded NFR alone (no classes): its row, its open share and ▸ still show (Codex review)
    await click(container.querySelector('input[type="checkbox"]:not([data-testid])') as HTMLElement);
    expect(useAccessibilityStore.getState().showClassArcs).toBe(false);
    expect(qa(container, 'nfr-matrix-diag').map(c => c.dataset.element)).toEqual(['N1']);
    expect(container.querySelector('[data-testid="nfr-matrix-toggle"][data-nfr="N1"]')).not.toBeNull();
    await click(container.querySelector('input[type="checkbox"]:not([data-testid])') as HTMLElement);
    expect(qa(container, 'nfr-matrix-cell')[0].dataset.pair).toBe('N1:V1|class_008');     // the strongest of its pairs
    await click(q(container, 'nfr-show-arcs'));
    expect(useAccessibilityStore.getState().showArcs).toBe(true);
  });
});

describe('Accessibility (preview): the engine knobs', () => {
  it('sends only the knobs changed from the engine defaults', async () => {
    const { runParameters, DEFAULT_NFR_SETTINGS } = await import('./AccessibilityPanel');
    expect(runParameters({ ...DEFAULT_NFR_SETTINGS }, null)).toEqual({ stringency: 0.9, mode: 'variants', elements: 'variants', internal_footprint_labels: true });
    expect(runParameters({ ...DEFAULT_NFR_SETTINGS, minGapBp: 80, opennessPadBp: 10, pairs: 'all' }, null))
      .toMatchObject({ min_gap_bp: 80, openness_pad_bp: 10, pairs: 'all' });
  });
});

describe('Accessibility (preview): the Rarest NFR slider', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.mocked(api.getAccessibilityJobs).mockReset().mockResolvedValue({ jobs: [] });
    vi.mocked(api.startAccessibility).mockReset().mockResolvedValue({ job_id: 'job12345abcdef', status: 'queued', message: 'Waiting' });
    vi.mocked(api.getAccessibilityJob).mockReset().mockResolvedValue(COMPLETE_JOB);
    vi.mocked(api.getNfrOverview).mockReset().mockResolvedValue({ nfr: 'N1', x: [0], step: 10, all: { profile: [0.2], n: 1 }, variants: {} });
    useAccessibilityStore.setState({ jobId: null, result: null, applied: [], panelTab: 'nfrs', listFilter: 'all', openCard: null, showEarlier: false });
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({
      chrom: 'chr19', start: 47517650, end: 47518985,
      datasets: [{ id: 'ds1', label: 'napa_ddda', color: '#3b82f6', consensus_chemistry: 'ddda' }],
      panels: [{ id: 'p1', contentType: 'dataset', datasetId: 'ds1', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 }],
      selectedDatasets: new Set(), clusterAssignments: {}, clusterOrder: {}, clusterFocus: {},
    } as never);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });
  const slide = (el: HTMLElement | null, v: number) => act(async () => {
    const input = el as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(v));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  it('sits beside Stringency, sends min_fraction to a FiberHMM that has it, and shows how each NFR was found', async () => {
    vi.mocked(api.getAccessibilitySchema).mockResolvedValue({ schema: 's', panel_parameters: [], defaults: { detect_method: 'raw', clip_gaps_to_region: false, min_fraction: 0.10, stringency: 0.9 } });
    await act(async () => root.render(<AccessibilityPanel />));
    await wait(50);
    const slider = q(container, 'nfr-min-fraction') as HTMLInputElement;
    expect(slider.disabled).toBe(false);
    expect(q(container, 'nfr-rarest')?.textContent).toContain('10%');
    expect(q(container, 'nfr-rarest')?.title).toMatch(/background/);
    expect(slider.parentElement?.parentElement?.parentElement).toBe(q(container, 'nfr-stringency')?.parentElement?.parentElement);   // the same row
    await slide(slider, 0.12);
    expect(q(container, 'nfr-rarest')?.textContent).toContain('12%');
    expect(slider.getAttribute('aria-valuetext')).toBe('12% of reads');
    expect(container.querySelector(`label[for="${slider.id}"]`)?.textContent).toBe('Find NFRs open in at least 12% of reads');
    await click(q(container, 'nfr-find'));
    expect(api.startAccessibility).toHaveBeenCalledWith(expect.objectContaining({ parameters: expect.objectContaining({ min_fraction: 0.12, detect_method: 'raw', clip_gaps_to_region: false }) }));
    await click([...container.querySelectorAll('button')].find(b => b.textContent === '10% default')!);
    expect(q(container, 'nfr-rarest')?.textContent).toContain('10%');
    expect(q(container, 'nfr-background-marker')).toBeNull();
    // Engine defaults puts the Rarest NFR back too
    await slide(slider, 0.2);
    await click(q(container, 'nfr-settings-toggle'));
    expect((q(container, 'nfr-detect-method') as HTMLSelectElement).value).toBe('raw');
    expect(q(container, 'nfr-knob-min_fold')).toBeNull();
    await click(q(container, 'nfr-clip-gaps-input'));
    expect((q(container, 'nfr-clip-gaps-input') as HTMLInputElement).checked).toBe(true);
    expect(q(container, 'nfr-knob-detect_threshold')).toBeNull();          // the fixed rule's only
    await click([...container.querySelectorAll('button')].find(b => b.textContent === 'Engine defaults')!);
    expect(q(container, 'nfr-rarest')?.textContent).toContain('10%');
    await wait(1500);
    expect(q(container, 'nfr-detection-line')?.textContent).toContain('NFRs open in ≥ 5% · background 2.7% · called at ≥ 5.4% here');
    expect(q(container, 'nfr-background-marker')?.title).toContain('Background here: about 2.7%');
    expect(q(container, 'nfr-card-detection')?.textContent).toContain('open in 37% of reads · background 2.7% · 13.7× background · q');
    await act(async () => useBrowserStore.setState({ start: 47517000 }));
    expect(q(container, 'nfr-background-marker')).toBeNull();
  });

  it('keeps enrichment available on older engines and gates the gap toggle independently', async () => {
    vi.mocked(api.getAccessibilitySchema).mockResolvedValue({ schema: 's', panel_parameters: [], defaults: { detect_method: 'enrichment', min_fraction: .05 } });
    await act(async () => root.render(<AccessibilityPanel />));
    await wait(50);
    expect(q(container, 'nfr-raw-unavailable')?.textContent).toContain('background and q also gate');
    await click(q(container, 'nfr-settings-toggle'));
    expect((q(container, 'nfr-detect-method') as HTMLSelectElement).value).toBe('enrichment');
    expect((q(container, 'nfr-clip-gaps-input') as HTMLInputElement).disabled).toBe(true);
    expect(q(container, 'nfr-knob-min_fold')).not.toBeNull();
    await click(q(container, 'nfr-find'));
    expect(api.startAccessibility).toHaveBeenCalledWith(expect.objectContaining({ parameters: expect.objectContaining({ detect_method: 'enrichment' }) }));
    expect(vi.mocked(api.startAccessibility).mock.calls[0][0].parameters).not.toHaveProperty('clip_gaps_to_region');
  });

  it('waits for the FiberHMM schema before it can be moved, retries a failed read, and sends nothing new without it', async () => {
    vi.mocked(api.getAccessibilitySchema).mockRejectedValueOnce(new Error('starting'))
      .mockResolvedValue({ schema: 's', panel_parameters: [], defaults: { min_fraction: 0.05 } });
    await act(async () => root.render(<AccessibilityPanel />));
    await wait(50);
    expect((q(container, 'nfr-min-fraction') as HTMLInputElement).disabled).toBe(true);
    expect(q(container, 'nfr-rarest')?.title).toMatch(/Checking/);
    await wait(1700);                                                          // the retry
    expect((q(container, 'nfr-min-fraction') as HTMLInputElement).disabled).toBe(false);
    act(() => root.unmount());
    root = createRoot(container);
    vi.mocked(api.getAccessibilitySchema).mockReset().mockRejectedValue(new Error('no engine'));
    await act(async () => root.render(<AccessibilityPanel />));
    await wait(50);
    expect((q(container, 'nfr-min-fraction') as HTMLInputElement).disabled).toBe(true);
    expect(q(container, 'nfr-help-rarest')).not.toBeNull();
    await click(q(container, 'nfr-settings-toggle'));
    expect((q(container, 'nfr-detect-method') as HTMLSelectElement).disabled).toBe(true);
    await click(q(container, 'nfr-find'));
    expect(api.startAccessibility).toHaveBeenCalledWith(expect.objectContaining({
      parameters: { stringency: 0.9, mode: 'variants', elements: 'variants', internal_footprint_labels: true },
    }));
  });

  it('is off, and sends nothing new, with an older FiberHMM', async () => {
    vi.mocked(api.getAccessibilitySchema).mockResolvedValue({ schema: 's', panel_parameters: [], defaults: { detect_threshold: 0.15, stringency: 0.9 } });
    await act(async () => root.render(<AccessibilityPanel />));
    await wait(50);
    expect((q(container, 'nfr-min-fraction') as HTMLInputElement).disabled).toBe(true);
    expect(q(container, 'nfr-rarest')?.title).toMatch(/older fixed rule \(more than 15% of reads open\)/);
    await click(q(container, 'nfr-settings-toggle'));
    expect((q(container, 'nfr-detect-method') as HTMLSelectElement).value).toBe('fixed');
    expect(q(container, 'nfr-knob-detect_threshold')).not.toBeNull();
    await click(q(container, 'nfr-find'));
    expect(api.startAccessibility).toHaveBeenCalledWith(expect.objectContaining({
      parameters: { stringency: 0.9, mode: 'variants', elements: 'variants', internal_footprint_labels: true },
    }));
  });
});
