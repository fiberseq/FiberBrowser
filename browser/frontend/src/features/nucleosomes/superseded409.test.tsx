/** A read-side request the server drops as superseded (409, an Analyse of its datasets or the panel's newer request)
 * is an expected outcome: never shown as an error, the view keeps what it shows, and the re-ask comes once when the
 * Analyse ends (the revision moves). */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RegularityView } from './RegularityView';
import { PatchGeometryView } from './PatchGeometryView';
import { regularitySeries } from './RegularityView';
import { getNucJob, isSupersededNuc, listNucJobs, nucGeometries, nucRegularity, SUPERSEDED_DETAIL } from './api';
import { useBrowserStore } from '../../stores/browserStore';
import { resetAutoAnalyse } from './firstOpen';
import { resyncAfterSuperseded, useNucJob } from './nucJob';
import { useNucGeoRuns } from './geoRuns';
import type { NucObservation, NucRegularityResult } from './types';

vi.mock('./api', async original => ({ ...(await original<typeof import('./api')>()),
  nucRegularity: vi.fn(), nucGeometries: vi.fn(), getNucJob: vi.fn(), listNucJobs: vi.fn(async () => ({ jobs: [] })) }));
vi.mock('../../api/datasets', () => ({ getDatasets: vi.fn(async () => ({ datasets: [] })) }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** What fetchJson throws for the server's superseded answer. */
const superseded = () => Object.assign(new Error(`API error 409: ${SUPERSEDED_DETAIL}`), { status: 409, detail: SUPERSEDED_DETAIL });
const obs = (id: string, extra: Partial<NucObservation> = {}): NucObservation => ({ obsId: id, datasetId: id, panelId: `p-${id}`, stateKey: id,
  label: id, color: '#15803d', kind: 'linear', chrom: 'chr2R', start: 1000, end: 21000, ...extra });
const hist = (n: number) => ({ edges: Array.from({ length: n + 1 }, (_, i) => i), counts: Array.from({ length: n }, (_, i) => i % 5), n: 10 });
const answer = (id: string): NucRegularityResult => ({
  observations: [{ obsId: id, datasetId: id, molecules: 40, scored: 40, scores: hist(8), periods: { values: [180, 186], counts: [3, 5], n: 8 },
    track: { edges: [1000, 2000, 3000], mean: [3.5, 4.2], n: [4, 5] }, scatter: { points: [[3.2, 50]], n: 1, spearman: 0.6 },
    acf: { lags: [0, 50, 100], mean: [1, 0.1, 0.2], n: 3, maskBp: 300, thinPerKb: 25 },
    summary: { molecules: 40, m6aPerKb: 63, footprintMedian: 151, mergedPct: 26, spacingMedian: 189, score: 3.9, scoreAboveRef: 0.9, repeatLength: 191 } }],
  datasets: { [id]: { params: {}, paramsDigest: 'x', reference: { median: 3.01, quantiles: {}, n_windows: 3000, n_molecules: 400, observed_p95: 5.7,
    observed_median: 3.9, hist: hist(8) }, scale: { zero: 3.01, top: 5.7, reference: true }, recomputed: 0, missing: 0 } },
  updatedDatasets: [],
}) as never;

describe('isSupersededNuc', () => {
  it('knows the superseded 409 by status and detail, or by its message, and nothing else', () => {
    expect(isSupersededNuc(superseded())).toBe(true);
    expect(isSupersededNuc(new Error(`API error 409: ${SUPERSEDED_DETAIL}`))).toBe(true);
    expect(isSupersededNuc(Object.assign(new Error('API error 409: Conflict'), { status: 409, detail: 'Conflict' }))).toBe(false);
    expect(isSupersededNuc(Object.assign(new Error('API error 422: bad'), { status: 422, detail: 'bad' }))).toBe(false);
    expect(isSupersededNuc(new Error('network'))).toBe(false);
    expect(isSupersededNuc(null)).toBe(false);
  });
});

describe('views drop a superseded request silently and ask again once', () => {
  let container: HTMLDivElement, root: Root;
  const tick = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve(); await Promise.resolve(); }); };
  const text = () => container.textContent ?? '';
  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    useBrowserStore.setState({ datasets: [{ id: 'a', label: 'Early', data_type: 'bam' }], clusterAssignments: {} } as never);
    vi.mocked(nucRegularity).mockReset(); vi.mocked(nucGeometries).mockReset();
    vi.mocked(listNucJobs).mockReset().mockResolvedValue({ jobs: [] });
    vi.mocked(getNucJob).mockReset();
    useNucJob.getState().clear();
    resetAutoAnalyse();
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); useNucJob.getState().clear(); vi.useRealTimers(); });

  it('Regularity: no error text, the answer on show stays with "Updating…", one request again when the revision moves', async () => {
    vi.mocked(nucRegularity).mockResolvedValueOnce(answer('a'));
    const view = (revision: string, start = 1000) => <RegularityView observations={[obs('a', { start, end: start + 20000 })]} settings={{ regularity: { view: 'charts', patches: { open: false } } }}
      setSettings={vi.fn()} revision={revision} includeDuplicates={false} panelId="r1" />;
    await act(async () => { root.render(view('0')); });
    await tick(700);
    expect(container.querySelectorAll('[data-testid="nuc-reg-acf-chart"]').length).toBe(1);
    // a cohort change asks again; an Analyse of the dataset starts meanwhile and the server drops the request
    vi.mocked(nucRegularity).mockRejectedValueOnce(superseded());
    await act(async () => { root.render(<RegularityView observations={[obs('a', { readIds: ['r1'] })]} settings={{ regularity: { view: 'charts', patches: { open: false } } }}
      setSettings={vi.fn()} revision="0" includeDuplicates={false} panelId="r1" />); });
    await tick(700);
    expect(nucRegularity).toHaveBeenCalledTimes(2);
    expect(text()).not.toMatch(/409|Replaced by a newer/);
    expect(text()).toContain('Updating…');
    expect(container.querySelectorAll('[data-testid="nuc-reg-acf-chart"]').length).toBe(1);   // the last answer stays
    expect(listNucJobs).toHaveBeenCalledTimes(1);                                          // the re-ask is made sure of
    await tick(5000);
    expect(nucRegularity).toHaveBeenCalledTimes(2);                                        // never repeated by hand
    // the Analyse ends: the revision moves and the view asks once, then shows the current answer
    vi.mocked(nucRegularity).mockResolvedValueOnce(answer('a'));
    await act(async () => { root.render(<RegularityView observations={[obs('a', { readIds: ['r1'] })]} settings={{ regularity: { view: 'charts', patches: { open: false } } }}
      setSettings={vi.fn()} revision="1" includeDuplicates={false} panelId="r1" />); });
    await tick(700);
    expect(nucRegularity).toHaveBeenCalledTimes(3);
    expect(text()).not.toContain('Updating…');
    expect(text()).not.toMatch(/409|Replaced by a newer/);
  });

  it('Regularity: a real failure is still shown', async () => {
    vi.mocked(nucRegularity).mockRejectedValueOnce(Object.assign(new Error('API error 422: bad parameters'), { status: 422, detail: 'bad parameters' }));
    await act(async () => { root.render(<RegularityView observations={[obs('a')]} settings={{ regularity: { patches: { open: false } } }}
      setSettings={vi.fn()} revision="0" includeDuplicates={false} panelId="r2" />); });
    await tick(700);
    expect(text()).toContain('bad parameters');
  });

  it('Patches: no error and the panel\'s geometry run is kept (hub set, track, overlay identity), never dropped', async () => {
    const geo = { window: { chrom: 'chr2R', start: 1000, end: 21000 }, params: { patch: {}, geometry: {}, view: {} }, references: {}, errors: {},
      nMolecules: 7, nPatches: 1, geometries: [], nested: [], profiles: { edges: [1000, 21000], share: {}, carriers: {}, none: [0] }, patchStats: {},
      assignments: {}, updatedDatasets: [] };
    vi.mocked(nucGeometries).mockResolvedValueOnce(geo as never);
    const dropRun = vi.fn();
    const runs = useNucGeoRuns.getState();
    useNucGeoRuns.setState({ dropRun } as never);
    try {
      const render = (revision: string) => <PatchGeometryView series={regularitySeries([obs('a')], {})} settings={{ regularity: { patches: { open: true } } }}
        setSettings={vi.fn()} revision={revision} includeDuplicates={false} panelId="g1" regularityState="ready" />;
      await act(async () => { root.render(render('0')); });
      await tick(600);
      dropRun.mockClear();                       // (an answer without geometries drops its own run: not the subject)
      vi.mocked(nucGeometries).mockRejectedValueOnce(superseded());
      await act(async () => { root.render(render('1')); });
      await tick(600);
      expect(nucGeometries).toHaveBeenCalledTimes(2);
      expect(dropRun).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="nuc-patch-error"]')).toBeNull();
      expect(text()).not.toMatch(/409|Replaced by a newer/);
    } finally {
      useNucGeoRuns.setState({ dropRun: runs.dropRun } as never);
    }
  });
});

