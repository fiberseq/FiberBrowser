import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useReadActionsStore } from '../../stores/readActionsStore';
import { registerHubState } from '../hub/hubState';
import { useHubData } from '../hub/hubData';
import { NucleosomePanel, changedSettings } from './NucleosomePanel';
import { getNucJob, listNucJobs, nucGeometries, nucRegularity, nucStatus } from './api';
import { useNucJob } from './nucJob';
import { resetAutoAnalyse } from './firstOpen';
import { showsGeometries } from './geoRuns';
import type { NucPanelState } from './types';

vi.mock('./api', async original => ({ ...(await original<typeof import('./api')>()),
  getNucJob: vi.fn(), listNucJobs: vi.fn(), nucStatus: vi.fn(), nucRegularity: vi.fn(), nucGeometries: vi.fn(),
}));
vi.mock('./nucJob', async original => ({ ...(await original<typeof import('./nucJob')>()), refreshNucDatasets: vi.fn(async () => undefined) }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement, root: Root;
const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const click = async (element: HTMLElement) => { await act(async () => element.click()); };
const tab = (key: string) => container.querySelector<HTMLElement>(`[data-analysis-tab="${key}"]`)!;
const nucSettings = () => useBrowserStore.getState().panels.find(p => p.id === 'nuc')?.nucleosomes;
async function renderPanel() {
  await act(async () => root.render(<NucleosomePanel panelId="nuc" isFullView />));
  await act(async () => { vi.advanceTimersByTime(700); await Promise.resolve(); await Promise.resolve(); });
}
function setPanel(nucleosomes: NucPanelState) {
  useBrowserStore.setState(s => ({ panels: s.panels.map(p => p.id === 'nuc' ? { ...p, nucleosomes } : p) }));
}
/** A regularity answer for an analysed view (scored tiles), or for one without nucleosome calls yet. */
const regAnswer = (analysed: boolean) => ({ observations: [analysed
  ? { obsId: 'reads', datasetId: 'd1', molecules: 12, scored: 12, summary: { molecules: 12, m6aPerKb: 40, scoreAboveRef: 0.4, repeatLength: 186 } }
  : { obsId: 'reads', datasetId: 'd1', molecules: 0, scored: 0, notComputed: 12 }], datasets: {}, updatedDatasets: [] }) as never;

beforeEach(() => {
  registerHubState();
  vi.useFakeTimers();
  resetAutoAnalyse();
  useBrowserStore.setState({ chrom: 'chr1', start: 1000, end: 5000, showDuplicateReads: false,
    datasets: [{ id: 'd1', label: 'Sample A', color: '#16a34a', data_type: 'bam', available_layers: { nucsz: true, nucseg: true } }],
    panels: [{ id: 'reads', contentType: 'dataset', datasetId: 'd1', subTracks: [], collapsed: false },
      { id: 'nuc', contentType: 'nucleosomes', nucleosomes: { regularity: { autoAnalyse: 'off' } }, subTracks: [], collapsed: false }],
    selectedDatasets: new Set(), selectedPeaks: new Set(), selectedFeatures: [], filteredReadIds: {},
    featureHub: { ...useBrowserStore.getState().featureHub, selected: [] },
    clusterAssignments: {}, clusterFocus: {}, selectedClusters: {}, clusterFeatureRules: [],
  } as never);
  useHubData.setState({ scans: [] });
  useNucJob.getState().clear();
  useReadActionsStore.getState().reset();
  vi.mocked(nucStatus).mockResolvedValue({ available: true, datasets: [] });
  vi.mocked(listNucJobs).mockResolvedValue({ jobs: [] });
  vi.mocked(nucRegularity).mockResolvedValue(regAnswer(true));
  vi.mocked(nucGeometries).mockReturnValue(new Promise(() => {}) as never);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount()); container.remove();
  useNucJob.getState().clear();
  vi.useRealTimers(); vi.clearAllMocks(); vi.restoreAllMocks();
});

describe('the panel header and Analyse', () => {
  it('follows the newest in-progress analysis on mount and displays its waiting message', async () => {
    const newest = { job_id: 'newest', status: 'queued' as const, created_at: 2,
      message: 'Waiting for the previous run to stop', datasets: [], results: {},
      view: { chrom: 'chr1', start: 1000, end: 5000 } };
    vi.mocked(listNucJobs).mockResolvedValue({ jobs: [newest,
      { ...newest, job_id: 'old', created_at: 1, status: 'cancelling' }] });
    vi.mocked(getNucJob).mockResolvedValue(newest);
    await renderPanel();
    expect(getNucJob).toHaveBeenCalledWith('newest');
    expect(useNucJob.getState().job?.job_id).toBe('newest');
    expect(q('nuc-job').textContent).toContain('Waiting for the previous run to stop');
  });

  it('never replaces a running analysis: Analyse is disabled while one runs; a replaced job shows a quiet notice', async () => {
    const submit = vi.spyOn(useNucJob.getState(), 'submit').mockResolvedValue();
    useNucJob.setState({ panelId: 'nuc', job: { job_id: 'old', status: 'running', created_at: 1,
      datasets: [{ datasetId: 'd1', label: 'Sample A', kind: 'native' }],
      view: { chrom: 'chr1', start: 1000, end: 5000 }, results: {} } });
    await renderPanel();
    // One Analyse runs at a time: a new request would replace the running one (the server cancels it).
    expect((q('nuc-compute') as HTMLButtonElement).disabled).toBe(true);
    await click(q('nuc-compute'));
    expect(submit).not.toHaveBeenCalled();
    act(() => useNucJob.setState(s => ({ job: { ...s.job!, status: 'cancelled', message: 'Replaced by a newer run' } })));
    expect(q('nuc-job').textContent).toContain('Replaced by a newer analysis');
    expect(q('nuc-error')).toBeNull();
    expect((q('nuc-compute') as HTMLButtonElement).disabled).toBe(false);
    await click(q('nuc-compute'));
    expect(submit).toHaveBeenCalledOnce();
  });

  it('names the view, keeps the one Analyse button in the header and sends no Sites request', async () => {
    const submit = vi.spyOn(useNucJob.getState(), 'submit').mockResolvedValue();
    await renderPanel();
    expect(container.textContent).toContain('chr1:1,001–5,000');
    expect(q('nuc-compute').textContent).toBe('Analyse this view');
    expect([...container.querySelectorAll('button')].filter(b => b.textContent === 'Analyse this view')).toHaveLength(1);
    // the old tabs are gone; three tabs remain
    expect(tab('geometries')).not.toBeNull();
    expect(tab('charts')).not.toBeNull();
    expect(tab('site')).not.toBeNull();
    for (const old of ['sites', 'segments', 'window', 'regularity']) expect(tab(old)).toBeNull();
    await click(q('nuc-compute'));
    expect(submit).toHaveBeenCalledWith({ datasets: ['d1'], views: [{ datasetId: 'd1', chrom: 'chr1', start: 1000, end: 5000 }], include_duplicates: false }, 'nuc');
  });

  it('an unanalysed view: one status line, and the header\'s Analyse analyses the datasets without calls', async () => {
    vi.mocked(nucRegularity).mockResolvedValue(regAnswer(false));
    vi.mocked(nucGeometries).mockResolvedValue({ window: null, geometries: [], nMolecules: 0, nPatches: 0, nested: [], patchStats: {}, references: {},
      errors: { reads: 'No regularity reference yet: run Analyse first' }, profiles: { edges: [], share: {}, carriers: {}, none: [] }, assignments: {},
      updatedDatasets: [], params: { patch: {}, geometry: {}, view: {} } } as never);
    const submit = vi.spyOn(useNucJob.getState(), 'submit').mockResolvedValue();
    await renderPanel();
    await act(async () => { vi.advanceTimersByTime(700); await Promise.resolve(); await Promise.resolve(); });
    expect(q('nuc-geo-needs-analyse')).not.toBeNull();
    expect(q('nuc-reg-needs-analyse')).toBeNull();
    expect(q('nuc-geo-analysing')).toBeNull();
    await click(q('nuc-compute'));
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ datasets: ['d1'] }), 'nuc');
  });
});

