/** The job card's Cancel: it shows "Cancelling…" at once, and no automatic start (the panel's Auto-Analyse, the
 * cluster views) analyses the cancelled views again until the user chooses Analyse there. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelNucJob, listNucJobs, nucRegularity, nucStatus, submitNucJob } from './api';
import { autoAnalyseVetoed, clearAutoAnalyseVeto, requestViews, useNucJob } from './nucJob';
import { autoAnalyseAction, consumeAutoAnalyse, resetAutoAnalyse } from './firstOpen';
import { RegularityView, regularitySeries } from './RegularityView';
import { clusterViewNucSettings } from './regParams';
import { analyseClusterView, resetClusterAnalyse } from '../../components/controls/cluster-detail/clusterNuc';
import { NucleosomePanel } from './NucleosomePanel';
import { useBrowserStore } from '../../stores/browserStore';
import type { NucJob, NucObservation } from './types';

vi.mock('./api', async original => ({ ...(await original<typeof import('./api')>()),
  submitNucJob: vi.fn(), getNucJob: vi.fn(), cancelNucJob: vi.fn(), listNucJobs: vi.fn(async () => ({ jobs: [] })),
  nucStatus: vi.fn(), nucRegularity: vi.fn() }));
vi.mock('../../api/datasets', () => ({ getDatasets: vi.fn(async () => ({ datasets: [] })) }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const view = { datasetId: 'a', chrom: 'chr2R', start: 1000, end: 21000 };
const running = (id = 'j1'): NucJob => ({ job_id: id, status: 'running', created_at: 1, datasets: [{ datasetId: 'a', label: 'A', kind: 'native' }],
  view: { chrom: '', start: 0, end: 0 }, results: {} });

describe('a user Cancel vetoes automatic restarts of its views', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useNucJob.getState().clear(); resetAutoAnalyse(); resetClusterAnalyse(); clearAutoAnalyseVeto([view]);
    vi.mocked(submitNucJob).mockReset(); vi.mocked(cancelNucJob).mockReset();
  });
  afterEach(() => { useNucJob.getState().clear(); clearAutoAnalyseVeto([view]); vi.useRealTimers(); });

  it('the views of a request: per-dataset views, or one view for every dataset', () => {
    expect(requestViews({ datasets: ['a'], views: [view] })).toEqual([view]);
    expect(requestViews({ datasets: ['a', 'b'], chrom: 'c', start: 1, end: 9 })).toEqual([
      { datasetId: 'a', chrom: 'c', start: 1, end: 9 }, { datasetId: 'b', chrom: 'c', start: 1, end: 9 }]);
  });

  it('the card\'s Cancel records the job\'s views; a programmatic cancel (a view moved on) does not; the user\'s Analyse lifts it', async () => {
    vi.mocked(submitNucJob).mockResolvedValue(running());
    vi.mocked(cancelNucJob).mockResolvedValue({ ...running(), status: 'cancelling' });
    await useNucJob.getState().submit({ datasets: ['a'], views: [view] }, 'p1');
    await useNucJob.getState().cancel();
    expect(autoAnalyseVetoed([view])).toBe(false);
    await useNucJob.getState().cancel({ user: true });
    expect(autoAnalyseVetoed([view])).toBe(true);
    expect(autoAnalyseVetoed([{ ...view, start: 50000, end: 70000 }])).toBe(false);   // another view: free
    expect(useNucJob.getState().job?.status).toBe('cancelling');
    clearAutoAnalyseVeto([view]);
    expect(autoAnalyseVetoed([view])).toBe(false);
  });

  it('the cluster views never start an Analyse of a view the user cancelled, in any mode', async () => {
    const obs: NucObservation = { obsId: 'a', datasetId: 'a', panelId: 'p-a', stateKey: 'a', label: 'a', color: '#000', kind: 'linear', ...view };
    const series = regularitySeries([obs], { a: { r1: 0, r2: 1 } });
    const settings = clusterViewNucSettings([{ id: 'nuc1', contentType: 'nucleosomes', nucleosomes: { regularity: { autoAnalyse: 'every' } } }] as never);
    vi.mocked(submitNucJob).mockResolvedValue(running('panel'));
    vi.mocked(cancelNucJob).mockResolvedValue({ ...running('panel'), status: 'cancelled' });
    await useNucJob.getState().submit({ datasets: ['a'], views: [view] }, 'nuc1');
    await useNucJob.getState().cancel({ user: true });
    expect(useNucJob.getState().job?.status).toBe('cancelled');
    vi.mocked(submitNucJob).mockClear();
    const out = await analyseClusterView(series, ['a'], 'v1', settings, false, 'the regularity channels');
    expect(out.status).toBe('needs-analyse');
    expect(submitNucJob).not.toHaveBeenCalled();
  });

  it("the cluster views share the panel's 'first open' budget: after the panel's automatic Analyse they offer, never start", async () => {
    const obs: NucObservation = { obsId: 'a', datasetId: 'a', panelId: 'p-a', stateKey: 'a', label: 'a', color: '#000', kind: 'linear', ...view };
    const series = regularitySeries([obs], { a: { r1: 0, r2: 1 } });
    const settings = clusterViewNucSettings([{ id: 'nuc1', contentType: 'nucleosomes', nucleosomes: { regularity: { autoAnalyse: 'first' } } }] as never);
    expect(autoAnalyseAction('first', 'nuc1', ['a'])).toBe('run');
    consumeAutoAnalyse('first', 'nuc1');                   // the panel's own automatic Analyse started
    const out = await analyseClusterView(series, ['a'], 'v1', settings, false, 'x');
    expect(out.status).toBe('needs-analyse');
    expect(submitNucJob).not.toHaveBeenCalled();
  });
});

describe("the panel's Auto-Analyse", () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    vi.useFakeTimers(); resetAutoAnalyse(); useNucJob.getState().clear();
    useBrowserStore.setState({ datasets: [{ id: 'a', label: 'A', data_type: 'bam' }], clusterAssignments: {} } as never);
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); clearAutoAnalyseVeto([view]); vi.useRealTimers(); });

  it("'every view' never restarts a view whose Analyse the user cancelled, and says it waits for the header's Analyse", async () => {
    vi.mocked(nucRegularity).mockResolvedValue({ observations: [{ obsId: 'a', datasetId: 'a', molecules: 0, scored: 0, notComputed: 50 }], datasets: {}, updatedDatasets: [] } as never);
    vi.mocked(submitNucJob).mockResolvedValue(running());
    vi.mocked(cancelNucJob).mockResolvedValue({ ...running(), status: 'cancelled' });
    await useNucJob.getState().submit({ datasets: ['a'], views: [view] }, 'r1');
    await useNucJob.getState().cancel({ user: true });
    const onAnalyse = vi.fn();
    const obs: NucObservation = { obsId: 'a', datasetId: 'a', panelId: 'p-a', stateKey: 'a', label: 'a', color: '#000', kind: 'linear', ...view };
    await act(async () => { root.render(<RegularityView observations={[obs]} settings={{ regularity: { autoAnalyse: 'every', patches: { open: false } } }}
      setSettings={vi.fn()} revision="1" includeDuplicates={false} onAnalyse={onAnalyse} panelId="r1" />); });
    for (let i = 0; i < 4; i++) await act(async () => { vi.advanceTimersByTime(700); await Promise.resolve(); await Promise.resolve(); });
    expect(onAnalyse).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="nuc-reg-needs-analyse"]')).not.toBeNull();
  });
});

describe('the job card', () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    vi.useFakeTimers();
    useBrowserStore.setState({ chrom: 'chr1', start: 1000, end: 5000, showDuplicateReads: false,
      datasets: [{ id: 'd1', label: 'Sample A', color: '#16a34a', data_type: 'bam', available_layers: { nucsz: true, nucseg: true } }],
      panels: [{ id: 'reads', contentType: 'dataset', datasetId: 'd1', subTracks: [], collapsed: false },
        { id: 'nuc', contentType: 'nucleosomes', nucleosomes: { regularity: { autoAnalyse: 'off' } }, subTracks: [], collapsed: false }],
      selectedDatasets: new Set(), selectedPeaks: new Set(), selectedFeatures: [], filteredReadIds: {},
      clusterAssignments: {}, clusterFocus: {}, selectedClusters: {}, clusterFeatureRules: [] } as never);
    useNucJob.getState().clear();
    vi.mocked(nucStatus).mockResolvedValue({ available: true, datasets: [] });
    vi.mocked(listNucJobs).mockResolvedValue({ jobs: [] });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); useNucJob.getState().clear(); vi.useRealTimers(); });

  it('Cancel is a user cancel; "Cancelling…" shows at once, with no second Cancel; then "Analysis cancelled"', async () => {
    const job = { ...running('card'), datasets: [{ datasetId: 'd1', label: 'Sample A', kind: 'native' }], view: { chrom: 'chr1', start: 1000, end: 5000 } };
    useNucJob.setState({ panelId: 'nuc', job });
    await act(async () => root.render(<NucleosomePanel panelId="nuc" isFullView />));
    await act(async () => { vi.advanceTimersByTime(600); });
    const card = () => container.querySelector<HTMLElement>('[data-testid="nuc-job"]')!;
    expect(card().textContent).toContain('Analysing…');
    vi.mocked(cancelNucJob).mockResolvedValue({ ...job, status: 'cancelling', message: 'Cancelling' });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="nuc-job-cancel"]')!.click(); });
    expect(cancelNucJob).toHaveBeenCalledWith('card');
    expect(card().textContent).toContain('Cancelling…');
    expect(card().textContent).not.toContain('Analysing…');
    expect(container.querySelector('[data-testid="nuc-job-cancel"]')).toBeNull();
    expect(autoAnalyseVetoed([{ datasetId: 'd1', chrom: 'chr1', start: 1000, end: 5000 }])).toBe(true);
    act(() => useNucJob.setState(s => ({ job: { ...s.job!, status: 'cancelled', message: 'Cancelled' } })));
    expect(card().textContent).toContain('Analysis cancelled');
    clearAutoAnalyseVeto([{ datasetId: 'd1', chrom: 'chr1', start: 1000, end: 5000 }]);
  });
});