describe('resyncAfterSuperseded', () => {
  const job = (id: string, status: string, created_at: number) => ({ job_id: id, status, created_at, datasets: [{ datasetId: 'a', label: 'A', kind: 'native' }],
    view: { chrom: 'c', start: 0, end: 1 }, results: { a: { calibration: {}, records: 1, computed: 1, cached: 0, undecodable: {}, datasets: ['a'] } } });
  beforeEach(() => { vi.useFakeTimers(); useNucJob.getState().clear(); vi.mocked(listNucJobs).mockReset(); vi.mocked(getNucJob).mockReset(); });
  afterEach(() => { useNucJob.getState().clear(); vi.useRealTimers(); });

  it('follows an Analyse this tab did not start, so its end moves the revision', async () => {
    vi.mocked(listNucJobs).mockResolvedValue({ jobs: [job('other-tab', 'running', 5)] } as never);
    await resyncAfterSuperseded('p1');
    expect(useNucJob.getState().job?.job_id).toBe('other-tab');
    const before = useNucJob.getState().revision;
    vi.mocked(getNucJob).mockResolvedValue(job('other-tab', 'complete', 5) as never);
    await vi.advanceTimersByTimeAsync(400);
    expect(useNucJob.getState().revision).toBe(before + 1);
  });

  it('an Analyse that has ended already moves the revision at once; one this tab follows is left to its own end', async () => {
    vi.mocked(listNucJobs).mockResolvedValue({ jobs: [job('done-elsewhere', 'complete', 7)] } as never);
    const before = useNucJob.getState().revision;
    await resyncAfterSuperseded('p1');
    expect(useNucJob.getState().revision).toBe(before + 1);
    await resyncAfterSuperseded('p1');                      // finished once only
    expect(useNucJob.getState().revision).toBe(before + 1);
    useNucJob.setState({ job: job('mine', 'running', 9) as never, panelId: 'p1' });
    vi.mocked(listNucJobs).mockResolvedValue({ jobs: [job('mine', 'running', 9)] } as never);
    await resyncAfterSuperseded('p2');
    expect(useNucJob.getState()).toMatchObject({ panelId: 'p1', revision: before + 1 });
  });
});