describe('settings and tabs', () => {
  it('Settings opens one drawer with every group; the button counts the changed settings', async () => {
    setPanel({ regularity: { autoAnalyse: 'off', params: { window_bp: 1500 } as never, patches: { params: { tol_bp: 300 } } } });
    await renderPanel();
    expect(q('nuc-settings')).toBeNull();
    expect(q('nuc-settings-changed').textContent).toBe('3');
    await click(q('nuc-settings-toggle'));
    for (const id of ['nuc-reg-score-row', 'nuc-reg-cohort-row', 'nuc-patch-call-row', 'nuc-patch-high-row', 'nuc-patch-low-row',
      'nuc-geo-params-row', 'nuc-patch-ref-row', 'nuc-patch-origin-row']) expect(q(id)).not.toBeNull();
    await click(q('nuc-settings-toggle'));
    expect(q('nuc-settings')).toBeNull();
    expect(changedSettings({})).toBe(0);
    expect(changedSettings({ regularity: { patches: { open: false, params: { low: null } }, cohort: 'spanning' } })).toBe(3);
  });

  it('a tab change is saved on the panel; the geometries are the default', async () => {
    await renderPanel();
    expect(tab('geometries').getAttribute('aria-current')).toBe('page');
    await click(tab('charts'));
    expect(nucSettings()?.regularity?.view).toBe('charts');
    await click(tab('geometries'));
    expect(nucSettings()?.regularity?.view).toBeUndefined();
  });

  it('columns can be hidden under Settings and shown again', async () => {
    useBrowserStore.setState(s => ({ datasets: [...s.datasets, { id: 'd2', label: 'Sample B', color: '#2563eb', data_type: 'bam' }],
      panels: [s.panels[0], { id: 'reads2', contentType: 'dataset', datasetId: 'd2', subTracks: [], collapsed: false }, s.panels[1]] }) as never);
    await renderPanel();
    await click(q('nuc-settings-toggle'));
    const boxes = [...container.querySelectorAll<HTMLInputElement>('[data-testid="nuc-column-toggle"]')];
    expect(boxes).toHaveLength(2);
    await click(boxes[1]);
    expect(nucSettings()?.hidden).toEqual([boxes[1].getAttribute('data-obs')]);
    await act(async () => { vi.advanceTimersByTime(10); });
    // the last shown column can't be hidden
    expect(container.querySelectorAll<HTMLInputElement>('[data-testid="nuc-column-toggle"]')[0].disabled).toBe(true);
    await click(q('nuc-show-hidden'));
    expect(nucSettings()?.hidden).toEqual([]);
  });
});

describe('older sessions', () => {
  for (const mode of ['sites', 'segments', 'window']) {
    it(`a session saved on the removed '${mode}' tab opens cleanly on the geometries`, async () => {
      setPanel({ mode, windowSource: 'handoff', window: { chrom: 'chr1', start: 1000, end: 3000, label: 'Site chr1:2,001', anchor: 2000 },
        anchor: { kind: 'position', pos: 2000, orientation: 0 }, flank: 1000, background: 'hub', regularity: { autoAnalyse: 'off' } } as never);
      const errors: unknown[] = [];
      const onError = (e: ErrorEvent) => errors.push(e.error);
      window.addEventListener('error', onError);
      await renderPanel();
      window.removeEventListener('error', onError);
      expect(errors).toEqual([]);
      expect(q('nuc-regularity')).not.toBeNull();
      expect(tab('geometries').getAttribute('aria-current')).toBe('page');
      expect(nucRegularity).toHaveBeenCalled();
      // its geometries are kept (an export of another panel, the hub, the track): the old mode never hides them
      expect(showsGeometries({ nucleosomes: { mode } })).toBe(true);
    });
  }
});
